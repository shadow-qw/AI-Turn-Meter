import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  formatCacheRate,
  formatInlineSummary,
  formatTokens,
  formatTps,
  normalizePreviewText,
  normalizeTurn,
} from '../packages/daemon/src/format.mjs';
import { TurnStore } from '../packages/daemon/src/store.mjs';
import { isCodexOpenAiModel, parseCodexSessionContent } from '../packages/daemon/src/adapters/codex.mjs';
import {
  AntigravityAdapter,
  buildAntigravitySpeedIndex,
  parseAntigravityTranscriptContent,
} from '../packages/daemon/src/adapters/antigravity.mjs';
import {
  parseCodeBuddyCliContent,
  parseCodeBuddyIdeSessionDir,
  workspaceMd5,
} from '../packages/daemon/src/adapters/codebuddy.mjs';
import { processCursorHookPayload, drainCursorSpool } from '../packages/daemon/src/adapters/cursor.mjs';
import {
  CdpInlineInjector,
  buildInjectedRuntimeSource,
  isEligibleCdpTarget,
} from '../packages/daemon/src/cdp-injector.mjs';
import { createMeterServer } from '../packages/daemon/src/server.mjs';
import {
  APP_SPECS,
  extractPreservableArgs,
  isAppRunning,
  isPortListening,
  resolveAppPaths,
} from '../packages/daemon/src/apps.mjs';
import {
  applyLocalSshConfig,
  buildAppLaunchAgentPlist,
  buildLaunchAgentPlist,
  buildRemoteSshOneLiner,
  cleanCursorHooks,
  patchCursorHooks,
} from '../packages/daemon/src/installer.mjs';
import { estimateTurnCost, resolveModelPricing } from '../packages/daemon/src/pricing.mjs';
import { computeQuotaWindow } from '../packages/daemon/src/quota.mjs';

test('formatting helpers match specification', () => {
  assert.equal(formatTokens(341), '341');
  assert.equal(formatTokens(1400), '1.4k');
  assert.equal(formatTokens(97234), '97.2k');
  assert.equal(formatTokens(1240000), '1.24M');
  assert.equal(formatCacheRate(94000, 97200), '97%');
  assert.equal(formatCacheRate(0, 0), '--');
  assert.equal(formatTps(48.0), '48 tok/s');
  assert.equal(formatTps(null), 'N/A tok/s');

  const norm = normalizeTurn({
    turnUid: 'x:1:1',
    tool: 'codex',
    sessionId: 's1',
    turnId: 't1',
    totalInputTokens: 97200,
    cacheReadTokens: 93312,
    outputTokens: 1400,
    tps: 48,
    tpsMethod: 'active_model',
  });
  assert.equal(formatInlineSummary(norm), '输入 97.2k (96%) · 输出 1.4k · 48 tok/s');
});

test('Codex parser aggregates multi-call turn and subtracts tool wait', () => {
  const jsonl = [
    JSON.stringify({
      timestamp: '2026-11-16T10:00:00.000Z',
      type: 'session_meta',
      payload: { id: 'sess-1', cwd: '/tmp/proj' },
    }),
    JSON.stringify({
      timestamp: '2026-11-16T10:00:00.100Z',
      type: 'turn_context',
      payload: { turn_id: 'turn-1', model: 'gpt-6-codex', cwd: '/tmp/proj' },
    }),
    JSON.stringify({
      timestamp: '2026-11-16T10:00:00.100Z',
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-1' },
    }),
    JSON.stringify({
      timestamp: '2026-11-16T10:00:02.100Z',
      type: 'token_usage_record',
      payload: {
        turn_id: 'turn-1',
        response_id: 'r1',
        usage: { input_tokens: 1000, cached_input_tokens: 500, output_tokens: 100, reasoning_output_tokens: 40 },
        turn_token_usage: { input_tokens: 1000, cached_input_tokens: 500, output_tokens: 100, reasoning_output_tokens: 40 },
      },
    }),
    JSON.stringify({
      timestamp: '2026-11-16T10:00:04.100Z',
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'c1' },
    }),
    JSON.stringify({
      timestamp: '2026-11-16T10:00:06.100Z',
      type: 'token_usage_record',
      payload: {
        turn_id: 'turn-1',
        response_id: 'r2',
        usage: { input_tokens: 2000, cached_input_tokens: 1900, output_tokens: 200, reasoning_output_tokens: 60 },
        turn_token_usage: { input_tokens: 3000, cached_input_tokens: 2400, output_tokens: 300, reasoning_output_tokens: 100 },
      },
    }),
    JSON.stringify({
      timestamp: '2026-11-16T10:00:06.100Z',
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'turn-1', duration_ms: 6000, time_to_first_token_ms: 800 },
    }),
  ].join('\n');

  const turns = parseCodexSessionContent(jsonl, 'rollout.jsonl');
  assert.equal(turns.length, 1);
  const t = turns[0];
  assert.equal(t.totalInputTokens, 3000);
  assert.equal(t.cacheReadTokens, 2400);
  assert.equal(t.uncachedInputTokens, 600);
  assert.equal(t.outputTokens, 300);
  assert.equal(t.thinkingTokens, 100);
  assert.equal(t.callCount, 2);
  assert.equal(t.durationMs, 6000);
  // 2000ms tool wait subtracted -> 4000ms active
  assert.equal(t.modelActiveMs, 4000);
  assert.equal(t.ttftMs, 800);
  assert.equal(t.tpsMethod, 'active_model');
});

test('Codex parser uses Reasoning + AgentMessage intervals instead of visible-only TTFT', () => {
  const jsonl = [
    JSON.stringify({ timestamp: '2026-11-17T06:52:44.493Z', type: 'session_meta', payload: { id: 'sess-r1', cwd: '/tmp/proj' } }),
    JSON.stringify({ timestamp: '2026-11-17T06:52:44.493Z', type: 'turn_context', payload: { turn_id: 'turn-r1', model: 'gpt-5.4' } }),
    JSON.stringify({ timestamp: '2026-11-17T06:52:44.493Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-r1' } }),
    JSON.stringify({
      timestamp: '2026-11-17T06:52:46.545Z',
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        turn_id: 'turn-r1',
        item: { type: 'UserMessage' },
        started_at_ms: 1794898366544,
        completed_at_ms: 1794898366545,
      },
    }),
    JSON.stringify({
      timestamp: '2026-11-17T06:52:56.259Z',
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        turn_id: 'turn-r1',
        item: { type: 'Reasoning' },
        started_at_ms: 1794898370351,
        completed_at_ms: 1794898376259,
      },
    }),
    JSON.stringify({
      timestamp: '2026-11-17T06:52:56.460Z',
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        turn_id: 'turn-r1',
        item: { type: 'AgentMessage' },
        started_at_ms: 1794898376264,
        completed_at_ms: 1794898376460,
      },
    }),
    JSON.stringify({
      timestamp: '2026-11-17T06:52:56.461Z',
      type: 'token_usage_record',
      payload: {
        turn_id: 'turn-r1',
        response_id: 'resp-r1',
        usage: { input_tokens: 27042, cached_input_tokens: 4096, output_tokens: 221, reasoning_output_tokens: 198 },
        turn_token_usage: { input_tokens: 27042, cached_input_tokens: 4096, output_tokens: 221, reasoning_output_tokens: 198 },
      },
    }),
    JSON.stringify({
      timestamp: '2026-11-17T06:52:56.786Z',
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'turn-r1', duration_ms: 12294, time_to_first_token_ms: 11772 },
    }),
  ].join('\n');

  const turns = parseCodexSessionContent(jsonl, 'rollout-r1.jsonl');
  assert.equal(turns.length, 1);
  const t = turns[0];
  // Reasoning (5908ms) + AgentMessage (196ms) = 6104ms -> 221 / 6.104 = 36.2 tok/s
  assert.equal(t.modelActiveMs, 6104);
  assert.equal(t.ttftMs, 3806);
  assert.equal(t.tpsMethod, 'streaming_decode');

  // Fallback without item_completed when reasoning tokens exist must not subtract visible-only TTFT
  const fallbackJsonl = [
    JSON.stringify({ timestamp: '2026-11-17T06:52:44.493Z', type: 'turn_context', payload: { turn_id: 'turn-r2', model: 'gpt-5.4' } }),
    JSON.stringify({
      timestamp: '2026-11-17T06:52:56.461Z',
      type: 'token_usage_record',
      payload: {
        turn_id: 'turn-r2',
        response_id: 'resp-r2',
        usage: { input_tokens: 27042, cached_input_tokens: 4096, output_tokens: 221, reasoning_output_tokens: 198 },
      },
    }),
    JSON.stringify({
      timestamp: '2026-11-17T06:52:56.786Z',
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'turn-r2', duration_ms: 12294, time_to_first_token_ms: 11772 },
    }),
  ].join('\n');
  const fallbackTurns = parseCodexSessionContent(fallbackJsonl, 'rollout-r2.jsonl');
  assert.equal(fallbackTurns.length, 1);
  assert.equal(fallbackTurns[0].modelActiveMs, 12294);
  assert.equal(fallbackTurns[0].tpsMethod, 'e2e_turn');
});

test('Antigravity parser handles USER_INPUT turn grouping + RPC pure streaming TPS', () => {
  const transcript = [
    JSON.stringify({ step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-17T03:00:00Z' }),
    JSON.stringify({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-17T03:00:02Z',
      input_tokens: 1000,
      cache_read_tokens: 9000,
      output_tokens: 200,
      tool_calls: [{ name: 'read_file' }],
    }),
    JSON.stringify({ step_index: 2, type: 'GENERIC', status: 'DONE', created_at: '2026-11-17T03:00:03Z' }),
    JSON.stringify({
      step_index: 3,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-17T03:00:05Z',
      input_tokens: 500,
      cache_read_tokens: 9500,
      output_tokens: 400,
      tool_calls: [],
    }),
    // Open second turn (still waiting for model)
    JSON.stringify({ step_index: 4, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-17T03:01:00Z' }),
  ].join('\n');

  const speedIndex = buildAntigravitySpeedIndex([
    {
      stepIndices: [1],
      chatModel: {
        model: 'gemini-4-hydrogen',
        timeToFirstToken: '0.6s',
        streamingDuration: '1.0s',
        usage: { outputTokens: 200, thinkingOutputTokens: 50 },
      },
    },
    {
      stepIndices: [3],
      chatModel: {
        model: 'gemini-4-hydrogen',
        timeToFirstToken: '0.4s',
        streamingDuration: '2.0s',
        usage: { outputTokens: 400, thinkingOutputTokens: 100 },
      },
    },
  ]);

  const turns = parseAntigravityTranscriptContent(transcript, {
    sessionId: 'conv-ag',
    workspacePath: '/tmp/ws',
    speedIndex,
  });
  assert.equal(turns.length, 1);
  const t = turns[0];
  assert.equal(t.totalInputTokens, 20000);
  assert.equal(t.uncachedInputTokens, 1500);
  assert.equal(t.cacheReadTokens, 18500);
  assert.equal(t.outputTokens, 600);
  assert.equal(t.thinkingTokens, 150);
  assert.equal(t.ttftMs, 600);
  assert.equal(t.tps, 200);
  assert.equal(t.tpsMethod, 'streaming_decode');
});

test('CodeBuddy IDE dir & CLI JSONL parsers extract statsSnapshot and workspace MD5', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cb-ide-'));
  try {
    const ws = '/Users/test/Project/demo';
    const hash = workspaceMd5(ws);
    const sessDir = join(dir, hash, 'sess-1');
    mkdirSync(join(sessDir, 'messages'), { recursive: true });

    writeFileSync(
      join(sessDir, 'index.json'),
      JSON.stringify({
        requests: [
          {
            id: 'req-1',
            state: 'complete',
            startedAt: 1000000,
            messages: ['m1', 'm2'],
            usage: { inputTokens: 25357, outputTokens: 341, cacheTokens: 12288, cachedWriteTokens: 0 },
          },
        ],
      })
    );
    writeFileSync(
      join(sessDir, 'messages', 'm1.json'),
      JSON.stringify({
        role: 'user',
        message: JSON.stringify({
          content: [{ type: 'text', text: `<user_info>\nWorkspace Folder: ${ws}\n</user_info>` }],
        }),
      })
    );
    writeFileSync(
      join(sessDir, 'messages', 'm2.json'),
      JSON.stringify({
        role: 'assistant',
        createdAt: new Date(1005848).toISOString(),
        extra: JSON.stringify({
          modelName: 'Hy4 flash',
          agentMessageCount: 2,
          statsSnapshot: {
            inputTokens: 25357,
            outputTokens: 341,
            cachedInputTokens: 12288,
            cacheWriteTokens: 0,
            thinkingTokens: 241,
            elapsedMs: 3777,
          },
        }),
      })
    );

    const ideTurns = parseCodeBuddyIdeSessionDir(sessDir, hash);
    assert.equal(ideTurns.length, 1);
    assert.equal(ideTurns[0].workspacePath, ws);
    assert.equal(ideTurns[0].workspaceHash, hash);
    assert.equal(ideTurns[0].modelActiveMs, 3777);
    assert.equal(ideTurns[0].tpsMethod, 'active_model');

    const cliJsonl = [
      JSON.stringify({ type: 'message', role: 'user', id: 'u1', timestamp: 1000, cwd: ws }),
      JSON.stringify({
        type: 'function_call',
        id: 'a1',
        timestamp: 2000,
        providerData: {
          messageId: 'm1',
          requestModelName: 'GLM',
          rawUsage: { prompt_tokens: 1000, prompt_cache_hit_tokens: 700, completion_tokens: 100, completion_thinking_tokens: 20 },
        },
      }),
      JSON.stringify({ type: 'function_call_result', id: 'r1', timestamp: 3000 }),
      JSON.stringify({
        type: 'message',
        role: 'assistant',
        id: 'a2',
        timestamp: 5000,
        providerData: {
          messageId: 'm2',
          requestModelName: 'GLM',
          rawUsage: { prompt_tokens: 1200, prompt_cache_hit_tokens: 1000, completion_tokens: 200, completion_thinking_tokens: 50 },
        },
      }),
    ].join('\n');

    const cliTurns = parseCodeBuddyCliContent(cliJsonl, 'cli.jsonl');
    assert.equal(cliTurns.length, 1);
    assert.equal(cliTurns[0].totalInputTokens, 2200);
    assert.equal(cliTurns[0].cacheReadTokens, 1700);
    assert.equal(cliTurns[0].outputTokens, 300);
    assert.equal(cliTurns[0].modelActiveMs, 3000); // 4000ms total - 1000ms tool
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Cursor hook lifecycle deduplicates stop and subtracts Shell/MCP time', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'cursor-hook-'));
  try {
    assert.equal(
      processCursorHookPayload(
        {
          hook_event_name: 'beforeSubmitPrompt',
          conversation_id: 'c1',
          generation_id: 'g1',
          workspace_roots: ['/tmp/repo'],
        },
        { stateDir, nowMs: 10000 }
      ),
      null
    );
    processCursorHookPayload(
      { hook_event_name: 'beforeShellExecution', conversation_id: 'c1', generation_id: 'g1' },
      { stateDir, nowMs: 11000 }
    );
    processCursorHookPayload(
      { hook_event_name: 'afterShellExecution', conversation_id: 'c1', generation_id: 'g1' },
      { stateDir, nowMs: 13000 }
    );

    const turn = processCursorHookPayload(
      {
        hook_event_name: 'afterAgentResponse',
        conversation_id: 'c1',
        generation_id: 'g1',
        model_id: 'gemini-4-carbon',
        input_tokens: 100000,
        cache_read_tokens: 80000,
        cache_write_tokens: 5000,
        output_tokens: 600,
      },
      { stateDir, nowMs: 16000 }
    );
    assert.ok(turn);
    assert.equal(turn.totalInputTokens, 100000);
    assert.equal(turn.uncachedInputTokens, 15000);
    assert.equal(turn.cacheReadTokens, 80000);
    assert.equal(turn.outputTokens, 600);
    assert.equal(turn.durationMs, 6000);
    assert.equal(turn.modelActiveMs, 4000); // 6000 - 2000 shell wait
    assert.equal(turn.tpsMethod, 'e2e_minus_tools');

    // Duplicate stop event for same generation_id must be ignored
    assert.equal(
      processCursorHookPayload(
        {
          hook_event_name: 'stop',
          conversation_id: 'c1',
          generation_id: 'g1',
          input_tokens: 100000,
          output_tokens: 600,
        },
        { stateDir, nowMs: 16050 }
      ),
      null
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('TurnStore & HTTP server separate per-turn from sessionTotal and match workspace', async () => {
  const serverStateDir = mkdtempSync(join(tmpdir(), 'meter-srv-'));
  const meter = createMeterServer({
    port: 0,
    dbPath: ':memory:',
    stateDir: serverStateDir,
    enableWatchers: false,
    enableCdp: false,
  });
  const addr = await meter.start();
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const healthRes = await (await fetch(`${baseUrl}/health`)).json();
    assert.equal(healthRes.ok, true);
    assert.ok(typeof healthRes.version === 'string' && healthRes.version.length > 0);
    assert.ok(typeof healthRes.root === 'string' && healthRes.root.length > 0);

    const r1 = await fetch(`${baseUrl}/v1/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        turnUid: 'cursor:s1:t1',
        tool: 'cursor',
        sessionId: 's1',
        turnId: 't1',
        model: 'grok-4.7',
        workspacePath: '/tmp/ws-a',
        completedAtMs: 1000,
        totalInputTokens: 10000,
        cacheReadTokens: 8000,
        outputTokens: 500,
        durationMs: 5000,
        modelActiveMs: 5000,
      }),
    });
    assert.equal(r1.status, 200);

    const r2 = await fetch(`${baseUrl}/v1/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        turnUid: 'cursor:s1:t2',
        tool: 'cursor',
        sessionId: 's1',
        turnId: 't2',
        model: 'grok-4.7',
        workspacePath: '/tmp/ws-a',
        completedAtMs: 2000,
        totalInputTokens: 20000,
        cacheReadTokens: 19000,
        outputTokens: 1000,
        durationMs: 10000,
        modelActiveMs: 10000,
      }),
    });
    const d2 = await r2.json();
    // Main inlineText is ONLY turn 2 (20k / 1k), NOT cumulative 30k
    assert.equal(d2.record.inlineText, '输入 20k (95%) · 输出 1k · 100 tok/s');
    // sessionTotal keeps the 2-turn cumulative reference
    assert.equal(d2.record.sessionTotal.turnCount, 2);
    assert.equal(d2.record.sessionTotal.totalInputTokens, 30000);
    assert.equal(d2.record.sessionTotal.outputTokens, 1500);

    const matchRes = await fetch(`${baseUrl}/v1/match?tool=cursor&workspace=${encodeURIComponent('/tmp/ws-a')}`);
    const matchJson = await matchRes.json();
    assert.equal(matchJson.turn.turnId, 't2');

    // End-to-end cursor-hook.mjs CLI -> HTTP /v1/ingest test (async so parent HTTP server stays unblocked)
    const hookStateDir = mkdtempSync(join(tmpdir(), 'cursor-cli-'));
    try {
      const hookBin = join(process.cwd(), 'packages', 'daemon', 'bin', 'cursor-hook.mjs');
      const env = {
        ...process.env,
        AI_TURN_METER_PORT: String(addr.port),
        AI_TURN_METER_STATE_DIR: hookStateDir,
      };
      const runHook = (payload, customEnv = env) =>
        new Promise((resolve, reject) => {
          const child = spawn(process.execPath, [hookBin], { env: customEnv, stdio: ['pipe', 'ignore', 'pipe'] });
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
        conversation_id: 'cli-conv',
        generation_id: 'cli-gen',
        workspace_roots: ['/tmp/ws-cli'],
      });
      await runHook({
        hook_event_name: 'stop',
        conversation_id: 'cli-conv',
        generation_id: 'cli-gen',
        model_id: 'grok-4.7',
        workspace_roots: ['/tmp/ws-cli'],
        input_tokens: 12000,
        cache_read_tokens: 10000,
        cache_write_tokens: 0,
        output_tokens: 300,
      });

      const cliMatch = await (
        await fetch(`${baseUrl}/v1/match?tool=cursor&workspace=${encodeURIComponent('/tmp/ws-cli')}`)
      ).json();
      assert.equal(cliMatch.turn.turnId, 'cli-gen');
      assert.equal(cliMatch.turn.totalInputTokens, 12000);
      assert.equal(cliMatch.turn.uncachedInputTokens, 2000);

      // Remote-SSH raw hook endpoint (/v1/ingest/cursor-hook)
      const sshSubmitRes = await fetch(`${baseUrl}/v1/ingest/cursor-hook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hook_event_name: 'beforeSubmitPrompt',
          conversation_id: 'ssh-conv',
          generation_id: 'ssh-gen',
          workspace_roots: ['/data/home/user/proj'],
        }),
      });
      assert.equal(sshSubmitRes.status, 200);
      const sshStopRes = await fetch(`${baseUrl}/v1/ingest/cursor-hook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hook_event_name: 'stop',
          conversation_id: 'ssh-conv',
          generation_id: 'ssh-gen',
          model_id: 'gemini-4-argon',
          workspace_roots: ['/data/home/user/proj'],
          input_tokens: 9000,
          cache_read_tokens: 8000,
          cache_write_tokens: 0,
          output_tokens: 180,
        }),
      });
      assert.equal(sshStopRes.status, 200);
      const sshMatch = await (
        await fetch(`${baseUrl}/v1/match?tool=cursor&workspace=${encodeURIComponent('/data/home/user/proj')}`)
      ).json();
      assert.equal(sshMatch.turn.turnId, 'ssh-gen');
      assert.equal(sshMatch.turn.model, 'gemini-4-argon');
      assert.equal(sshMatch.turn.totalInputTokens, 9000);

      // Spool fallback when daemon port is unreachable
      const offlineEnv = { ...env, AI_TURN_METER_PORT: '1' };
      await runHook(
        {
          hook_event_name: 'stop',
          conversation_id: 'cli-conv',
          generation_id: 'cli-gen-spool',
          model_id: 'grok-4.7',
          workspace_roots: ['/tmp/ws-spool'],
          input_tokens: 5000,
          cache_read_tokens: 4000,
          output_tokens: 100,
        },
        offlineEnv
      );
      const drained = drainCursorSpool(meter.store, hookStateDir);
      assert.equal(drained.length, 1);
      assert.equal(drained[0].turnId, 'cli-gen-spool');

      // Strict per-tool isolation in /v1/match: never leak another tool's record even for the same workspace
      await fetch(`${baseUrl}/v1/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          turnUid: 'codex:s-iso:t-iso',
          tool: 'codex',
          sessionId: 's-iso',
          turnId: 't-iso',
          model: 'gpt-6.1-sol',
          workspacePath: '/tmp/ws-shared',
          completedAtMs: Date.now() + 5000,
          totalInputTokens: 4000,
          cacheReadTokens: 2000,
          outputTokens: 80,
          durationMs: 1000,
          modelActiveMs: 1000,
        }),
      });
      const codebuddyShared = await (
        await fetch(`${baseUrl}/v1/match?tool=codebuddy&workspace=${encodeURIComponent('/tmp/ws-shared')}`)
      ).json();
      assert.equal(codebuddyShared.turn, null);

      const cursorShared = await (
        await fetch(`${baseUrl}/v1/match?tool=cursor&workspace=${encodeURIComponent('/tmp/ws-shared')}`)
      ).json();
      assert.equal(cursorShared.turn.tool, 'cursor');

      // Per-tool and global toggle via /v1/config
      await fetch(`${baseUrl}/v1/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tools: { cursor: false } }),
      });
      const disabledCursor = await (
        await fetch(`${baseUrl}/v1/match?tool=cursor&workspace=${encodeURIComponent('/tmp/ws-shared')}`)
      ).json();
      assert.equal(disabledCursor.disabled, true);
      assert.equal(disabledCursor.turn, null);

      await fetch(`${baseUrl}/v1/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      });
      const disabledAll = await (
        await fetch(`${baseUrl}/v1/match?tool=codex&workspace=${encodeURIComponent('/tmp/ws-shared')}`)
      ).json();
      assert.equal(disabledAll.disabled, true);

      await fetch(`${baseUrl}/v1/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true, tools: { cursor: true } }),
      });
      const restoredCursor = await (
        await fetch(`${baseUrl}/v1/match?tool=cursor&workspace=${encodeURIComponent('/tmp/ws-shared')}`)
      ).json();
      assert.equal(restoredCursor.disabled, undefined);
      assert.equal(restoredCursor.turn.tool, 'cursor');
    } finally {
      rmSync(hookStateDir, { recursive: true, force: true });
    }
  } finally {
    await meter.stop();
    rmSync(serverStateDir, { recursive: true, force: true });
  }
});

test('CdpInlineInjector resolves static ports and DevToolsActivePort files cleanly', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cdp-port-'));
  try {
    const portFile = join(tmp, 'DevToolsActivePort');
    writeFileSync(portFile, '55551\n/devtools/browser/abc\n');
    const injector = new CdpInlineInjector({
      specs: [
        { tool: 'antigravity', portFile },
        { tool: 'codex', port: 47921 },
        { tool: 'cursor', portFile: join(tmp, 'missing') },
      ],
      getTurnForTool: () => null,
    });
    assert.equal(injector.resolvePort(injector.specs[0]), 55551);
    assert.equal(injector.resolvePort(injector.specs[1]), 47921);
    assert.equal(injector.resolvePort(injector.specs[2]), null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('Injected popover script compiles and supports multi-turn non-clobbering pills', () => {
  const src = buildInjectedRuntimeSource();
  new Function(src);
  assert.match(src, /RUNTIME_VERSION = 12/);
  assert.match(src, /agent-transcript-turn-actions/);
  assert.match(src, /__aiTurnMeterUpdateTurns/);
  assert.match(src, /data-align/);
  assert.match(src, /atm-grid/);
  assert.match(src, /缓存率/);
  assert.doesNotMatch(src, /含思考/);
  assert.doesNotMatch(src, /TTFT /);

  const tmpCursorDir = mkdtempSync(join(tmpdir(), 'cursor-prev-'));
  try {
    processCursorHookPayload(
      { hook_event_name: 'beforeSubmitPrompt', conversation_id: 'c-prev', generation_id: 'g-prev' },
      { stateDir: tmpCursorDir, nowMs: 1000 }
    );
    const mid = processCursorHookPayload(
      { hook_event_name: 'afterAgentResponse', conversation_id: 'c-prev', generation_id: 'g-prev', text: '收到「1」。' },
      { stateDir: tmpCursorDir, nowMs: 2500 }
    );
    assert.equal(mid, null);
    const done = processCursorHookPayload(
      {
        hook_event_name: 'stop',
        conversation_id: 'c-prev',
        generation_id: 'g-prev',
        model_id: 'grok-4.7',
        input_tokens: 23500,
        cache_read_tokens: 6100,
        output_tokens: 413,
      },
      { stateDir: tmpCursorDir, nowMs: 3000 }
    );
    assert.equal(done.replyPreview, '收到「1」。');
  } finally {
    rmSync(tmpCursorDir, { recursive: true, force: true });
  }

  const codexPreviewTurns = parseCodexSessionContent(
    [
      JSON.stringify({ timestamp: '2026-11-17T06:52:44.493Z', type: 'turn_context', payload: { turn_id: 't-prev', model: 'gpt-6' } }),
      JSON.stringify({ timestamp: '2026-11-17T06:52:45.000Z', type: 'token_usage_record', payload: { turn_id: 't-prev', response_id: 'rp', usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 10 } } }),
      JSON.stringify({ timestamp: '2026-11-17T06:52:46.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 't-prev', duration_ms: 1000, last_agent_message: '第一轮回复正文' } }),
    ].join('\n'),
    'rollout-prev.jsonl'
  );
  assert.equal(codexPreviewTurns[0].replyPreview, '第一轮回复正文');
});

test('Installer patches & cleans Cursor hooks with numeric version and resolves user Applications bundles', () => {
  const tmpHome = mkdtempSync(join(tmpdir(), 'atm-home-'));
  try {
    // 1. Multi-path app resolution checks ~/Applications even when /Applications misses it
    const fakeCursorCli = join(tmpHome, 'Applications', 'Cursor.app', 'Contents', 'Resources', 'app', 'bin', 'cursor');
    mkdirSync(join(fakeCursorCli, '..'), { recursive: true });
    writeFileSync(fakeCursorCli, '#!/bin/sh\n');
    const resolved = resolveAppPaths(APP_SPECS.cursor, {
      homeDir: tmpHome,
      searchDirs: [join(tmpHome, 'Applications')],
      allowMdfind: false,
    });
    assert.equal(resolved.installed, true);
    assert.equal(resolved.cliPath, fakeCursorCli);

    // 2. Patch existing hooks.json lacking numeric version while keeping unrelated hooks
    const hooksPath = join(tmpHome, '.cursor', 'hooks.json');
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });
    writeFileSync(hooksPath, JSON.stringify({ hooks: { stop: [{ command: '/usr/local/bin/other-hook' }] } }));

    patchCursorHooks({ homeDir: tmpHome, hookCmd: '/opt/homebrew/bin/node /opt/homebrew/opt/ai-turn-meter/libexec/packages/daemon/bin/cursor-hook.mjs', log: () => {} });
    const patched = JSON.parse(readFileSync(hooksPath, 'utf8'));
    assert.equal(patched.version, 1);
    assert.equal(patched.hooks.stop.length, 2);
    assert.equal(patched.hooks.stop[0].command, '/usr/local/bin/other-hook');

    // 3. Clean removes only our cursor-hook.mjs entries
    cleanCursorHooks({ homeDir: tmpHome, log: () => {} });
    const cleaned = JSON.parse(readFileSync(hooksPath, 'utf8'));
    assert.equal(cleaned.hooks.stop.length, 1);
    assert.equal(cleaned.hooks.stop[0].command, '/usr/local/bin/other-hook');

    // 4. LaunchAgent plist includes explicit PATH alongside node binary
    const plist = buildLaunchAgentPlist({ nodeBin: '/opt/homebrew/opt/node/bin/node', root: '/opt/homebrew/opt/ai-turn-meter/libexec', homeDir: tmpHome });
    assert.match(plist, /\/opt\/homebrew\/opt\/node\/bin\/node/);
    assert.match(plist, /<key>PATH<\/key>/);
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('extractPreservableArgs preserves existing wrapper flags and drops old debugging switches', () => {
  const cursorExe = '/Applications/Cursor.app/Contents/MacOS/Cursor';
  assert.deepEqual(
    extractPreservableArgs(
      `${cursorExe} --mute-audio --disable-audio-output --remote-debugging-port=47922 -psn_0_1234`,
      cursorExe
    ),
    ['--mute-audio', '--disable-audio-output']
  );

  assert.deepEqual(
    extractPreservableArgs(
      '/Applications/CodeBuddy CN.app/Contents/MacOS/Electron --remote-debugging-port 47923 --disable-gpu --disable-gpu',
      '/Applications/CodeBuddy CN.app/Contents/MacOS/Electron'
    ),
    ['--disable-gpu']
  );

  // Must not match Helper binaries
  assert.deepEqual(
    extractPreservableArgs(
      '/Applications/Cursor.app/Contents/Frameworks/Cursor Helper.app/Contents/MacOS/Cursor Helper --type=renderer',
      cursorExe
    ),
    []
  );
});

test('Injected runtime mounts right-aligned pills onto Cursor virtualized turn-actions rows', () => {
  class MiniEl {
    constructor(tag, { className = '', attrs = {}, rect = {}, style = {}, text = '' } = {}) {
      this.tagName = tag.toUpperCase();
      this.nodeType = 1;
      this.className = className;
      this.attrs = { ...attrs };
      this.dataset = {};
      this.style = { ...style };
      this._rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, ...rect };
      this._style = { display: 'block', flexDirection: 'row', justifyContent: 'normal', visibility: 'visible', opacity: '1', overflowY: 'visible', ...style };
      this.children = [];
      this.childNodes = [];
      this.parentElement = null;
      this._text = text;
      if (text) this.childNodes.push({ nodeType: 3, nodeValue: text });
      const self = this;
      this.classList = {
        contains: (c) => self.className.split(/\s+/).includes(c),
        add: (c) => {
          if (!self.classList.contains(c)) self.className = `${self.className} ${c}`.trim();
        },
      };
    }
    set textContent(v) {
      this._text = String(v);
      this.children = [];
      this.childNodes = v ? [{ nodeType: 3, nodeValue: String(v) }] : [];
    }
    get firstChild() { return this.childNodes[0] || null; }
    get lastElementChild() { return this.children[this.children.length - 1] || null; }
    get previousElementSibling() {
      if (!this.parentElement) return null;
      const idx = this.parentElement.children.indexOf(this);
      return idx > 0 ? this.parentElement.children[idx - 1] : null;
    }
    appendChild(ch) {
      ch.parentElement = this;
      this.children.push(ch);
      this.childNodes.push(ch);
      return ch;
    }
    insertBefore(ch, ref) {
      ch.parentElement = this;
      const idx = ref ? this.children.indexOf(ref) : -1;
      if (idx === -1) return this.appendChild(ch);
      this.children.splice(idx, 0, ch);
      this.childNodes.splice(idx, 0, ch);
      return ch;
    }
    removeChild(ch) {
      this.children = this.children.filter((c) => c !== ch);
      this.childNodes = this.childNodes.filter((c) => c !== ch);
      ch.parentElement = null;
    }
    remove() {
      if (this.parentElement) this.parentElement.removeChild(this);
    }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    addEventListener() {}
    getBoundingClientRect() { return this._rect; }
    contains(other) {
      if (other === this) return true;
      return this.children.some((c) => c.contains(other));
    }
    closest(sel) {
      let cur = this;
      while (cur) {
        if (MiniEl.matches(cur, sel)) return cur;
        cur = cur.parentElement;
      }
      return null;
    }
    querySelectorAll(sel) {
      const out = [];
      const walk = (n) => {
        for (const c of n.children) {
          if (MiniEl.matches(c, sel)) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    static matches(el, selList) {
      return selList.split(',').some((raw) => {
        const s = raw.replace(':scope >', '').trim();
        if (!s) return false;
        if (s.startsWith('.')) return el.classList.contains(s.slice(1));
        if (s.startsWith('#')) return el.attrs.id === s.slice(1) || el.id === s.slice(1);
        if (s.startsWith('[')) {
          const m = s.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
          if (!m) return false;
          const val = el.getAttribute(m[1]);
          return m[2] !== undefined ? val === m[2] : val !== null;
        }
        return el.tagName === s.toUpperCase();
      });
    }
  }

  const body = new MiniEl('body');
  const head = new MiniEl('head');
  const scroller = new MiniEl('div', {
    className: 'virtualized-composer-messages-scroll-container',
    rect: { left: 1205, top: 57, right: 1921, bottom: 925, width: 716, height: 868 },
    style: { overflowY: 'auto' },
  });
  scroller.scrollHeight = 2400;
  scroller.clientHeight = 868;
  const plane = new MiniEl('div', { className: 'composer-react-virtual-plane', rect: { left: 1205, top: 57, right: 1921, bottom: 925, width: 716, height: 868 } });
  scroller.appendChild(plane);
  body.appendChild(scroller);

  function addTurn(yMsg, replyText, yAct, timeText, pending = false) {
    const uRow = new MiniEl('div', { className: 'composer-react-virtual-plane-row virtualized-composer-messages-row', attrs: { 'data-human-row': 'true' }, text: '1' });
    plane.appendChild(uRow);
    const mRow = new MiniEl('div', { className: 'composer-react-virtual-plane-row virtualized-composer-messages-row', text: replyText, rect: { left: 1221, top: yMsg, right: 1905, bottom: yMsg + 40, width: 684, height: 40 } });
    plane.appendChild(mRow);
    const aRow = new MiniEl('div', { className: 'composer-react-virtual-plane-row virtualized-composer-messages-row', rect: { left: 1221, top: yAct, right: 1905, bottom: yAct + 30, width: 684, height: 30 } });
    const rowInner = new MiniEl('div', { className: 'agent-transcript-row agent-transcript-row-turn-actions', attrs: pending ? { 'data-pending': 'true' } : {}, rect: { left: 1221, top: yAct, right: 1905, bottom: yAct + 30, width: 684, height: 30 } });
    const bar = new MiniEl('div', { className: 'agent-transcript-turn-actions', rect: { left: 1232, top: yAct, right: 1894, bottom: yAct + 24, width: 662, height: 24 }, style: { display: 'flex', justifyContent: 'normal' } });
    const trailing = new MiniEl('div', { className: 'agent-transcript-turn-actions-trailing', rect: { left: 1232, top: yAct, right: 1330, bottom: yAct + 24, width: 98, height: 24 }, style: { display: 'flex' } });
    for (const label of ['Copy message', 'Fork chat']) {
      const btn = new MiniEl('button', { rect: { left: 1236, top: yAct + 2, right: 1254, bottom: yAct + 20, width: 18, height: 18 }, attrs: { 'aria-label': label } });
      btn.appendChild(new MiniEl('svg', { className: 'ui-icon cursor-icon' }));
      trailing.appendChild(btn);
    }
    trailing.appendChild(new MiniEl('span', { text: timeText }));
    bar.appendChild(trailing);
    rowInner.appendChild(bar);
    aRow.appendChild(rowInner);
    plane.appendChild(aRow);
    return bar;
  }

  const bar1 = addTurn(200, '我是 **Grok 4.7**，第一轮回答。', 250, '5m ago');
  const bar2 = addTurn(400, '第二轮已通过 **Remote-SSH** 验证完成。', 450, '1m ago');
  const barPending = addTurn(600, 'Planning...', 650, 'now', true);

  const composer = new MiniEl('div', {
    className: 'aislash-editor-input',
    attrs: { contenteditable: 'true', role: 'textbox', 'aria-label': 'Prompt' },
    rect: { left: 1232, top: 961, right: 1894, bottom: 983, width: 662, height: 22 },
  });
  body.appendChild(composer);

  const doc = {
    title: 'workspace [SSH: example-host]',
    head,
    body,
    addEventListener: () => {},
    removeEventListener: () => {},
    getElementById: (id) => [...head.children, ...body.children].find((e) => e.id === id || e.attrs.id === id) || null,
    createElement: (tag) => new MiniEl(tag),
    querySelector: (sel) => body.querySelector(sel),
    querySelectorAll: (sel) => body.querySelectorAll(sel),
  };
  const win = {
    location: { pathname: '/' },
    innerWidth: 1920,
    innerHeight: 1080,
    document: doc,
    addEventListener: () => {},
    removeEventListener: () => {},
    getComputedStyle: (el) => el._style,
  };
  win.window = win;
  class FakeMutationObserver {
    observe() {}
    disconnect() {}
  }
  const fn = new Function(
    'window',
    'document',
    'MutationObserver',
    'setTimeout',
    'clearTimeout',
    buildInjectedRuntimeSource()
  );
  fn(win, doc, FakeMutationObserver, () => 0, () => {});

  const turns = [
    {
      turnUid: 'cursor:ssh-1:t1',
      tool: 'cursor',
      sessionId: 'ssh-1',
      workspacePath: '/data/workspace',
      completedAtMs: 1000,
      totalInputTokens: 16800,
      cacheReadTokens: 6144,
      outputTokens: 479,
      cacheRatePct: 36.6,
      tps: 59.6,
      replyPreview: '我是 Grok 4.7，第一轮回答。',
    },
    {
      turnUid: 'cursor:ssh-1:t2',
      tool: 'cursor',
      sessionId: 'ssh-1',
      workspacePath: '/data/workspace',
      completedAtMs: 2000,
      totalInputTokens: 24000,
      cacheReadTokens: 12000,
      outputTokens: 610,
      cacheRatePct: 50,
      tps: 64.2,
      replyPreview: '第二轮已通过 **Remote-SSH** 验证完成。',
    },
    {
      turnUid: 'cursor:other:t9',
      tool: 'cursor',
      sessionId: 'other',
      workspacePath: '/Users/dev/other',
      completedAtMs: 3000,
      totalInputTokens: 99999,
      outputTokens: 999,
      tps: 99,
      replyPreview: '其他窗口会话内容',
    },
  ];
  win.__aiTurnMeterUpdateTurns(turns, 'cursor');

  assert.equal(bar1.lastElementChild.classList.contains('ai-turn-meter-inline-pill'), true);
  assert.equal(bar1.lastElementChild.getAttribute('data-align'), 'right');
  assert.equal(bar1.lastElementChild.dataset.atmTurnUid, 'cursor:ssh-1:t1');

  assert.equal(bar2.lastElementChild.classList.contains('ai-turn-meter-inline-pill'), true);
  assert.equal(bar2.lastElementChild.getAttribute('data-align'), 'right');
  assert.equal(bar2.lastElementChild.dataset.atmTurnUid, 'cursor:ssh-1:t2');

  assert.equal(barPending.querySelector('.ai-turn-meter-inline-pill'), null);
});

test('Antigravity & CodeBuddy CLI extract replyPreview with Markdown link normalization and TurnStore skips no-op writes', async () => {
  assert.equal(
    normalizePreviewText('已修改 [server.mjs](file:///Users/demo/packages/daemon/src/server.mjs#L10-L20) 与 ![diagram](https://example.com/a.png)'),
    '已修改 server.mjs 与 diagram'
  );

  const agTranscript = [
    JSON.stringify({ step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-17T04:00:00Z' }),
    JSON.stringify({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-17T04:00:02Z',
      content: '中间说明文本',
      input_tokens: 1000,
      cache_read_tokens: 8000,
      output_tokens: 100,
      tool_calls: [{ name: 'read_file' }],
    }),
    JSON.stringify({
      step_index: 2,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-17T04:00:04Z',
      content: '最终答复：请查看 [README.md](file:///Users/demo/README.md) 中的说明。',
      input_tokens: 500,
      cache_read_tokens: 9000,
      output_tokens: 200,
      tool_calls: [],
    }),
  ].join('\n');

  const agTurns = parseAntigravityTranscriptContent(agTranscript, {
    sessionId: 'conv-prev',
    workspacePath: '/tmp/ag',
  });
  assert.equal(agTurns.length, 1);
  assert.equal(agTurns[0].replyPreview, '最终答复：请查看 [README.md](file:///Users/demo/README.md) 中的说明。');

  const store = new TurnStore(':memory:');
  try {
    const first = store.upsertTurn(agTurns[0]);
    assert.equal(first.changed, true);
    assert.equal(first.record.replyPreview, '最终答复：请查看 README.md 中的说明。');

    const second = store.upsertTurn(agTurns[0]);
    assert.equal(second.changed, false);

    const updated = store.upsertTurn({ ...agTurns[0], model: 'gemini-4-hydrogen' });
    assert.equal(updated.changed, true);
    assert.equal(updated.record.model, 'gemini-4-hydrogen');
  } finally {
    store.close();
  }

  const cliWithReply = [
    JSON.stringify({ type: 'message', role: 'user', id: 'u1', timestamp: 1000, cwd: '/tmp/cb' }),
    JSON.stringify({
      type: 'message',
      role: 'assistant',
      id: 'a1',
      timestamp: 2000,
      content: [{ type: 'text', text: 'CodeBuddy CLI 答复正文' }],
      providerData: {
        messageId: 'm1',
        requestModelName: 'GLM',
        rawUsage: { prompt_tokens: 500, prompt_cache_hit_tokens: 200, completion_tokens: 50 },
      },
    }),
  ].join('\n');
  const cbCliTurns = parseCodeBuddyCliContent(cliWithReply, 'cli-prev.jsonl');
  assert.equal(cbCliTurns.length, 1);
  assert.equal(cbCliTurns[0].replyPreview, 'CodeBuddy CLI 答复正文');

  // AntigravityAdapter.scan returns immediately on unchanged files without touching RPC
  const tmpGem = mkdtempSync(join(tmpdir(), 'ag-idle-'));
  const memStore = new TurnStore(':memory:');
  try {
    const sessBrain = join(tmpGem, 'antigravity', 'brain', 'sess-idle', '.system_generated', 'logs');
    mkdirSync(sessBrain, { recursive: true });
    writeFileSync(join(sessBrain, 'transcript.jsonl'), agTranscript);
    const adapter = new AntigravityAdapter({ store: memStore, geminiRoot: tmpGem, enableRpc: false });
    let rpcChecks = 0;
    adapter.getServers = async () => {
      rpcChecks += 1;
      return null;
    };
    const firstScan = await adapter.scan();
    assert.equal(firstScan.length, 1);
    assert.equal(rpcChecks, 1);
    const secondScan = await adapter.scan();
    assert.equal(secondScan.length, 0);
    assert.equal(rpcChecks, 1);
  } finally {
    memStore.close();
    rmSync(tmpGem, { recursive: true, force: true });
  }
});

test('Cursor hook closes unclosed tool timer on stop and keeps latest replyPreview', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'cursor-stop-'));
  try {
    processCursorHookPayload(
      { hook_event_name: 'beforeSubmitPrompt', conversation_id: 'c2', generation_id: 'g2' },
      { stateDir, nowMs: 1000 }
    );
    processCursorHookPayload(
      { hook_event_name: 'beforeShellExecution', conversation_id: 'c2', generation_id: 'g2' },
      { stateDir, nowMs: 2000 }
    );
    processCursorHookPayload(
      { hook_event_name: 'afterAgentResponse', conversation_id: 'c2', generation_id: 'g2', text: '第一段过渡回复' },
      { stateDir, nowMs: 3000 }
    );
    const done = processCursorHookPayload(
      {
        hook_event_name: 'stop',
        conversation_id: 'c2',
        generation_id: 'g2',
        last_assistant_message: '最后完整回复',
        input_tokens: 1000,
        output_tokens: 200,
      },
      { stateDir, nowMs: 5000 }
    );
    assert.ok(done);
    assert.equal(done.replyPreview, '最后完整回复');
    assert.equal(done.durationMs, 4000);
    // Unclosed tool window [2000..5000] = 3000ms subtracted -> 1000ms active
    assert.equal(done.modelActiveMs, 1000);
    assert.equal(done.tpsMethod, 'e2e_minus_tools');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('Injected runtime matches Markdown-cleaned replyPreview and bounds Pass 3 within anchored segments', () => {
  class MiniEl {
    constructor(tag, { className = '', attrs = {}, rect = {}, style = {}, text = '' } = {}) {
      this.tagName = tag.toUpperCase();
      this.nodeType = 1;
      this.className = className;
      this.attrs = { ...attrs };
      this.dataset = {};
      this.style = { ...style };
      this._rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, ...rect };
      this._style = { display: 'flex', flexDirection: 'row', justifyContent: 'flex-end', visibility: 'visible', opacity: '1', overflowY: 'visible', ...style };
      this.children = [];
      this.childNodes = [];
      this.parentElement = null;
      if (text) this.childNodes.push({ nodeType: 3, nodeValue: text });
      const self = this;
      this.classList = {
        contains: (c) => self.className.split(/\s+/).includes(c),
      };
    }
    set textContent(v) {
      this.children = [];
      this.childNodes = v ? [{ nodeType: 3, nodeValue: String(v) }] : [];
    }
    get firstChild() { return this.childNodes[0] || null; }
    get firstElementChild() { return this.children[0] || null; }
    get lastElementChild() { return this.children[this.children.length - 1] || null; }
    appendChild(ch) {
      ch.parentElement = this;
      this.children.push(ch);
      this.childNodes.push(ch);
      return ch;
    }
    insertBefore(ch, ref) {
      ch.parentElement = this;
      const idx = ref ? this.children.indexOf(ref) : -1;
      if (idx === -1) return this.appendChild(ch);
      this.children.splice(idx, 0, ch);
      this.childNodes.splice(idx, 0, ch);
      return ch;
    }
    removeChild(ch) {
      this.children = this.children.filter((c) => c !== ch);
      this.childNodes = this.childNodes.filter((c) => c !== ch);
      ch.parentElement = null;
    }
    remove() {
      if (this.parentElement) this.parentElement.removeChild(this);
    }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    addEventListener() {}
    getBoundingClientRect() { return this._rect; }
    contains(other) {
      if (other === this) return true;
      return this.children.some((c) => c.contains(other));
    }
    closest(sel) {
      let cur = this;
      while (cur) {
        if (MiniEl.matches(cur, sel)) return cur;
        cur = cur.parentElement;
      }
      return null;
    }
    querySelectorAll(sel) {
      const out = [];
      const walk = (n) => {
        for (const c of n.children) {
          if (MiniEl.matches(c, sel)) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    static matches(el, selList) {
      return selList.split(',').some((raw) => {
        const s = raw.replace(':scope >', '').trim();
        if (!s) return false;
        if (s.startsWith('.')) return el.classList.contains(s.slice(1));
        if (s.startsWith('#')) return el.attrs.id === s.slice(1) || el.id === s.slice(1);
        if (s.startsWith('[')) {
          const m = s.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
          if (!m) return false;
          const val = el.getAttribute(m[1]);
          return m[2] !== undefined ? val === m[2] : val !== null;
        }
        return el.tagName === s.toUpperCase();
      });
    }
  }

  const body = new MiniEl('body');
  const head = new MiniEl('head');
  const list = new MiniEl('div', {
    rect: { left: 100, top: 60, right: 800, bottom: 760, width: 700, height: 700 },
    style: { overflowY: 'auto' },
  });
  list.scrollHeight = 1400;
  list.clientHeight = 700;
  body.appendChild(list);

  function addReply(y, replyText) {
    const card = new MiniEl('div', { rect: { left: 120, top: y, right: 780, bottom: y + 90, width: 660, height: 90 }, style: { display: 'block' } });
    card.appendChild(new MiniEl('div', { text: replyText, style: { display: 'block' } }));
    const bar = new MiniEl('div', { rect: { left: 120, top: y + 60, right: 780, bottom: y + 84, width: 660, height: 24 }, style: { display: 'flex', justifyContent: 'flex-end' } });
    for (const lbl of ['Copy', 'Good', 'Bad']) {
      const btn = new MiniEl('button', { rect: { left: 700, top: y + 62, right: 720, bottom: y + 82, width: 20, height: 20 }, attrs: { 'aria-label': lbl } });
      btn.appendChild(new MiniEl('svg'));
      bar.appendChild(btn);
    }
    card.appendChild(bar);
    list.appendChild(card);
    return bar;
  }

  // Top unmatched reply (turn 2), middle anchored reply (turn 3 with Markdown link in DB), bottom unmatched reply (no turn 4 yet)
  const barTop = addReply(100, '这是第二轮摘要文本');
  const barAnchored = addReply(250, '请查看 README.md 并验证结果');
  const barBottom = addReply(400, '尚未入库的第四轮流式内容');

  body.appendChild(
    new MiniEl('div', {
      attrs: { contenteditable: 'true' },
      rect: { left: 120, top: 820, right: 780, bottom: 880, width: 660, height: 60 },
    })
  );

  const doc = {
    title: 'Antigravity',
    head,
    body,
    addEventListener: () => {},
    removeEventListener: () => {},
    getElementById: (id) => [...head.children, ...body.children].find((e) => e.id === id || e.attrs.id === id) || null,
    createElement: (tag) => new MiniEl(tag),
    querySelector: (sel) => body.querySelector(sel),
    querySelectorAll: (sel) => body.querySelectorAll(sel),
  };
  const win = {
    location: { pathname: '/' },
    innerWidth: 1280,
    innerHeight: 960,
    document: doc,
    addEventListener: () => {},
    removeEventListener: () => {},
    getComputedStyle: (el) => el._style,
  };
  win.window = win;
  class FakeMutationObserver { observe() {} disconnect() {} }
  new Function('window', 'document', 'MutationObserver', 'setTimeout', 'clearTimeout', buildInjectedRuntimeSource())(
    win,
    doc,
    FakeMutationObserver,
    () => 0,
    () => {}
  );

  win.__aiTurnMeterUpdateTurns(
    [
      {
        turnUid: 'antigravity:s-ag:t1',
        tool: 'antigravity',
        sessionId: 's-ag',
        completedAtMs: 1000,
        totalInputTokens: 1000,
        cacheReadTokens: 800,
        outputTokens: 50,
        tps: 100,
        replyPreview: '第一轮已滚动出屏幕',
      },
      {
        turnUid: 'antigravity:s-ag:t2',
        tool: 'antigravity',
        sessionId: 's-ag',
        completedAtMs: 2000,
        totalInputTokens: 2000,
        cacheReadTokens: 1600,
        outputTokens: 100,
        tps: 120,
        replyPreview: '不同文本触发 Pass 3 区间对齐',
      },
      {
        turnUid: 'antigravity:s-ag:t3',
        tool: 'antigravity',
        sessionId: 's-ag',
        completedAtMs: 3000,
        totalInputTokens: 3000,
        cacheReadTokens: 2500,
        outputTokens: 150,
        tps: 140,
        replyPreview: '请查看 [README.md](file:///Users/demo/README.md) 并验证结果',
      },
    ],
    'antigravity'
  );

  assert.equal(barAnchored.querySelector('.ai-turn-meter-inline-pill')?.dataset?.atmTurnUid, 'antigravity:s-ag:t3');
  assert.equal(barTop.querySelector('.ai-turn-meter-inline-pill')?.dataset?.atmTurnUid, 'antigravity:s-ag:t2');
  // Bottom bar must NOT wrongly steal t1/t2 from above the t3 anchor
  assert.equal(barBottom.querySelector('.ai-turn-meter-inline-pill'), null);
});

test('isEligibleCdpTarget, cleanTextWithoutPill style stripping, and batched apps helpers', () => {
  const ws = 'ws://127.0.0.1:47921/devtools/page/1';
  assert.equal(isEligibleCdpTarget({ type: 'page', webSocketDebuggerUrl: ws, url: 'https://127.0.0.1:53082/c/abc' }), true);
  assert.equal(isEligibleCdpTarget({ type: 'page', webSocketDebuggerUrl: ws, url: 'app://-/index.html' }), true);
  assert.equal(isEligibleCdpTarget({ type: 'page', webSocketDebuggerUrl: ws, url: 'data:text/html,hi' }), false);
  assert.equal(isEligibleCdpTarget({ type: 'page', webSocketDebuggerUrl: ws, url: 'about:blank' }), false);
  assert.equal(isEligibleCdpTarget({ type: 'webview', webSocketDebuggerUrl: ws, url: 'codex-sandbox://viz' }), false);
  assert.equal(isEligibleCdpTarget({ type: 'webview', webSocketDebuggerUrl: ws, url: 'https://chatgpt.com/api/auth/session' }), false);
  assert.equal(
    isEligibleCdpTarget({ type: 'page', webSocketDebuggerUrl: ws, url: 'app://-/index.html?initialRoute=%2Favatar-overlay' }),
    false
  );

  // Batch helpers use pre-fetched port Set and ps line arrays
  const portSet = new Set([47831, 47921]);
  assert.equal(isPortListening(47831, portSet), true);
  assert.equal(isPortListening(47922, portSet), false);
  assert.equal(
    isAppRunning(
      { installed: true, exePath: '/Applications/Cursor.app/Contents/MacOS/Cursor' },
      ['/Applications/Cursor.app/Contents/MacOS/Cursor --remote-debugging-port=47922']
    ),
    true
  );
  assert.equal(
    isAppRunning(
      { installed: true, exePath: '/Applications/Cursor.app/Contents/MacOS/Cursor' },
      ['/Applications/ChatGPT.app/Contents/MacOS/ChatGPT']
    ),
    false
  );

  // cleanTextWithoutPill skips <style>, <script>, <svg>
  class NodeEl {
    constructor(tag, { attrs = {}, rect = {}, style = {}, text = '' } = {}) {
      this.tagName = tag.toUpperCase();
      this.nodeType = 1;
      this.className = '';
      this.attrs = { ...attrs };
      this.dataset = {};
      this.style = { ...style };
      this._rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, ...rect };
      this._style = { display: 'flex', flexDirection: 'row', justifyContent: 'flex-end', visibility: 'visible', opacity: '1', overflowY: 'visible', ...style };
      this.children = [];
      this.childNodes = [];
      this.parentElement = null;
      if (text) this.childNodes.push({ nodeType: 3, nodeValue: text });
      const self = this;
      this.classList = { contains: (c) => self.className.split(/\s+/).includes(c) };
    }
    set textContent(v) {
      this.children = [];
      this.childNodes = v ? [{ nodeType: 3, nodeValue: String(v) }] : [];
    }
    get firstChild() { return this.childNodes[0] || null; }
    get firstElementChild() { return this.children[0] || null; }
    get lastElementChild() { return this.children[this.children.length - 1] || null; }
    appendChild(ch) { ch.parentElement = this; this.children.push(ch); this.childNodes.push(ch); return ch; }
    insertBefore(ch, ref) {
      ch.parentElement = this;
      const idx = ref ? this.children.indexOf(ref) : -1;
      if (idx === -1) return this.appendChild(ch);
      this.children.splice(idx, 0, ch);
      this.childNodes.splice(idx, 0, ch);
      return ch;
    }
    removeChild(ch) { this.children = this.children.filter((c) => c !== ch); this.childNodes = this.childNodes.filter((c) => c !== ch); ch.parentElement = null; }
    remove() { if (this.parentElement) this.parentElement.removeChild(this); }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    addEventListener() {}
    getBoundingClientRect() { return this._rect; }
    contains(other) { return other === this || this.children.some((c) => c.contains(other)); }
    closest(sel) {
      let cur = this;
      while (cur) {
        if (NodeEl.matches(cur, sel)) return cur;
        cur = cur.parentElement;
      }
      return null;
    }
    querySelectorAll(sel) {
      const out = [];
      const walk = (n) => {
        for (const c of n.children) {
          if (NodeEl.matches(c, sel)) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    static matches(el, selList) {
      return selList.split(',').some((raw) => {
        const s = raw.replace(':scope >', '').trim();
        if (!s) return false;
        if (s.startsWith('.')) return el.classList.contains(s.slice(1));
        if (s.startsWith('#')) return el.attrs.id === s.slice(1) || el.id === s.slice(1);
        if (s.startsWith('[')) {
          const m = s.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
          if (!m) return false;
          const val = el.getAttribute(m[1]);
          return m[2] !== undefined ? val === m[2] : val !== null;
        }
        return el.tagName === s.toUpperCase();
      });
    }
  }

  const body = new NodeEl('body');
  const head = new NodeEl('head');
  const list = new NodeEl('div', { rect: { left: 100, top: 60, right: 800, bottom: 760, width: 700, height: 700 }, style: { overflowY: 'auto' } });
  list.scrollHeight = 1000;
  list.clientHeight = 700;
  body.appendChild(list);
  const card = new NodeEl('div', { rect: { left: 120, top: 100, right: 780, bottom: 190, width: 660, height: 90 }, style: { display: 'block' } });
  card.appendChild(new NodeEl('style', { text: '/* Copied tooltip CSS */ .copied { color: red; }' }));
  card.appendChild(new NodeEl('div', { text: '干净的正文回复', style: { display: 'block' } }));
  const bar = new NodeEl('div', { rect: { left: 120, top: 160, right: 780, bottom: 184, width: 660, height: 24 }, style: { display: 'flex', justifyContent: 'flex-end' } });
  for (const lbl of ['Copy', 'Good', 'Bad']) {
    const btn = new NodeEl('button', { rect: { left: 700, top: 162, right: 720, bottom: 182, width: 20, height: 20 }, attrs: { 'aria-label': lbl } });
    btn.appendChild(new NodeEl('svg'));
    bar.appendChild(btn);
  }
  card.appendChild(bar);
  list.appendChild(card);
  body.appendChild(new NodeEl('div', { attrs: { contenteditable: 'true' }, rect: { left: 120, top: 820, right: 780, bottom: 880, width: 660, height: 60 } }));

  const doc = {
    title: 'Antigravity',
    head,
    body,
    addEventListener: () => {},
    removeEventListener: () => {},
    getElementById: (id) => [...head.children, ...body.children].find((e) => e.id === id || e.attrs.id === id) || null,
    createElement: (tag) => new NodeEl(tag),
    querySelector: (sel) => body.querySelector(sel),
    querySelectorAll: (sel) => body.querySelectorAll(sel),
  };
  const win = {
    location: { pathname: '/' },
    innerWidth: 1280,
    innerHeight: 960,
    document: doc,
    addEventListener: () => {},
    removeEventListener: () => {},
    getComputedStyle: (el) => el._style,
  };
  win.window = win;
  class FakeMutationObserver { observe() {} disconnect() {} }
  new Function('window', 'document', 'MutationObserver', 'setTimeout', 'clearTimeout', buildInjectedRuntimeSource())(
    win,
    doc,
    FakeMutationObserver,
    () => 0,
    () => {}
  );
  win.__aiTurnMeterUpdateTurns(
    [
      {
        turnUid: 'antigravity:s-clean:t1',
        tool: 'antigravity',
        sessionId: 's-clean',
        completedAtMs: 1000,
        totalInputTokens: 500,
        cacheReadTokens: 300,
        outputTokens: 50,
        tps: 90,
        replyPreview: '干净的正文回复',
      },
    ],
    'antigravity'
  );
  assert.equal(bar.dataset.atmMsgSig.includes('Copied'), false);
  assert.equal(bar.dataset.atmMsgSig.includes('干净的正文回复'), true);
});

test('Pricing engine computes standard, long-context, cache savings, custom override, and skips unknown models', () => {
  // gpt-6.1-sol: $2/M in, $0.1/M cacheRead, $10/M out (threshold 272k)
  const stdCost = estimateTurnCost({
    model: 'gpt-6.1-sol',
    callCount: 1,
    totalInputTokens: 100_000,
    uncachedInputTokens: 20_000,
    cacheReadTokens: 80_000,
    cacheWriteTokens: 0,
    outputTokens: 5_000,
  });
  assert.equal(stdCost.priced, true);
  // 0.02 * 2 + 0.08 * 0.1 + 0.005 * 10 = 0.04 + 0.008 + 0.05 = 0.098
  assert.ok(Math.abs(stdCost.costUsd - 0.098) < 1e-6);
  // savings: 0.08 * (2 - 0.1) = 0.152
  assert.ok(Math.abs(stdCost.savingsUsd - 0.152) < 1e-6);

  // Single-call context > 272k triggers 2x input/cache and 1.5x output
  const longCost = estimateTurnCost({
    model: 'gpt-6.1-sol',
    callCount: 1,
    totalInputTokens: 300_000,
    uncachedInputTokens: 100_000,
    cacheReadTokens: 200_000,
    cacheWriteTokens: 0,
    outputTokens: 10_000,
  });
  // 0.1 * 4 + 0.2 * 0.2 + 0.01 * 15 = 0.4 + 0.04 + 0.15 = 0.59
  assert.ok(Math.abs(longCost.costUsd - 0.59) < 1e-6);

  // Route prefixes, minor revisions & date snapshots resolve cleanly
  assert.ok(resolveModelPricing('workbuddy/kimi-k3.1-pro'));
  assert.ok(resolveModelPricing('claude-opus-4-5-20251101'));
  const astra62 = resolveModelPricing('gpt-6.2-astra');
  assert.equal(astra62.input, 8.0);
  assert.equal(astra62.output, 40.0);

  // Unknown models stay unpriced
  const unknownCost = estimateTurnCost({
    model: 'unknown',
    totalInputTokens: 1000,
    uncachedInputTokens: 1000,
    cacheReadTokens: 0,
    outputTokens: 100,
  });
  assert.equal(unknownCost.priced, false);
  assert.equal(unknownCost.costUsd, null);

  // Custom pricing override
  const customCost = estimateTurnCost(
    {
      model: 'my-internal-model',
      totalInputTokens: 1_000_000,
      uncachedInputTokens: 500_000,
      cacheReadTokens: 500_000,
      outputTokens: 100_000,
    },
    { 'my-internal-model': { input: 4.0, cacheRead: 1.0, output: 10.0 } }
  );
  assert.equal(customCost.priced, true);
  // 0.5 * 4 + 0.5 * 1 + 0.1 * 10 = 3.5
  assert.ok(Math.abs(customCost.costUsd - 3.5) < 1e-6);
});

test('TurnStore.getUsageSummary & /v1/usage aggregate today, 7d, byTool, byModel, and daily series', async () => {
  const meter = createMeterServer({
    port: 0,
    dbPath: ':memory:',
    enableWatchers: false,
    enableCdp: false,
  });
  const addr = await meter.start();
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  try {
    const now = Date.now();
    const twoDaysAgo = now - 2 * 86_400_000;
    const tenDaysAgo = now - 10 * 86_400_000;

    meter.store.upsertTurn({
      turnUid: 'antigravity:u1:t1',
      tool: 'antigravity',
      sessionId: 'u1',
      turnId: 't1',
      model: 'gemini-4-hydrogen',
      completedAtMs: now - 1000,
      totalInputTokens: 100_000,
      cacheReadTokens: 90_000,
      outputTokens: 2_000,
      tps: 200,
    });
    meter.store.upsertTurn({
      turnUid: 'codex:u2:t2',
      tool: 'codex',
      sessionId: 'u2',
      turnId: 't2',
      model: 'gpt-6.1-sol',
      completedAtMs: twoDaysAgo,
      totalInputTokens: 50_000,
      cacheReadTokens: 40_000,
      outputTokens: 1_000,
      tps: 50,
    });
    meter.store.upsertTurn({
      turnUid: 'cursor:u3:t3',
      tool: 'cursor',
      sessionId: 'u3',
      turnId: 't3',
      model: 'grok-4.7',
      completedAtMs: tenDaysAgo,
      totalInputTokens: 20_000,
      cacheReadTokens: 10_000,
      outputTokens: 500,
      tps: 40,
    });

    const res7 = await (await fetch(`${baseUrl}/v1/usage?days=7`)).json();
    assert.equal(res7.totals.turnCount, 2);
    assert.equal(res7.today.turnCount, 1);
    assert.equal(res7.byTool.length, 2);
    assert.equal(res7.byModel.length, 2);
    assert.equal(res7.daily.length, 7);
    assert.ok(res7.totals.estimatedCostUsd > 0);
    assert.ok(res7.totals.cacheSavingsUsd > 0);

    assert.ok(res7.cards);
    assert.equal(res7.cards.all.today.turnCount, 1);
    assert.equal(res7.cards.all.currentWindow.turnCount, 2);
    assert.equal(res7.cards.all.days30.turnCount, 3);
    assert.equal(res7.cards.all.daily30.length, 30);
    assert.equal(res7.cards.all.recentWindows.length, 4);
    assert.equal(res7.cards.all.recentWindows[0].turnCount, 2);
    assert.equal(res7.cards.all.recentWindows[1].turnCount, 1);
    assert.equal(res7.cards.all.topModel, 'gemini-4-hydrogen');

    assert.equal(res7.cards.codex.today.turnCount, 0);
    assert.equal(res7.cards.codex.today.costUsd, 0);
    assert.equal(res7.cards.codex.currentWindow.turnCount, 1);
    assert.equal(res7.cards.codex.topModel, 'gpt-6.1-sol');

    assert.equal(res7.cards.antigravity.today.turnCount, 1);
    assert.equal(res7.cards.antigravity.days30.turnCount, 1);
    assert.equal(res7.cards.cursor.recentWindows[1].turnCount, 1);
    assert.equal(res7.cards.codebuddy.days30.turnCount, 0);

    const resAll = await (await fetch(`${baseUrl}/v1/usage?days=all`)).json();
    assert.equal(resAll.totals.turnCount, 3);
    assert.ok(Array.isArray(resAll.byProject) && resAll.byProject.length >= 1);

    const cfgInlineOff = await (
      await fetch(`${baseUrl}/v1/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inlineTools: { antigravity: false } }),
      })
    ).json();
    assert.equal(cfgInlineOff.config.inlineTools.antigravity, false);
    const matchOff = await (await fetch(`${baseUrl}/v1/match?tool=antigravity`)).json();
    assert.equal(matchOff.disabled, true);
    assert.equal(matchOff.turn, null);

    await fetch(`${baseUrl}/v1/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inlineTools: { antigravity: true } }),
    });
    const matchOn = await (await fetch(`${baseUrl}/v1/match?tool=antigravity`)).json();
    assert.ok(matchOn.turn);

    const stateRes = await (await fetch(`${baseUrl}/v1/state`)).json();
    assert.equal(stateRes.todaySummary.turnCount, 1);
  } finally {
    await meter.stop();
  }
});

test('computeQuotaWindow calculates pace/reserve and getUsageSummary binds quota metadata & latestTurnSubline', () => {
  const nowMs = Date.UTC(2026, 10, 18, 12, 0, 0);
  // 5h window: 3h left (2h elapsed = 40% elapsed => expected remaining 60%), 90% remaining => 30% reserve
  const qReserve = computeQuotaWindow({
    id: 'session',
    title: '会话',
    remainingPct: 90,
    windowSeconds: 18000,
    resetAtMs: nowMs + 3 * 3600 * 1000,
    nowMs,
  });
  assert.equal(qReserve.remainingPct, 90);
  assert.equal(qReserve.pacePct, 60);
  assert.equal(qReserve.resetText, '3 小时后重置');
  assert.match(qReserve.subtitle, /余量 30% · 持续到重置 · \d+\.\d 倍余量/);

  // 5h window: 3h left (60% expected remaining), 30% remaining => deficit & predicted exhaustion
  const qDeficit = computeQuotaWindow({
    id: 'session-low',
    title: '会话',
    usedPct: 70,
    windowSeconds: 18000,
    resetAtMs: nowMs + 3 * 3600 * 1000,
    nowMs,
  });
  assert.equal(qDeficit.remainingPct, 30);
  assert.equal(qDeficit.pacePct, 60);
  assert.match(qDeficit.subtitle, /已多用 30% · 预计 .*后耗尽/);

  const store = new TurnStore(':memory:');
  try {
    store.upsertTurn({
      turnUid: 'codex:q1:t1',
      tool: 'codex',
      sessionId: 'q1',
      turnId: 't1',
      model: 'gpt-6-astra',
      completedAtMs: nowMs - 1000,
      totalInputTokens: 100_000,
      cacheReadTokens: 90_000,
      outputTokens: 1_500,
      tps: 180,
    });
    store.upsertTurn({
      turnUid: 'cursor:q2:t1',
      tool: 'cursor',
      sessionId: 'q2',
      turnId: 't1',
      model: 'gpt-6-astra',
      completedAtMs: nowMs - 2000,
      totalInputTokens: 20_000,
      cacheReadTokens: 0,
      outputTokens: 300,
      tps: 42.5,
    });
    const summary = store.getUsageSummary({
      days: 7,
      nowMs,
      quotasByTool: {
        all: {
          accountEmail: '1 个已登录账号',
          planTitle: '多客户端额度总览',
          quotaWindows: [qReserve],
          resetCreditsText: '3 次可用',
        },
        codex: {
          accountEmail: 'user@example.com',
          planTitle: 'Plus',
          quotaWindows: [qReserve],
          resetCreditsText: '3 次可用',
        },
      },
    });
    assert.equal(summary.cards.codex.accountEmail, 'user@example.com');
    assert.equal(summary.cards.codex.planTitle, 'Plus');
    assert.equal(summary.cards.codex.quotaWindows.length, 1);
    assert.equal(summary.cards.codex.resetCreditsText, '3 次可用');
    assert.equal(summary.cards.codex.latestTpsText, '180 tok/s');
    assert.equal(summary.cards.codex.latestCacheText, '缓存 90%');
    assert.equal(summary.cards.codex.latestTurnSubline, '最近速率 180 tok/s · 缓存 90%');
    assert.equal(summary.cards.cursor.latestTpsText, '42.5 tok/s');
    assert.equal(summary.cards.cursor.latestCacheText, null);
    assert.equal(summary.cards.cursor.latestTurnSubline, '最近速率 42.5 tok/s');
    assert.equal(summary.cards.all.accountEmail, '1 个已登录账号');
    assert.equal(summary.cards.cursor.quotaWindows.length, 0);
  } finally {
    store.close();
  }
});

test('applyLocalSshConfig is idempotent for existing and new Host blocks and builds background app plist', () => {
  const tmpHome = mkdtempSync(join(tmpdir(), 'atm-ssh-'));
  try {
    const sshDir = join(tmpHome, '.ssh');
    mkdirSync(sshDir, { recursive: true });
    const cfgPath = join(sshDir, 'config');
    writeFileSync(
      cfgPath,
      ['Host dev-a', '  HostName 10.0.0.2', '  User ubuntu', '', 'Host dev-b', '  HostName 10.0.0.3', ''].join('\n')
    );

    const r1 = applyLocalSshConfig('dev-a', { port: 47831, homeDir: tmpHome });
    assert.equal(r1.changed, true);
    assert.equal(r1.status, 'updated_host_block');
    const content1 = readFileSync(cfgPath, 'utf8');
    assert.match(content1, /Host dev-a\n  RemoteForward 47831 127\.0\.0\.1:47831\n  ExitOnForwardFailure no\n  HostName 10\.0\.0\.2/);

    // Second apply must be idempotent
    const r2 = applyLocalSshConfig('dev-a', { port: 47831, homeDir: tmpHome });
    assert.equal(r2.changed, false);
    assert.equal(r2.status, 'already_configured');

    // New host appends cleanly
    const r3 = applyLocalSshConfig('dev-c', { port: 47831, homeDir: tmpHome });
    assert.equal(r3.changed, true);
    assert.equal(r3.status, 'appended_host_block');
    const content3 = readFileSync(cfgPath, 'utf8');
    assert.match(content3, /Host dev-c\n  RemoteForward 47831 127\.0\.0\.1:47831\n  ExitOnForwardFailure no/);

    const oneLiner = buildRemoteSshOneLiner('dev-a', { port: 47831 });
    assert.match(oneLiner, /^ssh dev-a '/);
    assert.match(oneLiner, /python3 -'/);

    const appPlist = buildAppLaunchAgentPlist({ appExe: '/Applications/AI Turn Meter.app/Contents/MacOS/AITurnMeter' });
    assert.match(appPlist, /<string>--background<\/string>/);
    assert.match(appPlist, /com\.local\.ai-turn-meter\.app/);
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('Codex adapter filters third-party proxy models, recovers superseded turns, skips fork baseline, and purges legacy DB rows', async () => {
  assert.equal(isCodexOpenAiModel('gpt-6-astra'), true);
  assert.equal(isCodexOpenAiModel('gpt-6.2-astra'), true);
  assert.equal(isCodexOpenAiModel('codex-auto-review'), true);
  assert.equal(isCodexOpenAiModel('workbuddy/claude-opus-5.5'), false);
  assert.equal(isCodexOpenAiModel('workbuddy/kimi-k3.1-pro'), false);

  const mixedJsonl = [
    JSON.stringify({ timestamp: '2026-11-12T06:59:05.000Z', type: 'session_meta', payload: { id: 'sess-mix', cwd: '/tmp/proj' } }),
    JSON.stringify({ timestamp: '2026-11-12T06:59:06.000Z', type: 'turn_context', payload: { turn_id: 't-opus', model: 'workbuddy/claude-opus-5.5' } }),
    JSON.stringify({
      timestamp: '2026-11-12T06:59:10.000Z',
      type: 'token_usage_record',
      payload: { turn_id: 't-opus', response_id: 'r-op', usage: { input_tokens: 50000, cached_input_tokens: 0, output_tokens: 500 } },
    }),
    JSON.stringify({ timestamp: '2026-11-12T06:59:11.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 't-opus', duration_ms: 4000 } }),
    // Second turn interrupted (no task_complete) when third turn starts -> must be recovered!
    JSON.stringify({ timestamp: '2026-11-12T07:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 't-astra-interrupted' } }),
    JSON.stringify({ timestamp: '2026-11-12T07:00:01.000Z', type: 'turn_context', payload: { turn_id: 't-astra-interrupted', model: 'gpt-6-astra' } }),
    JSON.stringify({
      timestamp: '2026-11-12T07:01:00.000Z',
      type: 'token_usage_record',
      payload: {
        turn_id: 't-astra-interrupted',
        response_id: 'r-as1',
        usage: { input_tokens: 100000, cached_input_tokens: 80000, output_tokens: 800 },
        turn_token_usage: { input_tokens: 100000, cached_input_tokens: 80000, output_tokens: 800 },
      },
    }),
    // thread_settings_applied UI change must not overwrite active turn_context model
    JSON.stringify({ timestamp: '2026-11-12T07:01:30.000Z', type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model: 'workbuddy/kimi-k3.1-pro' } } }),
    JSON.stringify({ timestamp: '2026-11-12T07:02:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 't-kimi' } }),
    JSON.stringify({ timestamp: '2026-11-12T07:02:01.000Z', type: 'turn_context', payload: { turn_id: 't-kimi', model: 'workbuddy/kimi-k3.1-pro' } }),
  ].join('\n');

  const turns = parseCodexSessionContent(mixedJsonl, 'rollout-mix.jsonl');
  assert.equal(turns.length, 1);
  assert.equal(turns[0].turnId, 't-astra-interrupted');
  assert.equal(turns[0].model, 'gpt-6-astra');
  assert.equal(turns[0].totalInputTokens, 100000);

  // Forked rollout with only inherited baseline token_count and no new API call emits 0 turns
  const forkedBaselineJsonl = [
    JSON.stringify({ timestamp: '2026-11-12T09:08:32.000Z', type: 'session_meta', payload: { id: 'sess-fork', history_base: 10 } }),
    JSON.stringify({ timestamp: '2026-11-12T09:08:33.000Z', type: 'turn_context', payload: { turn_id: 't-fork', model: 'gpt-6-astra' } }),
    JSON.stringify({
      timestamp: '2026-11-12T09:09:40.000Z',
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 295974, output_tokens: 10439 }, last_token_usage: { input_tokens: 65433, output_tokens: 3000 } } },
    }),
    JSON.stringify({
      timestamp: '2026-11-12T09:09:50.000Z',
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 295974, output_tokens: 10439 }, last_token_usage: { input_tokens: 65433, output_tokens: 3000 } } },
    }),
  ].join('\n');
  assert.equal(parseCodexSessionContent(forkedBaselineJsonl, 'rollout_fork.jsonl', { flushOpenTurns: true }).length, 0);

  // Disabled provider excluded from Overview (cards.all + todaySummary) & topModel ranked by token volume
  const meter = createMeterServer({
    port: 0,
    dbPath: ':memory:',
    enableWatchers: false,
    enableCdp: false,
    enableQuotaProbe: false,
  });
  const addr = await meter.start();
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  try {
    const now = Date.now();
    meter.store.upsertTurn({
      turnUid: 'codex:s1:t1',
      tool: 'codex',
      sessionId: 's1',
      turnId: 't1',
      model: 'gpt-6-astra',
      completedAtMs: now - 1000,
      totalInputTokens: 500_000,
      cacheReadTokens: 450_000,
      outputTokens: 5_000,
    });
    meter.store.upsertTurn({
      turnUid: 'codex:s1:t2',
      tool: 'codex',
      sessionId: 's1',
      turnId: 't2',
      model: 'gpt-6.1-sol',
      completedAtMs: now - 500,
      totalInputTokens: 2_000_000,
      cacheReadTokens: 1_900_000,
      outputTokens: 10_000,
    });
    meter.store.upsertTurn({
      turnUid: 'codebuddy:s2:t1',
      tool: 'codebuddy',
      sessionId: 's2',
      turnId: 't1',
      model: 'Claude-Opus-5.5',
      completedAtMs: now - 200,
      totalInputTokens: 3_000_000,
      cacheReadTokens: 2_000_000,
      outputTokens: 20_000,
    });

    await fetch(`${baseUrl}/v1/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tools: { codebuddy: false } }),
    });

    const usageAll = await (await fetch(`${baseUrl}/v1/usage?days=7`)).json();
    assert.equal(usageAll.cards.all.today.turnCount, 2);
    assert.equal(usageAll.cards.all.topModel, 'gpt-6.1-sol'); // Highest token volume among enabled tools
    assert.equal(usageAll.cards.codex.topModel, 'gpt-6.1-sol');
    assert.equal(usageAll.cards.codebuddy.today.turnCount, 1);
  } finally {
    await meter.stop();
  }

  // Reopening an existing SQLite DB with legacy proxy rows under tool='codex' purges non-OpenAI models
  const dbDir = mkdtempSync(join(tmpdir(), 'atm-purge-'));
  try {
    const dbPath = join(dbDir, 'meter.db');
    const s1 = new TurnStore(dbPath);
    s1.upsertTurn({
      turnUid: 'codex:legacy:opus',
      tool: 'codex',
      sessionId: 'legacy',
      turnId: 'opus',
      model: 'workbuddy/claude-opus-5.5',
      completedAtMs: Date.now() - 1000,
      totalInputTokens: 100_000,
      outputTokens: 1_000,
    });
    s1.upsertTurn({
      turnUid: 'codex:legacy:gpt6',
      tool: 'codex',
      sessionId: 'legacy',
      turnId: 'gpt6',
      model: 'gpt-6-astra',
      completedAtMs: Date.now() - 500,
      totalInputTokens: 100_000,
      outputTokens: 1_000,
    });
    s1.close();

    const s2 = new TurnStore(dbPath);
    const codexTurns = s2.getRecentTurns(20, 'codex');
    assert.equal(codexTurns.length, 1);
    assert.equal(codexTurns[0].model, 'gpt-6-astra');
    s2.close();
  } finally {
    rmSync(dbDir, { recursive: true, force: true });
  }
});
