import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { cursorApiJson, resolveCursorCookieCandidates, resolveCursorCookieHeader } from '../quota.mjs';

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
      const net = durationMs - toolWaitMs;
      if (net >= 150) {
        modelActiveMs = net;
        tpsMethod = toolWaitMs > 0 ? 'e2e_minus_tools' : 'e2e_turn';
      }
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

const DRAINING_SPOOL_PREFIX = 'cursor-spool.jsonl.draining-';

export function drainCursorSpool(store, stateDir = defaultStateDir()) {
  if (!stateDir || !existsSync(stateDir)) return [];

  let batchFiles = [];
  try {
    batchFiles = readdirSync(stateDir)
      .filter((name) => name.startsWith(DRAINING_SPOOL_PREFIX))
      .sort()
      .map((name) => join(stateDir, name));
  } catch {
    return [];
  }

  const spoolFile = join(stateDir, 'cursor-spool.jsonl');
  if (existsSync(spoolFile)) {
    const tmpFile = `${spoolFile}.draining-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    try {
      renameSync(spoolFile, tmpFile);
      batchFiles.push(tmpFile);
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        // Leave spoolFile intact for the next drain attempt.
      }
    }
  }

  if (batchFiles.length === 0) return [];

  const records = [];
  for (const batchFile of batchFiles) {
    let raw;
    try {
      raw = readFileSync(batchFile, 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') continue;
      // Preserve unreadable batch file for later recovery and stop to keep chronological order.
      break;
    }

    const lines = raw.split(/\r?\n/).filter(Boolean);
    const validTurns = [];
    for (const l of lines) {
      try {
        const parsed = JSON.parse(l);
        if (parsed && typeof parsed === 'object') {
          validTurns.push(parsed);
        }
      } catch {
        // Skip malformed JSON line so it cannot poison valid records in the batch.
      }
    }

    if (validTurns.length === 0) {
      try {
        rmSync(batchFile, { force: true });
      } catch {}
      continue;
    }

    const batchRecords = [];
    const hasTx = Boolean(store?.db && typeof store.db.exec === 'function');
    let txStarted = false;
    try {
      if (hasTx) {
        store.db.exec('BEGIN');
        txStarted = true;
      }
      for (const turn of validTurns) {
        const res = store.upsertTurn(turn);
        if (res?.changed && res.record) {
          batchRecords.push(res.record);
        }
      }
      if (txStarted) {
        store.db.exec('COMMIT');
        txStarted = false;
      }
    } catch {
      if (txStarted) {
        try {
          store.db.exec('ROLLBACK');
        } catch {}
      }
      // Keep the draining batch file intact on SQLite/write failure so the next drain retries.
      break;
    }

    records.push(...batchRecords);
    try {
      rmSync(batchFile, { force: true });
    } catch {
      // Ignore cleanup error; upsertTurn is idempotent by turn_uid on retry.
    }
  }

  return records;
}

export function buildCursorHookOverlapIndex(hookRows = []) {
  const bySession = new Map();
  for (const row of hookRows) {
    if (!row || !row.session_id) continue;
    let entry = bySession.get(row.session_id);
    if (!entry) {
      entry = { workspacePath: null, hooks: [] };
      bySession.set(row.session_id, entry);
    }
    if (!entry.workspacePath && row.workspace_path) {
      entry.workspacePath = row.workspace_path;
    }
    entry.hooks.push({
      startedAtMs: Number(row.started_at_ms) || null,
      completedAtMs: Number(row.completed_at_ms) || 0,
      totalInputTokens: Number(row.total_input_tokens) || 0,
      outputTokens: Number(row.output_tokens) || 0,
    });
  }
  return bySession;
}

export function parseCursorApiUsageEvent(ev, overlapIndex = null) {
  if (!ev || typeof ev !== 'object') return null;
  const tsMs = Number(ev.timestamp);
  if (!Number.isFinite(tsMs) || tsMs <= 0) return null;

  const usage = ev.tokenUsage && typeof ev.tokenUsage === 'object' ? ev.tokenUsage : {};
  const uncachedInputTokens = Math.max(0, Math.round(Number(usage.inputTokens) || 0));
  const cacheReadTokens = Math.max(0, Math.round(Number(usage.cacheReadTokens) || 0));
  const cacheWriteTokens = Math.max(0, Math.round(Number(usage.cacheWriteTokens) || 0));
  const outputTokens = Math.max(0, Math.round(Number(usage.outputTokens) || 0));
  const totalInputTokens = uncachedInputTokens + cacheReadTokens + cacheWriteTokens;

  const rawCents = Number(usage.totalCents);
  const explicitCostUsd = Number.isFinite(rawCents) && rawCents >= 0 ? rawCents / 100 : null;

  if (totalInputTokens === 0 && outputTokens === 0 && (explicitCostUsd === null || explicitCostUsd <= 0)) {
    return null;
  }

  const convId = typeof ev.conversationId === 'string' && ev.conversationId.trim() ? ev.conversationId.trim() : null;
  let workspacePath = null;

  if (convId && overlapIndex && overlapIndex.has(convId)) {
    const entry = overlapIndex.get(convId);
    workspacePath = entry.workspacePath || null;
    for (const h of entry.hooks) {
      const closeInTime = Math.abs(h.completedAtMs - tsMs) <= 6 * 3600_000;
      if (closeInTime && h.totalInputTokens > 0 && h.totalInputTokens === totalInputTokens) {
        return null;
      }
      if (Math.abs(h.completedAtMs - tsMs) <= 20_000 && h.outputTokens > 0 && h.outputTokens === outputTokens) {
        return null;
      }
      if (
        h.startedAtMs &&
        tsMs >= h.startedAtMs - 60_000 &&
        tsMs <= h.completedAtMs + 20_000 &&
        totalInputTokens <= h.totalInputTokens
      ) {
        return null;
      }
    }
  }

  const d = new Date(tsMs);
  const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const sessionId = convId || `cursor-cloud-${dayKey}`;
  const rawEventId =
    typeof ev.usageEventId === 'string' && ev.usageEventId.trim()
      ? ev.usageEventId.trim()
      : `${convId || 'no-conv'}:${tsMs}:${ev.model || 'unknown'}:${totalInputTokens}:${outputTokens}`;

  return {
    turnUid: `cursor:api:${rawEventId}`,
    tool: 'cursor',
    host: 'cursor-cloud',
    sessionId,
    turnId: rawEventId,
    model: typeof ev.model === 'string' && ev.model.trim() ? ev.model.trim() : 'cursor',
    workspacePath,
    startedAtMs: Math.round(tsMs),
    completedAtMs: Math.round(tsMs),
    callCount: 1,
    totalInputTokens,
    uncachedInputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    thinkingTokens: null,
    durationMs: null,
    modelActiveMs: null,
    ttftMs: null,
    tpsMethod: 'unavailable',
    explicitCostUsd,
  };
}

export async function syncCursorHistoryEvents(
  store,
  {
    cursorCookie = null,
    nowMs = Date.now(),
    pageSize = 500,
    maxPages = 60,
    onBatch = null,
    fetchPageFn = null,
  } = {}
) {
  const candidates = fetchPageFn
    ? [{ cookieHeader: cursorCookie }]
    : (await resolveCursorCookieCandidates({ cursorCookie, allowSilentKeychain: true })).candidates;
  if (candidates.length === 0 && !fetchPageFn) return { synced: 0, completed: false };

  let activeCookie = candidates[0]?.cookieHeader || cursorCookie;

  const backfilled = store.getMeta?.('cursor_history_backfilled_v1') === '1';
  const latestSavedMs = Number(store.getMeta?.('cursor_history_latest_ms')) || 0;
  const startDateMs = backfilled && latestSavedMs > 0 ? Math.max(0, latestSavedMs - 3600_000) : 0;

  const overlapIndex = buildCursorHookOverlapIndex(store.getCursorLocalHookRows?.() || []);
  let newestSeenMs = latestSavedMs;
  let totalChanged = 0;
  let completed = false;

  const doFetchPageWithCookie = (page, hdr) =>
    fetchPageFn
      ? fetchPageFn(page)
      : cursorApiJson('https://cursor.com/api/dashboard/get-filtered-usage-events', hdr, {
          method: 'POST',
          timeoutMs: 20_000,
          body: {
            page,
            pageSize,
            startDate: String(startDateMs),
            endDate: String(nowMs + 60_000),
          },
        });

  let page1Res = null;
  if (fetchPageFn) {
    page1Res = await doFetchPageWithCookie(1, activeCookie);
  } else {
    for (const c of candidates) {
      const r = await doFetchPageWithCookie(1, c.cookieHeader);
      if (r && Array.isArray(r.usageEventsDisplay)) {
        activeCookie = c.cookieHeader;
        page1Res = r;
        break;
      }
    }
  }

  for (let page = 1; page <= maxPages; page += 1) {
    const res = page === 1 ? page1Res : await doFetchPageWithCookie(page, activeCookie);
    if (!res || !Array.isArray(res.usageEventsDisplay)) break;
    const events = res.usageEventsDisplay;
    if (events.length === 0) {
      completed = true;
      break;
    }

    const batchRecords = [];
    for (const ev of events) {
      const ts = Number(ev?.timestamp);
      if (Number.isFinite(ts) && ts > newestSeenMs) newestSeenMs = ts;
      const parsed = parseCursorApiUsageEvent(ev, overlapIndex);
      if (!parsed) {
        const rawId = typeof ev?.usageEventId === 'string' && ev.usageEventId.trim() ? ev.usageEventId.trim() : null;
        if (rawId && typeof store.deleteTurnByUid === 'function') {
          store.deleteTurnByUid(`cursor:api:${rawId}`);
        }
        continue;
      }
      const upserted = store.upsertTurn(parsed);
      if (upserted.changed) {
        totalChanged += 1;
        batchRecords.push(upserted.record);
      }
    }

    if (batchRecords.length > 0 && onBatch) {
      onBatch(batchRecords);
    }

    if (events.length < pageSize) {
      completed = true;
      break;
    }
  }

  if (newestSeenMs > latestSavedMs) {
    store.setMeta?.('cursor_history_latest_ms', String(Math.round(newestSeenMs)));
  }
  if (completed && !backfilled) {
    store.setMeta?.('cursor_history_backfilled_v1', '1');
  }

  return { synced: totalChanged, completed };
}
