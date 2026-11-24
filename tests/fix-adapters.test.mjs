import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

import { TurnStore } from '../packages/daemon/src/store.mjs';
import { normalizeTurn } from '../packages/daemon/src/format.mjs';
import {
  AntigravityAdapter,
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

test('CodexAdapter defers ingested_files caching for open turns so >120s flushOpenTurns actually fires', () => {
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
    const s1 = adapter.scan({ nowMs: mtimeMs + 10_000 });
    assert.equal(s1.length, 0);
    assert.equal(store.getIngestedFile(fp), null);
    assert.equal(adapter.pendingOpenFiles.has(fp), true);

    // 2. Scan at +50s (<120s, unchanged): throttled cleanly
    const s2 = adapter.scan({ nowMs: mtimeMs + 50_000 });
    assert.equal(s2.length, 0);
    assert.equal(store.getIngestedFile(fp), null);

    // 3. Scan at +125s (>120s, unchanged): flushes open turn and persists ingested_files
    const s3 = adapter.scan({ nowMs: mtimeMs + 125_000 });
    assert.equal(s3.length, 1);
    assert.equal(s3[0].turnUid, 'codex:codex-open-1:turn-open');
    assert.equal(s3[0].totalInputTokens, 4000);
    assert.equal(s3[0].outputTokens, 300);
    assert.equal(adapter.pendingOpenFiles.has(fp), false);
    assert.ok(store.getIngestedFile(fp), 'ingested_files must be persisted once flushed');

    // 4. Subsequent scan at +140s is skipped cleanly
    assert.equal(adapter.scan({ nowMs: mtimeMs + 140_000 }).length, 0);

    // 5. Archived .jsonl.zst with open turn flushes immediately even at +5s
    const zstPath = join(archivedDir, 'rollout-zst.jsonl.zst');
    const zstContent = openTurnJsonl.replace(/codex-open-1/g, 'codex-zst-1');
    writeFileSync(zstPath, zstdCompressSync(Buffer.from(zstContent, 'utf8')));
    const zstMtime = statSync(zstPath).mtimeMs;
    const sZst = adapter.scan({ nowMs: zstMtime + 5_000 });
    assert.equal(sZst.length, 1);
    assert.equal(sZst[0].turnUid, 'codex:codex-zst-1:turn-open');
    assert.ok(store.getIngestedFile(zstPath));

    // 6. Normal completion (task_complete appended before 120s) emits immediately and persists ingested_files
    const fpLive = join(sessionsDir, 'rollout-live.jsonl');
    const liveInitial = openTurnJsonl.replace(/codex-open-1/g, 'codex-live-1');
    writeFileSync(fpLive, liveInitial);
    const liveMtime1 = statSync(fpLive).mtimeMs;
    assert.equal(adapter.scan({ nowMs: liveMtime1 + 5_000 }).length, 0);
    assert.equal(store.getIngestedFile(fpLive), null);

    const taskCompleteLine = JSON.stringify({
      timestamp: '2026-11-23T04:00:05.100Z',
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'turn-open', duration_ms: 5000 },
    });
    writeFileSync(fpLive, `${liveInitial}\n${taskCompleteLine}\n`);
    const liveMtime2 = statSync(fpLive).mtimeMs;
    const sLive = adapter.scan({ nowMs: liveMtime2 + 5_000 });
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
