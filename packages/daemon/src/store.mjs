import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { isCodexOpenAiModel } from './adapters/codex.mjs';
import { formatCacheRate, formatInlineSummary, formatTps, normalizeTurn, TOOL_LABELS } from './format.mjs';
import { defaultCustomPricingPath, estimateTurnCost, loadCustomPricing, sanitizeUsageBuckets } from './pricing.mjs';
import { buildReceiptPunchlines, parseLocalDateRange } from './receipt.mjs';

function setBoundedCache(map, key, val, maxSize = 16) {
  if (map.has(key)) map.delete(key);
  while (map.size >= maxSize) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
  map.set(key, val);
}

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
const CARD_TOOL_KEYS = ['codex', 'claude', 'cursor', 'antigravity', 'codebuddy'];
const UNBOUND_WORKSPACE_LABEL = '未关联工作区';
const ACTIVE_SESSION_WINDOW_MS = 90_000;
const RECENT_SESSIONS_CACHE_TTL_MS = 15_000;

/**
 * Revision of what the session-file adapters extract per turn. Bump it whenever a parser starts
 * producing data that historical files must be re-parsed for (e.g. usage buckets); every file
 * ingested under an older revision is then re-parsed once on the next scan.
 */
export const INGEST_PARSER_REV = 2;

function normalizeWorkspacePath(raw) {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  return trimmed.length > 1 ? trimmed.replace(/\/+$/, '') : trimmed;
}

function workspaceBasename(workspacePath) {
  const normalized = normalizeWorkspacePath(workspacePath);
  if (!normalized) return null;
  return normalized.split('/').filter(Boolean).pop() || normalized;
}

function truncateSessionTitle(raw, maxLen = 60) {
  if (typeof raw !== 'string') return null;
  const clean = raw.replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, Math.max(1, maxLen - 1)).trimEnd()}…`;
}

function shortSessionId(sessionId) {
  const s = String(sessionId || '').trim();
  if (!s) return 'session';
  return s.length > 12 ? s.slice(0, 8) : s;
}

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
      host: row.host,
      model: row.model,
      completedAtMs: row.completed_at_ms,
      totalInputTokens: totalIn,
      uncachedInputTokens: uncachedIn,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      outputTokens: out,
      callCount: calls,
      explicitCostUsd: row.explicit_cost_usd,
      usageBuckets: sanitizeUsageBuckets(row.usage_buckets_json),
    },
    customRates
  );
  if (cost.priced && cost.costUsd !== null) {
    acc.pricedTurnCount += 1;
    acc.estimatedCostUsd += cost.costUsd;
    acc.cacheSavingsUsd += cost.savingsUsd || 0;
    // Keep the known part of a partially priced turn, but surface it in "N 次请求没有价格".
    if (cost.partial) acc.unpricedTurnCount += 1;
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
    turnCount: Math.round(acc.turnCount),
    callCount: Math.round(acc.callCount),
    totalInputTokens: Math.round(acc.totalInputTokens),
    uncachedInputTokens: Math.round(acc.uncachedInputTokens),
    cacheReadTokens: Math.round(acc.cacheReadTokens),
    cacheWriteTokens: Math.round(acc.cacheWriteTokens),
    outputTokens: Math.round(acc.outputTokens),
    thinkingTokens: Math.round(acc.thinkingTokens),
    totalTokens: Math.round(totalTokens),
    cacheRatePct,
    avgTps,
    estimatedCostUsd,
    cacheSavingsUsd,
    pricedTurnCount: Math.round(acc.pricedTurnCount),
    unpricedTurnCount: Math.round(acc.unpricedTurnCount),
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
    this.db.exec('PRAGMA busy_timeout = 5000;');
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
        explicit_cost_usd REAL,
        usage_buckets_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_turns_completed ON turns(completed_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_turns_tool_completed ON turns(tool, completed_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_turns_tool_host_completed ON turns(tool, host, completed_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(tool, session_id);
      CREATE INDEX IF NOT EXISTS idx_turns_tool_session_completed ON turns(tool, session_id, completed_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_turns_workspace ON turns(workspace_path, completed_at_ms DESC);

      CREATE TABLE IF NOT EXISTS ingested_files (
        file_path TEXT PRIMARY KEY,
        mtime_ms REAL NOT NULL,
        size_bytes INTEGER
      );

      -- Successor of ingested_files. Older daemons keep writing ingested_files without knowing
      -- parser revisions (and would mark files "done" after parsing them without usage buckets),
      -- so this version tracks its own state in a table they never touch.
      CREATE TABLE IF NOT EXISTS ingest_state (
        file_path TEXT PRIMARY KEY,
        mtime_ms REAL NOT NULL,
        size_bytes INTEGER,
        parser_rev INTEGER NOT NULL
      );

      -- Which session file first contained each API call (message.id|requestId). Resumed or
      -- forked Claude Code sessions copy earlier calls into a new file; only the owner counts them.
      CREATE TABLE IF NOT EXISTS call_owner (
        call_key TEXT PRIMARY KEY,
        file_path TEXT NOT NULL
      );

      -- Which session file produced each turn, so re-parsing a file replaces exactly the turns it
      -- produced before (including ones a newer parser no longer emits) and nothing else.
      CREATE TABLE IF NOT EXISTS turn_source (
        turn_uid TEXT PRIMARY KEY,
        file_path TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_turn_source_file ON turn_source(file_path);

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

    const verRow = this.db.prepare('PRAGMA user_version').get();
    const schemaVer = Number(verRow?.user_version || 0);
    if (schemaVer < 1) {
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
      this.db.exec('PRAGMA user_version = 1;');
    }

    if (schemaVer < 2) {
      const staleSessions = this.db
        .prepare(
          `SELECT DISTINCT session_id FROM turns
           WHERE tool = 'antigravity'
             AND (model = 'unknown' OR (tps IS NOT NULL AND tps_method = 'unavailable'))`
        )
        .all();
      if (staleSessions.length > 0) {
        const delIngested = this.db.prepare(`DELETE FROM ingested_files WHERE file_path LIKE ?`);
        const delIngestState = this.db.prepare(`DELETE FROM ingest_state WHERE file_path LIKE ?`);
        for (const row of staleSessions) {
          if (typeof row.session_id === 'string' && row.session_id.trim()) {
            const pattern = `%/${row.session_id}/.system_generated/logs/transcript.jsonl`;
            delIngested.run(pattern);
            delIngestState.run(pattern);
          }
        }
      }
      this.db.exec('PRAGMA user_version = 2;');
    }

    if (schemaVer < 3) {
      // Clear ingested_files so previously skipped open turns (Antigravity subagents, Codex, CodeBuddy CLI)
      // and historical CodeBuddy IDE fallback timestamps are re-scanned with current parsers.
      this.db.exec('DELETE FROM ingested_files;');
      this.db.exec('DELETE FROM ingest_state;');

      // Remove stale mid-turn cursor-cloud partial snapshots that overlap completed local cursor-ide turns.
      const overlapCloudRows = this.db
        .prepare(
          `SELECT c.turn_uid, c.session_id, c.completed_at_ms, c.total_input_tokens, c.output_tokens
           FROM turns c
           WHERE c.tool = 'cursor' AND c.host = 'cursor-cloud'
             AND EXISTS (
               SELECT 1 FROM turns h
               WHERE h.tool = 'cursor' AND h.host != 'cursor-cloud' AND h.session_id = c.session_id
             )`
        )
        .all();
      if (overlapCloudRows.length > 0) {
        const hooksBySessionStmt = this.db.prepare(
          `SELECT started_at_ms, completed_at_ms, total_input_tokens, output_tokens
           FROM turns
           WHERE tool = 'cursor' AND host != 'cursor-cloud' AND session_id = ?`
        );
        const delCloudStmt = this.db.prepare(`DELETE FROM turns WHERE turn_uid = ?`);
        for (const cr of overlapCloudRows) {
          const hooks = hooksBySessionStmt.all(cr.session_id);
          const crMs = Number(cr.completed_at_ms) || 0;
          const crIn = Number(cr.total_input_tokens) || 0;
          const crOut = Number(cr.output_tokens) || 0;
          const isDup = hooks.some((h) => {
            const hStart = Number(h.started_at_ms) || 0;
            const hEnd = Number(h.completed_at_ms) || 0;
            const hIn = Number(h.total_input_tokens) || 0;
            const hOut = Number(h.output_tokens) || 0;
            const closeInTime = Math.abs(hEnd - crMs) <= 6 * 3600_000;
            const inputMatch = closeInTime && crIn > 0 && crIn === hIn;
            const outputMatch = Math.abs(hEnd - crMs) <= 20_000 && crOut > 0 && crOut === hOut;
            const midTurnWindowMatch =
              hStart > 0 && crMs >= hStart - 60_000 && crMs <= hEnd + 20_000 && crIn <= hIn;
            return inputMatch || outputMatch || midTurnWindowMatch;
          });
          if (isDup) {
            delCloudStmt.run(cr.turn_uid);
          }
        }
      }
      this.db.exec('PRAGMA user_version = 3;');
    }

    if (schemaVer < 4) {
      try {
        this.db.exec('ALTER TABLE turns ADD COLUMN usage_buckets_json TEXT;');
      } catch {
        // Column already exists on initialized databases
      }
      // Clear ingested_files so historical Codex, Claude Code, Antigravity, and CodeBuddy CLI
      // sessions are re-scanned once to populate per-call usage_buckets_json.
      this.db.exec('DELETE FROM ingested_files;');
      this.db.exec('DELETE FROM ingest_state;');
      this.db.exec('PRAGMA user_version = 4;');
    }

    // Purge any legacy third-party gateway proxy turns (e.g. workbuddy/claude-opus-5.5) recorded under Codex.
    const codexModels = this.db.prepare(`SELECT DISTINCT model FROM turns WHERE tool = 'codex'`).all();
    const staleCodexModels = codexModels.map((r) => r.model).filter((m) => !isCodexOpenAiModel(m));
    if (staleCodexModels.length > 0) {
      const delStmt = this.db.prepare(`DELETE FROM turns WHERE tool = 'codex' AND model = ?`);
      for (const m of staleCodexModels) {
        delStmt.run(m);
      }
    }

    this.writeGeneration = 0;
    this._usageBaseCache = new Map();
    this._receiptCache = new Map();
    this._recentSessionsCache = new Map();

    this.upsertStmt = this.db.prepare(`
      INSERT INTO turns (
        turn_uid, tool, host, session_id, turn_id, model,
        workspace_path, workspace_hash, started_at_ms, completed_at_ms,
        call_count, total_input_tokens, uncached_input_tokens,
        cache_read_tokens, cache_write_tokens, output_tokens,
        thinking_tokens, cache_rate_pct, duration_ms, model_active_ms,
        ttft_ms, tps, tps_method, reply_preview, explicit_cost_usd, usage_buckets_json
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?
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
        thinking_tokens = COALESCE(excluded.thinking_tokens, turns.thinking_tokens),
        cache_rate_pct = excluded.cache_rate_pct,
        duration_ms = excluded.duration_ms,
        model_active_ms = CASE
          WHEN turns.tps_method = 'streaming_decode'
            AND excluded.tps_method != 'streaming_decode'
            AND turns.output_tokens = excluded.output_tokens
          THEN turns.model_active_ms
          ELSE excluded.model_active_ms
        END,
        ttft_ms = COALESCE(excluded.ttft_ms, turns.ttft_ms),
        tps = CASE
          WHEN turns.tps_method = 'streaming_decode'
            AND excluded.tps_method != 'streaming_decode'
            AND turns.output_tokens = excluded.output_tokens
          THEN turns.tps
          ELSE COALESCE(excluded.tps, turns.tps)
        END,
        tps_method = CASE
          WHEN turns.tps_method = 'streaming_decode'
            AND excluded.tps_method != 'streaming_decode'
            AND turns.output_tokens = excluded.output_tokens
          THEN turns.tps_method
          WHEN excluded.tps IS NOT NULL THEN excluded.tps_method
          ELSE turns.tps_method
        END,
        reply_preview = COALESCE(excluded.reply_preview, turns.reply_preview),
        explicit_cost_usd = COALESCE(excluded.explicit_cost_usd, turns.explicit_cost_usd),
        usage_buckets_json = COALESCE(excluded.usage_buckets_json, turns.usage_buckets_json)
    `);

    this.getExistingStmt = this.db.prepare(`SELECT * FROM turns WHERE turn_uid = ?`);

    this.getIngestedStmt = this.db.prepare(
      `SELECT mtime_ms, size_bytes FROM ingest_state WHERE file_path = ? AND parser_rev = ?`
    );
    this.setIngestedStmt = this.db.prepare(`
      INSERT INTO ingest_state (file_path, mtime_ms, size_bytes, parser_rev)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(file_path) DO UPDATE SET
        mtime_ms = excluded.mtime_ms,
        size_bytes = excluded.size_bytes,
        parser_rev = excluded.parser_rev
    `);
    this.getCallOwnerStmt = this.db.prepare(`SELECT file_path FROM call_owner WHERE call_key = ?`);
    this.claimCallStmt = this.db.prepare(
      `INSERT INTO call_owner (call_key, file_path) VALUES (?, ?) ON CONFLICT(call_key) DO NOTHING`
    );
    this.deleteTurnStmt = this.db.prepare(`DELETE FROM turns WHERE turn_uid = ?`);
    this.listFileTurnsStmt = this.db.prepare(`SELECT turn_uid FROM turn_source WHERE file_path = ?`);
    this.setTurnSourceStmt = this.db.prepare(`
      INSERT INTO turn_source (turn_uid, file_path) VALUES (?, ?)
      ON CONFLICT(turn_uid) DO UPDATE SET file_path = excluded.file_path
    `);
    this.deleteTurnSourceStmt = this.db.prepare(`DELETE FROM turn_source WHERE turn_uid = ?`);
    this.getMetaStmt = this.db.prepare(`SELECT value FROM sync_meta WHERE key = ?`);
    this.setMetaStmt = this.db.prepare(`
      INSERT INTO sync_meta (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);

    // A parser revision bump re-parses every session file; call ownership is rebuilt alongside it so
    // it follows the current rules (oldest-created file first). Adapters do a full scan first while
    // this is set, so an original session is not out-raced by a recent fork of it.
    this.ingestResetPending = this.getMeta('ingest_parser_rev') !== String(INGEST_PARSER_REV);
    if (this.ingestResetPending) {
      this.db.exec('DELETE FROM call_owner; DELETE FROM ingest_state;');
      this.setMeta('ingest_parser_rev', INGEST_PARSER_REV);
    }

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

    let resolvedExplicitCostUsd = t.explicitCostUsd;
    const matchedCloudUids = [];
    // Bidirectional deduplication: if a local Cursor hook turn arrives after a cursor-cloud API event
    // for the same session, remove the overlapping cloud placeholder while preserving its billed explicitCostUsd.
    if (t.tool === 'cursor' && t.host !== 'cursor-cloud' && t.sessionId) {
      const cloudRows = this.db
        .prepare(
          `SELECT turn_uid, completed_at_ms, total_input_tokens, output_tokens, explicit_cost_usd
           FROM turns
           WHERE tool = 'cursor' AND host = 'cursor-cloud' AND session_id = ?`
        )
        .all(t.sessionId);
      if (cloudRows.length > 0) {
        let recoveredCost = 0;
        let hasRecoveredCost = false;
        for (const cr of cloudRows) {
          const crMs = Number(cr.completed_at_ms) || 0;
          const crIn = Number(cr.total_input_tokens) || 0;
          const crOut = Number(cr.output_tokens) || 0;
          const closeInTime = Math.abs(crMs - t.completedAtMs) <= 6 * 3600_000;
          const inputMatch = closeInTime && crIn > 0 && crIn === t.totalInputTokens;
          const outputMatch = Math.abs(crMs - t.completedAtMs) <= 20_000 && crOut > 0 && crOut === t.outputTokens;
          const midTurnWindowMatch =
            Boolean(t.startedAtMs) &&
            crMs >= t.startedAtMs - 60_000 &&
            crMs <= t.completedAtMs + 20_000 &&
            crIn <= t.totalInputTokens;
          if (inputMatch || outputMatch || midTurnWindowMatch) {
            matchedCloudUids.push(cr.turn_uid);
            if (
              typeof cr.explicit_cost_usd === 'number' &&
              Number.isFinite(cr.explicit_cost_usd) &&
              cr.explicit_cost_usd >= 0
            ) {
              recoveredCost += cr.explicit_cost_usd;
              hasRecoveredCost = true;
            }
          }
        }
        if (
          hasRecoveredCost &&
          resolvedExplicitCostUsd === null &&
          (!prev || prev.explicit_cost_usd === null)
        ) {
          resolvedExplicitCostUsd = Number(recoveredCost.toFixed(6));
        }
      }
    }

    const usageBucketsJson =
      Array.isArray(t.usageBuckets) && t.usageBuckets.length > 0 ? JSON.stringify(t.usageBuckets) : null;

    const preserveStreaming =
      Boolean(prev) &&
      prev.tps_method === 'streaming_decode' &&
      t.tpsMethod !== 'streaming_decode' &&
      prev.output_tokens === t.outputTokens;

    const changed =
      !prev ||
      prev.completed_at_ms !== t.completedAtMs ||
      prev.total_input_tokens !== t.totalInputTokens ||
      prev.uncached_input_tokens !== t.uncachedInputTokens ||
      prev.cache_read_tokens !== t.cacheReadTokens ||
      prev.cache_write_tokens !== t.cacheWriteTokens ||
      prev.output_tokens !== t.outputTokens ||
      (t.thinkingTokens !== null && prev.thinking_tokens !== t.thinkingTokens) ||
      (!preserveStreaming && (prev.tps !== t.tps || (t.tps !== null && prev.tps_method !== t.tpsMethod))) ||
      prev.call_count !== t.callCount ||
      (!prev.reply_preview && Boolean(t.replyPreview)) ||
      (prev.model === 'unknown' && t.model !== 'unknown') ||
      (!preserveStreaming && t.model !== 'unknown' && prev.model !== t.model) ||
      (!prev.workspace_path && Boolean(t.workspacePath)) ||
      (resolvedExplicitCostUsd !== null && prev.explicit_cost_usd !== resolvedExplicitCostUsd) ||
      (usageBucketsJson !== null && prev.usage_buckets_json !== usageBucketsJson);

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
        resolvedExplicitCostUsd,
        usageBucketsJson
      );
    }

    if (matchedCloudUids.length > 0) {
      const delCloudStmt = this.db.prepare(`DELETE FROM turns WHERE turn_uid = ?`);
      for (const uid of matchedCloudUids) {
        delCloudStmt.run(uid);
      }
    }

    if (changed || matchedCloudUids.length > 0) {
      this.writeGeneration += 1;
      this._recentSessionsCache.clear();
    }

    const mergedRow = prev ? (changed ? this.getExistingStmt.get(t.turnUid) : prev) : null;
    const finalRecordInput =
      resolvedExplicitCostUsd !== t.explicitCostUsd
        ? { ...t, explicitCostUsd: resolvedExplicitCostUsd }
        : t;
    return {
      changed: changed || matchedCloudUids.length > 0,
      record: mergedRow ? this.rowToTurn(mergedRow) : this.enrichRecord(finalRecordInput),
    };
  }

  getPricingVersionTag() {
    if (!this.customPricingPath || !existsSync(this.customPricingPath)) return 0;
    try {
      return statSync(this.customPricingPath).mtimeMs || 0;
    } catch {
      return 0;
    }
  }

  /**
   * Attach formatted inline text and session cumulative totals (for hover/detail view).
   * @param {ReturnType<typeof normalizeTurn>} t
   * @param {{ sessionAgg?: any, customRates?: Record<string, any> | null }} [opts]
   */
  enrichRecord(t, opts = {}) {
    const agg =
      opts.sessionAgg !== undefined
        ? opts.sessionAgg
        : this.sessionAggStmt.get(t.tool, t.sessionId) || {
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
    const customRates =
      opts.customRates !== undefined
        ? opts.customRates
        : this.customPricingPath
          ? loadCustomPricing(this.customPricingPath)
          : null;
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

  rowToNormalizedTurn(row) {
    if (!row) return null;
    return normalizeTurn({
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
      usageBuckets: sanitizeUsageBuckets(row.usage_buckets_json),
    });
  }

  batchEnrichRows(rows) {
    if (!rows || rows.length === 0) return [];
    const normalized = rows.map((r) => this.rowToNormalizedTurn(r)).filter(Boolean);
    if (normalized.length === 0) return [];

    const pairMap = new Map();
    for (const t of normalized) {
      const k = `${t.tool}\0${t.sessionId}`;
      if (!pairMap.has(k)) pairMap.set(k, [t.tool, t.sessionId]);
    }
    const pairs = Array.from(pairMap.values());
    const aggMap = new Map();
    const chunkSize = 100;
    for (let i = 0; i < pairs.length; i += chunkSize) {
      const chunk = pairs.slice(i, i + chunkSize);
      const clauses = chunk.map(() => `(tool = ? AND session_id = ?)`).join(' OR ');
      const params = chunk.flat();
      const aggRows = this.db
        .prepare(
          `SELECT
            tool,
            session_id,
            COUNT(*) AS turn_count,
            COALESCE(SUM(call_count), 0) AS call_count,
            COALESCE(SUM(total_input_tokens), 0) AS total_input_tokens,
            COALESCE(SUM(uncached_input_tokens), 0) AS uncached_input_tokens,
            COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
            COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens
          FROM turns
          WHERE ${clauses}
          GROUP BY tool, session_id`
        )
        .all(...params);
      for (const r of aggRows) {
        aggMap.set(`${r.tool}\0${r.session_id}`, r);
      }
    }

    const customRates = this.customPricingPath ? loadCustomPricing(this.customPricingPath) : null;
    return normalized.map((t) => {
      const fallbackAgg = {
        turn_count: 1,
        call_count: t.callCount,
        total_input_tokens: t.totalInputTokens,
        uncached_input_tokens: t.uncachedInputTokens,
        cache_read_tokens: t.cacheReadTokens,
        cache_write_tokens: t.cacheWriteTokens,
        output_tokens: t.outputTokens,
      };
      return this.enrichRecord(t, {
        sessionAgg: aggMap.get(`${t.tool}\0${t.sessionId}`) || fallbackAgg,
        customRates,
      });
    });
  }

  rowToTurn(row) {
    if (!row) return null;
    return this.enrichRecord(this.rowToNormalizedTurn(row));
  }

  /** Files ingested under an older parser revision read as not ingested, so they get re-parsed. */
  getIngestedFile(filePath) {
    const r = this.getIngestedStmt.get(filePath, INGEST_PARSER_REV);
    return r ? { mtimeMs: Number(r.mtime_ms), sizeBytes: r.size_bytes ?? null } : null;
  }

  setIngestedFile(filePath, mtimeMs, sizeBytes = null) {
    this.setIngestedStmt.run(filePath, mtimeMs, sizeBytes, INGEST_PARSER_REV);
  }

  isCallOwnedByOtherFile(callKey, filePath) {
    const r = this.getCallOwnerStmt.get(callKey);
    return Boolean(r && r.file_path !== filePath);
  }

  /** First file to contain a call owns it; later claims by other files are ignored. */
  claimCallKeys(filePath, callKeys) {
    if (!callKeys || callKeys.size === 0) return;
    this.db.exec('BEGIN');
    try {
      for (const key of callKeys) this.claimCallStmt.run(key, filePath);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  deleteTurns(turnUids) {
    if (!Array.isArray(turnUids) || turnUids.length === 0) return 0;
    let removed = 0;
    for (const uid of turnUids) {
      removed += Number(this.deleteTurnStmt.run(uid).changes) || 0;
      this.deleteTurnSourceStmt.run(uid);
    }
    if (removed > 0) {
      this.writeGeneration += 1;
      this._recentSessionsCache.clear();
    }
    return removed;
  }

  /**
   * Record that filePath now produces exactly turnUids: turns it produced on an earlier parse but no
   * longer does are deleted, and each uid's source is (re)pointed at filePath.
   */
  syncFileTurns(filePath, turnUids) {
    const keep = new Set(turnUids || []);
    const stale = this.listFileTurnsStmt
      .all(filePath)
      .map((r) => r.turn_uid)
      .filter((uid) => !keep.has(uid));
    let removed = 0;
    this.db.exec('BEGIN');
    try {
      for (const uid of stale) {
        removed += Number(this.deleteTurnStmt.run(uid).changes) || 0;
        this.deleteTurnSourceStmt.run(uid);
      }
      for (const uid of keep) this.setTurnSourceStmt.run(uid, filePath);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    if (removed > 0) {
      this.writeGeneration += 1;
      this._recentSessionsCache.clear();
    }
    return removed;
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

  deleteTurnByUid(turnUid) {
    if (typeof turnUid !== 'string' || !turnUid.trim()) return false;
    const info = this.db.prepare(`DELETE FROM turns WHERE turn_uid = ?`).run(turnUid.trim());
    if (info && info.changes > 0) {
      this.writeGeneration += 1;
      this._recentSessionsCache.clear();
      return true;
    }
    return false;
  }

  getLatestByTool() {
    const tools = ['codex', 'claude', 'antigravity', 'cursor', 'codebuddy'];
    const stmt = this.db.prepare(
      `SELECT * FROM turns WHERE tool = ?
       ORDER BY (CASE WHEN host = 'cursor-cloud' THEN 0 ELSE 1 END) DESC, completed_at_ms DESC LIMIT 1`
    );
    const rawByTool = new Map();
    const rowsToEnrich = [];
    for (const tool of tools) {
      const row = stmt.get(tool) || null;
      rawByTool.set(tool, row);
      if (row) rowsToEnrich.push(row);
    }
    const enriched = this.batchEnrichRows(rowsToEnrich);
    const byUid = new Map(enriched.map((t) => [t.turnUid, t]));
    const result = {};
    for (const tool of tools) {
      const row = rawByTool.get(tool);
      result[tool] = row ? byUid.get(row.turn_uid) || null : null;
    }
    return result;
  }

  getRecentTurns(limit = 20, tool = null, { excludeHosts = null } = {}) {
    const excluded = Array.isArray(excludeHosts)
      ? excludeHosts.filter((h) => typeof h === 'string' && h.length > 0)
      : [];
    const clauses = [];
    const params = [];
    if (tool) {
      clauses.push('tool = ?');
      params.push(tool);
    }
    if (excluded.length > 0) {
      clauses.push(`host NOT IN (${excluded.map(() => '?').join(', ')})`);
      params.push(...excluded);
    }
    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM turns ${whereSql} ORDER BY completed_at_ms DESC LIMIT ?`)
      .all(...params, limit);
    return this.batchEnrichRows(rows);
  }

  /**
   * Aggregate recent sessions grouped by (tool, session_id) ordered by MAX(completed_at_ms) DESC.
   * @param {{ tool?: string | null, limit?: number, nowMs?: number, sessionTitles?: Map<string, { title?: string | null, workspacePath?: string | null, updatedAtMs?: number | null }> | null, enabledTools?: Record<string, boolean> | null }} [opts]
   */
  getRecentSessions({
    tool = null,
    limit = 5,
    nowMs = Date.now(),
    sessionTitles = null,
    enabledTools = null,
  } = {}) {
    const effectiveTool =
      typeof tool === 'string' && tool.trim() && tool.trim() !== 'all' ? tool.trim() : null;
    const resolvedLimit = Math.min(100, Math.max(1, Math.round(Number(limit) || 5)));

    const disabledTools =
      !effectiveTool && enabledTools && typeof enabledTools === 'object'
        ? Object.entries(enabledTools)
            .filter(([, enabled]) => enabled === false)
            .map(([k]) => k)
            .sort()
        : [];
    const titleMap = sessionTitles instanceof Map ? sessionTitles : null;
    let parentEdgeCount = 0;
    if (titleMap) {
      for (const entry of titleMap.values()) {
        if (typeof entry?.parentSessionId === 'string' && entry.parentSessionId.trim()) {
          parentEdgeCount += 1;
        }
      }
    }

    const resolveRootSessionId = (sTool, sid) => {
      if (sTool !== 'antigravity' || !titleMap || parentEdgeCount === 0) return sid;
      let cur = sid;
      const visited = new Set([cur]);
      while (true) {
        const entry = titleMap.get(cur);
        const parent =
          typeof entry?.parentSessionId === 'string' && entry.parentSessionId.trim()
            ? entry.parentSessionId.trim()
            : null;
        if (!parent || visited.has(parent)) break;
        visited.add(parent);
        cur = parent;
      }
      return cur;
    };

    const pricingVer = this.getPricingVersionTag();
    const cacheKey = `${this.writeGeneration}|${pricingVer}|${effectiveTool || ''}|${resolvedLimit}|${disabledTools.join(',')}|${parentEdgeCount}`;
    const nowWallMs = Date.now();

    const applyOverlay = (baseItems) => {
      return baseItems.map((item) => {
        const titleEntry = titleMap ? titleMap.get(item.sessionId) || null : null;
        const workspacePath =
          item.latestWorkspacePath || normalizeWorkspacePath(titleEntry?.workspacePath) || null;
        const title =
          truncateSessionTitle(titleEntry?.title, 80) ||
          truncateSessionTitle(item.firstReplyPreview, 60) ||
          workspaceBasename(workspacePath) ||
          shortSessionId(item.sessionId);

        const titleUpdatedAtMs =
          typeof titleEntry?.updatedAtMs === 'number' && Number.isFinite(titleEntry.updatedAtMs)
            ? titleEntry.updatedAtMs
            : null;
        const effectiveActiveAtMs =
          titleUpdatedAtMs !== null ? Math.max(item.lastActiveAtMs, titleUpdatedAtMs) : item.lastActiveAtMs;
        const isActive = effectiveActiveAtMs > 0 && nowMs - effectiveActiveAtMs <= ACTIVE_SESSION_WINDOW_MS;

        const out = {
          sessionId: item.sessionId,
          tool: item.tool,
          title,
          workspacePath,
          model: item.model,
          modelCount: item.modelCount,
          totalTokens: item.totalTokens,
          thinkingTokens: item.thinkingTokens,
          estimatedCostUsd: item.estimatedCostUsd,
          turnCount: item.turnCount,
          lastActiveAtMs: item.lastActiveAtMs,
          isActive,
        };
        if (item.subagentCount > 0) {
          out.subagentCount = item.subagentCount;
        }
        return out;
      });
    };

    const cached = this._recentSessionsCache.get(cacheKey);
    if (
      cached &&
      nowWallMs - cached.cachedAtMs < RECENT_SESSIONS_CACHE_TTL_MS &&
      Math.abs(nowMs - cached.nowMs) < RECENT_SESSIONS_CACHE_TTL_MS
    ) {
      return applyOverlay(cached.items);
    }

    const clauses = [];
    const params = [];
    if (effectiveTool) {
      clauses.push('tool = ?');
      params.push(effectiveTool);
    } else if (disabledTools.length > 0) {
      clauses.push(`tool NOT IN (${disabledTools.map(() => '?').join(', ')})`);
      params.push(...disabledTools);
    }
    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

    const scanLimit = parentEdgeCount > 0 ? Math.max(resolvedLimit * 40, 200) : resolvedLimit;
    const rawGrouped = this.db
      .prepare(
        `SELECT tool, session_id, MAX(completed_at_ms) AS last_active_at_ms
         FROM turns
         ${whereSql}
         GROUP BY tool, session_id
         ORDER BY last_active_at_ms DESC
         LIMIT ?`
      )
      .all(...params, scanLimit);

    if (rawGrouped.length === 0) {
      setBoundedCache(this._recentSessionsCache, cacheKey, { cachedAtMs: nowWallMs, nowMs, items: [] }, 32);
      return [];
    }

    const mergedMap = new Map();
    for (const r of rawGrouped) {
      const rootId = resolveRootSessionId(r.tool, r.session_id);
      const key = `${r.tool}\0${rootId}`;
      const ts = Number(r.last_active_at_ms) || 0;
      let group = mergedMap.get(key);
      if (!group) {
        group = {
          tool: r.tool,
          session_id: rootId,
          last_active_at_ms: ts,
          memberIds: new Set([rootId]),
        };
        mergedMap.set(key, group);
      } else if (ts > group.last_active_at_ms) {
        group.last_active_at_ms = ts;
      }
      group.memberIds.add(r.session_id);
    }

    const grouped = Array.from(mergedMap.values())
      .sort((a, b) => b.last_active_at_ms - a.last_active_at_ms)
      .slice(0, resolvedLimit);

    if (parentEdgeCount > 0 && titleMap) {
      const agGroupsByRoot = new Map();
      for (const g of grouped) {
        if (g.tool === 'antigravity') agGroupsByRoot.set(g.session_id, g);
      }
      if (agGroupsByRoot.size > 0) {
        for (const candidateId of titleMap.keys()) {
          const rootId = resolveRootSessionId('antigravity', candidateId);
          const g = agGroupsByRoot.get(rootId);
          if (g) {
            g.memberIds.add(candidateId);
          }
        }
      }
    }

    const queryPairs = [];
    for (const g of grouped) {
      for (const memberId of g.memberIds) {
        queryPairs.push([g.tool, memberId]);
      }
    }
    const turnRows = [];
    const pairChunkSize = 100;
    for (let i = 0; i < queryPairs.length; i += pairChunkSize) {
      const chunk = queryPairs.slice(i, i + pairChunkSize);
      const pairClauses = chunk.map(() => `(tool = ? AND session_id = ?)`).join(' OR ');
      const pairParams = chunk.flat();
      const rows = this.db
        .prepare(
          `SELECT
            tool, host, session_id, model, workspace_path, completed_at_ms,
            call_count, total_input_tokens, uncached_input_tokens,
            cache_read_tokens, cache_write_tokens, output_tokens,
            thinking_tokens, tps, reply_preview, explicit_cost_usd, usage_buckets_json
           FROM turns
           WHERE ${pairClauses}
           ORDER BY completed_at_ms ASC, rowid ASC`
        )
        .all(...pairParams);
      turnRows.push(...rows);
    }

    const rowsByKey = new Map();
    for (const r of turnRows) {
      const rootId = resolveRootSessionId(r.tool, r.session_id);
      const key = `${r.tool}\0${rootId}`;
      let list = rowsByKey.get(key);
      if (!list) {
        list = [];
        rowsByKey.set(key, list);
      }
      list.push(r);
    }

    const customRates = this.customPricingPath ? loadCustomPricing(this.customPricingPath) : null;

    const baseItems = grouped.map((g) => {
      const sTool = g.tool;
      const sessionId = g.session_id;
      const sessionRows = rowsByKey.get(`${sTool}\0${sessionId}`) || [];
      const acc = createUsageAccumulator();
      const nonUnknownModels = new Set();
      const subagentSet = new Set();
      let latestKnownModel = null;
      let rootReplyPreview = null;
      let fallbackReplyPreview = null;
      let latestWorkspacePath = null;
      let lastActiveAtMs = Number(g.last_active_at_ms) || 0;

      for (const row of sessionRows) {
        addTurnToAccumulator(acc, row, customRates);
        if (row.session_id !== sessionId) {
          subagentSet.add(row.session_id);
        }
        const ts = Number(row.completed_at_ms) || 0;
        if (ts > lastActiveAtMs) lastActiveAtMs = ts;
        const m = typeof row.model === 'string' ? row.model.trim() : '';
        if (m && m !== 'unknown') {
          nonUnknownModels.add(m);
          latestKnownModel = m;
        }
        if (typeof row.reply_preview === 'string' && row.reply_preview.trim()) {
          if (row.session_id === sessionId && !rootReplyPreview) {
            rootReplyPreview = row.reply_preview.trim();
          } else if (!fallbackReplyPreview) {
            fallbackReplyPreview = row.reply_preview.trim();
          }
        }
        const ws = normalizeWorkspacePath(row.workspace_path);
        if (ws) latestWorkspacePath = ws;
      }

      const fin = finalizeAccumulator(acc);
      return {
        sessionId,
        tool: sTool,
        firstReplyPreview: rootReplyPreview || fallbackReplyPreview,
        latestWorkspacePath,
        model: latestKnownModel,
        modelCount: nonUnknownModels.size,
        subagentCount: subagentSet.size,
        totalTokens: fin.totalTokens,
        thinkingTokens: fin.thinkingTokens,
        estimatedCostUsd: fin.estimatedCostUsd,
        turnCount: fin.turnCount,
        lastActiveAtMs,
      };
    });

    setBoundedCache(this._recentSessionsCache, cacheKey, { cachedAtMs: nowWallMs, nowMs, items: baseItems }, 32);
    return applyOverlay(baseItems);
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
   * @param {{ days?: number | string | null, tool?: string | null, nowMs?: number, quotasByTool?: Record<string, any> | null, enabledTools?: Record<string, boolean> | null, externalData?: any, sessionTitles?: Map<string, any> | null }} [opts]
   */
  getUsageSummary({
    days = 7,
    tool = null,
    nowMs = Date.now(),
    quotasByTool = null,
    enabledTools = null,
    externalData = null,
    sessionTitles = null,
  } = {}) {
    const todayStartMs = startOfLocalDayMs(nowMs);
    const resolvedDays =
      days === 'all' || days === 0 || days === '0' || days === null
        ? 0
        : Math.max(1, Math.round(Number(days) || 7));

    const enabledKey = ['codex', 'claude', 'cursor', 'antigravity', 'codebuddy']
      .map((k) => (!enabledTools || enabledTools[k] !== false ? '1' : '0'))
      .join('');
    const pricingVer = this.getPricingVersionTag();
    const cacheKey = `${this.writeGeneration}|${pricingVer}|${toLocalDateKey(nowMs)}|${Math.floor(nowMs / 60_000)}|${resolvedDays}|${tool || ''}|${enabledKey}`;

    const overlayQuotas = (base) => {
      const overlaidCards = {};
      for (const [k, card] of Object.entries(base.cards)) {
        const q = quotasByTool?.[k] || null;
        const recentSessions =
          k === 'all'
            ? this.getRecentSessions({
                tool: null,
                limit: 5,
                nowMs,
                sessionTitles,
                enabledTools,
              })
            : CARD_TOOL_KEYS.includes(k)
              ? this.getRecentSessions({
                  tool: k,
                  limit: 5,
                  nowMs,
                  sessionTitles,
                })
              : Array.isArray(card.recentSessions)
                ? card.recentSessions
                : [];
        overlaidCards[k] = {
          ...card,
          accountEmail: q?.accountEmail ?? null,
          planTitle: q?.planTitle ?? null,
          quotaWindows: Array.isArray(q?.quotaWindows) ? q.quotaWindows : [],
          resetCreditsText: q?.resetCreditsText ?? null,
          quotaHint: q?.quotaHint ?? null,
          recentSessions,
        };
      }
      if (externalData && typeof externalData === 'object') {
        if (externalData.cards && typeof externalData.cards === 'object') {
          for (const [extKey, extCard] of Object.entries(externalData.cards)) {
            overlaidCards[extKey] = extCard;
          }
        }
        if (
          overlaidCards.all &&
          Array.isArray(externalData.overviewWindows) &&
          externalData.overviewWindows.length > 0
        ) {
          overlaidCards.all = {
            ...overlaidCards.all,
            quotaWindows: [
              ...(overlaidCards.all.quotaWindows || []),
              ...externalData.overviewWindows,
            ],
          };
        }
        if (overlaidCards.all && Number(externalData.activeAccounts) > 0) {
          const builtInCountMatch = String(overlaidCards.all.accountEmail || '').match(/^(\d+)/);
          const builtInCount = builtInCountMatch ? Number(builtInCountMatch[1]) : 0;
          const totalCount = builtInCount + Number(externalData.activeAccounts);
          overlaidCards.all = {
            ...overlaidCards.all,
            accountEmail: `${totalCount} 个已登录账号`,
          };
        }
      }
      return {
        ...base,
        generatedAtMs: nowMs,
        cards: overlaidCards,
        ...(externalData
          ? {
              externalProviders: Array.isArray(externalData.providers) ? externalData.providers : [],
              providersDir: externalData.providersDir || null,
            }
          : {}),
      };
    };

    const cached = this._usageBaseCache.get(cacheKey);
    if (cached) {
      return overlayQuotas(cached);
    }

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
    const workspaceMap = new Map();
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
        const name = rawWs ? (rawWs.split('/').filter(Boolean).pop() || rawWs) : '独立对话';
        projectMap.set(projKey, {
          name,
          path: rawWs || '未绑定工作区目录',
          acc: createUsageAccumulator(),
        });
      }
      addTurnToAccumulator(projectMap.get(projKey).acc, row, customRates);

      const normWs = normalizeWorkspacePath(row.workspace_path);
      const wsKey = normWs || UNBOUND_WORKSPACE_LABEL;
      if (!workspaceMap.has(wsKey)) {
        workspaceMap.set(wsKey, {
          workspacePath: wsKey,
          workspaceName: normWs ? workspaceBasename(normWs) : UNBOUND_WORKSPACE_LABEL,
          acc: createUsageAccumulator(),
          tools: new Set(),
        });
      }
      const wsEntry = workspaceMap.get(wsKey);
      addTurnToAccumulator(wsEntry.acc, row, customRates);
      if (tKey) wsEntry.tools.add(tKey);

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

    const totalWindowCost =
      typeof totals.estimatedCostUsd === 'number' &&
      Number.isFinite(totals.estimatedCostUsd) &&
      totals.estimatedCostUsd > 0
        ? totals.estimatedCostUsd
        : 0;
    const byWorkspace = Array.from(workspaceMap.values())
      .map(({ workspacePath, workspaceName, acc, tools }) => {
        const stats = finalizeAccumulator(acc);
        const sharePct =
          totalWindowCost > 0
            ? stats.estimatedCostUsd !== null && stats.estimatedCostUsd > 0
              ? Number(((stats.estimatedCostUsd / totalWindowCost) * 100).toFixed(1))
              : 0
            : totals.totalTokens > 0
              ? Number(((stats.totalTokens / totals.totalTokens) * 100).toFixed(1))
              : 0;
        return {
          workspacePath,
          workspaceName,
          turnCount: stats.turnCount,
          totalTokens: stats.totalTokens,
          thinkingTokens: stats.thinkingTokens,
          outputTokens: stats.outputTokens,
          estimatedCostUsd: stats.estimatedCostUsd,
          sharePct,
          tools: Array.from(tools).sort(),
        };
      })
      .sort(
        (a, b) =>
          (b.estimatedCostUsd ?? -1) - (a.estimatedCostUsd ?? -1) || b.totalTokens - a.totalTokens
      )
      .slice(0, 12);

    const daily = Array.from(dailyMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, acc]) => ({
        date,
        ...finalizeAccumulator(acc),
      }));

    const cards = this.buildCardsByTool(nowMs, customRates, null, enabledTools);

    const baseResult = {
      days: resolvedDays,
      tool: tool || null,
      sinceMs,
      generatedAtMs: nowMs,
      today,
      totals,
      byTool,
      byModel,
      byProject,
      byWorkspace,
      daily,
      cards,
    };
    setBoundedCache(this._usageBaseCache, cacheKey, baseResult);
    return overlayQuotas(baseResult);
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
          const name = rawWs ? (rawWs.split('/').filter(Boolean).pop() || rawWs) : '独立对话';
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
      recentSessions: [],
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
    const enabledKey = ['codex', 'claude', 'cursor', 'antigravity', 'codebuddy']
      .map((k) => (!enabledTools || enabledTools[k] !== false ? '1' : '0'))
      .join('');
    const pricingVer = this.getPricingVersionTag();
    const cacheKey = `${this.writeGeneration}|${pricingVer}|${range.date}|${range.scope}|${tool || ''}|${normalizedGroup}|${enabledKey}|${toLocalDateKey(nowMs)}`;
    const cached = this._receiptCache.get(cacheKey);
    if (cached) {
      return { ...cached, generatedAtMs: nowMs };
    }
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
      const toolKey = typeof row.tool === 'string' && row.tool.trim() ? row.tool.trim() : 'unknown';
      addTurnToAccumulator(totalsAcc, row, customRates);
      toolSet.add(toolKey);
      const ts = Number(row.completed_at_ms) || 0;
      if (ts > 0 && Number.isFinite(ts)) {
        if (firstTurnAtMs === null || ts < firstTurnAtMs) firstTurnAtMs = ts;
        if (lastTurnAtMs === null || ts > lastTurnAtMs) lastTurnAtMs = ts;
        const hour = new Date(ts).getHours();
        if (Number.isInteger(hour) && hour >= 0 && hour < 24) {
          hourlyCounts[hour] += 1;
        }
      }

      const rawWs = typeof row.workspace_path === 'string' ? row.workspace_path.trim() : '';
      const projName = rawWs ? (rawWs.split('/').filter(Boolean).pop() || rawWs) : '独立对话';
      const projKey = rawWs || '__independent__';
      if (!projectMap.has(projKey)) {
        projectMap.set(projKey, { name: projName, path: rawWs || '未绑定工作区目录', acc: createUsageAccumulator() });
      }
      addTurnToAccumulator(projectMap.get(projKey).acc, row, customRates);

      const mName = typeof row.model === 'string' && row.model.trim() ? row.model.trim() : 'unknown';
      if (!modelCostMap.has(mName)) modelCostMap.set(mName, createUsageAccumulator());
      addTurnToAccumulator(modelCostMap.get(mName), row, customRates);

      if (!agentMap.has(toolKey)) {
        agentMap.set(toolKey, {
          tool: toolKey,
          label: String(TOOL_LABELS[toolKey] || toolKey).toUpperCase(),
          acc: createUsageAccumulator(),
          models: new Map(),
        });
      }
      const ag = agentMap.get(toolKey);
      addTurnToAccumulator(ag.acc, row, customRates);
      if (!ag.models.has(mName)) {
        ag.models.set(mName, { model: mName, label: mName.toUpperCase(), acc: createUsageAccumulator() });
      }
      addTurnToAccumulator(ag.models.get(mName).acc, row, customRates);

      let gKey;
      let gLabel;
      let gSublabel;
      let gTool = toolKey;
      if (normalizedGroup === 'tool') {
        gKey = toolKey;
        gLabel = TOOL_LABELS[toolKey] || toolKey;
        gSublabel = toolKey;
      } else if (normalizedGroup === 'project') {
        gKey = projKey;
        gLabel = projName;
        gSublabel = rawWs || '独立对话';
        gTool = null;
      } else {
        gKey = `${toolKey}\0${mName}`;
        gLabel = mName;
        gSublabel = TOOL_LABELS[toolKey] || toolKey;
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
          .prepare(`SELECT completed_at_ms, total_input_tokens, uncached_input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, thinking_tokens, call_count, tps, model, explicit_cost_usd, tool, host, usage_buckets_json FROM turns WHERE tool = ? AND completed_at_ms >= ? ORDER BY completed_at_ms DESC`)
          .all(tool, since90Ms)
      : this.db
          .prepare(`SELECT completed_at_ms, total_input_tokens, uncached_input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, thinking_tokens, call_count, tps, model, explicit_cost_usd, tool, host, usage_buckets_json FROM turns WHERE completed_at_ms >= ? ORDER BY completed_at_ms DESC`)
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

    // Compute consecutive active streak ending on range.date (querying 365 days ending at range.endMs)
    const [ay, am, ad] = range.date.split('-').map(Number);
    const streakStartMs = new Date(ay, am - 1, ad - 365, 0, 0, 0, 0).getTime();
    const streakRows = tool
      ? this.db
          .prepare(
            `SELECT completed_at_ms, tool FROM turns WHERE tool = ? AND completed_at_ms >= ? AND completed_at_ms < ?`
          )
          .all(tool, streakStartMs, range.endMs)
      : this.db
          .prepare(
            `SELECT completed_at_ms, tool FROM turns WHERE completed_at_ms >= ? AND completed_at_ms < ?`
          )
          .all(streakStartMs, range.endMs);
    const filteredStreakRows =
      !tool && enabledTools ? streakRows.filter((r) => enabledTools[r.tool] !== false) : streakRows;
    const activeDateSet = new Set();
    for (const r of filteredStreakRows) {
      activeDateSet.add(toLocalDateKey(r.completed_at_ms));
    }
    let streakDays = 0;
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
    setBoundedCache(this._receiptCache, cacheKey, receipt);
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
