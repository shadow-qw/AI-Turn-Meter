import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ClaudeCodeAdapter,
  parseClaudeCodeSessionContent,
} from '../packages/daemon/src/adapters/claude-code.mjs';
import { estimateTurnCost } from '../packages/daemon/src/pricing.mjs';
import {
  assembleAllQuotas,
  computeQuotaWindow,
  fetchAntigravityQuota,
  normalizeCodexRateWindows,
} from '../packages/daemon/src/quota.mjs';
import { TurnStore } from '../packages/daemon/src/store.mjs';

function startMockAntigravityServer({ userStatus, quotaSummary, summaryStatus = 200 }) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        if (req.headers['x-codeium-csrf-token'] !== 'test-csrf') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        if (req.url === '/exa.language_server_pb.LanguageServerService/GetUserStatus') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(userStatus));
          return;
        }
        if (req.url === '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary') {
          res.writeHead(summaryStatus, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(quotaSummary));
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        port: addr.port,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

test('computeQuotaWindow passes through optional group/windowKind cleanly and omits when absent', () => {
  const nowMs = Date.UTC(2026, 10, 23, 12, 0, 0);
  const plain = computeQuotaWindow({
    id: 'plain',
    title: 'Plain',
    remainingPct: 75,
    nowMs,
  });
  assert.equal(plain.id, 'plain');
  assert.equal(plain.remainingPct, 75);
  assert.equal('group' in plain, false);
  assert.equal('windowKind' in plain, false);

  const tagged = computeQuotaWindow({
    id: 'ag-gemini-5h',
    title: 'Gemini 会话',
    remainingPct: 82.5,
    windowSeconds: 18000,
    resetAtMs: nowMs + 3 * 3600 * 1000,
    nowMs,
    group: 'Gemini',
    windowKind: '5h',
  });
  assert.equal(tagged.group, 'Gemini');
  assert.equal(tagged.windowKind, '5h');
  assert.equal(tagged.remainingPct, 82.5);
});

test('fetchAntigravityQuota emits 5h + weekly windows for Gemini and Claude/GPT plus Argon with group/windowKind', async () => {
  const nowMs = Date.UTC(2026, 10, 23, 10, 0, 0);
  const in3h = new Date(nowMs + 3 * 3600 * 1000).toISOString();
  const in4d = new Date(nowMs + 4 * 86400 * 1000).toISOString();

  const srv = await startMockAntigravityServer({
    userStatus: {
      userStatus: {
        email: 'dev@example.com',
        userTier: { name: 'Google AI Ultra' },
      },
    },
    quotaSummary: {
      response: {
        groups: [
          {
            buckets: [
              { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.85, resetTime: in3h },
              { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.62, resetTime: in4d },
              { bucketId: '3p-5h', window: '5h', remainingFraction: 0.4, resetTime: in3h },
              { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.72, resetTime: in4d },
              {
                bucketId: 'gemini-argon-wtu-weekly',
                window: 'weekly',
                remainingFraction: 0.91,
                resetTime: in4d,
              },
            ],
          },
        ],
      },
    },
  });

  try {
    const quota = await fetchAntigravityQuota(nowMs, {
      inspectServers: async () => ({
        servers: [{ pid: 1001, httpPort: srv.port, ports: [srv.port], csrf: 'test-csrf' }],
        runningWithoutCsrfToken: false,
        detectedVersion: '2.34.0',
      }),
    });

    assert.equal(quota.accountEmail, 'dev@example.com');
    assert.equal(quota.planTitle, 'Google AI Ultra');
    assert.equal(quota.quotaHint, null);
    assert.equal(quota.quotaWindows.length, 5);

    assert.deepEqual(
      quota.quotaWindows.map((w) => ({
        id: w.id,
        title: w.title,
        group: w.group,
        windowKind: w.windowKind,
        remainingPct: w.remainingPct,
      })),
      [
        { id: 'ag-gemini-5h', title: 'Gemini 会话', group: 'Gemini', windowKind: '5h', remainingPct: 85 },
        { id: 'ag-gemini-weekly', title: 'Gemini 每周', group: 'Gemini', windowKind: 'weekly', remainingPct: 62 },
        {
          id: 'ag-claude-gpt-5h',
          title: 'Claude / GPT 会话',
          group: 'Claude / GPT',
          windowKind: '5h',
          remainingPct: 40,
        },
        {
          id: 'ag-claude-gpt-weekly',
          title: 'Claude / GPT 每周',
          group: 'Claude / GPT',
          windowKind: 'weekly',
          remainingPct: 72,
        },
        {
          id: 'ag-argon-weekly',
          title: 'Gemini 4 Argon',
          group: 'Gemini 4 Argon',
          windowKind: 'weekly',
          remainingPct: 91,
        },
      ]
    );

    const assembled = assembleAllQuotas({
      codex: { accountEmail: null, planTitle: null, quotaWindows: [], resetCreditsText: null },
      cursor: { accountEmail: null, planTitle: null, quotaWindows: [], resetCreditsText: null },
      codebuddy: { accountEmail: null, planTitle: null, quotaWindows: [], resetCreditsText: null },
      antigravity: quota,
    });
    const ovAg = assembled.all.quotaWindows.find((w) => w.id === 'overview-antigravity');
    assert.ok(ovAg);
    assert.equal(ovAg.title, 'Antigravity');
    assert.equal(ovAg.remainingPct, 85);
    assert.match(ovAg.subtitle || '', /每周 62%/);
    assert.equal(ovAg.group, undefined);
    assert.equal(ovAg.windowKind, undefined);
  } finally {
    await srv.close();
  }
});

test('fetchAntigravityQuota fallback model configs and normalizeCodexRateWindows include group/windowKind metadata', async () => {
  const nowMs = Date.UTC(2026, 10, 23, 10, 0, 0);
  const in2h = new Date(nowMs + 2 * 3600 * 1000).toISOString();

  const srv = await startMockAntigravityServer({
    userStatus: {
      userStatus: {
        email: 'fallback@example.com',
        planStatus: { planInfo: { planName: 'Pro' } },
        cascadeModelConfigData: {
          clientModelConfigs: [
            { label: 'Gemini 4 Pro', quotaInfo: { remainingFraction: 0.65, resetTime: in2h } },
            { label: 'Claude Sonnet 4.5', quotaInfo: { remainingFraction: 0.35, resetTime: in2h } },
          ],
        },
      },
    },
    quotaSummary: { response: { groups: [] } },
  });

  try {
    const quota = await fetchAntigravityQuota(nowMs, {
      inspectServers: async () => ({
        servers: [{ pid: 1002, httpPort: srv.port, ports: [srv.port], csrf: 'test-csrf' }],
        runningWithoutCsrfToken: false,
        detectedVersion: '2.33.0',
      }),
    });
    assert.equal(quota.quotaWindows.length, 2);
    assert.equal(quota.quotaWindows[0].id, 'ag-gemini');
    assert.equal(quota.quotaWindows[0].title, 'Gemini Models');
    assert.equal(quota.quotaWindows[0].group, 'Gemini');
    assert.equal(quota.quotaWindows[0].windowKind, '5h');
    assert.equal(quota.quotaWindows[1].id, 'ag-claude-gpt');
    assert.equal(quota.quotaWindows[1].title, 'Claude / GPT');
    assert.equal(quota.quotaWindows[1].group, 'Claude / GPT');
    assert.equal(quota.quotaWindows[1].windowKind, '5h');
  } finally {
    await srv.close();
  }

  const in3dSec = Math.floor((nowMs + 3 * 86400 * 1000) / 1000);
  const in2hSec = Math.floor((nowMs + 2 * 3600 * 1000) / 1000);
  const codexWins = normalizeCodexRateWindows(
    {
      primary_window: { used_percent: 20, limit_window_seconds: 18000, reset_at: in2hSec },
      secondary_window: { used_percent: 35, limit_window_seconds: 604800, reset_at: in3dSec },
    },
    nowMs
  );
  assert.equal(codexWins.length, 2);
  assert.equal(codexWins[0].id, 'codex-session');
  assert.equal(codexWins[0].group, 'Codex');
  assert.equal(codexWins[0].windowKind, '5h');
  assert.equal(codexWins[1].id, 'codex-weekly');
  assert.equal(codexWins[1].group, 'Codex');
  assert.equal(codexWins[1].windowKind, 'weekly');

  const monthlyWins = normalizeCodexRateWindows(
    {
      primary_window: { used_percent: 10, limit_window_seconds: 2592000, reset_at: in3dSec },
      secondary_window: null,
    },
    nowMs
  );
  assert.equal(monthlyWins.length, 1);
  assert.equal(monthlyWins[0].id, 'codex-monthly');
  assert.equal(monthlyWins[0].group, 'Codex');
  assert.equal(monthlyWins[0].windowKind, 'monthly');
});

test('parseClaudeCodeSessionContent groups turns, deduplicates message.id chunks, accounts cache tokens, and subtracts tool wait', () => {
  const jsonl = [
    // Meta user message must not start a turn
    JSON.stringify({
      type: 'user',
      isMeta: true,
      sessionId: 'cc-sess-1',
      cwd: '/Users/dev/my-repo',
      timestamp: '2026-11-23T08:00:00.000Z',
      message: { role: 'user', content: '<local-command-caveat>ignore</local-command-caveat>' },
    }),
    // Turn 1: user prompt -> streamed assistant msg_1 (thinking + tool_use) -> tool_result (3s wait) -> msg_2 (final text)
    JSON.stringify({
      type: 'user',
      sessionId: 'cc-sess-1',
      cwd: '/Users/dev/my-repo',
      timestamp: '2026-11-23T08:01:00.000Z',
      message: { role: 'user', content: 'Inspect quota.mjs and summarize' },
    }),
    // Streaming chunk 1 of msg_1 (partial output_tokens)
    JSON.stringify({
      type: 'assistant',
      sessionId: 'cc-sess-1',
      cwd: '/Users/dev/my-repo',
      timestamp: '2026-11-23T08:01:01.000Z',
      message: {
        id: 'msg_01A',
        model: 'claude-sonnet-4-5-20250929',
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'Let me read quota.mjs first.' }],
        usage: {
          input_tokens: 150,
          cache_read_input_tokens: 12000,
          cache_creation_input_tokens: 850,
          output_tokens: 20,
        },
      },
    }),
    // Streaming chunk 2 of msg_1 (final usage + tool_use)
    JSON.stringify({
      type: 'assistant',
      sessionId: 'cc-sess-1',
      cwd: '/Users/dev/my-repo',
      timestamp: '2026-11-23T08:01:02.000Z',
      message: {
        id: 'msg_01A',
        model: 'claude-sonnet-4-5-20250929',
        role: 'assistant',
        content: [
          { type: 'text', text: 'Reading quota.mjs now.' },
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'quota.mjs' } },
        ],
        stop_reason: 'tool_use',
        usage: {
          input_tokens: 150,
          cache_read_input_tokens: 12000,
          cache_creation_input_tokens: 850,
          output_tokens: 120,
        },
      },
    }),
    // Tool result (must NOT start a new turn; tool wait = 08:01:02 -> 08:01:05 = 3000ms)
    JSON.stringify({
      type: 'user',
      sessionId: 'cc-sess-1',
      cwd: '/Users/dev/my-repo',
      timestamp: '2026-11-23T08:01:05.000Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file contents...' }],
      },
    }),
    // Second assistant call msg_01B in Turn 1
    JSON.stringify({
      type: 'assistant',
      sessionId: 'cc-sess-1',
      cwd: '/Users/dev/my-repo',
      timestamp: '2026-11-23T08:01:08.000Z',
      message: {
        id: 'msg_01B',
        model: 'claude-sonnet-4-5-20250929',
        role: 'assistant',
        content: [{ type: 'text', text: 'Done: quota.mjs now splits 3p-5h and 3p-weekly cleanly.' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 50,
          cache_read_input_tokens: 13000,
          cache_creation_input_tokens: 200,
          output_tokens: 180,
        },
      },
    }),
    // Synthetic assistant message should be ignored
    JSON.stringify({
      type: 'assistant',
      sessionId: 'cc-sess-1',
      timestamp: '2026-11-23T08:01:09.000Z',
      message: {
        id: 'msg_synth',
        model: '<synthetic>',
        role: 'assistant',
        content: [{ type: 'text', text: 'Synthetic notice' }],
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }),
    // Turn 2: simple single-call turn without tools (e2e_turn)
    JSON.stringify({
      type: 'user',
      sessionId: 'cc-sess-1',
      cwd: '/Users/dev/my-repo',
      timestamp: '2026-11-23T08:02:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'Thanks! One quick question.' }] },
    }),
    JSON.stringify({
      type: 'assistant',
      sessionId: 'cc-sess-1',
      cwd: '/Users/dev/my-repo',
      timestamp: '2026-11-23T08:02:04.000Z',
      message: {
        id: 'msg_02A',
        model: 'claude-sonnet-4-5-20250929',
        role: 'assistant',
        content: [{ type: 'text', text: 'Happy to help — everything is ready.' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 14000,
          cache_creation_input_tokens: 0,
          output_tokens: 200,
        },
      },
    }),
  ].join('\n');

  const turns = parseClaudeCodeSessionContent(jsonl, {});
  assert.equal(turns.length, 2);

  // Turn 1 assertions
  const t1 = turns[0];
  assert.equal(t1.turnUid, 'claude_code:cc-sess-1:turn-1');
  assert.equal(t1.tool, 'claude_code');
  assert.equal(t1.host, 'claude-code');
  assert.equal(t1.sessionId, 'cc-sess-1');
  assert.equal(t1.turnId, 'turn-1');
  assert.equal(t1.model, 'claude-sonnet-4-5-20250929');
  assert.equal(t1.workspacePath, '/Users/dev/my-repo');
  assert.equal(t1.callCount, 2);
  // msg_01A (150 + 12000 + 850 = 13000) + msg_01B (50 + 13000 + 200 = 13250) = 26250
  assert.equal(t1.uncachedInputTokens, 200);
  assert.equal(t1.cacheReadTokens, 25000);
  assert.equal(t1.cacheWriteTokens, 1050);
  assert.equal(t1.totalInputTokens, 26250);
  // msg_01A deduplicated max output = 120 (not 20+120=140), msg_01B = 180 -> 300
  assert.equal(t1.outputTokens, 300);
  // Duration = 8000ms, tool wait = 3000ms -> active = 5000ms -> 300 / 5 = 60 tok/s
  assert.equal(t1.durationMs, 8000);
  assert.equal(t1.modelActiveMs, 5000);
  assert.equal(t1.tpsMethod, 'e2e_minus_tools');
  assert.equal(t1.tps, 60);
  assert.equal(t1.replyPreview, 'Done: quota.mjs now splits 3p-5h and 3p-weekly cleanly.');

  // Pricing integration sanity check for Claude model with cache read/write
  const cost = estimateTurnCost(t1);
  assert.equal(cost.priced, true);
  assert.ok(cost.costUsd > 0);
  assert.ok(cost.savingsUsd > 0);

  // Turn 2 assertions
  const t2 = turns[1];
  assert.equal(t2.turnUid, 'claude_code:cc-sess-1:turn-2');
  assert.equal(t2.callCount, 1);
  assert.equal(t2.uncachedInputTokens, 100);
  assert.equal(t2.cacheReadTokens, 14000);
  assert.equal(t2.cacheWriteTokens, 0);
  assert.equal(t2.totalInputTokens, 14100);
  assert.equal(t2.outputTokens, 200);
  assert.equal(t2.durationMs, 4000);
  assert.equal(t2.modelActiveMs, 4000);
  assert.equal(t2.tpsMethod, 'e2e_turn');
  assert.equal(t2.tps, 50);
  assert.equal(t2.replyPreview, 'Happy to help — everything is ready.');
});

test('ClaudeCodeAdapter discovers ~/.claude/projects/*.jsonl and performs incremental scan with ingested_files', () => {
  const root = mkdtempSync(join(tmpdir(), 'atm-cc-'));
  const store = new TurnStore(':memory:');
  try {
    const projA = join(root, 'projects', '-Users-dev-repo-a');
    const projB = join(root, 'projects', '-Users-dev-repo-b');
    mkdirSync(projA, { recursive: true });
    mkdirSync(projB, { recursive: true });

    const sessFileA = join(projA, 'sess-a.jsonl');
    const sessFileB = join(projB, 'sess-b.jsonl');

    writeFileSync(
      sessFileA,
      [
        JSON.stringify({
          type: 'user',
          sessionId: 'sess-a',
          cwd: '/Users/dev/repo-a',
          timestamp: '2026-11-23T09:00:00.000Z',
          message: { role: 'user', content: 'Hello A' },
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 'sess-a',
          cwd: '/Users/dev/repo-a',
          timestamp: '2026-11-23T09:00:02.000Z',
          message: {
            id: 'm-a1',
            model: 'claude-opus-4-5-20251101',
            role: 'assistant',
            content: [{ type: 'text', text: 'Reply A1' }],
            usage: { input_tokens: 500, cache_read_input_tokens: 4000, cache_creation_input_tokens: 100, output_tokens: 100 },
          },
        }),
      ].join('\n') + '\n'
    );

    writeFileSync(
      sessFileB,
      [
        JSON.stringify({
          type: 'user',
          cwd: '/Users/dev/repo-b',
          timestamp: '2026-11-23T09:05:00.000Z',
          message: { role: 'user', content: 'Hello B' },
        }),
        JSON.stringify({
          type: 'assistant',
          cwd: '/Users/dev/repo-b',
          timestamp: '2026-11-23T09:05:03.000Z',
          message: {
            id: 'm-b1',
            model: 'claude-sonnet-4-5-20250929',
            role: 'assistant',
            content: [{ type: 'text', text: 'Reply B1' }],
            usage: { input_tokens: 300, cache_read_input_tokens: 2000, output_tokens: 150 },
          },
        }),
      ].join('\n') + '\n'
    );
    // Ensure sessFileB has a strictly newer mtime than sessFileA
    const tOld = new Date('2026-11-23T09:00:05.000Z');
    const tNew = new Date('2026-11-23T09:05:05.000Z');
    utimesSync(sessFileA, tOld, tOld);
    utimesSync(sessFileB, tNew, tNew);

    const emitted = [];
    let enabled = true;
    const adapter = new ClaudeCodeAdapter({
      store,
      claudeRoot: root,
      onTurns: (turns) => emitted.push(...turns),
      isEnabled: () => enabled,
    });

    const listed = adapter.listSessionFiles();
    assert.equal(listed.length, 2);
    assert.equal(listed[0].sessionId, 'sess-b');
    assert.equal(listed[1].sessionId, 'sess-a');

    // Initial scan ingests both sessions and records ingested_files
    const first = adapter.scan();
    assert.equal(first.length, 2);
    assert.equal(emitted.length, 2);
    assert.ok(store.getIngestedFile(sessFileA));
    assert.ok(store.getIngestedFile(sessFileB));
    // sess-b lacked sessionId field in JSONL, so filename fallback 'sess-b' is used
    assert.ok(first.some((r) => r.turnUid === 'claude_code:sess-b:turn-1'));
    assert.ok(first.some((r) => r.turnUid === 'claude_code:sess-a:turn-1'));

    // Re-scanning unchanged files produces 0 changes (both in-memory and fresh adapter via ingested_files)
    assert.equal(adapter.scan().length, 0);
    const freshAdapter = new ClaudeCodeAdapter({ store, claudeRoot: root });
    assert.equal(freshAdapter.scan().length, 0);

    // Appending Turn 2 to sessFileA triggers incremental ingest of only the new turn
    appendFileSync(
      sessFileA,
      [
        JSON.stringify({
          type: 'user',
          sessionId: 'sess-a',
          cwd: '/Users/dev/repo-a',
          timestamp: '2026-11-23T09:10:00.000Z',
          message: { role: 'user', content: 'Second turn in A' },
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 'sess-a',
          cwd: '/Users/dev/repo-a',
          timestamp: '2026-11-23T09:10:05.000Z',
          message: {
            id: 'm-a2',
            model: 'claude-opus-4-5-20251101',
            role: 'assistant',
            content: [{ type: 'text', text: 'Reply A2' }],
            usage: { input_tokens: 200, cache_read_input_tokens: 5000, output_tokens: 250 },
          },
        }),
      ].join('\n') + '\n'
    );
    const tAppended = new Date('2026-11-23T09:10:06.000Z');
    utimesSync(sessFileA, tAppended, tAppended);

    const second = adapter.scan();
    assert.equal(second.length, 1);
    assert.equal(second[0].turnUid, 'claude_code:sess-a:turn-2');
    assert.equal(second[0].totalInputTokens, 5200);
    assert.equal(second[0].outputTokens, 250);
    assert.equal(second[0].replyPreview, 'Reply A2');

    // Disabled adapter skips scanning cleanly
    enabled = false;
    assert.deepEqual(adapter.scan(), []);

    // start() / stop() lifecycle cleans up timers and watchers
    adapter.start();
    adapter.stop();
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
