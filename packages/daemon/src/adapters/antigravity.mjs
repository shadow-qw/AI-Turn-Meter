import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, watch } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { accumulateUsageBucket, finalizeUsageBuckets } from '../pricing.mjs';

const execFileAsync = promisify(execFile);
const MIN_STREAMING_SEC = 0.15;
const MAX_INFERRED_STEP_MS = 10 * 60_000;
const OPEN_TURN_FLUSH_MS = 120_000;

function parseIsoMs(ts) {
  if (typeof ts !== 'string') return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

export function parseDurationSec(val) {
  if (typeof val === 'number') return Number.isFinite(val) && val >= 0 ? val : null;
  if (typeof val !== 'string') return null;
  const m = val.match(/^([0-9]+(?:\.[0-9]+)?)s$/i);
  const n = m ? Number(m[1]) : Number(val);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Build a Map<stepIndex, speedEntry> from LanguageServerService GetCascadeTrajectoryGeneratorMetadata.
 */
export function buildAntigravitySpeedIndex(generatorMetadata) {
  const index = new Map();
  if (!Array.isArray(generatorMetadata)) return index;

  for (const row of generatorMetadata) {
    const cm = row?.chatModel;
    const stepIndices = Array.isArray(row?.stepIndices) ? row.stepIndices : [];
    if (!cm || stepIndices.length === 0) continue;

    const ttftSec = parseDurationSec(cm.timeToFirstToken);
    const streamingSec = parseDurationSec(cm.streamingDuration);
    const outputTokens = Number(cm.usage?.outputTokens);
    const thinkingTokens = Number(cm.usage?.thinkingOutputTokens);
    const model = cm.responseModel || cm.model || '';

    const entry = {
      ttftMs: ttftSec !== null ? Math.round(ttftSec * 1000) : null,
      streamingMs: streamingSec !== null ? Math.round(streamingSec * 1000) : null,
      outputTokens: Number.isFinite(outputTokens) && outputTokens >= 0 ? Math.round(outputTokens) : null,
      thinkingTokens:
        Number.isFinite(thinkingTokens) && thinkingTokens >= 0 ? Math.round(thinkingTokens) : null,
      model: typeof model === 'string' ? model : '',
    };

    for (const idx of stepIndices) {
      const n = Number(idx);
      if (Number.isFinite(n)) index.set(n, entry);
    }
  }
  return index;
}

/**
 * Parse an Antigravity transcript.jsonl into completed user-turn summaries plus open-turn status.
 * @param {string} content
 * @param {object} opts
 * @returns {{ turns: Array<object>, hasOpenTurns: boolean }}
 */
export function parseAntigravityTranscriptDetailed(
  content,
  {
    sessionId,
    host = 'antigravity-desktop',
    workspacePath = null,
    speedIndex = null,
    flushOpenTurns = false,
  } = {}
) {
  const lines = content.split(/\r?\n/);
  const steps = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      steps.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  if (steps.length === 0) return { turns: [], hasOpenTurns: false };

  // Group into user turns: each USER_INPUT starts a turn
  const rawTurns = [];
  let current = null;

  for (let i = 0; i < steps.length; i += 1) {
    const s = steps[i];
    if (s.type === 'USER_INPUT') {
      if (current) {
        current.closedByNextInput = true;
        rawTurns.push(current);
      }
      current = {
        turnIndex: rawTurns.length + 1,
        startedStepIndex: s.step_index ?? i,
        startedAtMs: parseIsoMs(s.created_at),
        lastAtMs: parseIsoMs(s.created_at),
        steps: [s],
        plannerSteps: [],
        lastStep: s,
        closedByNextInput: false,
      };
      continue;
    }

    if (!current) {
      // Transcript may start without USER_INPUT (e.g. subagent); synthesize turn 1
      current = {
        turnIndex: 1,
        startedStepIndex: s.step_index ?? i,
        startedAtMs: parseIsoMs(s.created_at),
        lastAtMs: parseIsoMs(s.created_at),
        steps: [],
        plannerSteps: [],
        lastStep: s,
        closedByNextInput: false,
      };
    }

    const tMs = parseIsoMs(s.created_at);
    if (tMs !== null) current.lastAtMs = tMs;
    current.steps.push(s);
    current.lastStep = s;
    if (s.type === 'PLANNER_RESPONSE') {
      current.plannerSteps.push(s);
    }
  }
  if (current) rawTurns.push(current);

  const completed = [];
  const stepIndexCounts = new Map();
  let hasOpenTurns = false;

  for (const rt of rawTurns) {
    if (rt.plannerSteps.length === 0) continue;
    const lastPlanner = rt.plannerSteps[rt.plannerSteps.length - 1];
    const hasPendingTools =
      Array.isArray(lastPlanner.tool_calls) && lastPlanner.tool_calls.length > 0;
    const isFinalPlannerDone =
      rt.lastStep === lastPlanner && lastPlanner.status === 'DONE' && !hasPendingTools;

    if (!rt.closedByNextInput && !isFinalPlannerDone) {
      if (!flushOpenTurns) {
        const hasAnyTokens = rt.plannerSteps.some(
          (ps) =>
            (Number(ps.input_tokens) || 0) > 0 ||
            (Number(ps.cache_read_tokens) || 0) > 0 ||
            (Number(ps.output_tokens) || 0) > 0
        );
        if (hasAnyTokens) hasOpenTurns = true;
        // Turn is still mid-execution (or ended on a tool call awaiting stale flush)
        continue;
      }
    }

    let uncachedInputTokens = 0;
    let cacheReadTokens = 0;
    let outputTokens = 0;
    let thinkingTokens = 0;
    let hasThinking = false;
    const modelWeights = new Map();

    let sumStreamingMs = 0;
    let sumStreamOut = 0;
    let firstTtftMs = null;
    let replyPreview = null;
    const seenEntries = new Set();
    const stepUsages = [];

    for (const ps of rt.plannerSteps) {
      if (typeof ps.content === 'string' && ps.content.trim()) {
        replyPreview = ps.content;
      }
      const inp = Number(ps.input_tokens) || 0;
      const cr = Number(ps.cache_read_tokens) || 0;
      const out = Number(ps.output_tokens) || 0;
      uncachedInputTokens += inp;
      cacheReadTokens += cr;
      outputTokens += out;

      const sp = speedIndex instanceof Map ? speedIndex.get(ps.step_index) : null;
      const transcriptModel = typeof ps.model === 'string' && ps.model.trim() ? ps.model.trim() : '';
      const resolvedStepModel = (sp && sp.model) || transcriptModel;
      if (resolvedStepModel) {
        const stepWeight = Math.max(1, inp + cr + out);
        modelWeights.set(resolvedStepModel, (modelWeights.get(resolvedStepModel) || 0) + stepWeight);
      }
      stepUsages.push({
        model: resolvedStepModel || null,
        uncachedInput: inp,
        cacheRead: cr,
        output: out,
      });

      if (sp) {
        if (!seenEntries.has(sp)) {
          seenEntries.add(sp);
          if (firstTtftMs === null && sp.ttftMs !== null) firstTtftMs = sp.ttftMs;
          if (sp.thinkingTokens !== null) {
            thinkingTokens += sp.thinkingTokens;
            hasThinking = true;
          }
          const spOut = sp.outputTokens !== null ? sp.outputTokens : out;
          if (
            sp.streamingMs !== null &&
            sp.streamingMs >= MIN_STREAMING_SEC * 1000 &&
            spOut > 0
          ) {
            sumStreamingMs += sp.streamingMs;
            sumStreamOut += spOut;
          }
        }
      }
    }

    let model = 'unknown';
    let bestModelWeight = -1;
    for (const [m, w] of modelWeights.entries()) {
      if (w > bestModelWeight) {
        bestModelWeight = w;
        model = m;
      }
    }

    if (uncachedInputTokens === 0 && cacheReadTokens === 0 && outputTokens === 0) continue;

    const bucketMap = new Map();
    for (const su of stepUsages) {
      accumulateUsageBucket(bucketMap, {
        model: su.model || model,
        uncachedInput: su.uncachedInput,
        cacheRead: su.cacheRead,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        output: su.output,
      });
    }
    const usageBuckets = finalizeUsageBuckets(bucketMap);

    const totalInputTokens = uncachedInputTokens + cacheReadTokens;
    const durationMs =
      rt.startedAtMs !== null && rt.lastAtMs !== null && rt.lastAtMs >= rt.startedAtMs
        ? rt.lastAtMs - rt.startedAtMs
        : null;

    let tps = null;
    let tpsMethod = 'unavailable';
    let modelActiveMs = null;

    if (sumStreamingMs >= MIN_STREAMING_SEC * 1000 && sumStreamOut > 0) {
      tps = Number((sumStreamOut / (sumStreamingMs / 1000)).toFixed(1));
      tpsMethod = 'streaming_decode';
      modelActiveMs = sumStreamingMs;
    } else if (outputTokens > 0) {
      let inferredActiveMs = 0;
      let inferredActiveOut = 0;
      let toolWaitMs = 0;
      const turnSteps = rt.steps || [];
      for (let i = 0; i + 1 < turnSteps.length; i += 1) {
        const curStep = turnSteps[i];
        const nextStep = turnSteps[i + 1];
        const t0 = parseIsoMs(curStep.created_at);
        const t1 = parseIsoMs(nextStep.created_at);
        if (t0 === null || t1 === null || t1 < t0) continue;
        const deltaMs = t1 - t0;
        if (deltaMs > MAX_INFERRED_STEP_MS) continue;
        if (curStep.type === 'PLANNER_RESPONSE') {
          inferredActiveMs += deltaMs;
          inferredActiveOut += Number(curStep.output_tokens) || 0;
        } else if (curStep.type !== 'USER_INPUT') {
          toolWaitMs += deltaMs;
        }
      }

      if (toolWaitMs > 0 && inferredActiveMs >= MIN_STREAMING_SEC * 1000 && inferredActiveOut > 0) {
        tps = Number((inferredActiveOut / (inferredActiveMs / 1000)).toFixed(1));
        tpsMethod = 'e2e_minus_tools';
        modelActiveMs = inferredActiveMs;
      } else if (durationMs !== null && durationMs >= MIN_STREAMING_SEC * 1000) {
        tps = Number((outputTokens / (durationMs / 1000)).toFixed(1));
        tpsMethod = 'e2e_turn';
      }
    }

    const stepKey = String(rt.startedStepIndex);
    const occ = (stepIndexCounts.get(stepKey) || 0) + 1;
    stepIndexCounts.set(stepKey, occ);
    const turnId = occ === 1 ? `turn-${rt.startedStepIndex}` : `turn-${rt.startedStepIndex}-r${occ}`;

    completed.push({
      turnUid: `antigravity:${sessionId}:${turnId}`,
      tool: 'antigravity',
      host,
      sessionId,
      turnId,
      model,
      workspacePath,
      startedAtMs: rt.startedAtMs,
      completedAtMs: rt.lastAtMs ?? Date.now(),
      callCount: rt.plannerSteps.length,
      totalInputTokens,
      uncachedInputTokens,
      cacheReadTokens,
      cacheWriteTokens: 0,
      outputTokens,
      thinkingTokens: hasThinking ? thinkingTokens : null,
      durationMs,
      modelActiveMs,
      ttftMs: firstTtftMs,
      tps,
      tpsMethod,
      usageBuckets,
      replyPreview,
    });
  }

  return { turns: completed, hasOpenTurns };
}

/**
 * Parse an Antigravity transcript.jsonl into completed user-turn summaries.
 * @param {string} content
 * @param {object} opts
 */
export function parseAntigravityTranscriptContent(content, opts = {}) {
  return parseAntigravityTranscriptDetailed(content, opts).turns;
}

function defaultIsPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/**
 * Discover active Antigravity language server instances from `~/.gemini/<sub >/daemon/*.json`
 * discovery files (e.g. `hub_<port>.json`, `ls_*.json`) written by Antigravity 2.x.
 */
export function discoverAntigravityDaemonFiles(
  geminiRoot = join(homedir(), '.gemini'),
  { isPidAlive = defaultIsPidAlive } = {}
) {
  const entries = [];
  for (const sub of ['antigravity', 'antigravity-ide', 'antigravity-cli']) {
    const daemonDir = join(geminiRoot, sub, 'daemon');
    if (!existsSync(daemonDir)) continue;
    let files;
    try {
      files = readdirSync(daemonDir);
    } catch {
      continue;
    }
    for (const fn of files) {
      if (!fn.endsWith('.json')) continue;
      const fp = join(daemonDir, fn);
      try {
        const st = statSync(fp);
        const data = JSON.parse(readFileSync(fp, 'utf8'));
        if (!data || typeof data !== 'object') continue;
        const csrf =
          typeof data.csrfToken === 'string' && data.csrfToken.trim()
            ? data.csrfToken.trim()
            : typeof data.csrf_token === 'string' && data.csrf_token.trim()
              ? data.csrf_token.trim()
              : null;
        if (!csrf) continue;

        const pid = Number(data.pid);
        const hasPid = Number.isInteger(pid) && pid > 0;
        if (hasPid && !isPidAlive(pid)) continue;

        const httpsPort = Number(data.httpsPort ?? data.https_port);
        const httpPort = Number(data.httpPort ?? data.http_port);
        const validHttps = Number.isInteger(httpsPort) && httpsPort > 0 && httpsPort <= 65535 ? httpsPort : null;
        const validHttp = Number.isInteger(httpPort) && httpPort > 0 && httpPort <= 65535 ? httpPort : null;
        const ports = [];
        if (validHttps !== null) ports.push(validHttps);
        if (validHttp !== null && validHttp !== validHttps) ports.push(validHttp);
        if (ports.length === 0) continue;

        const version =
          typeof data.lsVersion === 'string' && data.lsVersion.trim()
            ? data.lsVersion.trim()
            : typeof data.version === 'string' && data.version.trim()
              ? data.version.trim()
              : null;

        entries.push({
          pid: hasPid ? pid : null,
          csrf,
          ports,
          httpsPort: validHttps,
          httpPort: validHttp,
          version,
          mtimeMs: st.mtimeMs,
          source: 'daemon_file',
        });
      } catch {
        // Ignore malformed or concurrently rotated discovery file
      }
    }
  }

  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const seen = new Set();
  const deduped = [];
  for (const e of entries) {
    const key = e.pid ? `pid:${e.pid}` : `csrf:${e.csrf}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(e);
  }
  return deduped;
}

/**
 * Inspect local Antigravity LanguageServerService processes from daemon discovery JSON files
 * first, then fall back to the current user's process list (`ps` + `lsof`).
 * Distinguishes running servers with an exposed `--csrf_token` from newer builds (e.g. 2.34+)
 * that pass tokens via stdin (`--read_host_bridge_token_from_stdin`) without exposing `--csrf_token`.
 */
export async function inspectAntigravityLanguageServers({ geminiRoot = join(homedir(), '.gemini') } = {}) {
  try {
    const fromFiles = discoverAntigravityDaemonFiles(geminiRoot);
    if (fromFiles.length > 0) {
      return {
        servers: fromFiles,
        runningWithoutCsrfToken: false,
        detectedVersion: fromFiles.find((s) => s.version)?.version || null,
      };
    }

    const uid = process.getuid?.();
    const { stdout: psOut } = await execFileAsync('ps', ['-axo', 'pid=,uid=,command='], {
      timeout: 2000,
    });
    return await parseAntigravityLanguageServerPsOutput(psOut, { uid });
  } catch {
    return { servers: [], runningWithoutCsrfToken: false, detectedVersion: null };
  }
}

export async function parseAntigravityLanguageServerPsOutput(
  psOut,
  { uid = process.getuid?.(), resolvePorts = null } = {}
) {
  const candidates = [];
  let runningWithoutCsrfToken = false;
  let detectedVersion = null;

  for (const line of String(psOut || '').split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    if (uid !== undefined && uid !== null && Number(m[2]) !== uid) continue;
    const cmd = m[3];
    if (!/language_server(?:\.native)?\b/.test(cmd) || !/--standalone\b/.test(cmd)) continue;
    const ver = cmd.match(/--override_ide_version(?:=|\s+)"?([^\s"]+)/)?.[1] || null;
    if (ver && !detectedVersion) detectedVersion = ver;
    const csrf = cmd.match(/--csrf_token(?:=|\s+)"?([^\s"]+)/)?.[1];
    if (csrf) {
      candidates.push({ pid: Number(m[1]), csrf });
    } else {
      runningWithoutCsrfToken = true;
    }
  }

  if (candidates.length === 0) {
    return { servers: [], runningWithoutCsrfToken, detectedVersion };
  }

  const results = [];
  for (const c of candidates) {
    try {
      let ports = [];
      if (typeof resolvePorts === 'function') {
        ports = (await resolvePorts(c.pid)) || [];
      } else {
        const { stdout: lsofOut } = await execFileAsync(
          'lsof',
          ['-Pan', '-p', String(c.pid), '-iTCP', '-sTCP:LISTEN', '-Fn'],
          { timeout: 2000 }
        );
        for (const l of lsofOut.split(/\r?\n/)) {
          const pm = l.startsWith('n') && l.match(/:(\d+)(?:\s|$)/);
          if (pm) ports.push(Number(pm[1]));
        }
      }
      if (ports.length > 0) results.push({ pid: c.pid, csrf: c.csrf, ports });
    } catch {
      // Ignore single pid error
    }
  }

  return { servers: results, runningWithoutCsrfToken, detectedVersion };
}

/**
 * Discover local Antigravity LanguageServerService HTTP/HTTPS port + CSRF token.
 */
export async function discoverAntigravityLanguageServers(opts = {}) {
  const { servers } = await inspectAntigravityLanguageServers(opts);
  return servers.length > 0 ? servers : null;
}

export function buildLanguageServerEndpoints(srv) {
  const endpoints = [];
  if (typeof srv?.httpsPort === 'number' && srv.httpsPort > 0) {
    endpoints.push({ port: srv.httpsPort, useHttps: true });
  }
  if (typeof srv?.httpPort === 'number' && srv.httpPort > 0) {
    endpoints.push({ port: srv.httpPort, useHttps: false });
  }
  if (endpoints.length > 0) return endpoints;
  for (const port of srv?.ports || []) {
    endpoints.push({ port, useHttps: true });
    endpoints.push({ port, useHttps: false });
  }
  return endpoints;
}

function postJsonLocal(port, csrf, path, body, useHttps = true) {
  return new Promise((resolve) => {
    const mod = useHttps ? https : http;
    const data = JSON.stringify(body);
    const req = mod.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        rejectUnauthorized: false,
        timeout: 1500,
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'x-codeium-csrf-token': csrf,
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let out = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          out += chunk;
        });
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve(null);
          try {
            resolve(JSON.parse(out));
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.write(data);
    req.end();
  });
}

async function fetchGeneratorMetadata(servers, convId) {
  if (!servers || servers.length === 0) return null;
  const path = '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata';
  const body = { cascadeId: convId, generatorMetadataOffset: 0, includeMessages: false };

  for (const srv of servers) {
    for (const { port, useHttps } of buildLanguageServerEndpoints(srv)) {
      const res = await postJsonLocal(port, srv.csrf, path, body, useHttps);
      if (res && Array.isArray(res.generatorMetadata)) {
        return res.generatorMetadata;
      }
    }
  }
  return null;
}

function parseSummaryTimestampMs(val) {
  if (typeof val === 'number') {
    if (!Number.isFinite(val) || val <= 0) return null;
    return val < 1e11 ? Math.round(val * 1000) : Math.round(val);
  }
  if (typeof val === 'string') {
    const s = val.trim();
    if (!s) return null;
    if (/^\d+(?:\.\d+)?$/.test(s)) {
      const n = Number(s);
      if (!Number.isFinite(n) || n <= 0) return null;
      return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
    }
    const iso = s.replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/, '$1T$2');
    const ms = Date.parse(iso);
    return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : null;
  }
  return null;
}

function cleanSummaryTitle(val) {
  if (typeof val !== 'string') return null;
  const cleaned = val.replace(/\s+/g, ' ').trim();
  return cleaned || null;
}

function parseSummaryWorkspacePath(workspaceUris, fallbackWorkspacePath = null) {
  let uris = [];
  if (typeof workspaceUris === 'string' && workspaceUris.trim()) {
    try {
      const parsed = JSON.parse(workspaceUris);
      if (Array.isArray(parsed)) uris = parsed;
      else if (typeof parsed === 'string') uris = [parsed];
    } catch {
      uris = [workspaceUris.trim()];
    }
  }
  const first = Array.isArray(uris)
    ? uris.find((u) => typeof u === 'string' && u.trim())
    : null;
  const raw = first || (typeof fallbackWorkspacePath === 'string' && fallbackWorkspacePath.trim() ? fallbackWorkspacePath.trim() : null);
  if (!raw) return null;
  if (raw.startsWith('file://')) {
    const stripped = raw.replace(/^file:\/\//, '');
    try {
      return decodeURIComponent(stripped);
    } catch {
      return stripped;
    }
  }
  return raw;
}

const SUMMARY_CANDIDATE_COLUMNS = [
  'conversation_id',
  'title',
  'summary',
  'preview',
  'workspace_uris',
  'workspace_path',
  'parent_conversation_id',
  'updated_at_ms',
  'last_modified_time',
  'updated_at',
  'last_user_input_time',
];

function readConversationSummariesMap(geminiRoot = join(homedir(), '.gemini')) {
  const map = new Map();
  if (!geminiRoot || typeof geminiRoot !== 'string') return map;
  for (const sub of ['antigravity', 'antigravity-ide', 'antigravity-cli']) {
    const dbPath = join(geminiRoot, sub, 'conversation_summaries.db');
    if (!existsSync(dbPath)) continue;
    let db = null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const tableCols = db.prepare(`PRAGMA table_info(conversation_summaries)`).all();
      const colNames = new Set(
        tableCols.map((c) => (typeof c?.name === 'string' ? c.name : '')).filter(Boolean)
      );
      if (!colNames.has('conversation_id')) continue;

      const selectedCols = SUMMARY_CANDIDATE_COLUMNS.filter((c) => colNames.has(c));
      const rows = db
        .prepare(`SELECT ${selectedCols.join(', ')} FROM conversation_summaries`)
        .all();

      for (const r of rows) {
        const sessionId =
          typeof r.conversation_id === 'string' && r.conversation_id.trim()
            ? r.conversation_id.trim()
            : null;
        if (!sessionId) continue;

        const title =
          cleanSummaryTitle(r.title) ||
          cleanSummaryTitle(r.summary) ||
          cleanSummaryTitle(r.preview) ||
          null;
        const workspacePath = parseSummaryWorkspacePath(r.workspace_uris, r.workspace_path);
        const updatedAtMs =
          parseSummaryTimestampMs(r.updated_at_ms) ??
          parseSummaryTimestampMs(r.last_modified_time) ??
          parseSummaryTimestampMs(r.updated_at) ??
          parseSummaryTimestampMs(r.last_user_input_time) ??
          null;
        const parentSessionId =
          typeof r.parent_conversation_id === 'string' && r.parent_conversation_id.trim() !== ''
            ? r.parent_conversation_id.trim()
            : null;
        const isSubagent = Boolean(parentSessionId);

        const prev = map.get(sessionId);
        if (!prev) {
          map.set(sessionId, { title, workspacePath, updatedAtMs, isSubagent, parentSessionId });
        } else {
          const prevTs = prev.updatedAtMs ?? -1;
          const nextTs = updatedAtMs ?? -1;
          const useNextPrimary = nextTs >= prevTs;
          map.set(sessionId, {
            title: useNextPrimary ? title || prev.title : prev.title || title,
            workspacePath: useNextPrimary
              ? workspacePath || prev.workspacePath
              : prev.workspacePath || workspacePath,
            updatedAtMs: nextTs > prevTs ? updatedAtMs : prev.updatedAtMs,
            isSubagent: prev.isSubagent || isSubagent,
            parentSessionId: useNextPrimary
              ? parentSessionId || prev.parentSessionId || null
              : prev.parentSessionId || parentSessionId || null,
          });
        }
      }
    } catch {
      // Ignore locked, malformed, or missing summary db
    } finally {
      try {
        db?.close();
      } catch {
        // Ignore close error
      }
    }
  }
  return map;
}

/**
 * Load Antigravity conversation titles, workspace paths, and update timestamps
 * from `~/.gemini/{antigravity,antigravity-ide,antigravity-cli}/conversation_summaries.db`.
 * Inspects table schema defensively so missing columns or tables never throw.
 * @param {string} [geminiRoot]
 * @returns {Map<string, { title: string | null, workspacePath: string | null, updatedAtMs: number | null }>}
 */
export function loadAntigravitySessionTitles(geminiRoot = join(homedir(), '.gemini')) {
  const full = readConversationSummariesMap(geminiRoot);
  const out = new Map();
  for (const [sessionId, entry] of full.entries()) {
    const item = {
      title: entry.title,
      workspacePath: entry.workspacePath,
      updatedAtMs: entry.updatedAtMs,
    };
    if (entry.parentSessionId) {
      item.parentSessionId = entry.parentSessionId;
    }
    out.set(sessionId, item);
  }
  return out;
}

function loadConversationMetaMap(geminiRoot) {
  return readConversationSummariesMap(geminiRoot);
}

export class AntigravityAdapter {
  constructor({
    store,
    onTurns,
    geminiRoot = join(homedir(), '.gemini'),
    enableRpc = true,
    isEnabled = () => true,
    discoverServers = discoverAntigravityLanguageServers,
  }) {
    this.store = store;
    this.onTurns = onTurns;
    this.geminiRoot = geminiRoot;
    this.enableRpc = enableRpc;
    this.isEnabled = isEnabled;
    this.discoverServers = discoverServers;
    this.fileMtimes = new Map();
    this.pendingOpenFiles = new Map();
    this.watchers = [];
    this.timer = null;
    this.backfillTimer = null;
    this.pending = null;
    this.lsServers = null;
    this.lsDiscoveredAt = 0;
    this._scanning = false;
    this._stopped = false;
  }

  listTranscriptFiles() {
    const hosts = [
      { sub: 'antigravity', host: 'antigravity-desktop' },
      { sub: 'antigravity-ide', host: 'antigravity-ide' },
      { sub: 'antigravity-cli', host: 'antigravity-cli' },
    ];
    const results = [];
    for (const { sub, host } of hosts) {
      const brainDir = join(this.geminiRoot, sub, 'brain');
      if (!existsSync(brainDir)) continue;
      let entries;
      try {
        entries = readdirSync(brainDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const fp = join(brainDir, ent.name, '.system_generated', 'logs', 'transcript.jsonl');
        try {
          const st = statSync(fp);
          results.push({ fp, sessionId: ent.name, host, mtimeMs: st.mtimeMs, sizeBytes: st.size });
        } catch {
          // No transcript yet
        }
      }
    }
    return results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  async getServers(nowMs = null) {
    if (!this.enableRpc) return null;
    const checkNow = nowMs ?? Date.now();
    if (this.lsDiscoveredAt > 0 && checkNow - this.lsDiscoveredAt < 15000) return this.lsServers;
    this.lsServers = await this.discoverServers({ geminiRoot: this.geminiRoot });
    this.lsDiscoveredAt = nowMs ?? Date.now();
    return this.lsServers;
  }

  async scan({ maxRecentFiles = 20, nowMs } = {}) {
    if (this.isEnabled && !this.isEnabled()) return [];
    if (this._scanning) return [];
    this._scanning = true;
    try {
      const effectiveNow = nowMs ?? Date.now();
      let listed = this.listTranscriptFiles();
      if (this.pendingOpenFiles.size > 0) {
        const livePaths = new Set(listed.map((f) => f.fp));
        for (const fp of this.pendingOpenFiles.keys()) {
          if (!livePaths.has(fp)) this.pendingOpenFiles.delete(fp);
        }
      }
      if (Number.isFinite(maxRecentFiles)) {
        const top = listed.slice(0, maxRecentFiles);
        if (this.pendingOpenFiles.size > 0) {
          const topSet = new Set(top.map((f) => f.fp));
          for (const item of listed.slice(maxRecentFiles)) {
            if (this.pendingOpenFiles.has(item.fp) && !topSet.has(item.fp)) {
              top.push(item);
              topSet.add(item.fp);
            }
          }
        }
        listed = top;
      }
      const dirtyFiles = listed
        .reverse()
        .filter(({ fp, mtimeMs, sizeBytes }) => {
          const pending = this.pendingOpenFiles.get(fp);
          if (pending) {
            const modified = pending.mtimeMs !== mtimeMs || pending.sizeBytes !== sizeBytes;
            const readyToFlush = effectiveNow - mtimeMs > OPEN_TURN_FLUSH_MS;
            return modified || readyToFlush;
          }
          const mem = this.fileMtimes.get(fp);
          if (mem && mem.mtimeMs === mtimeMs && mem.sizeBytes === sizeBytes) return false;
          const cached = this.store.getIngestedFile?.(fp);
          if (cached && cached.mtimeMs === mtimeMs && cached.sizeBytes === sizeBytes) {
            this.fileMtimes.set(fp, { mtimeMs, sizeBytes });
            return false;
          }
          return true;
        });
      if (dirtyFiles.length === 0) return [];

      const metaMap = loadConversationMetaMap(this.geminiRoot);
      const hasRecentFile = dirtyFiles.some(({ mtimeMs }) => effectiveNow - mtimeMs < 15 * 60_000);
      const servers = hasRecentFile ? await this.getServers(nowMs) : null;
      const changed = [];

      for (const { fp, sessionId, host, mtimeMs, sizeBytes } of dirtyFiles) {
        let content;
        try {
          content = readFileSync(fp, 'utf8');
        } catch {
          continue;
        }
        let speedIndex = null;
        if (servers && servers.length > 0 && effectiveNow - mtimeMs < 15 * 60_000) {
          const meta = await fetchGeneratorMetadata(servers, sessionId);
          if (meta) speedIndex = buildAntigravitySpeedIndex(meta);
        }

        const convMeta = metaMap.get(sessionId);
        const effectiveHost = convMeta?.isSubagent ? 'antigravity-subagent' : host;
        const flushOpenTurns = effectiveNow - mtimeMs > OPEN_TURN_FLUSH_MS;
        const { turns, hasOpenTurns } = parseAntigravityTranscriptDetailed(content, {
          sessionId,
          host: effectiveHost,
          workspacePath: convMeta?.workspacePath || null,
          speedIndex,
          flushOpenTurns,
        });

        for (const t of turns) {
          const res = this.store.upsertTurn(t);
          if (res.changed) changed.push(res.record);
        }

        if (hasOpenTurns && !flushOpenTurns) {
          this.fileMtimes.delete(fp);
          this.pendingOpenFiles.set(fp, { mtimeMs, sizeBytes });
        } else {
          this.pendingOpenFiles.delete(fp);
          this.fileMtimes.set(fp, { mtimeMs, sizeBytes });
          this.store.setIngestedFile?.(fp, mtimeMs, sizeBytes);
        }
      }

      if (changed.length > 0 && this.onTurns) {
        this.onTurns(changed);
      }
      return changed;
    } finally {
      this._scanning = false;
    }
  }

  async start() {
    this._stopped = false;
    await this.scan({ maxRecentFiles: 12 });
    const runBackfill = () => {
      this.backfillTimer = null;
      if (this._stopped) return;
      if (this._scanning) {
        this.backfillTimer = setTimeout(runBackfill, 300);
        this.backfillTimer.unref?.();
        return;
      }
      this.scan({ maxRecentFiles: Infinity }).catch(() => {});
    };
    this.backfillTimer = setTimeout(runBackfill, 300);
    this.backfillTimer.unref?.();
    for (const sub of ['antigravity', 'antigravity-ide', 'antigravity-cli']) {
      const brainDir = join(this.geminiRoot, sub, 'brain');
      if (!existsSync(brainDir)) continue;
      try {
        const w = watch(brainDir, { recursive: true }, (_, fn) => {
          if (typeof fn === 'string' && fn.endsWith('transcript.jsonl')) {
            this.scheduleScan();
          }
        });
        this.watchers.push(w);
      } catch {
        // Poll covers fallback
      }
    }
    this.timer = setInterval(() => {
      this.scan({ maxRecentFiles: 8 }).catch(() => {});
    }, 2000);
    this.timer.unref?.();
  }

  scheduleScan() {
    if (this._stopped || this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      if (this._stopped) return;
      if (this._scanning) {
        this.scheduleScan();
        return;
      }
      this.scan({ maxRecentFiles: 8 }).catch(() => {});
    }, 150);
    this.pending.unref?.();
  }

  stop() {
    this._stopped = true;
    for (const w of this.watchers) w.close();
    this.watchers = [];
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.backfillTimer) {
      clearTimeout(this.backfillTimer);
      this.backfillTimer = null;
    }
    if (this.pending) {
      clearTimeout(this.pending);
      this.pending = null;
    }
  }
}
