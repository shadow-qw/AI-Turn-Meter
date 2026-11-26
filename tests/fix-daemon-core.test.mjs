import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { parseCodexSessionDetailed } from '../packages/daemon/src/adapters/codex.mjs';
import { CdpInlineInjector } from '../packages/daemon/src/cdp-injector.mjs';
import { ExternalProviderRegistry } from '../packages/daemon/src/external-providers.mjs';
import {
  inspectLocalCodexConfig,
  probeCodexProtocol,
  runQuickCapabilityProbes,
  runTokenDistributionFingerprint,
} from '../packages/daemon/src/fingerprint.mjs';
import {
  buildAppLaunchAgentPlist,
  setAppAutostart,
} from '../packages/daemon/src/installer.mjs';
import {
  curlFetchRaw,
  getProxyState,
  httpRequestRaw,
  resetNetProxyCacheForTests,
} from '../packages/daemon/src/net.mjs';
import { estimateTurnCost, resolveModelPricing } from '../packages/daemon/src/pricing.mjs';
import {
  fetchAntigravityQuota,
  fetchCodexQuota,
  getAllQuotas,
  resetQuotaCacheForTests,
} from '../packages/daemon/src/quota.mjs';
import { renderReceiptAscii, renderReceiptSvg } from '../packages/daemon/src/receipt.mjs';
import { createMeterServer } from '../packages/daemon/src/server.mjs';
import { TurnStore } from '../packages/daemon/src/store.mjs';

function makeTmpDir(prefix = 'atm-core-fix-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

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
      resolve({
        port: server.address().port,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// 1. fingerprint.mjs (P0 Security: never leak ChatGPT OAuth to third-party Codex providers)
// ---------------------------------------------------------------------------

test('fingerprint: custom Codex model_provider without env_key refuses probes and never leaks ChatGPT OAuth or Account-Id', async () => {
  const codexHome = makeTmpDir('atm-codex-sec-');
  const prevCustomKey = process.env.ATM_TEST_RELAY_KEY;
  const prevOpenAiKey = process.env.OPENAI_API_KEY;
  delete process.env.ATM_TEST_RELAY_KEY;
  process.env.OPENAI_API_KEY = 'sk-official-env-should-not-leak';

  try {
    writeFileSync(
      join(codexHome, 'config.toml'),
      [
        'model = "gpt-5.4"',
        'model_provider = "thirdparty"',
        '',
        '[model_providers.thirdparty]',
        'base_url = "https://relay.untrusted.example/v1"',
        'env_key = "ATM_TEST_RELAY_KEY"',
        'wire_api = "chat"',
      ].join('\n')
    );
    writeFileSync(
      join(codexHome, 'auth.json'),
      JSON.stringify({
        OPENAI_API_KEY: 'sk-auth-json-should-not-leak',
        tokens: {
          access_token: 'chatgpt-oauth-secret-token',
          account_id: 'acct-secret-12345',
        },
      })
    );

    const cfgNoKey = inspectLocalCodexConfig(codexHome);
    assert.equal(cfgNoKey.authMode, 'custom_provider_no_key');
    assert.equal(cfgNoKey.configured, false);
    assert.equal(cfgNoKey.accessToken, null);
    assert.equal(cfgNoKey.accountId, null);
    assert.equal(cfgNoKey.apiKey, null);
    assert.equal(cfgNoKey.hasAccessToken, false);
    assert.equal(cfgNoKey.hasApiKey, false);

    let fetchCalls = 0;
    const forbiddenFetch = async () => {
      fetchCalls += 1;
      throw new Error('fetch should NEVER be called when custom provider env_key is missing');
    };

    const protoRes = await probeCodexProtocol({ codexHome, fetchImpl: forbiddenFetch });
    assert.equal(protoRes.ok, false);
    assert.equal(protoRes.verdict, 'unavailable');
    assert.match(protoRes.summary, /ATM_TEST_RELAY_KEY|API Key/);
    assert.equal(fetchCalls, 0);

    const quickRes = await runQuickCapabilityProbes({
      targetType: 'codex',
      codexHome,
      fetchImpl: forbiddenFetch,
    });
    assert.equal(quickRes.ok, false);
    assert.equal(quickRes.verdict, 'unavailable');
    assert.match(quickRes.summary, /ATM_TEST_RELAY_KEY|API Key/);
    assert.equal(fetchCalls, 0);

    const deepRes = await runTokenDistributionFingerprint({
      targetType: 'codex',
      codexHome,
      sampleCount: 10,
      fetchImpl: forbiddenFetch,
    });
    assert.equal(deepRes.ok, false);
    assert.equal(deepRes.verdict, 'unavailable');
    assert.match(deepRes.summary, /ATM_TEST_RELAY_KEY|API Key/);
    assert.equal(fetchCalls, 0);

    // When the custom provider's env_key IS set, use ONLY that key and NEVER send ChatGPT-Account-Id or OAuth token
    process.env.ATM_TEST_RELAY_KEY = 'sk-relay-only-key';
    const cfgWithKey = inspectLocalCodexConfig(codexHome);
    assert.equal(cfgWithKey.authMode, 'custom_provider');
    assert.equal(cfgWithKey.configured, true);
    assert.equal(cfgWithKey.apiKey, 'sk-relay-only-key');
    assert.equal(cfgWithKey.accessToken, null);
    assert.equal(cfgWithKey.accountId, null);

    let capturedHeaders = null;
    const captureFetch = async (_url, init) => {
      capturedHeaders = init.headers;
      return {
        ok: true,
        status: 200,
        headers: new Map([['openai-model', 'gpt-5.4']]),
        text: async () => JSON.stringify({ model: 'gpt-5.4', choices: [{ message: { content: 'OK' } }] }),
      };
    };
    const okProto = await probeCodexProtocol({ codexHome, fetchImpl: captureFetch });
    assert.equal(okProto.ok, true);
    assert.equal(capturedHeaders.Authorization, 'Bearer sk-relay-only-key');
    assert.equal('ChatGPT-Account-Id' in capturedHeaders, false);
  } finally {
    if (prevCustomKey === undefined) delete process.env.ATM_TEST_RELAY_KEY;
    else process.env.ATM_TEST_RELAY_KEY = prevCustomKey;
    if (prevOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevOpenAiKey;
    rmSync(codexHome, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. quota.mjs (Proto3 zero-value, Antigravity stale grace, inflight race, Codex bounds)
// ---------------------------------------------------------------------------

test('quota: Antigravity treats Proto3 omitted remainingFraction with resetTime as 0% in both summary and fallback', async () => {
  const nowMs = Date.UTC(2026, 10, 23, 12, 0, 0);
  const in2h = new Date(nowMs + 2 * 3600 * 1000).toISOString();
  const in3d = new Date(nowMs + 3 * 86400 * 1000).toISOString();

  // Case A: RetrieveUserQuotaSummary omits remainingFraction when exhausted (0.0)
  const srvSummary = await startMockAntigravityServer({
    userStatus: {
      userStatus: { email: 'zero@example.com', userTier: { name: 'Pro' } },
    },
    quotaSummary: {
      response: {
        groups: [
          {
            buckets: [
              // Exhausted bucket: remainingFraction omitted by Proto3 JSON
              { bucketId: 'gemini-5h', window: '5h', resetTime: in2h },
              // Active bucket with fraction
              { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.45, resetTime: in3d },
              // Disabled bucket must still be skipped
              { bucketId: '3p-5h', window: '5h', disabled: true, resetTime: in2h },
              // Neither fraction nor resetTime must be skipped
              { bucketId: '3p-weekly', window: 'weekly' },
            ],
          },
        ],
      },
    },
  });

  try {
    const q = await fetchAntigravityQuota(nowMs, {
      inspectServers: async () => ({
        servers: [{ pid: 101, httpPort: srvSummary.port, ports: [srvSummary.port], csrf: 'test-csrf' }],
      }),
    });
    assert.equal(q._ok, true);
    assert.equal(q._errorKind, null);
    assert.equal(q.quotaWindows.length, 2);
    const g5h = q.quotaWindows.find((w) => w.id === 'ag-gemini-5h');
    assert.ok(g5h);
    assert.equal(g5h.remainingPct, 0);
    assert.ok(g5h.resetText);
    assert.equal(q.quotaWindows.find((w) => w.id === 'ag-claude-gpt-5h'), undefined);
    assert.equal(q.quotaWindows.find((w) => w.id === 'ag-claude-gpt-weekly'), undefined);
  } finally {
    await srvSummary.close();
  }

  // Case B: GetUserStatus clientModelConfigs fallback omits remainingFraction when exhausted
  const srvFallback = await startMockAntigravityServer({
    userStatus: {
      userStatus: {
        email: 'fallback-zero@example.com',
        planStatus: { planInfo: { planName: 'Pro' } },
        cascadeModelConfigData: {
          clientModelConfigs: [
            { label: 'Gemini 4 Pro', quotaInfo: { resetTime: in2h } },
            { label: 'Claude Sonnet 4.5', quotaInfo: { remainingFraction: 0.5, resetTime: in2h } },
          ],
        },
      },
    },
    quotaSummary: { response: { groups: [] } },
  });

  try {
    const q = await fetchAntigravityQuota(nowMs, {
      inspectServers: async () => ({
        servers: [{ pid: 102, httpPort: srvFallback.port, ports: [srvFallback.port], csrf: 'test-csrf' }],
      }),
    });
    assert.equal(q.quotaWindows.length, 2);
    const gem = q.quotaWindows.find((w) => w.id === 'ag-gemini');
    const claude = q.quotaWindows.find((w) => w.id === 'ag-claude-gpt');
    assert.equal(gem.remainingPct, 0);
    assert.equal(claude.remainingPct, 50);
  } finally {
    await srvFallback.close();
  }
});

test('quota: Antigravity marks transient RPC failures with _errorKind=network and participates in 15m stale grace + 5s retry TTL', async () => {
  resetQuotaCacheForTests();
  try {
    // 1. Discovered server fails to respond -> _errorKind: 'network'
    const failedResp = await fetchAntigravityQuota(Date.now(), {
      inspectServers: async () => ({
        servers: [{ pid: 201, httpPort: 1, ports: [1], csrf: 'bad' }],
        runningWithoutCsrfToken: false,
      }),
    });
    assert.equal(failedResp._ok, false);
    assert.equal(failedResp._errorKind, 'network');

    // 2. inspectServers throws -> _errorKind: 'network'
    const failedThrow = await fetchAntigravityQuota(Date.now(), {
      inspectServers: async () => {
        throw new Error('ps failed');
      },
    });
    assert.equal(failedThrow._ok, false);
    assert.equal(failedThrow._errorKind, 'network');

    // 3. getAllQuotas stale grace + ERROR_RETRY_TTL_MS (5s) for Antigravity
    const baseNow = Date.now();
    let agCalls = 0;
    const goodAg = {
      accountEmail: 'ag@example.com',
      planTitle: 'Ultra',
      quotaWindows: [{ id: 'ag-gemini-5h', title: 'Gemini 会话', remainingPct: 80, resetText: '3 小时后重置', pacePct: null, subtitle: null }],
      resetCreditsText: null,
      quotaHint: null,
      _ok: true,
      _errorKind: null,
    };
    const transientErrAg = {
      accountEmail: null,
      planTitle: null,
      quotaWindows: [],
      resetCreditsText: null,
      quotaHint: '暂无法连接 Antigravity 本地服务',
      _ok: false,
      _errorKind: 'network',
    };
    const emptyOk = { accountEmail: null, planTitle: null, quotaWindows: [], resetCreditsText: null, _ok: true, _errorKind: null };

    const fetchers = {
      codex: async () => emptyOk,
      cursor: async () => emptyOk,
      codebuddy: () => emptyOk,
      antigravity: async () => {
        agCalls += 1;
        return agCalls === 1 ? goodAg : transientErrAg;
      },
    };

    const q1 = await getAllQuotas(baseNow, { allowNetwork: false, _fetchers: fetchers });
    assert.equal(q1.antigravity.quotaWindows[0].remainingPct, 80);
    assert.equal(agCalls, 1);

    // Transient RPC error within 15m -> stale grace preserves last good snapshot
    const q2 = await getAllQuotas(baseNow + 60_000, {
      forceRefresh: true,
      allowNetwork: false,
      _fetchers: fetchers,
    });
    assert.equal(agCalls, 2);
    assert.equal(q2.antigravity.quotaWindows[0].remainingPct, 80);

    // Because Antigravity is in anyTransientFailure, cache TTL dropped to 5s (not 45s):
    // querying 6s after q2 must trigger a retry rather than returning 45s cache
    await getAllQuotas(Date.now() + 6_000, {
      forceRefresh: false,
      allowNetwork: false,
      _fetchers: fetchers,
    });
    assert.equal(agCalls, 3);
  } finally {
    resetQuotaCacheForTests();
  }
});

test('quota: getAllQuotas prevents stale inflight request from clobbering newer cacheKey or inflightPromise', async () => {
  resetQuotaCacheForTests();
  try {
    let resolveA;
    let resolveB;
    let callsForB = 0;

    const emptyOk = { accountEmail: null, planTitle: null, quotaWindows: [], resetCreditsText: null, _ok: true, _errorKind: null };
    const fetchers = {
      codex: async () => emptyOk,
      antigravity: async () => emptyOk,
      codebuddy: () => emptyOk,
      cursor: async (_now, { cursorCookie }) => {
        if (cursorCookie === 'cookie-A') {
          return new Promise((r) => {
            resolveA = () =>
              r({
                accountEmail: 'a@example.com',
                planTitle: 'PlanA',
                quotaWindows: [],
                resetCreditsText: null,
                _ok: true,
                _errorKind: null,
              });
          });
        }
        callsForB += 1;
        return new Promise((r) => {
          resolveB = () =>
            r({
              accountEmail: 'b@example.com',
              planTitle: 'PlanB',
              quotaWindows: [],
              resetCreditsText: null,
              _ok: true,
              _errorKind: null,
            });
        });
      },
    };

    const now = Date.now();
    // Scenario 1: A starts, B starts; A resolves FIRST while B is still in flight
    const pA = getAllQuotas(now, { cursorCookie: 'cookie-A', _fetchers: fetchers });
    const pB = getAllQuotas(now, { cursorCookie: 'cookie-B', _fetchers: fetchers });

    resolveA();
    const resA = await pA;
    assert.equal(resA.cursor.accountEmail, 'a@example.com');

    // A's .finally() MUST NOT have cleared B's inflightPromise, so C deduplicates onto B
    const pC = getAllQuotas(now, { cursorCookie: 'cookie-B', _fetchers: fetchers });
    assert.equal(callsForB, 1, 'C must join in-flight B rather than starting a duplicate fetch');

    resolveB();
    const [resB, resC] = await Promise.all([pB, pC]);
    assert.equal(resB.cursor.accountEmail, 'b@example.com');
    assert.equal(resC.cursor.accountEmail, 'b@example.com');

    // Scenario 2: Slow A2 starts, fast B2 starts and finishes FIRST, then slow A2 finishes LATER -> must not overwrite B2 cache
    resetQuotaCacheForTests();
    let resolveSlow;
    let resolveFast;
    const fetchers2 = {
      codex: async () => emptyOk,
      antigravity: async () => emptyOk,
      codebuddy: () => emptyOk,
      cursor: async (_now, { cursorCookie }) => {
        if (cursorCookie === 'slow-key') {
          return new Promise((r) => {
            resolveSlow = () =>
              r({ accountEmail: 'slow@example.com', planTitle: 'Slow', quotaWindows: [], resetCreditsText: null, _ok: true, _errorKind: null });
          });
        }
        return new Promise((r) => {
          resolveFast = () =>
            r({ accountEmail: 'fast@example.com', planTitle: 'Fast', quotaWindows: [], resetCreditsText: null, _ok: true, _errorKind: null });
        });
      },
    };

    const pSlow = getAllQuotas(now, { cursorCookie: 'slow-key', _fetchers: fetchers2 });
    const pFast = getAllQuotas(now, { cursorCookie: 'fast-key', _fetchers: fetchers2 });
    resolveFast();
    await pFast;
    resolveSlow();
    await pSlow;

    // Warm cache lookup for fast-key must still return fast@example.com (not poisoned by slow-key)
    let unexpectedCall = false;
    const cachedFast = await getAllQuotas(Date.now(), {
      cursorCookie: 'fast-key',
      _fetchers: {
        ...fetchers2,
        cursor: async () => {
          unexpectedCall = true;
          return emptyOk;
        },
      },
    });
    assert.equal(unexpectedCall, false);
    assert.equal(cachedFast.cursor.accountEmail, 'fast@example.com');
  } finally {
    resetQuotaCacheForTests();
  }
});

test('quota: findNewestCodexRateLimits bounds scan to 15 newest files and skips files > 20 MB', async () => {
  const codexHome = makeTmpDir('atm-codex-bound-');
  const prevCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;

  try {
    const sessDir = join(codexHome, 'sessions', '2026', '11', '23');
    mkdirSync(sessDir, { recursive: true });
    const nowMs = Date.now();
    const rateLimitLine = JSON.stringify({
      payload: {
        rate_limits: {
          limit_id: 'codex',
          primary: { used_percent: 33, window_minutes: 300, resets_at: Math.floor((nowMs + 7200_000) / 1000) },
        },
      },
    });

    // File #16 (oldest): has rate_limits, but lies beyond the 15-file cap
    const f16 = join(sessDir, 'rollout-16.jsonl');
    writeFileSync(f16, `${rateLimitLine}\n`);
    const t16 = new Date(nowMs - 20_000);
    utimesSync(f16, t16, t16);

    // Files #2..#15: empty files newer than #16
    for (let i = 2; i <= 15; i += 1) {
      const fp = join(sessDir, `rollout-${String(i).padStart(2, '0')}.jsonl`);
      writeFileSync(fp, '{"type":"noop"}\n');
      const tm = new Date(nowMs - i * 1000);
      utimesSync(fp, tm, tm);
    }

    // File #1 (newest): > 20 MB sparse file containing rate_limits at the start (must be skipped!)
    const f1 = join(sessDir, 'rollout-01-huge.jsonl');
    writeFileSync(f1, `${rateLimitLine}\n`);
    truncateSync(f1, 20 * 1024 * 1024 + 4096);
    const t1 = new Date(nowMs - 500);
    utimesSync(f1, t1, t1);

    const qBounded = await fetchCodexQuota(nowMs, { allowNetwork: false });
    assert.equal(qBounded.quotaWindows.length, 0, 'must skip >20MB file #1 and stop before file #16');

    // Now put valid rate_limits in file #2 (<=20MB, within top 15) while #1 is still >20MB
    const f2 = join(sessDir, 'rollout-02.jsonl');
    writeFileSync(f2, `${rateLimitLine}\n`);
    const t2 = new Date(nowMs - 1000);
    utimesSync(f2, t2, t2);

    const qFound = await fetchCodexQuota(nowMs, { allowNetwork: false });
    assert.equal(qFound.quotaWindows.length, 1);
    assert.equal(qFound.quotaWindows[0].remainingPct, 67);
  } finally {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    rmSync(codexHome, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. external-providers.mjs (inflight map race)
// ---------------------------------------------------------------------------

test('external-providers: older fetchSingle .finally() never deletes a newer inflight promise', async () => {
  const tmpDir = makeTmpDir('atm-ext-race-');
  const providersDir = join(tmpDir, 'providers');
  mkdirSync(providersDir, { recursive: true });

  try {
    const reg = new ExternalProviderRegistry({ providersDir });
    const deferreds = [];
    let fetchCount = 0;

    const fakeEntry = {
      meta: {
        key: 'ext:race',
        providerId: 'race',
        name: 'Race Provider',
        shortName: 'Race',
        icon: 'puzzlepiece.extension',
        accentColor: null,
        currency: 'USD',
        currencySymbol: '$',
        detailUrl: null,
        auth: null,
        fileName: 'race.mjs',
        filePath: join(providersDir, 'race.mjs'),
        cacheTtlMs: 60_000,
        timeoutMs: 5_000,
      },
      plugin: {
        fetch: () => {
          fetchCount += 1;
          return new Promise((resolve) => {
            deferreds.push(resolve);
          });
        },
      },
      loadError: null,
    };

    const p1 = reg.fetchSingle(fakeEntry, { forceRefresh: false });
    const inflight1 = reg.inflight.get('ext:race');
    const p2 = reg.fetchSingle(fakeEntry, { forceRefresh: true });
    const inflight2 = reg.inflight.get('ext:race');
    await new Promise((r) => setImmediate(r));
    assert.equal(fetchCount, 2);
    assert.ok(inflight1);
    assert.ok(inflight2);
    assert.notEqual(inflight2, inflight1);

    // Finish older p1 first -> must NOT delete p2's inflight entry from map
    deferreds[0]({ account: 'old', quotaWindows: [{ id: 'w', title: 'W', remainingPct: 10 }] });
    await p1;
    assert.equal(reg.inflight.get('ext:race'), inflight2, 'p1 must not delete newer p2 from inflight map');

    // Concurrent non-forced call must join p2 (no 3rd fetch!)
    const p3 = reg.fetchSingle(fakeEntry, { forceRefresh: false });
    await new Promise((r) => setImmediate(r));
    assert.equal(fetchCount, 2);

    deferreds[1]({ account: 'fresh', quotaWindows: [{ id: 'w', title: 'W', remainingPct: 90 }] });
    const [r2, r3] = await Promise.all([p2, p3]);
    assert.equal(r2.card.accountEmail, 'fresh');
    assert.equal(r3.card.accountEmail, 'fresh');
    assert.equal(reg.inflight.has('ext:race'), false);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. pricing.mjs (missing active models)
// ---------------------------------------------------------------------------

test('pricing: resolves gemini-pro-orchestrator-neon, composer-2.5/fast, claude-opus-4/4.1, and claude-3.5/3.7 models', () => {
  const neon = resolveModelPricing('gemini-4-neon');
  const orchNeon = resolveModelPricing('gemini-pro-orchestrator-neon');
  assert.deepEqual(orchNeon, neon);

  const compStd = resolveModelPricing('composer-2.5');
  const compFast = resolveModelPricing('composer-2.5-fast');
  const compFastDashed = resolveModelPricing('composer-2-5-fast');
  assert.ok(compStd);
  assert.ok(compFast);
  assert.deepEqual(compFastDashed, compFast);
  assert.ok(compFast.input > compStd.input, 'composer-2.5-fast should preserve distinct fast tier rate');

  for (const name of [
    'claude-opus-4',
    'claude-opus-4-20250514',
    'claude-opus-4.1',
    'claude-opus-4-1-20250805',
    'claude-3.5-sonnet',
    'claude-3-5-sonnet',
    'claude-3-5-sonnet-20241022',
    'claude-3.7-sonnet',
    'claude-3-7-sonnet',
    'claude-3-7-sonnet-20250219',
    'claude-3.5-haiku',
    'claude-3-5-haiku',
    'claude-3-5-haiku-20241022',
  ]) {
    const rate = resolveModelPricing(name);
    assert.ok(rate, `expected pricing entry for ${name}`);
    const est = estimateTurnCost({
      model: name,
      totalInputTokens: 100_000,
      uncachedInputTokens: 20_000,
      cacheReadTokens: 80_000,
      outputTokens: 2_000,
      callCount: 1,
    });
    assert.equal(est.priced, true);
    assert.ok(est.costUsd > 0);
    assert.ok(est.savingsUsd > 0);
  }

  // CodexBar CostUsagePricing parity aliases & newer tiers
  assert.deepEqual(resolveModelPricing('gpt-5.6'), resolveModelPricing('gpt-5.6-sol'));
  assert.deepEqual(resolveModelPricing('gpt-reserve'), resolveModelPricing('gpt-5.6-luna'));
  assert.equal(resolveModelPricing('gpt-5.4-pro')?.input, 30.0);
  assert.equal(resolveModelPricing('gpt-5.5-pro')?.output, 180.0);
  assert.equal(resolveModelPricing('gpt-5-pro')?.input, 15.0);
  assert.equal(resolveModelPricing('claude-fable-5')?.input, 10.0);
  assert.equal(resolveModelPricing('claude-mythos-5-1')?.cacheRead, 0.25);
  assert.equal(resolveModelPricing('claude-mythos-5-2')?.input, 8.0);
});

// ---------------------------------------------------------------------------
// 5. cdp-injector.mjs (stale port fallback, WS close fast-fail, 0 SQLite queries when idle)
// ---------------------------------------------------------------------------

test('cdp-injector: falls back from stale DevToolsActivePort to spec.port, skips getTurnsForTool when no targets, and resolves fast on WS close', async () => {
  const tmpDir = makeTmpDir('atm-cdp-fix-');
  try {
    const portFile = join(tmpDir, 'DevToolsActivePort');
    writeFileSync(portFile, '55551\n/devtools/browser/stale\n');

    const queriedPorts = [];
    let getTurnsCalls = 0;
    let evalCalls = 0;

    const injector = new CdpInlineInjector({
      specs: [{ tool: 'antigravity', portFile, port: 47924 }],
      getTurnsForTool: () => {
        getTurnsCalls += 1;
        return [
          {
            turnUid: 'antigravity:s1:t1',
            tool: 'antigravity',
            host: 'antigravity-desktop',
            sessionId: 's1',
            turnId: 't1',
            completedAtMs: 1000,
            tps: 80,
            totalInputTokens: 5000,
            replyPreview: 'hi',
          },
        ];
      },
    });

    // resolvePort preserves backwards-compatible portFile priority and supports optional listeningPorts verification
    assert.equal(injector.resolvePort(injector.specs[0]), 55551);
    assert.equal(injector.resolvePort(injector.specs[0], { listeningPorts: new Set([47924]) }), 47924);

    // Case A: no targets on either port -> getTurnsForTool is NEVER called (0 SQLite queries!)
    injector.findTargets = async (port) => {
      queriedPorts.push(port);
      return [];
    };
    const idleRes = await injector.pushTool(injector.specs[0]);
    assert.equal(idleRes, false);
    assert.deepEqual(queriedPorts, [55551, 47924]);
    assert.equal(getTurnsCalls, 0, 'idle polling must not query turns when 0 CDP targets are open');

    // Case B: stale portFile port 55551 has 0 targets, static fallback port 47924 has live target
    queriedPorts.length = 0;
    injector.findTargets = async (port) => {
      queriedPorts.push(port);
      if (port === 47924) {
        return [{ id: 'ag-win-1', url: 'https://ag.local/app', webSocketDebuggerUrl: 'ws://127.0.0.1:47924/devtools/page/1' }];
      }
      return [];
    };
    injector.evaluateOnTarget = async () => {
      evalCalls += 1;
      return true;
    };
    const pushed = await injector.pushTool(injector.specs[0]);
    assert.equal(pushed, true);
    assert.deepEqual(queriedPorts, [55551, 47924]);
    assert.equal(getTurnsCalls, 1);
    assert.equal(evalCalls, 1);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  // Case C: evaluateOnTarget resolves immediately on premature WebSocket close (not stalling 1400ms)
  const wsServer = http.createServer();
  const upgradedSockets = new Set();
  wsServer.on('upgrade', (req, socket) => {
    upgradedSockets.add(socket);
    socket.on('close', () => upgradedSockets.delete(socket));
    const key = req.headers['sec-websocket-key'];
    const accept = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '',
        '',
      ].join('\r\n')
    );
    // Immediately drop connection cleanly once opened (premature disconnect before answering id:1)
    setTimeout(() => {
      try {
        // Send WebSocket Close frame (0x88, 0x00) then destroy socket
        socket.write(Buffer.from([0x88, 0x00]));
        socket.destroy();
      } catch {}
    }, 20);
  });

  await new Promise((resolve) => wsServer.listen(0, '127.0.0.1', resolve));
  try {
    const port = wsServer.address().port;
    const injector = new CdpInlineInjector({ specs: [] });
    const t0 = Date.now();
    const ok = await injector.evaluateOnTarget(`ws://127.0.0.1:${port}/page/1`, '1+1');
    const elapsedMs = Date.now() - t0;
    assert.equal(ok, false);
    assert.ok(elapsedMs < 600, `expected fast close resolution (<600ms), got ${elapsedMs}ms`);
  } finally {
    for (const s of upgradedSockets) {
      try {
        s.destroy();
      } catch {}
    }
    wsServer.closeAllConnections?.();
    await new Promise((done) => wsServer.close(() => done()));
  }
});

// ---------------------------------------------------------------------------
// 6. net.mjs (scutil dedup, curl -L redirect, helperBin -> curlFetchRaw fallback)
// ---------------------------------------------------------------------------

test('net: getProxyState deduplicates concurrent scutil calls, curlFetchRaw honors redirect, and httpRequestRaw falls back to curl proxy when helperBin fails', async () => {
  resetNetProxyCacheForTests();
  try {
    let scutilCalls = 0;
    let releaseScutil;
    const runScutil = () => {
      scutilCalls += 1;
      return new Promise((resolve) => {
        releaseScutil = () => resolve('HTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 7890\n');
      });
    };

    const now = Date.now();
    const batch = [
      getProxyState(now, { runScutil }),
      getProxyState(now, { runScutil }),
      getProxyState(now, { runScutil }),
      getProxyState(now, { runScutil }),
    ];
    assert.equal(scutilCalls, 1, 'concurrent getProxyState calls must share a single scutil invocation');
    releaseScutil();
    const results = await Promise.all(batch);
    for (const r of results) {
      assert.equal(r.hasSystemProxy, true);
      assert.equal(r.fallbackProxyUrl, 'http://127.0.0.1:7890');
    }
  } finally {
    resetNetProxyCacheForTests();
  }

  // Local HTTP server for curl redirect test + proxy fallback test
  const srv = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/final' });
      res.end();
      return;
    }
    if (req.url === '/final') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ landed: true }));
      return;
    }
    // Act as HTTP forward proxy for full-URL requests (curl --proxy)
    if (req.url && req.url.startsWith('http://proxy-target.test/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ via: 'curl-proxy', path: req.url }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));

  const tmpDir = makeTmpDir('atm-net-helper-');
  const failingHelper = join(tmpDir, 'failing-helper.sh');
  writeFileSync(failingHelper, '#!/bin/sh\nexit 1\n');
  chmodSync(failingHelper, 0o755);

  try {
    const port = srv.address().port;
    const base = `http://127.0.0.1:${port}`;

    // curlFetchRaw follows redirects by default (-L) and respects redirect='manual'
    const followed = await curlFetchRaw(`${base}/redirect`, { redirect: 'follow', timeoutMs: 4000 });
    assert.equal(followed.ok, true);
    assert.equal(followed.status, 200);
    assert.deepEqual(JSON.parse(followed.text), { landed: true });
    assert.equal(followed.finalUrl, `${base}/final`);

    const manual = await curlFetchRaw(`${base}/redirect`, { redirect: 'manual', timeoutMs: 4000 });
    assert.equal(manual.status, 302);
    assert.equal(manual.headers.location, '/final');

    // httpRequestRaw Path A: hasSystemProxy=true + failing helperBin falls back to curlFetchRaw(fallbackProxyUrl)
    const fallbackA = await httpRequestRaw('http://proxy-target.test/a', {
      timeoutMs: 4000,
      _nativeHelperBin: failingHelper,
      _proxyState: { hasSystemProxy: true, fallbackProxyUrl: base },
    });
    assert.equal(fallbackA.ok, true);
    assert.equal(fallbackA.status, 200);
    assert.deepEqual(JSON.parse(fallbackA.text), {
      via: 'curl-proxy',
      path: 'http://proxy-target.test/a',
    });

    // httpRequestRaw Path B: direct fetch throws + failing helperBin still falls back to curlFetchRaw(fallbackProxyUrl)
    const fallbackB = await httpRequestRaw('http://proxy-target.test/b', {
      timeoutMs: 4000,
      _nativeHelperBin: failingHelper,
      _proxyState: { hasSystemProxy: false, fallbackProxyUrl: base },
      _directFetch: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    assert.equal(fallbackB.ok, true);
    assert.equal(fallbackB.status, 200);
    assert.deepEqual(JSON.parse(fallbackB.text), {
      via: 'curl-proxy',
      path: 'http://proxy-target.test/b',
    });
  } finally {
    srv.closeAllConnections?.();
    await new Promise((done) => srv.close(() => done()));
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 7a. store.mjs (composite index, recentSessions cache, upsertTurn merged return)
// ---------------------------------------------------------------------------

test('store: creates idx_turns_tool_session_completed, caches recentSessions with write/TTL invalidation, and returns merged row on ON CONFLICT', () => {
  const store = new TurnStore(':memory:');
  try {
    // 1. Verify composite index exists
    const idxRow = store.db
      .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_turns_tool_session_completed'`)
      .get();
    assert.ok(idxRow, 'composite index idx_turns_tool_session_completed must exist');
    assert.match(idxRow.sql, /\(tool,\s*session_id,\s*completed_at_ms DESC\)/i);

    // 2. upsertTurn ON CONFLICT preserves higher-quality fields AND returns merged row (not raw incoming)
    const nowMs = Date.UTC(2026, 10, 23, 14, 0, 0);
    const first = store.upsertTurn({
      turnUid: 'antigravity:sess-merge:turn-1',
      tool: 'antigravity',
      host: 'antigravity-desktop',
      sessionId: 'sess-merge',
      turnId: 'turn-1',
      model: 'claude-opus-4-6',
      workspacePath: '/Users/dev/merge-repo',
      completedAtMs: nowMs - 10_000,
      totalInputTokens: 20_000,
      uncachedInputTokens: 4_000,
      cacheReadTokens: 16_000,
      outputTokens: 600,
      thinkingTokens: 320,
      durationMs: 12_000,
      modelActiveMs: 4_000,
      tps: 150,
      tpsMethod: 'streaming_decode',
    });
    assert.equal(first.changed, true);

    // Offline rescan arrives with degraded fields + newly populated replyPreview (changed === true)
    const merged = store.upsertTurn({
      turnUid: 'antigravity:sess-merge:turn-1',
      tool: 'antigravity',
      host: 'antigravity-desktop',
      sessionId: 'sess-merge',
      turnId: 'turn-1',
      model: 'unknown',
      workspacePath: null,
      completedAtMs: nowMs - 10_000,
      totalInputTokens: 20_000,
      uncachedInputTokens: 4_000,
      cacheReadTokens: 16_000,
      outputTokens: 600,
      thinkingTokens: null,
      durationMs: 12_000,
      modelActiveMs: 10_000,
      tps: 60,
      tpsMethod: 'e2e_minus_tools',
      replyPreview: 'Merged preview text',
    });
    assert.equal(merged.changed, true);
    assert.equal(merged.record.model, 'claude-opus-4-6');
    assert.equal(merged.record.tps, 150);
    assert.equal(merged.record.tpsMethod, 'streaming_decode');
    assert.equal(merged.record.modelActiveMs, 4000);
    assert.equal(merged.record.thinkingTokens, 320);
    assert.equal(merged.record.workspacePath, '/Users/dev/merge-repo');
    assert.equal(merged.record.replyPreview, 'Merged preview text');
    assert.ok(merged.record.estimatedCostUsd > 0, 'merged record cost must use preserved model');

    // 3. recentSessions cache keyed by writeGeneration + 15s TTL -> 0 SQLite queries on warm getUsageSummary
    const u1 = store.getUsageSummary({ days: 7, nowMs });
    assert.equal(u1.cards.all.recentSessions.length, 1);

    let prepareCount = 0;
    const origPrepare = store.db.prepare.bind(store.db);
    store.db.prepare = (...args) => {
      prepareCount += 1;
      return origPrepare(...args);
    };
    try {
      // Warm hit within 15s -> 0 SQLite prepare calls even with fresh sessionTitles!
      const titles = new Map([['sess-merge', { title: 'Fresh Cached Overlay', workspacePath: null, updatedAtMs: nowMs }]]);
      const u2 = store.getUsageSummary({ days: 7, nowMs: nowMs + 5_000, sessionTitles: titles });
      assert.equal(prepareCount, 0, 'warm getUsageSummary must execute 0 SQLite queries for cached base + recentSessions');
      assert.equal(u2.cards.antigravity.recentSessions[0].title, 'Fresh Cached Overlay');

      // Past 15s TTL -> refreshes recentSessions from SQLite
      store.getRecentSessions({ limit: 5, nowMs: nowMs + 20_000 });
      assert.ok(prepareCount > 0, 'recentSessions cache must expire after 15s TTL');

      // Write invalidation immediately clears cache
      prepareCount = 0;
      store.getRecentSessions({ limit: 5, nowMs: nowMs + 21_000 });
      assert.equal(prepareCount, 0, 'recentSessions should hit cache again right after refresh');
    } finally {
      store.db.prepare = origPrepare;
    }

    store.upsertTurn({
      turnUid: 'codex:sess-new:turn-1',
      tool: 'codex',
      sessionId: 'sess-new',
      turnId: 'turn-1',
      model: 'gpt-5.4',
      completedAtMs: nowMs - 1_000,
      totalInputTokens: 2000,
      outputTokens: 100,
    });
    const afterWrite = store.getRecentSessions({ limit: 5, nowMs: nowMs + 21_000 });
    assert.equal(afterWrite.length, 2, 'writeGeneration bump must invalidate recentSessions cache');
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// 7b. server.mjs (getSessionTitles cache, tool=all, excludeCloud, enabled gating, 400 vs 500)
// ---------------------------------------------------------------------------

test('server: caches getSessionTitles (15s TTL / 3s forceRefresh guard), normalizes tool=all, supports excludeCloud, gates disabled tools, and separates 400 vs 500', async () => {
  const tmpDir = makeTmpDir('atm-srv-fix-');
  let fakeNow = Date.UTC(2026, 10, 23, 15, 0, 0);
  let titleLoadCount = 0;

  const meter = createMeterServer({
    port: 0,
    dbPath: join(tmpDir, 'meter.db'),
    stateDir: tmpDir,
    authToken: 'test-tok',
    enableWatchers: false,
    enableCdp: false,
    enableAntigravityRpc: false,
    enableQuotaProbe: true,
    enableExternalProviders: false,
    nowFn: () => fakeNow,
    loadSessionTitles: () => {
      titleLoadCount += 1;
      return new Map([
        ['ag-s1', { title: `Title v${titleLoadCount}`, workspacePath: '/tmp/ws', updatedAtMs: fakeNow }],
      ]);
    },
  });

  try {
    const addr = await meter.start();
    const base = `http://127.0.0.1:${addr.port}`;
    const authHeaders = { 'Content-Type': 'application/json', 'x-atm-token': 'test-tok' };

    meter.store.upsertTurn({
      turnUid: 'antigravity:ag-s1:t1',
      tool: 'antigravity',
      host: 'antigravity-desktop',
      sessionId: 'ag-s1',
      turnId: 't1',
      model: 'gemini-4-neon',
      completedAtMs: fakeNow - 5_000,
      totalInputTokens: 10_000,
      outputTokens: 500,
    });
    meter.store.upsertTurn({
      turnUid: 'cursor:cur-s1:local-1',
      tool: 'cursor',
      host: 'cursor-ide',
      sessionId: 'cur-s1',
      turnId: 'local-1',
      model: 'composer-2.5',
      completedAtMs: fakeNow - 3_000,
      totalInputTokens: 8_000,
      outputTokens: 400,
    });
    meter.store.upsertTurn({
      turnUid: 'cursor:cur-s1:cloud-1',
      tool: 'cursor',
      host: 'cursor-cloud',
      sessionId: 'cur-s1',
      turnId: 'cloud-1',
      model: 'grok-bot-default',
      completedAtMs: fakeNow - 2_000,
      totalInputTokens: 12_000,
      outputTokens: 10,
    });

    // 1. getSessionTitles 15s TTL & 3s forceRefresh guard
    const s1 = await (await fetch(`${base}/v1/sessions?limit=5`)).json();
    assert.equal(titleLoadCount, 1);
    assert.equal(s1.sessions.find((s) => s.sessionId === 'ag-s1').title, 'Title v1');

    // Within 3s: even refresh=1 uses cached titles
    fakeNow += 2_000;
    const s2 = await (await fetch(`${base}/v1/sessions?limit=5&refresh=1`)).json();
    assert.equal(titleLoadCount, 1);
    assert.equal(s2.sessions.find((s) => s.sessionId === 'ag-s1').title, 'Title v1');

    // >3s: refresh=1 bypasses cache
    fakeNow += 2_000; // +4s total
    const s3 = await (await fetch(`${base}/v1/sessions?limit=5&refresh=1`)).json();
    assert.equal(titleLoadCount, 2);
    assert.equal(s3.sessions.find((s) => s.sessionId === 'ag-s1').title, 'Title v2');

    // Within 15s of last reload: normal call stays cached
    fakeNow += 10_000;
    await fetch(`${base}/v1/sessions?limit=5`);
    assert.equal(titleLoadCount, 2);

    // >15s of last reload: normal call refreshes
    fakeNow += 6_000; // +16s since reload at v2
    const s4 = await (await fetch(`${base}/v1/sessions?limit=5`)).json();
    assert.equal(titleLoadCount, 3);
    assert.equal(s4.sessions.find((s) => s.sessionId === 'ag-s1').title, 'Title v3');

    // 2. tool=all normalized consistently across /v1/turns, /v1/sessions, /v1/usage, /v1/receipt
    const turnsAll = await (await fetch(`${base}/v1/turns?tool=all&limit=20`)).json();
    assert.equal(turnsAll.turns.length, 3);
    const sessionsAll = await (await fetch(`${base}/v1/sessions?tool=all&limit=20`)).json();
    assert.equal(sessionsAll.sessions.length, 2);
    const usageAll = await (await fetch(`${base}/v1/usage?days=7&tool=all`)).json();
    assert.equal(usageAll.totals.turnCount, 3);
    assert.equal(usageAll.tool, null);
    const receiptAll = await (await fetch(`${base}/v1/receipt?scope=day&date=2026-11-23&tool=all`)).json();
    assert.equal(receiptAll.totals.turnCount, 3);
    assert.equal(receiptAll.toolFilter, 'all');

    // 3. GET /v1/turns?excludeCloud=1 and excludeCloud=true exclude host='cursor-cloud'
    const noCloud1 = await (await fetch(`${base}/v1/turns?tool=cursor&excludeCloud=1`)).json();
    assert.equal(noCloud1.turns.length, 1);
    assert.equal(noCloud1.turns[0].host, 'cursor-ide');

    const noCloudTrue = await (await fetch(`${base}/v1/turns?tool=all&excludeCloud=true`)).json();
    assert.equal(noCloudTrue.turns.length, 2);
    assert.equal(noCloudTrue.turns.some((t) => t.host === 'cursor-cloud'), false);

    // 4. Respect config.enabled and isToolEnabled() across /v1/ingest, /v1/ingest/cursor-hook, spool, and triggerCursorHistorySync
    // Disable cursor only
    await fetch(`${base}/v1/config`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ tools: { cursor: false } }),
    });
    assert.equal(meter.triggerCursorHistorySync({ force: true }), null);

    const ingCursorOff = await (
      await fetch(`${base}/v1/ingest`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          turnUid: 'cursor:disabled:t1',
          tool: 'cursor',
          sessionId: 'disabled',
          turnId: 't1',
          totalInputTokens: 1000,
          outputTokens: 100,
        }),
      })
    ).json();
    assert.equal(ingCursorOff.ok, true);
    assert.equal(ingCursorOff.ignored, true);

    const hookCursorOff = await (
      await fetch(`${base}/v1/ingest/cursor-hook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hook_event_name: 'stop',
          conversation_id: 'hook-disabled',
          generation_id: 'g1',
          input_tokens: 1000,
          output_tokens: 100,
        }),
      })
    ).json();
    assert.equal(hookCursorOff.ok, true);
    assert.equal(hookCursorOff.ignored, true);

    // Disable master switch (even with codex tool=true)
    await fetch(`${base}/v1/config`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ enabled: false, tools: { cursor: true, codex: true } }),
    });
    assert.equal(meter.triggerCursorHistorySync({ force: true }), null);

    const ingMasterOff = await (
      await fetch(`${base}/v1/ingest`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          turnUid: 'codex:master-off:t1',
          tool: 'codex',
          sessionId: 'master-off',
          turnId: 't1',
          totalInputTokens: 1000,
          outputTokens: 100,
        }),
      })
    ).json();
    assert.equal(ingMasterOff.ok, true);
    assert.equal(ingMasterOff.ignored, true);

    // Verify none of the ignored turns were persisted
    const allAfterDisabled = meter.store.getRecentTurns(50);
    assert.equal(allAfterDisabled.some((t) => t.turnUid === 'cursor:disabled:t1'), false);
    assert.equal(allAfterDisabled.some((t) => t.turnUid === 'codex:master-off:t1'), false);
    assert.equal(allAfterDisabled.some((t) => t.sessionId === 'hook-disabled'), false);

    // Re-enable master switch for error separation tests
    await fetch(`${base}/v1/config`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ enabled: true, tools: { codex: true, cursor: true } }),
    });

    // 5. Separate JSON parse 400 from persistence 500, and guard store.getUsageSummary inside .catch()
    const badJsonRes = await fetch(`${base}/v1/ingest`, {
      method: 'POST',
      headers: authHeaders,
      body: '{not-valid-json',
    });
    assert.equal(badJsonRes.status, 400);
    assert.equal((await badJsonRes.json()).error, 'invalid json');

    const origUpsert = meter.store.upsertTurn.bind(meter.store);
    meter.store.upsertTurn = () => {
      throw new Error('SQLITE_BUSY: database is locked');
    };
    try {
      const dbErrRes = await fetch(`${base}/v1/ingest`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          turnUid: 'codex:err:t1',
          tool: 'codex',
          sessionId: 'err',
          turnId: 't1',
          totalInputTokens: 1000,
          outputTokens: 100,
        }),
      });
      assert.equal(dbErrRes.status, 500);
      const errBody = await dbErrRes.json();
      assert.equal(errBody.ok, false);
      assert.match(errBody.error, /SQLITE_BUSY/);
    } finally {
      meter.store.upsertTurn = origUpsert;
    }

    const origGetUsage = meter.store.getUsageSummary.bind(meter.store);
    meter.store.getUsageSummary = () => {
      throw new Error('usage query boom');
    };
    try {
      const usageErrRes = await fetch(`${base}/v1/usage?days=7`);
      assert.equal(usageErrRes.status, 500);
      const usageErrBody = await usageErrRes.json();
      assert.equal(usageErrBody.ok, false);
      assert.match(usageErrBody.error, /usage query boom/);
    } finally {
      meter.store.getUsageSummary = origGetUsage;
    }
  } finally {
    await meter.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('server: drainCursorSpool respects config.enabled and tools.cursor on startup and re-enable', async () => {
  const tmpDir = makeTmpDir('atm-spool-gate-');
  const spoolPath = join(tmpDir, 'cursor-spool.jsonl');
  const configPath = join(tmpDir, 'config.json');

  writeFileSync(
    configPath,
    JSON.stringify({
      enabled: true,
      tools: { antigravity: true, codex: true, cursor: false, codebuddy: true },
    })
  );
  writeFileSync(
    spoolPath,
    `${JSON.stringify({
      turnUid: 'cursor:spooled:t1',
      tool: 'cursor',
      host: 'cursor-ide',
      sessionId: 'spooled',
      turnId: 't1',
      model: 'composer-2.5',
      completedAtMs: Date.now(),
      totalInputTokens: 5000,
      outputTokens: 200,
    })}\n`
  );

  const meter = createMeterServer({
    port: 0,
    dbPath: join(tmpDir, 'meter.db'),
    stateDir: tmpDir,
    authToken: 'spool-tok',
    enableWatchers: false,
    enableCdp: false,
    enableAntigravityRpc: false,
    enableQuotaProbe: false,
    enableExternalProviders: false,
  });

  try {
    const addr = await meter.start();
    const base = `http://127.0.0.1:${addr.port}`;

    // Spool must NOT be drained while tools.cursor === false
    assert.equal(existsSync(spoolPath), true);
    assert.equal(meter.store.getRecentTurns(10, 'cursor').length, 0);

    // Re-enabling cursor drains the spool cleanly
    const reenable = await fetch(`${base}/v1/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-atm-token': 'spool-tok' },
      body: JSON.stringify({ tools: { cursor: true } }),
    });
    assert.equal(reenable.status, 200);
    const turns = meter.store.getRecentTurns(10, 'cursor');
    assert.equal(turns.length, 1);
    assert.equal(turns[0].turnUid, 'cursor:spooled:t1');
  } finally {
    await meter.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 11. Regressions: curl -K headers & direct system proxy, store >90d streak &
//     '独立对话' & cache_write_tokens change, receipt '0×', codex .jsonl.zst,
//     CDP exceptionDetails, setAppAutostart dryRun & offline CLI status config
// ---------------------------------------------------------------------------

test('net: curlFetchRaw sends sensitive headers via -K config file and httpRequestRaw uses curl proxy directly when helperBin is missing', async () => {
  const srv = http.createServer((req, res) => {
    if (req.url === '/echo-secret') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ secret: req.headers['x-secret'] || null }));
      return;
    }
    if (req.url === 'http://example.test/proxied') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ proxied: true, secret: req.headers['x-secret'] || null }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  try {
    const port = srv.address().port;
    const directRes = await curlFetchRaw(`http://127.0.0.1:${port}/echo-secret`, {
      headers: { 'X-Secret': 'top-secret-token' },
      timeoutMs: 3000,
    });
    assert.equal(directRes.status, 200);
    assert.equal(JSON.parse(directRes.text).secret, 'top-secret-token');

    const proxyRes = await httpRequestRaw('http://example.test/proxied', {
      headers: { 'X-Secret': 'proxy-secret' },
      timeoutMs: 3000,
      _nativeHelperBin: null,
      _proxyState: { hasSystemProxy: true, fallbackProxyUrl: `http://127.0.0.1:${port}` },
      _directFetch: () => {
        throw new Error('directFetch must not run when curl proxy path succeeds');
      },
    });
    assert.equal(proxyRes.status, 200);
    assert.deepEqual(JSON.parse(proxyRes.text), { proxied: true, secret: 'proxy-secret' });
  } finally {
    srv.closeAllConnections?.();
    await new Promise((resolve) => srv.close(resolve));
  }
});

test('store & receipt: cache_write_tokens triggers upsert change, streakDays exceeds 90, projects localize independent chats, and 0x renders', () => {
  const store = new TurnStore(':memory:');
  try {
    const first = store.upsertTurn({
      turnUid: 'cursor:cw:1',
      tool: 'cursor',
      sessionId: 'cw',
      turnId: '1',
      model: 'gpt-5',
      completedAtMs: Date.now(),
      totalInputTokens: 1000,
      uncachedInputTokens: 500,
      cacheReadTokens: 500,
      cacheWriteTokens: 0,
      outputTokens: 100,
    });
    assert.equal(first.changed, true);

    const second = store.upsertTurn({
      turnUid: 'cursor:cw:1',
      tool: 'cursor',
      sessionId: 'cw',
      turnId: '1',
      model: 'gpt-5',
      completedAtMs: Date.now(),
      totalInputTokens: 1000,
      uncachedInputTokens: 500,
      cacheReadTokens: 0,
      cacheWriteTokens: 500,
      outputTokens: 100,
    });
    assert.equal(second.changed, true);

    const now = new Date();
    const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    for (let i = 0; i < 95; i += 1) {
      const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i, 12, 0, 0, 0);
      store.upsertTurn({
        turnUid: `codex:streak:${i}`,
        tool: 'codex',
        sessionId: 'streak',
        turnId: `d-${i}`,
        model: 'gpt-5',
        workspacePath: '',
        completedAtMs: day.getTime(),
        totalInputTokens: 1000,
        outputTokens: 100,
      });
    }
    const receipt = store.getReceiptData({ scope: 'day', date: todayKey, groupBy: 'project' });
    assert.ok(receipt.streakDays >= 95, `expected streakDays >= 95, got ${receipt.streakDays}`);
    assert.equal(receipt.highlights.topProject.name, '独立对话');
    assert.equal(store.getUsageSummary({ days: 7 }).byProject[0].name, '独立对话');

    const zeroRatioReceipt = { ...receipt, vsDailyAvgRatio: 0 };
    const ascii = renderReceiptAscii(zeroRatioReceipt);
    const svg = renderReceiptSvg(zeroRatioReceipt);
    assert.equal(ascii.includes('0×'), true);
    assert.equal(svg.includes('0×'), true);
  } finally {
    store.close();
  }
});

test('codex: parseCodexSessionDetailed strips .jsonl.zst for sessionId and fork baseline detection', () => {
  const ts1 = '2026-11-24T10:00:00.000Z';
  const ts2 = '2026-11-24T10:00:01.000Z';
  const ts3 = '2026-11-24T10:00:02.000Z';
  const ts4 = '2026-11-24T10:00:04.000Z';

  const plainContent = [
    JSON.stringify({ type: 'turn_context', timestamp: ts1, payload: { turn_id: 't1', model: 'gpt-5' } }),
    JSON.stringify({
      type: 'token_usage_record',
      timestamp: ts2,
      payload: {
        turn_id: 't1',
        response_id: 'r1',
        usage: { input_tokens: 100, output_tokens: 20 },
      },
    }),
    JSON.stringify({ type: 'event_msg', timestamp: ts3, payload: { type: 'task_complete', turn_id: 't1' } }),
  ].join('\n');

  const plainParsed = parseCodexSessionDetailed(
    plainContent,
    '/tmp/rollout-2026-11-24T10-00-00-abc123.jsonl.zst'
  );
  assert.equal(plainParsed.turns.length, 1);
  assert.equal(plainParsed.turns[0].sessionId, 'rollout-2026-11-24T10-00-00-abc123');
  assert.equal(plainParsed.turns[0].turnUid, 'codex:rollout-2026-11-24T10-00-00-abc123:t1');

  const forkContent = [
    JSON.stringify({ type: 'turn_context', timestamp: ts1, payload: { turn_id: 't1', model: 'gpt-5' } }),
    JSON.stringify({
      type: 'event_msg',
      timestamp: ts2,
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 5000, output_tokens: 200 },
          last_token_usage: { input_tokens: 500, output_tokens: 50 },
        },
      },
    }),
    JSON.stringify({
      type: 'event_msg',
      timestamp: ts3,
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 5600, output_tokens: 260 },
          last_token_usage: { input_tokens: 600, output_tokens: 60 },
        },
      },
    }),
    JSON.stringify({ type: 'event_msg', timestamp: ts4, payload: { type: 'task_complete', turn_id: 't1' } }),
  ].join('\n');

  const forkParsed = parseCodexSessionDetailed(
    forkContent,
    '/tmp/fork_11111111-2222-3333-4444-555555555555.jsonl.zst'
  );
  assert.equal(forkParsed.turns.length, 1);
  assert.equal(forkParsed.turns[0].sessionId, 'fork_11111111-2222-3333-4444-555555555555');
  assert.equal(forkParsed.turns[0].totalInputTokens, 600);
  assert.equal(forkParsed.turns[0].outputTokens, 60);
});

test('cdp: evaluateOnTarget resolves false promptly when CDP payload contains exceptionDetails', async () => {
  const wsServer = http.createServer();
  const upgradedSockets = new Set();
  wsServer.on('upgrade', (req, socket) => {
    upgradedSockets.add(socket);
    socket.on('close', () => upgradedSockets.delete(socket));
    const key = req.headers['sec-websocket-key'];
    const accept = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '',
        '',
      ].join('\r\n')
    );
    socket.once('data', (chunk) => {
      let reqId = 1;
      try {
        const masked = (chunk[1] & 0x80) !== 0;
        const len = chunk[1] & 0x7f;
        let off = 2;
        if (len === 126) off = 4;
        else if (len === 127) off = 10;
        const mask = masked ? chunk.subarray(off, off + 4) : null;
        const payload = Buffer.from(chunk.subarray(masked ? off + 4 : off));
        if (mask) {
          for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
        }
        reqId = JSON.parse(payload.toString('utf8')).id ?? 1;
      } catch {}
      const reply = Buffer.from(
        JSON.stringify({ id: reqId, result: { exceptionDetails: { text: 'Uncaught ReferenceError' } } })
      );
      socket.write(Buffer.concat([Buffer.from([0x81, reply.length]), reply]));
    });
  });

  await new Promise((resolve) => wsServer.listen(0, '127.0.0.1', resolve));
  try {
    const port = wsServer.address().port;
    const injector = new CdpInlineInjector({ specs: [] });
    const t0 = Date.now();
    const ok = await injector.evaluateOnTarget(`ws://127.0.0.1:${port}/page/1`, 'throw new Error("x")');
    const elapsedMs = Date.now() - t0;
    assert.equal(ok, false);
    assert.ok(elapsedMs < 600, `expected fast exceptionDetails resolution (<600ms), got ${elapsedMs}ms`);
  } finally {
    for (const s of upgradedSockets) {
      try {
        s.destroy();
      } catch {}
    }
    wsServer.closeAllConnections?.();
    await new Promise((done) => wsServer.close(() => done()));
  }
});

test('installer & cli: setAppAutostart dryRun and offline cli status --json expose sanitized local config', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'atm-cli-offline-'));
  try {
    const fakeExe = join(tmpDir, 'AITurnMeter');
    writeFileSync(fakeExe, '');
    const enRes = setAppAutostart(true, { homeDir: tmpDir, appExe: fakeExe, dryRun: true, log: () => {} });
    assert.equal(enRes.enabled, true);
    assert.equal(existsSync(enRes.plistPath), false);
    const plistXml = buildAppLaunchAgentPlist({ appExe: fakeExe });
    assert.equal(plistXml.includes(fakeExe), true);

    mkdirSync(join(tmpDir, 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(enRes.plistPath, plistXml);
    const disRes = setAppAutostart(false, { homeDir: tmpDir, dryRun: true, log: () => {} });
    assert.equal(disRes.enabled, false);
    assert.equal(existsSync(enRes.plistPath), true);

    writeFileSync(
      join(tmpDir, 'config.json'),
      JSON.stringify({
        enabled: false,
        cursorCookie: 'WorkosCursorSessionToken=secret',
        tools: { codex: false, cursor: true },
      })
    );

    const probeSrv = http.createServer();
    await new Promise((resolve) => probeSrv.listen(0, '127.0.0.1', resolve));
    const closedPort = probeSrv.address().port;
    await new Promise((resolve) => probeSrv.close(resolve));

    const out = execFileSync(
      process.execPath,
      [join(process.cwd(), 'packages/daemon/bin/cli.mjs'), 'status', '--json'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          AI_TURN_METER_STATE_DIR: tmpDir,
          AI_TURN_METER_PORT: String(closedPort),
        },
      }
    );
    const status = JSON.parse(out);
    assert.equal(status.online, false);
    assert.equal(status.config.enabled, false);
    assert.equal(status.config.hasCursorCookie, true);
    assert.equal(status.config.cursorCookie, undefined);
    assert.equal(status.config.tools.codex, false);
    assert.equal(status.externalProviders, null);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('pricing: supports Grok 4.6/4.7, -fast multipliers, Gemini 4 schedule, Claude 1h cache/geo, Fable/DeepSeek, and cursor-ide cumulative guard', () => {
  // 1. Grok 4.7 short vs >200K long context + -fast 2x multiplier
  const grokShort = estimateTurnCost({
    model: 'grok-4.7-xhigh',
    totalInputTokens: 150_000,
    uncachedInputTokens: 50_000,
    cacheReadTokens: 100_000,
    outputTokens: 10_000,
    callCount: 1,
  });
  // 0.05*2 + 0.1*0.5 + 0.01*6 = 0.1 + 0.05 + 0.06 = 0.21
  assert.equal(grokShort.costUsd, 0.21);

  const grokLong = estimateTurnCost({
    model: 'grok-4.7-xhigh',
    totalInputTokens: 250_000,
    uncachedInputTokens: 50_000,
    cacheReadTokens: 200_000,
    outputTokens: 10_000,
    callCount: 1,
  });
  // 0.05*4 + 0.2*1 + 0.01*12 = 0.2 + 0.2 + 0.12 = 0.52
  assert.equal(grokLong.costUsd, 0.52);

  const grokFast = estimateTurnCost({
    model: 'grok-4.7-xhigh-fast',
    totalInputTokens: 150_000,
    uncachedInputTokens: 50_000,
    cacheReadTokens: 100_000,
    outputTokens: 10_000,
    callCount: 1,
  });
  assert.equal(grokFast.costUsd, 0.42);

  // 2. claude-opus-5-5-xhigh-fast (2x on $4/$0.2/$20) vs composer-2.5-fast (dedicated rate, no double mult)
  const opus55Fast = estimateTurnCost({
    model: 'claude-opus-5-5-xhigh-fast',
    totalInputTokens: 1_000_000,
    uncachedInputTokens: 0,
    cacheReadTokens: 1_000_000,
    outputTokens: 100_000,
    callCount: 10,
  });
  // (1*0.2 + 0.1*20) * 2 = 2.2 * 2 = 4.4
  assert.equal(opus55Fast.costUsd, 4.4);

  const compFast = estimateTurnCost({
    model: 'composer-2.5-fast',
    totalInputTokens: 1_000_000,
    uncachedInputTokens: 1_000_000,
    cacheReadTokens: 0,
    outputTokens: 0,
    callCount: 1,
  });
  assert.equal(compFast.costUsd, 3.0);

  // 3. Claude Fable 5.1/5.2 & DeepSeek Flash
  assert.equal(resolveModelPricing('claude-fable-5-1')?.cacheRead, 0.25);
  assert.equal(resolveModelPricing('claude-fable-5-2')?.input, 8.0);
  assert.equal(resolveModelPricing('deepseek-flash')?.input, 0.27);
  assert.equal(resolveModelPricing('deepseek-v41-flash-1017-max')?.output, 1.1);

  // 4. Gemini 4 updated flat 1M rates & Argon/Carbon Dec 1, 2026 schedule
  const neon300k = estimateTurnCost({
    model: 'gemini-4-neon',
    totalInputTokens: 300_000,
    uncachedInputTokens: 100_000,
    cacheReadTokens: 200_000,
    outputTokens: 10_000,
    callCount: 1,
  });
  // flat 1M: 0.1*3 + 0.2*0.15 + 0.01*15 = 0.3 + 0.03 + 0.15 = 0.48
  assert.equal(neon300k.costUsd, 0.48);

  const hydroTiered = estimateTurnCost({
    model: 'gemini-4-hydrogen-tiered-high',
    totalInputTokens: 1_000_000,
    uncachedInputTokens: 0,
    cacheReadTokens: 1_000_000,
    outputTokens: 100_000,
    callCount: 5,
  });
  // 1*0.075 + 0.1*7.5 = 0.825
  assert.equal(hydroTiered.costUsd, 0.825);

  const argonNov = estimateTurnCost({
    model: 'gemini-4-argon-high',
    completedAtMs: Date.UTC(2026, 10, 30, 23, 59, 59),
    totalInputTokens: 1_000_000,
    uncachedInputTokens: 500_000,
    cacheReadTokens: 500_000,
    outputTokens: 100_000,
    callCount: 5,
  });
  // Nov promo: 0.5*2 + 0.5*0.1 + 0.1*10 = 2.05
  assert.equal(argonNov.costUsd, 2.05);

  const argonDec = estimateTurnCost({
    model: 'gemini-4-argon-high',
    completedAtMs: Date.UTC(2026, 11, 1, 0, 0, 0),
    totalInputTokens: 1_000_000,
    uncachedInputTokens: 500_000,
    cacheReadTokens: 500_000,
    outputTokens: 100_000,
    callCount: 5,
  });
  // Dec standard: 0.5*4 + 0.5*0.2 + 0.1*20 = 4.1
  assert.equal(argonDec.costUsd, 4.1);

  // 5. cursor-ide cumulative callCount=1 should NOT trigger >200K long-context 2x surcharge
  const cursorHook = estimateTurnCost({
    host: 'cursor-ide',
    model: 'claude-sonnet-4-5',
    totalInputTokens: 1_500_000,
    uncachedInputTokens: 500_000,
    cacheReadTokens: 1_000_000,
    outputTokens: 20_000,
    callCount: 1,
  });
  // Short tier: 0.5*3 + 1.0*0.3 + 0.02*15 = 1.5 + 0.3 + 0.3 = 2.1
  assert.equal(cursorHook.costUsd, 2.1);
});
