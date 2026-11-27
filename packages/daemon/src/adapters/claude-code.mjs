import { existsSync, readdirSync, readFileSync, statSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { normalizePreviewText } from '../format.mjs';
import {
  accumulateUsageBucket,
  finalizeUsageBuckets,
  normalizeInferenceGeo,
  normalizeServiceTier,
} from '../pricing.mjs';

function parseTimestampMs(ts) {
  if (typeof ts === 'number' && Number.isFinite(ts)) {
    return ts > 0 && ts < 1e12 ? ts * 1000 : ts;
  }
  if (typeof ts !== 'string' || !ts.trim()) return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

function toFiniteNonNeg(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  return v;
}

function mergeIntervalsMs(intervals) {
  const valid = intervals
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s)
    .sort((a, b) => a[0] - b[0]);
  if (valid.length === 0) return 0;
  let total = 0;
  let [curStart, curEnd] = valid[0];
  for (let i = 1; i < valid.length; i += 1) {
    const [s, e] = valid[i];
    if (s <= curEnd) {
      if (e > curEnd) curEnd = e;
    } else {
      total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    }
  }
  return total + (curEnd - curStart);
}

/**
 * Classify a Claude Code `type === 'user'` JSONL entry.
 * @param {any} obj
 * @returns {'user_prompt' | 'tool_result' | 'meta' | 'ignore'}
 */
function classifyUserEntry(obj) {
  if (obj?.isMeta === true) return 'meta';
  const content = obj?.message?.content ?? obj?.content;

  if (typeof content === 'string') {
    if (obj?.toolUseResult !== undefined) return 'tool_result';
    return content.trim().length > 0 ? 'user_prompt' : 'ignore';
  }

  if (Array.isArray(content)) {
    let hasToolResult = obj?.toolUseResult !== undefined;
    let hasText = false;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'tool_result') {
        hasToolResult = true;
      } else if (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
        hasText = true;
      }
    }
    if (hasToolResult) return 'tool_result';
    if (hasText) return 'user_prompt';
    return 'ignore';
  }

  return obj?.toolUseResult !== undefined ? 'tool_result' : 'ignore';
}

function extractAssistantTextParts(content) {
  if (typeof content === 'string') {
    const trimmed = content.trim();
    return trimmed ? [trimmed] : [];
  }
  if (!Array.isArray(content)) return [];
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      const trimmed = block.text.trim();
      if (trimmed) parts.push(trimmed);
    }
  }
  return parts;
}

function contentHasToolUse(content) {
  if (!Array.isArray(content)) return false;
  return content.some((block) => block && typeof block === 'object' && block.type === 'tool_use');
}

/**
 * Parse a Claude Code local session JSONL (`~/.claude/projects/<encoded-project>/*.jsonl`)
 * into normalized TurnRecord inputs.
 *
 * @param {string} content
 * @param {{ sessionId?: string | null, workspacePath?: string | null, filePath?: string }} [opts]
 */
export function parseClaudeCodeSessionContent(
  content,
  {
    sessionId = null,
    workspacePath = null,
    filePath = '',
    tool = 'claude',
    // Cross-file dedupe: resumed/forked sessions copy earlier API calls (same message.id +
    // requestId) into a new file. Calls for which isForeignCall(key) is true belong to another
    // file and are skipped; every key seen is added to seenCallKeys; turns left empty only
    // because their calls were skipped get their turnUid pushed to droppedTurnUids.
    isForeignCall = null,
    seenCallKeys = null,
    droppedTurnUids = null,
  } = {}
) {
  if (typeof content !== 'string' || !content.trim()) return [];
  const foreignMemo = new Map();
  const callIsForeign = (key) => {
    if (typeof isForeignCall !== 'function') return false;
    if (!foreignMemo.has(key)) foreignMemo.set(key, Boolean(isForeignCall(key)));
    return foreignMemo.get(key);
  };

  const lines = content.split(/\r?\n/);
  const explicitSessionId = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : null;
  const explicitWorkspacePath =
    typeof workspacePath === 'string' && workspacePath.trim() ? workspacePath.trim() : null;

  let resolvedSessionId = explicitSessionId;
  let resolvedWorkspacePath = explicitWorkspacePath;
  let resolvedAgentId = null;

  const rawTurns = [];
  let current = null;
  let turnCounter = 0;

  const startTurn = (startedAtMs, cwd = null) => {
    if (current) {
      rawTurns.push(current);
    }
    turnCounter += 1;
    current = {
      turnIndex: turnCounter,
      model: 'unknown',
      workspacePath: cwd || resolvedWorkspacePath || null,
      startedAtMs,
      lastAssistantTsMs: null,
      pendingToolStartMs: null,
      lastToolResultTsMs: null,
      toolIntervals: [],
      calls: new Map(),
      callOrder: [],
      anonSeq: 0,
    };
    return current;
  };

  const flushPendingToolWait = (turn) => {
    if (
      turn &&
      turn.pendingToolStartMs !== null &&
      turn.lastToolResultTsMs !== null &&
      turn.lastToolResultTsMs > turn.pendingToolStartMs
    ) {
      turn.toolIntervals.push([turn.pendingToolStartMs, turn.lastToolResultTsMs]);
    }
    if (turn) {
      turn.pendingToolStartMs = null;
      turn.lastToolResultTsMs = null;
    }
  };

  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;

    if (!resolvedSessionId && typeof obj.sessionId === 'string' && obj.sessionId.trim()) {
      resolvedSessionId = obj.sessionId.trim();
    }
    if (!resolvedAgentId && typeof obj.agentId === 'string' && obj.agentId.trim()) {
      resolvedAgentId = obj.agentId.trim();
    }
    const lineCwd = typeof obj.cwd === 'string' && obj.cwd.trim() ? obj.cwd.trim() : null;
    if (lineCwd) {
      if (!resolvedWorkspacePath) resolvedWorkspacePath = lineCwd;
      if (current && !current.workspacePath) current.workspacePath = lineCwd;
    }

    const tsMs = parseTimestampMs(obj.timestamp);

    if (obj.type === 'user') {
      const kind = classifyUserEntry(obj);
      if (kind === 'user_prompt') {
        startTurn(tsMs, lineCwd);
      } else if (kind === 'tool_result' && current && tsMs !== null) {
        if (current.pendingToolStartMs === null && current.lastAssistantTsMs !== null) {
          current.pendingToolStartMs = current.lastAssistantTsMs;
        }
        if (current.lastToolResultTsMs === null || tsMs > current.lastToolResultTsMs) {
          current.lastToolResultTsMs = tsMs;
        }
      }
      continue;
    }

    if (obj.type !== 'assistant') continue;
    if (obj.isApiErrorMessage === true) continue;

    const msg = obj.message;
    if (!msg || typeof msg !== 'object') continue;

    if (typeof msg.id === 'string' && msg.id.trim()) {
      const callKey = `${msg.id.trim()}|${typeof obj.requestId === 'string' ? obj.requestId.trim() : ''}`;
      seenCallKeys?.add(callKey);
      if (callIsForeign(callKey)) {
        if (current) current.hadForeignCall = true;
        continue;
      }
    }

    const rawModel = typeof msg.model === 'string' ? msg.model.trim() : '';
    if (rawModel === '<synthetic>') continue;

    const usage = msg.usage;
    const hasUsage = Boolean(usage && typeof usage === 'object');
    const textParts = extractAssistantTextParts(msg.content);
    const hasToolUse = contentHasToolUse(msg.content);

    if (!hasUsage && textParts.length === 0 && !hasToolUse) continue;

    if (!current) {
      startTurn(tsMs, lineCwd);
    }

    const msgId =
      typeof msg.id === 'string' && msg.id.trim()
        ? msg.id.trim()
        : typeof obj.uuid === 'string' && obj.uuid.trim()
          ? obj.uuid.trim()
          : `anon-${(current.anonSeq += 1)}`;

    const isNewCall = !current.calls.has(msgId);
    if (isNewCall && current.lastToolResultTsMs !== null) {
      flushPendingToolWait(current);
    }

    if (rawModel && rawModel.toLowerCase() !== 'unknown') {
      current.model = rawModel;
    }
    if (current.startedAtMs === null && tsMs !== null) {
      current.startedAtMs = tsMs;
    }
    if (tsMs !== null && (current.lastAssistantTsMs === null || tsMs > current.lastAssistantTsMs)) {
      current.lastAssistantTsMs = tsMs;
    }

    if (hasToolUse && tsMs !== null && current.lastToolResultTsMs === null) {
      current.pendingToolStartMs = tsMs;
    }

    let entry = current.calls.get(msgId);
    if (!entry) {
      entry = {
        id: msgId,
        model: null,
        hasUsage: false,
        uncachedInput: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        output: 0,
        thinking: null,
        serviceTier: null,
        inferenceGeo: null,
        textParts: [],
        seenTexts: new Set(),
      };
      current.calls.set(msgId, entry);
      current.callOrder.push(entry);
    }
    if (rawModel && rawModel.toLowerCase() !== 'unknown') {
      entry.model = rawModel;
    }

    if (hasUsage) {
      entry.hasUsage = true;
      const uncached = toFiniteNonNeg(usage.input_tokens) ?? 0;
      const cacheRead = toFiniteNonNeg(usage.cache_read_input_tokens) ?? 0;
      const e5m =
        usage.cache_creation && typeof usage.cache_creation === 'object'
          ? toFiniteNonNeg(usage.cache_creation.ephemeral_5m_input_tokens)
          : null;
      const e1h =
        usage.cache_creation && typeof usage.cache_creation === 'object'
          ? toFiniteNonNeg(usage.cache_creation.ephemeral_1h_input_tokens)
          : null;
      const rawCW = toFiniteNonNeg(usage.cache_creation_input_tokens);
      const cw1h = e1h ?? 0;
      const cw5m = e5m !== null ? e5m : Math.max(0, (rawCW ?? 0) - cw1h);
      const cacheWrite = Math.max(rawCW ?? 0, cw5m + cw1h);
      const output = toFiniteNonNeg(usage.output_tokens) ?? 0;
      const thinking =
        toFiniteNonNeg(usage.output_tokens_details?.thinking_tokens) ??
        toFiniteNonNeg(usage.thinking_tokens) ??
        toFiniteNonNeg(usage.reasoning_output_tokens);

      entry.uncachedInput = Math.max(entry.uncachedInput, uncached);
      entry.cacheRead = Math.max(entry.cacheRead, cacheRead);
      entry.cacheWrite1h = Math.max(entry.cacheWrite1h, cw1h);
      entry.cacheWrite = Math.max(entry.cacheWrite, cacheWrite);
      entry.cacheWrite5m = Math.max(0, entry.cacheWrite - entry.cacheWrite1h);
      entry.output = Math.max(entry.output, output);
      if (thinking !== null) {
        entry.thinking = entry.thinking === null ? thinking : Math.max(entry.thinking, thinking);
      }
      const speedTier = normalizeServiceTier(usage.speed);
      const rawTier = normalizeServiceTier(usage.service_tier);
      const callTier = speedTier || rawTier;
      if (callTier) entry.serviceTier = callTier;
      const geo = normalizeInferenceGeo(usage.inference_geo);
      if (geo) entry.inferenceGeo = geo;
    }

    for (const part of textParts) {
      if (!entry.seenTexts.has(part)) {
        entry.seenTexts.add(part);
        entry.textParts.push(part);
      }
    }
  }

  if (current) {
    rawTurns.push(current);
  }

  const finalSessionId =
    resolvedSessionId || (filePath ? basename(filePath, '.jsonl') : '') || 'claude-code-session';
  const resolvedTool = typeof tool === 'string' && tool.trim() ? tool.trim() : 'claude';
  const turnIdFor = (rt) =>
    resolvedAgentId ? `agent-${resolvedAgentId}-turn-${rt.turnIndex}` : `turn-${rt.turnIndex}`;
  const markDropped = (rt) => {
    if (rt.hadForeignCall && Array.isArray(droppedTurnUids)) {
      droppedTurnUids.push(`${resolvedTool}:${finalSessionId}:${turnIdFor(rt)}`);
    }
  };

  const completed = [];
  for (const rt of rawTurns) {
    const usageCalls = rt.callOrder.filter((c) => c.hasUsage);
    if (usageCalls.length === 0) {
      markDropped(rt);
      continue;
    }

    let uncachedInputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let outputTokens = 0;
    let thinkingTokens = 0;
    let hasThinking = false;
    const bucketMap = new Map();

    for (const c of usageCalls) {
      uncachedInputTokens += c.uncachedInput;
      cacheReadTokens += c.cacheRead;
      cacheWriteTokens += c.cacheWrite;
      outputTokens += c.output;
      if (c.thinking !== null) {
        thinkingTokens += c.thinking;
        hasThinking = true;
      }
      accumulateUsageBucket(bucketMap, {
        model: c.model || rt.model,
        serviceTier: c.serviceTier,
        inferenceGeo: c.inferenceGeo,
        uncachedInput: c.uncachedInput,
        cacheRead: c.cacheRead,
        cacheWrite5m: c.cacheWrite5m,
        cacheWrite1h: c.cacheWrite1h,
        output: c.output,
      });
    }

    const totalInputTokens = uncachedInputTokens + cacheReadTokens + cacheWriteTokens;
    if (totalInputTokens === 0 && outputTokens === 0) {
      markDropped(rt);
      continue;
    }
    const usageBuckets = finalizeUsageBuckets(bucketMap);

    let replyPreview = null;
    for (let i = rt.callOrder.length - 1; i >= 0; i -= 1) {
      const joined = rt.callOrder[i].textParts.join(' ').trim();
      if (joined) {
        replyPreview = normalizePreviewText(joined);
        if (replyPreview) break;
      }
    }

    const startedAtMs = rt.startedAtMs;
    const completedAtMs = rt.lastAssistantTsMs ?? startedAtMs ?? Date.now();
    const durationMs =
      startedAtMs !== null && completedAtMs >= startedAtMs ? Math.round(completedAtMs - startedAtMs) : null;

    const clampedToolIntervals =
      startedAtMs !== null
        ? rt.toolIntervals
            .map(([s, e]) => [Math.max(startedAtMs, s), Math.min(completedAtMs, e)])
            .filter(([s, e]) => e > s)
        : rt.toolIntervals;
    const toolWaitMs = Math.round(mergeIntervalsMs(clampedToolIntervals));

    let modelActiveMs = null;
    let tpsMethod = 'unavailable';
    if (durationMs !== null) {
      const withoutTools = Math.max(0, durationMs - toolWaitMs);
      if (toolWaitMs > 0 && withoutTools >= 150) {
        modelActiveMs = withoutTools;
        tpsMethod = 'e2e_minus_tools';
      } else if (durationMs >= 150) {
        modelActiveMs = durationMs;
        tpsMethod = 'e2e_turn';
      } else {
        modelActiveMs = durationMs;
        tpsMethod = 'unavailable';
      }
    }

    const denomMs = modelActiveMs !== null && modelActiveMs >= 150 ? modelActiveMs : null;
    const tps =
      denomMs !== null && outputTokens > 0
        ? Number((outputTokens / (denomMs / 1000)).toFixed(1))
        : null;
    if (tps === null) {
      tpsMethod = 'unavailable';
    }

    const turnId = turnIdFor(rt);
    completed.push({
      turnUid: `${resolvedTool}:${finalSessionId}:${turnId}`,
      tool: resolvedTool,
      host: 'claude-code',
      sessionId: finalSessionId,
      turnId,
      model: rt.model,
      workspacePath: rt.workspacePath || resolvedWorkspacePath || null,
      startedAtMs,
      completedAtMs,
      callCount: usageCalls.length,
      totalInputTokens,
      uncachedInputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      outputTokens,
      thinkingTokens: hasThinking ? thinkingTokens : null,
      durationMs,
      modelActiveMs,
      ttftMs: null,
      tps,
      tpsMethod,
      usageBuckets,
      replyPreview,
    });
  }

  return completed;
}

// Claude Code names each main transcript after its session UUID. A forked session's file can still
// carry the source session's id on the lines it copied, so the file name is the session identity.
const SESSION_FILE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fileOrderMs(st) {
  const born = Number(st.birthtimeMs);
  return born > 0 ? Math.min(born, st.mtimeMs) : st.mtimeMs;
}

export class ClaudeCodeAdapter {
  constructor({
    store,
    onTurns,
    claudeRoot = join(homedir(), '.claude'),
    isEnabled = () => true,
  }) {
    this.store = store;
    this.onTurns = onTurns;
    this.claudeRoot = claudeRoot;
    this.projectsDir = join(claudeRoot, 'projects');
    this.isEnabled = isEnabled;
    this.fileMtimes = new Map();
    this.watchers = [];
    this.timer = null;
    this.backfillTimer = null;
    this.pending = null;
  }

  listSessionFiles() {
    const results = [];
    if (!existsSync(this.projectsDir)) return results;

    let projDirs;
    try {
      projDirs = readdirSync(this.projectsDir, { withFileTypes: true });
    } catch {
      return results;
    }

    for (const projEnt of projDirs) {
      if (!projEnt.isDirectory()) continue;
      const projPath = join(this.projectsDir, projEnt.name);
      let entries;
      try {
        entries = readdirSync(projPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ent of entries) {
        if (ent.isFile() && ent.name.endsWith('.jsonl')) {
          const fp = join(projPath, ent.name);
          const base = basename(ent.name, '.jsonl');
          try {
            const st = statSync(fp);
            results.push({
              fp,
              sessionId: base,
              // Session id the turns are filed under. Legacy top-level agent-*.jsonl files keep the
              // session id recorded in their lines.
              ownSessionId: SESSION_FILE_UUID_RE.test(base) ? base : null,
              projectDir: projEnt.name,
              mtimeMs: st.mtimeMs,
              orderMs: fileOrderMs(st),
              sizeBytes: st.size,
            });
          } catch {
            // File may have been removed mid-scan
          }
        } else if (ent.isDirectory() && ent.name !== 'memory') {
          const subDir = join(projPath, ent.name, 'subagents');
          if (!existsSync(subDir)) continue;
          let subEntries;
          try {
            subEntries = readdirSync(subDir, { withFileTypes: true });
          } catch {
            continue;
          }
          for (const subEnt of subEntries) {
            if (!subEnt.isFile() || !subEnt.name.endsWith('.jsonl')) continue;
            const fp = join(subDir, subEnt.name);
            try {
              const st = statSync(fp);
              results.push({
                fp,
                sessionId: ent.name,
                ownSessionId: ent.name,
                projectDir: projEnt.name,
                mtimeMs: st.mtimeMs,
                orderMs: fileOrderMs(st),
                sizeBytes: st.size,
              });
            } catch {
              // File may have been removed mid-scan
            }
          }
        }
      }
    }

    return results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  scan({ maxRecentFiles = 30 } = {}) {
    if (this.isEnabled && !this.isEnabled()) return [];

    let files = this.listSessionFiles();
    if (Number.isFinite(maxRecentFiles)) {
      files = files.slice(0, maxRecentFiles);
    }

    // Oldest-created first: the original session file owns the API calls that resumed or forked
    // copies of it repeat, and each call is counted exactly once.
    files.sort((a, b) => a.orderMs - b.orderMs || a.mtimeMs - b.mtimeMs || (a.fp < b.fp ? -1 : a.fp > b.fp ? 1 : 0));

    const changed = [];
    for (const { fp, ownSessionId, mtimeMs, sizeBytes } of files) {
      const mem = this.fileMtimes.get(fp);
      if (mem && mem.mtimeMs === mtimeMs && mem.sizeBytes === sizeBytes) continue;

      const cached = this.store.getIngestedFile?.(fp);
      if (cached && cached.mtimeMs === mtimeMs && cached.sizeBytes === sizeBytes) {
        this.fileMtimes.set(fp, { mtimeMs, sizeBytes });
        continue;
      }

      let content;
      try {
        content = readFileSync(fp, 'utf8');
      } catch {
        continue;
      }

      const seenCallKeys = new Set();
      const droppedTurnUids = [];
      const turns = parseClaudeCodeSessionContent(content, {
        filePath: fp,
        sessionId: ownSessionId,
        isForeignCall: this.store.isCallOwnedByOtherFile
          ? (key) => this.store.isCallOwnedByOtherFile(key, fp)
          : null,
        seenCallKeys,
        droppedTurnUids,
      });
      this.store.claimCallKeys?.(fp, seenCallKeys);
      this.fileMtimes.set(fp, { mtimeMs, sizeBytes });
      for (const t of turns) {
        const res = this.store.upsertTurn(t);
        if (res.changed) changed.push(res.record);
      }
      // Rows written before turn provenance existed: turns of this file that only repeated calls
      // owned by another file were double counted.
      this.store.deleteTurns?.(droppedTurnUids);
      this.store.syncFileTurns?.(fp, turns.map((t) => t.turnUid));
      this.store.setIngestedFile?.(fp, mtimeMs, sizeBytes);
    }

    if (changed.length > 0 && this.onTurns) {
      this.onTurns(changed);
    }
    return changed;
  }

  start() {
    this.scan({ maxRecentFiles: this.store.ingestResetPending ? Infinity : 24 });
    this.backfillTimer = setTimeout(() => {
      this.backfillTimer = null;
      this.scan({ maxRecentFiles: Infinity });
    }, 200);
    this.backfillTimer.unref?.();

    if (existsSync(this.projectsDir)) {
      try {
        const w = watch(this.projectsDir, { recursive: true }, (_, fn) => {
          if (!fn || (typeof fn === 'string' && fn.endsWith('.jsonl'))) {
            this.scheduleScan();
          }
        });
        this.watchers.push(w);
      } catch {
        // Poll fallback covers missing/unwatchable directory
      }
    }

    this.timer = setInterval(() => this.scan({ maxRecentFiles: 12 }), 2000);
    this.timer.unref?.();
  }

  scheduleScan() {
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      this.scan({ maxRecentFiles: 12 });
    }, 150);
    this.pending.unref?.();
  }

  stop() {
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
