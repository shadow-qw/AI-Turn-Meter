import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as zlib from 'node:zlib';

import { TurnStore } from '../packages/daemon/src/store.mjs';
import { estimateTurnCost, resolveModelPricing } from '../packages/daemon/src/pricing.mjs';
import { CodexAdapter, parseCodexSessionDetailed } from '../packages/daemon/src/adapters/codex.mjs';

const zstdCompressSync = typeof zlib.zstdCompressSync === 'function' ? zlib.zstdCompressSync : null;

const tc = (ts, totIn, totOut, lastIn, lastOut) =>
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
const ctx = (ts, turnId) => JSON.stringify({ timestamp: ts, type: 'turn_context', payload: { turn_id: turnId, model: 'gpt-5.4' } });
const done = (ts, turnId) => JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId } });

test('Codex subagent rollouts keep their own session id when the parent session_meta is copied in', async () => {
  const root = mkdtempSync(join(tmpdir(), 'atm-codex-multimeta-'));
  const dir = join(root, 'sessions', '2026', '11', '20');
  mkdirSync(dir, { recursive: true });
  const parentId = '33333333-3333-7333-8333-333333333333';
  const childId = '44444444-4444-7444-8444-444444444444';
  const parentFile = join(dir, `rollout-2026-11-20T09-00-00-${parentId}.jsonl`);
  const childFile = join(dir, `rollout-2026-11-20T09-05-00-${childId}.jsonl`);

  writeFileSync(
    parentFile,
    [
      JSON.stringify({ timestamp: '2026-11-20T09:00:00Z', type: 'session_meta', payload: { id: parentId, cwd: '/tmp/parent', source: 'vscode' } }),
      ctx('2026-11-20T09:00:01Z', 'pt-1'),
      tc('2026-11-20T09:00:05Z', 1000, 100, 1000, 100),
      done('2026-11-20T09:00:06Z', 'pt-1'),
    ].join('\n') + '\n'
  );
  // Line 0 is the subagent's own meta; line 1 is the parent's meta copied in with the inherited history.
  writeFileSync(
    childFile,
    [
      JSON.stringify({
        timestamp: '2026-11-20T09:05:00Z',
        type: 'session_meta',
        payload: {
          id: childId,
          forked_from_id: parentId,
          cwd: '/tmp/child',
          source: { subagent: { thread_spawn: { parent_thread_id: parentId, depth: 1 } } },
        },
      }),
      JSON.stringify({ timestamp: '2026-11-20T09:00:00Z', type: 'session_meta', payload: { id: parentId, cwd: '/tmp/parent', source: 'vscode' } }),
      ctx('2026-11-20T09:05:00Z', 'pt-1'),
      tc('2026-11-20T09:05:00Z', 1000, 100, 1000, 100),
      done('2026-11-20T09:05:00Z', 'pt-1'),
      ctx('2026-11-20T09:05:10Z', 'ct-1'),
      tc('2026-11-20T09:05:20Z', 1600, 160, 600, 60),
      done('2026-11-20T09:05:21Z', 'ct-1'),
    ].join('\n') + '\n'
  );
  const old = new Date('2026-11-20T10:00:00Z');
  utimesSync(parentFile, old, old);
  utimesSync(childFile, old, old);

  const store = new TurnStore(':memory:');
  try {
    const adapter = new CodexAdapter({ store, sessionsDir: join(root, 'sessions'), archivedDir: join(root, 'arch') });
    await adapter.scan({ maxRecentFiles: Infinity });

    const rows = store.db
      .prepare(`SELECT session_id, turn_id, workspace_path, total_input_tokens, output_tokens FROM turns WHERE tool = 'codex' ORDER BY turn_id`)
      .all()
      .map((r) => ({ sid: r.session_id, tid: r.turn_id, ws: r.workspace_path, in: r.total_input_tokens, out: r.output_tokens }));
    assert.deepEqual(rows, [
      { sid: childId, tid: 'ct-1', ws: '/tmp/child', in: 600, out: 60 },
      { sid: parentId, tid: 'pt-1', ws: '/tmp/parent', in: 1000, out: 100 },
    ]);

    // Ownership lives in codex_call_owner keyed by a small file id, not in call_owner.
    assert.equal(store.db.prepare(`SELECT count(*) AS n FROM call_owner`).get().n, 0);
    assert.ok(store.db.prepare(`SELECT count(*) AS n FROM codex_call_owner`).get().n >= 2);
    assert.equal(store.db.prepare(`SELECT count(*) AS n FROM ingest_file`).get().n, 2);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Codex unreadable rollouts back off, warn once, and do not hold the ingest reset open', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'atm-codex-readfail-'));
  const dir = join(root, 'sessions', '2026', '11', '21');
  mkdirSync(dir, { recursive: true });
  const goodFile = join(dir, 'rollout-2026-11-21T08-00-00-55555555-5555-7555-8555-555555555555.jsonl');
  const badFile = join(dir, 'rollout-2026-11-21T08-10-00-66666666-6666-7666-8666-666666666666.jsonl.zst');
  writeFileSync(
    goodFile,
    [
      JSON.stringify({ timestamp: '2026-11-21T08:00:00Z', type: 'session_meta', payload: { id: '55555555-5555-7555-8555-555555555555' } }),
      ctx('2026-11-21T08:00:01Z', 'g-1'),
      tc('2026-11-21T08:00:05Z', 700, 70, 700, 70),
      done('2026-11-21T08:00:06Z', 'g-1'),
    ].join('\n') + '\n'
  );
  writeFileSync(badFile, Buffer.from('definitely not zstd data'));
  const old = new Date('2026-11-21T09:00:00Z');
  utimesSync(goodFile, old, old);
  utimesSync(badFile, old, old);

  const warn = t.mock.method(console, 'warn', () => {});
  const store = new TurnStore(':memory:');
  try {
    assert.equal(store.getCodexIngestResetPending(), true);
    const adapter = new CodexAdapter({ store, sessionsDir: join(root, 'sessions'), archivedDir: join(root, 'arch') });

    await adapter.scan({ maxRecentFiles: 12 });
    assert.equal(store.getCodexIngestResetPending(), false, 'a bad file must not keep the reset pending');
    assert.equal(store.db.prepare(`SELECT count(*) AS n FROM turns WHERE turn_id = 'g-1'`).get().n, 1);
    const readWarnings = () => warn.mock.calls.filter((c) => String(c.arguments[0]).includes('could not be read')).length;
    assert.equal(readWarnings(), 1);
    assert.equal(adapter.readFailures.get(badFile)?.attempts, 1);

    // Within the backoff window the file is skipped, not re-read.
    await adapter.scan({ maxRecentFiles: 12 });
    assert.equal(adapter.readFailures.get(badFile)?.attempts, 1);

    // Once the backoff expires it is retried quietly (no second warning for the same file state).
    adapter.readFailures.get(badFile).retryAtMs = 0;
    await adapter.scan({ maxRecentFiles: 12 });
    assert.equal(adapter.readFailures.get(badFile)?.attempts, 2);
    assert.equal(readWarnings(), 1);

    if (zstdCompressSync) {
      // A repaired file (new size/mtime) is retried immediately and ingested.
      const fixed = [
        JSON.stringify({ timestamp: '2026-11-21T08:10:00Z', type: 'session_meta', payload: { id: '66666666-6666-7666-8666-666666666666' } }),
        ctx('2026-11-21T08:10:01Z', 'b-1'),
        tc('2026-11-21T08:10:05Z', 300, 30, 300, 30),
        done('2026-11-21T08:10:06Z', 'b-1'),
      ].join('\n');
      writeFileSync(badFile, zstdCompressSync(Buffer.from(fixed, 'utf8')));
      const later = new Date('2026-11-21T09:30:00Z');
      utimesSync(badFile, later, later);
      await adapter.scan({ maxRecentFiles: 12 });
      assert.equal(adapter.readFailures.has(badFile), false);
      assert.equal(store.db.prepare(`SELECT count(*) AS n FROM turns WHERE turn_id = 'b-1'`).get().n, 1);
    }
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Parser-rev reset keeps Codex claims of pruned files, drops live ones, and clears legacy call_owner keys', () => {
  const root = mkdtempSync(join(tmpdir(), 'atm-codex-owner-reset-'));
  const dbPath = join(root, 'meter.db');
  const liveFile = join(root, 'rollout-live.jsonl');
  writeFileSync(liveFile, '\n');
  const prunedFile = join(root, 'rollout-pruned.jsonl');
  try {
    const s1 = new TurnStore(dbPath);
    s1.claimCodexCallKeys(liveFile, new Set(['codex:tc:live-root:1']));
    s1.claimCodexCallKeys(prunedFile, new Set(['codex:tc:pruned-root:1', 'codex:resp:pruned-root:r1']));
    s1.db.prepare(`INSERT INTO call_owner (call_key, file_path) VALUES (?, ?)`).run('codex:tc:legacy:1', liveFile);
    s1.db.prepare(`INSERT INTO call_owner (call_key, file_path) VALUES (?, ?)`).run('msg_1|req_1', prunedFile);
    assert.equal(s1.isCodexCallOwnedByOtherFile('codex:tc:live-root:1', liveFile), false);
    assert.equal(s1.isCodexCallOwnedByOtherFile('codex:tc:live-root:1', prunedFile), true);
    assert.equal(s1.isCodexCallOwnedByOtherFile('codex:tc:unclaimed:1', liveFile), false);
    s1.setMeta('ingest_parser_rev', 2);
    s1.setMeta('ingest_reset_cleared_rev', 2);
    s1.close();

    const s2 = new TurnStore(dbPath);
    try {
      const keys = s2.db.prepare(`SELECT call_key FROM codex_call_owner ORDER BY call_key`).all().map((r) => r.call_key);
      assert.deepEqual(keys, ['codex:resp:pruned-root:r1', 'codex:tc:pruned-root:1']);
      const legacy = s2.db.prepare(`SELECT call_key FROM call_owner ORDER BY call_key`).all().map((r) => r.call_key);
      assert.deepEqual(legacy, ['msg_1|req_1']);
      // Prefix lookup (range query) still finds a parent known only through its claimed token keys.
      assert.equal(s2.resolveCodexLineageRoot('kid-a', 'pruned-root').hasKnownParent, true);
      assert.equal(s2.resolveCodexLineageRoot('kid-b', 'never-seen').hasKnownParent, false);
    } finally {
      s2.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Forked rollout with an unknown parent skips only the file-level baseline, never a later turn', () => {
  const meta = JSON.stringify({
    timestamp: '2026-07-10T09:13:12Z',
    type: 'session_meta',
    payload: { id: 'kid-1', source: { subagent: { thread_spawn: { parent_thread_id: 'missing-parent' } } } },
  });
  const started = (ts, id) => JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'task_started', turn_id: id } });
  const content = [
    meta,
    started('2026-07-10T09:13:13Z', 'k-1'),
    ctx('2026-07-10T09:13:13Z', 'k-1'),
    tc('2026-07-10T09:13:20Z', 300, 30, 300, 30),
    tc('2026-07-10T09:13:30Z', 700, 70, 400, 40),
    started('2026-07-10T09:20:00Z', 'k-2'),
    ctx('2026-07-10T09:20:00Z', 'k-2'),
    tc('2026-07-10T09:20:10Z', 850, 85, 150, 15),
    done('2026-07-10T09:20:11Z', 'k-2'),
  ].join('\n');
  const turns = parseCodexSessionDetailed(content, '/x/rollout-kid-1.jsonl', { flushOpenTurns: true }).turns;
  assert.deepEqual(
    turns.map((t) => [t.turnId, t.totalInputTokens, t.outputTokens]).sort(),
    [
      ['k-1', 700, 70],
      ['k-2', 150, 15],
    ]
  );

  // The inherited baseline (first token_count, cumulative total above its own delta) is still skipped.
  const withBaseline = [
    meta,
    ctx('2026-07-10T09:13:13Z', 'k-1'),
    tc('2026-07-10T09:13:13Z', 5000, 500, 900, 90),
    tc('2026-07-10T09:13:20Z', 5300, 530, 300, 30),
    done('2026-07-10T09:13:21Z', 'k-1'),
  ].join('\n');
  const t2 = parseCodexSessionDetailed(withBaseline, '/x/rollout-kid-1.jsonl', { flushOpenTurns: true }).turns;
  assert.deepEqual(t2.map((t) => [t.turnId, t.totalInputTokens]), [['k-1', 300]]);
});

test('Gemini Flash rates follow the published schedule and Antigravity codenames resolve', () => {
  const rate = (m) => resolveModelPricing(m);
  for (const m of ['gemini-3.8-flash', 'gemini-3.8-flash-n', 'gemini-3.8-flash-tiered', 'gemini-3.6-flash', 'Gemini 3.6 Flash (High)', 'gemini-3.7-flash', 'gemini-3.7-flash-exp-b', 'gemini-flash-worker-agy']) {
    assert.equal(rate(m)?.input, 0.75, m);
    assert.equal(rate(m)?.output, 3.75, m);
  }
  assert.equal(rate('gemini-3-flash-a')?.input, 0.5);
  assert.equal(rate('gemini-3-flash-a')?.output, 3.0);

  const turn = (completedAtMs) => ({
    model: 'gemini-3.8-flash-n',
    completedAtMs,
    usageBuckets: [{ m: 'gemini-3.8-flash-n', b: 'le_200k', c: 1, in: 1_000_000, u: 1_000_000, cr: 0, cw5: 0, cw1h: 0, out: 1_000_000 }],
  });
  assert.equal(estimateTurnCost(turn(Date.UTC(2026, 11, 15))).costUsd, 4.5);
  assert.equal(estimateTurnCost(turn(Date.UTC(2027, 0, 2))).costUsd, 9.0);
});
