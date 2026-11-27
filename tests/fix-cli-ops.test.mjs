import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import Module from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  APP_LAUNCH_AGENT_LABEL,
  buildLaunchAgentPlist,
  installAll,
  installVsix,
  LAUNCH_AGENT_LABEL,
  needsExperimentalSqliteFlag,
  runDoctor,
} from '../packages/daemon/src/installer.mjs';
import {
  buildCleanLaunchEnv,
  formatDoctorReport,
  formatFingerprintOutput,
  openSingleApp,
  parseAppAutostartAction,
} from '../packages/daemon/bin/cli.mjs';
import {
  assertMinimumSystemVersionCompatible,
  assertVersionParity as assertDmgVersionParity,
  parseMachOMinOs,
  resolveMinimumSystemVersion,
  shouldCopyBundlePath,
  sortSemverDesc,
} from '../scripts/build-dmg.mjs';
import { decompressZstdSync } from '../packages/daemon/src/zstd.mjs';
import { assertVersionParity as assertReleaseVersionParity } from '../scripts/build-release.mjs';

const REPO_ROOT = process.cwd();
const CLI_BIN = join(REPO_ROOT, 'packages', 'daemon', 'bin', 'cli.mjs');
const DAEMON_BIN = join(REPO_ROOT, 'packages', 'daemon', 'bin', 'daemon.mjs');
const CURSOR_HOOK_BIN = join(REPO_ROOT, 'packages', 'daemon', 'bin', 'cursor-hook.mjs');

function listenServer(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve(server.address().port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function runSubprocessAsync(cmd, args, { env = process.env, stdinText = null, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      reject(new Error(`Subprocess timed out after ${timeoutMs}ms: ${cmd} ${args.join(' ')}`));
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
    if (stdinText !== null) {
      child.stdin.end(stdinText);
    } else {
      child.stdin.end();
    }
  });
}

test('installVsix survives failing and timed-out IDE CLIs and installAll still links CLI', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'atm-vsix-resilience-'));
  const fakeRoot = join(tmpDir, 'root');
  const fakeHome = join(tmpDir, 'home');
  const slowCli = join(tmpDir, 'slow-cursor-cli.sh');
  const failCli = join(tmpDir, 'fail-codebuddy-cli.sh');

  try {
    mkdirSync(join(fakeRoot, 'dist'), { recursive: true });
    mkdirSync(join(fakeRoot, 'packages', 'daemon', 'bin'), { recursive: true });
    mkdirSync(fakeHome, { recursive: true });
    writeFileSync(join(fakeRoot, 'dist', 'ai-turn-meter.vsix'), 'fake-vsix-zip');
    writeFileSync(join(fakeRoot, 'packages', 'daemon', 'bin', 'cli.mjs'), '#!/usr/bin/env node\n');

    writeFileSync(slowCli, '#!/bin/sh\nsleep 3\n');
    writeFileSync(failCli, '#!/bin/sh\necho "broken cli" >&2\nexit 1\n');
    chmodSync(slowCli, 0o755);
    chmodSync(failCli, 0o755);

    const resolveAppPathsFn = (spec) => {
      if (spec.key === 'cursor') {
        return { ...spec, installed: true, appPath: '/Applications/Cursor.app', cliPath: slowCli };
      }
      if (spec.key === 'codebuddy') {
        return { ...spec, installed: true, appPath: '/Applications/CodeBuddy CN.app', cliPath: failCli };
      }
      return { ...spec, installed: false, appPath: null, cliPath: null };
    };

    const logs = [];
    const results = installVsix({
      root: fakeRoot,
      homeDir: fakeHome,
      timeoutMs: 180,
      log: (m) => logs.push(m),
      resolveAppPathsFn,
    });

    assert.equal(results.length, 2);
    assert.equal(results[0].key, 'cursor');
    assert.equal(results[0].status, 'failed');
    assert.match(results[0].error, /timeout/i);
    assert.equal(results[1].key, 'codebuddy');
    assert.equal(results[1].status, 'failed');
    assert.ok(logs.some((l) => l.includes('[WARN]') && l.includes('Cursor')));
    assert.ok(logs.some((l) => l.includes('[WARN]') && l.includes('CodeBuddy CN')));

    // installAll must continue to patch hooks and create ~/.local/bin/ai-turn-meter even when VSIX installs fail
    const prevManaged = process.env.AI_TURN_METER_MANAGED_BY;
    delete process.env.AI_TURN_METER_MANAGED_BY;
    try {
      const allLogs = [];
      await installAll({
        root: fakeRoot,
        homeDir: fakeHome,
        skipLaunchAgent: true,
        vsixTimeoutMs: 180,
        log: (m) => allLogs.push(m),
        resolveAppPathsFn,
      });
      assert.ok(existsSync(join(fakeHome, '.cursor', 'hooks.json')));
      assert.ok(existsSync(join(fakeHome, '.local', 'bin', 'ai-turn-meter')));
      assert.ok(allLogs.includes('Install complete.'));
    } finally {
      if (prevManaged !== undefined) process.env.AI_TURN_METER_MANAGED_BY = prevManaged;
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('runDoctor reports version parity metadata and formatDoctorReport displays [WARN] on drift', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'atm-doctor-parity-'));
  const fakeRoot = join(tmpDir, 'root');
  const fakeHome = join(tmpDir, 'home');
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, pid: 99999, version: '0.2.28' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  try {
    mkdirSync(fakeRoot, { recursive: true });
    writeFileSync(join(fakeRoot, 'package.json'), JSON.stringify({ version: '0.2.29' }));
    mkdirSync(join(fakeHome, 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(
      join(fakeHome, 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`),
      `<plist><dict><array><string>/other/path/packages/daemon/bin/daemon.mjs</string></array></dict></plist>`
    );

    const port = await listenServer(server);
    const report = await runDoctor({ port, homeDir: fakeHome, root: fakeRoot });
    assert.equal(report.cliVersion, '0.2.29');
    assert.equal(report.daemonVersionMismatch, true);
    assert.equal(typeof report.vsixVersionMismatch, 'boolean');

    // Verify [WARN] rendering on daemon drift, LaunchAgent path drift, and VSIX lag
    const lines = formatDoctorReport(
      {
        cliVersion: '0.2.29',
        daemonVersionMismatch: true,
        vsixVersionMismatch: true,
        packageRoot: '/repo/current',
        node: { ok: true, version: '24.12.0', sqlite: true },
        daemon: { ok: true, port: 47831, pid: 1234, version: '0.2.28' },
        launchAgent: {
          plistPath: '/tmp/test.plist',
          plistExists: true,
          launchAgentLoaded: true,
          programDaemonPath: '/repo/old/packages/daemon/bin/daemon.mjs',
          pointsToCurrentRoot: false,
          managedByApp: false,
        },
        cursorHooks: { path: '/tmp/hooks.json', validVersion: true, configured: true },
        apps: {
          cursor: {
            installed: true,
            appPath: '/Applications/Cursor.app',
            cdpPort: 47922,
            vsixVersion: '0.2.28',
            vsixVersionMismatch: true,
          },
          codebuddy: {
            installed: true,
            appPath: '/Applications/CodeBuddy CN.app',
            cdpPort: null,
            vsixVersion: '0.2.29',
            vsixVersionMismatch: false,
          },
        },
      },
      '0.2.29'
    );

    const daemonLine = lines.find((l) => l.includes('Daemon http://'));
    const laLine = lines.find((l) => l.includes('LaunchAgent'));
    const cursorLine = lines.find((l) => l.includes('cursor'));
    const codebuddyLine = lines.find((l) => l.includes('codebuddy'));

    assert.ok(daemonLine?.includes('[WARN]'), `Expected [WARN] on daemon line: ${daemonLine}`);
    assert.ok(laLine?.includes('[WARN]'), `Expected [WARN] on LaunchAgent line: ${laLine}`);
    assert.ok(cursorLine?.includes('[WARN]'), `Expected [WARN] on cursor VSIX drift: ${cursorLine}`);
    assert.ok(codebuddyLine?.includes('[INFO]'), `Expected [INFO] on matching VSIX: ${codebuddyLine}`);

    // When managedByApp is true, LaunchAgent pointsToCurrentRoot=false should stay [OK  ]
    const appManagedLines = formatDoctorReport(
      {
        cliVersion: '0.2.29',
        daemonVersionMismatch: false,
        vsixVersionMismatch: false,
        packageRoot: '/repo/current',
        node: { ok: true, version: '24.12.0', sqlite: true },
        daemon: { ok: true, port: 47831, pid: 1234, version: '0.2.29' },
        launchAgent: {
          plistPath: '/tmp/test.plist',
          plistExists: true,
          launchAgentLoaded: true,
          programDaemonPath: '/Applications/AI Turn Meter.app/Contents/Resources/runtime/packages/daemon/bin/daemon.mjs',
          pointsToCurrentRoot: false,
          managedByApp: true,
        },
        cursorHooks: { path: '/tmp/hooks.json', validVersion: true, configured: true },
        apps: {},
      },
      '0.2.29'
    );
    assert.ok(appManagedLines.find((l) => l.includes('LaunchAgent'))?.includes('[OK  ]'));
    assert.ok(appManagedLines.find((l) => l.includes('Daemon http://'))?.includes('[OK  ]'));
  } finally {
    await closeServer(server);
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('cmdAppAutostart strictly validates action and never deletes plist on unknown args', () => {
  assert.deepEqual(parseAppAutostartAction('enable'), { kind: 'set', enabled: true });
  assert.deepEqual(parseAppAutostartAction('on'), { kind: 'set', enabled: true });
  assert.deepEqual(parseAppAutostartAction('true'), { kind: 'set', enabled: true });
  assert.deepEqual(parseAppAutostartAction('disable'), { kind: 'set', enabled: false });
  assert.deepEqual(parseAppAutostartAction('off'), { kind: 'set', enabled: false });
  assert.deepEqual(parseAppAutostartAction('false'), { kind: 'set', enabled: false });
  assert.deepEqual(parseAppAutostartAction('status'), { kind: 'status' });
  assert.equal(parseAppAutostartAction('bogus').kind, 'invalid');

  const tmpHome = mkdtempSync(join(tmpdir(), 'atm-autostart-'));
  try {
    const plistPath = join(tmpHome, 'Library', 'LaunchAgents', `${APP_LAUNCH_AGENT_LABEL}.plist`);
    mkdirSync(join(tmpHome, 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(plistPath, '<plist>keep-me</plist>');

    const res = spawnSync(process.execPath, [CLI_BIN, 'app-autostart', 'bogus'], {
      env: { ...process.env, HOME: tmpHome },
      encoding: 'utf8',
    });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /Invalid app-autostart action|Usage:/i);
    assert.ok(existsSync(plistPath), 'Existing autostart plist must NOT be deleted on invalid action');
    assert.equal(readFileSync(plistPath, 'utf8'), '<plist>keep-me</plist>');
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('cmdOpen strips AI_TURN_METER_STABLE_ROOT and AI_TURN_METER_NODE_BIN from child env', async () => {
  const dirtyEnv = {
    PATH: '/usr/bin:/bin',
    HOME: '/Users/tester',
    AI_TURN_METER_STABLE_ROOT: '/Applications/AI Turn Meter.app/Contents/Resources/runtime',
    AI_TURN_METER_NODE_BIN: '/Applications/AI Turn Meter.app/Contents/Resources/runtime/node',
    AI_TURN_METER_MANAGED_BY: 'homebrew',
    KEEP_ME: 'yes',
  };

  const clean = buildCleanLaunchEnv(dirtyEnv);
  assert.equal(clean.AI_TURN_METER_STABLE_ROOT, undefined);
  assert.equal(clean.AI_TURN_METER_NODE_BIN, undefined);
  assert.equal(clean.AI_TURN_METER_MANAGED_BY, undefined);
  assert.equal(clean.KEEP_ME, 'yes');
  assert.equal(clean.PATH, '/usr/bin:/bin');

  const openCalls = [];
  const ok = await openSingleApp('antigravity', {
    exitOnError: false,
    baseEnv: dirtyEnv,
    resolveAppPathsFn: (spec) => ({
      ...spec,
      installed: true,
      appPath: '/Applications/Antigravity.app',
      exePath: '/Applications/Antigravity.app/Contents/MacOS/Antigravity',
    }),
    readActivePortFn: () => null,
    readRunningProcessArgsFn: () => [],
    isAppRunningFn: () => false,
    hasAppHelpersRunningFn: () => false,
    isPortListeningFn: () => true,
    isCdpHttpReadyFn: async () => true,
    sleepFn: async () => {},
    execFileSyncFn: (cmd, args, opts) => {
      openCalls.push({ cmd, args, opts });
    },
  });

  assert.equal(ok, true);
  assert.equal(openCalls.length, 1);
  assert.equal(openCalls[0].cmd, 'open');
  assert.equal(openCalls[0].args[0], '-na');
  assert.equal(openCalls[0].opts.env.AI_TURN_METER_STABLE_ROOT, undefined);
  assert.equal(openCalls[0].opts.env.AI_TURN_METER_NODE_BIN, undefined);
  assert.equal(openCalls[0].opts.env.AI_TURN_METER_MANAGED_BY, undefined);
  assert.equal(openCalls[0].opts.env.KEEP_ME, 'yes');
});

test('cmdFingerprint prints one_click completely and surfaces daemon HTTP errors without offline fallback', async () => {
  const lines = formatFingerprintOutput({
    ok: true,
    mode: 'one_click',
    passive: {
      days: 7,
      totalTurnsScanned: 42,
      overallStatus: 'healthy',
      byTool: {
        codex: { toolLabel: 'Codex', status: 'healthy', turnCount: 42, anomalyCount: 0, latestModel: 'gpt-5.4' },
      },
      anomalies: [],
    },
    codexProto: {
      ok: true,
      verdict: 'healthy',
      responseModel: 'gpt-5.4',
      summary: '官方路由正常',
    },
    run: {
      mode: 'one_click',
      targetName: '一键全面体检',
      verdict: 'healthy',
      score: 100,
      summary: '全部正常（扫描 42 轮 · Codex 路由正常（gpt-5.4））',
    },
  });
  const text = lines.join('\n');
  assert.match(text, /模型降智被动诊断/);
  assert.match(text, /Codex 路由核验: healthy \(模型: gpt-5\.4\)/);
  assert.match(text, /\[one_click\] 一键全面体检 \| 结论: healthy \(100\/100\)/);
  assert.match(text, /全部正常/);

  // Stub daemon returning HTTP 401 on /v1/fingerprint/run and /v1/providers DELETE
  const server = http.createServer((req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
  });
  try {
    const port = await listenServer(server);
    const fpRes = await runSubprocessAsync(
      process.execPath,
      [CLI_BIN, 'fingerprint', '--mode=quick', '--target=ep-custom'],
      {
        env: {
          ...process.env,
          AI_TURN_METER_PORT: String(port),
          AI_TURN_METER_TOKEN: 'wrong-token',
        },
      }
    );
    assert.notEqual(fpRes.code, 0);
    assert.match(fpRes.stderr, /401/);
    assert.match(fpRes.stderr, /unauthorized/);

    const rmRes = await runSubprocessAsync(
      process.execPath,
      [CLI_BIN, 'providers', 'remove', 'ext:demo'],
      {
        env: {
          ...process.env,
          AI_TURN_METER_PORT: String(port),
          AI_TURN_METER_TOKEN: 'wrong-token',
        },
      }
    );
    assert.notEqual(rmRes.code, 0);
    assert.match(rmRes.stderr, /401/);
    assert.match(rmRes.stderr, /unauthorized/);
    assert.doesNotMatch(rmRes.stderr, /未找到插件/);
  } finally {
    await closeServer(server);
  }
});

test('CLI lightweight commands and cursor-hook.mjs emit zero SQLite ExperimentalWarning on stderr', async () => {
  for (const args of [['--version'], ['--help']]) {
    const res = await runSubprocessAsync(process.execPath, [CLI_BIN, ...args]);
    assert.equal(res.code, 0);
    assert.equal(res.stderr.trim(), '', `Expected clean stderr for cli ${args.join(' ')}, got: ${res.stderr}`);
  }

  // Online cursor-hook forwarding -> zero stderr
  let receivedHook = null;
  const stubServer = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      receivedHook = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, buffered: true }));
    });
  });

  const tmpDir = mkdtempSync(join(tmpdir(), 'atm-cursor-hook-clean-'));
  try {
    const port = await listenServer(stubServer);
    const onlineRes = await runSubprocessAsync(process.execPath, [CURSOR_HOOK_BIN], {
      env: { ...process.env, AI_TURN_METER_PORT: String(port), AI_TURN_METER_STATE_DIR: tmpDir },
      stdinText: JSON.stringify({
        hook_event_name: 'beforeSubmitPrompt',
        conversation_id: 'c-clean',
        generation_id: 'g-clean',
      }),
    });
    assert.equal(onlineRes.code, 0);
    assert.equal(onlineRes.stderr.trim(), '', `Expected clean stderr for online cursor-hook, got: ${onlineRes.stderr}`);
    assert.equal(receivedHook?.conversation_id, 'c-clean');

    await closeServer(stubServer);

    // Offline cursor-hook spooling -> zero stderr and writes cursor-spool.jsonl
    const offlineStateDir = join(tmpDir, 'offline');
    const off1 = await runSubprocessAsync(process.execPath, [CURSOR_HOOK_BIN], {
      env: { ...process.env, AI_TURN_METER_PORT: String(port), AI_TURN_METER_STATE_DIR: offlineStateDir },
      stdinText: JSON.stringify({
        hook_event_name: 'beforeSubmitPrompt',
        conversation_id: 'c-off',
        generation_id: 'g-off',
        workspace_roots: ['/tmp/ws-offline'],
      }),
    });
    assert.equal(off1.code, 0);
    assert.equal(off1.stderr.trim(), '', `Expected clean stderr for offline hook 1, got: ${off1.stderr}`);

    const off2 = await runSubprocessAsync(process.execPath, [CURSOR_HOOK_BIN], {
      env: { ...process.env, AI_TURN_METER_PORT: String(port), AI_TURN_METER_STATE_DIR: offlineStateDir },
      stdinText: JSON.stringify({
        hook_event_name: 'stop',
        conversation_id: 'c-off',
        generation_id: 'g-off',
        model_id: 'claude-4-sonnet',
        input_tokens: 5000,
        cache_read_tokens: 4000,
        output_tokens: 200,
      }),
    });
    assert.equal(off2.code, 0);
    assert.equal(off2.stderr.trim(), '', `Expected clean stderr for offline hook 2, got: ${off2.stderr}`);

    const spoolPath = join(offlineStateDir, 'cursor-spool.jsonl');
    assert.ok(existsSync(spoolPath), 'Offline hook should spool completed turn to cursor-spool.jsonl');
    const spooledTurn = JSON.parse(readFileSync(spoolPath, 'utf8').trim());
    assert.equal(spooledTurn.turnUid, 'cursor:c-off:g-off');
    assert.equal(spooledTurn.totalInputTokens, 5000);
    assert.equal(spooledTurn.outputTokens, 200);
  } finally {
    try {
      await closeServer(stubServer);
    } catch {}
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('daemon.mjs handles EADDRINUSE cleanly with ISO timestamp and guards duplicate shutdown signals', async () => {
  const blocker = http.createServer((_req, res) => res.end('ok'));
  const tmpState = mkdtempSync(join(tmpdir(), 'atm-daemon-bin-'));
  try {
    const busyPort = await listenServer(blocker);
    const busyRes = await runSubprocessAsync(process.execPath, [DAEMON_BIN, `--port=${busyPort}`], {
      // The daemon must never open the real ~/.local/share/ai-turn-meter/meter.db or scan real
      // session logs: the DB path and every adapter root derive from HOME / AI_TURN_METER_DB.
      env: {
        ...process.env,
        HOME: tmpState,
        AI_TURN_METER_DB: join(tmpState, 'meter.db'),
        AI_TURN_METER_STATE_DIR: tmpState,
        AI_TURN_METER_DISABLE_CDP: '1',
      },
      timeoutMs: 8000,
    });
    assert.equal(busyRes.code, 1);
    assert.match(busyRes.stderr, /\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/);
    assert.match(busyRes.stderr, /EADDRINUSE/);
    assert.doesNotMatch(busyRes.stderr, /Unhandled 'error' event/);

    // Release port and test normal startup + double SIGTERM re-entrancy guard
    await closeServer(blocker);
    const child = spawn(process.execPath, [DAEMON_BIN, `--port=${busyPort}`], {
      env: {
        ...process.env,
        HOME: join(tmpState, 'run2'),
        AI_TURN_METER_DB: join(tmpState, 'run2', 'meter.db'),
        AI_TURN_METER_STATE_DIR: join(tmpState, 'run2'),
        AI_TURN_METER_DISABLE_CDP: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`Daemon failed to start: ${stderr}`)), 8000);
      child.stdout.on('data', (d) => {
        stdout += d;
        if (stdout.includes('daemon listening on')) {
          clearTimeout(t);
          resolve();
        }
      });
      child.stderr.on('data', (d) => {
        stderr += d;
      });
      child.once('exit', (code) => {
        clearTimeout(t);
        reject(new Error(`Daemon exited prematurely (${code}): ${stderr}`));
      });
    });

    assert.match(stdout, /\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[ai-turn-meter\] daemon listening on/);

    // Send two rapid SIGTERMs to verify shuttingDown re-entrancy guard
    const exitResult = await new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {}
        reject(new Error('Daemon did not exit after SIGTERM'));
      }, 8000);
      child.once('exit', (code, signal) => {
        clearTimeout(t);
        resolve({ code, signal });
      });
      child.kill('SIGTERM');
      child.kill('SIGTERM');
    });

    assert.equal(exitResult.code, 0);
    const shutdownMatches = stdout.match(/received SIGTERM, shutting down daemon/g) || [];
    assert.equal(shutdownMatches.length, 1, `Expected single shutdown log, got stdout:\n${stdout}`);
    assert.match(stdout, /\[\d{4}-\d{2}-\d{2}T.*\] \[ai-turn-meter\] daemon stopped cleanly\./);
  } finally {
    try {
      await closeServer(blocker);
    } catch {}
    rmSync(tmpState, { recursive: true, force: true });
  }
});

test('vscode extension filters cursor-cloud, debounces SSE refresh, avoids reconnect clobber, and widens pollTimer', async () => {
  const sseClients = [];
  const requestedUrls = [];
  let matchCount = 0;

  const server = http.createServer((req, res) => {
    requestedUrls.push(req.url);
    if (req.url.startsWith('/v1/match')) {
      matchCount += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          turn: {
            tool: 'cursor',
            toolLabel: 'Cursor',
            model: 'claude-4-sonnet',
            inlineText: '输入 10k (80%) · 输出 500 · 55 tok/s',
            totalInputTokens: 10000,
            outputTokens: 500,
            cacheRatePct: 80,
            tps: 55,
          },
        })
      );
      return;
    }
    if (req.url.startsWith('/v1/turns')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          turns: [
            {
              tool: 'cursor',
              toolLabel: 'Cursor',
              host: 'cursor-cloud',
              model: 'grok-bot-default',
              inlineText: '输入 5k · 输出 100 · N/A tok/s',
              completedAtMs: Date.now(),
              uncachedInputTokens: 5000,
              cacheReadTokens: 0,
              tpsMethodLabel: '不可用',
            },
            {
              tool: 'cursor',
              toolLabel: 'Cursor',
              host: 'cursor-ide',
              model: 'claude-4-sonnet',
              inlineText: '输入 12k (90%) · 输出 400 · 60 tok/s',
              completedAtMs: Date.now(),
              uncachedInputTokens: 1200,
              cacheReadTokens: 10800,
              tpsMethodLabel: '扣工具含首字等待',
            },
          ],
        })
      );
      return;
    }
    if (req.url === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      sseClients.push(res);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const port = await listenServer(server);

  const commands = new Map();
  let configListener = null;
  let pickedItems = null;
  const intervalDelays = [];
  const origSetInterval = globalThis.setInterval;
  globalThis.setInterval = (fn, delay, ...rest) => {
    intervalDelays.push(delay);
    return origSetInterval(fn, delay, ...rest);
  };

  const mockVscode = {
    StatusBarAlignment: { Right: 2 },
    MarkdownString: class {
      constructor() {
        this.value = '';
      }
      appendMarkdown(s) {
        this.value += s;
      }
    },
    env: { appName: 'Cursor' },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: '/tmp/test-ws' } }],
      getConfiguration: () => ({
        get: (key) => {
          if (key === 'daemonUrl') return `http://127.0.0.1:${port}`;
          if (key === 'toolFilter') return 'auto';
          return undefined;
        },
      }),
      onDidChangeConfiguration: (fn) => {
        configListener = fn;
        return { dispose() {} };
      },
      onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
    },
    window: {
      createStatusBarItem: () => ({
        text: '',
        tooltip: null,
        command: null,
        show() {},
        hide() {},
        dispose() {},
      }),
      showInformationMessage() {},
      showWarningMessage() {},
      showQuickPick: async (items) => {
        pickedItems = items;
        return undefined;
      },
    },
    commands: {
      registerCommand: (name, fn) => {
        commands.set(name, fn);
        return { dispose() {} };
      },
    },
  };

  const origLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'vscode') return mockVscode;
    return origLoad.call(this, request, parent, isMain);
  };

  const context = { subscriptions: [] };
  try {
    const req = Module.createRequire(import.meta.url);
    const extPath = join(REPO_ROOT, 'packages', 'vscode-extension', 'extension.js');
    delete req.cache[req.resolve(extPath)];
    const ext = req(extPath);
    ext.activate(context);

    // Wait for initial SSE connection
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(sseClients.length, 1);
    assert.ok(intervalDelays.includes(5000), `Expected initial 5000ms fallback poll, got ${intervalDelays}`);
    assert.ok(intervalDelays.includes(30000), `Expected 30000ms poll after SSE connect, got ${intervalDelays}`);

    // 1. showRecent sends excludeCloud=1 and defensively filters cursor-cloud client-side
    await commands.get('aiTurnMeter.showRecent')();
    const turnsUrl = requestedUrls.find((u) => u.startsWith('/v1/turns'));
    assert.ok(turnsUrl?.includes('tool=cursor'), `Expected tool=cursor in ${turnsUrl}`);
    assert.ok(turnsUrl?.includes('excludeCloud=1'), `Expected excludeCloud=1 in ${turnsUrl}`);
    assert.equal(pickedItems?.length, 1);
    assert.match(pickedItems[0].description, /claude-4-sonnet/);

    // 2. Burst of 8 SSE events within 10ms triggers only 1 debounced /v1/match call
    const beforeBurst = matchCount;
    for (let i = 0; i < 8; i += 1) {
      sseClients[0].write(`event: turn\ndata: {"id":${i}}\n\n`);
    }
    await new Promise((r) => setTimeout(r, 450));
    assert.equal(matchCount - beforeBurst, 1, `Expected 1 debounced refresh, got ${matchCount - beforeBurst}`);

    // 3. Reconnect clobber check: config change calls connectSse() destroying old stream;
    // old stream's error/close must NOT schedule a reconnect that opens a 3rd stream
    configListener({ affectsConfiguration: (s) => s === 'aiTurnMeter' });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(sseClients.length, 2, 'Config change should open stream #2');
    // Wait briefly and verify stream #2 stays healthy and doesn't immediately drop to 5s poll
    const delaysBeforeWait = intervalDelays.length;
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(intervalDelays[intervalDelays.length - 1], 30000);
    assert.equal(intervalDelays.length, delaysBeforeWait);
  } finally {
    for (const sub of context.subscriptions) {
      try {
        sub.dispose?.();
      } catch {}
    }
    for (const c of sseClients) {
      try {
        c.end();
      } catch {}
    }
    Module._load = origLoad;
    globalThis.setInterval = origSetInterval;
    await closeServer(server);
  }
});

test('build-dmg semver sorting, .DS_Store filter, version parity check, and Homebrew caveats', () => {
  const sorted = sortSemverDesc(['v22.5.0', 'v24.9.0', 'v24.12.0', 'v24.2.1', 'v22.14.0', '.DS_Store']);
  assert.deepEqual(sorted, ['v24.12.0', 'v24.9.0', 'v24.2.1', 'v22.14.0', 'v22.5.0', '.DS_Store']);

  assert.equal(shouldCopyBundlePath('/repo/packages/daemon/.DS_Store'), false);
  assert.equal(shouldCopyBundlePath('/repo/packages/daemon/src/.DS_Store'), false);
  assert.equal(shouldCopyBundlePath('/repo/packages/daemon/src/server.mjs'), true);

  // Repo root passes version parity in both build scripts
  const dmgParity = assertDmgVersionParity(REPO_ROOT);
  const relParity = assertReleaseVersionParity(REPO_ROOT);
  assert.equal(dmgParity.rootVersion, dmgParity.vsixVersion);
  assert.equal(relParity.rootVersion, relParity.vsixVersion);

  // Mismatched package versions fail fast
  const tmpDir = mkdtempSync(join(tmpdir(), 'atm-parity-'));
  try {
    mkdirSync(join(tmpDir, 'packages', 'vscode-extension'), { recursive: true });
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({ version: '0.2.30' }));
    writeFileSync(join(tmpDir, 'packages', 'vscode-extension', 'package.json'), JSON.stringify({ version: '0.2.29' }));
    assert.throws(() => assertDmgVersionParity(tmpDir), /Version mismatch/);
    assert.throws(() => assertReleaseVersionParity(tmpDir), /Version mismatch/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  // Homebrew formula caveats mention brew upgrade + ai-turn-meter install
  const formula = readFileSync(join(REPO_ROOT, 'packaging', 'homebrew', 'ai-turn-meter.rb'), 'utf8');
  assert.match(formula, /brew upgrade/);
  assert.match(formula, /ai-turn-meter install/);
});

test('Node 22.5-22.14 compatibility: dynamic zstd fallback, sqlite flag detection, and no static zstd imports', () => {
  const sampleBuf = Buffer.from('28b52ffd', 'hex');
  assert.equal(decompressZstdSync(sampleBuf, { nativeImpl: null, cliFallback: null }), null);
  assert.equal(
    decompressZstdSync(sampleBuf, {
      nativeImpl: null,
      cliFallback: () => Buffer.from('ok'),
    }).toString('utf8'),
    'ok'
  );

  const codexSrc = readFileSync(join(REPO_ROOT, 'packages', 'daemon', 'src', 'adapters', 'codex.mjs'), 'utf8');
  const quotaSrc = readFileSync(join(REPO_ROOT, 'packages', 'daemon', 'src', 'quota.mjs'), 'utf8');
  assert.doesNotMatch(codexSrc, /import\s*\{[^}]*zstdDecompressSync[^}]*\}\s*from\s*['"]node:zlib['"]/);
  assert.doesNotMatch(quotaSrc, /import\s*\{[^}]*zstdDecompressSync[^}]*\}\s*from\s*['"]node:zlib['"]/);

  assert.equal(needsExperimentalSqliteFlag('22.5.0'), true);
  assert.equal(needsExperimentalSqliteFlag('22.12.9'), true);
  assert.equal(needsExperimentalSqliteFlag('22.13.0'), false);
  assert.equal(needsExperimentalSqliteFlag('24.12.0'), false);

  const plist225 = buildLaunchAgentPlist({ nodeBin: '/usr/local/bin/node', nodeVersion: '22.5.0' });
  const plist24 = buildLaunchAgentPlist({ nodeBin: '/usr/local/bin/node', nodeVersion: '24.12.0' });
  assert.match(plist225, /<string>--experimental-sqlite<\/string>/);
  assert.doesNotMatch(plist24, /--experimental-sqlite/);
});

test('build-dmg Mach-O minos parsing and LSMinimumSystemVersion compatibility enforcement', () => {
  const sampleOtool = `
Load command 9
      cmd LC_BUILD_VERSION
  cmdsize 32
 platform 1
    minos 13.5
      sdk 15.0
`;
  assert.equal(parseMachOMinOs(sampleOtool), '13.5');
  assert.equal(parseMachOMinOs('cmd LC_VERSION_MIN_MACOSX\n version 13.0\n'), '13.0');
  assert.equal(
    resolveMinimumSystemVersion({ declaredMinOs: '13.0', binaryMinVersions: ['13.0', '13.5'] }),
    '13.5'
  );
  assert.equal(
    assertMinimumSystemVersionCompatible({
      plistMinOs: '13.5',
      binaries: [
        { name: 'AITurnMeter', minOs: '13.0' },
        { name: 'runtime/node', minOs: '13.5' },
      ],
    }),
    '13.5'
  );
  assert.throws(
    () =>
      assertMinimumSystemVersionCompatible({
        plistMinOs: '13.0',
        binaries: [{ name: 'runtime/node', minOs: '13.5' }],
      }),
    /LSMinimumSystemVersion \(13\.0\) is lower than runtime\/node Mach-O minos \(13\.5\)/
  );
});
