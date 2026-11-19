import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  analyzePassiveTelemetry,
  buildManualProbePack,
  computeJsDivergence,
  evaluateCodexProtocolSignals,
  runQuickCapabilityProbes,
  runTokenDistributionFingerprint,
  sanitizeEndpoint,
  scoreManualProbeResponse,
} from '../packages/daemon/src/fingerprint.mjs';
import {
  buildBarcodeBars,
  formatReceiptMoney,
  renderReceiptAscii,
  renderReceiptSvg,
} from '../packages/daemon/src/receipt.mjs';
import { estimateTurnCost, resolveModelPricing } from '../packages/daemon/src/pricing.mjs';
import { APP_SPECS, readActivePort } from '../packages/daemon/src/apps.mjs';
import { CdpInlineInjector } from '../packages/daemon/src/cdp-injector.mjs';
import { parseCursorQuotaSummary } from '../packages/daemon/src/quota.mjs';
import { createMeterServer } from '../packages/daemon/src/server.mjs';
import { TurnStore } from '../packages/daemon/src/store.mjs';

test('L0 passive telemetry detects TPS spike, thinking drop, and flagship-to-lightweight session drift', () => {
  const store = new TurnStore(':memory:');
  try {
    const baseMs = Date.now() - 3 * 3600_000;
    // 6 normal flagship turns establishing baseline (~55 tok/s, ~1800 thinking tokens)
    for (let i = 0; i < 6; i += 1) {
      store.upsertTurn({
        turnUid: `codex:s1:norm-${i}`,
        tool: 'codex',
        sessionId: 's1',
        turnId: `norm-${i}`,
        model: 'gpt-6-astra',
        completedAtMs: baseMs + i * 60_000,
        totalInputTokens: 20_000,
        cacheReadTokens: 16_000,
        outputTokens: 400,
        thinkingTokens: 1800,
        tps: 55 + (i % 3),
        tpsMethod: 'streaming_decode',
      });
    }

    // Anomalous turn 1: TPS spikes to 260 tok/s & thinking drops to 0
    store.upsertTurn({
      turnUid: 'codex:s1:anom-spike',
      tool: 'codex',
      sessionId: 's1',
      turnId: 'anom-spike',
      model: 'gpt-6-astra',
      completedAtMs: baseMs + 10 * 60_000,
      totalInputTokens: 22_000,
      cacheReadTokens: 18_000,
      outputTokens: 320,
      thinkingTokens: 0,
      tps: 260,
      tpsMethod: 'streaming_decode',
    });

    // Anomalous turn 2: same session downgrades to lightweight model
    store.upsertTurn({
      turnUid: 'codex:s1:anom-drift',
      tool: 'codex',
      sessionId: 's1',
      turnId: 'anom-drift',
      model: 'gpt-6-luna',
      completedAtMs: baseMs + 12 * 60_000,
      totalInputTokens: 24_000,
      cacheReadTokens: 20_000,
      outputTokens: 250,
      thinkingTokens: 0,
      tps: 240,
      tpsMethod: 'streaming_decode',
    });

    const report = analyzePassiveTelemetry(store, { days: 7 });
    assert.equal(report.overallStatus, 'degraded');
    assert.equal(report.byTool.codex.status, 'degraded');
    const kinds = new Set(report.anomalies.map((a) => a.kind));
    assert.ok(kinds.has('tps_spike'), 'should detect tps_spike');
    assert.ok(kinds.has('thinking_drop'), 'should detect thinking_drop');
    assert.ok(kinds.has('model_drift'), 'should detect model_drift');
  } finally {
    store.close();
  }
});

test('L0.5 Codex protocol evaluator flags model mismatch, active safety-buffering, and ignores normal enabled header', () => {
  const mismatch = evaluateCodexProtocolSignals({
    requestedModel: 'gpt-6-astra',
    responseModel: 'gpt-6-luna',
    headers: {
      'x-codex-turn-state': 'abcdef1234567890',
      'x-codex-safety-buffering-enabled': 'true',
      'x-oneapi-request-id': 'req-123',
    },
    safetyBufferingActive: true,
    status: 200,
    latencyMs: 320,
  });
  assert.equal(mismatch.verdict, 'suspected_swap');
  assert.equal(mismatch.modelMismatch, true);
  assert.equal(mismatch.turnStateLength, 16);
  assert.equal(mismatch.headers['x-codex-turn-state'], '<len:16>');
  assert.ok(mismatch.findings.some((f) => f.code === 'safety_buffering'));
  assert.ok(mismatch.findings.some((f) => f.code === 'third_party_relay'));

  const ok = evaluateCodexProtocolSignals({
    requestedModel: 'gpt-6.2-sol',
    responseModel: 'gpt-6.2-sol',
    headers: {
      'x-codex-safety-buffering-enabled': 'true',
      'x-codex-plan-type': 'plus',
      'x-codex-active-limit': 'premium',
      'x-request-id': 'req-ok',
    },
    safetyBufferingActive: false,
    status: 200,
    latencyMs: 180,
  });
  assert.equal(ok.verdict, 'healthy');
  assert.equal(ok.modelMismatch, false);
});

test('L1 quick capability probes score full-strength vs degraded vs swapped endpoints accurately', async () => {
  const perfectAnswers = [
    '3,1',
    '8',
    '{"sum":43,"rev":"xedoc","even":true}',
    '4',
    '2',
    'A cat\nB dog\nC fox',
    'R,Q,P,S',
    '前者指尽量多穿保暖；后者指尽量少穿清凉。',
  ];

  let idx = 0;
  const mockGoodFetch = async () => {
    const content = perfectAnswers[idx++] || '';
    return {
      ok: true,
      status: 200,
      headers: new Map([['openai-model', 'claude-opus-4-6']]),
      text: async () =>
        JSON.stringify({
          model: 'claude-opus-4-6',
          choices: [{ message: { content } }],
        }),
    };
  };

  const goodRes = await runQuickCapabilityProbes({
    targetType: 'endpoint',
    targetName: 'Official',
    endpointConfig: {
      protocol: 'openai',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test-123456',
      model: 'claude-opus-4-6',
    },
    fetchImpl: mockGoodFetch,
  });
  assert.equal(goodRes.ok, true);
  assert.equal(goodRes.score, 100);
  assert.equal(goodRes.verdict, 'healthy');
  assert.equal(goodRes.details.passedCount, 8);

  // Swapped model check (even with correct answers, responseModel mismatch flags suspected_swap)
  idx = 0;
  const mockSwapFetch = async () => {
    const content = perfectAnswers[idx++] || '';
    return {
      ok: true,
      status: 200,
      headers: new Map(),
      text: async () =>
        JSON.stringify({
          model: 'gpt-4o-mini',
          choices: [{ message: { content } }],
        }),
    };
  };
  const swapRes = await runQuickCapabilityProbes({
    targetType: 'endpoint',
    targetName: 'Relay',
    endpointConfig: {
      protocol: 'openai',
      baseUrl: 'https://relay.example.com/v1',
      apiKey: 'sk-test-123456',
      model: 'claude-opus-4-6',
    },
    fetchImpl: mockSwapFetch,
  });
  assert.equal(swapRes.verdict, 'suspected_swap');

  // Manual semi-auto probe pack & scorer
  const pack = buildManualProbePack();
  assert.ok(pack.prompt.includes('[ATM-PROBE-V1]'));
  const manualOk = scoreManualProbeResponse(
    '{"q1":"3,1","q2":8,"q3":4,"q4":2,"q5":"R,Q,P,S"}',
    { tool: 'antigravity', model: 'gemini-4-neon' }
  );
  assert.equal(manualOk.ok, true);
  assert.equal(manualOk.score, 100);
  assert.equal(manualOk.verdict, 'healthy');
});

test('L2 single-token distribution JS divergence detects matching vs swapped distribution with baseline', async () => {
  assert.equal(computeJsDivergence({ '7': 8, '3': 2 }, { '7': 8, '3': 2 }), 0);
  assert.ok(computeJsDivergence({ '7': 10 }, { '2': 10 }) === 1);

  const store = new TurnStore(':memory:');
  try {
    const makeMockFetch = (answers) => async (_url, init) => {
      const body = JSON.parse(init.body);
      const p = body.messages?.[0]?.content || '';
      let reply = 'blue';
      if (p.includes('integer')) reply = answers.int;
      else if (p.includes('color')) reply = answers.color;
      else if (p.includes('fruit')) reply = answers.fruit;
      else if (p.includes('letter')) reply = answers.letter;
      else if (p.includes('animal')) reply = answers.animal;
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        text: async () =>
          JSON.stringify({
            model: 'claude-opus-4-6',
            choices: [{ message: { content: reply } }],
          }),
      };
    };

    const ep = {
      protocol: 'openai',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test-999999',
      model: 'claude-opus-4-6',
    };

    // 1. Record official baseline
    const recorded = await runTokenDistributionFingerprint({
      targetType: 'endpoint',
      targetName: 'Official',
      endpointConfig: ep,
      sampleCount: 15,
      recordBaseline: true,
      baselineName: 'Opus Official',
      store,
      fetchImpl: makeMockFetch({ int: '7', color: 'blue', fruit: 'apple', letter: 'K', animal: 'fox' }),
    });
    assert.equal(recorded.verdict, 'baseline_recorded');
    assert.equal(store.listFingerprintBaselines().length, 1);

    // 2. Compare identical distribution -> healthy (JS = 0)
    const matched = await runTokenDistributionFingerprint({
      targetType: 'endpoint',
      targetName: 'Official Check',
      endpointConfig: ep,
      sampleCount: 15,
      store,
      fetchImpl: makeMockFetch({ int: '7', color: 'blue', fruit: 'apple', letter: 'K', animal: 'fox' }),
    });
    assert.equal(matched.verdict, 'healthy');
    assert.equal(matched.jsDistance, 0);

    // 3. Compare shifted distribution -> suspected_swap (JS = 1.0)
    const swapped = await runTokenDistributionFingerprint({
      targetType: 'endpoint',
      targetName: 'Suspicious Relay',
      endpointConfig: ep,
      sampleCount: 15,
      store,
      fetchImpl: makeMockFetch({ int: '4', color: 'green', fruit: 'banana', letter: 'M', animal: 'cat' }),
    });
    assert.equal(swapped.verdict, 'suspected_swap');
    assert.equal(swapped.jsDistance, 1);

    // Verify sanitizeEndpoint hides full apiKey
    const san = sanitizeEndpoint({ id: 'e1', name: 'Test', baseUrl: ep.baseUrl, model: ep.model, apiKey: 'sk-secret-abcdef1234' });
    assert.equal(san.hasApiKey, true);
    assert.equal(san.apiKeyPreview, 'sk-s...1234');
    assert.equal('apiKey' in san, false);
  } finally {
    store.close();
  }
});

test('Daily thermal receipt aggregates items, currency conversion (1:7 & custom), ASCII & SVG exports', () => {
  const store = new TurnStore(':memory:');
  try {
    const dayTs = new Date(2026, 10, 19, 14, 30, 0).getTime();
    store.upsertTurn({
      turnUid: 'codex:s1:r1',
      tool: 'codex',
      sessionId: 's1',
      turnId: 'r1',
      model: 'gpt-6.2-sol',
      workspacePath: '/Users/dev/secret-repo',
      completedAtMs: dayTs,
      totalInputTokens: 100_000,
      uncachedInputTokens: 10_000,
      cacheReadTokens: 90_000,
      outputTokens: 5_000,
      tps: 92,
      tpsMethod: 'streaming_decode',
    });
    store.upsertTurn({
      turnUid: 'antigravity:s2:r2',
      tool: 'antigravity',
      sessionId: 's2',
      turnId: 'r2',
      model: 'claude-sonnet-4-5',
      workspacePath: '/Users/dev/secret-repo',
      completedAtMs: dayTs + 3600_000,
      totalInputTokens: 50_000,
      uncachedInputTokens: 10_000,
      cacheReadTokens: 40_000,
      outputTokens: 2_000,
      tps: 75,
      tpsMethod: 'streaming_decode',
    });

    const receipt = store.getReceiptData({ date: '2026-11-19', scope: 'day', groupBy: 'model', nowMs: dayTs + 7200_000 });
    assert.equal(receipt.date, '2026-11-19');
    assert.equal(receipt.receiptNo, 'ATM-20261119-002');
    assert.equal(receipt.items.length, 2);
    assert.equal(receipt.agentBreakdown.length, 2);
    assert.equal(receipt.streakDays, 1);
    assert.equal(receipt.vsDailyAvgRatio, 1);
    assert.ok(receipt.totals.estimatedCostUsd > 0);
    assert.ok(receipt.totals.cacheSavingsUsd > 0);
    assert.ok(receipt.totals.grossCostUsd > receipt.totals.estimatedCostUsd);
    assert.equal(receipt.highlights.topProject.name, 'secret-repo');

    assert.equal(formatReceiptMoney(1.0, { currency: 'both', usdToCny: 7 }), '$1.00 (¥7.00)');
    assert.equal(formatReceiptMoney(1.0, { currency: 'cny', usdToCny: 7.25 }), '¥7.25');
    assert.equal(formatReceiptMoney(1.0, { currency: 'usd', usdToCny: 7 }), '$1.00');
    assert.equal(buildBarcodeBars(receipt.barcodeSeed, 20).length, 20);

    const ascii = renderReceiptAscii(receipt, { currency: 'both', usdToCny: 7, hideProjects: true });
    assert.ok(ascii.includes('每日 AI 账单'));
    assert.ok(ascii.includes('ATM-20261119-002'));
    assert.ok(ascii.includes('1 USD = 7 CNY'));
    assert.ok(!ascii.includes('secret-repo'), 'hideProjects should strip project name');

    const svg = renderReceiptSvg(receipt, { theme: 'dark', currency: 'both', usdToCny: 7.2, hideProjects: false });
    assert.ok(svg.startsWith('<svg '));
    assert.ok(svg.includes('每日 AI 账单'));
    assert.ok(svg.includes('AI Turn Meter'));
    assert.ok(svg.includes('ATM-20261119-002'));
    assert.ok(svg.includes('1:7.2'));
  } finally {
    store.close();
  }
});

test('Pricing resolves gemini-4-neon, inverted Claude names, parenthetical context suffixes, and DeepSeek/GLM variants', () => {
  for (const name of [
    'gemini-4-neon',
    'gemini-4-neon-high',
    'Claude-Opus-4.6 (1M context)',
    'Claude-Opus-4.8 (1M context)',
    'Claude-4.5-Opus',
    'Claude-4.0-Sonnet',
    'DeepSeek V4 Pro 1M',
    'GLM-5.2',
    'cursor-grok-4.6-xhigh-fast',
  ]) {
    assert.ok(resolveModelPricing(name), `expected pricing for ${name}`);
  }

  const est = estimateTurnCost({
    model: 'gemini-4-neon',
    totalInputTokens: 4_876_869,
    uncachedInputTokens: 336_320,
    cacheReadTokens: 4_540_549,
    cacheWriteTokens: 0,
    outputTokens: 89_823,
    callCount: 38,
  });
  assert.equal(est.priced, true);
  assert.ok(est.costUsd > 2 && est.costUsd < 4);
  assert.ok(est.savingsUsd > 7);
});

test('Antigravity CDP port resolution prefers DevToolsActivePort and falls back to static port 47924', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'atm-agy-port-'));
  try {
    const injector = new CdpInlineInjector({ getTurnsForTool: () => [] });
    const missingPortFile = join(tmpDir, 'DevToolsActivePort');
    // Fallback to static port when DevToolsActivePort is absent
    assert.equal(
      injector.resolvePort({ tool: 'antigravity', portFile: missingPortFile, port: 47924 }),
      47924
    );
    assert.equal(
      readActivePort({ ...APP_SPECS.antigravity, portFile: missingPortFile, port: 47924 }, tmpDir, new Set([47924])),
      47924
    );
    assert.equal(
      readActivePort({ ...APP_SPECS.antigravity, portFile: missingPortFile, port: 47924 }, tmpDir, new Set()),
      null
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('parseCursorQuotaSummary appends standalone Grok Bot weekly quota alongside dual-pool plans', () => {
  const nowMs = Date.parse('2026-11-19T07:24:00.000Z');
  const parsed = parseCursorQuotaSummary(
    {
      billingCycleStart: '2026-10-30T16:06:35.000Z',
      billingCycleEnd: '2026-11-30T16:06:35.000Z',
      membershipType: 'enterprise',
      individualUsage: {
        plan: {
          autoPercentUsed: 32.68,
          apiPercentUsed: 100,
        },
        onDemand: {
          enabled: true,
          used: 14247,
          limit: 33300,
        },
      },
    },
    {
      nowMs,
      sandUsage: {
        currentPeriodStart: '2026-11-18T02:44:41.695Z',
        nextResetTimestampUtc: '2026-11-25T02:44:41.695Z',
        usagePercent: 0.56769,
        hasAvailableUsage: true,
        hasNonZeroIncludedLimit: true,
        grokPlanLabel: 'Grok Bot Plan',
        isTeamSeat: true,
      },
    }
  );

  assert.equal(parsed.quotaWindows.length, 3);
  assert.equal(parsed.quotaWindows[0].id, 'cursor-auto');
  assert.equal(parsed.quotaWindows[1].id, 'cursor-api');
  assert.equal(parsed.quotaWindows[2].id, 'cursor-grok-bot');
  assert.equal(parsed.quotaWindows[2].title, 'Grok Bot');
  assert.equal(Math.round(parsed.quotaWindows[2].remainingPct), 99);
  assert.ok(parsed.quotaWindows[2].resetText.includes('天'));
});

test('HTTP server exposes /v1/receipt (json/ascii/svg) and /v1/fingerprint/* CRUD & run endpoints', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'atm-fp-test-'));
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
    const base = `http://127.0.0.1:${addr.port}`;

    meter.store.upsertTurn({
      turnUid: 'cursor:s1:t1',
      tool: 'cursor',
      sessionId: 's1',
      turnId: 't1',
      model: 'claude-sonnet-4-5',
      completedAtMs: Date.now(),
      totalInputTokens: 30_000,
      cacheReadTokens: 25_000,
      outputTokens: 1_500,
      tps: 88,
      tpsMethod: 'e2e_turn',
      replyPreview: '{"q1":"3,1","q2":8,"q3":4,"q4":2,"q5":"R,Q,P,S"}',
    });

    // Receipt JSON + SVG + ASCII
    const recJson = await (await fetch(`${base}/v1/receipt?scope=day&groupBy=model`)).json();
    assert.equal(recJson.totals.turnCount, 1);
    const recSvg = await (await fetch(`${base}/v1/receipt?format=svg&theme=paper&rate=7`)).text();
    assert.ok(recSvg.includes('<svg '));
    const recAscii = await (await fetch(`${base}/v1/receipt?format=ascii&currency=both&rate=7`)).text();
    assert.ok(recAscii.includes('DAILY RECEIPT'));

    // Fingerprint endpoint add -> overview -> delete
    const addRes = await (
      await fetch(`${base}/v1/fingerprint/endpoints`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'My Relay',
          protocol: 'anthropic',
          baseUrl: 'https://relay.test/v1',
          model: 'claude-opus-4-6',
          apiKey: 'sk-ant-secret-987654',
        }),
      })
    ).json();
    assert.equal(addRes.ok, true);
    assert.equal(addRes.endpoint.apiKeyPreview, 'sk-a...7654');

    const overview = await (await fetch(`${base}/v1/fingerprint/overview`)).json();
    assert.equal(overview.endpoints.length, 1);
    assert.ok(overview.manualProbe.prompt.includes('[ATM-PROBE-V1]'));

    // Run passive scan & manual_score (auto-picking latest Cursor replyPreview)
    const passiveRun = await (
      await fetch(`${base}/v1/fingerprint/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'passive', days: 7 }),
      })
    ).json();
    assert.equal(passiveRun.ok, true);
    assert.equal(passiveRun.run.mode, 'passive');

    const manualRun = await (
      await fetch(`${base}/v1/fingerprint/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'manual_score', tool: 'cursor' }),
      })
    ).json();
    assert.equal(manualRun.ok, true);
    assert.equal(manualRun.run.score, 100);
    assert.equal(manualRun.run.verdict, 'healthy');

    // Delete endpoint
    const delRes = await (
      await fetch(`${base}/v1/fingerprint/endpoints?id=${encodeURIComponent(addRes.endpoint.id)}`, {
        method: 'DELETE',
      })
    ).json();
    assert.equal(delRes.ok, true);
    assert.equal(delRes.deleted, true);
    assert.equal(delRes.endpoints.length, 0);
  } finally {
    await meter.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
