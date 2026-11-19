#!/usr/bin/env node
/**
 * Unified CLI for AI Turn Meter:
 *   ai-turn-meter status
 *   ai-turn-meter cost [--days=1|7|30|all] [--tool=<tool>] [--json]
 *   ai-turn-meter doctor
 *   ai-turn-meter install [--dry-run] [--no-link] [--no-daemon]
 *   ai-turn-meter uninstall [--dry-run]
 *   ai-turn-meter open <codex|cursor|codebuddy|antigravity|all>
 *   ai-turn-meter ssh-info [host]
 *   ai-turn-meter ssh-apply <host> [--remote]
 *   ai-turn-meter app-autostart <enable|disable|status>
 *   ai-turn-meter daemon [--port=47831]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  APP_SPECS,
  DEFAULT_DAEMON_PORT,
  hasAppHelpersRunning,
  isAppRunning,
  isCdpHttpReady,
  isPortListening,
  readActivePort,
  readListeningTcpPorts,
  readProcessCommandLines,
  readRunningProcessArgs,
  resolveAppPaths,
} from '../src/apps.mjs';
import { formatTokens, formatTps } from '../src/format.mjs';
import { AUTH_TOKEN_HEADER, readDaemonToken } from '../src/auth.mjs';
import {
  applyLocalSshConfig,
  applyRemoteCursorHooks,
  buildRemoteHooksConfig,
  buildRemoteSshOneLiner,
  installAll,
  installLaunchAgent,
  isAppAutostartEnabled,
  resolveInstalledAppExe,
  resolvePackageRoot,
  runDoctor,
  setAppAutostart,
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
  ai-turn-meter cost [--days=7]         查看今日/本周/历史 Token 用量与 API 等效费用估算
  ai-turn-meter receipt [--date=...]    打印超市小票风每日账单（支持 --scope=day|week|month --group=model|tool|project --currency=both|usd|cny --rate=7 --svg=out.svg）
  ai-turn-meter fingerprint [--mode=.]  运行模型指纹与降智检测（passive|codex_protocol|quick|deep，支持 --target=codex|<id> --record-baseline）
  ai-turn-meter doctor                  检查 Node、LaunchAgent、Cursor Hooks、VSIX 与 CDP 状态
  ai-turn-meter install                 安装或更新 LaunchAgent、Cursor Hooks、VSIX 与 CLI 软链
    --dry-run                           仅预览安装步骤，不写入文件
    --no-link                           跳过 ~/.local/bin/ai-turn-meter 软链
    --no-daemon                         跳过 LaunchAgent 注册与拉起
  ai-turn-meter uninstall [--dry-run]   卸载 LaunchAgent、VSIX、Cursor Hooks 与 CLI 软链
  ai-turn-meter open <target|all>       开启调试口并打开指定软件 (codex|cursor|codebuddy|antigravity|all)
  ai-turn-meter ssh-info [host]         输出 Cursor Remote-SSH 所需的 RemoteForward、hooks.json 与一键命令
  ai-turn-meter ssh-apply <host>        一键将 RemoteForward 写入本机 ~/.ssh/config（加 --remote 同步写远端）
  ai-turn-meter app-autostart <action>  管理菜单栏应用开机自启 (enable|disable|status)
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

  const listeningPorts = readListeningTcpPorts();
  const processLines = readProcessCommandLines();
  const apps = {};
  for (const [key, spec] of Object.entries(APP_SPECS)) {
    const resolved = resolveAppPaths(spec);
    const cdpPort = resolved.installed ? readActivePort(resolved, undefined, listeningPorts) : null;
    apps[key] = {
      name: resolved.name,
      appPath: resolved.appPath,
      installed: resolved.installed,
      running: isAppRunning(resolved, processLines),
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
  if (activePort && (await isCdpHttpReady(activePort))) {
    execFileSync('open', ['-a', spec.appPath]);
    console.log(`Focused ${spec.name}`);
    return true;
  }

  // Capture existing launch flags (e.g. --mute-audio) before quitting so guards or user switches survive restart.
  const preservedArgs = readRunningProcessArgs(spec);
  let running = isAppRunning(spec);

  if (running) {
    let quitErr = '';
    try {
      execFileSync('osascript', ['-e', `tell application "${spec.name}" to quit`], {
        encoding: 'utf8',
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (e) {
      quitErr = String(e?.stderr || e?.message || '').trim();
    }
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (!isAppRunning(spec)) {
        running = false;
        break;
      }
      await sleepMs(250);
    }
    if (running) {
      const hint = quitErr
        ? `（${quitErr.slice(0, 80)}）`
        : '（可能存在未保存文件、确认弹窗或系统未授权自动化退出）';
      return fail(
        `${spec.name} 未在 8 秒内退出${hint}，请先按 ⌘Q 手动退出 ${spec.name}，再重试开启`
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
    for (const k of ['antigravity', 'codex', 'cursor', 'codebuddy']) {
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

function fmtUsd(val) {
  if (typeof val !== 'number' || !Number.isFinite(val)) return 'N/A';
  if (val === 0) return '$0.00';
  if (val < 0.01) return `$${val.toFixed(4)}`;
  return `$${val.toFixed(2)}`;
}

async function cmdCost(flags, jsonMode = false) {
  const daysFlag = flags.find((a) => a.startsWith('--days='));
  const toolFlag = flags.find((a) => a.startsWith('--tool='));
  const rawDays = daysFlag ? daysFlag.split('=')[1] : '7';
  const days = rawDays === 'all' || rawDays === '0' ? 0 : Math.max(1, Math.round(Number(rawDays) || 7));
  const tool = toolFlag ? toolFlag.split('=')[1].trim() || null : null;

  let usage = null;
  try {
    const qs = new URLSearchParams({ days: String(days) });
    if (tool) qs.set('tool', tool);
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/usage?${qs.toString()}`, {
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) usage = await res.json();
  } catch {}

  if (!usage) {
    const { TurnStore } = await import('../src/store.mjs');
    const { getAllQuotas } = await import('../src/quota.mjs');
    const store = new TurnStore();
    try {
      const quotasByTool = await getAllQuotas().catch(() => null);
      usage = store.getUsageSummary({ days, tool, quotasByTool });
    } finally {
      store.close();
    }
  }

  if (jsonMode) {
    console.log(JSON.stringify(usage));
    return;
  }

  const rangeLabel = days === 0 ? '全部历史' : days === 1 ? '今日' : `近 ${days} 天`;
  const t = usage.totals;
  const cacheStr = t.cacheRatePct !== null && t.cacheRatePct !== undefined ? `${t.cacheRatePct}%` : '--';
  console.log(`AI Turn Meter 用量与费用汇总（${rangeLabel}${tool ? ` · ${tool}` : ''}）`);
  console.log(
    `周期合计: ${t.turnCount} 轮 / ${t.callCount} 次调用 | 输入 ${formatTokens(t.totalInputTokens)} (缓存 ${cacheStr}) | 输出 ${formatTokens(t.outputTokens)} | 均速 ${formatTps(t.avgTps)}`
  );
  console.log(
    `费用估算: ${fmtUsd(t.estimatedCostUsd)}（缓存节省 ${fmtUsd(t.cacheSavingsUsd)}）${t.unpricedTurnCount > 0 ? ` | 未定价轮次: ${t.unpricedTurnCount}` : ''}`
  );
  if (days !== 1 && usage.today) {
    console.log(
      `今日快照: ${usage.today.turnCount} 轮 | 总计 ${formatTokens(usage.today.totalTokens)} | 估算 ${fmtUsd(usage.today.estimatedCostUsd)}`
    );
  }
  if (Array.isArray(usage.byTool) && usage.byTool.length > 0) {
    console.log('\n按客户端:');
    for (const row of usage.byTool) {
      const c = row.cacheRatePct !== null && row.cacheRatePct !== undefined ? `${row.cacheRatePct}%` : '--';
      console.log(
        `- ${row.toolLabel.padEnd(11)} ${String(row.sharePct).padStart(5)}% | 输入 ${formatTokens(row.totalInputTokens)} (${c}) | 输出 ${formatTokens(row.outputTokens)} | ${fmtUsd(row.estimatedCostUsd)}`
      );
    }
  }
  if (Array.isArray(usage.byModel) && usage.byModel.length > 0) {
    console.log('\nTop 模型:');
    for (const row of usage.byModel.slice(0, 12)) {
      const c = row.cacheRatePct !== null && row.cacheRatePct !== undefined ? `${row.cacheRatePct}%` : '--';
      console.log(
        `- [${row.toolLabel}] ${row.model} | ${row.turnCount}轮 | 输入 ${formatTokens(row.totalInputTokens)} (${c}) | 输出 ${formatTokens(row.outputTokens)} | ${formatTps(row.avgTps)} | ${fmtUsd(row.estimatedCostUsd)}`
      );
    }
  }
}

async function cmdReceipt(flags, jsonMode = false) {
  const getVal = (prefix) => {
    const f = flags.find((a) => a.startsWith(prefix));
    return f ? f.slice(prefix.length).trim() : '';
  };
  const date = getVal('--date=') || null;
  const scope = getVal('--scope=') || 'day';
  const tool = getVal('--tool=') || null;
  const groupBy = getVal('--group=') || getVal('--group-by=') || 'model';
  const currency = getVal('--currency=') || 'both';
  const rateRaw = Number(getVal('--rate='));
  const usdToCny = Number.isFinite(rateRaw) && rateRaw > 0 ? rateRaw : 7;
  const theme = getVal('--theme=') === 'dark' ? 'dark' : 'paper';
  const svgPath = getVal('--svg=') || null;
  const hideProjects = flags.includes('--hide-projects');

  let receipt = null;
  try {
    const qs = new URLSearchParams({ scope, groupBy });
    if (date) qs.set('date', date);
    if (tool) qs.set('tool', tool);
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/receipt?${qs.toString()}`, {
      signal: AbortSignal.timeout(2500),
    });
    if (res.ok) receipt = await res.json();
  } catch {}

  if (!receipt) {
    const { TurnStore } = await import('../src/store.mjs');
    const store = new TurnStore();
    try {
      receipt = store.getReceiptData({ date, scope, tool, groupBy });
    } finally {
      store.close();
    }
  }

  const { renderReceiptAscii, renderReceiptSvg } = await import('../src/receipt.mjs');
  if (svgPath) {
    const svg = renderReceiptSvg(receipt, { theme, currency, usdToCny, hideProjects });
    writeFileSync(svgPath, svg, 'utf8');
    if (!jsonMode) {
      console.log(`已导出热敏小票 SVG: ${svgPath}`);
    }
  }

  if (jsonMode) {
    console.log(JSON.stringify({ receipt, svgPath }));
    return;
  }
  console.log(renderReceiptAscii(receipt, { currency, usdToCny, hideProjects }));
}

async function cmdFingerprint(flags, jsonMode = false) {
  const getVal = (prefix) => {
    const f = flags.find((a) => a.startsWith(prefix));
    return f ? f.slice(prefix.length).trim() : '';
  };
  const mode = getVal('--mode=') || 'passive';
  const target = getVal('--target=') || 'codex';
  const days = Math.max(1, Number(getVal('--days=')) || 7);
  const sampleCount = Math.max(10, Number(getVal('--samples=')) || 50);
  const recordBaseline = flags.includes('--record-baseline');
  const baselineName = getVal('--baseline-name=') || null;
  const baselineId = getVal('--baseline-id=') || null;
  const model = getVal('--model=') || null;

  let out = null;
  try {
    const token = readDaemonToken();
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/fingerprint/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { [AUTH_TOKEN_HEADER]: token } : {}),
      },
      body: JSON.stringify({
        mode,
        target,
        days,
        sampleCount,
        recordBaseline,
        baselineName,
        baselineId,
        model,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (res.ok) out = await res.json();
  } catch {}

  if (!out) {
    const { TurnStore } = await import('../src/store.mjs');
    const {
      analyzePassiveTelemetry,
      probeCodexProtocol,
      runQuickCapabilityProbes,
      runTokenDistributionFingerprint,
    } = await import('../src/fingerprint.mjs');
    const store = new TurnStore();
    try {
      if (mode === 'passive') {
        const passive = analyzePassiveTelemetry(store, { days });
        out = { ok: true, mode, passive };
      } else if (mode === 'codex_protocol' || mode === 'protocol') {
        const run = await probeCodexProtocol({ modelOverride: model });
        out = { ok: run.ok, mode: 'codex_protocol', run: store.saveFingerprintRun(run) };
      } else if (mode === 'quick') {
        const run = await runQuickCapabilityProbes({
          targetType: 'codex',
          endpointConfig: model ? { model } : undefined,
        });
        out = { ok: run.ok, mode: 'quick', run: store.saveFingerprintRun(run) };
      } else if (mode === 'deep') {
        const run = await runTokenDistributionFingerprint({
          targetType: 'codex',
          endpointConfig: model ? { model } : undefined,
          sampleCount,
          recordBaseline,
          baselineName,
          baselineId,
          store,
        });
        out = { ok: run.ok, mode: 'deep', run: store.saveFingerprintRun(run) };
      } else {
        out = { ok: false, error: `离线模式暂不支持 ${mode}` };
      }
    } finally {
      store.close();
    }
  }

  if (jsonMode) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (out.passive) {
    const p = out.passive;
    console.log(`模型降智被动诊断（近 ${p.days} 天 · 扫描 ${p.totalTurnsScanned} 轮 · 状态: ${p.overallStatus}）`);
    for (const info of Object.values(p.byTool || {})) {
      console.log(
        `- ${info.toolLabel.padEnd(11)} [${info.status}]  ${info.turnCount} 轮 | 异常 ${info.anomalyCount} 条${info.latestModel ? ` | 最新模型: ${info.latestModel}` : ''}`
      );
    }
    if (Array.isArray(p.anomalies) && p.anomalies.length > 0) {
      console.log('\n可疑轮次:');
      for (const a of p.anomalies.slice(0, 10)) {
        console.log(`  ! [${a.toolLabel}/${a.model}] ${a.title} — ${a.detail}`);
      }
    }
    return;
  }

  const r = out.run;
  if (!r) {
    console.error(out.error || '检测执行失败');
    process.exit(1);
  }
  console.log(`[${r.mode}] ${r.targetName} | 结论: ${r.verdict}${r.score !== null && r.score !== undefined ? ` (${r.score}/100)` : ''}`);
  console.log(`摘要: ${r.summary}`);
  if (Array.isArray(r.details?.probes)) {
    for (const p of r.details.probes) {
      console.log(`  - [${p.passed ? 'PASS' : 'FAIL'}] ${p.name}: ${p.reason}`);
    }
  }
  if (r.jsDistance !== null && r.jsDistance !== undefined) {
    console.log(`JS 散度: ${r.jsDistance} (基线: ${r.details?.baselineName || '无'})`);
  }
}

function cmdSshInfo(host = '<remote-host>', jsonMode = false) {
  const remoteHooks = buildRemoteHooksConfig(PORT);
  const oneLiner = buildRemoteSshOneLiner(host, { port: PORT });
  if (jsonMode) {
    console.log(JSON.stringify({ host, port: PORT, remoteHooks, oneLiner }));
    return;
  }
  console.log(`1) Add to Mac ~/.ssh/config under Host ${host}:`);
  console.log(`   RemoteForward ${PORT} 127.0.0.1:${PORT}`);
  console.log('   ExitOnForwardFailure no');
  console.log('');
  console.log(`2) Write ~/.cursor/hooks.json on remote host ${host}:`);
  console.log(JSON.stringify(remoteHooks, null, 2));
  console.log('');
  console.log(`3) Or run one-liner on Mac to update remote ~/.cursor/hooks.json:`);
  console.log(`   ${oneLiner}`);
}

function cmdSshApply(host, flags, dryRun = false, jsonMode = false) {
  if (!host) {
    console.error('请提供远端 Host 名称，例如: ai-turn-meter ssh-apply dev-server');
    process.exit(1);
  }
  const localRes = applyLocalSshConfig(host, { port: PORT, dryRun });
  let remoteRes = null;
  if (flags.includes('--remote') && !dryRun) {
    remoteRes = applyRemoteCursorHooks(host, { port: PORT });
  }
  if (jsonMode) {
    console.log(JSON.stringify({ ok: true, local: localRes, remote: remoteRes }));
    return;
  }
  console.log(
    `本机 ~/.ssh/config (${localRes.host}): ${localRes.status === 'already_configured' ? '已包含 RemoteForward，无需重复修改' : `已写入 ${localRes.path}`}`
  );
  if (remoteRes) {
    console.log(`远端 ${remoteRes.host} ~/.cursor/hooks.json: 已自动写入 (${remoteRes.output})`);
  }
}

function cmdAppAutostart(action = 'status', flags = [], dryRun = false, jsonMode = false) {
  const appFlag = flags.find((a) => a.startsWith('--app='));
  const appPath = appFlag ? appFlag.split('=')[1].trim() : null;
  const appExe = appPath ? join(appPath, 'Contents', 'MacOS', 'AITurnMeter') : resolveInstalledAppExe();

  if (action === 'status') {
    const enabled = isAppAutostartEnabled();
    if (jsonMode) console.log(JSON.stringify({ enabled }));
    else console.log(`App autostart: ${enabled ? 'enabled' : 'disabled'}`);
    return;
  }
  const enable = action === 'enable' || action === 'on';
  const res = setAppAutostart(enable, { appExe, dryRun });
  if (jsonMode) {
    console.log(JSON.stringify({ ok: true, ...res }));
  } else {
    console.log(`App autostart ${res.enabled ? 'enabled' : 'disabled'} (${res.plistPath})`);
  }
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
} else if (cmd === 'cost') {
  await cmdCost(flags, jsonMode);
} else if (cmd === 'receipt') {
  await cmdReceipt(flags, jsonMode);
} else if (cmd === 'fingerprint') {
  await cmdFingerprint(flags, jsonMode);
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
} else if (cmd === 'app-autostart') {
  const idx = argv.indexOf('app-autostart');
  const action = argv[idx + 1] && !argv[idx + 1].startsWith('-') ? argv[idx + 1] : 'status';
  cmdAppAutostart(action, flags, dryRun, jsonMode);
} else if (cmd === 'open') {
  const target = argv[argv.indexOf('open') + 1];
  await cmdOpen(target);
} else if (cmd === 'ssh-info') {
  const idx = argv.indexOf('ssh-info');
  const host = argv[idx + 1] && !argv[idx + 1].startsWith('-') ? argv[idx + 1] : undefined;
  cmdSshInfo(host, jsonMode);
} else if (cmd === 'ssh-apply') {
  const idx = argv.indexOf('ssh-apply');
  const host = argv[idx + 1] && !argv[idx + 1].startsWith('-') ? argv[idx + 1] : undefined;
  cmdSshApply(host, flags, dryRun, jsonMode);
} else if (cmd === 'daemon') {
  await cmdDaemon(flags);
} else {
  printHelp();
  process.exit(1);
}
