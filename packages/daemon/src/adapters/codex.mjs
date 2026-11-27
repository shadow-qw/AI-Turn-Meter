import { readdirSync, statSync, watch } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { forEachFileLine } from '../zstd.mjs';
import { accumulateUsageBucket, finalizeUsageBuckets, normalizeServiceTier } from '../pricing.mjs';

const CODEX_OPENAI_MODEL_RE = /^(?:openai\/)?(?:gpt-|o1|o3|o4|codex-|chatgpt-)/i;
const OPEN_TURN_FLUSH_MS = 120_000;
const READ_RETRY_BASE_MS = 30_000;
const READ_RETRY_MAX_MS = 60 * 60_000;
const ROLLOUT_TS_RE = /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/;

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

function codexFileOrderMs(fp, st) {
  const m = basename(fp).match(ROLLOUT_TS_RE);
  if (m) {
    return Date.UTC(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
      Number(m[6])
    );
  }
  const born = Number(st?.birthtimeMs);
  const mtime = Number(st?.mtimeMs) || 0;
  return born > 0 ? Math.min(born, mtime || born) : mtime;
}

/**
 * Stateful line-by-line parser for Codex session rollouts (`.jsonl` and streamed `.jsonl.zst`).
 * Supports cross-file parent/fork replay deduplication via `isForeignCall` and `seenCallKeys`.
 */
export class CodexSessionStreamParser {
  constructor({
    filePath = '',
    flushOpenTurns = false,
    onlyOpenAiModels = true,
    isForeignCall = null,
    seenCallKeys = null,
    droppedTurnUids = null,
    resolveLineageRoot = null,
  } = {}) {
    this.filePath = filePath;
    this.flushOpenTurns = Boolean(flushOpenTurns);
    this.onlyOpenAiModels = Boolean(onlyOpenAiModels);
    this.isForeignCall = isForeignCall;
    this.seenCallKeys = seenCallKeys;
    this.droppedTurnUids = droppedTurnUids;
    this.resolveLineageRoot = resolveLineageRoot;
    this.foreignMemo = new Map();

    this.sessionId = filePath.split('/').pop()?.replace(/\.jsonl(?:\.zst)?$/i, '') || 'codex-session';
    this.hasSessionMetaId = false;
    this.forkedFromId = null;
    this.isForkedRollout = /_[0-9a-f-]{20,}\.jsonl(?:\.zst)?$/i.test(filePath);
    this.inForkReplayPrefix = this.isForkedRollout;
    this.lineageRoot = this.sessionId;
    this.hasKnownParent = false;
    this.sawForeignCall = false;
    this.workspacePath = null;
    this.currentModel = 'unknown';
    this.currentServiceTier = null;

    /** @type {Map<string, any>} */
    this.turns = new Map();
    this.completedTurns = [];
    this.allTurnUids = new Set();

    this.fileLastTotalSig = null;
    this.hasSeenTokenUsageRecord = false;
    this.skippedForkBaseline = false;
    this.countedOwnTokenCount = false;
    this.activeTurnId = null;
  }

  _callIsForeign(key) {
    if (!key || typeof this.isForeignCall !== 'function') return false;
    if (!this.foreignMemo.has(key)) {
      this.foreignMemo.set(key, Boolean(this.isForeignCall(key)));
    }
    return this.foreignMemo.get(key);
  }

  _ensureTurn(turnId, startedAtMs = null) {
    if (!turnId) return null;
    let t = this.turns.get(turnId);
    if (!t) {
      t = {
        turnId,
        model: this.currentModel,
        hasTurnContextModel: false,
        serviceTier: this.currentServiceTier,
        hasTurnContextTier: false,
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
        fallbackCalls: [],
        lastAgentText: null,
        hadForeignCall: false,
        flushed: false,
      };
      this.turns.set(turnId, t);
    }
    if (startedAtMs !== null && t.startedAtMs === null) {
      t.startedAtMs = startedAtMs;
    }
    if (startedAtMs !== null) {
      t.lastEventMs = startedAtMs;
    }
    if (!t.hasTurnContextModel && t.model === 'unknown' && this.currentModel !== 'unknown') {
      t.model = this.currentModel;
    }
    if (!t.hasTurnContextTier && t.serviceTier === null && this.currentServiceTier !== null) {
      t.serviceTier = this.currentServiceTier;
    }
    return t;
  }

  _finalizeTurn(t, { completedAtMs, explicitDurationMs = null, rawTtftMs = null, lastAgentMessage = null } = {}) {
    if (!t || t.flushed) return;
    t.flushed = true;

    const turnUid = `codex:${this.sessionId}:${t.turnId}`;
    const markDropped = () => {
      if (t.hadForeignCall && Array.isArray(this.droppedTurnUids)) {
        this.droppedTurnUids.push(turnUid);
      }
    };

    const effectiveModel = t.model !== 'unknown' ? t.model : this.currentModel;
    if (this.onlyOpenAiModels && !isCodexOpenAiModel(effectiveModel)) {
      markDropped();
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
      if (lastTurnUsage && !t.hadForeignCall) {
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

    if (totalInputTokens <= 0 && outputTokens <= 0) {
      markDropped();
      return;
    }

    const effectiveTier = t.serviceTier ?? this.currentServiceTier;
    const bucketMap = new Map();
    if (t.calls.length > 0) {
      let sumIn = 0;
      let sumCr = 0;
      let sumCw = 0;
      let sumOut = 0;
      let lastBucketCall = null;
      for (const c of t.calls) {
        if (!c.usage) continue;
        const inp = Math.max(0, Number(c.usage.input_tokens) || 0);
        const cr = Math.min(Math.max(0, Number(c.usage.cached_input_tokens) || 0), inp);
        const cw = Math.min(Math.max(0, Number(c.usage.cache_write_input_tokens) || 0), Math.max(0, inp - cr));
        const unc = Math.max(0, inp - cr - cw);
        const out = Math.max(0, Number(c.usage.output_tokens) || 0);
        sumIn += inp;
        sumCr += cr;
        sumCw += cw;
        sumOut += out;
        lastBucketCall = c;
        accumulateUsageBucket(bucketMap, {
          model: c.model && c.model !== 'unknown' ? c.model : effectiveModel,
          serviceTier: c.serviceTier ?? effectiveTier,
          uncachedInput: unc,
          cacheRead: cr,
          cacheWrite5m: cw,
          cacheWrite1h: 0,
          output: out,
        });
      }
      if (totalInputTokens > sumIn || outputTokens > sumOut) {
        const dIn = Math.max(0, totalInputTokens - sumIn);
        const dCr = Math.min(dIn, Math.max(0, cacheReadTokens - sumCr));
        const dCw = Math.min(Math.max(0, dIn - dCr), Math.max(0, cacheWriteTokens - sumCw));
        const dUnc = Math.max(0, dIn - dCr - dCw);
        const dOut = Math.max(0, outputTokens - sumOut);
        accumulateUsageBucket(bucketMap, {
          model: (lastBucketCall?.model && lastBucketCall.model !== 'unknown' ? lastBucketCall.model : null) || effectiveModel,
          serviceTier: lastBucketCall?.serviceTier ?? effectiveTier,
          uncachedInput: dUnc,
          cacheRead: dCr,
          cacheWrite5m: dCw,
          cacheWrite1h: 0,
          output: dOut,
        });
      }
    } else if (t.fallbackCalls.length > 0) {
      for (const fc of t.fallbackCalls) {
        const inp = Math.max(0, fc.input);
        const cr = Math.min(Math.max(0, fc.cached), inp);
        const cw = Math.min(Math.max(0, fc.cacheWrite), Math.max(0, inp - cr));
        const unc = Math.max(0, inp - cr - cw);
        const out = Math.max(0, fc.output);
        accumulateUsageBucket(bucketMap, {
          model: fc.model && fc.model !== 'unknown' ? fc.model : effectiveModel,
          serviceTier: fc.serviceTier ?? effectiveTier,
          uncachedInput: unc,
          cacheRead: cr,
          cacheWrite5m: cw,
          cacheWrite1h: 0,
          output: out,
        });
      }
    }
    const usageBuckets = finalizeUsageBuckets(bucketMap);

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

    this.allTurnUids.add(turnUid);
    this.completedTurns.push({
      turnUid,
      tool: 'codex',
      host: 'codex-desktop',
      sessionId: this.sessionId,
      turnId: t.turnId,
      model: effectiveModel,
      workspacePath: this.workspacePath,
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
      serviceTier: effectiveTier,
      usageBuckets,
      replyPreview:
        typeof lastAgentMessage === 'string' && lastAgentMessage.trim()
          ? lastAgentMessage
          : t.lastAgentText || null,
    });
  }

  _switchActiveTurn(newTurnId, tsMs) {
    if (this.activeTurnId && newTurnId && this.activeTurnId !== newTurnId) {
      const prev = this.turns.get(this.activeTurnId);
      if (prev && !prev.flushed) {
        this._finalizeTurn(prev, { completedAtMs: prev.lastEventMs ?? tsMs });
      }
    }
    if (newTurnId) this.activeTurnId = newTurnId;
  }

  _canEmitTurn(t) {
    if (!t || t.flushed) return false;
    const effectiveModel = t.model !== 'unknown' ? t.model : this.currentModel;
    if (this.onlyOpenAiModels && !isCodexOpenAiModel(effectiveModel)) {
      return false;
    }
    if (t.calls.length > 0) {
      const lastTurnUsage = [...t.calls].reverse().find((c) => c.turnUsage)?.turnUsage;
      if (lastTurnUsage && !t.hadForeignCall) {
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

  feedLine(line) {
    if (!line || !line.trim()) return;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }
    if (!obj || typeof obj !== 'object') return;

    const tsMs = parseIsoMs(obj.timestamp);
    const topType = obj.type;
    const p = obj.payload;
    if (!p || typeof p !== 'object') return;

    if (topType === 'session_meta') {
      const metaId =
        typeof p.id === 'string' && p.id
          ? p.id
          : typeof p.session_id === 'string' && p.session_id
            ? p.session_id
            : null;
      // Subagent rollouts copy their parent's session_meta into the inherited history right after
      // their own. Only the file's first session_meta describes this rollout; a later meta with a
      // different id belongs to an ancestor and must not rename the session, its fork parent, or cwd.
      if (this.hasSessionMetaId && metaId && metaId !== this.sessionId) {
        return;
      }
      if (metaId) {
        this.sessionId = metaId;
        this.hasSessionMetaId = true;
      }
      const rawForkParent =
        (typeof p.forked_from_id === 'string' && p.forked_from_id.trim()) ||
        (typeof p.source?.subagent?.thread_spawn?.parent_thread_id === 'string' &&
          p.source.subagent.thread_spawn.parent_thread_id.trim()) ||
        null;
      if (rawForkParent) {
        this.forkedFromId = rawForkParent;
      }
      if (rawForkParent || p.history_base || p.subagent_history_start_ordinal) {
        this.isForkedRollout = true;
        this.inForkReplayPrefix = true;
      }
      if (typeof this.resolveLineageRoot === 'function') {
        const info = this.resolveLineageRoot(this.sessionId, this.forkedFromId);
        this.lineageRoot = info?.rootId || this.sessionId;
        this.hasKnownParent = Boolean(info?.hasKnownParent);
      } else {
        this.lineageRoot = this.forkedFromId || this.sessionId;
        this.hasKnownParent = false;
      }
      if (typeof p.cwd === 'string' && p.cwd) this.workspacePath = p.cwd;
      return;
    }

    if (topType === 'turn_context') {
      if (typeof p.model === 'string' && p.model) this.currentModel = p.model;
      if (typeof p.service_tier === 'string') this.currentServiceTier = normalizeServiceTier(p.service_tier);
      if (typeof p.cwd === 'string' && p.cwd && !this.workspacePath) this.workspacePath = p.cwd;
      if (typeof p.turn_id === 'string' && p.turn_id) {
        this._switchActiveTurn(p.turn_id, tsMs);
        const t = this._ensureTurn(this.activeTurnId, tsMs);
        if (t && typeof p.model === 'string' && p.model) {
          t.model = p.model;
          t.hasTurnContextModel = true;
        }
        if (t && typeof p.service_tier === 'string') {
          t.serviceTier = normalizeServiceTier(p.service_tier);
          t.hasTurnContextTier = true;
        }
      }
      return;
    }

    if (topType === 'token_usage_record') {
      this.hasSeenTokenUsageRecord = true;
      const turnId = p.turn_id || this.activeTurnId;
      const t = this._ensureTurn(turnId, tsMs);
      if (!t) return;
      if (!this.hasSessionMetaId && typeof p.session_id === 'string' && p.session_id) {
        this.sessionId = p.session_id;
      }

      const respId = typeof p.response_id === 'string' ? p.response_id : null;
      const respKey = respId ? `codex:resp:${this.lineageRoot || this.sessionId}:${respId}` : null;
      if (respKey) {
        this.seenCallKeys?.add(respKey);
        if (this.isForkedRollout && this.inForkReplayPrefix && this._callIsForeign(respKey)) {
          t.hadForeignCall = true;
          this.sawForeignCall = true;
          return;
        }
      }
      this.inForkReplayPrefix = false;

      // Flush any completed tool execution window before this API call finished
      if (t.lastCallEndMs !== null && t.lastToolEndMs !== null && t.lastToolEndMs > t.lastCallEndMs) {
        t.toolWaitMs += t.lastToolEndMs - t.lastCallEndMs;
      }
      t.lastToolEndMs = null;
      if (tsMs !== null) {
        t.lastCallEndMs = tsMs;
        t.lastEventMs = tsMs;
      }

      if (!respId || !t.seenResponseIds.has(respId)) {
        if (respId) t.seenResponseIds.add(respId);
        t.calls.push({
          model: t.model !== 'unknown' ? t.model : this.currentModel,
          serviceTier: t.serviceTier ?? this.currentServiceTier,
          usage: p.usage || null,
          turnUsage: p.turn_token_usage || null,
          tsMs,
        });
      }
      return;
    }

    if (topType === 'response_item') {
      const t = this._ensureTurn(this.activeTurnId, tsMs);
      if (t && tsMs !== null) {
        t.lastEventMs = tsMs;
        if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
          t.lastToolEndMs = tsMs;
        }
      }
      return;
    }

    if (topType !== 'event_msg') return;
    const pt = p.type;

    if (pt === 'thread_settings_applied') {
      const m = p.thread_settings?.model;
      if (typeof m === 'string' && m) {
        this.currentModel = m;
        // Only backfill if current active turn had no turn_context model yet
        const activeTurn = this.activeTurnId ? this.turns.get(this.activeTurnId) : null;
        if (activeTurn && !activeTurn.hasTurnContextModel && activeTurn.model === 'unknown') {
          activeTurn.model = m;
        }
      }
      const st = p.thread_settings?.service_tier;
      if (typeof st === 'string') {
        this.currentServiceTier = normalizeServiceTier(st);
        const activeTurn = this.activeTurnId ? this.turns.get(this.activeTurnId) : null;
        if (
          activeTurn &&
          !activeTurn.hasTurnContextTier &&
          activeTurn.calls.length === 0 &&
          activeTurn.fallbackTurnUsage.calls === 0
        ) {
          activeTurn.serviceTier = this.currentServiceTier;
        }
      }
      const cwd = p.thread_settings?.cwd;
      if (typeof cwd === 'string' && cwd && !this.workspacePath) this.workspacePath = cwd;
      return;
    }

    if (pt === 'task_started') {
      this._switchActiveTurn(p.turn_id, tsMs);
      const startedMs =
        tsMs ?? (typeof p.started_at === 'number' ? p.started_at * 1000 : null);
      this._ensureTurn(this.activeTurnId, startedMs);
      return;
    }

    if (pt === 'token_count') {
      const t = this._ensureTurn(this.activeTurnId, tsMs);
      const last = p.info?.last_token_usage;
      const total = p.info?.total_token_usage;
      if (t && last && typeof last === 'object') {
        const sig = JSON.stringify(total || last);
        if (this.fileLastTotalSig !== sig) {
          this.fileLastTotalSig = sig;
          const totalIn = Number(total?.input_tokens) || 0;
          const totalCached = Number(total?.cached_input_tokens) || 0;
          const totalOut = Number(total?.output_tokens) || 0;
          const totalReasoning = Number(total?.reasoning_output_tokens) || 0;

          const lastIn = Number(last.input_tokens) || 0;
          const cachedIn = Number(last.cached_input_tokens) || 0;
          const cacheWriteIn = Number(last.cache_write_input_tokens) || 0;
          const outTok = Number(last.output_tokens) || 0;

          if (lastIn === 0 && outTok === 0 && cachedIn === 0 && cacheWriteIn === 0) {
            return;
          }

          const tcKey =
            total && typeof total === 'object'
              ? `codex:tc:${this.lineageRoot || this.sessionId}:${totalIn}:${totalCached}:${totalOut}:${totalReasoning}:${lastIn}:${outTok}`
              : null;
          if (tcKey) this.seenCallKeys?.add(tcKey);

          if (this.isForkedRollout && this.inForkReplayPrefix && tcKey && this._callIsForeign(tcKey)) {
            t.hadForeignCall = true;
            this.sawForeignCall = true;
            return;
          }

          // Single-file fallback when parent rollout is absent: the file's first token_count, before
          // this rollout has counted any call of its own, reflects the inherited parent baseline. Once a
          // call was counted, a later turn's first token_count is real usage, not a baseline.
          if (
            this.isForkedRollout &&
            !this.hasSeenTokenUsageRecord &&
            !this.skippedForkBaseline &&
            !this.sawForeignCall &&
            !this.hasKnownParent &&
            !this.countedOwnTokenCount &&
            t.fallbackTurnUsage.calls === 0 &&
            t.calls.length === 0 &&
            totalIn > lastIn
          ) {
            this.skippedForkBaseline = true;
          } else {
            this.countedOwnTokenCount = true;
            this.inForkReplayPrefix = false;
            t.fallbackTurnUsage.input += lastIn;
            t.fallbackTurnUsage.cached += cachedIn;
            t.fallbackTurnUsage.cacheWrite += cacheWriteIn;
            t.fallbackTurnUsage.output += outTok;
            t.fallbackTurnUsage.thinking += Number(last.reasoning_output_tokens) || 0;
            t.fallbackTurnUsage.calls += 1;
            t.fallbackCalls.push({
              model: t.model !== 'unknown' ? t.model : this.currentModel,
              serviceTier: t.serviceTier ?? this.currentServiceTier,
              input: lastIn,
              cached: cachedIn,
              cacheWrite: cacheWriteIn,
              output: outTok,
            });
          }
        }
      }
      return;
    }

    if (pt === 'item_completed') {
      const turnId = p.turn_id || this.activeTurnId;
      const t = this._ensureTurn(turnId, tsMs);
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
      return;
    }

    if (pt === 'task_complete') {
      const turnId = p.turn_id || this.activeTurnId;
      const t = this._ensureTurn(turnId, tsMs);
      if (!t) return;

      const completedAtMs =
        tsMs ??
        (typeof p.completed_at === 'number' ? p.completed_at * 1000 : Date.now());
      const explicitDurationMs =
        typeof p.duration_ms === 'number' && p.duration_ms >= 0 ? p.duration_ms : null;
      const rawTtftMs =
        typeof p.time_to_first_token_ms === 'number' && p.time_to_first_token_ms >= 0
          ? p.time_to_first_token_ms
          : null;

      this._finalizeTurn(t, {
        completedAtMs,
        explicitDurationMs,
        rawTtftMs,
        lastAgentMessage: p.last_agent_message,
      });

      if (this.activeTurnId === turnId) this.activeTurnId = null;
    }
  }

  finish() {
    let hasOpenTurns = false;
    if (this.flushOpenTurns) {
      for (const t of this.turns.values()) {
        if (!t.flushed) {
          this._finalizeTurn(t, { completedAtMs: t.lastEventMs });
        }
      }
    } else {
      for (const t of this.turns.values()) {
        if (this._canEmitTurn(t)) {
          hasOpenTurns = true;
          break;
        }
      }
    }
    return {
      turns: this.completedTurns,
      hasOpenTurns,
      sessionId: this.sessionId,
      forkedFromId: this.forkedFromId,
      allTurnUids: this.allTurnUids,
    };
  }
}

/**
 * Parse a Codex session rollout JSONL string into completed TurnRecord inputs plus open-turn status.
 * @param {string} content
 * @param {string} filePath
 * @param {object} [opts]
 * @returns {{ turns: Array<object>, hasOpenTurns: boolean }}
 */
export function parseCodexSessionDetailed(content, filePath = '', opts = {}) {
  const parser = new CodexSessionStreamParser({ ...opts, filePath });
  for (const line of String(content || '').split(/\r?\n/)) {
    parser.feedLine(line);
  }
  const res = parser.finish();
  return { turns: res.turns, hasOpenTurns: res.hasOpenTurns };
}

/**
 * Parse a Codex session rollout JSONL string into completed TurnRecord inputs.
 * @param {string} content
 * @param {string} filePath
 * @param {object} [opts]
 */
export function parseCodexSessionContent(content, filePath = '', opts = {}) {
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
    this.pending = null;
    this._scanning = false;
    this._stopped = false;
    /** fp -> { mtimeMs, sizeBytes, attempts, retryAtMs } for rollouts that could not be read. */
    this.readFailures = new Map();
  }

  async scan({ maxRecentFiles = 30, nowMs = Date.now() } = {}) {
    if (this.isEnabled && !this.isEnabled()) return [];
    if (this._scanning) return [];
    this._scanning = true;
    try {
      const resetPending = Boolean(this.store.getCodexIngestResetPending?.());
      const effectiveMaxFiles = resetPending ? Infinity : maxRecentFiles;
      if (resetPending) {
        this.fileMtimes.clear();
      }

      const collectLimit = Number.isFinite(effectiveMaxFiles) ? Math.max(effectiveMaxFiles * 3, 90) : Infinity;
      const rawPaths = [];
      collectJsonlFiles(this.sessionsDir, rawPaths, collectLimit);
      if (this.archivedDir) {
        collectJsonlFiles(this.archivedDir, rawPaths, collectLimit);
      }

      let files = rawPaths
        .map((fp) => {
          try {
            const st = statSync(fp);
            return { fp, mtimeMs: st.mtimeMs, sizeBytes: st.size, orderMs: codexFileOrderMs(fp, st) };
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      if (Number.isFinite(effectiveMaxFiles)) {
        const top = files.slice(0, effectiveMaxFiles);
        const topSet = new Set(top.map((f) => f.fp));
        // Unreadable rollouts outside the recent window are retried once their backoff expires.
        for (const [fp, failure] of this.readFailures) {
          if (topSet.has(fp) || failure.retryAtMs > nowMs) continue;
          try {
            const st = statSync(fp);
            top.push({ fp, mtimeMs: st.mtimeMs, sizeBytes: st.size, orderMs: codexFileOrderMs(fp, st) });
            topSet.add(fp);
          } catch {
            this.readFailures.delete(fp);
          }
        }
        if (this.pendingOpenFiles.size > 0) {
          for (const item of files.slice(effectiveMaxFiles)) {
            if (this.pendingOpenFiles.has(item.fp) && !topSet.has(item.fp)) {
              top.push(item);
              topSet.add(item.fp);
            }
          }
          for (const fp of [...this.pendingOpenFiles.keys()]) {
            if (topSet.has(fp)) continue;
            try {
              const st = statSync(fp);
              top.push({ fp, mtimeMs: st.mtimeMs, sizeBytes: st.size, orderMs: codexFileOrderMs(fp, st) });
              topSet.add(fp);
            } catch {
              this.pendingOpenFiles.delete(fp);
            }
          }
        }
        files = top;
      }

      // Oldest-created first so parent rollouts claim replayed calls before forked children scan.
      files.sort((a, b) => a.orderMs - b.orderMs || a.mtimeMs - b.mtimeMs || (a.fp < b.fp ? -1 : a.fp > b.fp ? 1 : 0));

      const changed = [];
      const newReadFailures = [];
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

        const failure = this.readFailures.get(fp);
        if (failure) {
          if (failure.mtimeMs !== mtimeMs || failure.sizeBytes !== sizeBytes) {
            this.readFailures.delete(fp);
          } else if (nowMs < failure.retryAtMs) {
            continue;
          }
        }

        const isForeignCall = this.store.isCodexCallOwnedByOtherFile
          ? (key) => this.store.isCodexCallOwnedByOtherFile(key, fp)
          : this.store.isCallOwnedByOtherFile
            ? (key) => this.store.isCallOwnedByOtherFile(key, fp)
            : null;
        const resolveLineageRoot = this.store.resolveCodexLineageRoot
          ? (sid, pid) => this.store.resolveCodexLineageRoot(sid, pid)
          : null;
        const seenCallKeys = new Set();
        const droppedTurnUids = [];
        const parser = new CodexSessionStreamParser({
          filePath: fp,
          flushOpenTurns,
          onlyOpenAiModels: true,
          isForeignCall,
          seenCallKeys,
          droppedTurnUids,
          resolveLineageRoot,
        });

        let readError = null;
        const ok = await forEachFileLine(fp, (line) => parser.feedLine(line), {
          warn: (msg) => {
            readError = msg;
          },
        });
        if (!ok) {
          const prev = this.readFailures.get(fp);
          const attempts = prev && prev.mtimeMs === mtimeMs && prev.sizeBytes === sizeBytes ? prev.attempts + 1 : 1;
          const delayMs = Math.min(READ_RETRY_BASE_MS * 2 ** (attempts - 1), READ_RETRY_MAX_MS);
          this.readFailures.set(fp, { mtimeMs, sizeBytes, attempts, retryAtMs: Date.now() + delayMs });
          if (attempts === 1) newReadFailures.push(readError || fp);
          continue;
        }
        this.readFailures.delete(fp);

        const { turns, hasOpenTurns, sessionId, forkedFromId, allTurnUids } = parser.finish();
        if (forkedFromId) {
          this.store.setCodexParent?.(sessionId, forkedFromId);
        }
        if (this.store.claimCodexCallKeys) {
          this.store.claimCodexCallKeys(fp, seenCallKeys);
        } else {
          this.store.claimCallKeys?.(fp, seenCallKeys);
        }
        for (const t of turns) {
          const res = this.store.upsertTurn(t);
          if (res.changed) changed.push(res.record);
        }
        this.store.deleteTurns?.(droppedTurnUids);
        this.store.syncFileTurns?.(fp, Array.from(allTurnUids));

        if (hasOpenTurns && !flushOpenTurns) {
          this.fileMtimes.delete(fp);
          this.pendingOpenFiles.set(fp, { mtimeMs, sizeBytes });
        } else {
          this.pendingOpenFiles.delete(fp);
          this.fileMtimes.set(fp, { mtimeMs, sizeBytes });
          this.store.setIngestedFile?.(fp, mtimeMs, sizeBytes);
        }
      }

      if (newReadFailures.length > 0) {
        console.warn(
          `[ai-turn-meter] codex: ${newReadFailures.length} rollout file(s) could not be read; retrying with backoff. First: ${newReadFailures[0]}`
        );
      }

      // Unreadable files are retried on their own backoff, so they do not hold the reset open (which
      // would force a full rescan every poll). They are re-parsed under the new rules once readable.
      if (resetPending && !Number.isFinite(effectiveMaxFiles)) {
        this.store.purgeLegacyDuplicateCodexTurns?.();
        this.store.completeCodexIngestReset?.();
      }

      if (changed.length > 0 && this.onTurns) {
        this.onTurns(changed);
      }
      return changed;
    } finally {
      this._scanning = false;
    }
  }

  start() {
    this._stopped = false;
    const resetPending = Boolean(this.store.getCodexIngestResetPending?.());
    if (resetPending) {
      this.backfillTimer = setTimeout(() => {
        this.backfillTimer = null;
        if (this._stopped) return;
        this.scan({ maxRecentFiles: Infinity }).catch(() => {});
      }, 50);
      this.backfillTimer.unref?.();
    } else {
      this.scan({ maxRecentFiles: 24 }).catch(() => {});
      const runBackfill = () => {
        this.backfillTimer = null;
        if (this._stopped) return;
        if (this._scanning) {
          this.backfillTimer = setTimeout(runBackfill, 300);
          this.backfillTimer.unref?.();
          return;
        }
        this.scan({ maxRecentFiles: Infinity }).catch(() => {});
      };
      this.backfillTimer = setTimeout(runBackfill, 150);
      this.backfillTimer.unref?.();
    }
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
    this.timer = setInterval(() => {
      if (!this._stopped) this.scan({ maxRecentFiles: 12 }).catch(() => {});
    }, 2000);
    this.timer.unref?.();
  }

  scheduleScan() {
    if (this._stopped || this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      if (this._stopped) return;
      if (this._scanning) {
        this.scheduleScan();
        return;
      }
      this.scan({ maxRecentFiles: 12 }).catch(() => {});
    }, 150);
    this.pending.unref?.();
  }

  stop() {
    this._stopped = true;
    for (const w of this.watchers) w.close();
    this.watchers = [];
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.backfillTimer) {
      clearTimeout(this.backfillTimer);
      this.backfillTimer = null;
    }
    if (this.pending) {
      clearTimeout(this.pending);
      this.pending = null;
    }
  }
}
