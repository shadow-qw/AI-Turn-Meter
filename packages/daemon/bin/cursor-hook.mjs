#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { AUTH_TOKEN_HEADER, readDaemonToken } from '../src/auth.mjs';

const PORT = Number(process.env.AI_TURN_METER_PORT || 47831);

function defaultStateDir() {
  return process.env.AI_TURN_METER_STATE_DIR || join(homedir(), '.local', 'share', 'ai-turn-meter');
}

function loadInflightState(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return { inflight: {}, completedGenIds: {} };
  }
}

function saveInflightState(filePath, state) {
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
 * Lightweight offline Cursor hook state machine (mirrors adapters/cursor.mjs without importing quota.mjs/node:sqlite).
 */
function processCursorHookPayloadLocal(payload, { stateDir = defaultStateDir(), nowMs = Date.now() } = {}) {
  if (!payload || typeof payload !== 'object') return null;
  const eventName = payload.hook_event_name || payload.event;
  if (!eventName) return null;

  const stateFile = join(stateDir, 'cursor-inflight.json');
  const state = loadInflightState(stateFile);
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
    saveInflightState(stateFile, state);
    return null;
  }

  if (eventName === 'beforeShellExecution' || eventName === 'beforeMCPExecution') {
    const entry = state.inflight[inflightKey] || state.inflight[convId];
    if (entry && entry.toolActiveStartMs === null) {
      entry.toolActiveStartMs = nowMs;
      entry.updatedAtMs = nowMs;
      saveInflightState(stateFile, state);
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
      saveInflightState(stateFile, state);
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
      saveInflightState(stateFile, state);
    }

    const hasTokens =
      typeof payload.input_tokens === 'number' || typeof payload.output_tokens === 'number';
    if (!hasTokens) {
      return null;
    }

    const startedAtMs = entry?.startedAtMs ?? null;
    const toolWaitMs = entry?.toolWaitMs ?? 0;

    const totalInputTokens = Number(payload.input_tokens) || 0;
    const cacheReadTokens = Number(payload.cache_read_tokens) || 0;
    const cacheWriteTokens = Number(payload.cache_write_tokens) || 0;
    const outputTokens = Number(payload.output_tokens) || 0;

    let durationMs = null;
    let modelActiveMs = null;
    let tpsMethod = 'unavailable';

    if (startedAtMs !== null && nowMs >= startedAtMs) {
      durationMs = nowMs - startedAtMs;
      const net = durationMs - toolWaitMs;
      if (net >= 150) {
        modelActiveMs = net;
        tpsMethod = toolWaitMs > 0 ? 'e2e_minus_tools' : 'e2e_turn';
      }
    }

    state.completedGenIds[dedupKey] = nowMs;
    delete state.inflight[inflightKey];
    if (state.inflight[convId] === entry) delete state.inflight[convId];
    saveInflightState(stateFile, state);

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

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) return;

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }

  const stateDir = defaultStateDir();
  const token = readDaemonToken(stateDir);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 600);
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/ingest/cursor-hook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { [AUTH_TOKEN_HEADER]: token } : {}),
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (res.ok) return;
  } catch {
    // Daemon offline: fall back to local inflight processing + spool file so turn is never lost
  } finally {
    clearTimeout(timer);
  }

  const turn = processCursorHookPayloadLocal(payload, { stateDir });
  if (!turn) return;

  const spoolFile = join(stateDir, 'cursor-spool.jsonl');
  mkdirSync(dirname(spoolFile), { recursive: true });
  appendFileSync(spoolFile, `${JSON.stringify(turn)}\n`);
}

main().catch(() => {});
