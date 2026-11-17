#!/usr/bin/env node
/**
 * Unified CLI for AI Turn Meter:
 *   ai-turn-meter status
 *   ai-turn-meter doctor
 *   ai-turn-meter install [--dry-run] [--no-link] [--no-daemon]
 *   ai-turn-meter uninstall [--dry-run]
 *   ai-turn-meter open <codex|cursor|codebuddy|antigravity|all>
 *   ai-turn-meter ssh-info [host]
 *   ai-turn-meter daemon [--port=47831]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  APP_SPECS,
  DEFAULT_DAEMON_PORT,
  hasAppHelpersRunning,
  isAppRunning,
  isCdpHttpReady,
  isPortListening,
  readActivePort,
  readRunningProcessArgs,
  resolveAppPaths,
} from '../src/apps.mjs';
import {
  CURSOR_EVENTS,
  installAll,
  installLaunchAgent,
  resolvePackageRoot,
  runDoctor,
  uninstallAll,
  uninstallLaunchAgent,
} from '../src/installer.mjs';

const PORT = DEFAULT_DAEMON_PORT;

function getPkgVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(resolvePackageRoot(), 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function printHelp() {
  console.log(`ai-turn-meter v${getPkgVersion()}

Usage:
  ai-turn-meter [status]                查看后台守护进程、CDP 与 4 家最近一轮指标
  ai-turn-meter doctor                  检查 Node、LaunchAgent、Cursor Hooks、VSIX 与 CDP 状态
  ai-turn-meter install                 安装或更新 LaunchAgent、Cursor Hooks、VSIX 与 CLI 软链
    --dry-run                           仅预览安装步骤，不写入文件
    --no-link                           跳过 ~/.local/bin/ai-turn-meter 软链
    --no-daemon                         跳过 LaunchAgent 注册与拉起
  ai-turn-meter uninstall [--dry-run]   卸载 LaunchAgent、VSIX、Cursor Hooks 与 CLI 软链
  ai-turn-meter open <target|all>       开启调试口并打开指定软件 (codex|cursor|codebuddy|antigravity|all)
  ai-turn-meter ssh-info [host]         输出 Cursor Remote-SSH 所需的 RemoteForward 与远端 hooks.json
  ai-turn-meter daemon [--port=47831]   在前台直接启动守护进程`);
}

async function cmdStatus(jsonMode = false) {
  let state = null;
  let online = false;
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/state`, { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      state = await res.json();
      online = true;
    }
  } catch {}

  const apps = {};
  for (const [key, spec] of Object.entries(APP_SPECS)) {
    const resolved = resolveAppPaths(spec);
    const cdpPort = resolved.installed ? readActivePort(resolved) : null;
    apps[key] = {
      name: resolved.name,
      appPath: resolved.appPath,
      installed: resolved.installed,
      running: isAppRunning(resolved),
      cdpPort,
      latestTurn: state?.byTool?.[key] || null,
    };
  }

  if (jsonMode) {
    const config = state?.config || {
      enabled: true,
      tools: { antigravity: true, codex: true, cursor: true, codebuddy: true },
    };
    console.log(JSON.stringify({ version: getPkgVersion(), port: PORT, online, config, apps, state }));
    return;
  }

  if (!online) {
    console.error(`Daemon offline (http://127.0.0.1:${PORT})`);
    process.exit(1);
  }
  console.log(`Daemon: online (http://127.0.0.1:${PORT})`);
  for (const [key, app] of Object.entries(apps)) {
    const cdpLabel = !app.installed
      ? '未安装'
      : app.cdpPort
        ? `CDP:${app.cdpPort}`
        : key === 'antigravity'
          ? 'CDP未检测到'
          : 'CDP未启用';
    const t = app.latestTurn;
    console.log(`- ${key.padEnd(11)} [${cdpLabel}]  ${t ? `${t.model} | ${t.inlineText}` : '暂无记录'}`);
  }
}

async function cmdDoctor(jsonMode = false) {
  const report = await runDoctor({ port: PORT });
  if (jsonMode) {
    console.log(JSON.stringify({ version: getPkgVersion(), ...report }));
    return;
  }
  const mark = (ok) => (ok ? 'OK  ' : 'FAIL');
  console.log(`AI Turn Meter v${getPkgVersion()} Doctor`);
  console.log(`- [${mark(report.node.ok)}] Node.js v${report.node.version} (node:sqlite=${report.node.sqlite})`);
  console.log(
    `- [${mark(report.daemon.ok)}] Daemon http://127.0.0.1:${report.daemon.port}${report.daemon.pid ? ` (pid ${report.daemon.pid})` : ''}`
  );
  console.log(
    `- [${mark(report.launchAgent.plistExists && report.launchAgent.launchAgentLoaded)}] LaunchAgent (${report.launchAgent.plistPath})`
  );
  console.log(
    `- [${mark(report.cursorHooks.validVersion && report.cursorHooks.configured)}] Cursor Hooks (${report.cursorHooks.path}, versionOk=${report.cursorHooks.validVersion})`
  );
  for (const [key, app] of Object.entries(report.apps)) {
    const parts = [app.installed ? app.appPath : '未安装'];
    if (app.installed) {
      parts.push(app.cdpPort ? `CDP:${app.cdpPort}` : 'CDP未启用');
      if (key === 'cursor' || key === 'codebuddy') {
        parts.push(app.vsixVersion ? `VSIX:${app.vsixVersion}` : 'VSIX未安装');
      }
    }
    console.log(`- [${app.installed ? 'INFO' : 'SKIP'}] ${key.padEnd(11)} ${parts.join(' | ')}`);
  }
}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function openSingleApp(target, { exitOnError = true } = {}) {
  const fail = (message) => {
    console.error(message);
    if (exitOnError) process.exit(1);
    return false;
  };

  const baseSpec = APP_SPECS[target];
  if (!baseSpec) {
    return fail(`Unknown app "${target}". Choose: codex | cursor | codebuddy | antigravity | all`);
  }
  const spec = resolveAppPaths(baseSpec);
  if (!spec.installed || !spec.appPath) {
    return fail(`Not installed: ${spec.bundleName}`);
  }
  const activePort = readActivePort(spec);
  if (target === 'antigravity' || (activePort && (await isCdpHttpReady(activePort)))) {
    execFileSync('open', ['-a', spec.appPath]);
    console.log(`Focused ${spec.name}`);
    return true;
  }

  // Capture existing launch flags (e.g. --mute-audio) before quitting so guards or user switches survive restart.
  const preservedArgs = readRunningProcessArgs(spec);
  let running = isAppRunning(spec);

  if (running) {
    try {
      execFileSync('osascript', ['-e', `tell application "${spec.name}" to quit`], { stdio: 'ignore' });
    } catch {}
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (!isAppRunning(spec)) {
        running = false;
        break;
      }
      await sleepMs(250);
    }
    if (running) {
      return fail(
        `${spec.name} 未在 8 秒内退出（可能存在未保存文件或确认弹窗），请手动退出后重试 ai-turn-meter open ${target}`
      );
    }
    const helperDeadline = Date.now() + 2000;
    while (Date.now() < helperDeadline && hasAppHelpersRunning(spec)) {
      await sleepMs(150);
    }
    await sleepMs(250);
  }

  const launchArgs = [...preservedArgs, `--remote-debugging-port=${spec.port}`];
  execFileSync('open', ['-na', spec.appPath, '--args', ...launchArgs], {
    stdio: 'ignore',
  });

  const cdpDeadline = Date.now() + 10000;
  let ready = false;
  while (Date.now() < cdpDeadline) {
    if (isPortListening(spec.port) && (await isCdpHttpReady(spec.port))) {
      ready = true;
      break;
    }
    await sleepMs(250);
  }
  if (ready) {
    // Re-check after 1.6s so a background watchdog relaunch that drops `--remote-debugging-port` is caught honestly.
    await sleepMs(1600);
    ready = isPortListening(spec.port) && (await isCdpHttpReady(spec.port));
  }
  if (!ready) {
    const postArgs = readRunningProcessArgs(spec);
    const detail = isAppRunning(spec)
      ? `${spec.name} 启动后调试口 ${spec.port} 未保持开启（当前进程参数：${postArgs.join(' ') || '无'}，可能被其他守护脚本重启覆盖）`
      : `${spec.name} 未能开启调试口 ${spec.port}`;
    return fail(detail);
  }

  console.log(`Launched ${spec.name} with CDP on 127.0.0.1:${spec.port}`);
  return true;
}

async function cmdOpen(target) {
  if (target === 'all') {
    let allOk = true;
    for (const k of ['codex', 'cursor', 'codebuddy']) {
      if (resolveAppPaths(APP_SPECS[k]).installed) {
        const ok = await openSingleApp(k, { exitOnError: false });
        if (!ok) allOk = false;
      }
    }
    if (!allOk) process.exit(1);
    return;
  }
  await openSingleApp(target, { exitOnError: true });
}

function cmdSshInfo(host = '<remote-host>') {
  const remoteHooks = {
    version: 1,
    hooks: Object.fromEntries(
      CURSOR_EVENTS.map((ev) => [
        ev,
        [
          {
            command: `curl -fsS -m 1 -X POST -H "Content-Type: application/json" --data-binary @- http://127.0.0.1:${PORT}/v1/ingest/cursor-hook >/dev/null 2>&1 || true`,
          },
        ],
      ])
    ),
  };
  console.log(`1) Add to Mac ~/.ssh/config under Host ${host}:`);
  console.log(`   RemoteForward ${PORT} 127.0.0.1:${PORT}`);
  console.log('');
  console.log(`2) Write ~/.cursor/hooks.json on remote host ${host}:`);
  console.log(JSON.stringify(remoteHooks, null, 2));
}

async function cmdDaemon(flags) {
  const portFlag = flags.find((a) => a.startsWith('--port='));
  const port = portFlag ? Number(portFlag.split('=')[1]) : PORT;
  const { createMeterServer } = await import('../src/server.mjs');
  const meter = createMeterServer({ port });
  await meter.start();
  console.log(`[ai-turn-meter] daemon listening on http://127.0.0.1:${port}`);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      await meter.stop();
      process.exit(0);
    });
  }
}

const argv = process.argv.slice(2);
const cmd = argv.find((a) => !a.startsWith('-'));
const flags = argv.filter((a) => a.startsWith('-'));
const dryRun = flags.includes('--dry-run');
const jsonMode = flags.includes('--json');

if (flags.includes('--version') || flags.includes('-v')) {
  console.log(getPkgVersion());
} else if (flags.includes('--help') || flags.includes('-h') || cmd === 'help') {
  printHelp();
} else if (cmd === 'status' || !cmd) {
  await cmdStatus(jsonMode);
} else if (cmd === 'doctor') {
  await cmdDoctor(jsonMode);
} else if (cmd === 'install' || cmd === 'setup') {
  await installAll({
    dryRun,
    skipCliLink: flags.includes('--no-link'),
    skipLaunchAgent: flags.includes('--no-daemon'),
  });
} else if (cmd === 'uninstall') {
  uninstallAll({ dryRun });
} else if (cmd === 'start-daemon') {
  installLaunchAgent({ dryRun });
} else if (cmd === 'stop-daemon') {
  uninstallLaunchAgent({ dryRun });
} else if (cmd === 'open') {
  const target = argv[argv.indexOf('open') + 1];
  await cmdOpen(target);
} else if (cmd === 'ssh-info') {
  const idx = argv.indexOf('ssh-info');
  const host = argv[idx + 1] && !argv[idx + 1].startsWith('-') ? argv[idx + 1] : undefined;
  cmdSshInfo(host);
} else if (cmd === 'daemon') {
  await cmdDaemon(flags);
} else {
  printHelp();
  process.exit(1);
}
