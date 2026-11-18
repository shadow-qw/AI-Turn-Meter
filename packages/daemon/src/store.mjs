import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { formatCacheRate, formatInlineSummary, formatTps, normalizeTurn, TOOL_LABELS } from './format.mjs';
import { defaultCustomPricingPath, estimateTurnCost, loadCustomPricing } from './pricing.mjs';

function startOfLocalDayMs(nowMs = Date.now()) {
  const d = new Date(nowMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function toLocalDateKey(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function toZhMonthDay(ms) {
  const d = new Date(ms);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function formatZhRange(startMs, endMs) {
  const fmt = (ms) => {
    const d = new Date(ms);
    const m = d.getMonth() + 1;
    const day = d.getDate();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${m}月${day}日 ${hh}:${mm}`;
  };
  return `${fmt(startMs)} – ${fmt(endMs)}`;
}

const CARD_WINDOW_TITLES = ['当前窗口', '上一窗口', '2 个窗口前', '3 个窗口前'];
const CARD_TOOL_KEYS = ['codex', 'cursor', 'antigravity', 'codebuddy'];

function createUsageAccumulator() {
  return {
    turnCount: 0,
    callCount: 0,
    totalInputTokens: 0,
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    tpsOutputSum: 0,
    tpsDurationSecSum: 0,
    estimatedCostUsd: 0,
    cacheSavingsUsd: 0,
    pricedTurnCount: 0,
    unpricedTurnCount: 0,
  };
}

function addTurnToAccumulator(acc, row, customRates) {
  const totalIn = Number(row.total_input_tokens) || 0;
  const uncachedIn = Number(row.uncached_input_tokens) || 0;
  const cacheRead = Number(row.cache_read_tokens) || 0;
  const cacheWrite = Number(row.cache_write_tokens) || 0;
  const out = Number(row.output_tokens) || 0;
  const thinking = Number(row.thinking_tokens) || 0;
  const calls = Math.max(1, Number(row.call_count) || 1);
  const tps = typeof row.tps === 'number' && Number.isFinite(row.tps) && row.tps > 0 ? row.tps : null;

  acc.turnCount += 1;
  acc.callCount += calls;
  acc.totalInputTokens += totalIn;
  acc.uncachedInputTokens += uncachedIn;
  acc.cacheReadTokens += cacheRead;
  acc.cacheWriteTokens += cacheWrite;
  acc.outputTokens += out;
  acc.thinkingTokens += thinking;
  if (tps !== null && out > 0) {
    acc.tpsOutputSum += out;
    acc.tpsDurationSecSum += out / tps;
  }

  const cost = estimateTurnCost(
    {
      model: row.model,
      totalInputTokens: totalIn,
      uncachedInputTokens: uncachedIn,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      outputTokens: out,
      callCount: calls,
    },
    customRates
  );
  if (cost.priced && cost.costUsd !== null) {
    acc.pricedTurnCount += 1;
    acc.estimatedCostUsd += cost.costUsd;
    acc.cacheSavingsUsd += cost.savingsUsd || 0;
  } else {
    acc.unpricedTurnCount += 1;
  }
}

function finalizeAccumulator(acc) {
  const totalTokens = acc.totalInputTokens + acc.outputTokens;
  const cacheRatePct =
    acc.totalInputTokens > 0
      ? Number(Math.min(100, Math.max(0, (acc.cacheReadTokens / acc.totalInputTokens) * 100)).toFixed(1))
      : null;
  const avgTps =
    acc.tpsOutputSum > 0 && acc.tpsDurationSecSum > 0
      ? Number((acc.tpsOutputSum / acc.tpsDurationSecSum).toFixed(1))
      : null;
  const estimatedCostUsd =
    acc.turnCount === 0
      ? 0
      : acc.pricedTurnCount > 0
        ? Number(acc.estimatedCostUsd.toFixed(4))
        : null;
  const cacheSavingsUsd =
    acc.turnCount === 0
      ? 0
      : acc.pricedTurnCount > 0
        ? Number(acc.cacheSavingsUsd.toFixed(4))
        : null;

  return {
    turnCount: acc.turnCount,
    callCount: acc.callCount,
    totalInputTokens: acc.totalInputTokens,
    uncachedInputTokens: acc.uncachedInputTokens,
    cacheReadTokens: acc.cacheReadTokens,
    cacheWriteTokens: acc.cacheWriteTokens,
    outputTokens: acc.outputTokens,
    thinkingTokens: acc.thinkingTokens,
    totalTokens,
    cacheRatePct,
    avgTps,
    estimatedCostUsd,
    cacheSavingsUsd,
    pricedTurnCount: acc.pricedTurnCount,
    unpricedTurnCount: acc.unpricedTurnCount,
  };
}

export function defaultDbPath() {
  return (
    process.env.AI_TURN_METER_DB ||
    join(homedir(), '.local', 'share', 'ai-turn-meter', 'meter.db')
  );
}

/**
 * SQLite-backed store for normalized per-turn metrics and per-session cumulative totals.
 */
export class TurnStore {
  /**
   * @param {string} [dbPath]
   * @param {{ customPricingPath?: string | null }} [opts]
   */
  constructor(dbPath = defaultDbPath(), { customPricingPath } = {}) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.customPricingPath =
      customPricingPath !== undefined ? customPricingPath : dbPath === ':memory:' ? null : defaultCustomPricingPath();
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS turns (
        turn_uid TEXT PRIMARY KEY,
        tool TEXT NOT NULL,
        host TEXT NOT NULL,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        model TEXT NOT NULL,
        workspace_path TEXT,
        workspace_hash TEXT,
        started_at_ms INTEGER,
        completed_at_ms INTEGER NOT NULL,
        call_count INTEGER NOT NULL,
        total_input_tokens INTEGER NOT NULL,
        uncached_input_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL,
        cache_write_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        thinking_tokens INTEGER,
        cache_rate_pct REAL,
        duration_ms INTEGER,
        model_active_ms INTEGER,
        ttft_ms INTEGER,
        tps REAL,
        tps_method TEXT NOT NULL,
        reply_preview TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_turns_completed ON turns(completed_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_turns_tool_completed ON turns(tool, completed_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(tool, session_id);
      CREATE INDEX IF NOT EXISTS idx_turns_workspace ON turns(workspace_path, completed_at_ms DESC);
    `);

    try {
      this.db.exec('ALTER TABLE turns ADD COLUMN reply_preview TEXT;');
    } catch {
      // Column already exists on initialized databases
    }

    this.upsertStmt = this.db.prepare(`
      INSERT INTO turns (
        turn_uid, tool, host, session_id, turn_id, model,
        workspace_path, workspace_hash, started_at_ms, completed_at_ms,
        call_count, total_input_tokens, uncached_input_tokens,
        cache_read_tokens, cache_write_tokens, output_tokens,
        thinking_tokens, cache_rate_pct, duration_ms, model_active_ms,
        ttft_ms, tps, tps_method, reply_preview
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?
      )
      ON CONFLICT(turn_uid) DO UPDATE SET
        host = excluded.host,
        model = CASE WHEN excluded.model != 'unknown' THEN excluded.model ELSE turns.model END,
        workspace_path = COALESCE(excluded.workspace_path, turns.workspace_path),
        workspace_hash = COALESCE(excluded.workspace_hash, turns.workspace_hash),
        started_at_ms = COALESCE(excluded.started_at_ms, turns.started_at_ms),
        completed_at_ms = excluded.completed_at_ms,
        call_count = excluded.call_count,
        total_input_tokens = excluded.total_input_tokens,
        uncached_input_tokens = excluded.uncached_input_tokens,
        cache_read_tokens = excluded.cache_read_tokens,
        cache_write_tokens = excluded.cache_write_tokens,
        output_tokens = excluded.output_tokens,
        thinking_tokens = excluded.thinking_tokens,
        cache_rate_pct = excluded.cache_rate_pct,
        duration_ms = excluded.duration_ms,
        model_active_ms = excluded.model_active_ms,
        ttft_ms = COALESCE(excluded.ttft_ms, turns.ttft_ms),
        tps = COALESCE(excluded.tps, turns.tps),
        tps_method = CASE WHEN excluded.tps IS NOT NULL THEN excluded.tps_method ELSE turns.tps_method END,
        reply_preview = COALESCE(excluded.reply_preview, turns.reply_preview)
    `);

    this.getExistingStmt = this.db.prepare(
      `SELECT completed_at_ms, total_input_tokens, uncached_input_tokens, cache_read_tokens, output_tokens, tps, call_count, model, workspace_path, reply_preview FROM turns WHERE turn_uid = ?`
    );

    this.sessionAggStmt = this.db.prepare(`
      SELECT
        COUNT(*) AS turn_count,
        COALESCE(SUM(call_count), 0) AS call_count,
        COALESCE(SUM(total_input_tokens), 0) AS total_input_tokens,
        COALESCE(SUM(uncached_input_tokens), 0) AS uncached_input_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens
      FROM turns
      WHERE tool = ? AND session_id = ?
    `);
  }

  /**
   * Insert or update a turn; returns `{ changed, record }`.
   * @param {object} rawTurn
   */
  upsertTurn(rawTurn) {
    const t = normalizeTurn(rawTurn);
    const prev = this.getExistingStmt.get(t.turnUid);

    const changed =
      !prev ||
      prev.completed_at_ms !== t.completedAtMs ||
      prev.total_input_tokens !== t.totalInputTokens ||
      prev.uncached_input_tokens !== t.uncachedInputTokens ||
      prev.cache_read_tokens !== t.cacheReadTokens ||
      prev.output_tokens !== t.outputTokens ||
      prev.tps !== t.tps ||
      prev.call_count !== t.callCount ||
      (!prev.reply_preview && Boolean(t.replyPreview)) ||
      (prev.model === 'unknown' && t.model !== 'unknown') ||
      (!prev.workspace_path && Boolean(t.workspacePath));

    if (changed) {
      this.upsertStmt.run(
        t.turnUid,
        t.tool,
        t.host,
        t.sessionId,
        t.turnId,
        t.model,
        t.workspacePath,
        t.workspaceHash,
        t.startedAtMs,
        t.completedAtMs,
        t.callCount,
        t.totalInputTokens,
        t.uncachedInputTokens,
        t.cacheReadTokens,
        t.cacheWriteTokens,
        t.outputTokens,
        t.thinkingTokens,
        t.cacheRatePct,
        t.durationMs,
        t.modelActiveMs,
        t.ttftMs,
        t.tps,
        t.tpsMethod,
        t.replyPreview
      );
    }

    return {
      changed,
      record: this.enrichRecord(t),
    };
  }

  /**
   * Attach formatted inline text and session cumulative totals (for hover/detail view).
   * @param {ReturnType<typeof normalizeTurn>} t
   */
  enrichRecord(t) {
    const agg = this.sessionAggStmt.get(t.tool, t.sessionId) || {
      turn_count: 1,
      call_count: t.callCount,
      total_input_tokens: t.totalInputTokens,
      uncached_input_tokens: t.uncachedInputTokens,
      cache_read_tokens: t.cacheReadTokens,
      cache_write_tokens: t.cacheWriteTokens,
      output_tokens: t.outputTokens,
    };
    const sessionTotal = {
      turnCount: Number(agg.turn_count),
      callCount: Number(agg.call_count),
      totalInputTokens: Number(agg.total_input_tokens),
      uncachedInputTokens: Number(agg.uncached_input_tokens),
      cacheReadTokens: Number(agg.cache_read_tokens),
      cacheWriteTokens: Number(agg.cache_write_tokens),
      outputTokens: Number(agg.output_tokens),
    };
    const customRates = this.customPricingPath ? loadCustomPricing(this.customPricingPath) : null;
    const cost = estimateTurnCost(t, customRates);
    return {
      ...t,
      toolLabel: TOOL_LABELS[t.tool] || t.tool,
      inlineText: formatInlineSummary(t),
      estimatedCostUsd: cost.costUsd,
      cacheSavingsUsd: cost.savingsUsd,
      sessionTotal,
    };
  }

  rowToTurn(row) {
    if (!row) return null;
    const t = normalizeTurn({
      turnUid: row.turn_uid,
      tool: row.tool,
      host: row.host,
      sessionId: row.session_id,
      turnId: row.turn_id,
      model: row.model,
      workspacePath: row.workspace_path,
      workspaceHash: row.workspace_hash,
      startedAtMs: row.started_at_ms,
      completedAtMs: row.completed_at_ms,
      callCount: row.call_count,
      totalInputTokens: row.total_input_tokens,
      uncachedInputTokens: row.uncached_input_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheWriteTokens: row.cache_write_tokens,
      outputTokens: row.output_tokens,
      thinkingTokens: row.thinking_tokens,
      durationMs: row.duration_ms,
      modelActiveMs: row.model_active_ms,
      ttftMs: row.ttft_ms,
      tps: row.tps,
      tpsMethod: row.tps_method,
      replyPreview: row.reply_preview || null,
    });
    return this.enrichRecord(t);
  }

  getLatestByTool() {
    const tools = ['codex', 'antigravity', 'cursor', 'codebuddy'];
    const result = {};
    const stmt = this.db.prepare(
      `SELECT * FROM turns WHERE tool = ? ORDER BY completed_at_ms DESC LIMIT 1`
    );
    for (const tool of tools) {
      result[tool] = this.rowToTurn(stmt.get(tool));
    }
    return result;
  }

  getRecentTurns(limit = 20, tool = null) {
    if (tool) {
      const rows = this.db
        .prepare(`SELECT * FROM turns WHERE tool = ? ORDER BY completed_at_ms DESC LIMIT ?`)
        .all(tool, limit);
      return rows.map((r) => this.rowToTurn(r));
    }
    const rows = this.db
      .prepare(`SELECT * FROM turns ORDER BY completed_at_ms DESC LIMIT ?`)
      .all(limit);
    return rows.map((r) => this.rowToTurn(r));
  }

  /**
   * Match turn for an IDE window strictly scoped by tool when `tool` is provided.
   * Only falls back across tools when `tool` is omitted.
   */
  getMatchForIde({ tool = null, workspacePath = null, workspaceHash = null } = {}) {
    if (tool) {
      if (workspacePath) {
        const r = this.db
          .prepare(
            `SELECT * FROM turns WHERE tool = ? AND workspace_path = ? ORDER BY completed_at_ms DESC LIMIT 1`
          )
          .get(tool, workspacePath);
        if (r) return this.rowToTurn(r);
      }
      if (workspaceHash) {
        const r = this.db
          .prepare(
            `SELECT * FROM turns WHERE tool = ? AND workspace_hash = ? ORDER BY completed_at_ms DESC LIMIT 1`
          )
          .get(tool, workspaceHash);
        if (r) return this.rowToTurn(r);
      }
      const r = this.db
        .prepare(`SELECT * FROM turns WHERE tool = ? ORDER BY completed_at_ms DESC LIMIT 1`)
        .get(tool);
      return r ? this.rowToTurn(r) : null;
    }

    if (workspacePath) {
      const r = this.db
        .prepare(`SELECT * FROM turns WHERE workspace_path = ? ORDER BY completed_at_ms DESC LIMIT 1`)
        .get(workspacePath);
      if (r) return this.rowToTurn(r);
    }
    if (workspaceHash) {
      const r = this.db
        .prepare(`SELECT * FROM turns WHERE workspace_hash = ? ORDER BY completed_at_ms DESC LIMIT 1`)
        .get(workspaceHash);
      if (r) return this.rowToTurn(r);
    }
    return this.getRecentTurns(1)[0] || null;
  }

  getTodaySummary(nowMs = Date.now(), tool = null) {
    const startMs = startOfLocalDayMs(nowMs);
    const customRates = this.customPricingPath ? loadCustomPricing(this.customPricingPath) : null;
    const rows = tool
      ? this.db
          .prepare(`SELECT * FROM turns WHERE tool = ? AND completed_at_ms >= ?`)
          .all(tool, startMs)
      : this.db
          .prepare(`SELECT * FROM turns WHERE completed_at_ms >= ?`)
          .all(startMs);
    const acc = createUsageAccumulator();
    for (const row of rows) {
      addTurnToAccumulator(acc, row, customRates);
    }
    return finalizeAccumulator(acc);
  }

  /**
   * Aggregate usage, cost, and cache savings over `days` local calendar days (0 or 'all' = all history).
   * @param {{ days?: number | string | null, tool?: string | null, nowMs?: number, quotasByTool?: Record<string, any> | null }} [opts]
   */
  getUsageSummary({ days = 7, tool = null, nowMs = Date.now(), quotasByTool = null } = {}) {
    const todayStartMs = startOfLocalDayMs(nowMs);
    const resolvedDays =
      days === 'all' || days === 0 || days === '0' || days === null
        ? 0
        : Math.max(1, Math.round(Number(days) || 7));

    let sinceMs = 0;
    if (resolvedDays > 0) {
      const nowDate = new Date(nowMs);
      sinceMs = new Date(
        nowDate.getFullYear(),
        nowDate.getMonth(),
        nowDate.getDate() - (resolvedDays - 1)
      ).getTime();
    }

    const customRates = this.customPricingPath ? loadCustomPricing(this.customPricingPath) : null;
    const rows = tool
      ? this.db
          .prepare(`SELECT * FROM turns WHERE tool = ? AND completed_at_ms >= ? ORDER BY completed_at_ms ASC`)
          .all(tool, sinceMs)
      : this.db
          .prepare(`SELECT * FROM turns WHERE completed_at_ms >= ? ORDER BY completed_at_ms ASC`)
          .all(sinceMs);

    const totalsAcc = createUsageAccumulator();
    const todayAcc = createUsageAccumulator();
    const toolMap = new Map();
    const modelMap = new Map();
    const dailyMap = new Map();

    if (resolvedDays >= 1 && resolvedDays <= 90) {
      const nowDate = new Date(nowMs);
      for (let i = resolvedDays - 1; i >= 0; i -= 1) {
        const d = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() - i);
        const key = toLocalDateKey(d.getTime());
        dailyMap.set(key, createUsageAccumulator());
      }
    }

    for (const row of rows) {
      addTurnToAccumulator(totalsAcc, row, customRates);
      if (row.completed_at_ms >= todayStartMs) {
        addTurnToAccumulator(todayAcc, row, customRates);
      }

      const tKey = row.tool;
      if (!toolMap.has(tKey)) toolMap.set(tKey, createUsageAccumulator());
      addTurnToAccumulator(toolMap.get(tKey), row, customRates);

      const mName = row.model || 'unknown';
      const mKey = `${tKey}\0${mName}`;
      if (!modelMap.has(mKey)) {
        modelMap.set(mKey, { tool: tKey, model: mName, acc: createUsageAccumulator() });
      }
      addTurnToAccumulator(modelMap.get(mKey).acc, row, customRates);

      const dayKey = toLocalDateKey(row.completed_at_ms);
      if (!dailyMap.has(dayKey)) dailyMap.set(dayKey, createUsageAccumulator());
      addTurnToAccumulator(dailyMap.get(dayKey), row, customRates);
    }

    const totals = finalizeAccumulator(totalsAcc);
    const today = resolvedDays === 1 ? totals : finalizeAccumulator(todayAcc);

    const byTool = Array.from(toolMap.entries())
      .map(([tKey, acc]) => {
        const stats = finalizeAccumulator(acc);
        return {
          tool: tKey,
          toolLabel: TOOL_LABELS[tKey] || tKey,
          sharePct:
            totals.totalTokens > 0
              ? Number(((stats.totalTokens / totals.totalTokens) * 100).toFixed(1))
              : 0,
          ...stats,
        };
      })
      .sort((a, b) => b.totalTokens - a.totalTokens);

    const byModel = Array.from(modelMap.values())
      .map(({ tool: tKey, model, acc }) => {
        const stats = finalizeAccumulator(acc);
        return {
          tool: tKey,
          toolLabel: TOOL_LABELS[tKey] || tKey,
          model,
          priced: stats.pricedTurnCount > 0,
          sharePct:
            totals.totalTokens > 0
              ? Number(((stats.totalTokens / totals.totalTokens) * 100).toFixed(1))
              : 0,
          ...stats,
        };
      })
      .sort(
        (a, b) =>
          (b.estimatedCostUsd ?? -1) - (a.estimatedCostUsd ?? -1) || b.totalTokens - a.totalTokens
      );

    const daily = Array.from(dailyMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, acc]) => ({
        date,
        ...finalizeAccumulator(acc),
      }));

    const cards = this.buildCardsByTool(nowMs, customRates, quotasByTool);

    return {
      days: resolvedDays,
      tool: tool || null,
      sinceMs,
      generatedAtMs: nowMs,
      today,
      totals,
      byTool,
      byModel,
      daily,
      cards,
    };
  }

  buildLatestTurnMetrics(rows, todayFin) {
    const latestRow = rows.length > 0 ? rows[rows.length - 1] : null;
    let tpsText = null;
    if (latestRow && typeof latestRow.tps === 'number' && Number.isFinite(latestRow.tps) && latestRow.tps > 0) {
      tpsText = formatTps(latestRow.tps);
    } else if (todayFin && typeof todayFin.avgTps === 'number' && Number.isFinite(todayFin.avgTps) && todayFin.avgTps > 0) {
      tpsText = `均 ${formatTps(todayFin.avgTps)}`;
    }

    let cacheText = null;
    if (latestRow && Number(latestRow.cache_read_tokens) > 0 && Number(latestRow.total_input_tokens) > 0) {
      const cacheStr = formatCacheRate(latestRow.cache_read_tokens, latestRow.total_input_tokens);
      if (cacheStr !== '--') {
        cacheText = `缓存 ${cacheStr}`;
      }
    }

    const parts = [];
    if (tpsText) parts.push(tpsText.startsWith('均 ') ? `今日均速 ${tpsText.slice(2)}` : `最近速率 ${tpsText}`);
    if (cacheText) parts.push(cacheText);

    return {
      latestTpsText: tpsText,
      latestCacheText: cacheText,
      latestTurnSubline: parts.length > 0 ? parts.join(' · ') : null,
    };
  }

  buildCodexBarCardSnapshot(rows, nowMs = Date.now(), customRates = null, quotaInfo = null) {
    const todayStartMs = startOfLocalDayMs(nowMs);
    const nowDate = new Date(nowMs);
    const days30StartMs = new Date(
      nowDate.getFullYear(),
      nowDate.getMonth(),
      nowDate.getDate() - 29
    ).getTime();
    const weekMs = 7 * 86_400_000;

    const todayAcc = createUsageAccumulator();
    const days30Acc = createUsageAccumulator();
    const windowAccs = [
      createUsageAccumulator(),
      createUsageAccumulator(),
      createUsageAccumulator(),
      createUsageAccumulator(),
    ];
    const dailyMap = new Map();
    for (let i = 29; i >= 0; i -= 1) {
      const d = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() - i);
      const ms = d.getTime();
      dailyMap.set(toLocalDateKey(ms), {
        label: toZhMonthDay(ms),
        acc: createUsageAccumulator(),
        models: new Map(),
      });
    }
    const modelMap = new Map();
    const projectMap = new Map();

    for (const row of rows) {
      const ts = Number(row.completed_at_ms) || 0;
      if (ts >= todayStartMs) {
        addTurnToAccumulator(todayAcc, row, customRates);
      }
      if (ts >= days30StartMs) {
        addTurnToAccumulator(days30Acc, row, customRates);
        const dayKey = toLocalDateKey(ts);
        const bucket = dailyMap.get(dayKey);
        const mName = row.model && row.model !== 'unknown' ? row.model : null;
        if (bucket) {
          addTurnToAccumulator(bucket.acc, row, customRates);
          if (mName) {
            if (!bucket.models.has(mName)) bucket.models.set(mName, createUsageAccumulator());
            addTurnToAccumulator(bucket.models.get(mName), row, customRates);
          }
        }

        if (mName) {
          if (!modelMap.has(mName)) modelMap.set(mName, createUsageAccumulator());
          addTurnToAccumulator(modelMap.get(mName), row, customRates);
        }

        const rawWs = typeof row.workspace_path === 'string' ? row.workspace_path.trim() : '';
        const projKey = rawWs || '__independent__';
        if (!projectMap.has(projKey)) {
          const name = rawWs ? (rawWs.split('/').filter(Boolean).pop() || rawWs) : 'Independent chats';
          projectMap.set(projKey, {
            name,
            path: rawWs || '未绑定工作区目录',
            acc: createUsageAccumulator(),
          });
        }
        addTurnToAccumulator(projectMap.get(projKey).acc, row, customRates);
      }
      if (ts <= nowMs) {
        const diff = Math.max(0, nowMs - ts);
        const idx = Math.floor(diff / weekMs);
        if (idx >= 0 && idx < 4) {
          addTurnToAccumulator(windowAccs[idx], row, customRates);
        }
      }
    }

    const todayFin = finalizeAccumulator(todayAcc);
    const days30Fin = finalizeAccumulator(days30Acc);
    const winFinals = windowAccs.map((a) => finalizeAccumulator(a));

    let topModel = null;
    let topScore = null;
    for (const [modelName, acc] of modelMap.entries()) {
      const fin = finalizeAccumulator(acc);
      const score = [fin.estimatedCostUsd ?? -1, fin.totalTokens, fin.turnCount];
      if (
        !topScore ||
        score[0] > topScore[0] ||
        (score[0] === topScore[0] && score[1] > topScore[1]) ||
        (score[0] === topScore[0] && score[1] === topScore[1] && score[2] > topScore[2])
      ) {
        topModel = modelName;
        topScore = score;
      }
    }

    const daily30 = Array.from(dailyMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, { label, acc, models }]) => {
        const fin = finalizeAccumulator(acc);
        const dayModels = Array.from(models.entries())
          .map(([model, mAcc]) => {
            const mFin = finalizeAccumulator(mAcc);
            return {
              model,
              costUsd: mFin.estimatedCostUsd,
              totalTokens: mFin.totalTokens,
            };
          })
          .sort((a, b) => ((b.costUsd ?? -1) - (a.costUsd ?? -1)) || (b.totalTokens - a.totalTokens))
          .slice(0, 4);
        return {
          date,
          label,
          totalTokens: fin.totalTokens,
          costUsd: fin.estimatedCostUsd,
          turnCount: fin.turnCount,
          models: dayModels,
        };
      });

    const projects = Array.from(projectMap.values())
      .map(({ name, path, acc }) => {
        const fin = finalizeAccumulator(acc);
        return {
          name,
          path,
          costUsd: fin.estimatedCostUsd,
          totalTokens: fin.totalTokens,
          turnCount: fin.turnCount,
        };
      })
      .sort((a, b) => ((b.costUsd ?? -1) - (a.costUsd ?? -1)) || (b.totalTokens - a.totalTokens))
      .slice(0, 6);

    const recentWindows = winFinals.map((fin, idx) => {
      const endMs = nowMs - idx * weekMs;
      const startMs = endMs - weekMs;
      return {
        index: idx,
        title: CARD_WINDOW_TITLES[idx],
        rangeText: formatZhRange(startMs, endMs),
        costUsd: fin.estimatedCostUsd,
        totalTokens: fin.totalTokens,
        turnCount: fin.turnCount,
      };
    });

    const latestMetrics = this.buildLatestTurnMetrics(rows, todayFin);

    return {
      accountEmail: quotaInfo?.accountEmail ?? null,
      planTitle: quotaInfo?.planTitle ?? null,
      quotaWindows: Array.isArray(quotaInfo?.quotaWindows) ? quotaInfo.quotaWindows : [],
      resetCreditsText: quotaInfo?.resetCreditsText ?? null,
      latestTpsText: latestMetrics.latestTpsText,
      latestCacheText: latestMetrics.latestCacheText,
      latestTurnSubline: latestMetrics.latestTurnSubline,
      today: {
        costUsd: todayFin.estimatedCostUsd,
        totalTokens: todayFin.totalTokens,
        totalInputTokens: todayFin.totalInputTokens,
        outputTokens: todayFin.outputTokens,
        turnCount: todayFin.turnCount,
        callCount: todayFin.callCount,
        cacheRatePct: todayFin.cacheRatePct,
        avgTps: todayFin.avgTps,
        cacheSavingsUsd: todayFin.cacheSavingsUsd,
      },
      currentWindow: {
        costUsd: winFinals[0].estimatedCostUsd,
        totalTokens: winFinals[0].totalTokens,
        turnCount: winFinals[0].turnCount,
      },
      days30: {
        costUsd: days30Fin.estimatedCostUsd,
        totalTokens: days30Fin.totalTokens,
        turnCount: days30Fin.turnCount,
      },
      daily30,
      projects,
      recentWindows,
      topModel,
    };
  }

  buildCardsByTool(nowMs = Date.now(), customRates = null, quotasByTool = null) {
    const nowDate = new Date(nowMs);
    const days30StartMs = new Date(
      nowDate.getFullYear(),
      nowDate.getMonth(),
      nowDate.getDate() - 29
    ).getTime();
    const minMs = Math.min(days30StartMs, nowMs - 28 * 86_400_000);
    const rows = this.db
      .prepare(`SELECT * FROM turns WHERE completed_at_ms >= ? ORDER BY completed_at_ms ASC`)
      .all(minMs);

    const byTool = new Map(CARD_TOOL_KEYS.map((k) => [k, []]));
    for (const r of rows) {
      if (byTool.has(r.tool)) byTool.get(r.tool).push(r);
    }

    const cards = {
      all: this.buildCodexBarCardSnapshot(rows, nowMs, customRates, quotasByTool?.all || null),
    };
    for (const k of CARD_TOOL_KEYS) {
      cards[k] = this.buildCodexBarCardSnapshot(
        byTool.get(k) || [],
        nowMs,
        customRates,
        quotasByTool?.[k] || null
      );
    }
    return cards;
  }

  getState(limit = 20) {
    const recent = this.getRecentTurns(limit);
    return {
      updatedAtMs: Date.now(),
      latest: recent[0] || null,
      byTool: this.getLatestByTool(),
      todaySummary: this.getTodaySummary(),
      recent,
    };
  }

  close() {
    this.db.close();
  }
}
