import assert from 'node:assert/strict';
import { createCipheriv, createHash, pbkdf2Sync } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import test from 'node:test';

import { openSingleApp } from '../packages/daemon/bin/cli.mjs';
import {
  ClaudeCodeAdapter,
  parseClaudeCodeSessionContent,
} from '../packages/daemon/src/adapters/claude-code.mjs';
import { APP_SPECS } from '../packages/daemon/src/apps.mjs';
import { getDefaultCdpSpecs } from '../packages/daemon/src/cdp-injector.mjs';
import {
  buildCurlNoProxyList,
  curlFetchRaw,
  httpRequestRaw,
  isLoopbackUrl,
  normalizeProxyUrl,
} from '../packages/daemon/src/net.mjs';
import { classifyContextBand, estimateTurnCost } from '../packages/daemon/src/pricing.mjs';
import {
  assembleAllQuotas,
  computeQuotaWindow,
  decryptClaudeCookieValue,
  decryptClaudeSafeStorageString,
  decryptElectronSafeStorageBuffer,
  extractOAuthTokensFromClaudeConfig,
  fetchAntigravityQuota,
  fetchClaudeQuota,
  formatClaudePlan,
  getAllQuotas,
  normalizeClaudeCookieInput,
  normalizeCodexRateWindows,
  parseClaudeCliCredentialsJson,
  parseClaudeQuotaUsage,
  readClaudeDesktopCookies,
  readClaudePlanUsageHistory,
  readClaudeSettingsProxyUrl,
  resetQuotaCacheForTests,
  resolveClaudeProxyConfig,
} from '../packages/daemon/src/quota.mjs';
import { createMeterServer } from '../packages/daemon/src/server.mjs';
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
  assert.equal(t1.turnUid, 'claude:cc-sess-1:turn-1');
  assert.equal(t1.tool, 'claude');
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
  assert.equal(t2.turnUid, 'claude:cc-sess-1:turn-2');
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
    assert.ok(first.some((r) => r.turnUid === 'claude:sess-b:turn-1'));
    assert.ok(first.some((r) => r.turnUid === 'claude:sess-a:turn-1'));

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
    assert.equal(second[0].turnUid, 'claude:sess-a:turn-2');
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

function encryptElectronSafeStorage(plainBuffer, password) {
  const key = pbkdf2Sync(Buffer.from(password, 'utf8'), Buffer.from('saltysalt', 'utf8'), 1003, 16, 'sha1');
  const iv = Buffer.alloc(16, 0x20);
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  const enc = Buffer.concat([cipher.update(plainBuffer), cipher.final()]);
  return Buffer.concat([Buffer.from('v10', 'utf8'), enc]);
}

function startMockClaudeServer(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      handler(req, res);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

test('Claude Safe Storage decryption strips Chromium v24 host hash prefix on cookies but not oauth cache strings', () => {
  const pw = 'synthetic-claude-keychain-pw';
  const secretTokenJson = JSON.stringify({
    'acct:user-1|client:org-1': { token: 'sk-ant-oat01-test', expiresAt: Date.now() + 3600_000 },
  });
  const encStringB64 = encryptElectronSafeStorage(Buffer.from(secretTokenJson, 'utf8'), pw).toString('base64');
  assert.equal(decryptClaudeSafeStorageString(encStringB64, ['wrong', pw]), secretTokenJson);
  assert.equal(decryptElectronSafeStorageBuffer(Buffer.from('plain'), [pw]), null);

  const hostHash = createHash('sha256').update('.claude.ai').digest();
  const cookiePlain = Buffer.concat([hostHash, Buffer.from('sk-ant-sid01-abc', 'utf8')]);
  const encCookieV24 = encryptElectronSafeStorage(cookiePlain, pw);
  assert.equal(decryptClaudeCookieValue(encCookieV24, '.claude.ai', [pw], 24), 'sk-ant-sid01-abc');

  const encCookieLegacy = encryptElectronSafeStorage(Buffer.from('sk-ant-sid01-legacy', 'utf8'), pw);
  assert.equal(decryptClaudeCookieValue(encCookieLegacy, '.claude.ai', [pw], 23), 'sk-ant-sid01-legacy');

  assert.equal(normalizeClaudeCookieInput('Cookie: sessionKey=abc; cf_clearance=xyz'), 'sessionKey=abc; cf_clearance=xyz');
  assert.equal(normalizeClaudeCookieInput('sk-ant-sid01-raw'), 'sessionKey=sk-ant-sid01-raw');
});

test('extractOAuthTokensFromClaudeConfig, readClaudeDesktopCookies, and readClaudePlanUsageHistory extract local state cleanly', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'atm-claude-local-'));
  try {
    const pw = 'synthetic-claude-keychain-pw';
    const nowMs = Date.UTC(2026, 10, 25, 12, 0, 0);
    const futureExp = nowMs + 7200_000;

    const tokenMap = {
      'acct:other-uuid|k1': { token: 'sk-ant-oat01-other', expiresAt: futureExp + 1000, subscriptionType: 'pro' },
      'acct:active-uuid|k2': {
        token: 'sk-ant-oat01-active',
        expiresAt: futureExp,
        subscriptionType: 'max',
        rateLimitTier: 'default_claude_max_5x',
      },
      'acct:active-uuid|expired': { token: 'sk-ant-oat01-expired', expiresAt: nowMs - 1000 },
    };
    const cfg = {
      lastKnownAccountUuid: 'ACTIVE-UUID',
      'dxt:allowlistEnabled:11111111-2222-3333-4444-555555555555': true,
      'oauth:tokenCacheV2': encryptElectronSafeStorage(Buffer.from(JSON.stringify(tokenMap), 'utf8'), pw).toString('base64'),
    };
    const extracted = extractOAuthTokensFromClaudeConfig(cfg, [pw], nowMs);
    assert.equal(extracted.hasEncryptedOAuthCache, false);
    assert.equal(extracted.fallbackOrgUuid, '11111111-2222-3333-4444-555555555555');
    assert.equal(extracted.tokens.length, 2);
    assert.equal(extracted.tokens[0].token, 'sk-ant-oat01-active');

    const locked = extractOAuthTokensFromClaudeConfig(cfg, [], nowMs);
    assert.equal(locked.hasEncryptedOAuthCache, true);
    assert.equal(locked.tokens.length, 0);

    const cliParsed = parseClaudeCliCredentialsJson(
      JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-cli', expiresAt: futureExp, subscriptionType: 'pro' } })
    );
    assert.equal(cliParsed.token, 'sk-ant-oat01-cli');

    const dbPath = join(tmp, 'Cookies');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, expires_utc INTEGER);
    `);
    db.prepare(`INSERT INTO meta (key, value) VALUES ('version', '24')`).run();
    const futureChromeUtc = (nowMs + 86400_000 + 11644473600000) * 1000;
    const hostHash = createHash('sha256').update('.claude.ai').digest();
    db.prepare(`INSERT INTO cookies VALUES (?, ?, '', ?, ?)`).run(
      '.claude.ai',
      'sessionKey',
      encryptElectronSafeStorage(Buffer.concat([hostHash, Buffer.from('sk-ant-sid01-cookie', 'utf8')]), pw),
      futureChromeUtc
    );
    db.prepare(`INSERT INTO cookies VALUES (?, ?, '', ?, ?)`).run(
      '.claude.ai',
      'lastActiveOrg',
      encryptElectronSafeStorage(Buffer.concat([hostHash, Buffer.from('org-uuid-123', 'utf8')]), pw),
      futureChromeUtc
    );
    db.close();

    const cookiesOk = readClaudeDesktopCookies(dbPath, [pw], nowMs);
    assert.equal(cookiesOk.hasEncryptedCookies, false);
    assert.equal(cookiesOk.lastActiveOrg, 'org-uuid-123');
    assert.ok(cookiesOk.cookieHeader.includes('sessionKey=sk-ant-sid01-cookie'));

    const cookiesLocked = readClaudeDesktopCookies(dbPath, [], nowMs);
    assert.equal(cookiesLocked.cookieHeader, null);
    assert.equal(cookiesLocked.hasEncryptedCookies, true);

    const historyPath = join(tmp, 'plan-usage-history.json');
    writeFileSync(
      historyPath,
      JSON.stringify({
        version: 2,
        samples: [{ t: nowMs - 600_000, org: 'org-uuid-123', u: { fh: 25, sd: 12 } }],
      })
    );
    const hist = readClaudePlanUsageHistory(historyPath, nowMs);
    assert.equal(hist.orgUuid, 'org-uuid-123');
    assert.deepEqual(hist.latestSample.u, { fh: 25, sd: 12 });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('parseClaudeQuotaUsage and assembleAllQuotas normalize 5h/weekly, weekly cap, model limits, and extra_usage', () => {
  const nowMs = Date.UTC(2026, 10, 25, 12, 0, 0);
  const in3h = new Date(nowMs + 3 * 3600 * 1000).toISOString();
  const in4d = new Date(nowMs + 4 * 86400 * 1000).toISOString();

  assert.equal(formatClaudePlan('claude_max', 'default_claude_max_20x'), 'Max 20x');
  assert.equal(formatClaudePlan('claude_pro', null), 'Pro');

  const parsed = parseClaudeQuotaUsage(
    {
      five_hour: { utilization: 32, resets_at: in3h },
      seven_day: { utilization: 18, resets_at: in4d },
      seven_day_sonnet: { utilization: 5, resets_at: in4d },
      limits: [
        {
          kind: 'weekly_scoped',
          group: 'model',
          percent: 12,
          resets_at: in4d,
          scope: { model: { display_name: 'Haiku' } },
        },
      ],
      extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1250, currency: 'USD' },
    },
    { nowMs, accountEmail: 'user@claude.ai', planTitle: 'Max 5x' }
  );

  assert.equal(parsed.accountEmail, 'user@claude.ai');
  assert.equal(parsed.planTitle, 'Max 5x');
  assert.equal(parsed.resetCreditsText, '$12.50 / $50.00');
  assert.equal(parsed.quotaWindows.length, 4);
  assert.equal(parsed.quotaWindows[0].id, 'claude-5h');
  assert.equal(parsed.quotaWindows[0].remainingPct, 68);
  assert.equal(parsed.quotaWindows[0].group, 'Claude');
  assert.equal(parsed.quotaWindows[0].windowKind, '5h');
  assert.equal(parsed.quotaWindows[1].id, 'claude-weekly');
  assert.equal(parsed.quotaWindows[1].remainingPct, 82);
  assert.equal(parsed.quotaWindows[2].id, 'claude-sonnet-weekly');
  assert.equal(parsed.quotaWindows[3].id, 'claude-limit-haiku');

  // Weekly 100% exhaustion caps 5h window to 0% remaining
  const capped = parseClaudeQuotaUsage(
    {
      five_hour: { utilization: 20, resets_at: in3h },
      seven_day: { utilization: 100, resets_at: in4d },
    },
    { nowMs }
  );
  assert.equal(capped.quotaWindows[0].remainingPct, 0);

  const assembled = assembleAllQuotas({
    codex: { accountEmail: null, planTitle: null, quotaWindows: [], resetCreditsText: null },
    claude: parsed,
    antigravity: { accountEmail: null, planTitle: null, quotaWindows: [], resetCreditsText: null },
    cursor: { accountEmail: null, planTitle: null, quotaWindows: [], resetCreditsText: null },
    codebuddy: { accountEmail: null, planTitle: null, quotaWindows: [], resetCreditsText: null },
  });
  const ovClaude = assembled.all.quotaWindows.find((w) => w.id === 'overview-claude');
  assert.ok(ovClaude);
  assert.equal(ovClaude.title, 'Claude');
  assert.equal(ovClaude.remainingPct, 68);
  assert.match(ovClaude.subtitle || '', /每周 82%/);
  assert.equal(assembled.all.accountEmail, '1 个已登录账号');
});

test('fetchClaudeQuota handles OAuth priority, Web Cookie fallback, 429 stale grace, and offline history fallback', async () => {
  resetQuotaCacheForTests();
  const tmp = mkdtempSync(join(tmpdir(), 'atm-claude-fetch-'));
  const homeDir = join(tmp, 'home');
  const supportDir = join(tmp, 'support');
  mkdirSync(join(homeDir, '.claude'), { recursive: true });
  mkdirSync(supportDir, { recursive: true });

  const nowMs = Date.UTC(2026, 10, 25, 14, 0, 0);
  const in2h = new Date(nowMs + 2 * 3600 * 1000).toISOString();
  const in3d = new Date(nowMs + 3 * 86400 * 1000).toISOString();

  let oauthStatus = 200;
  let webStatus = 200;

  const mockSrv = await startMockClaudeServer((req, res) => {
    if (req.url === '/api/oauth/usage') {
      if (oauthStatus !== 200) {
        res.writeHead(oauthStatus, { 'Content-Type': 'application/json', 'Retry-After': '120' });
        res.end(JSON.stringify({ error: 'status' }));
        return;
      }
      assert.equal(req.headers.authorization, 'Bearer sk-ant-oat01-cli');
      assert.equal(req.headers['anthropic-beta'], 'oauth-2025-04-20');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          five_hour: { utilization: 15, resets_at: in2h },
          seven_day: { utilization: 25, resets_at: in3d },
        })
      );
      return;
    }
    if (req.url === '/api/oauth/profile') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          account: { email: 'oauth@claude.ai' },
          organization: { organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_5x' },
        })
      );
      return;
    }
    if (req.url === '/api/organizations') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([{ uuid: 'org-web-1', name: 'Personal', capabilities: ['chat'], organization_type: 'claude_pro' }]));
      return;
    }
    if (req.url === '/api/organizations/org-web-1/usage') {
      if (webStatus !== 200) {
        res.writeHead(webStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'limited' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          five_hour: { utilization: 40, resets_at: in2h },
          seven_day: { utilization: 50, resets_at: in3d },
        })
      );
      return;
    }
    if (req.url === '/api/account') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          email_address: 'web@claude.ai',
          memberships: [{ organization: { uuid: 'org-web-1', organization_type: 'claude_pro' } }],
        })
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  try {
    writeFileSync(
      join(homeDir, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-cli', expiresAt: nowMs + 3600_000 } })
    );

    // 1. OAuth succeeds first
    const rOAuth = await fetchClaudeQuota(nowMs, {
      homeDir,
      claudeAppSupportDir: supportDir,
      claudeApiBaseUrl: mockSrv.url,
      claudeWebBaseUrl: mockSrv.url,
      forceRefresh: true,
    });
    assert.equal(rOAuth._ok, true);
    assert.equal(rOAuth.source, 'oauth');
    assert.equal(rOAuth.accountEmail, 'oauth@claude.ai');
    assert.equal(rOAuth.planTitle, 'Max 5x');
    assert.equal(rOAuth.quotaWindows[0].remainingPct, 85);

    // 2. OAuth 401 -> Web Cookie fallback
    oauthStatus = 401;
    const rWeb = await fetchClaudeQuota(nowMs, {
      homeDir,
      claudeAppSupportDir: supportDir,
      claudeApiBaseUrl: mockSrv.url,
      claudeWebBaseUrl: mockSrv.url,
      claudeCookie: 'sessionKey=sk-ant-sid01-web',
      forceRefresh: true,
    });
    assert.equal(rWeb._ok, true);
    assert.equal(rWeb.source, 'web');
    assert.equal(rWeb.accountEmail, 'web@claude.ai');
    assert.equal(rWeb.planTitle, 'Pro');
    assert.equal(rWeb.quotaWindows[0].remainingPct, 60);

    // 3. Stale grace preserves good snapshot via getAllQuotas when rate limited (429)
    resetQuotaCacheForTests();
    let claudeFetcherCalls = 0;
    const qOffDefault = await getAllQuotas(nowMs, {
      forceRefresh: true,
      _fetchers: {
        codex: async () => ({ accountEmail: null, planTitle: null, quotaWindows: [], resetCreditsText: null }),
        claude: async () => {
          claudeFetcherCalls += 1;
          return rWeb;
        },
        antigravity: async () => ({ accountEmail: null, planTitle: null, quotaWindows: [], resetCreditsText: null }),
        cursor: async () => ({ accountEmail: null, planTitle: null, quotaWindows: [], resetCreditsText: null }),
        codebuddy: () => ({ accountEmail: null, planTitle: null, quotaWindows: [], resetCreditsText: null }),
      },
    });
    assert.equal(claudeFetcherCalls, 0);
    assert.equal(qOffDefault.claude.quotaWindows.length, 0);
    assert.equal(qOffDefault.claude.accountEmail, null);
    assert.equal(qOffDefault.claude.planTitle, null);
    assert.match(qOffDefault.claude.quotaHint || '', /纯本地离线/);

    const q1 = await getAllQuotas(nowMs, {
      forceRefresh: true,
      claudeQuotaEnabled: true,
      _fetchers: {
        codex: async () => ({ accountEmail: null, planTitle: null, quotaWindows: [], resetCreditsText: null }),
        claude: async () => rWeb,
        antigravity: async () => ({ accountEmail: null, planTitle: null, quotaWindows: [], resetCreditsText: null }),
        cursor: async () => ({ accountEmail: null, planTitle: null, quotaWindows: [], resetCreditsText: null }),
        codebuddy: () => ({ accountEmail: null, planTitle: null, quotaWindows: [], resetCreditsText: null }),
      },
    });
    assert.equal(q1.claude.quotaWindows[0].remainingPct, 60);

    const q2 = await getAllQuotas(nowMs + 60_000, {
      forceRefresh: true,
      claudeQuotaEnabled: true,
      _fetchers: {
        codex: async () => ({ accountEmail: null, planTitle: null, quotaWindows: [], resetCreditsText: null }),
        claude: async () => ({
          accountEmail: null,
          planTitle: null,
          quotaWindows: [],
          resetCreditsText: null,
          _errorKind: 'rate_limit',
        }),
        antigravity: async () => ({ accountEmail: null, planTitle: null, quotaWindows: [], resetCreditsText: null }),
        cursor: async () => ({ accountEmail: null, planTitle: null, quotaWindows: [], resetCreditsText: null }),
        codebuddy: () => ({ accountEmail: null, planTitle: null, quotaWindows: [], resetCreditsText: null }),
      },
    });
    assert.equal(q2.claude.quotaWindows[0].remainingPct, 60);

    // Turning claudeQuotaEnabled back off immediately clears stale-grace windows
    const qOffAfterOn = await getAllQuotas(nowMs + 90_000, {
      forceRefresh: true,
      claudeQuotaEnabled: false,
      _fetchers: {
        codex: async () => ({ accountEmail: null, planTitle: null, quotaWindows: [], resetCreditsText: null }),
        claude: async () => {
          claudeFetcherCalls += 1;
          return rWeb;
        },
        antigravity: async () => ({ accountEmail: null, planTitle: null, quotaWindows: [], resetCreditsText: null }),
        cursor: async () => ({ accountEmail: null, planTitle: null, quotaWindows: [], resetCreditsText: null }),
        codebuddy: () => ({ accountEmail: null, planTitle: null, quotaWindows: [], resetCreditsText: null }),
      },
    });
    assert.equal(claudeFetcherCalls, 0);
    assert.equal(qOffAfterOn.claude.quotaWindows.length, 0);
    assert.match(qOffAfterOn.claude.quotaHint || '', /纯本地离线/);

    // 4. Offline local plan-usage-history.json weak fallback
    writeFileSync(
      join(supportDir, 'plan-usage-history.json'),
      JSON.stringify({
        version: 2,
        samples: [{ t: nowMs - 300_000, org: 'org-web-1', u: { fh: 12, sd: 34 } }],
      })
    );
    const rHist = await fetchClaudeQuota(nowMs, {
      allowNetwork: false,
      homeDir: join(tmp, 'empty-home'),
      claudeAppSupportDir: supportDir,
      forceRefresh: true,
    });
    assert.equal(rHist._ok, true);
    assert.equal(rHist.source, 'local-history');
    assert.equal(rHist.quotaWindows[0].remainingPct, 88);
    assert.equal(rHist.quotaWindows[1].remainingPct, 66);
  } finally {
    await mockSrv.close();
    resetQuotaCacheForTests();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('createMeterServer exposes hasClaudeCookie config and ingests ~/.claude sessions under tool=claude', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'atm-claude-srv-'));
  const stateDir = join(tmp, 'state');
  const claudeRoot = join(tmp, 'dot-claude');
  const projDir = join(claudeRoot, 'projects', '-Users-dev-proj');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(projDir, { recursive: true });

  writeFileSync(
    join(projDir, 's1.jsonl'),
    [
      JSON.stringify({
        type: 'user',
        sessionId: 's1',
        cwd: '/Users/dev/proj',
        timestamp: new Date(Date.now() - 5000).toISOString(),
        message: { role: 'user', content: 'hi' },
      }),
      JSON.stringify({
        type: 'assistant',
        sessionId: 's1',
        cwd: '/Users/dev/proj',
        timestamp: new Date(Date.now() - 1000).toISOString(),
        message: {
          id: 'm1',
          model: 'claude-sonnet-4-5-20250929',
          role: 'assistant',
          content: [{ type: 'text', text: 'hello' }],
          usage: { input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 80 },
        },
      }),
    ].join('\n') + '\n'
  );

  const srv = createMeterServer({
    port: 0,
    dbPath: join(stateDir, 'meter.db'),
    stateDir,
    claudeRoot,
    authToken: 'test-token-claude',
    enableWatchers: true,
    enableCdp: false,
    enableAntigravityRpc: false,
    enableQuotaProbe: false,
    enableExternalProviders: false,
  });

  try {
    const addr = await srv.start();
    const base = `http://127.0.0.1:${addr.port}`;

    // Default config keeps claudeQuotaEnabled=false and blocks /v1/claude/sync-local
    const initStateRes = await fetch(`${base}/v1/state`);
    assert.equal(initStateRes.status, 200);
    const initStateJson = await initStateRes.json();
    assert.equal(initStateJson.config.claudeQuotaEnabled, false);

    const syncDisabledRes = await fetch(`${base}/v1/claude/sync-local`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ATM-Token': 'test-token-claude',
      },
      body: JSON.stringify({}),
    });
    assert.equal(syncDisabledRes.status, 400);
    const syncDisabledJson = await syncDisabledRes.json();
    assert.equal(syncDisabledJson.ok, false);

    // Toggle claudeQuotaEnabled on & off via POST /v1/config
    const enableQuotaRes = await fetch(`${base}/v1/config`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ATM-Token': 'test-token-claude',
      },
      body: JSON.stringify({ claudeQuotaEnabled: true }),
    });
    assert.equal(enableQuotaRes.status, 200);
    const enableQuotaJson = await enableQuotaRes.json();
    assert.equal(enableQuotaJson.config.claudeQuotaEnabled, true);

    const disableQuotaRes = await fetch(`${base}/v1/config`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ATM-Token': 'test-token-claude',
      },
      body: JSON.stringify({ claudeQuotaEnabled: false }),
    });
    assert.equal(disableQuotaRes.status, 200);
    const disableQuotaJson = await disableQuotaRes.json();
    assert.equal(disableQuotaJson.config.claudeQuotaEnabled, false);

    const cfgRes = await fetch(`${base}/v1/config`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ATM-Token': 'test-token-claude',
      },
      body: JSON.stringify({ claudeCookie: 'sessionKey=sk-ant-sid01-xyz' }),
    });
    assert.equal(cfgRes.status, 200);
    const cfgJson = await cfgRes.json();
    assert.equal(cfgJson.config.hasClaudeCookie, true);
    assert.equal(cfgJson.config.claudeQuotaEnabled, false);
    assert.equal(cfgJson.config.tools.claude, true);

    const usageRes = await fetch(`${base}/v1/usage?days=7`);
    assert.equal(usageRes.status, 200);
    const usageJson = await usageRes.json();
    assert.ok(usageJson.cards.claude);
    assert.equal(usageJson.cards.claude.today.turnCount, 1);

    // Invalid claudeProxyUrl returns HTTP 400 and preserves previous config
    const badProxyRes = await fetch(`${base}/v1/config`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ATM-Token': 'test-token-claude',
      },
      body: JSON.stringify({ claudeProxyUrl: 'ftp://invalid-proxy:21' }),
    });
    assert.equal(badProxyRes.status, 400);
    const badProxyJson = await badProxyRes.json();
    assert.equal(badProxyJson.ok, false);

    // Valid claudeProxyUrl persists & reflects effectiveClaudeProxyUrl + source='config'
    const okProxyRes = await fetch(`${base}/v1/config`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ATM-Token': 'test-token-claude',
      },
      body: JSON.stringify({ claudeProxyUrl: 'http://127.0.0.1:17890/' }),
    });
    assert.equal(okProxyRes.status, 200);
    const okProxyJson = await okProxyRes.json();
    assert.equal(okProxyJson.config.claudeProxyUrl, 'http://127.0.0.1:17890');
    assert.equal(okProxyJson.config.effectiveClaudeProxyUrl, 'http://127.0.0.1:17890');
    assert.equal(okProxyJson.config.claudeProxySource, 'config');

    // Empty string clears manual claudeProxyUrl override
    const clearProxyRes = await fetch(`${base}/v1/config`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ATM-Token': 'test-token-claude',
      },
      body: JSON.stringify({ claudeProxyUrl: '   ' }),
    });
    assert.equal(clearProxyRes.status, 200);
    const clearProxyJson = await clearProxyRes.json();
    assert.equal(clearProxyJson.config.claudeProxyUrl, null);
  } finally {
    await srv.stop();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('strict proxy resolution, fail-closed anti-IP-leak guards, and Claude CDP exclusion', async () => {
  assert.equal(normalizeProxyUrl(' http://127.0.0.1:17890/ '), 'http://127.0.0.1:17890');
  assert.equal(normalizeProxyUrl('socks5h://127.0.0.1:7891'), 'socks5h://127.0.0.1:7891');
  assert.equal(normalizeProxyUrl('ftp://127.0.0.1:21'), null);
  assert.equal(normalizeProxyUrl('http://127.0.0.1:99999'), null);
  assert.equal(normalizeProxyUrl(''), null);

  assert.equal(isLoopbackUrl('http://127.0.0.1:47831/health'), true);
  assert.equal(isLoopbackUrl('http://localhost:8080/test'), true);
  assert.equal(isLoopbackUrl('http://[::1]:8080/test'), true);
  assert.equal(isLoopbackUrl('https://api.anthropic.com/api/oauth/usage'), false);
  assert.equal(isLoopbackUrl('https://claude.ai/api/organizations'), false);

  // Precedence: config > claude_settings > env > system > none
  const tmp = mkdtempSync(join(tmpdir(), 'atm-claude-proxy-'));
  const homeDir = join(tmp, 'home');
  const supportDir = join(tmp, 'support');
  mkdirSync(join(homeDir, '.claude'), { recursive: true });
  mkdirSync(supportDir, { recursive: true });

  const envKeys = ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy'];
  const savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));

  try {
    assert.equal(readClaudeSettingsProxyUrl(homeDir), null);
    assert.deepEqual(resolveClaudeProxyConfig({ homeDir, env: {}, systemProxyState: null }), {
      proxyUrl: null,
      source: 'none',
    });

    writeFileSync(
      join(homeDir, '.claude', 'settings.json'),
      JSON.stringify({ env: { HTTPS_PROXY: 'http://127.0.0.1:17890/' } })
    );
    assert.equal(readClaudeSettingsProxyUrl(homeDir), 'http://127.0.0.1:17890');

    assert.deepEqual(
      resolveClaudeProxyConfig({
        claudeProxyUrl: 'socks5://127.0.0.1:10808',
        homeDir,
        env: { HTTPS_PROXY: 'http://127.0.0.1:8888' },
        systemProxyState: { hasSystemProxy: true, fallbackProxyUrl: 'http://127.0.0.1:7890' },
      }),
      { proxyUrl: 'socks5://127.0.0.1:10808', source: 'config' }
    );
    assert.deepEqual(
      resolveClaudeProxyConfig({
        homeDir,
        env: { HTTPS_PROXY: 'http://127.0.0.1:8888' },
        systemProxyState: { hasSystemProxy: true, fallbackProxyUrl: 'http://127.0.0.1:7890' },
      }),
      { proxyUrl: 'http://127.0.0.1:17890', source: 'claude_settings' }
    );
    assert.deepEqual(
      resolveClaudeProxyConfig({
        homeDir: join(tmp, 'no-settings'),
        env: { HTTPS_PROXY: 'http://127.0.0.1:8888' },
        systemProxyState: { hasSystemProxy: true, fallbackProxyUrl: 'http://127.0.0.1:7890' },
      }),
      { proxyUrl: 'http://127.0.0.1:8888', source: 'env' }
    );
    assert.deepEqual(
      resolveClaudeProxyConfig({
        homeDir: join(tmp, 'no-settings'),
        env: {},
        systemProxyState: { hasSystemProxy: true, fallbackProxyUrl: 'http://127.0.0.1:7890' },
      }),
      { proxyUrl: 'http://127.0.0.1:7890', source: 'system' }
    );

    // httpRequestRaw strictProxy fail-closed: missing proxy never calls _directFetch
    let directCalls = 0;
    const directSpy = async () => {
      directCalls += 1;
      throw new Error('direct fetch must not be called');
    };
    const noProxyRes = await httpRequestRaw('https://api.anthropic.com/api/oauth/usage', {
      strictProxy: true,
      _proxyState: { hasSystemProxy: false, fallbackProxyUrl: null },
      _nativeHelperBin: null,
      _directFetch: directSpy,
    });
    assert.equal(noProxyRes.ok, false);
    assert.equal(noProxyRes.errorKind, 'proxy_required');
    assert.equal(directCalls, 0);

    // httpRequestRaw strictProxy fail-closed: unreachable explicit proxy never falls back to direct
    const badProxyRes = await httpRequestRaw('https://api.anthropic.com/api/oauth/usage', {
      proxyUrl: 'http://127.0.0.1:1',
      strictProxy: true,
      timeoutMs: 1000,
      _proxyState: { hasSystemProxy: false, fallbackProxyUrl: null },
      _nativeHelperBin: null,
      _directFetch: directSpy,
    });
    assert.equal(badProxyRes.ok, false);
    assert.equal(badProxyRes.errorKind, 'network');
    assert.equal(directCalls, 0);

    // fetchClaudeQuota strictProxy fail-closed with zero proxy available never invokes network
    for (const k of envKeys) delete process.env[k];
    resetQuotaCacheForTests();
    const emptyHome = join(tmp, 'empty-home');
    mkdirSync(join(emptyHome, '.claude'), { recursive: true });
    writeFileSync(
      join(emptyHome, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-failclosed', expiresAt: Date.now() + 3600_000 } })
    );
    let spyFetchCalls = 0;
    const failClosedQuota = await fetchClaudeQuota(Date.now(), {
      homeDir: emptyHome,
      claudeAppSupportDir: supportDir,
      claudeApiBaseUrl: 'https://api.anthropic.com',
      claudeWebBaseUrl: 'https://claude.ai',
      claudeCookie: 'sessionKey=sk-ant-sid01-failclosed',
      requireProxy: true,
      _proxyState: { hasSystemProxy: false, fallbackProxyUrl: null },
      _nativeHelperBin: null,
      _directFetch: directSpy,
      fetchImpl: async () => {
        spyFetchCalls += 1;
        throw new Error('fetchImpl must not be called when proxy is missing');
      },
      forceRefresh: true,
    });
    assert.equal(failClosedQuota._ok, false);
    assert.equal(failClosedQuota._errorKind, 'proxy_required');
    assert.match(failClosedQuota.quotaHint || '', /阻止直连/);
    assert.equal(spyFetchCalls, 0);
    assert.equal(directCalls, 0);

    // Claude CDP exclusion: packaged Claude.app must not receive --remote-debugging-port
    assert.equal(APP_SPECS.claude.supportsCdp, false);
    assert.equal(getDefaultCdpSpecs().some((s) => s.tool === 'claude'), false);
    const execCalls = [];
    const opened = await openSingleApp('claude', {
      exitOnError: false,
      resolveAppPathsFn: (spec) => ({
        ...spec,
        installed: true,
        appPath: '/Applications/Claude.app',
      }),
      execFileSyncFn: (cmd, args) => {
        execCalls.push({ cmd, args });
      },
    });
    assert.equal(opened, true);
    assert.equal(execCalls.length, 1);
    assert.deepEqual(execCalls[0], { cmd: 'open', args: ['-a', '/Applications/Claude.app'] });
  } finally {
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    resetQuotaCacheForTests();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('loopback targets bypass proxies: no proxy handed to the native helper, direct fallback allowed, curl --noproxy exempts loopback', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'atm-loopback-'));
  const markerPath = join(tmp, 'helper-stdin.json');
  const fakeHelper = join(tmp, 'fake-helper.sh');
  writeFileSync(fakeHelper, `#!/bin/sh\ncat > "${markerPath}"\necho '{"ok":false,"error":"proxy connect failed"}'\n`);
  chmodSync(fakeHelper, 0o755);
  const srv = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"local":true}');
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const deadProxyState = { hasSystemProxy: true, fallbackProxyUrl: 'http://127.0.0.1:9' };
  try {
    const url = `http://127.0.0.1:${srv.address().port}/v1/models`;

    // System proxy on + helper present: loopback must not be routed through the helper/proxy.
    const plain = await httpRequestRaw(url, { timeoutMs: 3000, _nativeHelperBin: fakeHelper, _proxyState: deadProxyState });
    assert.equal(plain.status, 200);
    assert.deepEqual(JSON.parse(plain.text), { local: true });
    assert.equal(existsSync(markerPath), false, 'helper must not run for a loopback target without preferNative');

    // preferNative: helper runs without a proxy and a helper failure may fall back to direct.
    const native = await httpRequestRaw(url, {
      timeoutMs: 3000,
      preferNative: true,
      _nativeHelperBin: fakeHelper,
      _proxyState: deadProxyState,
    });
    assert.equal(native.status, 200);
    assert.equal(JSON.parse(readFileSync(markerPath, 'utf8')).proxyUrl, null);

    // curl with a dead proxy still reaches loopback thanks to the --noproxy list.
    const viaCurl = await curlFetchRaw(url, { timeoutMs: 3000, proxyUrl: 'http://127.0.0.1:9' });
    assert.equal(viaCurl.status, 200);

    // Strict mode ignores NO_PROXY (only loopback is exempt); non-strict honors it.
    const env = { NO_PROXY: ' .corp.example , intranet ' };
    assert.equal(buildCurlNoProxyList({ strict: true, env }), 'localhost,127.0.0.1,::1');
    assert.equal(buildCurlNoProxyList({ strict: false, env }), 'localhost,127.0.0.1,::1,.corp.example,intranet');
  } finally {
    srv.closeAllConnections?.();
    await new Promise((resolve) => srv.close(resolve));
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('fetchClaudeQuota 429 backoff never serves another identity snapshot, and getAllQuotas forwards in-memory keychain creds', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'atm-claude-ratelimit-'));
  const homeDir = join(tmp, 'home');
  const supportDir = join(tmp, 'support');
  mkdirSync(join(homeDir, '.claude'), { recursive: true });
  mkdirSync(supportDir, { recursive: true });
  const rateLimited = new Set();
  const srv = http.createServer((req, res) => {
    const cookie = String(req.headers.cookie || '');
    const who = cookie.includes('sessionKey=A') ? 'a' : 'b';
    if (rateLimited.has(who)) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' });
      res.end('{"error":"rate_limited"}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url.startsWith('/api/account')) {
      res.end(JSON.stringify({ email_address: `${who}@example.com`, memberships: [] }));
      return;
    }
    res.end(JSON.stringify({ five_hour: { utilization: who === 'a' ? 40 : 70, resets_at: '2099-01-01T00:00:00Z' } }));
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  resetQuotaCacheForTests();
  try {
    const base = `http://127.0.0.1:${srv.address().port}`;
    const opts = (cookie, extra = {}) => ({
      homeDir,
      claudeAppSupportDir: supportDir,
      claudeApiBaseUrl: base,
      claudeWebBaseUrl: base,
      claudeCookie: cookie,
      ...extra,
    });
    const cookieA = 'sessionKey=A; lastActiveOrg=org-a';
    const cookieB = 'sessionKey=B; lastActiveOrg=org-b';
    const t0 = Date.now();

    const a = await fetchClaudeQuota(t0, opts(cookieA));
    assert.equal(a._ok, true);
    assert.equal(a.accountEmail, 'a@example.com');

    // Switching identity and immediately hitting 429 must not rebind account A's snapshot to B.
    rateLimited.add('b');
    const b1 = await fetchClaudeQuota(t0 + 1000, opts(cookieB));
    assert.equal(b1._errorKind, 'rate_limit');
    const b2 = await fetchClaudeQuota(t0 + 2000, opts(cookieB));
    assert.equal(b2._errorKind, 'rate_limit');
    assert.equal(b2.accountEmail, null);
    assert.equal(b2.quotaWindows.length, 0);

    // Same identity hitting 429 keeps its own last good snapshot during the backoff.
    resetQuotaCacheForTests();
    const a1 = await fetchClaudeQuota(t0, opts(cookieA));
    assert.equal(a1._ok, true);
    rateLimited.add('a');
    await fetchClaudeQuota(t0 + 1000, opts(cookieA, { forceRefresh: true }));
    const a2 = await fetchClaudeQuota(t0 + 2000, opts(cookieA));
    assert.equal(a2._errorKind, 'rate_limit');
    assert.equal(a2.accountEmail, 'a@example.com');
    assert.equal(a2.quotaWindows.length, 1);

    // getAllQuotas threads the daemon's in-memory keychain material into the Claude fetcher.
    resetQuotaCacheForTests();
    const empty = () => ({ accountEmail: null, planTitle: null, quotaWindows: [], resetCreditsText: null });
    let seen = null;
    await getAllQuotas(t0, {
      forceRefresh: true,
      claudeQuotaEnabled: true,
      claudeSafeStoragePasswords: ['pw-1'],
      claudeCliCredentials: ['{"claudeAiOauth":{"accessToken":"tok"}}'],
      _fetchers: {
        codex: async () => empty(),
        claude: async (_now, o) => {
          seen = o;
          return empty();
        },
        antigravity: async () => empty(),
        cursor: async () => empty(),
        codebuddy: () => empty(),
      },
    });
    assert.deepEqual(seen.safeStoragePasswords, ['pw-1']);
    assert.deepEqual(seen.cliCredentialsList, ['{"claudeAiOauth":{"accessToken":"tok"}}']);
  } finally {
    resetQuotaCacheForTests();
    srv.closeAllConnections?.();
    await new Promise((resolve) => srv.close(resolve));
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('ClaudeCodeAdapter counts each API call once across resumed/forked session files and removes rows that were double counted', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'atm-claude-dedupe-'));
  const dbPath = join(tmp, 'meter.db');
  const root = join(tmp, '.claude');
  const proj = join(root, 'projects', '-Users-dev-repo');
  mkdirSync(proj, { recursive: true });
  const user = (sid, ts, text) =>
    JSON.stringify({ type: 'user', sessionId: sid, cwd: '/Users/dev/repo', timestamp: ts, message: { role: 'user', content: text } });
  const call = (sid, ts, id, req, cacheRead, out) =>
    JSON.stringify({
      type: 'assistant',
      sessionId: sid,
      requestId: req,
      cwd: '/Users/dev/repo',
      timestamp: ts,
      message: {
        id,
        model: 'claude-opus-5-5',
        role: 'assistant',
        content: [{ type: 'text', text: `reply ${id}` }],
        usage: { input_tokens: 10, cache_read_input_tokens: cacheRead, output_tokens: out },
      },
    });
  // Original session: two turns. The resumed session copies both (rewriting sessionId) and adds one.
  const fileA = join(proj, 'sess-orig.jsonl');
  const fileB = join(proj, 'sess-resumed.jsonl');
  writeFileSync(
    fileA,
    [
      user('sess-orig', '2026-11-20T10:00:00.000Z', 'q1'),
      call('sess-orig', '2026-11-20T10:00:05.000Z', 'msg_1', 'req_1', 1_000_000, 1_000),
      user('sess-orig', '2026-11-20T10:01:00.000Z', 'q2'),
      call('sess-orig', '2026-11-20T10:01:05.000Z', 'msg_2', 'req_2', 2_000_000, 2_000),
    ].join('\n') + '\n'
  );
  writeFileSync(
    fileB,
    [
      user('sess-resumed', '2026-11-20T10:00:00.000Z', 'q1'),
      call('sess-resumed', '2026-11-20T10:00:05.000Z', 'msg_1', 'req_1', 1_000_000, 1_000),
      user('sess-resumed', '2026-11-20T10:01:00.000Z', 'q2'),
      call('sess-resumed', '2026-11-20T10:01:05.000Z', 'msg_2', 'req_2', 2_000_000, 2_000),
      user('sess-resumed', '2026-11-21T09:00:00.000Z', 'q3'),
      call('sess-resumed', '2026-11-21T09:00:05.000Z', 'msg_3', 'req_3', 3_000_000, 3_000),
    ].join('\n') + '\n'
  );
  utimesSync(fileA, new Date('2026-11-20T10:02:00Z'), new Date('2026-11-20T10:02:00Z'));
  utimesSync(fileB, new Date('2026-11-21T09:01:00Z'), new Date('2026-11-21T09:01:00Z'));
  const nowMs = Date.parse('2026-11-22T00:00:00Z');
  const sumTurns = (s) =>
    s.db.prepare(`SELECT COUNT(*) n, SUM(cache_read_tokens) cr, SUM(output_tokens) o FROM turns WHERE tool = 'claude'`).get();

  try {
    // Simulate rows written by an older version that parsed each file on its own (double counting),
    // with the legacy ingested_files table marking both files as done.
    const legacy = new TurnStore(dbPath);
    for (const fp of [fileA, fileB]) {
      for (const t of parseClaudeCodeSessionContent(readFileSync(fp, 'utf8'), { filePath: fp })) legacy.upsertTurn(t);
      legacy.db.prepare(`INSERT INTO ingested_files (file_path, mtime_ms, size_bytes) VALUES (?, 0, 0)`).run(fp);
    }
    assert.equal(sumTurns(legacy).cr, 9_000_000, 'legacy rows double count msg_1 and msg_2');
    legacy.close();

    const store = new TurnStore(dbPath);
    const adapter = new ClaudeCodeAdapter({ store, claudeRoot: root, onTurns: () => {} });
    adapter.scan({ maxRecentFiles: Infinity });

    // Each call counted once: msg_1 + msg_2 stay with the original file, msg_3 with the resumed one.
    const totals = sumTurns(store);
    assert.deepEqual({ n: totals.n, cr: totals.cr, o: totals.o }, { n: 3, cr: 6_000_000, o: 6_000 });
    const uids = store.db.prepare(`SELECT turn_uid FROM turns WHERE tool = 'claude' ORDER BY turn_uid`).all().map((r) => r.turn_uid);
    assert.deepEqual(uids, ['claude:sess-orig:turn-1', 'claude:sess-orig:turn-2', 'claude:sess-resumed:turn-3']);
    const usage = store.getUsageSummary({ days: 30, tool: 'claude', nowMs });
    assert.equal(usage.totals.estimatedCostUsd, Number(((6_000_000 * 0.2 + 30 * 4 + 6_000 * 20) / 1e6).toFixed(4)));

    // Stable across rescans and across a fresh adapter (ownership + parser revision persisted).
    assert.equal(adapter.scan({ maxRecentFiles: Infinity }).length, 0);
    assert.equal(new ClaudeCodeAdapter({ store, claudeRoot: root, onTurns: () => {} }).scan({ maxRecentFiles: Infinity }).length, 0);
    assert.deepEqual(sumTurns(store), totals);
    store.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('ingest_state re-parses files ingested by older daemons or older parser revisions', () => {
  const store = new TurnStore(':memory:');
  try {
    const fp = '/tmp/some/session.jsonl';
    // An older daemon only knows ingested_files; that must not mark the file as parsed for this version.
    store.db.prepare(`INSERT INTO ingested_files (file_path, mtime_ms, size_bytes) VALUES (?, 1, 2)`).run(fp);
    assert.equal(store.getIngestedFile(fp), null);
    store.setIngestedFile(fp, 1, 2);
    assert.deepEqual(store.getIngestedFile(fp), { mtimeMs: 1, sizeBytes: 2 });
    // A row from an older parser revision reads as not ingested.
    store.db.prepare(`UPDATE ingest_state SET parser_rev = parser_rev - 1 WHERE file_path = ?`).run(fp);
    assert.equal(store.getIngestedFile(fp), null);
  } finally {
    store.close();
  }
});

test('pricing: official Claude 5.x rates, Haiku 5.5 per-request 100K tier, no borrowed -fast rates, and partial turns surface as unpriced', () => {
  const one = (model, n, extra = {}) =>
    estimateTurnCost({
      model,
      usageBuckets: [{ m: model, b: classifyContextBand(n), c: 1, in: n, u: n, cr: 0, cw5: 0, cw1h: 0, out: 1_000_000, ...extra }],
    }).costUsd;
  // Haiku 5.5: up to 100K prompt -> $0.10 / $0.50; over 100K -> $0.50 / $2.50; US inference 1.1x on both.
  assert.equal(one('claude-haiku-5-5', 100_000), 0.51);
  assert.equal(one('claude-haiku-5-5', 100_001), Number((100_001 * 0.5 / 1e6 + 2.5).toFixed(6)));
  assert.equal(one('claude-haiku-5-5', 150_000, { geo: 'us' }), Number(((0.15 * 0.5 + 2.5) * 1.1).toFixed(6)));
  // Sonnet 5 is $2 / $10 (the scheduled $3 / $15 increase was cancelled).
  assert.equal(one('claude-sonnet-5', 1_000_000), 12);
  // Opus 5.5: cache hits at 0.05x input, 1M context at standard price.
  assert.equal(
    estimateTurnCost({
      model: 'claude-opus-5-5',
      usageBuckets: [{ m: 'claude-opus-5-5', b: 'gt_272k', c: 1, in: 900_000, u: 0, cr: 900_000, cw5: 0, cw1h: 0, out: 0 }],
    }).costUsd,
    0.18
  );
  // Fable 5.2 fast mode is 2x ($16 / $80).
  assert.equal(one('claude-fable-5-2', 100_000, { st: 'fast' }), 81.6);
  // A "-fast" suffix only borrows a base rate that actually has a fast tier.
  const flat = { totalInputTokens: 1e6, uncachedInputTokens: 1e6, outputTokens: 1e6, callCount: 1 };
  assert.equal(estimateTurnCost({ ...flat, model: 'grok-4-fast' }).priced, false);
  assert.equal(estimateTurnCost({ ...flat, model: 'gpt-5-fast' }).costUsd, 22.5);
  // A bucket with an unknown model is not priced at another model's rate; the turn is flagged partial.
  const partial = estimateTurnCost({
    model: 'claude-opus-5-5',
    usageBuckets: [
      { m: 'claude-opus-5-5', b: 'le_100k', c: 1, in: 1e6, u: 1e6, cr: 0, cw5: 0, cw1h: 0, out: 0 },
      { m: 'mystery-model', b: 'le_100k', c: 1, in: 1e6, u: 1e6, cr: 0, cw5: 0, cw1h: 0, out: 1e6 },
    ],
  });
  assert.equal(partial.partial, true);
  assert.equal(partial.costUsd, 4);

  const store = new TurnStore(':memory:');
  try {
    store.upsertTurn({
      turnUid: 'claude:s:turn-1',
      tool: 'claude',
      sessionId: 's',
      turnId: 'turn-1',
      model: 'claude-opus-5-5',
      completedAtMs: Date.parse('2026-11-21T00:00:00Z'),
      totalInputTokens: 2e6,
      uncachedInputTokens: 2e6,
      outputTokens: 1e6,
      callCount: 2,
      usageBuckets: [
        { m: 'claude-opus-5-5', b: 'le_100k', c: 1, in: 1e6, u: 1e6, cr: 0, cw5: 0, cw1h: 0, out: 0 },
        { m: 'mystery-model', b: 'le_100k', c: 1, in: 1e6, u: 1e6, cr: 0, cw5: 0, cw1h: 0, out: 1e6 },
      ],
    });
    const t = store.getUsageSummary({ days: 30, tool: 'claude', nowMs: Date.parse('2026-11-22T00:00:00Z') }).totals;
    assert.equal(t.estimatedCostUsd, 4);
    assert.equal(t.unpricedTurnCount, 1, 'the unpriced part shows up in "N 次请求没有价格"');
  } finally {
    store.close();
  }
});
