import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, watch } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MIN_STREAMING_SEC = 0.15;

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
 * Parse an Antigravity transcript.jsonl into completed user-turn summaries.
 * @param {string} content
 * @param {object} opts
 */
export function parseAntigravityTranscriptContent(
  content,
  {
    sessionId,
    host = 'antigravity-desktop',
    workspacePath = null,
    speedIndex = null,
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
  if (steps.length === 0) return [];

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
        plannerSteps: [],
        lastStep: s,
        closedByNextInput: false,
      };
    }

    const tMs = parseIsoMs(s.created_at);
    if (tMs !== null) current.lastAtMs = tMs;
    current.lastStep = s;
    if (s.type === 'PLANNER_RESPONSE') {
      current.plannerSteps.push(s);
    }
  }
  if (current) rawTurns.push(current);

  const completed = [];
  for (const rt of rawTurns) {
    if (rt.plannerSteps.length === 0) continue;
    const lastPlanner = rt.plannerSteps[rt.plannerSteps.length - 1];
    const hasPendingTools =
      Array.isArray(lastPlanner.tool_calls) && lastPlanner.tool_calls.length > 0;
    const isFinalPlannerDone =
      rt.lastStep === lastPlanner && lastPlanner.status === 'DONE' && !hasPendingTools;

    if (!rt.closedByNextInput && !isFinalPlannerDone) {
      // Turn is still mid-execution
      continue;
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

      if (speedIndex instanceof Map) {
        const sp = speedIndex.get(ps.step_index);
        if (sp) {
          if (sp.model) {
            const stepWeight = Math.max(1, inp + cr + out);
            modelWeights.set(sp.model, (modelWeights.get(sp.model) || 0) + stepWeight);
          }
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

    let tps = null;
    let tpsMethod = 'unavailable';
    if (sumStreamingMs >= MIN_STREAMING_SEC * 1000 && sumStreamOut > 0) {
      tps = Number((sumStreamOut / (sumStreamingMs / 1000)).toFixed(1));
      tpsMethod = 'streaming_decode';
    }

    const totalInputTokens = uncachedInputTokens + cacheReadTokens;
    const durationMs =
      rt.startedAtMs !== null && rt.lastAtMs !== null && rt.lastAtMs >= rt.startedAtMs
        ? rt.lastAtMs - rt.startedAtMs
        : null;

    completed.push({
      turnUid: `antigravity:${sessionId}:turn-${rt.startedStepIndex}`,
      tool: 'antigravity',
      host,
      sessionId,
      turnId: `turn-${rt.startedStepIndex}`,
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
      modelActiveMs: sumStreamingMs > 0 ? sumStreamingMs : null,
      ttftMs: firstTtftMs,
      tps,
      tpsMethod,
      replyPreview,
    });
  }

  return completed;
}

/**
 * Discover local Antigravity LanguageServerService HTTP/HTTPS port + CSRF token from current user's processes.
 */
export async function discoverAntigravityLanguageServers() {
  try {
    const uid = process.getuid?.();
    const { stdout: psOut } = await execFileAsync('ps', ['-axo', 'pid=,uid=,command='], {
      timeout: 2000,
    });
    const candidates = [];
    for (const line of psOut.split(/\r?\n/)) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
      if (!m) continue;
      if (uid !== undefined && Number(m[2]) !== uid) continue;
      const cmd = m[3];
      if (!/language_server(?:\.native)?\b/.test(cmd) || !/--standalone\b/.test(cmd)) continue;
      const csrf = cmd.match(/--csrf_token(?:=|\s+)"?([^\s"]+)/)?.[1];
      if (csrf) candidates.push({ pid: Number(m[1]), csrf });
    }
    if (candidates.length === 0) return null;

    const results = [];
    for (const c of candidates) {
      try {
        const { stdout: lsofOut } = await execFileAsync(
          'lsof',
          ['-Pan', '-p', String(c.pid), '-iTCP', '-sTCP:LISTEN', '-Fn'],
          { timeout: 2000 }
        );
        const ports = [];
        for (const l of lsofOut.split(/\r?\n/)) {
          const pm = l.startsWith('n') && l.match(/:(\d+)(?:\s|$)/);
          if (pm) ports.push(Number(pm[1]));
        }
        if (ports.length > 0) results.push({ pid: c.pid, csrf: c.csrf, ports });
      } catch {
        // Ignore single pid error
      }
    }
    return results;
  } catch {
    return null;
  }
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
    for (const port of srv.ports) {
      for (const useHttps of [true, false]) {
        const res = await postJsonLocal(port, srv.csrf, path, body, useHttps);
        if (res && Array.isArray(res.generatorMetadata)) {
          return res.generatorMetadata;
        }
      }
    }
  }
  return null;
}

function loadConversationMetaMap(geminiRoot) {
  const map = new Map();
  for (const sub of ['antigravity', 'antigravity-ide', 'antigravity-cli']) {
    const dbPath = join(geminiRoot, sub, 'conversation_summaries.db');
    if (!existsSync(dbPath)) continue;
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const rows = db
        .prepare(
          `SELECT conversation_id, workspace_uris, parent_conversation_id FROM conversation_summaries`
        )
        .all();
      for (const r of rows) {
        let uris = [];
        try {
          uris = JSON.parse(r.workspace_uris || '[]');
        } catch {
          if (typeof r.workspace_uris === 'string' && r.workspace_uris.startsWith('file://')) {
            uris = [r.workspace_uris];
          }
        }
        const first = Array.isArray(uris) ? uris[0] : null;
        const workspacePath =
          typeof first === 'string' && first
            ? first.startsWith('file://')
              ? decodeURIComponent(first.replace(/^file:\/\//, ''))
              : first
            : null;
        const isSubagent =
          typeof r.parent_conversation_id === 'string' && r.parent_conversation_id.trim() !== '';
        map.set(r.conversation_id, { workspacePath, isSubagent });
      }
      db.close();
    } catch {
      // Ignore locked or missing summary db
    }
  }
  return map;
}

export class AntigravityAdapter {
  constructor({ store, onTurns, geminiRoot = join(homedir(), '.gemini'), enableRpc = true, isEnabled = () => true }) {
    this.store = store;
    this.onTurns = onTurns;
    this.geminiRoot = geminiRoot;
    this.enableRpc = enableRpc;
    this.isEnabled = isEnabled;
    this.fileMtimes = new Map();
    this.watchers = [];
    this.timer = null;
    this.backfillTimer = null;
    this.lsServers = null;
    this.lsDiscoveredAt = 0;
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

  async getServers() {
    if (!this.enableRpc) return null;
    if (this.lsServers && Date.now() - this.lsDiscoveredAt < 15000) return this.lsServers;
    this.lsServers = await discoverAntigravityLanguageServers();
    this.lsDiscoveredAt = Date.now();
    return this.lsServers;
  }

  async scan({ maxRecentFiles = 20 } = {}) {
    if (this.isEnabled && !this.isEnabled()) return [];
    let listed = this.listTranscriptFiles();
    if (Number.isFinite(maxRecentFiles)) {
      listed = listed.slice(0, maxRecentFiles);
    }
    const dirtyFiles = listed
      .reverse()
      .filter(({ fp, mtimeMs, sizeBytes }) => {
        if (this.fileMtimes.get(fp) === mtimeMs) return false;
        const cached = this.store.getIngestedFile?.(fp);
        if (cached && cached.mtimeMs === mtimeMs && cached.sizeBytes === sizeBytes) {
          this.fileMtimes.set(fp, mtimeMs);
          return false;
        }
        return true;
      });
    if (dirtyFiles.length === 0) return [];

    const nowMs = Date.now();
    const metaMap = loadConversationMetaMap(this.geminiRoot);
    const hasRecentFile = dirtyFiles.some(({ mtimeMs }) => nowMs - mtimeMs < 15 * 60_000);
    const servers = hasRecentFile ? await this.getServers() : null;
    const changed = [];

    for (const { fp, sessionId, host, mtimeMs, sizeBytes } of dirtyFiles) {
      let content;
      try {
        content = readFileSync(fp, 'utf8');
      } catch {
        continue;
      }
      let speedIndex = null;
      if (servers && servers.length > 0 && nowMs - mtimeMs < 15 * 60_000) {
        const meta = await fetchGeneratorMetadata(servers, sessionId);
        if (meta) speedIndex = buildAntigravitySpeedIndex(meta);
      }

      const convMeta = metaMap.get(sessionId);
      const effectiveHost = convMeta?.isSubagent ? 'antigravity-subagent' : host;
      const turns = parseAntigravityTranscriptContent(content, {
        sessionId,
        host: effectiveHost,
        workspacePath: convMeta?.workspacePath || null,
        speedIndex,
      });

      this.fileMtimes.set(fp, mtimeMs);
      for (const t of turns) {
        const res = this.store.upsertTurn(t);
        if (res.changed) changed.push(res.record);
      }
      this.store.setIngestedFile?.(fp, mtimeMs, sizeBytes);
    }

    if (changed.length > 0 && this.onTurns) {
      this.onTurns(changed);
    }
    return changed;
  }

  async start() {
    await this.scan({ maxRecentFiles: 12 });
    this.backfillTimer = setTimeout(() => {
      this.backfillTimer = null;
      this.scan({ maxRecentFiles: Infinity }).catch(() => {});
    }, 300);
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
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      this.scan({ maxRecentFiles: 8 }).catch(() => {});
    }, 150);
  }

  stop() {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    if (this.timer) clearInterval(this.timer);
    if (this.backfillTimer) clearTimeout(this.backfillTimer);
    if (this.pending) clearTimeout(this.pending);
  }
}
