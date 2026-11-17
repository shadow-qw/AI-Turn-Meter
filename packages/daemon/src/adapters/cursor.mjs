import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export function defaultStateDir() {
  return process.env.AI_TURN_METER_STATE_DIR || join(homedir(), '.local', 'share', 'ai-turn-meter');
}

function loadState(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return { inflight: {}, completedGenIds: {} };
  }
}

function saveState(filePath, state) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpFile = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpFile, JSON.stringify(state));
  renameSync(tmpFile, filePath);
}

function pruneOldEntries(state, nowMs) {
  const maxAge = 6 * 3600 * 1000;
  for (const [k, v] of Object.entries(state.inflight || {})) {
    if (!v || nowMs - (v.updatedAtMs || v.startedAtMs || 0) > maxAge) {
      delete state.inflight[k];
    }
  }
  for (const [k, ts] of Object.entries(state.completedGenIds || {})) {
    if (typeof ts !== 'number' || nowMs - ts > maxAge) {
      delete state.completedGenIds[k];
    }
  }
}

/**
 * Process a single Cursor lifecycle hook JSON event into either updated inflight state
 * or a completed normalized turn payload ready for TurnStore.upsertTurn().
 *
 * @param {object} payload
 * @param {{ stateDir?: string, nowMs?: number }} [opts]
 * @returns {object | null}
 */
export function processCursorHookPayload(payload, { stateDir = defaultStateDir(), nowMs = Date.now() } = {}) {
  if (!payload || typeof payload !== 'object') return null;
  const eventName = payload.hook_event_name || payload.event;
  if (!eventName) return null;

  const stateFile = join(stateDir, 'cursor-inflight.json');
  const state = loadState(stateFile);
  pruneOldEntries(state, nowMs);

  const convId = String(payload.conversation_id || 'default');
  const genId = payload.generation_id ? String(payload.generation_id) : null;
  const inflightKey = genId ? `${convId}:${genId}` : convId;

  const workspacePath =
    (Array.isArray(payload.workspace_roots) && payload.workspace_roots[0]) ||
    payload.cwd ||
    null;

  if (eventName === 'beforeSubmitPrompt') {
    const entry = {
      startedAtMs: nowMs,
      updatedAtMs: nowMs,
      toolWaitMs: 0,
      toolActiveStartMs: null,
      workspacePath,
    };
    state.inflight[inflightKey] = entry;
    state.inflight[convId] = entry;
    saveState(stateFile, state);
    return null;
  }

  if (eventName === 'beforeShellExecution' || eventName === 'beforeMCPExecution') {
    const entry = state.inflight[inflightKey] || state.inflight[convId];
    if (entry && entry.toolActiveStartMs === null) {
      entry.toolActiveStartMs = nowMs;
      entry.updatedAtMs = nowMs;
      saveState(stateFile, state);
    }
    return null;
  }

  if (eventName === 'afterShellExecution' || eventName === 'afterMCPExecution') {
    const entry = state.inflight[inflightKey] || state.inflight[convId];
    if (entry) {
      if (entry.toolActiveStartMs !== null && nowMs >= entry.toolActiveStartMs) {
        entry.toolWaitMs += nowMs - entry.toolActiveStartMs;
      }
      entry.toolActiveStartMs = null;
      entry.updatedAtMs = nowMs;
      saveState(stateFile, state);
    }
    return null;
  }

  if (eventName === 'afterAgentResponse' || eventName === 'stop') {
    const turnId = genId || `turn-${nowMs}`;
    const dedupKey = `${convId}:${turnId}`;
    if (state.completedGenIds[dedupKey]) {
      return null;
    }

    const entry = state.inflight[inflightKey] || state.inflight[convId] || null;
    const msgText =
      typeof payload.text === 'string' && payload.text.trim()
        ? payload.text
        : typeof payload.last_assistant_message === 'string' && payload.last_assistant_message.trim()
          ? payload.last_assistant_message
          : null;
    if (
      entry &&
      (msgText || (eventName === 'stop' && entry.toolActiveStartMs !== null))
    ) {
      if (msgText) entry.replyPreview = msgText;
      if (eventName === 'stop' && entry.toolActiveStartMs !== null) {
        if (nowMs >= entry.toolActiveStartMs) {
          entry.toolWaitMs += nowMs - entry.toolActiveStartMs;
        }
        entry.toolActiveStartMs = null;
      }
      entry.updatedAtMs = nowMs;
      saveState(stateFile, state);
    }

    const hasTokens =
      typeof payload.input_tokens === 'number' || typeof payload.output_tokens === 'number';
    if (!hasTokens) {
      return null;
    }

    const startedAtMs = entry?.startedAtMs ?? null;
    const toolWaitMs = entry?.toolWaitMs ?? 0;

    // Cursor docs: input_tokens is inclusive of cache_read_tokens + cache_write_tokens
    const totalInputTokens = Number(payload.input_tokens) || 0;
    const cacheReadTokens = Number(payload.cache_read_tokens) || 0;
    const cacheWriteTokens = Number(payload.cache_write_tokens) || 0;
    const outputTokens = Number(payload.output_tokens) || 0;

    let durationMs = null;
    let modelActiveMs = null;
    let tpsMethod = 'unavailable';

    if (startedAtMs !== null && nowMs >= startedAtMs) {
      durationMs = nowMs - startedAtMs;
      const net = Math.max(150, durationMs - toolWaitMs);
      modelActiveMs = net;
      tpsMethod = toolWaitMs > 0 ? 'e2e_minus_tools' : 'e2e_turn';
    }

    state.completedGenIds[dedupKey] = nowMs;
    delete state.inflight[inflightKey];
    if (state.inflight[convId] === entry) delete state.inflight[convId];
    saveState(stateFile, state);

    return {
      turnUid: `cursor:${convId}:${turnId}`,
      tool: 'cursor',
      host: 'cursor-ide',
      sessionId: convId,
      turnId,
      model: payload.model_id || payload.model || 'unknown',
      workspacePath: workspacePath || entry?.workspacePath || null,
      startedAtMs,
      completedAtMs: nowMs,
      callCount: 1,
      totalInputTokens,
      uncachedInputTokens: Math.max(0, totalInputTokens - cacheReadTokens - cacheWriteTokens),
      cacheReadTokens,
      cacheWriteTokens,
      outputTokens,
      thinkingTokens: null,
      durationMs,
      modelActiveMs,
      ttftMs: null,
      tpsMethod,
      replyPreview: msgText || entry?.replyPreview || null,
    };
  }

  return null;
}

export function drainCursorSpool(store, stateDir = defaultStateDir()) {
  const spoolFile = join(stateDir, 'cursor-spool.jsonl');
  if (!existsSync(spoolFile)) return [];
  const tmpFile = `${spoolFile}.draining-${process.pid}-${Date.now()}`;
  let lines;
  try {
    renameSync(spoolFile, tmpFile);
    lines = readFileSync(tmpFile, 'utf8').split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  } finally {
    try {
      if (existsSync(tmpFile)) rmSync(tmpFile, { force: true });
    } catch {
      // ignore cleanup error
    }
  }
  const records = [];
  for (const l of lines) {
    try {
      const turn = JSON.parse(l);
      const res = store.upsertTurn(turn);
      if (res.changed) records.push(res.record);
    } catch {
      // ignore malformed spool line
    }
  }
  return records;
}
