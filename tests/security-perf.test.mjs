import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AntigravityAdapter } from '../packages/daemon/src/adapters/antigravity.mjs';
import { CodeBuddyAdapter } from '../packages/daemon/src/adapters/codebuddy.mjs';
import { CodexAdapter } from '../packages/daemon/src/adapters/codex.mjs';
import { validateLocalRequest, verifyDaemonToken } from '../packages/daemon/src/auth.mjs';
import { CdpInlineInjector } from '../packages/daemon/src/cdp-injector.mjs';
import { probeCodexProtocol } from '../packages/daemon/src/fingerprint.mjs';
import { httpRequestRaw } from '../packages/daemon/src/net.mjs';
import { getAllQuotas, resetQuotaCacheForTests } from '../packages/daemon/src/quota.mjs';
import { createMeterServer } from '../packages/daemon/src/server.mjs';
import { TurnStore } from '../packages/daemon/src/store.mjs';

function rawHttpRequest({ port, method = 'GET', path = '/', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          data += c;
        });
        res.on('end', () => {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        });
      }
    );
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

test('Daemon enforces local Host, blocks browser Origins, requires X-ATM-Token, and sets 0600 permissions', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'atm-sec-'));
  const dbPath = join(tmpDir, 'meter.db');
  const meter = createMeterServer({
    port: 0,
    dbPath,
    stateDir: tmpDir,
    enableWatchers: false,
    enableCdp: false,
    enableAntigravityRpc: false,
    enableQuotaProbe: false,
  });

  try {
    const addr = await meter.start();
    const port = addr.port;
    const base = `http://127.0.0.1:${port}`;

    // Verify daemon.token created with 0o600
    const tokenMode = statSync(join(tmpDir, 'daemon.token')).mode & 0o777;
    assert.equal(tokenMode, 0o600);

    // Browser Origin blocked with 403 and no ACAO header
    const originRes = await rawHttpRequest({
      port,
      method: 'GET',
      path: '/v1/state',
      headers: { Origin: 'https://evil.example' },
    });
    assert.equal(originRes.status, 403);
    assert.equal(originRes.headers['access-control-allow-origin'], undefined);

    // Sec-Fetch-Site cross-site blocked
    const sfsRes = await rawHttpRequest({
      port,
      method: 'GET',
      path: '/health',
      headers: { 'Sec-Fetch-Site': 'cross-site' },
    });
    assert.equal(sfsRes.status, 403);

    // Non-loopback Host blocked (DNS rebinding guard)
    const hostRes = await rawHttpRequest({
      port,
      method: 'GET',
      path: '/health',
      headers: { Host: 'evil.example:47831' },
    });
    assert.equal(hostRes.status, 403);

    // OPTIONS preflight blocked
    const optRes = await rawHttpRequest({ port, method: 'OPTIONS', path: '/v1/config' });
    assert.equal(optRes.status, 403);
    assert.equal(optRes.headers['access-control-allow-origin'], undefined);

    // Protected routes reject missing/invalid token with 401
    for (const [method, path] of [
      ['POST', '/v1/config'],
      ['POST', '/v1/ingest'],
      ['POST', '/v1/cursor/sync-local'],
      ['GET', '/v1/fingerprint/overview'],
      ['POST', '/v1/fingerprint/endpoints'],
      ['DELETE', '/v1/fingerprint/endpoints?id=x'],
      ['DELETE', '/v1/fingerprint/baselines?id=x'],
      ['POST', '/v1/fingerprint/run'],
    ]) {
      const unauth = await fetch(`${base}${path}`, {
        method,
        headers: method === 'POST' ? { 'Content-Type': 'application/json' } : {},
        body: method === 'POST' ? '{}' : undefined,
      });
      assert.equal(unauth.status, 401, `${method} ${path} should require token`);
    }

    // Valid token (and Bearer token) accepted, and config.json written with 0o600
    const cfgRes = await fetch(`${base}/v1/config`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${meter.authToken}`,
      },
      body: JSON.stringify({ cursorCookie: 'WorkosCursorSessionToken=sec::tok' }),
    });
    assert.equal(cfgRes.status, 200);
    const cfgMode = statSync(join(tmpDir, 'config.json')).mode & 0o777;
    assert.equal(cfgMode, 0o600);

    // Remote-SSH /v1/ingest/cursor-hook works without token, rejects invalid event names, and rejects browser Origin
    const badHook = await fetch(`${base}/v1/ingest/cursor-hook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hook_event_name: 'arbitraryUnknownEvent' }),
    });
    assert.equal(badHook.status, 400);

    const okHook = await fetch(`${base}/v1/ingest/cursor-hook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hook_event_name: 'beforeSubmitPrompt',
        conversation_id: 'sec-conv',
        generation_id: 'sec-gen',
      }),
    });
    assert.equal(okHook.status, 200);

    const originHook = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/v1/ingest/cursor-hook',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://evil.example',
      },
      body: JSON.stringify({ hook_event_name: 'beforeSubmitPrompt' }),
    });
    assert.equal(originHook.status, 403);

    // >1MB POST returns 413 cleanly without crashing server
    const bigBody = JSON.stringify({ pad: 'a'.repeat(1024 * 1024 + 128) });
    const bigRes = await fetch(`${base}/v1/config`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-atm-token': meter.authToken,
      },
      body: bigBody,
    });
    assert.equal(bigRes.status, 413);

    const healthAfter = await fetch(`${base}/health`);
    assert.equal(healthAfter.status, 200);

    // Unit helpers validateLocalRequest & verifyDaemonToken
    assert.equal(validateLocalRequest({ headers: { host: 'localhost:47831' } }).ok, true);
    assert.equal(validateLocalRequest({ headers: { host: '[::1]:47831', 'sec-fetch-site': 'none' } }).ok, true);
    assert.equal(verifyDaemonToken({ headers: { 'x-atm-token': meter.authToken } }, meter.authToken), true);
    assert.equal(verifyDaemonToken({ headers: { 'x-atm-token': 'wrong' } }, meter.authToken), false);
  } finally {
    await meter.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Shared net.mjs httpRequestRaw preserves headers/body and fingerprint uses it', async () => {
  const raw429 = await httpRequestRaw('https://api.example.com/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      headers: new Map([
        ['X-Codex-Active-Limit', 'codex-pro'],
        ['OpenAI-Model', 'gpt-6.1-sol'],
      ]),
      text: async () => JSON.stringify({ error: { message: 'rate limited' } }),
    }),
  });
  assert.equal(raw429.ok, false);
  assert.equal(raw429.status, 429);
  assert.equal(raw429.headers['x-codex-active-limit'], 'codex-pro');
  assert.ok(raw429.text.includes('rate limited'));

  const tmpCodex = mkdtempSync(join(tmpdir(), 'atm-fp-net-'));
  try {
    // Minimal codex home with API key so probeCodexProtocol invokes callModelOnce
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(tmpCodex, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-test-net-123' }));
    const res = await probeCodexProtocol({
      codexHome: tmpCodex,
      modelOverride: 'gpt-6.1-sol',
      fetchImpl: async () => ({
        ok: false,
        status: 429,
        headers: new Map([
          ['openai-model', 'gpt-6.1-sol'],
          ['x-codex-turn-state', 'tok123456'],
        ]),
        text: async () => JSON.stringify({ error: { message: 'too many requests' } }),
      }),
    });
    assert.equal(res.ok, false);
    assert.equal(res.details.headerEval.turnStateLength, 9);
    assert.equal(res.responseModel, 'gpt-6.1-sol');
  } finally {
    rmSync(tmpCodex, { recursive: true, force: true });
  }
});

test('Disabled tools skip adapter scans and quota cache isolates enabledTools', async () => {
  const store = new TurnStore(':memory:');
  try {
    let enabled = false;
    const codex = new CodexAdapter({ store, sessionsDir: '/nonexistent-dir', isEnabled: () => enabled });
    const agy = new AntigravityAdapter({ store, geminiRoot: '/nonexistent-dir', enableRpc: false, isEnabled: () => enabled });
    const cb = new CodeBuddyAdapter({ store, extDataDir: '/nonexistent-dir', cliProjectsDir: '/nonexistent-dir', isEnabled: () => enabled });

    assert.deepEqual(codex.scan(), []);
    assert.deepEqual(await agy.scan(), []);
    assert.deepEqual(cb.scan(), []);

    resetQuotaCacheForTests();
    const qOff = await getAllQuotas(Date.now(), {
      allowNetwork: false,
      enabledTools: { codex: false, antigravity: false, cursor: false, codebuddy: false },
    });
    assert.equal(qOff.codex.quotaWindows.length, 0);
    assert.equal(qOff.all.accountEmail, null);
  } finally {
    resetQuotaCacheForTests();
    store.close();
  }
});

test('CdpInlineInjector caches per target.id + url and injects new targets cleanly', async () => {
  let targets = [{ id: 'win-1', type: 'page', url: 'https://chat.local/c/1', webSocketDebuggerUrl: 'ws://127.0.0.1:47921/1' }];
  const evalCalls = [];

  const turn = {
    turnUid: 'codex:s1:t1',
    tool: 'codex',
    sessionId: 's1',
    turnId: 't1',
    completedAtMs: 1000,
    tps: 55,
    totalInputTokens: 1200,
    replyPreview: 'hello',
  };

  const injector = new CdpInlineInjector({
    specs: [{ tool: 'codex', port: 47921 }],
    getTurnsForTool: () => [turn],
  });
  injector.findTargets = async () => targets;
  injector.evaluateOnTarget = async (wsUrl) => {
    evalCalls.push(wsUrl);
    return true;
  };

  const spec = injector.specs[0];
  assert.equal(await injector.pushTool(spec), true);
  assert.deepEqual(evalCalls, ['ws://127.0.0.1:47921/1']);

  // Second tick with unchanged target & turns -> skipped
  assert.equal(await injector.pushTool(spec), false);
  assert.equal(evalCalls.length, 1);

  // New window target opens -> only new target injected
  targets = [
    ...targets,
    { id: 'win-2', type: 'page', url: 'https://chat.local/c/2', webSocketDebuggerUrl: 'ws://127.0.0.1:47921/2' },
  ];
  assert.equal(await injector.pushTool(spec), true);
  assert.deepEqual(evalCalls, ['ws://127.0.0.1:47921/1', 'ws://127.0.0.1:47921/2']);

  // Existing win-1 navigates to new URL -> win-1 re-injected
  targets[0] = { ...targets[0], url: 'https://chat.local/c/3' };
  assert.equal(await injector.pushTool(spec), true);
  assert.deepEqual(evalCalls, ['ws://127.0.0.1:47921/1', 'ws://127.0.0.1:47921/2', 'ws://127.0.0.1:47921/1']);
});

test('TurnStore caches aggregations with generation invalidation, deduplicates Cursor cloud+local, and /v1/apps works', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'atm-perf-'));
  const meter = createMeterServer({
    port: 0,
    dbPath: join(tmpDir, 'meter.db'),
    stateDir: tmpDir,
    enableWatchers: false,
    enableCdp: false,
    enableAntigravityRpc: false,
    enableQuotaProbe: false,
  });

  try {
    const addr = await meter.start();
    const base = `http://127.0.0.1:${addr.port}`;
    const store = meter.store;
    const now = Date.now();

    // Insert cloud Cursor event first
    store.upsertTurn({
      turnUid: 'cursor:api:ev-1',
      tool: 'cursor',
      host: 'cursor-cloud',
      sessionId: 'conv-dedup',
      turnId: 'ev-1',
      model: 'claude-sonnet-4-5',
      completedAtMs: now - 5000,
      totalInputTokens: 15000,
      uncachedInputTokens: 3000,
      cacheReadTokens: 12000,
      outputTokens: 400,
      explicitCostUsd: 0.02,
    });

    const u1 = store.getUsageSummary({
      days: 7,
      nowMs: now,
      quotasByTool: { cursor: { accountEmail: 'a@b.com', planTitle: 'Pro', quotaWindows: [] } },
    });
    assert.equal(u1.totals.turnCount, 1);
    assert.equal(u1.cards.cursor.accountEmail, 'a@b.com');

    // Cache hit with updated quotasByTool overlays cleanly without stale quota metadata
    const u2 = store.getUsageSummary({
      days: 7,
      nowMs: now,
      quotasByTool: { cursor: { accountEmail: 'c@d.com', planTitle: 'Ultra', quotaWindows: [] } },
    });
    assert.equal(u2.totals.turnCount, 1);
    assert.equal(u2.cards.cursor.accountEmail, 'c@d.com');
    assert.equal(u2.cards.cursor.planTitle, 'Ultra');

    // Delayed local hook arrives for the same turn -> must delete overlapping cursor-cloud row
    store.upsertTurn({
      turnUid: 'cursor:conv-dedup:gen-1',
      tool: 'cursor',
      host: 'cursor-ide',
      sessionId: 'conv-dedup',
      turnId: 'gen-1',
      model: 'claude-sonnet-4-5',
      workspacePath: '/tmp/proj-dedup',
      completedAtMs: now - 4000,
      totalInputTokens: 15000,
      uncachedInputTokens: 3000,
      cacheReadTokens: 12000,
      outputTokens: 400,
      durationMs: 4000,
      modelActiveMs: 4000,
    });

    const u3 = store.getUsageSummary({ days: 7, nowMs: now });
    assert.equal(u3.totals.turnCount, 1);
    const recent = store.getRecentTurns(10, 'cursor');
    assert.equal(recent.length, 1);
    assert.equal(recent[0].host, 'cursor-ide');

    // Receipt cache invalidates on new turn
    const r1 = store.getReceiptData({ nowMs: now });
    assert.equal(r1.totals.turnCount, 1);
    store.upsertTurn({
      turnUid: 'codex:s2:t1',
      tool: 'codex',
      sessionId: 's2',
      turnId: 't1',
      model: 'gpt-6.1-sol',
      completedAtMs: now - 1000,
      totalInputTokens: 5000,
      outputTokens: 200,
    });
    const r2 = store.getReceiptData({ nowMs: now });
    assert.equal(r2.totals.turnCount, 2);

    // /v1/apps endpoint returns StatusResponse shape
    const appsRes = await fetch(`${base}/v1/apps`);
    assert.equal(appsRes.status, 200);
    const appsJson = await appsRes.json();
    assert.equal(appsJson.online, true);
    assert.ok(appsJson.apps.codex && appsJson.apps.cursor && appsJson.apps.antigravity && appsJson.apps.codebuddy);
    assert.equal(appsJson.apps.codex.latestTurn.model, 'gpt-6.1-sol');

    // cursor-hook.mjs posts directly to /v1/ingest/cursor-hook when daemon is online
    const hookBin = join(process.cwd(), 'packages', 'daemon', 'bin', 'cursor-hook.mjs');
    const runHook = (payload) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [hookBin], {
          env: {
            ...process.env,
            AI_TURN_METER_PORT: String(addr.port),
            AI_TURN_METER_STATE_DIR: tmpDir,
          },
          stdio: ['pipe', 'ignore', 'pipe'],
        });
        let err = '';
        child.stderr.on('data', (d) => {
          err += d;
        });
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err || `exit ${code}`))));
        child.stdin.end(JSON.stringify(payload));
      });

    await runHook({
      hook_event_name: 'beforeSubmitPrompt',
      conversation_id: 'online-conv',
      generation_id: 'online-gen',
      workspace_roots: ['/tmp/ws-online'],
    });
    await runHook({
      hook_event_name: 'stop',
      conversation_id: 'online-conv',
      generation_id: 'online-gen',
      model_id: 'claude-opus-4-6',
      input_tokens: 6000,
      cache_read_tokens: 4000,
      output_tokens: 250,
    });
    const matchRes = await (await fetch(`${base}/v1/match?tool=cursor&workspace=${encodeURIComponent('/tmp/ws-online')}`)).json();
    assert.equal(matchRes.turn.turnId, 'online-gen');
    assert.ok(typeof matchRes.turn.startedAtMs === 'number');
  } finally {
    await meter.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
