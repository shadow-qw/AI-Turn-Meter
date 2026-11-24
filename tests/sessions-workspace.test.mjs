import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { loadAntigravitySessionTitles } from '../packages/daemon/src/adapters/antigravity.mjs';
import { createMeterServer } from '../packages/daemon/src/server.mjs';
import { TurnStore } from '../packages/daemon/src/store.mjs';

function makeTmpDir(prefix = 'atm-sessions-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

function createSummariesDb(dbPath, sqlStatements) {
  mkdirSync(join(dbPath, '..'), { recursive: true });
  const db = new DatabaseSync(dbPath);
  for (const sql of sqlStatements) {
    db.exec(sql);
  }
  db.close();
}

test('loadAntigravitySessionTitles reads title/summary/preview defensively across subdirs without throwing on missing columns', () => {
  const root = makeTmpDir('atm-ag-titles-');
  try {
    // 1. Standard Antigravity 2.x schema (title + preview + last_modified_time + workspace_uris)
    createSummariesDb(join(root, 'antigravity', 'conversation_summaries.db'), [
      `CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        preview TEXT NOT NULL DEFAULT '',
        last_modified_time datetime NOT NULL,
        workspace_uris TEXT NOT NULL DEFAULT '',
        parent_conversation_id TEXT NOT NULL DEFAULT ''
      );`,
      `INSERT INTO conversation_summaries VALUES (
        'conv-1',
        '  Fix   Daemon Discovery  ',
        'Fallback Preview',
        '2026-09-24 06:59:56.926+00:00',
        '["file:///Users/dev/Project/%E6%B5%8B%E8%AF%95%E9%A1%B9%E7%9B%AE"]',
        ''
      );`,
      `INSERT INTO conversation_summaries VALUES (
        'conv-2',
        '',
        'Preview Used When Title Empty',
        '0001-01-01 00:00:00+00:00',
        '',
        ''
      );`,
    ]);

    // 2. Alternative schema with summary + updated_at_ms and missing title/workspace_uris/parent_conversation_id
    createSummariesDb(join(root, 'antigravity-cli', 'conversation_summaries.db'), [
      `CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        summary TEXT,
        workspace_path TEXT,
        updated_at_ms INTEGER
      );`,
      `INSERT INTO conversation_summaries VALUES (
        'conv-3',
        'Summary Column Title',
        '/Users/dev/cli-repo',
        1790234000000
      );`,
      // Newer timestamp for conv-2 in cli dir should enrich updatedAtMs while keeping workspacePath/title
      `INSERT INTO conversation_summaries VALUES (
        'conv-2',
        '',
        '/Users/dev/backfilled-ws',
        1790235000
      );`,
    ]);

    // 3. Corrupt/empty DB in antigravity-ide should never throw
    mkdirSync(join(root, 'antigravity-ide'), { recursive: true });
    writeFileSync(join(root, 'antigravity-ide', 'conversation_summaries.db'), 'not-a-sqlite-file');

    const map = loadAntigravitySessionTitles(root);
    assert.equal(map.size, 3);

    const c1 = map.get('conv-1');
    assert.deepEqual(c1, {
      title: 'Fix Daemon Discovery',
      workspacePath: '/Users/dev/Project/测试项目',
      updatedAtMs: Date.parse('2026-09-24T06:59:56.926+00:00'),
    });

    const c2 = map.get('conv-2');
    assert.equal(c2.title, 'Preview Used When Title Empty');
    assert.equal(c2.workspacePath, '/Users/dev/backfilled-ws');
    assert.equal(c2.updatedAtMs, 1790235000 * 1000);

    const c3 = map.get('conv-3');
    assert.deepEqual(c3, {
      title: 'Summary Column Title',
      workspacePath: '/Users/dev/cli-repo',
      updatedAtMs: 1790234000000,
    });

    // Missing table schema also returns empty map without throwing
    const emptyRoot = makeTmpDir('atm-ag-empty-');
    try {
      createSummariesDb(join(emptyRoot, 'antigravity', 'conversation_summaries.db'), [
        `CREATE TABLE other_table (id TEXT PRIMARY KEY);`,
      ]);
      const emptyMap = loadAntigravitySessionTitles(emptyRoot);
      assert.equal(emptyMap.size, 0);
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('TurnStore.getRecentSessions aggregates by (tool, session_id) with exact schema, title fallbacks, modelCount, and isActive', () => {
  const store = new TurnStore(':memory:');
  try {
    const nowMs = Date.UTC(2026, 10, 23, 8, 0, 0);

    // Session 1: antigravity, 2 turns, 2 distinct models + 1 unknown, explicit sessionTitle with fresher updatedAtMs
    store.upsertTurn({
      turnUid: 'ag:s1:t1',
      tool: 'antigravity',
      sessionId: 'ag-session-1',
      turnId: 't1',
      model: 'gemini-2.5-pro',
      workspacePath: '/Users/dev/repo-alpha/',
      completedAtMs: nowMs - 300_000,
      totalInputTokens: 10000,
      uncachedInputTokens: 4000,
      cacheReadTokens: 6000,
      outputTokens: 500,
      thinkingTokens: 300,
      replyPreview: 'First reply preview',
    });
    store.upsertTurn({
      turnUid: 'ag:s1:t2',
      tool: 'antigravity',
      sessionId: 'ag-session-1',
      turnId: 't2',
      model: 'claude-opus-4-6',
      workspacePath: '/Users/dev/repo-alpha',
      completedAtMs: nowMs - 200_000,
      totalInputTokens: 20000,
      uncachedInputTokens: 5000,
      cacheReadTokens: 15000,
      outputTokens: 1000,
      thinkingTokens: 700,
    });
    store.upsertTurn({
      turnUid: 'ag:s1:t3',
      tool: 'antigravity',
      sessionId: 'ag-session-1',
      turnId: 't3',
      model: 'unknown',
      completedAtMs: nowMs - 150_000,
      totalInputTokens: 1000,
      uncachedInputTokens: 1000,
      outputTokens: 100,
    });

    // Session 2: codex, recent (within 90s), no title map -> uses truncated first non-empty reply_preview
    const longPreview =
      'Implemented streaming parser with full cache hit metrics and fallback token accounting across multiple tools';
    store.upsertTurn({
      turnUid: 'codex:s2:t1',
      tool: 'codex',
      sessionId: 'codex-session-2',
      turnId: 't1',
      model: 'gpt-5.4',
      workspacePath: '/Users/dev/repo-beta',
      completedAtMs: nowMs - 30_000,
      totalInputTokens: 5000,
      uncachedInputTokens: 2000,
      cacheReadTokens: 3000,
      outputTokens: 400,
      thinkingTokens: 120,
      replyPreview: longPreview,
    });

    // Session 3: cursor, no title, no reply_preview -> falls back to basename of workspacePath
    store.upsertTurn({
      turnUid: 'cursor:s3:t1',
      tool: 'cursor',
      sessionId: 'cursor-session-3',
      turnId: 't1',
      model: 'claude-sonnet-4-5',
      workspacePath: '/Users/dev/my-web-app',
      completedAtMs: nowMs - 90_001,
      totalInputTokens: 4000,
      uncachedInputTokens: 4000,
      outputTokens: 250,
    });

    // Session 4: codebuddy, no title, no reply_preview, no workspacePath -> falls back to short sessionId
    store.upsertTurn({
      turnUid: 'cb:s4:t1',
      tool: 'codebuddy',
      sessionId: '2ed491b9-101f-42cf-a2a8-9333f0f71039',
      turnId: 't1',
      model: 'unknown',
      completedAtMs: nowMs - 500_000,
      totalInputTokens: 2000,
      uncachedInputTokens: 2000,
      outputTokens: 100,
    });

    const sessionTitles = new Map([
      [
        'ag-session-1',
        {
          title: 'Antigravity Summary Title',
          workspacePath: '/Users/dev/repo-alpha',
          updatedAtMs: nowMs - 20_000, // fresher than completedAtMs -> marks isActive true
        },
      ],
    ]);

    const sessions = store.getRecentSessions({ limit: 10, nowMs, sessionTitles });
    assert.equal(sessions.length, 4);

    // Ordered by MAX(completed_at_ms) DESC: s2 (-30s), s3 (-90.001s), s1 (-150s), s4 (-500s)
    assert.deepEqual(
      sessions.map((s) => s.sessionId),
      ['codex-session-2', 'cursor-session-3', 'ag-session-1', '2ed491b9-101f-42cf-a2a8-9333f0f71039']
    );

    // Exact schema keys check
    const expectedKeys = [
      'estimatedCostUsd',
      'isActive',
      'lastActiveAtMs',
      'model',
      'modelCount',
      'sessionId',
      'thinkingTokens',
      'title',
      'tool',
      'totalTokens',
      'turnCount',
      'workspacePath',
    ];
    for (const s of sessions) {
      assert.deepEqual(Object.keys(s).sort(), expectedKeys);
    }

    // s2: reply_preview fallback truncated cleanly, active within 90s
    const s2 = sessions[0];
    assert.equal(s2.tool, 'codex');
    assert.ok(s2.title.endsWith('…'));
    assert.ok(s2.title.length <= 60);
    assert.equal(s2.model, 'gpt-5.4');
    assert.equal(s2.modelCount, 1);
    assert.equal(s2.totalTokens, 5400);
    assert.equal(s2.thinkingTokens, 120);
    assert.equal(s2.turnCount, 1);
    assert.equal(s2.isActive, true);

    // s3: workspace basename fallback, 90_001ms ago -> isActive false
    const s3 = sessions[1];
    assert.equal(s3.title, 'my-web-app');
    assert.equal(s3.workspacePath, '/Users/dev/my-web-app');
    assert.equal(s3.isActive, false);

    // s1: sessionTitles title wins, 2 distinct non-unknown models, most recent non-unknown model, active via title updatedAtMs
    const s1 = sessions[2];
    assert.equal(s1.title, 'Antigravity Summary Title');
    assert.equal(s1.workspacePath, '/Users/dev/repo-alpha');
    assert.equal(s1.model, 'claude-opus-4-6');
    assert.equal(s1.modelCount, 2);
    assert.equal(s1.totalTokens, 32600);
    assert.equal(s1.thinkingTokens, 1000);
    assert.equal(s1.turnCount, 3);
    assert.equal(s1.lastActiveAtMs, nowMs - 150_000);
    assert.equal(s1.isActive, true);
    assert.equal(typeof s1.estimatedCostUsd, 'number');
    assert.ok(s1.estimatedCostUsd > 0);

    // s4: short sessionId fallback, model null, modelCount 0, unpriced cost null
    const s4 = sessions[3];
    assert.equal(s4.title, '2ed491b9');
    assert.equal(s4.workspacePath, null);
    assert.equal(s4.model, null);
    assert.equal(s4.modelCount, 0);
    assert.equal(s4.estimatedCostUsd, null);
    assert.equal(s4.isActive, false);

    // Tool filter + limit
    const codexOnly = store.getRecentSessions({ tool: 'codex', limit: 5, nowMs });
    assert.equal(codexOnly.length, 1);
    assert.equal(codexOnly[0].sessionId, 'codex-session-2');

    // Antigravity subagent rollup: child sessions with parentSessionId roll up into root conversation
    store.upsertTurn({
      turnUid: 'ag:sub1:t1',
      tool: 'antigravity',
      host: 'antigravity-subagent',
      sessionId: 'ag-sub-1',
      turnId: 't1',
      model: 'gemini-4-neon',
      completedAtMs: nowMs - 10_000,
      totalInputTokens: 50000,
      uncachedInputTokens: 10000,
      cacheReadTokens: 40000,
      outputTokens: 2000,
      thinkingTokens: 500,
    });
    store.upsertTurn({
      turnUid: 'ag:sub2:t1',
      tool: 'antigravity',
      host: 'antigravity-subagent',
      sessionId: 'ag-sub-2',
      turnId: 't1',
      model: 'claude-opus-4-6',
      completedAtMs: nowMs - 5_000,
      totalInputTokens: 30000,
      uncachedInputTokens: 5000,
      cacheReadTokens: 25000,
      outputTokens: 1000,
      thinkingTokens: 250,
    });
    const titlesWithParents = new Map([
      [
        'ag-session-1',
        {
          title: 'Antigravity Summary Title',
          workspacePath: '/Users/dev/repo-alpha',
          updatedAtMs: nowMs - 20_000,
        },
      ],
      ['ag-sub-1', { title: null, workspacePath: null, updatedAtMs: nowMs - 10_000, parentSessionId: 'ag-session-1' }],
      ['ag-sub-2', { title: null, workspacePath: null, updatedAtMs: nowMs - 5_000, parentSessionId: 'ag-session-1' }],
    ]);
    const rolledUp = store.getRecentSessions({
      tool: 'antigravity',
      limit: 5,
      nowMs,
      sessionTitles: titlesWithParents,
    });
    assert.equal(rolledUp.length, 1);
    assert.equal(rolledUp[0].sessionId, 'ag-session-1');
    assert.equal(rolledUp[0].title, 'Antigravity Summary Title');
    assert.equal(rolledUp[0].subagentCount, 2);
    assert.equal(rolledUp[0].modelCount, 3);
    assert.equal(rolledUp[0].totalTokens, 32600 + 52000 + 31000);
    assert.equal(rolledUp[0].thinkingTokens, 1000 + 500 + 250);
    assert.equal(rolledUp[0].turnCount, 5);
    assert.equal(rolledUp[0].lastActiveAtMs, nowMs - 5_000);
  } finally {
    store.close();
  }
});

test('TurnStore.getUsageSummary computes byWorkspace (top 12, sharePct, unbound grouping, sorted tools) and attaches recentSessions to cards', () => {
  const store = new TurnStore(':memory:');
  try {
    const nowMs = Date.UTC(2026, 10, 23, 10, 0, 0);

    // Insert 13 named workspaces + 1 unbound workspace (14 total -> byWorkspace capped at 12)
    store.upsertTurn({
      turnUid: 'ws:main:1',
      tool: 'codex',
      sessionId: 'sess-main-codex',
      turnId: 't1',
      model: 'gpt-5.4',
      workspacePath: '/Users/dev/ai-turn-meter/',
      completedAtMs: nowMs - 10_000,
      totalInputTokens: 40000,
      uncachedInputTokens: 20000,
      cacheReadTokens: 20000,
      outputTokens: 2000,
      thinkingTokens: 800,
      explicitCostUsd: 0.6,
    });
    store.upsertTurn({
      turnUid: 'ws:main:2',
      tool: 'antigravity',
      sessionId: 'sess-main-ag',
      turnId: 't1',
      model: 'gemini-2.5-pro',
      workspacePath: '/Users/dev/ai-turn-meter',
      completedAtMs: nowMs - 20_000,
      totalInputTokens: 20000,
      uncachedInputTokens: 10000,
      cacheReadTokens: 10000,
      outputTokens: 1000,
      thinkingTokens: 450,
      explicitCostUsd: 0.4,
    });

    // Unbound workspace turn
    store.upsertTurn({
      turnUid: 'ws:unbound:1',
      tool: 'cursor',
      sessionId: 'sess-unbound',
      turnId: 't1',
      model: 'claude-sonnet-4-5',
      workspacePath: null,
      completedAtMs: nowMs - 30_000,
      totalInputTokens: 10000,
      uncachedInputTokens: 10000,
      outputTokens: 500,
      thinkingTokens: 100,
      explicitCostUsd: 0.25,
    });

    // 12 smaller named workspaces (so total 14 workspaces)
    for (let i = 1; i <= 12; i += 1) {
      store.upsertTurn({
        turnUid: `ws:extra:${i}`,
        tool: 'codex',
        sessionId: `sess-extra-${i}`,
        turnId: 't1',
        model: 'gpt-5.4',
        workspacePath: `/Users/dev/proj-${String(i).padStart(2, '0')}`,
        completedAtMs: nowMs - (100_000 + i * 1000),
        totalInputTokens: 1000 * i,
        uncachedInputTokens: 1000 * i,
        outputTokens: 100,
        thinkingTokens: 10,
        explicitCostUsd: Number((0.01 * i).toFixed(4)),
      });
    }

    const summary = store.getUsageSummary({ days: 7, nowMs });

    // totals and byTool expose thinkingTokens and outputTokens
    assert.equal(summary.totals.thinkingTokens, 800 + 450 + 100 + 120);
    assert.equal(summary.totals.outputTokens, 2000 + 1000 + 500 + 1200);
    const agTool = summary.byTool.find((t) => t.tool === 'antigravity');
    assert.equal(agTool.thinkingTokens, 450);
    assert.equal(agTool.outputTokens, 1000);

    // byWorkspace capped at 12, exact schema, sorted by cost DESC
    assert.equal(summary.byWorkspace.length, 12);
    const expectedWsKeys = [
      'estimatedCostUsd',
      'outputTokens',
      'sharePct',
      'thinkingTokens',
      'tools',
      'totalTokens',
      'turnCount',
      'workspaceName',
      'workspacePath',
    ];
    for (const row of summary.byWorkspace) {
      assert.deepEqual(Object.keys(row).sort(), expectedWsKeys);
    }

    const topWs = summary.byWorkspace[0];
    assert.equal(topWs.workspacePath, '/Users/dev/ai-turn-meter');
    assert.equal(topWs.workspaceName, 'ai-turn-meter');
    assert.equal(topWs.turnCount, 2);
    assert.equal(topWs.totalTokens, 63000);
    assert.equal(topWs.thinkingTokens, 1250);
    assert.equal(topWs.outputTokens, 3000);
    assert.equal(topWs.estimatedCostUsd, 1.0);
    assert.deepEqual(topWs.tools, ['antigravity', 'codex']);
    // Total cost = 1.0 + 0.25 + (0.01 * 78) = 2.03 -> 1.0 / 2.03 = 49.3%
    assert.equal(topWs.sharePct, 49.3);

    const unboundWs = summary.byWorkspace[1];
    assert.equal(unboundWs.workspacePath, '未关联工作区');
    assert.equal(unboundWs.workspaceName, '未关联工作区');
    assert.deepEqual(unboundWs.tools, ['cursor']);

    // Cards recentSessions attached (up to 5) on all + each built-in tool
    assert.equal(summary.cards.all.recentSessions.length, 5);
    assert.equal(summary.cards.codex.recentSessions.length, 5);
    assert.equal(summary.cards.antigravity.recentSessions.length, 1);
    assert.equal(summary.cards.cursor.recentSessions.length, 1);
    assert.equal(summary.cards.codebuddy.recentSessions.length, 0);

    // Cache hit with updated sessionTitles overlays fresh titles cleanly
    const titles = new Map([['sess-main-ag', { title: 'Live Hydrated Title', workspacePath: null, updatedAtMs: nowMs }]]);
    const summary2 = store.getUsageSummary({ days: 7, nowMs, sessionTitles: titles });
    assert.equal(summary2.cards.antigravity.recentSessions[0].title, 'Live Hydrated Title');
  } finally {
    store.close();
  }
});

test('TurnStore.getUsageSummary byWorkspace falls back to token sharePct when total cost is 0/unpriced', () => {
  const store = new TurnStore(':memory:');
  try {
    const nowMs = Date.UTC(2026, 10, 23, 12, 0, 0);
    store.upsertTurn({
      turnUid: 'u:1',
      tool: 'codebuddy',
      sessionId: 's-1',
      turnId: 't1',
      model: 'unpriced-custom-model',
      workspacePath: '/tmp/ws-big',
      completedAtMs: nowMs - 5000,
      totalInputTokens: 7000,
      outputTokens: 500,
    });
    store.upsertTurn({
      turnUid: 'u:2',
      tool: 'codebuddy',
      sessionId: 's-2',
      turnId: 't1',
      model: 'unpriced-custom-model',
      workspacePath: '/tmp/ws-small',
      completedAtMs: nowMs - 4000,
      totalInputTokens: 2000,
      outputTokens: 500,
    });

    const summary = store.getUsageSummary({ days: 7, nowMs });
    assert.equal(summary.totals.estimatedCostUsd, null);
    assert.equal(summary.byWorkspace.length, 2);
    assert.equal(summary.byWorkspace[0].workspaceName, 'ws-big');
    assert.equal(summary.byWorkspace[0].sharePct, 75.0);
    assert.equal(summary.byWorkspace[1].workspaceName, 'ws-small');
    assert.equal(summary.byWorkspace[1].sharePct, 25.0);
  } finally {
    store.close();
  }
});

test('HTTP GET /v1/sessions and GET /v1/usage hydrate Antigravity titles and enforce local Host/Origin checks', async () => {
  const tmpRoot = makeTmpDir('atm-http-sessions-');
  const geminiRoot = join(tmpRoot, 'gemini');
  const dbPath = join(tmpRoot, 'meter.db');
  const nowMs = Date.now();

  createSummariesDb(join(geminiRoot, 'antigravity', 'conversation_summaries.db'), [
    `CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      last_modified_time datetime NOT NULL,
      workspace_uris TEXT NOT NULL DEFAULT ''
    );`,
    `INSERT INTO conversation_summaries VALUES (
      'ag-http-1',
      'Session Analytics Rollout',
      '${new Date(nowMs - 5000).toISOString()}',
      '["file:///Users/dev/ai-turn-meter"]'
    );`,
  ]);

  const srv = createMeterServer({
    port: 0,
    dbPath,
    stateDir: tmpRoot,
    geminiRoot,
    enableWatchers: false,
    enableCdp: false,
    enableAntigravityRpc: false,
    enableQuotaProbe: false,
    enableExternalProviders: false,
  });

  try {
    const addr = await srv.start();
    const base = `http://127.0.0.1:${addr.port}`;

    srv.store.upsertTurn({
      turnUid: 'ag:http:1',
      tool: 'antigravity',
      sessionId: 'ag-http-1',
      turnId: 't1',
      model: 'claude-opus-4-6',
      workspacePath: '/Users/dev/ai-turn-meter',
      completedAtMs: nowMs - 10_000,
      totalInputTokens: 12000,
      uncachedInputTokens: 2000,
      cacheReadTokens: 10000,
      outputTokens: 600,
      thinkingTokens: 240,
    });
    srv.store.upsertTurn({
      turnUid: 'codex:http:1',
      tool: 'codex',
      sessionId: 'codex-http-1',
      turnId: 't1',
      model: 'gpt-5.4',
      workspacePath: '/Users/dev/other-proj',
      completedAtMs: nowMs - 5000,
      totalInputTokens: 8000,
      uncachedInputTokens: 3000,
      cacheReadTokens: 5000,
      outputTokens: 400,
      replyPreview: 'Codex session preview title',
    });

    // Read-only GET /v1/sessions works without auth token on localhost
    const resAll = await fetch(`${base}/v1/sessions?limit=10`);
    assert.equal(resAll.status, 200);
    const bodyAll = await resAll.json();
    assert.equal(bodyAll.sessions.length, 2);
    assert.equal(bodyAll.sessions[0].sessionId, 'codex-http-1');
    assert.equal(bodyAll.sessions[0].title, 'Codex session preview title');
    assert.equal(bodyAll.sessions[1].sessionId, 'ag-http-1');
    assert.equal(bodyAll.sessions[1].title, 'Session Analytics Rollout');
    assert.equal(bodyAll.sessions[1].thinkingTokens, 240);
    assert.equal(bodyAll.sessions[1].isActive, true);

    // Filter by tool & limit
    const resAg = await fetch(`${base}/v1/sessions?tool=antigravity&limit=5`);
    assert.equal(resAg.status, 200);
    const bodyAg = await resAg.json();
    assert.equal(bodyAg.sessions.length, 1);
    assert.equal(bodyAg.sessions[0].sessionId, 'ag-http-1');

    // Cross-origin request is rejected (403) just like /v1/turns
    const badOrigin = await fetch(`${base}/v1/sessions`, {
      headers: { Origin: 'https://evil.example.com' },
    });
    assert.equal(badOrigin.status, 403);

    // GET /v1/usage includes byWorkspace and hydrated recentSessions on cards
    const usageRes = await fetch(`${base}/v1/usage?days=7`);
    assert.equal(usageRes.status, 200);
    const usage = await usageRes.json();
    assert.equal(usage.byWorkspace.length, 2);
    assert.equal(usage.totals.thinkingTokens, 240);
    assert.equal(usage.cards.antigravity.recentSessions[0].title, 'Session Analytics Rollout');
    assert.equal(usage.cards.all.recentSessions.length, 2);
  } finally {
    await srv.stop();
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});
