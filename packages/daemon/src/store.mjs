import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { isCodexOpenAiModel } from './adapters/codex.mjs';
import { formatCacheRate, formatInlineSummary, formatTps, normalizeTurn, TOOL_LABELS } from './format.mjs';
import { defaultCustomPricingPath, estimateTurnCost, loadCustomPricing } from './pricing.mjs';
import { buildReceiptPunchlines, parseLocalDateRange } from './receipt.mjs';

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
      explicitCostUsd: row.explicit_cost_usd,
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
    this.dbPath = dbPath;
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
        reply_preview TEXT,
        explicit_cost_usd REAL
      );

      CREATE INDEX IF NOT EXISTS idx_turns_completed ON turns(completed_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_turns_tool_completed ON turns(tool, completed_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(tool, session_id);
      CREATE INDEX IF NOT EXISTS idx_turns_workspace ON turns(workspace_path, completed_at_ms DESC);

      CREATE TABLE IF NOT EXISTS ingested_files (
        file_path TEXT PRIMARY KEY,
        mtime_ms REAL NOT NULL,
        size_bytes INTEGER
      );

      CREATE TABLE IF NOT EXISTS sync_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS fingerprint_runs (
        id TEXT PRIMARY KEY,
        created_at_ms INTEGER NOT NULL,
        target_type TEXT NOT NULL,
        target_name TEXT NOT NULL,
        tool TEXT,
        requested_model TEXT,
        response_model TEXT,
        mode TEXT NOT NULL,
        verdict TEXT NOT NULL,
        score INTEGER,
        js_distance REAL,
        summary TEXT,
        details_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_fp_runs_created ON fingerprint_runs(created_at_ms DESC);

      CREATE TABLE IF NOT EXISTS fingerprint_baselines (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        model TEXT NOT NULL,
        target_name TEXT NOT NULL,
        sample_count INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL,
        distribution_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_fp_baselines_model ON fingerprint_baselines(model, created_at_ms DESC);
    `);

    try {
      this.db.exec('ALTER TABLE turns ADD COLUMN reply_preview TEXT;');
    } catch {
      // Column already exists on initialized databases
    }
    try {
      this.db.exec('ALTER TABLE turns ADD COLUMN explicit_cost_usd REAL;');
    } catch {
      // Column already exists on initialized databases
    }

    // Purge any legacy third-party gateway proxy turns (e.g. workbuddy/claude-opus-5.5) recorded under Codex.
    const existingCodexRows = this.db.prepare(`SELECT turn_uid, model FROM turns WHERE tool = 'codex'`).all();
    const staleCodexUids = existingCodexRows.filter((r) => !isCodexOpenAiModel(r.model)).map((r) => r.turn_uid);
    if (staleCodexUids.length > 0) {
      const delStmt = this.db.prepare(`DELETE FROM turns WHERE turn_uid = ?`);
      for (const uid of staleCodexUids) {
        delStmt.run(uid);
      }
    }

    this.upsertStmt = this.db.prepare(`
      INSERT INTO turns (
        turn_uid, tool, host, session_id, turn_id, model,
        workspace_path, workspace_hash, started_at_ms, completed_at_ms,
        call_count, total_input_tokens, uncached_input_tokens,
        cache_read_tokens, cache_write_tokens, output_tokens,
        thinking_tokens, cache_rate_pct, duration_ms, model_active_ms,
        ttft_ms, tps, tps_method, reply_preview, explicit_cost_usd
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?
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
        reply_preview = COALESCE(excluded.reply_preview, turns.reply_preview),
        explicit_cost_usd = COALESCE(excluded.explicit_cost_usd, turns.explicit_cost_usd)
    `);

    this.getExistingStmt = this.db.prepare(
      `SELECT completed_at_ms, total_input_tokens, uncached_input_tokens, cache_read_tokens, output_tokens, tps, call_count, model, workspace_path, reply_preview, explicit_cost_usd FROM turns WHERE turn_uid = ?`
    );

    this.getIngestedStmt = this.db.prepare(`SELECT mtime_ms, size_bytes FROM ingested_files WHERE file_path = ?`);
    this.setIngestedStmt = this.db.prepare(`
      INSERT INTO ingested_files (file_path, mtime_ms, size_bytes)
      VALUES (?, ?, ?)
      ON CONFLICT(file_path) DO UPDATE SET mtime_ms = excluded.mtime_ms, size_bytes = excluded.size_bytes
    `);
    this.getMetaStmt = this.db.prepare(`SELECT value FROM sync_meta WHERE key = ?`);
    this.setMetaStmt = this.db.prepare(`
      INSERT INTO sync_meta (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);

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
      (!prev.workspace_path && Boolean(t.workspacePath)) ||
      prev.explicit_cost_usd !== t.explicitCostUsd;

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
        t.replyPreview,
        t.explicitCostUsd
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
      explicitCostUsd: row.explicit_cost_usd ?? null,
    });
    return this.enrichRecord(t);
  }

  getIngestedFile(filePath) {
    const r = this.getIngestedStmt.get(filePath);
    return r ? { mtimeMs: Number(r.mtime_ms), sizeBytes: r.size_bytes ?? null } : null;
  }

  setIngestedFile(filePath, mtimeMs, sizeBytes = null) {
    this.setIngestedStmt.run(filePath, mtimeMs, sizeBytes);
  }

  getMeta(key) {
    const r = this.getMetaStmt.get(String(key));
    return r ? String(r.value) : null;
  }

  setMeta(key, value) {
    this.setMetaStmt.run(String(key), String(value));
  }

  getCursorLocalHookRows() {
    return this.db
      .prepare(
        `SELECT session_id, workspace_path, started_at_ms, completed_at_ms, total_input_tokens, output_tokens
         FROM turns
         WHERE tool = 'cursor' AND host != 'cursor-cloud'`
      )
      .all();
  }

  getLatestByTool() {
    const tools = ['codex', 'antigravity', 'cursor', 'codebuddy'];
    const result = {};
    const stmt = this.db.prepare(
      `SELECT * FROM turns WHERE tool = ?
       ORDER BY (CASE WHEN host = 'cursor-cloud' THEN 0 ELSE 1 END) DESC, completed_at_ms DESC LIMIT 1`
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
            `SELECT * FROM turns WHERE tool = ? AND workspace_path = ? AND host != 'cursor-cloud' ORDER BY completed_at_ms DESC LIMIT 1`
          )
          .get(tool, workspacePath);
        if (r) return this.rowToTurn(r);
      }
      if (workspaceHash) {
        const r = this.db
          .prepare(
            `SELECT * FROM turns WHERE tool = ? AND workspace_hash = ? AND host != 'cursor-cloud' ORDER BY completed_at_ms DESC LIMIT 1`
          )
          .get(tool, workspaceHash);
        if (r) return this.rowToTurn(r);
      }
      const r = this.db
        .prepare(`SELECT * FROM turns WHERE tool = ? AND host != 'cursor-cloud' ORDER BY completed_at_ms DESC LIMIT 1`)
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

  getTodaySummary(nowMs = Date.now(), tool = null, enabledTools = null) {
    const startMs = startOfLocalDayMs(nowMs);
    const customRates = this.customPricingPath ? loadCustomPricing(this.customPricingPath) : null;
    const rawRows = tool
      ? this.db
          .prepare(`SELECT * FROM turns WHERE tool = ? AND completed_at_ms >= ?`)
          .all(tool, startMs)
      : this.db
          .prepare(`SELECT * FROM turns WHERE completed_at_ms >= ?`)
          .all(startMs);
    const rows =
      !tool && enabledTools ? rawRows.filter((r) => enabledTools[r.tool] !== false) : rawRows;
    const acc = createUsageAccumulator();
    for (const row of rows) {
      addTurnToAccumulator(acc, row, customRates);
    }
    return finalizeAccumulator(acc);
  }

  /**
   * Aggregate usage, cost, and cache savings over `days` local calendar days (0 or 'all' = all history).
   * @param {{ days?: number | string | null, tool?: string | null, nowMs?: number, quotasByTool?: Record<string, any> | null, enabledTools?: Record<string, boolean> | null }} [opts]
   */
  getUsageSummary({ days = 7, tool = null, nowMs = Date.now(), quotasByTool = null, enabledTools = null } = {}) {
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
    const rawRows = tool
      ? this.db
          .prepare(`SELECT * FROM turns WHERE tool = ? AND completed_at_ms >= ? ORDER BY completed_at_ms ASC`)
          .all(tool, sinceMs)
      : this.db
          .prepare(`SELECT * FROM turns WHERE completed_at_ms >= ? ORDER BY completed_at_ms ASC`)
          .all(sinceMs);
    const rows =
      !tool && enabledTools ? rawRows.filter((r) => enabledTools[r.tool] !== false) : rawRows;

    const totalsAcc = createUsageAccumulator();
    const todayAcc = createUsageAccumulator();
    const toolMap = new Map();
    const modelMap = new Map();
    const projectMap = new Map();
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

    const byProject = Array.from(projectMap.values())
      .map(({ name, path, acc }) => {
        const stats = finalizeAccumulator(acc);
        return {
          name,
          path,
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

    const cards = this.buildCardsByTool(nowMs, customRates, quotasByTool, enabledTools);

    return {
      days: resolvedDays,
      tool: tool || null,
      sinceMs,
      generatedAtMs: nowMs,
      today,
      totals,
      byTool,
      byModel,
      byProject,
      daily,
      cards,
    };
  }

  buildLatestTurnMetrics(rows, todayFin) {
    let latestTpsRow = null;
    let latestLocalRow = null;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const r = rows[i];
      if (!latestLocalRow && r.host !== 'cursor-cloud') latestLocalRow = r;
      if (!latestTpsRow && typeof r.tps === 'number' && Number.isFinite(r.tps) && r.tps > 0) {
        latestTpsRow = r;
      }
      if (latestLocalRow && latestTpsRow) break;
    }
    const latestRow = latestTpsRow || latestLocalRow || (rows.length > 0 ? rows[rows.length - 1] : null);
    let tpsText = null;
    if (latestTpsRow && typeof latestTpsRow.tps === 'number' && latestTpsRow.tps > 0) {
      tpsText = formatTps(latestTpsRow.tps);
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
      const score = [fin.totalTokens, fin.turnCount, fin.estimatedCostUsd ?? -1];
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
      quotaHint: quotaInfo?.quotaHint ?? null,
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

  buildCardsByTool(nowMs = Date.now(), customRates = null, quotasByTool = null, enabledTools = null) {
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

    const enabledRows = enabledTools ? rows.filter((r) => enabledTools[r.tool] !== false) : rows;

    const cards = {
      all: this.buildCodexBarCardSnapshot(enabledRows, nowMs, customRates, quotasByTool?.all || null),
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

  getState(limit = 20, enabledTools = null) {
    const recent = this.getRecentTurns(limit);
    return {
      updatedAtMs: Date.now(),
      latest: recent[0] || null,
      byTool: this.getLatestByTool(),
      todaySummary: this.getTodaySummary(Date.now(), null, enabledTools),
      recent,
    };
  }

  /**
   * Build structured daily/range thermal-receipt payload ("Day Card").
   */
  getReceiptData({
    date = null,
    scope = 'day',
    tool = null,
    groupBy = 'model',
    enabledTools = null,
    nowMs = Date.now(),
  } = {}) {
    const range = parseLocalDateRange(date, scope, nowMs);
    const normalizedGroup = groupBy === 'tool' || groupBy === 'project' ? groupBy : 'model';
    const customRates = this.customPricingPath ? loadCustomPricing(this.customPricingPath) : null;

    const rawRows = tool
      ? this.db
          .prepare(
            `SELECT * FROM turns WHERE tool = ? AND completed_at_ms >= ? AND completed_at_ms < ? ORDER BY completed_at_ms ASC`
          )
          .all(tool, range.startMs, range.endMs)
      : this.db
          .prepare(
            `SELECT * FROM turns WHERE completed_at_ms >= ? AND completed_at_ms < ? ORDER BY completed_at_ms ASC`
          )
          .all(range.startMs, range.endMs);
    const rows =
      !tool && enabledTools ? rawRows.filter((r) => enabledTools[r.tool] !== false) : rawRows;

    const totalsAcc = createUsageAccumulator();
    const itemMap = new Map();
    const agentMap = new Map();
    const projectMap = new Map();
    const modelCostMap = new Map();
    const toolSet = new Set();
    const hourlyCounts = new Array(24).fill(0);
    let firstTurnAtMs = null;
    let lastTurnAtMs = null;

    for (const row of rows) {
      addTurnToAccumulator(totalsAcc, row, customRates);
      toolSet.add(row.tool);
      const ts = Number(row.completed_at_ms) || 0;
      if (ts > 0) {
        if (firstTurnAtMs === null || ts < firstTurnAtMs) firstTurnAtMs = ts;
        if (lastTurnAtMs === null || ts > lastTurnAtMs) lastTurnAtMs = ts;
        hourlyCounts[new Date(ts).getHours()] += 1;
      }

      const rawWs = typeof row.workspace_path === 'string' ? row.workspace_path.trim() : '';
      const projName = rawWs ? (rawWs.split('/').filter(Boolean).pop() || rawWs) : 'Independent chats';
      const projKey = rawWs || '__independent__';
      if (!projectMap.has(projKey)) {
        projectMap.set(projKey, { name: projName, path: rawWs || '未绑定工作区目录', acc: createUsageAccumulator() });
      }
      addTurnToAccumulator(projectMap.get(projKey).acc, row, customRates);

      const mName = row.model || 'unknown';
      if (!modelCostMap.has(mName)) modelCostMap.set(mName, createUsageAccumulator());
      addTurnToAccumulator(modelCostMap.get(mName), row, customRates);

      if (!agentMap.has(row.tool)) {
        agentMap.set(row.tool, {
          tool: row.tool,
          label: (TOOL_LABELS[row.tool] || row.tool).toUpperCase(),
          acc: createUsageAccumulator(),
          models: new Map(),
        });
      }
      const ag = agentMap.get(row.tool);
      addTurnToAccumulator(ag.acc, row, customRates);
      if (!ag.models.has(mName)) {
        ag.models.set(mName, { model: mName, label: mName.toUpperCase(), acc: createUsageAccumulator() });
      }
      addTurnToAccumulator(ag.models.get(mName).acc, row, customRates);

      let gKey;
      let gLabel;
      let gSublabel;
      let gTool = row.tool;
      if (normalizedGroup === 'tool') {
        gKey = row.tool;
        gLabel = TOOL_LABELS[row.tool] || row.tool;
        gSublabel = row.tool;
      } else if (normalizedGroup === 'project') {
        gKey = projKey;
        gLabel = projName;
        gSublabel = rawWs || '独立对话';
        gTool = null;
      } else {
        gKey = `${row.tool}\0${mName}`;
        gLabel = mName;
        gSublabel = TOOL_LABELS[row.tool] || row.tool;
      }
      if (!itemMap.has(gKey)) {
        itemMap.set(gKey, { id: gKey, label: gLabel, sublabel: gSublabel, tool: gTool, acc: createUsageAccumulator() });
      }
      addTurnToAccumulator(itemMap.get(gKey).acc, row, customRates);
    }

    const totalsBase = finalizeAccumulator(totalsAcc);
    const grossCostUsd =
      totalsBase.estimatedCostUsd !== null
        ? Number(((totalsBase.estimatedCostUsd || 0) + (totalsBase.cacheSavingsUsd || 0)).toFixed(4))
        : null;
    const totals = { ...totalsBase, grossCostUsd };

    const items = Array.from(itemMap.values())
      .map(({ id, label, sublabel, tool: itemTool, acc }) => {
        const stats = finalizeAccumulator(acc);
        const gross =
          stats.estimatedCostUsd !== null
            ? Number(((stats.estimatedCostUsd || 0) + (stats.cacheSavingsUsd || 0)).toFixed(4))
            : null;
        return {
          id,
          label,
          sublabel,
          tool: itemTool,
          priced: stats.pricedTurnCount > 0,
          sharePct:
            totals.totalTokens > 0
              ? Number(((stats.totalTokens / totals.totalTokens) * 100).toFixed(1))
              : 0,
          grossCostUsd: gross,
          ...stats,
        };
      })
      .sort(
        (a, b) =>
          (b.estimatedCostUsd ?? -1) - (a.estimatedCostUsd ?? -1) || b.totalTokens - a.totalTokens
      );

    let peakHour = null;
    let peakCount = 0;
    for (let h = 0; h < 24; h += 1) {
      if (hourlyCounts[h] > peakCount) {
        peakCount = hourlyCounts[h];
        peakHour = `${String(h).padStart(2, '0')}:00`;
      }
    }

    const topProjEntry = Array.from(projectMap.values())
      .map((p) => ({ name: p.name, path: p.path, stats: finalizeAccumulator(p.acc) }))
      .sort((a, b) => (b.stats.estimatedCostUsd ?? -1) - (a.stats.estimatedCostUsd ?? -1) || b.stats.totalTokens - a.stats.totalTokens)[0];
    const topModelEntry = Array.from(modelCostMap.entries())
      .map(([m, acc]) => ({ model: m, stats: finalizeAccumulator(acc) }))
      .sort((a, b) => (b.stats.estimatedCostUsd ?? -1) - (a.stats.estimatedCostUsd ?? -1) || b.stats.totalTokens - a.stats.totalTokens)[0];

    // Also provide recent 90 days of active dates for Day Card navigation
    const since90Ms = nowMs - 90 * 86_400_000;
    const histRows = tool
      ? this.db
          .prepare(`SELECT completed_at_ms, total_input_tokens, uncached_input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, thinking_tokens, call_count, tps, model, explicit_cost_usd, tool FROM turns WHERE tool = ? AND completed_at_ms >= ? ORDER BY completed_at_ms DESC`)
          .all(tool, since90Ms)
      : this.db
          .prepare(`SELECT completed_at_ms, total_input_tokens, uncached_input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, thinking_tokens, call_count, tps, model, explicit_cost_usd, tool FROM turns WHERE completed_at_ms >= ? ORDER BY completed_at_ms DESC`)
          .all(since90Ms);
    const filteredHist =
      !tool && enabledTools ? histRows.filter((r) => enabledTools[r.tool] !== false) : histRows;
    const availMap = new Map();
    for (const r of filteredHist) {
      const dk = toLocalDateKey(r.completed_at_ms);
      if (!availMap.has(dk)) availMap.set(dk, createUsageAccumulator());
      addTurnToAccumulator(availMap.get(dk), r, customRates);
    }
    const availableDates = Array.from(availMap.entries())
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([d, acc]) => {
        const s = finalizeAccumulator(acc);
        return {
          date: d,
          turnCount: s.turnCount,
          totalInputTokens: s.totalInputTokens,
          outputTokens: s.outputTokens,
          totalTokens: s.totalTokens,
          estimatedCostUsd: s.estimatedCostUsd,
          cacheSavingsUsd: s.cacheSavingsUsd,
        };
      });

    const agentBreakdown = Array.from(agentMap.values())
      .map((ag) => {
        const stats = finalizeAccumulator(ag.acc);
        const models = Array.from(ag.models.values())
          .map((m) => {
            const ms = finalizeAccumulator(m.acc);
            return {
              model: m.model,
              label: m.label,
              priced: ms.pricedTurnCount > 0,
              turnCount: ms.turnCount,
              callCount: ms.callCount,
              totalTokens: ms.totalTokens,
              estimatedCostUsd: ms.estimatedCostUsd,
            };
          })
          .sort(
            (a, b) =>
              (b.estimatedCostUsd ?? -1) - (a.estimatedCostUsd ?? -1) || b.totalTokens - a.totalTokens
          );
        return {
          tool: ag.tool,
          label: ag.label,
          priced: stats.pricedTurnCount > 0,
          turnCount: stats.turnCount,
          callCount: stats.callCount,
          totalTokens: stats.totalTokens,
          estimatedCostUsd: stats.estimatedCostUsd,
          models,
        };
      })
      .sort(
        (a, b) =>
          (b.estimatedCostUsd ?? -1) - (a.estimatedCostUsd ?? -1) || b.totalTokens - a.totalTokens
      );

    // Compute consecutive active streak ending on range.date (or latest active day <= range.date)
    const activeDateSet = new Set(availableDates.map((d) => d.date));
    let streakDays = 0;
    const [ay, am, ad] = range.date.split('-').map(Number);
    for (let offset = 0; offset < 365; offset += 1) {
      const probe = new Date(ay, am - 1, ad - offset);
      const key = toLocalDateKey(probe.getTime());
      if (activeDateSet.has(key)) {
        streakDays += 1;
      } else {
        break;
      }
    }

    // Compute ratio vs recent 30 active days daily average spend
    const recent30Costs = availableDates
      .slice(0, 30)
      .map((d) => d.estimatedCostUsd)
      .filter((v) => typeof v === 'number' && Number.isFinite(v) && v > 0);
    const dailyAvgUsd =
      recent30Costs.length > 0
        ? recent30Costs.reduce((sum, v) => sum + v, 0) / recent30Costs.length
        : null;
    const spanDays = range.scope === 'week' ? 7 : range.scope === 'month' ? 30 : 1;
    const currentPerDayUsd =
      typeof totals.estimatedCostUsd === 'number' && Number.isFinite(totals.estimatedCostUsd)
        ? totals.estimatedCostUsd / spanDays
        : null;
    const vsDailyAvgRatio =
      dailyAvgUsd && dailyAvgUsd > 0 && currentPerDayUsd !== null && currentPerDayUsd > 0
        ? Number((currentPerDayUsd / dailyAvgUsd).toFixed(1))
        : null;

    const compactDate = range.date.replace(/-/g, '');
    const receiptNo = `ATM-${compactDate}-${String(totals.turnCount).padStart(3, '0')}`;
    const receipt = {
      receiptNo,
      scope: range.scope,
      date: range.date,
      startDate: range.startDate,
      weekdayLabel: range.weekdayLabel,
      rangeLabel: range.rangeLabel,
      groupBy: normalizedGroup,
      toolFilter: tool || 'all',
      generatedAtMs: nowMs,
      activeTools: Array.from(toolSet),
      streakDays,
      vsDailyAvgRatio,
      totals,
      items,
      agentBreakdown,
      highlights: {
        firstTurnAtMs,
        lastTurnAtMs,
        peakHour,
        hourlyCounts,
        topProject: topProjEntry
          ? {
              name: topProjEntry.name,
              path: topProjEntry.path,
              costUsd: topProjEntry.stats.estimatedCostUsd,
              totalTokens: topProjEntry.stats.totalTokens,
            }
          : null,
        topModel: topModelEntry
          ? {
              model: topModelEntry.model,
              costUsd: topModelEntry.stats.estimatedCostUsd,
              totalTokens: topModelEntry.stats.totalTokens,
            }
          : null,
      },
      availableDates,
      barcodeSeed: `${receiptNo}:${totals.totalTokens}:${totals.estimatedCostUsd ?? 0}`,
    };
    receipt.punchlines = buildReceiptPunchlines(receipt);
    return receipt;
  }

  saveFingerprintRun(run) {
    const id = run.id || `fp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const createdAtMs = Number(run.createdAtMs) || Date.now();
    this.db
      .prepare(
        `INSERT INTO fingerprint_runs (
          id, created_at_ms, target_type, target_name, tool,
          requested_model, response_model, mode, verdict, score,
          js_distance, summary, details_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          verdict = excluded.verdict,
          score = excluded.score,
          js_distance = excluded.js_distance,
          summary = excluded.summary,
          details_json = excluded.details_json`
      )
      .run(
        id,
        createdAtMs,
        run.targetType || 'endpoint',
        run.targetName || 'unknown',
        run.tool || null,
        run.requestedModel || null,
        run.responseModel || null,
        run.mode || 'quick',
        run.verdict || 'unknown',
        typeof run.score === 'number' && Number.isFinite(run.score) ? Math.round(run.score) : null,
        typeof run.jsDistance === 'number' && Number.isFinite(run.jsDistance) ? run.jsDistance : null,
        run.summary || '',
        JSON.stringify(run.details || {})
      );
    return { ...run, id, createdAtMs };
  }

  listFingerprintRuns(limit = 30) {
    const rows = this.db
      .prepare(`SELECT * FROM fingerprint_runs ORDER BY created_at_ms DESC LIMIT ?`)
      .all(Math.min(100, Math.max(1, Number(limit) || 30)));
    return rows.map((r) => {
      let details = {};
      try {
        details = r.details_json ? JSON.parse(r.details_json) : {};
      } catch {}
      return {
        id: r.id,
        createdAtMs: r.created_at_ms,
        targetType: r.target_type,
        targetName: r.target_name,
        tool: r.tool || null,
        requestedModel: r.requested_model || null,
        responseModel: r.response_model || null,
        mode: r.mode,
        verdict: r.verdict,
        score: r.score !== null && r.score !== undefined ? Number(r.score) : null,
        jsDistance: r.js_distance !== null && r.js_distance !== undefined ? Number(r.js_distance) : null,
        summary: r.summary || '',
        details,
      };
    });
  }

  saveFingerprintBaseline(baseline) {
    const id = baseline.id || `bl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const createdAtMs = Number(baseline.createdAtMs) || Date.now();
    this.db
      .prepare(
        `INSERT INTO fingerprint_baselines (
          id, name, model, target_name, sample_count, created_at_ms, distribution_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          sample_count = excluded.sample_count,
          created_at_ms = excluded.created_at_ms,
          distribution_json = excluded.distribution_json`
      )
      .run(
        id,
        baseline.name || baseline.model || '基线',
        baseline.model || 'unknown',
        baseline.targetName || 'endpoint',
        Number(baseline.sampleCount) || 0,
        createdAtMs,
        JSON.stringify(baseline.distribution || {})
      );
    return { ...baseline, id, createdAtMs };
  }

  listFingerprintBaselines() {
    const rows = this.db
      .prepare(`SELECT * FROM fingerprint_baselines ORDER BY created_at_ms DESC`)
      .all();
    return rows.map((r) => {
      let distribution = {};
      try {
        distribution = r.distribution_json ? JSON.parse(r.distribution_json) : {};
      } catch {}
      return {
        id: r.id,
        name: r.name,
        model: r.model,
        targetName: r.target_name,
        sampleCount: r.sample_count,
        createdAtMs: r.created_at_ms,
        distribution,
      };
    });
  }

  deleteFingerprintBaseline(id) {
    if (!id) return false;
    const res = this.db.prepare(`DELETE FROM fingerprint_baselines WHERE id = ?`).run(id);
    return (res?.changes || 0) > 0;
  }

  close() {
    this.db.close();
  }
}
