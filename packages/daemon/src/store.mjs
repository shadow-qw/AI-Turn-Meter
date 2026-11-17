import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { formatInlineSummary, normalizeTurn, TOOL_LABELS } from './format.mjs';

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
   */
  constructor(dbPath = defaultDbPath()) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
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
    return {
      ...t,
      toolLabel: TOOL_LABELS[t.tool] || t.tool,
      inlineText: formatInlineSummary(t),
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

  getState(limit = 20) {
    const recent = this.getRecentTurns(limit);
    return {
      updatedAtMs: Date.now(),
      latest: recent[0] || null,
      byTool: this.getLatestByTool(),
      recent,
    };
  }

  close() {
    this.db.close();
  }
}
