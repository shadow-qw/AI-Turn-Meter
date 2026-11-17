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
  normalizeTurn,
} from '../packages/daemon/src/format.mjs';
import { TurnStore } from '../packages/daemon/src/store.mjs';
import { parseCodexSessionContent } from '../packages/daemon/src/adapters/codex.mjs';
import {
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
} from '../packages/daemon/src/cdp-injector.mjs';
import { createMeterServer } from '../packages/daemon/src/server.mjs';
import { APP_SPECS, extractPreservableArgs, resolveAppPaths } from '../packages/daemon/src/apps.mjs';
import {
  buildLaunchAgentPlist,
  cleanCursorHooks,
  patchCursorHooks,
} from '../packages/daemon/src/installer.mjs';

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
  assert.match(src, /RUNTIME_VERSION = 10/);
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
