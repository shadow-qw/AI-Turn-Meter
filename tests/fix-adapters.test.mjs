import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as zlib from 'node:zlib';

const zstdCompressSync = typeof zlib.zstdCompressSync === 'function' ? zlib.zstdCompressSync : null;

import { TurnStore } from '../packages/daemon/src/store.mjs';
import { normalizeTurn } from '../packages/daemon/src/format.mjs';
import { estimateTurnCost } from '../packages/daemon/src/pricing.mjs';
import { forEachZstdLine } from '../packages/daemon/src/zstd.mjs';
import { parseClaudeCodeSessionContent } from '../packages/daemon/src/adapters/claude-code.mjs';
import {
  AntigravityAdapter,
  decodeAntigravityGenMetadataRow,
  loadAntigravityConversationSpeedIndex,
  parseAntigravityTranscriptContent,
  parseAntigravityTranscriptDetailed,
} from '../packages/daemon/src/adapters/antigravity.mjs';
import {
  CodexAdapter,
  parseCodexSessionDetailed,
} from '../packages/daemon/src/adapters/codex.mjs';
import {
  CodeBuddyAdapter,
  parseCodeBuddyCliContent,
  parseCodeBuddyIdeSessionDir,
  workspaceMd5,
} from '../packages/daemon/src/adapters/codebuddy.mjs';
import { processCursorHookPayload } from '../packages/daemon/src/adapters/cursor.mjs';

test('Antigravity disambiguates duplicate step_index turnUids on retried/edited prompts without overwriting or phantom changes', async () => {
  const transcript = [
    JSON.stringify({ step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-23T01:00:00Z' }),
    JSON.stringify({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-23T01:00:02Z',
      model: 'gemini-4-neon',
      input_tokens: 1000,
      cache_read_tokens: 0,
      output_tokens: 100,
      tool_calls: [],
    }),
    // Empty aborted prompt reusing step_index 129 should not create an orphan -r2
    JSON.stringify({ step_index: 129, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-23T01:01:00Z' }),
    // First emitted attempt at step_index 129
    JSON.stringify({ step_index: 129, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-23T01:01:05Z' }),
    JSON.stringify({
      step_index: 130,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-23T01:01:08Z',
      model: 'gemini-4-neon',
      input_tokens: 2000,
      cache_read_tokens: 1000,
      output_tokens: 250,
      tool_calls: [],
    }),
    // Second emitted attempt (retried/edited) reusing step_index 129
    JSON.stringify({ step_index: 129, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-23T01:02:00Z' }),
    JSON.stringify({
      step_index: 130,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-23T01:02:04Z',
      model: 'gemini-4-neon',
      input_tokens: 3000,
      cache_read_tokens: 2000,
      output_tokens: 400,
      tool_calls: [],
    }),
    // Third emitted attempt reusing step_index 129
    JSON.stringify({ step_index: 129, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-23T01:03:00Z' }),
    JSON.stringify({
      step_index: 130,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-23T01:03:03Z',
      model: 'gemini-4-neon',
      input_tokens: 4000,
      cache_read_tokens: 3000,
      output_tokens: 350,
      tool_calls: [],
    }),
  ].join('\n');

  const turns = parseAntigravityTranscriptContent(transcript, { sessionId: 'sess-retry' });
  assert.equal(turns.length, 4);
  assert.deepEqual(
    turns.map((t) => t.turnId),
    ['turn-0', 'turn-129', 'turn-129-r2', 'turn-129-r3']
  );
  assert.deepEqual(
    turns.map((t) => t.turnUid),
    [
      'antigravity:sess-retry:turn-0',
      'antigravity:sess-retry:turn-129',
      'antigravity:sess-retry:turn-129-r2',
      'antigravity:sess-retry:turn-129-r3',
    ]
  );
  assert.deepEqual(
    turns.map((t) => t.outputTokens),
    [100, 250, 400, 350]
  );

  // Verify persistence in TurnStore: all 4 turns saved, no phantom changes on forced re-upsert
  const tmpGem = mkdtempSync(join(tmpdir(), 'ag-retry-'));
  const store = new TurnStore(':memory:');
  try {
    const logsDir = join(tmpGem, 'antigravity', 'brain', 'sess-retry', '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });
    const fp = join(logsDir, 'transcript.jsonl');
    writeFileSync(fp, transcript);

    const adapter = new AntigravityAdapter({ store, geminiRoot: tmpGem, enableRpc: false });
    const first = await adapter.scan();
    assert.equal(first.length, 4);
    assert.equal(store.getRecentTurns(10, 'antigravity').length, 4);

    // Force a fresh adapter rescan (ignoring fileMtimes & ingested_files) -> 0 phantom changes
    const storeTurnsBefore = store.getRecentTurns(10, 'antigravity');
    let phantomChanges = 0;
    for (const t of turns) {
      if (store.upsertTurn(t).changed) phantomChanges += 1;
    }
    assert.equal(phantomChanges, 0);
    assert.equal(store.getRecentTurns(10, 'antigravity').length, storeTurnsBefore.length);
  } finally {
    store.close();
    rmSync(tmpGem, { recursive: true, force: true });
  }
});

test('Antigravity flushes tool-ending/cancelled/subagent open turns after 120s and defers ingested_files caching', async () => {
  // Subagent transcript starting without USER_INPUT and ending on GENERIC tool output
  const subagentTranscript = [
    JSON.stringify({
      step_index: 0,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-23T02:00:00Z',
      model: 'gemini-4-neon-high',
      input_tokens: 12000,
      cache_read_tokens: 8000,
      output_tokens: 500,
      tool_calls: [{ name: 'post_message' }, { name: 'swarm_wait' }],
    }),
    JSON.stringify({
      step_index: 1,
      type: 'GENERIC',
      status: 'DONE',
      created_at: '2026-11-23T02:00:05Z',
    }),
  ].join('\n');

  const closedOnly = parseAntigravityTranscriptDetailed(subagentTranscript, {
    sessionId: 'sub-1',
    flushOpenTurns: false,
  });
  assert.equal(closedOnly.turns.length, 0);
  assert.equal(closedOnly.hasOpenTurns, true);

  const flushed = parseAntigravityTranscriptDetailed(subagentTranscript, {
    sessionId: 'sub-1',
    flushOpenTurns: true,
  });
  assert.equal(flushed.turns.length, 1);
  assert.equal(flushed.hasOpenTurns, false);
  assert.equal(flushed.turns[0].turnUid, 'antigravity:sub-1:turn-0');
  assert.equal(flushed.turns[0].totalInputTokens, 20000);
  assert.equal(flushed.turns[0].outputTokens, 500);
  assert.equal(flushed.turns[0].model, 'gemini-4-neon-high');

  // Cancelled turn (status !== DONE) is also recovered on flushOpenTurns
  const cancelledTranscript = [
    JSON.stringify({ step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-23T02:10:00Z' }),
    JSON.stringify({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'CANCELLED',
      created_at: '2026-11-23T02:10:04Z',
      model: 'gemini-4-neon',
      input_tokens: 3000,
      cache_read_tokens: 1000,
      output_tokens: 120,
      tool_calls: [],
    }),
  ].join('\n');
  assert.equal(
    parseAntigravityTranscriptContent(cancelledTranscript, { sessionId: 'c1', flushOpenTurns: false }).length,
    0
  );
  const cancelledFlushed = parseAntigravityTranscriptContent(cancelledTranscript, {
    sessionId: 'c1',
    flushOpenTurns: true,
  });
  assert.equal(cancelledFlushed.length, 1);
  assert.equal(cancelledFlushed[0].outputTokens, 120);

  // End-to-end adapter lifecycle: <120s defers ingested_files & throttles; >120s flushes & caches
  const tmpGem = mkdtempSync(join(tmpdir(), 'ag-flush-'));
  const store = new TurnStore(':memory:');
  try {
    const logsDir = join(tmpGem, 'antigravity', 'brain', 'sub-1', '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });
    const fp = join(logsDir, 'transcript.jsonl');
    writeFileSync(fp, subagentTranscript);
    const mtimeMs = statSync(fp).mtimeMs;

    let rpcChecks = 0;
    const adapter = new AntigravityAdapter({
      store,
      geminiRoot: tmpGem,
      enableRpc: true,
      discoverServers: async () => {
        rpcChecks += 1;
        return null;
      },
    });

    // 1. Scan at +10s: open turn not flushed, NOT persisted to ingested_files
    const scan1 = await adapter.scan({ nowMs: mtimeMs + 10_000 });
    assert.equal(scan1.length, 0);
    assert.equal(store.getIngestedFile(fp), null);
    assert.equal(adapter.pendingOpenFiles.has(fp), true);
    assert.equal(rpcChecks, 1);

    // 2. Scan at +40s (still < 120s, file unchanged): throttled (no dirty files, no extra RPC)
    const scan2 = await adapter.scan({ nowMs: mtimeMs + 40_000 });
    assert.equal(scan2.length, 0);
    assert.equal(store.getIngestedFile(fp), null);
    assert.equal(rpcChecks, 1);

    // 3. Simulate daemon restart before 120s: a brand-new adapter sees ingested_files is null and flushes at +125s
    const restartedAdapter = new AntigravityAdapter({ store, geminiRoot: tmpGem, enableRpc: false });
    const scanAfterRestart = await restartedAdapter.scan({ nowMs: mtimeMs + 125_000 });
    assert.equal(scanAfterRestart.length, 1);
    assert.equal(scanAfterRestart[0].turnUid, 'antigravity:sub-1:turn-0');
    assert.ok(store.getIngestedFile(fp), 'ingested_files should be persisted after flush');

    // 4. Original adapter also flushes cleanly on its own store once >120s (test non-restarted path on fresh store)
    const store2 = new TurnStore(':memory:');
    try {
      const adapter2 = new AntigravityAdapter({ store: store2, geminiRoot: tmpGem, enableRpc: false });
      assert.equal((await adapter2.scan({ maxRecentFiles: 1, nowMs: mtimeMs + 5_000 })).length, 0);
      assert.equal(adapter2.pendingOpenFiles.has(fp), true);

      // Create 2 newer transcripts to push sub-1 past maxRecentFiles: 1
      for (const extraId of ['newer-a', 'newer-b']) {
        const d = join(tmpGem, 'antigravity', 'brain', extraId, '.system_generated', 'logs');
        mkdirSync(d, { recursive: true });
        const efp = join(d, 'transcript.jsonl');
        writeFileSync(efp, cancelledTranscript);
        const futureSec = (mtimeMs + 10_000) / 1000;
        utimesSync(efp, futureSec, futureSec);
      }

      const scan3 = await adapter2.scan({ maxRecentFiles: 1, nowMs: mtimeMs + 125_000 });
      assert.ok(
        scan3.some((r) => r.turnUid === 'antigravity:sub-1:turn-0'),
        'pending open file should still flush even if newer files pushed it past maxRecentFiles'
      );
      assert.equal(adapter2.pendingOpenFiles.has(fp), false);
      assert.ok(store2.getIngestedFile(fp));
    } finally {
      store2.close();
    }
  } finally {
    store.close();
    rmSync(tmpGem, { recursive: true, force: true });
  }
});

test('AntigravityAdapter.scan() guards concurrent invocations with _scanning lock and getServers() caches null for 15s', async () => {
  const tmpGem = mkdtempSync(join(tmpdir(), 'ag-lock-'));
  const store = new TurnStore(':memory:');
  try {
    const logsDir = join(tmpGem, 'antigravity', 'brain', 'sess-lock', '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });
    const fp = join(logsDir, 'transcript.jsonl');
    writeFileSync(
      fp,
      [
        JSON.stringify({ step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-23T03:00:00Z' }),
        JSON.stringify({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-11-23T03:00:02Z',
          model: 'gemini-4-neon',
          input_tokens: 500,
          cache_read_tokens: 500,
          output_tokens: 100,
          tool_calls: [],
        }),
      ].join('\n')
    );

    let releaseRpc;
    let discoverCalls = 0;
    const adapter = new AntigravityAdapter({
      store,
      geminiRoot: tmpGem,
      enableRpc: true,
      discoverServers: async () => {
        discoverCalls += 1;
        await new Promise((resolve) => {
          releaseRpc = resolve;
        });
        return null;
      },
    });

    const p1 = adapter.scan();
    // Wait a tick so p1 reaches await discoverServers()
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(adapter._scanning, true);

    // Concurrent calls must immediately return [] without overlapping
    const r2 = await adapter.scan();
    const r3 = await adapter.scan();
    assert.deepEqual(r2, []);
    assert.deepEqual(r3, []);
    assert.equal(discoverCalls, 1);

    releaseRpc();
    const r1 = await p1;
    assert.equal(adapter._scanning, false);
    assert.equal(r1.length, 1);
    assert.equal(discoverCalls, 1);

    // Verify _scanning resets even when discoverServers throws
    const errAdapter = new AntigravityAdapter({
      store,
      geminiRoot: tmpGem,
      enableRpc: true,
      discoverServers: async () => {
        throw new Error('boom');
      },
    });
    // Force a new dirty file
    const logsDir2 = join(tmpGem, 'antigravity', 'brain', 'sess-err', '.system_generated', 'logs');
    mkdirSync(logsDir2, { recursive: true });
    writeFileSync(
      join(logsDir2, 'transcript.jsonl'),
      JSON.stringify({ step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-23T03:00:00Z' })
    );
    await assert.rejects(() => errAdapter.scan(), /boom/);
    assert.equal(errAdapter._scanning, false);

    // Verify getServers() caches null results for 15s
    let nullDiscoverCalls = 0;
    const cacheAdapter = new AntigravityAdapter({
      store,
      geminiRoot: tmpGem,
      enableRpc: true,
      discoverServers: async () => {
        nullDiscoverCalls += 1;
        return null;
      },
    });
    const t0 = 1_700_000_000_000;
    assert.equal(await cacheAdapter.getServers(t0), null);
    assert.equal(nullDiscoverCalls, 1);
    assert.equal(await cacheAdapter.getServers(t0 + 5_000), null);
    assert.equal(nullDiscoverCalls, 1);
    assert.equal(await cacheAdapter.getServers(t0 + 14_999), null);
    assert.equal(nullDiscoverCalls, 1);
    assert.equal(await cacheAdapter.getServers(t0 + 15_000), null);
    assert.equal(nullDiscoverCalls, 2);
  } finally {
    store.close();
    rmSync(tmpGem, { recursive: true, force: true });
  }
});

test('CodexAdapter defers ingested_files caching for open turns so >120s flushOpenTurns actually fires', async () => {
  const openTurnJsonl = [
    JSON.stringify({
      timestamp: '2026-11-23T04:00:00.000Z',
      type: 'session_meta',
      payload: { id: 'codex-open-1', cwd: '/tmp/proj' },
    }),
    JSON.stringify({
      timestamp: '2026-11-23T04:00:00.100Z',
      type: 'turn_context',
      payload: { turn_id: 'turn-open', model: 'gpt-5.4', cwd: '/tmp/proj' },
    }),
    JSON.stringify({
      timestamp: '2026-11-23T04:00:00.100Z',
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-open' },
    }),
    JSON.stringify({
      timestamp: '2026-11-23T04:00:03.100Z',
      type: 'token_usage_record',
      payload: {
        turn_id: 'turn-open',
        response_id: 'resp-1',
        usage: { input_tokens: 4000, cached_input_tokens: 2000, output_tokens: 300, reasoning_output_tokens: 50 },
        turn_token_usage: { input_tokens: 4000, cached_input_tokens: 2000, output_tokens: 300, reasoning_output_tokens: 50 },
      },
    }),
  ].join('\n');

  const dClosed = parseCodexSessionDetailed(openTurnJsonl, 'rollout.jsonl', { flushOpenTurns: false });
  assert.equal(dClosed.turns.length, 0);
  assert.equal(dClosed.hasOpenTurns, true);

  const dFlushed = parseCodexSessionDetailed(openTurnJsonl, 'rollout.jsonl', { flushOpenTurns: true });
  assert.equal(dFlushed.turns.length, 1);
  assert.equal(dFlushed.hasOpenTurns, false);

  const tmpRoot = mkdtempSync(join(tmpdir(), 'codex-open-'));
  const sessionsDir = join(tmpRoot, 'sessions', '2026', '11', '23');
  const archivedDir = join(tmpRoot, 'archived_sessions');
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(archivedDir, { recursive: true });
  const store = new TurnStore(':memory:');
  try {
    const fp = join(sessionsDir, 'rollout-open.jsonl');
    writeFileSync(fp, openTurnJsonl);
    const mtimeMs = statSync(fp).mtimeMs;

    const adapter = new CodexAdapter({ store, sessionsDir: join(tmpRoot, 'sessions'), archivedDir });

    // 1. Scan at +10s (<120s): open turn deferred, NOT persisted to ingested_files
    const s1 = await adapter.scan({ nowMs: mtimeMs + 10_000 });
    assert.equal(s1.length, 0);
    assert.equal(store.getIngestedFile(fp), null);
    assert.equal(adapter.pendingOpenFiles.has(fp), true);

    // 2. Scan at +50s (<120s, unchanged): throttled cleanly
    const s2 = await adapter.scan({ nowMs: mtimeMs + 50_000 });
    assert.equal(s2.length, 0);
    assert.equal(store.getIngestedFile(fp), null);

    // 3. Scan at +125s (>120s, unchanged): flushes open turn and persists ingested_files
    const s3 = await adapter.scan({ nowMs: mtimeMs + 125_000 });
    assert.equal(s3.length, 1);
    assert.equal(s3[0].turnUid, 'codex:codex-open-1:turn-open');
    assert.equal(s3[0].totalInputTokens, 4000);
    assert.equal(s3[0].outputTokens, 300);
    assert.equal(adapter.pendingOpenFiles.has(fp), false);
    assert.ok(store.getIngestedFile(fp), 'ingested_files must be persisted once flushed');

    // 4. Subsequent scan at +140s is skipped cleanly
    assert.equal((await adapter.scan({ nowMs: mtimeMs + 140_000 })).length, 0);

    // 5. Archived .jsonl.zst with open turn flushes immediately even at +5s
    if (zstdCompressSync) {
      const zstPath = join(archivedDir, 'rollout-zst.jsonl.zst');
      const zstContent = openTurnJsonl.replace(/codex-open-1/g, 'codex-zst-1');
      writeFileSync(zstPath, zstdCompressSync(Buffer.from(zstContent, 'utf8')));
      const zstMtime = statSync(zstPath).mtimeMs;
      const sZst = await adapter.scan({ nowMs: zstMtime + 5_000 });
      assert.equal(sZst.length, 1);
      assert.equal(sZst[0].turnUid, 'codex:codex-zst-1:turn-open');
      assert.ok(store.getIngestedFile(zstPath));
    }

    // 6. Normal completion (task_complete appended before 120s) emits immediately and persists ingested_files
    const fpLive = join(sessionsDir, 'rollout-live.jsonl');
    const liveInitial = openTurnJsonl.replace(/codex-open-1/g, 'codex-live-1');
    writeFileSync(fpLive, liveInitial);
    const liveMtime1 = statSync(fpLive).mtimeMs;
    assert.equal((await adapter.scan({ nowMs: liveMtime1 + 5_000 })).length, 0);
    assert.equal(store.getIngestedFile(fpLive), null);

    const taskCompleteLine = JSON.stringify({
      timestamp: '2026-11-23T04:00:05.100Z',
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'turn-open', duration_ms: 5000 },
    });
    writeFileSync(fpLive, `${liveInitial}\n${taskCompleteLine}\n`);
    const liveMtime2 = statSync(fpLive).mtimeMs;
    const sLive = await adapter.scan({ nowMs: liveMtime2 + 5_000 });
    assert.equal(sLive.length, 1);
    assert.equal(sLive[0].turnUid, 'codex:codex-live-1:turn-open');
    assert.equal(adapter.pendingOpenFiles.has(fpLive), false);
    assert.ok(store.getIngestedFile(fpLive));
  } finally {
    store.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('CodeBuddy preserves historical file mtimeMs fallback (no Date.now collapse) and avoids sub-150ms TPS clamping', () => {
  const historicalMs = Date.parse('2025-06-15T12:00:00.000Z');
  const tmpDir = mkdtempSync(join(tmpdir(), 'cb-fix-'));
  const store = new TurnStore(':memory:');
  try {
    // 1. CodeBuddy IDE session missing both req.startedAt and message.createdAt
    const ws = '/tmp/cb-ws';
    const hash = workspaceMd5(ws);
    const extDataDir = join(tmpDir, 'ext');
    const sessDir = join(extDataDir, 'user1', 'CodeBuddyIDE', 'user1', 'history', hash, 'sess-old');
    mkdirSync(join(sessDir, 'messages'), { recursive: true });

    const idxFile = join(sessDir, 'index.json');
    writeFileSync(
      idxFile,
      JSON.stringify({
        requests: [
          {
            id: 'req-old',
            state: 'complete',
            messages: ['m1'],
            usage: { inputTokens: 1500, outputTokens: 200, cacheTokens: 500, cachedWriteTokens: 0 },
          },
        ],
      })
    );
    writeFileSync(
      join(sessDir, 'messages', 'm1.json'),
      JSON.stringify({
        role: 'assistant',
        extra: JSON.stringify({ modelName: 'GLM-4.5' }),
      })
    );
    utimesSync(idxFile, historicalMs / 1000, historicalMs / 1000);

    // Direct call with explicit fallbackTimestampMs
    const directIde = parseCodeBuddyIdeSessionDir(sessDir, hash, { fallbackTimestampMs: historicalMs });
    assert.equal(directIde.length, 1);
    assert.equal(directIde[0].completedAtMs, historicalMs);
    assert.equal(directIde[0].modelActiveMs, null);
    assert.equal(directIde[0].tpsMethod, 'unavailable');

    // Direct call without explicit option reads index.json mtimeMs
    const inferredIde = parseCodeBuddyIdeSessionDir(sessDir, hash);
    assert.equal(inferredIde[0].completedAtMs, historicalMs);

    // 2. CodeBuddy CLI JSONL missing timestamps + sub-150ms net active duration cases
    const cliProjectsDir = join(tmpDir, 'cli');
    const cliProjDir = join(cliProjectsDir, 'proj1');
    mkdirSync(cliProjDir, { recursive: true });
    const cliNoTsJsonl = [
      JSON.stringify({ type: 'message', role: 'user', id: 'u-old', cwd: ws }),
      JSON.stringify({
        type: 'message',
        role: 'assistant',
        id: 'a-old',
        providerData: {
          messageId: 'm-old',
          requestModelName: 'GLM-4.5',
          rawUsage: { prompt_tokens: 1000, prompt_cache_hit_tokens: 200, completion_tokens: 80 },
        },
      }),
    ].join('\n');
    const cliFp = join(cliProjDir, 'sess-cli-old.jsonl');
    writeFileSync(cliFp, cliNoTsJsonl);
    utimesSync(cliFp, historicalMs / 1000, historicalMs / 1000);

    const directCli = parseCodeBuddyCliContent(cliNoTsJsonl, 'in-memory.jsonl', {
      fallbackTimestampMs: historicalMs,
    });
    assert.equal(directCli.length, 1);
    assert.equal(directCli[0].completedAtMs, historicalMs);

    // Full CodeBuddyAdapter.scan() passes file mtimeMs for both IDE and CLI
    const adapter = new CodeBuddyAdapter({ store, extDataDir, cliProjectsDir });
    const scanned = adapter.scan();
    assert.equal(scanned.length, 2);
    for (const r of scanned) {
      assert.equal(r.completedAtMs, historicalMs);
    }

    // 3. Sub-150ms net duration MUST NOT clamp up to 150ms
    const shortCliJsonl = [
      JSON.stringify({ type: 'message', role: 'user', id: 'u-fast', timestamp: 1000, cwd: ws }),
      JSON.stringify({
        type: 'message',
        role: 'assistant',
        id: 'a-fast',
        timestamp: 1080,
        providerData: {
          messageId: 'm-fast',
          requestModelName: 'GLM-4.5',
          rawUsage: { prompt_tokens: 500, completion_tokens: 90 },
        },
      }),
    ].join('\n');
    const shortTurns = parseCodeBuddyCliContent(shortCliJsonl, 'fast.jsonl');
    assert.equal(shortTurns.length, 1);
    assert.equal(shortTurns[0].durationMs, 80);
    assert.equal(shortTurns[0].modelActiveMs, null);
    assert.equal(shortTurns[0].tps, null);
    assert.equal(shortTurns[0].tpsMethod, 'unavailable');

    // Tool wait consuming almost entire turn (5000ms - 4900ms = 100ms < 150ms)
    const toolHeavyCliJsonl = [
      JSON.stringify({ type: 'message', role: 'user', id: 'u-th', timestamp: 1000, cwd: ws }),
      JSON.stringify({
        type: 'function_call',
        id: 'fc-1',
        timestamp: 1050,
        providerData: {
          messageId: 'm-th1',
          requestModelName: 'GLM-4.5',
          rawUsage: { prompt_tokens: 1000, completion_tokens: 50 },
        },
      }),
      JSON.stringify({ type: 'function_call_result', id: 'fcr-1', timestamp: 5950 }),
      JSON.stringify({
        type: 'message',
        role: 'assistant',
        id: 'a-th',
        timestamp: 6000,
        providerData: {
          messageId: 'm-th2',
          requestModelName: 'GLM-4.5',
          rawUsage: { prompt_tokens: 1200, completion_tokens: 50 },
        },
      }),
    ].join('\n');
    const toolHeavyTurns = parseCodeBuddyCliContent(toolHeavyCliJsonl, 'tool-heavy.jsonl');
    assert.equal(toolHeavyTurns.length, 1);
    assert.equal(toolHeavyTurns[0].durationMs, 5000);
    assert.equal(toolHeavyTurns[0].modelActiveMs, null);
    assert.equal(toolHeavyTurns[0].tps, null);
    assert.equal(toolHeavyTurns[0].tpsMethod, 'unavailable');

    // Boundary: net === 150ms IS accepted
    const boundaryCliJsonl = [
      JSON.stringify({ type: 'message', role: 'user', id: 'u-b', timestamp: 1000, cwd: ws }),
      JSON.stringify({
        type: 'message',
        role: 'assistant',
        id: 'a-b',
        timestamp: 1150,
        providerData: {
          messageId: 'm-b',
          requestModelName: 'GLM-4.5',
          rawUsage: { prompt_tokens: 500, completion_tokens: 30 },
        },
      }),
    ].join('\n');
    const boundaryTurns = parseCodeBuddyCliContent(boundaryCliJsonl, 'boundary.jsonl');
    assert.equal(boundaryTurns[0].modelActiveMs, 150);
    assert.equal(boundaryTurns[0].tps, 200);
    assert.equal(boundaryTurns[0].tpsMethod, 'e2e_turn');
  } finally {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Cursor hook does not clamp sub-150ms net active time up to 150ms', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'cursor-sub150-'));
  try {
    // 1. Short turn (< 150ms total)
    processCursorHookPayload(
      { hook_event_name: 'beforeSubmitPrompt', conversation_id: 'c1', generation_id: 'g-short' },
      { stateDir, nowMs: 10_000 }
    );
    const shortTurn = processCursorHookPayload(
      {
        hook_event_name: 'stop',
        conversation_id: 'c1',
        generation_id: 'g-short',
        model_id: 'claude-4-sonnet',
        input_tokens: 5000,
        output_tokens: 150,
      },
      { stateDir, nowMs: 10_080 }
    );
    assert.ok(shortTurn);
    assert.equal(shortTurn.durationMs, 80);
    assert.equal(shortTurn.modelActiveMs, null);
    assert.equal(shortTurn.tpsMethod, 'unavailable');
    const normShort = normalizeTurn(shortTurn);
    assert.equal(normShort.tps, null);
    assert.equal(normShort.tpsMethod, 'unavailable');

    // 2. Tool-heavy turn where durationMs - toolWaitMs = 100ms (< 150ms)
    processCursorHookPayload(
      { hook_event_name: 'beforeSubmitPrompt', conversation_id: 'c2', generation_id: 'g-tool' },
      { stateDir, nowMs: 20_000 }
    );
    processCursorHookPayload(
      { hook_event_name: 'beforeShellExecution', conversation_id: 'c2', generation_id: 'g-tool' },
      { stateDir, nowMs: 20_050 }
    );
    processCursorHookPayload(
      { hook_event_name: 'afterShellExecution', conversation_id: 'c2', generation_id: 'g-tool' },
      { stateDir, nowMs: 24_950 }
    );
    const toolTurn = processCursorHookPayload(
      {
        hook_event_name: 'stop',
        conversation_id: 'c2',
        generation_id: 'g-tool',
        model_id: 'claude-4-sonnet',
        input_tokens: 8000,
        output_tokens: 200,
      },
      { stateDir, nowMs: 25_000 }
    );
    assert.ok(toolTurn);
    assert.equal(toolTurn.durationMs, 5000);
    assert.equal(toolTurn.modelActiveMs, null);
    assert.equal(toolTurn.tpsMethod, 'unavailable');

    // 3. Boundary: net === 150ms IS accepted
    processCursorHookPayload(
      { hook_event_name: 'beforeSubmitPrompt', conversation_id: 'c3', generation_id: 'g-edge' },
      { stateDir, nowMs: 30_000 }
    );
    const edgeTurn = processCursorHookPayload(
      {
        hook_event_name: 'stop',
        conversation_id: 'c3',
        generation_id: 'g-edge',
        model_id: 'claude-4-sonnet',
        input_tokens: 1000,
        output_tokens: 30,
      },
      { stateDir, nowMs: 30_150 }
    );
    assert.ok(edgeTurn);
    assert.equal(edgeTurn.modelActiveMs, 150);
    assert.equal(edgeTurn.tpsMethod, 'e2e_turn');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('CodeBuddy CLI emits turns followed by acp-terminal-state / context-usage and Cursor deduplicates mid-turn cloud snapshots', () => {
  // 1. CodeBuddy CLI with trailing acp-terminal-state + context-usage
  const cliWithTrailingMeta = [
    JSON.stringify({ type: 'message', role: 'user', id: 'u-1', timestamp: 1000, cwd: '/tmp/proj' }),
    JSON.stringify({
      type: 'message',
      role: 'assistant',
      id: 'a-1',
      timestamp: 2500,
      content: [{ type: 'text', text: 'Completed task' }],
      providerData: {
        messageId: 'm-1',
        requestModelName: 'GLM-4.5',
        rawUsage: { prompt_tokens: 4000, prompt_cache_hit_tokens: 3000, completion_tokens: 200 },
      },
    }),
    JSON.stringify({ type: 'acp-terminal-state', timestamp: 2510 }),
    JSON.stringify({ type: 'context-usage', timestamp: 2520 }),
  ].join('\n');

  const cbTurns = parseCodeBuddyCliContent(cliWithTrailingMeta, 'trailing-meta.jsonl');
  assert.equal(cbTurns.length, 1);
  assert.equal(cbTurns[0].totalInputTokens, 4000);
  assert.equal(cbTurns[0].outputTokens, 200);

  // 2. Cursor mid-turn cloud snapshot vs completed local hook turn deduplication
  const store = new TurnStore(':memory:');
  try {
    // Mid-turn partial cloud event arrives first while turn is still running
    store.upsertTurn({
      turnUid: 'cursor:api:ev-mid-1',
      tool: 'cursor',
      host: 'cursor-cloud',
      sessionId: 'conv-dup-1',
      turnId: 'ev-mid-1',
      model: 'gemini-4-neon-xhigh',
      startedAtMs: 100_000,
      completedAtMs: 100_000,
      totalInputTokens: 800_000,
      uncachedInputTokens: 100_000,
      cacheReadTokens: 700_000,
      outputTokens: 20_000,
    });
    assert.equal(store.getRecentTurns(10, 'cursor').length, 1);

    // Local hook turn finishes at 140_000 with final 1_300_000 input tokens (started at 100_500)
    store.upsertTurn({
      turnUid: 'cursor:conv-dup-1:gen-1',
      tool: 'cursor',
      host: 'cursor-ide',
      sessionId: 'conv-dup-1',
      turnId: 'gen-1',
      model: 'gemini-4-neon',
      startedAtMs: 100_500,
      completedAtMs: 140_000,
      totalInputTokens: 1_300_000,
      uncachedInputTokens: 150_000,
      cacheReadTokens: 1_150_000,
      outputTokens: 35_000,
    });

    const cursorTurns = store.getRecentTurns(10, 'cursor');
    assert.equal(cursorTurns.length, 1);
    assert.equal(cursorTurns[0].host, 'cursor-ide');
    assert.equal(cursorTurns[0].totalInputTokens, 1_300_000);
  } finally {
    store.close();
  }
});

test('Codex parses service_tier multipliers, per-call >272K buckets, and token_count fallback buckets', () => {
  const jsonl = [
    JSON.stringify({ type: 'session_meta', payload: { id: 'sess-tier', cwd: '/tmp/ws' } }),
    // Turn 1: priority tier (2x) with mixed calls: 100K (<=272K) + 300K (>272K), avg = 200K (<=272K)
    JSON.stringify({
      timestamp: '2026-11-25T01:00:00Z',
      type: 'turn_context',
      payload: { turn_id: 't1', model: 'gpt-6.2-sol', service_tier: 'priority' },
    }),
    JSON.stringify({
      timestamp: '2026-11-25T01:00:05Z',
      type: 'token_usage_record',
      payload: {
        turn_id: 't1',
        response_id: 'r1',
        usage: { input_tokens: 100_000, cached_input_tokens: 80_000, output_tokens: 1_000 },
      },
    }),
    JSON.stringify({
      timestamp: '2026-11-25T01:00:10Z',
      type: 'token_usage_record',
      payload: {
        turn_id: 't1',
        response_id: 'r2',
        usage: { input_tokens: 300_000, cached_input_tokens: 200_000, output_tokens: 2_000 },
      },
    }),
    JSON.stringify({
      timestamp: '2026-11-25T01:00:12Z',
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 't1' },
    }),
    // Turn 2: resets to default tier via thread_settings_applied, then ultrafast (3x)
    JSON.stringify({
      timestamp: '2026-11-25T01:01:00Z',
      type: 'turn_context',
      payload: { turn_id: 't2', model: 'gpt-6.2-sol' },
    }),
    JSON.stringify({
      timestamp: '2026-11-25T01:01:01Z',
      type: 'event_msg',
      payload: { type: 'thread_settings_applied', thread_settings: { service_tier: 'default' } },
    }),
    JSON.stringify({
      timestamp: '2026-11-25T01:01:05Z',
      type: 'token_usage_record',
      payload: {
        turn_id: 't2',
        response_id: 'r3',
        usage: { input_tokens: 100_000, cached_input_tokens: 100_000, output_tokens: 1_000 },
      },
    }),
    JSON.stringify({
      timestamp: '2026-11-25T01:01:06Z',
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 't2' },
    }),
    // Turn 3: token_count fallback with ultrafast (3x)
    JSON.stringify({
      timestamp: '2026-11-25T01:02:00Z',
      type: 'turn_context',
      payload: { turn_id: 't3', model: 'gpt-6.2-sol', service_tier: 'ultrafast' },
    }),
    JSON.stringify({
      timestamp: '2026-11-25T01:02:05Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { input_tokens: 100_000, cached_input_tokens: 100_000, output_tokens: 1_000 },
          total_token_usage: { input_tokens: 100_000, cached_input_tokens: 100_000, output_tokens: 1_000 },
        },
      },
    }),
    JSON.stringify({
      timestamp: '2026-11-25T01:02:06Z',
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 't3' },
    }),
  ].join('\n');

  const turns = parseCodexSessionDetailed(jsonl, 'rollout-tier.jsonl').turns;
  assert.equal(turns.length, 3);
  assert.equal(turns[0].serviceTier, 'priority');
  assert.equal(turns[0].usageBuckets.length, 2);

  // Turn 1 expected:
  // Call 1 (<=272k, priority 2x): (0.02*2 + 0.08*0.1 + 0.001*10)*2 = (0.04+0.008+0.01)*2 = 0.116
  // Call 2 (>272k, priority 2x): (0.1*4 + 0.2*0.2 + 0.002*15)*2 = (0.4+0.04+0.03)*2 = 0.94
  // Total = 1.056
  assert.equal(estimateTurnCost(turns[0]).costUsd, 1.056);

  // Turn 2 expected (default tier): 0.1*0.1 + 0.001*10 = 0.02
  assert.equal(turns[1].serviceTier, null);
  assert.equal(estimateTurnCost(turns[1]).costUsd, 0.02);

  // Turn 3 expected (fallback ultrafast 3x): (0.1*0.1 + 0.001*10)*3 = 0.06
  assert.equal(turns[2].serviceTier, 'ultrafast');
  assert.equal(estimateTurnCost(turns[2]).costUsd, 0.06);
});

test('Claude Code parses 1h/5m cache writes, speed=fast, batch tier, us geo, thinking_tokens, and >200K per-call buckets', () => {
  const jsonl = [
    JSON.stringify({
      type: 'user',
      sessionId: 'c-sess',
      cwd: '/tmp/c',
      timestamp: '2026-11-25T02:00:00Z',
      message: { role: 'user', content: 'analyze' },
    }),
    // Call 1: claude-opus-5-5 with 1h cache write ($8/M) + 5m cache write ($5/M) + US geo (1.1x)
    JSON.stringify({
      type: 'assistant',
      sessionId: 'c-sess',
      timestamp: '2026-11-25T02:00:05Z',
      message: {
        id: 'msg-1',
        model: 'claude-opus-5-5',
        role: 'assistant',
        content: [{ type: 'text', text: 'step1' }],
        usage: {
          input_tokens: 10_000,
          cache_read_input_tokens: 100_000,
          cache_creation_input_tokens: 60_000,
          cache_creation: { ephemeral_5m_input_tokens: 20_000, ephemeral_1h_input_tokens: 40_000 },
          output_tokens: 2_000,
          output_tokens_details: { thinking_tokens: 500 },
          speed: 'standard',
          service_tier: 'standard',
          inference_geo: 'us',
        },
      },
    }),
    // Call 2: claude-opus-4-6 fast mode (6x) + batch? Let's test speed='fast' (6x on opus-4-6)
    JSON.stringify({
      type: 'assistant',
      sessionId: 'c-sess',
      timestamp: '2026-11-25T02:00:10Z',
      message: {
        id: 'msg-2',
        model: 'claude-opus-4-6',
        role: 'assistant',
        content: [{ type: 'text', text: 'fast done' }],
        usage: {
          input_tokens: 10_000,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          output_tokens: 1_000,
          speed: 'fast',
          inference_geo: 'global',
        },
      },
    }),
    // Turn 2: claude-sonnet-4-5 mixed >200K + <=200K per-call buckets + batch (0.5x)
    JSON.stringify({
      type: 'user',
      sessionId: 'c-sess',
      timestamp: '2026-11-25T02:01:00Z',
      message: { role: 'user', content: 'next' },
    }),
    JSON.stringify({
      type: 'assistant',
      sessionId: 'c-sess',
      timestamp: '2026-11-25T02:01:05Z',
      message: {
        id: 'msg-3',
        model: 'claude-sonnet-4-5',
        role: 'assistant',
        content: [{ type: 'text', text: 'short' }],
        usage: {
          input_tokens: 100_000,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          output_tokens: 1_000,
          service_tier: 'batch',
        },
      },
    }),
    JSON.stringify({
      type: 'assistant',
      sessionId: 'c-sess',
      timestamp: '2026-11-25T02:01:10Z',
      message: {
        id: 'msg-4',
        model: 'claude-sonnet-4-5',
        role: 'assistant',
        content: [{ type: 'text', text: 'long' }],
        usage: {
          input_tokens: 250_000,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          output_tokens: 2_000,
          service_tier: 'batch',
        },
      },
    }),
  ].join('\n');

  const turns = parseClaudeCodeSessionContent(jsonl, { sessionId: 'c-sess' });
  assert.equal(turns.length, 2);
  assert.equal(turns[0].thinkingTokens, 500);
  // Turn 1:
  // Call 1 (opus-5-5, us 1.1x): (0.01*4 + 0.1*0.2 + 0.02*5 + 0.04*8 + 0.002*20)*1.1 = (0.04+0.02+0.10+0.32+0.04)*1.1 = 0.52*1.1 = 0.572
  // Call 2 (opus-4-6, fast 6x): (0.01*5 + 0.001*25)*6 = 0.075*6 = 0.45
  // Total = 1.022
  assert.equal(estimateTurnCost(turns[0]).costUsd, 1.022);

  // Turn 2: avg = 175K (<=200K), but Call 4 = 250K (>200K)
  // Call 3 (<=200K, batch 0.5x): (0.1*3 + 0.001*15)*0.5 = 0.315*0.5 = 0.1575
  // Call 4 (>200K, batch 0.5x): (0.25*6 + 0.002*22.5)*0.5 = (1.5+0.045)*0.5 = 0.7725
  // Total = 0.93
  assert.equal(estimateTurnCost(turns[1]).costUsd, 0.93);
});

test('Antigravity emits per-step usageBuckets for mixed >200K & multi-model turns', () => {
  const transcript = [
    JSON.stringify({ step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-25T03:00:00Z' }),
    JSON.stringify({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-25T03:00:05Z',
      model: 'gemini-3.1-pro',
      input_tokens: 50_000,
      cache_read_tokens: 100_000,
      output_tokens: 1_000,
      tool_calls: [{ id: 'tc1' }],
    }),
    JSON.stringify({
      step_index: 2,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-25T03:00:10Z',
      model: 'gemini-3.1-pro',
      input_tokens: 50_000,
      cache_read_tokens: 200_000,
      output_tokens: 2_000,
      tool_calls: [],
    }),
    JSON.stringify({ step_index: 3, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-25T03:01:00Z' }),
    JSON.stringify({
      step_index: 4,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-25T03:01:05Z',
      model: 'gemini-4-neon',
      input_tokens: 100_000,
      cache_read_tokens: 0,
      output_tokens: 1_000,
      tool_calls: [{ id: 'tc2' }],
    }),
    JSON.stringify({
      step_index: 5,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-25T03:01:10Z',
      model: 'gemini-4-hydrogen',
      input_tokens: 100_000,
      cache_read_tokens: 0,
      output_tokens: 1_000,
      tool_calls: [],
    }),
  ].join('\n');

  const turns = parseAntigravityTranscriptContent(transcript, { sessionId: 'ag-buckets' });
  assert.equal(turns.length, 2);
  // Turn 1: Step 1 (150K <=200K): 0.05*2 + 0.1*0.2 + 0.001*12 = 0.132
  //         Step 2 (250K >200K):  0.05*4 + 0.2*0.4 + 0.002*18 = 0.316
  // Total = 0.448 (turn avg is 200K, so naive avg would miss Step 2!)
  assert.equal(estimateTurnCost(turns[0]).costUsd, 0.448);

  // Turn 2: multi-model buckets: neon (0.1*3 + 0.001*15 = 0.315) + hydrogen (0.1*1.5 + 0.001*7.5 = 0.1575) = 0.4725
  assert.equal(estimateTurnCost(turns[1]).costUsd, 0.4725);
});

test('TurnStore migrates v3->v4, preserves cursor-cloud explicitCostUsd on dedup, and aligns summary/session/receipt costs', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'atm-v4-mig-'));
  const dbPath = join(tmpDir, 'meter.db');
  try {
    // Seed a v3 database with an ingested_files row
    const rawDb = new DatabaseSync(dbPath);
    rawDb.exec(`
      CREATE TABLE turns (
        turn_uid TEXT PRIMARY KEY, tool TEXT NOT NULL, host TEXT NOT NULL,
        session_id TEXT NOT NULL, turn_id TEXT NOT NULL, model TEXT NOT NULL,
        workspace_path TEXT, workspace_hash TEXT, started_at_ms INTEGER,
        completed_at_ms INTEGER NOT NULL, call_count INTEGER NOT NULL,
        total_input_tokens INTEGER NOT NULL, uncached_input_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL, thinking_tokens INTEGER,
        cache_rate_pct REAL, duration_ms INTEGER, model_active_ms INTEGER,
        ttft_ms INTEGER, tps REAL, tps_method TEXT NOT NULL,
        reply_preview TEXT, explicit_cost_usd REAL
      );
      CREATE TABLE ingested_files (file_path TEXT PRIMARY KEY, mtime_ms REAL NOT NULL, size_bytes INTEGER);
      INSERT INTO ingested_files VALUES ('/tmp/old.jsonl', 1000, 100);
      PRAGMA user_version = 3;
    `);
    rawDb.close();

    const store = new TurnStore(dbPath);
    try {
      const ver = store.db.prepare('PRAGMA user_version').get().user_version;
      assert.equal(ver, 4);
      const cols = store.db.prepare('PRAGMA table_info(turns)').all().map((c) => c.name);
      assert.ok(cols.includes('usage_buckets_json'));
      assert.equal(store.db.prepare('SELECT COUNT(*) c FROM ingested_files').get().c, 0);

      // 1. Cursor cloud explicit_cost_usd preservation when local hook arrives
      const nowMs = Date.UTC(2026, 10, 25, 12, 0, 0);
      store.upsertTurn({
        turnUid: 'cursor:api:cloud-1',
        tool: 'cursor',
        host: 'cursor-cloud',
        sessionId: 'conv-preserve',
        turnId: 'cloud-1',
        model: 'grok-bot-default',
        startedAtMs: nowMs - 20_000,
        completedAtMs: nowMs - 10_000,
        totalInputTokens: 50_000,
        uncachedInputTokens: 10_000,
        cacheReadTokens: 40_000,
        outputTokens: 500,
        explicitCostUsd: 1.25,
      });
      store.upsertTurn({
        turnUid: 'cursor:conv-preserve:gen-1',
        tool: 'cursor',
        host: 'cursor-ide',
        sessionId: 'conv-preserve',
        turnId: 'gen-1',
        model: 'grok-bot-default',
        startedAtMs: nowMs - 25_000,
        completedAtMs: nowMs,
        totalInputTokens: 80_000,
        uncachedInputTokens: 15_000,
        cacheReadTokens: 65_000,
        outputTokens: 800,
      });
      const curTurns = store.getRecentTurns(10, 'cursor');
      assert.equal(curTurns.length, 1);
      assert.equal(curTurns[0].host, 'cursor-ide');
      assert.equal(curTurns[0].explicitCostUsd, 1.25);
      assert.equal(curTurns[0].estimatedCostUsd, 1.25);

      // 2. Query consistency across getUsageSummary, getRecentSessions, and getReceiptData (including availableDates)
      store.upsertTurn({
        turnUid: 'codex:s-cons:t-1',
        tool: 'codex',
        host: 'codex-desktop',
        sessionId: 's-cons',
        turnId: 't-1',
        model: 'gpt-6.2-sol',
        completedAtMs: nowMs,
        callCount: 2,
        totalInputTokens: 400_000,
        uncachedInputTokens: 120_000,
        cacheReadTokens: 280_000,
        outputTokens: 3_000,
        serviceTier: 'priority',
        usageBuckets: [
          { b: 'le_200k', st: 'priority', c: 1, in: 100_000, u: 20_000, cr: 80_000, cw5: 0, cw1h: 0, out: 1_000 },
          { b: 'gt_272k', st: 'priority', c: 1, in: 300_000, u: 100_000, cr: 200_000, cw5: 0, cw1h: 0, out: 2_000 },
        ],
      });

      const summary = store.getUsageSummary({ days: 7, tool: 'codex', nowMs });
      const sessions = store.getRecentSessions({ tool: 'codex', limit: 5, nowMs });
      const d = new Date(nowMs);
      const localDay = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const receipt = store.getReceiptData({ date: localDay, scope: 'day', tool: 'codex', nowMs });

      assert.equal(summary.totals.estimatedCostUsd, 1.056);
      assert.equal(sessions[0].estimatedCostUsd, 1.056);
      assert.equal(receipt.totals.estimatedCostUsd, 1.056);
      assert.equal(receipt.availableDates[0].estimatedCostUsd, 1.056);
    } finally {
      store.close();
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function pbVarint(n) {
  let v = BigInt(n);
  const out = [];
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return Buffer.from(out);
}

function pbFieldBytes(fieldNum, payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  return Buffer.concat([pbVarint((fieldNum << 3) | 2), pbVarint(buf.length), buf]);
}

function pbFieldVarint(fieldNum, val) {
  return Buffer.concat([pbVarint((fieldNum << 3) | 0), pbVarint(val)]);
}

function buildGenMetadataBlob({ stepIndices, responseModel, displayName, outputTokens, thinkingTokens, ttftMs, streamingMs }) {
  const usage = Buffer.concat([
    ...(outputTokens !== undefined ? [pbFieldVarint(3, outputTokens)] : []),
    ...(thinkingTokens !== undefined ? [pbFieldVarint(9, thinkingTokens)] : []),
  ]);
  const dur = (ms) =>
    Buffer.concat([
      pbFieldVarint(1, Math.floor(ms / 1000)),
      pbFieldVarint(2, (ms % 1000) * 1_000_000),
    ]);
  const chatModel = Buffer.concat([
    ...(usage.length ? [pbFieldBytes(4, usage)] : []),
    ...(ttftMs !== undefined ? [pbFieldBytes(11, dur(ttftMs))] : []),
    ...(streamingMs !== undefined ? [pbFieldBytes(12, dur(streamingMs))] : []),
    ...(responseModel ? [pbFieldBytes(19, responseModel)] : []),
    ...(displayName ? [pbFieldBytes(21, displayName)] : []),
  ]);
  const packedSteps = Buffer.concat(stepIndices.map((s) => pbVarint(s)));
  return Buffer.concat([pbFieldBytes(1, chatModel), pbFieldBytes(2, packedSteps)]);
}

test('Antigravity pricing falls back on unknown bucket, TurnStore protects named buckets, and offline gen_metadata protobuf restores models & TPS', async () => {
  // 1. Pricing fallback when bucket m is "unknown" or missing, while real unknown models remain partial
  const unknownBucketCost = estimateTurnCost({
    model: 'gemini-4-neon',
    completedAtMs: Date.UTC(2026, 10, 20),
    usageBuckets: [{ m: 'unknown', b: 'le_100k', c: 1, in: 1_000_000, u: 1_000_000, cr: 0, cw5: 0, cw1h: 0, out: 100_000 }],
  });
  assert.equal(unknownBucketCost.priced, true);
  assert.equal(unknownBucketCost.partial, false);
  assert.equal(unknownBucketCost.costUsd, 4.5);

  const realUnknownBucket = estimateTurnCost({
    model: 'gemini-4-neon',
    completedAtMs: Date.UTC(2026, 10, 20),
    usageBuckets: [
      { m: 'unknown', b: 'le_100k', c: 1, in: 1_000_000, u: 1_000_000, cr: 0, cw5: 0, cw1h: 0, out: 0 },
      { m: 'mystery-model', b: 'le_100k', c: 1, in: 1_000_000, u: 1_000_000, cr: 0, cw5: 0, cw1h: 0, out: 0 },
    ],
  });
  assert.equal(realUnknownBucket.partial, true);
  assert.equal(realUnknownBucket.costUsd, 3);

  // 2. TurnStore protects named usage_buckets_json from offline rescan overwrite with unknown model
  const store = new TurnStore(':memory:');
  try {
    store.upsertTurn({
      turnUid: 'antigravity:sess-p:turn-0',
      tool: 'antigravity',
      host: 'antigravity-desktop',
      sessionId: 'sess-p',
      turnId: 'turn-0',
      model: 'gemini-4-neon',
      completedAtMs: Date.UTC(2026, 10, 20),
      callCount: 1,
      totalInputTokens: 100_000,
      uncachedInputTokens: 100_000,
      outputTokens: 1_000,
      usageBuckets: [{ m: 'gemini-4-neon', b: 'le_100k', c: 1, in: 100_000, u: 100_000, cr: 0, cw5: 0, cw1h: 0, out: 1_000 }],
    });
    store.upsertTurn({
      turnUid: 'antigravity:sess-p:turn-0',
      tool: 'antigravity',
      host: 'antigravity-desktop',
      sessionId: 'sess-p',
      turnId: 'turn-0',
      model: 'unknown',
      completedAtMs: Date.UTC(2026, 10, 20),
      callCount: 1,
      totalInputTokens: 100_000,
      uncachedInputTokens: 100_000,
      outputTokens: 1_000,
      usageBuckets: [{ b: 'le_100k', c: 1, in: 100_000, u: 100_000, cr: 0, cw5: 0, cw1h: 0, out: 1_000 }],
    });
    const saved = store.db.prepare(`SELECT model, usage_buckets_json FROM turns WHERE turn_uid = 'antigravity:sess-p:turn-0'`).get();
    assert.equal(saved.model, 'gemini-4-neon');
    assert.equal(JSON.parse(saved.usage_buckets_json)[0].m, 'gemini-4-neon');
  } finally {
    store.close();
  }

  // 3. Binary protobuf gen_metadata decoder + offline SQLite scan
  const decoded = decodeAntigravityGenMetadataRow(
    buildGenMetadataBlob({
      stepIndices: [1, 2],
      responseModel: 'gemini-4-hydrogen',
      displayName: 'Gemini 4 Hydrogen (High)',
      outputTokens: 500,
      thinkingTokens: 200,
      ttftMs: 1200,
      streamingMs: 2500,
    })
  );
  assert.deepEqual(decoded.stepIndices, [1, 2]);
  assert.equal(decoded.entry.model, 'gemini-4-hydrogen');
  assert.equal(decoded.entry.outputTokens, 500);
  assert.equal(decoded.entry.thinkingTokens, 200);
  assert.equal(decoded.entry.ttftMs, 1200);
  assert.equal(decoded.entry.streamingMs, 2500);

  const tmpGem = mkdtempSync(join(tmpdir(), 'atm-ag-genmeta-'));
  try {
    const sid = 'sess-genmeta-1';
    const logsDir = join(tmpGem, 'antigravity', 'brain', sid, '.system_generated', 'logs');
    const convDir = join(tmpGem, 'antigravity', 'conversations');
    mkdirSync(logsDir, { recursive: true });
    mkdirSync(convDir, { recursive: true });

    writeFileSync(
      join(logsDir, 'transcript.jsonl'),
      [
        JSON.stringify({ step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-10T01:00:00Z' }),
        JSON.stringify({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-11-10T01:00:03Z',
          input_tokens: 100_000,
          cache_read_tokens: 0,
          output_tokens: 500,
          tool_calls: [{ id: 't1' }],
        }),
        JSON.stringify({
          step_index: 3,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-11-10T01:00:08Z',
          input_tokens: 100_000,
          cache_read_tokens: 0,
          output_tokens: 1_000,
          tool_calls: [],
        }),
      ].join('\n')
    );

    const convDb = new DatabaseSync(join(convDir, `${sid}.db`));
    convDb.exec(`CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER);`);
    const ins = convDb.prepare(`INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)`);
    const b0 = buildGenMetadataBlob({
      stepIndices: [1],
      responseModel: 'gemini-4-hydrogen',
      outputTokens: 500,
      thinkingTokens: 150,
      ttftMs: 900,
      streamingMs: 2000,
    });
    // Row 1 omits field 19 responseModel and falls back to field 21 displayName
    const b1 = buildGenMetadataBlob({
      stepIndices: [3],
      displayName: 'Gemini 3.8 Flash (High)',
      outputTokens: 1000,
      thinkingTokens: 300,
      ttftMs: 400,
      streamingMs: 2000,
    });
    ins.run(0, b0, b0.length);
    ins.run(1, b1, b1.length);
    convDb.close();

    const idxMap = loadAntigravityConversationSpeedIndex(tmpGem, 'antigravity', sid);
    assert.equal(idxMap.get(1)?.model, 'gemini-4-hydrogen');
    assert.equal(idxMap.get(3)?.model, 'Gemini 3.8 Flash (High)');

    const agStore = new TurnStore(':memory:');
    try {
      const adapter = new AntigravityAdapter({ store: agStore, geminiRoot: tmpGem, enableRpc: false });
      const emitted = await adapter.scan({ maxRecentFiles: Infinity });
      assert.equal(emitted.length, 1);
      assert.equal(emitted[0].tpsMethod, 'streaming_decode');
      assert.equal(emitted[0].thinkingTokens, 450);
      assert.equal(emitted[0].usageBuckets.length, 2);
      // Step 1 (hydrogen: 0.1*1.5 + 0.0005*7.5 = 0.15375) + Step 3 (3.8 flash: 0.1*0.75 + 0.001*3.75 = 0.07875) = 0.2325
      assert.equal(emitted[0].estimatedCostUsd, 0.2325);
    } finally {
      agStore.close();
    }
  } finally {
    rmSync(tmpGem, { recursive: true, force: true });
  }
});

test('CodexAdapter deduplicates replayed parent turns across forked rollouts and purges legacy orphan duplicates', async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'atm-codex-fork-dedupe-'));
  const sessDir = join(tmpRoot, 'sessions', '2026', '11', '12');
  mkdirSync(sessDir, { recursive: true });
  const parentId = '11111111-1111-7111-8111-111111111111';
  const childId = '22222222-2222-7222-8222-222222222222';
  const parentFile = join(sessDir, `rollout-2026-11-12T10-00-00-${parentId}.jsonl`);
  const childFile = join(sessDir, `rollout-2026-11-12T10-10-00-${childId}.jsonl`);

  const tc = (ts, tid, totIn, totOut, lastIn, lastOut) =>
    JSON.stringify({
      timestamp: ts,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: totIn, cached_input_tokens: 0, output_tokens: totOut, reasoning_output_tokens: 0 },
          last_token_usage: { input_tokens: lastIn, cached_input_tokens: 0, output_tokens: lastOut, reasoning_output_tokens: 0 },
        },
      },
    });

  writeFileSync(
    parentFile,
    [
      JSON.stringify({ timestamp: '2026-11-12T10:00:00Z', type: 'session_meta', payload: { id: parentId, cwd: '/tmp/p' } }),
      JSON.stringify({ timestamp: '2026-11-12T10:00:01Z', type: 'turn_context', payload: { turn_id: 'pt-1', model: 'gpt-5.4' } }),
      tc('2026-11-12T10:00:05Z', 'pt-1', 1000, 100, 1000, 100),
      JSON.stringify({ timestamp: '2026-11-12T10:00:06Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'pt-1' } }),
      JSON.stringify({ timestamp: '2026-11-12T10:01:00Z', type: 'turn_context', payload: { turn_id: 'pt-2', model: 'gpt-5.4' } }),
      tc('2026-11-12T10:01:05Z', 'pt-2', 3000, 300, 2000, 200),
      JSON.stringify({ timestamp: '2026-11-12T10:01:06Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'pt-2' } }),
    ].join('\n') + '\n'
  );

  // Forked child replays zero-delta baseline + parent pt-1 under synthetic rollout-4 + partial pt-2, then makes its own new turn ct-1
  writeFileSync(
    childFile,
    [
      JSON.stringify({ timestamp: '2026-11-12T10:10:00Z', type: 'session_meta', payload: { id: childId, forked_from_id: parentId, cwd: '/tmp/p' } }),
      tc('2026-11-12T10:10:00Z', null, 1000, 100, 0, 0),
      JSON.stringify({ timestamp: '2026-11-12T10:10:00Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'rollout-4' } }),
      JSON.stringify({ timestamp: '2026-11-12T10:10:00Z', type: 'turn_context', payload: { turn_id: 'pt-1', model: 'gpt-5.4' } }),
      tc('2026-11-12T10:10:00Z', 'pt-1', 1000, 100, 1000, 100),
      JSON.stringify({ timestamp: '2026-11-12T10:10:01Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'pt-1' } }),
      JSON.stringify({ timestamp: '2026-11-12T10:10:02Z', type: 'turn_context', payload: { turn_id: 'pt-2', model: 'gpt-5.4' } }),
      tc('2026-11-12T10:10:02Z', 'pt-2', 3000, 300, 2000, 200),
      JSON.stringify({ timestamp: '2026-11-12T10:10:03Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'pt-2' } }),
      JSON.stringify({ timestamp: '2026-11-12T10:11:00Z', type: 'turn_context', payload: { turn_id: 'ct-1', model: 'gpt-5.4' } }),
      tc('2026-11-12T10:11:05Z', 'ct-1', 3500, 350, 500, 50),
      JSON.stringify({ timestamp: '2026-11-12T10:11:06Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'ct-1' } }),
    ].join('\n') + '\n'
  );

  // Set child mtime older than parent to verify codexFileOrderMs filename ordering still processes parent first
  const tParent = new Date('2026-11-12T10:15:00Z');
  const tChild = new Date('2026-11-12T10:10:00Z');
  utimesSync(parentFile, tParent, tParent);
  utimesSync(childFile, tChild, tChild);

  const store = new TurnStore(':memory:');
  try {
    // Seed an orphan pre-turn_source duplicate row (like legacy guardian session_id vs id mismatch)
    store.upsertTurn({
      turnUid: `codex:legacy-orphan:pt-1`,
      tool: 'codex',
      host: 'codex-desktop',
      sessionId: 'legacy-orphan',
      turnId: 'pt-1',
      model: 'gpt-5.4',
      completedAtMs: Date.parse('2026-11-12T10:00:06Z'),
      totalInputTokens: 1000,
      uncachedInputTokens: 1000,
      outputTokens: 100,
    });

    const adapter = new CodexAdapter({ store, sessionsDir: join(tmpRoot, 'sessions'), archivedDir: join(tmpRoot, 'arch') });
    await adapter.scan({ maxRecentFiles: Infinity });

    const rows = store.db.prepare(`SELECT session_id, turn_id, total_input_tokens, output_tokens FROM turns WHERE tool = 'codex' ORDER BY completed_at_ms`).all();
    assert.deepEqual(
      rows.map((r) => ({ sid: r.session_id, tid: r.turn_id, in: r.total_input_tokens, out: r.output_tokens })),
      [
        { sid: parentId, tid: 'pt-1', in: 1000, out: 100 },
        { sid: parentId, tid: 'pt-2', in: 2000, out: 200 },
        { sid: childId, tid: 'ct-1', in: 500, out: 50 },
      ]
    );
    assert.equal(store.getCodexIngestResetPending(), false);
  } finally {
    store.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('forEachZstdLine streams compressed files via native or CLI fallback and warns on failure', async (t) => {
  if (!zstdCompressSync) {
    t.skip('native zstdCompressSync unavailable on this Node runtime');
    return;
  }
  const tmpDir = mkdtempSync(join(tmpdir(), 'atm-zst-stream-'));
  try {
    const zstPath = join(tmpDir, 'sample.jsonl.zst');
    const lines = ['{"a":1}', '{"b":2}', '{"c":3}'];
    writeFileSync(zstPath, zstdCompressSync(Buffer.from(`${lines.join('\n')}\n`, 'utf8')));

    const nativeOut = [];
    const okNative = await forEachZstdLine(zstPath, (l) => nativeOut.push(l));
    assert.equal(okNative, true);
    assert.deepEqual(nativeOut, lines);

    const warnings = [];
    const okMissing = await forEachZstdLine(zstPath, () => {}, {
      nativeStreamFactory: null,
      cliBin: null,
      warn: (msg) => warnings.push(msg),
    });
    assert.equal(okMissing, false);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /zstd CLI unavailable/);

    const cliOut = [];
    const okCli = await forEachZstdLine(zstPath, (l) => cliOut.push(l), {
      nativeStreamFactory: null,
      warn: () => {},
    });
    if (okCli) {
      assert.deepEqual(cliOut, lines);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
