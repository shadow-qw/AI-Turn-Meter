import { readdirSync, readFileSync, statSync, watch } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

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
 * Parse a Codex session rollout JSONL string into completed TurnRecord inputs.
 * @param {string} content
 * @param {string} filePath
 */
export function parseCodexSessionContent(content, filePath = '') {
  const lines = content.split(/\r?\n/);
  let sessionId = filePath.split('/').pop()?.replace(/\.jsonl$/, '') || 'codex-session';
  let workspacePath = null;
  let currentModel = 'unknown';

  /** @type {Map<string, any>} */
  const turns = new Map();
  const completedTurns = [];

  function ensureTurn(turnId, startedAtMs = null) {
    if (!turnId) return null;
    let t = turns.get(turnId);
    if (!t) {
      t = {
        turnId,
        model: currentModel,
        startedAtMs,
        calls: [],
        seenResponseIds: new Set(),
        lastCallEndMs: null,
        pendingToolStartMs: null,
        lastToolEndMs: null,
        toolWaitMs: 0,
        promptAnchorMs: null,
        firstGenStartMs: null,
        genIntervals: [],
        lastTokenCountTotal: null,
        fallbackTurnUsage: { input: 0, cached: 0, cacheWrite: 0, output: 0, thinking: 0, calls: 0 },
      };
      turns.set(turnId, t);
    }
    if (startedAtMs !== null && t.startedAtMs === null) {
      t.startedAtMs = startedAtMs;
    }
    if (t.model === 'unknown' && currentModel !== 'unknown') {
      t.model = currentModel;
    }
    return t;
  }

  let activeTurnId = null;

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
      if (typeof p.id === 'string' && p.id) sessionId = p.id;
      if (typeof p.cwd === 'string' && p.cwd) workspacePath = p.cwd;
      continue;
    }

    if (topType === 'turn_context') {
      if (typeof p.model === 'string' && p.model) currentModel = p.model;
      if (typeof p.cwd === 'string' && p.cwd && !workspacePath) workspacePath = p.cwd;
      if (typeof p.turn_id === 'string' && p.turn_id) {
        activeTurnId = p.turn_id;
        const t = ensureTurn(activeTurnId, tsMs);
        if (t && currentModel !== 'unknown') t.model = currentModel;
      }
      continue;
    }

    if (topType === 'token_usage_record') {
      const turnId = p.turn_id || activeTurnId;
      const t = ensureTurn(turnId, tsMs);
      if (!t) continue;
      if (typeof p.session_id === 'string' && p.session_id) sessionId = p.session_id;

      // Flush any completed tool execution window before this API call finished
      if (t.lastCallEndMs !== null && t.lastToolEndMs !== null && t.lastToolEndMs > t.lastCallEndMs) {
        t.toolWaitMs += t.lastToolEndMs - t.lastCallEndMs;
      }
      t.lastToolEndMs = null;
      if (tsMs !== null) t.lastCallEndMs = tsMs;

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
      if (typeof m === 'string' && m) currentModel = m;
      const cwd = p.thread_settings?.cwd;
      if (typeof cwd === 'string' && cwd && !workspacePath) workspacePath = cwd;
      continue;
    }

    if (pt === 'task_started') {
      activeTurnId = p.turn_id || activeTurnId;
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
        if (t.lastTokenCountTotal !== sig) {
          t.lastTokenCountTotal = sig;
          t.fallbackTurnUsage.input += Number(last.input_tokens) || 0;
          t.fallbackTurnUsage.cached += Number(last.cached_input_tokens) || 0;
          t.fallbackTurnUsage.cacheWrite += Number(last.cache_write_input_tokens) || 0;
          t.fallbackTurnUsage.output += Number(last.output_tokens) || 0;
          t.fallbackTurnUsage.thinking += Number(last.reasoning_output_tokens) || 0;
          t.fallbackTurnUsage.calls += 1;
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
      const durationMs =
        typeof p.duration_ms === 'number' && p.duration_ms >= 0
          ? p.duration_ms
          : t.startedAtMs !== null
            ? Math.max(0, completedAtMs - t.startedAtMs)
            : null;
      const rawTtftMs =
        typeof p.time_to_first_token_ms === 'number' && p.time_to_first_token_ms >= 0
          ? p.time_to_first_token_ms
          : null;

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

      if (totalInputTokens > 0 || outputTokens > 0) {
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
          turnUid: `codex:${sessionId}:${turnId}`,
          tool: 'codex',
          host: 'codex-desktop',
          sessionId,
          turnId,
          model: t.model || currentModel,
          workspacePath,
          startedAtMs: t.startedAtMs,
          completedAtMs,
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
            typeof p.last_agent_message === 'string' && p.last_agent_message.trim()
              ? p.last_agent_message
              : t.lastAgentText || null,
        });
      }

      if (activeTurnId === turnId) activeTurnId = null;
    }
  }

  return completedTurns;
}

function collectJsonlFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      collectJsonlFiles(full, out);
    } else if (ent.isFile() && ent.name.endsWith('.jsonl')) {
      out.push(full);
    }
  }
  return out;
}

export class CodexAdapter {
  constructor({ store, onTurns, sessionsDir = join(homedir(), '.codex', 'sessions') }) {
    this.store = store;
    this.onTurns = onTurns;
    this.sessionsDir = sessionsDir;
    this.fileMtimes = new Map();
    this.watcher = null;
    this.timer = null;
  }

  scan({ maxRecentFiles = 30 } = {}) {
    const files = collectJsonlFiles(this.sessionsDir)
      .map((fp) => {
        try {
          return { fp, mtimeMs: statSync(fp).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, maxRecentFiles)
      .reverse();

    const changed = [];
    for (const { fp, mtimeMs } of files) {
      if (this.fileMtimes.get(fp) === mtimeMs) continue;
      this.fileMtimes.set(fp, mtimeMs);
      let content;
      try {
        content = readFileSync(fp, 'utf8');
      } catch {
        continue;
      }
      const turns = parseCodexSessionContent(content, fp);
      for (const t of turns) {
        const res = this.store.upsertTurn(t);
        if (res.changed) changed.push(res.record);
      }
    }
    if (changed.length > 0 && this.onTurns) {
      this.onTurns(changed);
    }
    return changed;
  }

  start() {
    this.scan();
    try {
      this.watcher = watch(this.sessionsDir, { recursive: true }, () => {
        this.scheduleScan();
      });
    } catch {
      // Directory may not exist yet; poll fallback covers it
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
    this.watcher?.close();
    if (this.timer) clearInterval(this.timer);
    if (this.pending) clearTimeout(this.pending);
  }
}
