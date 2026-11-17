/**
 * Shared formatting and metric normalization helpers for AI Turn Meter.
 */

export const TPS_METHOD_LABELS = {
  streaming_decode: '纯流式解码',
  active_model: '模型活跃时长（已扣工具）',
  e2e_minus_tools: '扣工具含首字等待',
  e2e_turn: '整轮端到端',
  unavailable: '不可用',
};

export const TOOL_LABELS = {
  codex: 'Codex',
  antigravity: 'Antigravity',
  cursor: 'Cursor',
  codebuddy: 'CodeBuddy',
};

/**
 * Clamp to a non-negative integer, or null if missing/invalid.
 * @param {unknown} v
 * @returns {number | null}
 */
export function toNonNegInt(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  return Math.round(v);
}

/**
 * Clamp to a non-negative finite number, or null if missing/invalid.
 * @param {unknown} v
 * @returns {number | null}
 */
export function toNonNegFloat(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  return v;
}

export function normalizePreviewText(v, maxLen = 120) {
  if (typeof v !== 'string') return null;
  const clean = v.replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  return clean.slice(0, maxLen);
}

/**
 * Format token counts compactly: 341, 1.4k, 97.2k, 1.24M.
 * @param {number | null | undefined} count
 * @returns {string}
 */
export function formatTokens(count) {
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) {
    return 'N/A';
  }
  if (count < 1000) return String(Math.round(count));
  if (count < 10000) return `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (count < 1_000_000) return `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${(count / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
}

/**
 * Format cache hit percentage from cacheRead / totalInput.
 * @param {number | null | undefined} cacheRead
 * @param {number | null | undefined} totalInput
 * @returns {string}
 */
export function formatCacheRate(cacheRead, totalInput) {
  if (
    typeof cacheRead !== 'number' ||
    typeof totalInput !== 'number' ||
    !Number.isFinite(cacheRead) ||
    !Number.isFinite(totalInput) ||
    totalInput <= 0
  ) {
    return '--';
  }
  const pct = Math.min(100, Math.max(0, Math.round((cacheRead / totalInput) * 100)));
  return `${pct}%`;
}

/**
 * Format TPS cleanly as e.g. "48 tok/s" or "N/A tok/s".
 * @param {number | null | undefined} tps
 * @returns {string}
 */
export function formatTps(tps) {
  if (typeof tps !== 'number' || !Number.isFinite(tps) || tps <= 0) {
    return 'N/A tok/s';
  }
  const rounded = tps >= 100 ? Math.round(tps) : Number(tps.toFixed(1).replace(/\.0$/, ''));
  return `${rounded} tok/s`;
}

/**
 * Format the primary single-line summary matching user preference:
 * "输入 97.2k (96%) · 输出 1.4k · 48 tok/s"
 * @param {{ totalInputTokens: number, cacheReadTokens: number, outputTokens: number, tps: number | null }} turn
 * @returns {string}
 */
export function formatInlineSummary(turn) {
  if (!turn) return '等待首轮回复';
  const totalIn = formatTokens(turn.totalInputTokens);
  const cachePct = formatCacheRate(turn.cacheReadTokens, turn.totalInputTokens);
  const out = formatTokens(turn.outputTokens);
  const speed = formatTps(turn.tps);
  return `输入 ${totalIn} (${cachePct}) · 输出 ${out} · ${speed}`;
}

/**
 * Format duration in ms concisely: "720ms" or "3.8s".
 * @param {number | null | undefined} ms
 * @returns {string}
 */
export function formatDurationMs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return 'N/A';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2).replace(/\.?0+$/, '')}s`;
}

/**
 * Compute normalized turn metrics with strict non-negative bounds.
 * @param {object} raw
 */
export function normalizeTurn(raw) {
  const uncachedInputTokens = toNonNegInt(raw.uncachedInputTokens) ?? 0;
  const cacheReadTokens = toNonNegInt(raw.cacheReadTokens) ?? 0;
  const cacheWriteTokens = toNonNegInt(raw.cacheWriteTokens) ?? 0;
  const explicitTotalInput = toNonNegInt(raw.totalInputTokens);
  const totalInputTokens =
    explicitTotalInput !== null
      ? Math.max(explicitTotalInput, cacheReadTokens + cacheWriteTokens)
      : uncachedInputTokens + cacheReadTokens + cacheWriteTokens;
  const resolvedUncached = Math.max(0, totalInputTokens - cacheReadTokens - cacheWriteTokens);

  const outputTokens = toNonNegInt(raw.outputTokens) ?? 0;
  const thinkingTokens = toNonNegInt(raw.thinkingTokens);
  const callCount = Math.max(1, toNonNegInt(raw.callCount) ?? 1);

  const durationMs = toNonNegFloat(raw.durationMs);
  const modelActiveMs = toNonNegFloat(raw.modelActiveMs);
  const ttftMs = toNonNegFloat(raw.ttftMs);

  let tps = toNonNegFloat(raw.tps);
  const minMsForTps = 150;
  if (tps === null && outputTokens > 0) {
    const denomMs = modelActiveMs !== null && modelActiveMs >= minMsForTps ? modelActiveMs : durationMs;
    if (denomMs !== null && denomMs >= minMsForTps) {
      tps = Number((outputTokens / (denomMs / 1000)).toFixed(1));
    }
  } else if (tps !== null) {
    tps = Number(tps.toFixed(1));
  }

  const tpsMethod = tps !== null ? raw.tpsMethod || 'e2e_turn' : 'unavailable';
  const cacheRatePct =
    totalInputTokens > 0
      ? Number(Math.min(100, Math.max(0, (cacheReadTokens / totalInputTokens) * 100)).toFixed(1))
      : null;

  return {
    turnUid: String(raw.turnUid),
    tool: String(raw.tool),
    host: String(raw.host || raw.tool),
    sessionId: String(raw.sessionId),
    turnId: String(raw.turnId),
    model: String(raw.model || 'unknown'),
    workspacePath: raw.workspacePath ? String(raw.workspacePath) : null,
    workspaceHash: raw.workspaceHash ? String(raw.workspaceHash) : null,
    startedAtMs: toNonNegInt(raw.startedAtMs),
    completedAtMs: toNonNegInt(raw.completedAtMs) ?? Date.now(),
    callCount,
    totalInputTokens,
    uncachedInputTokens: resolvedUncached,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    thinkingTokens,
    cacheRatePct,
    durationMs: durationMs !== null ? Math.round(durationMs) : null,
    modelActiveMs: modelActiveMs !== null ? Math.round(modelActiveMs) : null,
    ttftMs: ttftMs !== null ? Math.round(ttftMs) : null,
    tps,
    tpsMethod,
    tpsMethodLabel: TPS_METHOD_LABELS[tpsMethod] || TPS_METHOD_LABELS.unavailable,
    replyPreview: normalizePreviewText(raw.replyPreview),
  };
}
