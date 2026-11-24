import { readdirSync, readFileSync, statSync, watch } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { zstdDecompressSync } from 'node:zlib';

const CODEX_OPENAI_MODEL_RE = /^(?:openai\/)?(?:gpt-|o1|o3|o4|codex-|chatgpt-)/i;
const OPEN_TURN_FLUSH_MS = 120_000;

/**
 * Return true when `model` is an OpenAI / Codex model rather than a third-party gateway proxy.
 * @param {string} model
 */
export function isCodexOpenAiModel(model) {
  if (typeof model !== 'string') return false;
  const trimmed = model.trim();
  if (!trimmed || trimmed.toLowerCase() === 'unknown') return false;
  return CODEX_OPENAI_MODEL_RE.test(trimmed);
}

function parseIsoMs(ts) {
  if (typeof ts !== 'string') return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Sum non-overlapping [startMs, endMs] intervals in milliseconds.
 * @param {Array<[number, number]>} intervals
 */
function mergeIntervalsMs(intervals) {
  const valid = intervals
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s)
    .sort((a, b) => a[0] - b[0]);
  if (valid.length === 0) return 0;
  let total = 0;
  let [curStart, curEnd] = valid[0];
  for (let i = 1; i < valid.length; i++) {
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
 * Parse a Codex session rollout JSONL string into completed TurnRecord inputs plus open-turn status.
 * @param {string} content
 * @param {string} filePath
 * @param {{ flushOpenTurns?: boolean, onlyOpenAiModels?: boolean }} [opts]
 * @returns {{ turns: Array<object>, hasOpenTurns: boolean }}
 */
export function parseCodexSessionDetailed(
  content,
  filePath = '',
  { flushOpenTurns = false, onlyOpenAiModels = true } = {}
) {
  const lines = content.split(/\r?\n/);
  let sessionId = filePath.split('/').pop()?.replace(/\.jsonl$/, '') || 'codex-session';
  let hasSessionMetaId = false;
  let isForkedRollout = /_[0-9a-f-]{20,}\.jsonl$/i.test(filePath);
  let workspacePath = null;
  let currentModel = 'unknown';

  /** @type {Map<string, any>} */
  const turns = new Map();
  const completedTurns = [];

  let fileLastTotalSig = null;
  let hasSeenTokenUsageRecord = false;
  let skippedForkBaseline = false;

  function ensureTurn(turnId, startedAtMs = null) {
    if (!turnId) return null;
    let t = turns.get(turnId);
    if (!t) {
      t = {
        turnId,
        model: currentModel,
        hasTurnContextModel: false,
        startedAtMs,
        lastEventMs: startedAtMs,
        calls: [],
        seenResponseIds: new Set(),
        lastCallEndMs: null,
        pendingToolStartMs: null,
        lastToolEndMs: null,
        toolWaitMs: 0,
        promptAnchorMs: null,
        firstGenStartMs: null,
        genIntervals: [],
        fallbackTurnUsage: { input: 0, cached: 0, cacheWrite: 0, output: 0, thinking: 0, calls: 0 },
        lastAgentText: null,
        flushed: false,
      };
      turns.set(turnId, t);
    }
    if (startedAtMs !== null && t.startedAtMs === null) {
      t.startedAtMs = startedAtMs;
    }
    if (startedAtMs !== null) {
      t.lastEventMs = startedAtMs;
    }
    if (!t.hasTurnContextModel && t.model === 'unknown' && currentModel !== 'unknown') {
      t.model = currentModel;
    }
    return t;
  }

  function finalizeTurn(t, { completedAtMs, explicitDurationMs = null, rawTtftMs = null, lastAgentMessage = null } = {}) {
    if (!t || t.flushed) return;
    t.flushed = true;

    const effectiveModel = t.model !== 'unknown' ? t.model : currentModel;
    if (onlyOpenAiModels && !isCodexOpenAiModel(effectiveModel)) {
      return;
    }

    let totalInputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let outputTokens = 0;
    let thinkingTokens = 0;
    let callCount = t.calls.length;

    if (t.calls.length > 0) {
      const lastTurnUsage = [...t.calls].reverse().find((c) => c.turnUsage)?.turnUsage;
      if (lastTurnUsage) {
        totalInputTokens = Number(lastTurnUsage.input_tokens) || 0;
        cacheReadTokens = Number(lastTurnUsage.cached_input_tokens) || 0;
        cacheWriteTokens = Number(lastTurnUsage.cache_write_input_tokens) || 0;
        outputTokens = Number(lastTurnUsage.output_tokens) || 0;
        thinkingTokens = Number(lastTurnUsage.reasoning_output_tokens) || 0;
      } else {
        for (const c of t.calls) {
          if (!c.usage) continue;
          totalInputTokens += Number(c.usage.input_tokens) || 0;
          cacheReadTokens += Number(c.usage.cached_input_tokens) || 0;
          cacheWriteTokens += Number(c.usage.cache_write_input_tokens) || 0;
          outputTokens += Number(c.usage.output_tokens) || 0;
          thinkingTokens += Number(c.usage.reasoning_output_tokens) || 0;
        }
      }
    } else if (t.fallbackTurnUsage.calls > 0) {
      totalInputTokens = t.fallbackTurnUsage.input;
      cacheReadTokens = t.fallbackTurnUsage.cached;
      cacheWriteTokens = t.fallbackTurnUsage.cacheWrite;
      outputTokens = t.fallbackTurnUsage.output;
      thinkingTokens = t.fallbackTurnUsage.thinking;
      callCount = t.fallbackTurnUsage.calls;
    }

    if (totalInputTokens <= 0 && outputTokens <= 0) return;

    const resolvedCompletedMs = completedAtMs ?? t.lastEventMs ?? t.startedAtMs ?? Date.now();
    const durationMs =
      explicitDurationMs !== null && explicitDurationMs >= 0
        ? explicitDurationMs
        : t.startedAtMs !== null
          ? Math.max(0, resolvedCompletedMs - t.startedAtMs)
          : null;

    const genMs = mergeIntervalsMs(t.genIntervals);
    const anchorMs = t.promptAnchorMs ?? t.startedAtMs;
    let ttftMs = rawTtftMs;
    if (genMs >= 150 && t.firstGenStartMs !== null) {
      ttftMs =
        anchorMs !== null && t.firstGenStartMs >= anchorMs
          ? Math.round(t.firstGenStartMs - anchorMs)
          : thinkingTokens === 0
            ? rawTtftMs
            : null;
    }

    let modelActiveMs = null;
    let tpsMethod = 'e2e_turn';
    if (genMs >= 150) {
      modelActiveMs = Math.round(genMs);
      tpsMethod = 'streaming_decode';
    } else if (durationMs !== null) {
      const withoutTools = Math.max(0, durationMs - t.toolWaitMs);
      // Only subtract Codex time_to_first_token_ms when no hidden reasoning ran,
      // because Codex sets it at the first visible AgentMessage token after Reasoning.
      if (callCount === 1 && thinkingTokens === 0 && ttftMs !== null && withoutTools - ttftMs >= 150) {
        modelActiveMs = withoutTools - ttftMs;
        tpsMethod = 'active_model';
      } else if (t.toolWaitMs > 0 && withoutTools >= 150) {
        modelActiveMs = withoutTools;
        tpsMethod = 'active_model';
      } else {
        modelActiveMs = durationMs;
        tpsMethod = ttftMs !== null && callCount > 1 ? 'active_model' : 'e2e_turn';
      }
    }

    completedTurns.push({
      turnUid: `codex:${sessionId}:${t.turnId}`,
      tool: 'codex',
      host: 'codex-desktop',
      sessionId,
      turnId: t.turnId,
      model: effectiveModel,
      workspacePath,
      startedAtMs: t.startedAtMs,
      completedAtMs: resolvedCompletedMs,
      callCount,
      totalInputTokens,
      uncachedInputTokens: Math.max(0, totalInputTokens - cacheReadTokens - cacheWriteTokens),
      cacheReadTokens,
      cacheWriteTokens,
      outputTokens,
      thinkingTokens,
      durationMs,
      modelActiveMs,
      ttftMs,
      tpsMethod,
      replyPreview:
        typeof lastAgentMessage === 'string' && lastAgentMessage.trim()
          ? lastAgentMessage
          : t.lastAgentText || null,
    });
  }

  let activeTurnId = null;

  function switchActiveTurn(newTurnId, tsMs) {
    if (activeTurnId && newTurnId && activeTurnId !== newTurnId) {
      const prev = turns.get(activeTurnId);
      if (prev && !prev.flushed) {
        finalizeTurn(prev, { completedAtMs: prev.lastEventMs ?? tsMs });
      }
    }
    if (newTurnId) activeTurnId = newTurnId;
  }

  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    const tsMs = parseIsoMs(obj.timestamp);
    const topType = obj.type;
    const p = obj.payload;
    if (!p || typeof p !== 'object') continue;

    if (topType === 'session_meta') {
      const metaId = typeof p.id === 'string' && p.id ? p.id : typeof p.session_id === 'string' && p.session_id ? p.session_id : null;
      if (metaId) {
        sessionId = metaId;
        hasSessionMetaId = true;
      }
      if (p.forked_from_id || p.history_base || p.subagent_history_start_ordinal) {
        isForkedRollout = true;
      }
      if (typeof p.cwd === 'string' && p.cwd) workspacePath = p.cwd;
      continue;
    }

    if (topType === 'turn_context') {
      if (typeof p.model === 'string' && p.model) currentModel = p.model;
      if (typeof p.cwd === 'string' && p.cwd && !workspacePath) workspacePath = p.cwd;
      if (typeof p.turn_id === 'string' && p.turn_id) {
        switchActiveTurn(p.turn_id, tsMs);
        const t = ensureTurn(activeTurnId, tsMs);
        if (t && typeof p.model === 'string' && p.model) {
          t.model = p.model;
          t.hasTurnContextModel = true;
        }
      }
      continue;
    }

    if (topType === 'token_usage_record') {
      hasSeenTokenUsageRecord = true;
      const turnId = p.turn_id || activeTurnId;
      const t = ensureTurn(turnId, tsMs);
      if (!t) continue;
      if (!hasSessionMetaId && typeof p.session_id === 'string' && p.session_id) {
        sessionId = p.session_id;
      }

      // Flush any completed tool execution window before this API call finished
      if (t.lastCallEndMs !== null && t.lastToolEndMs !== null && t.lastToolEndMs > t.lastCallEndMs) {
        t.toolWaitMs += t.lastToolEndMs - t.lastCallEndMs;
      }
      t.lastToolEndMs = null;
      if (tsMs !== null) {
        t.lastCallEndMs = tsMs;
        t.lastEventMs = tsMs;
      }

      const respId = typeof p.response_id === 'string' ? p.response_id : null;
      if (!respId || !t.seenResponseIds.has(respId)) {
        if (respId) t.seenResponseIds.add(respId);
        t.calls.push({
          usage: p.usage || null,
          turnUsage: p.turn_token_usage || null,
          tsMs,
        });
      }
      continue;
    }

    if (topType === 'response_item') {
      const t = ensureTurn(activeTurnId, tsMs);
      if (t && tsMs !== null) {
        t.lastEventMs = tsMs;
        if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
          t.lastToolEndMs = tsMs;
        }
      }
      continue;
    }

    if (topType !== 'event_msg') continue;
    const pt = p.type;

    if (pt === 'thread_settings_applied') {
      const m = p.thread_settings?.model;
      if (typeof m === 'string' && m) {
        currentModel = m;
        // Only backfill if current active turn had no turn_context model yet
        const activeTurn = activeTurnId ? turns.get(activeTurnId) : null;
        if (activeTurn && !activeTurn.hasTurnContextModel && activeTurn.model === 'unknown') {
          activeTurn.model = m;
        }
      }
      const cwd = p.thread_settings?.cwd;
      if (typeof cwd === 'string' && cwd && !workspacePath) workspacePath = cwd;
      continue;
    }

    if (pt === 'task_started') {
      switchActiveTurn(p.turn_id, tsMs);
      const startedMs =
        tsMs ?? (typeof p.started_at === 'number' ? p.started_at * 1000 : null);
      ensureTurn(activeTurnId, startedMs);
      continue;
    }

    if (pt === 'token_count') {
      const t = ensureTurn(activeTurnId, tsMs);
      const last = p.info?.last_token_usage;
      const total = p.info?.total_token_usage;
      if (t && last && typeof last === 'object') {
        const sig = JSON.stringify(total || last);
        if (fileLastTotalSig !== sig) {
          fileLastTotalSig = sig;
          const totalIn = Number(total?.input_tokens) || 0;
          const lastIn = Number(last.input_tokens) || 0;
          // In forked/resumed rollouts, initial token_count before any new call reflects the inherited parent baseline.
          if (
            isForkedRollout &&
            !hasSeenTokenUsageRecord &&
            !skippedForkBaseline &&
            t.fallbackTurnUsage.calls === 0 &&
            t.calls.length === 0 &&
            totalIn > lastIn
          ) {
            skippedForkBaseline = true;
          } else {
            t.fallbackTurnUsage.input += lastIn;
            t.fallbackTurnUsage.cached += Number(last.cached_input_tokens) || 0;
            t.fallbackTurnUsage.cacheWrite += Number(last.cache_write_input_tokens) || 0;
            t.fallbackTurnUsage.output += Number(last.output_tokens) || 0;
            t.fallbackTurnUsage.thinking += Number(last.reasoning_output_tokens) || 0;
            t.fallbackTurnUsage.calls += 1;
          }
        }
      }
      continue;
    }

    if (pt === 'item_completed') {
      const turnId = p.turn_id || activeTurnId;
      const t = ensureTurn(turnId, tsMs);
      const itemType = p.item?.type;
      const itemStart =
        typeof p.started_at_ms === 'number' && Number.isFinite(p.started_at_ms) ? p.started_at_ms : null;
      const itemEnd =
        typeof p.completed_at_ms === 'number' && Number.isFinite(p.completed_at_ms) ? p.completed_at_ms : null;

      if (t && itemType === 'UserMessage' && itemEnd !== null) {
        t.promptAnchorMs = t.promptAnchorMs === null ? itemEnd : Math.min(t.promptAnchorMs, itemEnd);
      } else if (t && (itemType === 'Reasoning' || itemType === 'AgentMessage')) {
        if (itemType === 'AgentMessage') {
          const textPart = Array.isArray(p.item?.content)
            ? p.item.content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join(' ')
            : '';
          if (textPart.trim()) t.lastAgentText = textPart;
        }
        if (itemStart !== null) {
          t.firstGenStartMs =
            t.firstGenStartMs === null ? itemStart : Math.min(t.firstGenStartMs, itemStart);
          if (itemEnd !== null && itemEnd > itemStart) {
            t.genIntervals.push([itemStart, itemEnd]);
          }
        }
      }
      continue;
    }

    if (pt === 'task_complete') {
      const turnId = p.turn_id || activeTurnId;
      const t = ensureTurn(turnId, tsMs);
      if (!t) continue;

      const completedAtMs =
        tsMs ??
        (typeof p.completed_at === 'number' ? p.completed_at * 1000 : Date.now());
      const explicitDurationMs =
        typeof p.duration_ms === 'number' && p.duration_ms >= 0 ? p.duration_ms : null;
      const rawTtftMs =
        typeof p.time_to_first_token_ms === 'number' && p.time_to_first_token_ms >= 0
          ? p.time_to_first_token_ms
          : null;

      finalizeTurn(t, {
        completedAtMs,
        explicitDurationMs,
        rawTtftMs,
        lastAgentMessage: p.last_agent_message,
      });

      if (activeTurnId === turnId) activeTurnId = null;
    }
  }

  function canEmitTurn(t) {
    if (!t || t.flushed) return false;
    const effectiveModel = t.model !== 'unknown' ? t.model : currentModel;
    if (onlyOpenAiModels && !isCodexOpenAiModel(effectiveModel)) {
      return false;
    }
    if (t.calls.length > 0) {
      const lastTurnUsage = [...t.calls].reverse().find((c) => c.turnUsage)?.turnUsage;
      if (lastTurnUsage) {
        return (Number(lastTurnUsage.input_tokens) || 0) > 0 || (Number(lastTurnUsage.output_tokens) || 0) > 0;
      }
      let inp = 0;
      let out = 0;
      for (const c of t.calls) {
        if (!c.usage) continue;
        inp += Number(c.usage.input_tokens) || 0;
        out += Number(c.usage.output_tokens) || 0;
      }
      return inp > 0 || out > 0;
    }
    if (t.fallbackTurnUsage.calls > 0) {
      return t.fallbackTurnUsage.input > 0 || t.fallbackTurnUsage.output > 0;
    }
    return false;
  }

  let hasOpenTurns = false;
  if (flushOpenTurns) {
    for (const t of turns.values()) {
      if (!t.flushed) {
        finalizeTurn(t, { completedAtMs: t.lastEventMs });
      }
    }
  } else {
    for (const t of turns.values()) {
      if (canEmitTurn(t)) {
        hasOpenTurns = true;
        break;
      }
    }
  }

  return { turns: completedTurns, hasOpenTurns };
}

/**
 * Parse a Codex session rollout JSONL string into completed TurnRecord inputs.
 * @param {string} content
 * @param {string} filePath
 * @param {{ flushOpenTurns?: boolean, onlyOpenAiModels?: boolean }} [opts]
 */
export function parseCodexSessionContent(
  content,
  filePath = '',
  opts = {}
) {
  return parseCodexSessionDetailed(content, filePath, opts).turns;
}

function collectJsonlFiles(dir, out = [], maxFiles = Infinity) {
  if (!dir || out.length >= maxFiles) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  entries.sort((a, b) => b.name.localeCompare(a.name));
  for (const ent of entries) {
    if (out.length >= maxFiles) break;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      collectJsonlFiles(full, out, maxFiles);
    } else if (ent.isFile() && (ent.name.endsWith('.jsonl') || ent.name.endsWith('.jsonl.zst'))) {
      out.push(full);
    }
  }
  return out;
}

export class CodexAdapter {
  constructor({
    store,
    onTurns,
    sessionsDir = join(homedir(), '.codex', 'sessions'),
    archivedDir,
    isEnabled = () => true,
  }) {
    this.store = store;
    this.onTurns = onTurns;
    this.sessionsDir = sessionsDir;
    this.archivedDir =
      archivedDir !== undefined
        ? archivedDir
        : basename(sessionsDir) === 'sessions'
          ? join(dirname(sessionsDir), 'archived_sessions')
          : null;
    this.isEnabled = isEnabled;
    this.fileMtimes = new Map();
    this.pendingOpenFiles = new Map();
    this.watchers = [];
    this.timer = null;
    this.backfillTimer = null;
  }

  scan({ maxRecentFiles = 30, nowMs = Date.now() } = {}) {
    if (this.isEnabled && !this.isEnabled()) return [];
    const collectLimit = Number.isFinite(maxRecentFiles) ? Math.max(maxRecentFiles * 3, 90) : Infinity;
    const rawPaths = [];
    collectJsonlFiles(this.sessionsDir, rawPaths, collectLimit);
    if (this.archivedDir) {
      collectJsonlFiles(this.archivedDir, rawPaths, collectLimit);
    }

    let files = rawPaths
      .map((fp) => {
        try {
          const st = statSync(fp);
          return { fp, mtimeMs: st.mtimeMs, sizeBytes: st.size };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (Number.isFinite(maxRecentFiles)) {
      const top = files.slice(0, maxRecentFiles);
      if (this.pendingOpenFiles.size > 0) {
        const topSet = new Set(top.map((f) => f.fp));
        for (const item of files.slice(maxRecentFiles)) {
          if (this.pendingOpenFiles.has(item.fp) && !topSet.has(item.fp)) {
            top.push(item);
            topSet.add(item.fp);
          }
        }
        for (const fp of [...this.pendingOpenFiles.keys()]) {
          if (topSet.has(fp)) continue;
          try {
            const st = statSync(fp);
            top.push({ fp, mtimeMs: st.mtimeMs, sizeBytes: st.size });
            topSet.add(fp);
          } catch {
            this.pendingOpenFiles.delete(fp);
          }
        }
      }
      files = top;
    }
    files.reverse();

    const changed = [];
    for (const { fp, mtimeMs, sizeBytes } of files) {
      const flushOpenTurns = fp.endsWith('.jsonl.zst') || nowMs - mtimeMs > OPEN_TURN_FLUSH_MS;
      const pending = this.pendingOpenFiles.get(fp);
      if (pending) {
        const modified = pending.mtimeMs !== mtimeMs || pending.sizeBytes !== sizeBytes;
        if (!modified && !flushOpenTurns) continue;
      } else {
        const mem = this.fileMtimes.get(fp);
        if (mem && mem.mtimeMs === mtimeMs && mem.sizeBytes === sizeBytes) continue;
        const cached = this.store.getIngestedFile?.(fp);
        if (cached && cached.mtimeMs === mtimeMs && cached.sizeBytes === sizeBytes) {
          this.fileMtimes.set(fp, { mtimeMs, sizeBytes });
          continue;
        }
      }
      let content;
      try {
        if (fp.endsWith('.jsonl.zst')) {
          content = zstdDecompressSync(readFileSync(fp)).toString('utf8');
        } else {
          content = readFileSync(fp, 'utf8');
        }
      } catch {
        continue;
      }
      const { turns, hasOpenTurns } = parseCodexSessionDetailed(content, fp, {
        flushOpenTurns,
        onlyOpenAiModels: true,
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
  }

  start() {
    this.scan({ maxRecentFiles: 24 });
    this.backfillTimer = setTimeout(() => {
      this.backfillTimer = null;
      this.scan({ maxRecentFiles: Infinity });
    }, 150);
    this.backfillTimer.unref?.();
    for (const dir of [this.sessionsDir, this.archivedDir].filter(Boolean)) {
      try {
        const w = watch(dir, { recursive: true }, () => {
          this.scheduleScan();
        });
        this.watchers.push(w);
      } catch {
        // Directory may not exist yet; poll fallback covers it
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
  }

  stop() {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    if (this.timer) clearInterval(this.timer);
    if (this.backfillTimer) clearTimeout(this.backfillTimer);
    if (this.pending) clearTimeout(this.pending);
  }
}
