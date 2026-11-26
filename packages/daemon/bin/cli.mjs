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
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { AUTH_TOKEN_HEADER, defaultTokenPath, readDaemonToken } from '../src/auth.mjs';
import { normalizeProxyUrl, resolveClaudeProxyConfig } from '../src/net.mjs';
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

function readLocalPublicConfig() {
  const toolKeys = ['antigravity', 'codex', 'claude', 'cursor', 'codebuddy'];
  const defaultProxy = resolveClaudeProxyConfig({});
  const defaults = {
    enabled: true,
    tools: { antigravity: true, codex: true, claude: true, cursor: true, codebuddy: true },
    inlineEnabled: true,
    inlineTools: { antigravity: true, codex: true, claude: true, cursor: true, codebuddy: true },
    hasCursorCookie: false,
    hasClaudeCookie: false,
    claudeProxyUrl: null,
    effectiveClaudeProxyUrl: defaultProxy.proxyUrl || null,
    claudeProxySource: defaultProxy.source,
    claudeQuotaEnabled: false,
  };
  try {
    const cfgPath = join(dirname(defaultTokenPath()), 'config.json');
    if (!existsSync(cfgPath)) return defaults;
    const raw = JSON.parse(readFileSync(cfgPath, 'utf8'));
    const tools = { ...defaults.tools };
    const inlineTools = { ...defaults.inlineTools };
    for (const k of toolKeys) {
      if (typeof raw?.tools?.[k] === 'boolean') tools[k] = raw.tools[k];
      if (typeof raw?.inlineTools?.[k] === 'boolean') inlineTools[k] = raw.inlineTools[k];
    }
    if (raw?.tools && typeof raw.tools === 'object') {
      for (const [k, v] of Object.entries(raw.tools)) {
        if (typeof k === 'string' && k.startsWith('ext:') && typeof v === 'boolean') {
          tools[k] = v;
        }
      }
    }
    const cookie = typeof raw?.cursorCookie === 'string' ? raw.cursorCookie.trim() : '';
    const claudeCookie = typeof raw?.claudeCookie === 'string' ? raw.claudeCookie.trim() : '';
    const claudeProxyUrl = normalizeProxyUrl(raw?.claudeProxyUrl);
    const claudeProxy = resolveClaudeProxyConfig({ claudeProxyUrl });
    return {
      enabled: typeof raw?.enabled === 'boolean' ? raw.enabled : true,
      tools,
      inlineEnabled: typeof raw?.inlineEnabled === 'boolean' ? raw.inlineEnabled : true,
      inlineTools,
      hasCursorCookie: Boolean(cookie),
      hasClaudeCookie: Boolean(claudeCookie),
      claudeProxyUrl: claudeProxyUrl || null,
      effectiveClaudeProxyUrl: claudeProxy.proxyUrl || null,
      claudeProxySource: claudeProxy.source,
      claudeQuotaEnabled: raw?.claudeQuotaEnabled === true,
    };
  } catch {
    return defaults;
  }
}

function printHelp() {
  console.log(`ai-turn-meter v${getPkgVersion()}

Usage:
  ai-turn-meter [status]                查看后台守护进程、CDP 与 4 家最近一轮指标
  ai-turn-meter providers [import|remove] 管理本地外部数据源插件（列表、导入 .mjs 或移除）
  ai-turn-meter cost [--days=7]         查看今日/本周/历史 Token 用量与 API 等效费用估算
  ai-turn-meter receipt [--date=...]    打印超市小票风每日账单（支持 --scope=day|week|month --group=model|tool|project --currency=both|usd|cny --rate=7 --svg=out.svg）
  ai-turn-meter fingerprint [--mode=.]  运行模型指纹与降智检测（one_click|passive|codex_protocol|manual_score|quick|deep，支持 --target=codex|<id> --record-baseline）
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

  let providersMeta = null;
  if (online) {
    try {
      const pRes = await fetch(`http://127.0.0.1:${PORT}/v1/providers`, { signal: AbortSignal.timeout(1500) });
      if (pRes.ok) providersMeta = await pRes.json();
    } catch {}
  }

  if (jsonMode) {
    const config = state?.config || readLocalPublicConfig();
    console.log(
      JSON.stringify({
        version: getPkgVersion(),
        port: PORT,
        online,
        config,
        apps,
        externalProviders: online ? (providersMeta?.providers || []) : null,
        providersDir: providersMeta?.providersDir || null,
        state,
      })
    );
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
      : APP_SPECS[key]?.supportsCdp === false
        ? '免CDP'
        : app.cdpPort
          ? `CDP:${app.cdpPort}`
          : key === 'antigravity'
            ? 'CDP未检测到'
            : 'CDP未启用';
    const t = app.latestTurn;
    console.log(`- ${key.padEnd(11)} [${cdpLabel}]  ${t ? `${t.model} | ${t.inlineText}` : '暂无记录'}`);
  }
}

export function formatDoctorReport(report, cliVersion = getPkgVersion()) {
  const mark = (ok) => (ok ? 'OK  ' : 'FAIL');
  const resolvedCliVersion = report.cliVersion || cliVersion;
  const lines = [];
  lines.push(`AI Turn Meter v${resolvedCliVersion} Doctor`);
  lines.push(`- [${mark(report.node.ok)}] Node.js v${report.node.version} (node:sqlite=${report.node.sqlite})`);

  const daemonVersion = report.daemon?.version || null;
  const daemonMismatch = Boolean(
    report.daemon?.ok &&
      (report.daemonVersionMismatch ?? daemonVersion !== resolvedCliVersion)
  );
  const daemonMark = !report.daemon?.ok ? 'FAIL' : daemonMismatch ? 'WARN' : 'OK  ';
  const daemonDetail = report.daemon?.pid
    ? ` (pid ${report.daemon.pid}${daemonVersion ? `, v${daemonVersion}` : ''})`
    : daemonVersion
      ? ` (v${daemonVersion})`
      : '';
  const daemonWarnSuffix = daemonMismatch
    ? ` [版本不一致: CLI v${resolvedCliVersion}，请运行 ai-turn-meter install 更新]`
    : '';
  lines.push(
    `- [${daemonMark}] Daemon http://127.0.0.1:${report.daemon.port}${daemonDetail}${daemonWarnSuffix}`
  );

  const laReady = Boolean(report.launchAgent?.plistExists && report.launchAgent?.launchAgentLoaded);
  const laRootDrift = Boolean(
    laReady && !report.launchAgent?.pointsToCurrentRoot && !report.launchAgent?.managedByApp
  );
  const laMark = !laReady ? 'FAIL' : laRootDrift ? 'WARN' : 'OK  ';
  const laWarnSuffix = laRootDrift
    ? ` [指向其他路径: ${report.launchAgent.programDaemonPath || 'unknown'}，非当前 ${report.packageRoot || ''}]`
    : '';
  lines.push(`- [${laMark}] LaunchAgent (${report.launchAgent.plistPath})${laWarnSuffix}`);

  lines.push(
    `- [${mark(report.cursorHooks.validVersion && report.cursorHooks.configured)}] Cursor Hooks (${report.cursorHooks.path}, versionOk=${report.cursorHooks.validVersion})`
  );
  for (const [key, app] of Object.entries(report.apps || {})) {
    const parts = [app.installed ? app.appPath : '未安装'];
    let appMark = app.installed ? 'INFO' : 'SKIP';
    if (app.installed) {
      parts.push(
        APP_SPECS[key]?.supportsCdp === false
          ? '免CDP'
          : app.cdpPort
            ? `CDP:${app.cdpPort}`
            : 'CDP未启用'
      );
      if (key === 'cursor' || key === 'codebuddy') {
        const vsixMismatch = Boolean(
          app.vsixVersionMismatch ?? (app.vsixVersion && app.vsixVersion !== resolvedCliVersion)
        );
        if (vsixMismatch) {
          appMark = 'WARN';
          parts.push(`VSIX:${app.vsixVersion} (CLI:${resolvedCliVersion}，请运行 ai-turn-meter install 更新)`);
        } else {
          parts.push(app.vsixVersion ? `VSIX:${app.vsixVersion}` : 'VSIX未安装');
        }
      }
    }
    lines.push(`- [${appMark}] ${key.padEnd(11)} ${parts.join(' | ')}`);
  }
  return lines;
}

async function cmdDoctor(jsonMode = false) {
  const report = await runDoctor({ port: PORT });
  if (jsonMode) {
    console.log(JSON.stringify({ version: report.cliVersion || getPkgVersion(), ...report }));
    return;
  }
  for (const line of formatDoctorReport(report)) {
    console.log(line);
  }
}

export function buildCleanLaunchEnv(baseEnv = process.env) {
  const env = { ...baseEnv };
  delete env.AI_TURN_METER_STABLE_ROOT;
  delete env.AI_TURN_METER_NODE_BIN;
  delete env.AI_TURN_METER_MANAGED_BY;
  return env;
}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function openSingleApp(
  target,
  {
    exitOnError = true,
    execFileSyncFn = execFileSync,
    resolveAppPathsFn = resolveAppPaths,
    readActivePortFn = readActivePort,
    isCdpHttpReadyFn = isCdpHttpReady,
    readRunningProcessArgsFn = readRunningProcessArgs,
    isAppRunningFn = isAppRunning,
    hasAppHelpersRunningFn = hasAppHelpersRunning,
    isPortListeningFn = isPortListening,
    sleepFn = sleepMs,
    baseEnv = process.env,
  } = {}
) {
  const fail = (message) => {
    console.error(message);
    if (exitOnError) process.exit(1);
    return false;
  };

  const baseSpec = APP_SPECS[target];
  if (!baseSpec) {
    return fail(`Unknown app "${target}". Choose: codex | claude | cursor | codebuddy | antigravity | all`);
  }
  const spec = resolveAppPathsFn(baseSpec);
  if (!spec.installed || !spec.appPath) {
    return fail(`Not installed: ${spec.bundleName}`);
  }
  const launchEnv = buildCleanLaunchEnv(baseEnv);
  if (spec.supportsCdp === false) {
    execFileSyncFn('open', ['-a', spec.appPath], { env: launchEnv });
    console.log(
      `Opened ${spec.name} (official ${spec.bundleName} disables --remote-debugging-port; quota syncs without CDP)`
    );
    return true;
  }
  const activePort = readActivePortFn(spec);
  if (activePort && (await isCdpHttpReadyFn(activePort))) {
    execFileSyncFn('open', ['-a', spec.appPath], { env: launchEnv });
    console.log(`Focused ${spec.name}`);
    return true;
  }

  // Capture existing launch flags (e.g. --mute-audio) before quitting so guards or user switches survive restart.
  const preservedArgs = readRunningProcessArgsFn(spec);
  let running = isAppRunningFn(spec);

  if (running) {
    let quitErr = '';
    try {
      execFileSyncFn('osascript', ['-e', `tell application "${spec.name}" to quit`], {
        encoding: 'utf8',
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (e) {
      quitErr = String(e?.stderr || e?.message || '').trim();
    }
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (!isAppRunningFn(spec)) {
        running = false;
        break;
      }
      await sleepFn(250);
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
    while (Date.now() < helperDeadline && hasAppHelpersRunningFn(spec)) {
      await sleepFn(150);
    }
    await sleepFn(250);
  }

  const launchArgs = [...preservedArgs, `--remote-debugging-port=${spec.port}`];
  execFileSyncFn('open', ['-na', spec.appPath, '--args', ...launchArgs], {
    stdio: 'ignore',
    env: launchEnv,
  });

  const cdpDeadline = Date.now() + 10000;
  let ready = false;
  while (Date.now() < cdpDeadline) {
    if (isPortListeningFn(spec.port) && (await isCdpHttpReadyFn(spec.port))) {
      ready = true;
      break;
    }
    await sleepFn(250);
  }
  if (ready) {
    // Re-check after 1.6s so a background watchdog relaunch that drops `--remote-debugging-port` is caught honestly.
    await sleepFn(1600);
    ready = isPortListeningFn(spec.port) && (await isCdpHttpReadyFn(spec.port));
  }
  if (!ready) {
    const postArgs = readRunningProcessArgsFn(spec);
    const detail = isAppRunningFn(spec)
      ? `${spec.name} 启动后调试口 ${spec.port} 未保持开启（当前进程参数：${postArgs.join(' ') || '无'}，可能被其他守护脚本重启覆盖）`
      : `${spec.name} 未能开启调试口 ${spec.port}`;
    return fail(detail);
  }

  console.log(`Launched ${spec.name} with CDP on 127.0.0.1:${spec.port}`);
  return true;
}

async function cmdOpen(target) {
  if (target === 'all') {
    const cfg = readLocalPublicConfig();
    let allOk = true;
    for (const k of ['antigravity', 'codex', 'cursor', 'codebuddy']) {
      if (cfg.tools?.[k] === false) continue;
      if (APP_SPECS[k]?.supportsCdp === false) continue;
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
      const localCfg = readLocalPublicConfig();
      const quotasByTool = await getAllQuotas(Date.now(), {
        claudeProxyUrl: localCfg.claudeProxyUrl,
        claudeQuotaEnabled: localCfg.claudeQuotaEnabled === true,
      }).catch(() => null);
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

export function formatFingerprintOutput(out) {
  const lines = [];
  if (out?.passive) {
    const p = out.passive;
    lines.push(`模型降智被动诊断（近 ${p.days} 天 · 扫描 ${p.totalTurnsScanned} 轮 · 状态: ${p.overallStatus}）`);
    for (const info of Object.values(p.byTool || {})) {
      lines.push(
        `- ${info.toolLabel.padEnd(11)} [${info.status}]  ${info.turnCount} 轮 | 异常 ${info.anomalyCount} 条${info.latestModel ? ` | 最新模型: ${info.latestModel}` : ''}`
      );
    }
    if (Array.isArray(p.anomalies) && p.anomalies.length > 0) {
      lines.push('\n可疑轮次:');
      for (const a of p.anomalies.slice(0, 10)) {
        lines.push(`  ! [${a.toolLabel}/${a.model}] ${a.title} — ${a.detail}`);
      }
    }
  }

  if (out?.codexProto) {
    const cp = out.codexProto;
    if (lines.length > 0) lines.push('');
    lines.push(
      `Codex 路由核验: ${cp.verdict || (cp.ok ? 'healthy' : 'error')}${cp.responseModel ? ` (模型: ${cp.responseModel})` : ''}`
    );
    if (cp.summary) {
      lines.push(`  摘要: ${cp.summary}`);
    }
  }

  const r = out?.run;
  const shouldPrintRun = Boolean(
    r && (!out?.passive || out?.mode === 'one_click' || r.mode === 'one_click' || out?.codexProto)
  );
  if (shouldPrintRun) {
    if (lines.length > 0) lines.push('');
    lines.push(
      `[${r.mode}] ${r.targetName} | 结论: ${r.verdict}${r.score !== null && r.score !== undefined ? ` (${r.score}/100)` : ''}`
    );
    lines.push(`摘要: ${r.summary}`);
    if (Array.isArray(r.details?.probes)) {
      for (const p of r.details.probes) {
        lines.push(`  - [${p.passed ? 'PASS' : 'FAIL'}] ${p.name}: ${p.reason}`);
      }
    }
    if (r.jsDistance !== null && r.jsDistance !== undefined) {
      lines.push(`JS 散度: ${r.jsDistance} (基线: ${r.details?.baselineName || '无'})`);
    }
  }

  return lines;
}

async function cmdFingerprint(flags, jsonMode = false) {
  const getVal = (prefix) => {
    const f = flags.find((a) => a.startsWith(prefix));
    return f ? f.slice(prefix.length).trim() : '';
  };
  const mode = getVal('--mode=') || 'passive';
  const target = getVal('--target=') || 'codex';
  const tool = getVal('--tool=') || null;
  const replyText = getVal('--reply=') || null;
  const days = Math.max(1, Number(getVal('--days=')) || 7);
  const sampleCount = Math.max(10, Number(getVal('--samples=')) || 50);
  const recordBaseline = flags.includes('--record-baseline');
  const baselineName = getVal('--baseline-name=') || null;
  const baselineId = getVal('--baseline-id=') || null;
  const model = getVal('--model=') || null;

  let out = null;
  let daemonHttpError = null;
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
        ...(tool ? { tool } : {}),
        ...(replyText ? { replyText } : {}),
        days,
        sampleCount,
        recordBaseline,
        baselineName,
        baselineId,
        model,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    let data = null;
    try {
      data = await res.json();
    } catch {}
    if (res.ok) {
      out = data;
    } else {
      daemonHttpError = {
        status: res.status,
        error: data?.error || `Daemon 返回 HTTP ${res.status}`,
      };
    }
  } catch {
    // Connection error (e.g. ECONNREFUSED / daemon offline): fall back to offline execution below
  }

  if (daemonHttpError) {
    if (jsonMode) {
      console.log(
        JSON.stringify({ ok: false, status: daemonHttpError.status, error: daemonHttpError.error }, null, 2)
      );
    } else {
      console.error(`Daemon 检测请求失败 (HTTP ${daemonHttpError.status}): ${daemonHttpError.error}`);
    }
    process.exit(1);
  }

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
        if (target !== 'codex') {
          out = { ok: false, error: `离线模式暂不支持自定义端点 target=${target}，请先启动守护进程` };
        } else {
          const run = await runQuickCapabilityProbes({
            targetType: 'codex',
            endpointConfig: model ? { model } : undefined,
          });
          out = { ok: run.ok, mode: 'quick', run: store.saveFingerprintRun(run) };
        }
      } else if (mode === 'deep') {
        if (target !== 'codex') {
          out = { ok: false, error: `离线模式暂不支持自定义端点 target=${target}，请先启动守护进程` };
        } else {
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
        }
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

  const lines = formatFingerprintOutput(out);
  if (lines.length === 0) {
    console.error(out?.error || '检测执行失败');
    process.exit(1);
  }
  for (const line of lines) {
    console.log(line);
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

export const APP_AUTOSTART_USAGE =
  'Usage: ai-turn-meter app-autostart <enable|disable|status> (also accepts on|true or off|false)';

export function parseAppAutostartAction(action) {
  const normalized = String(action ?? '').trim().toLowerCase();
  if (!normalized || normalized === 'status') {
    return { kind: 'status' };
  }
  if (normalized === 'enable' || normalized === 'on' || normalized === 'true') {
    return { kind: 'set', enabled: true };
  }
  if (normalized === 'disable' || normalized === 'off' || normalized === 'false') {
    return { kind: 'set', enabled: false };
  }
  return { kind: 'invalid', action: String(action) };
}

function cmdAppAutostart(action = 'status', flags = [], dryRun = false, jsonMode = false) {
  const fail = (message) => {
    if (jsonMode) {
      console.log(JSON.stringify({ ok: false, error: message, usage: APP_AUTOSTART_USAGE }));
    } else {
      console.error(message);
      console.error(APP_AUTOSTART_USAGE);
    }
    process.exit(1);
  };

  const parsed = parseAppAutostartAction(action);
  if (parsed.kind === 'invalid') {
    return fail(`Invalid app-autostart action "${parsed.action}".`);
  }

  const appFlag = flags.find((a) => a.startsWith('--app='));
  const appPath = appFlag ? appFlag.split('=')[1].trim() : null;
  const appExe = appPath ? join(appPath, 'Contents', 'MacOS', 'AITurnMeter') : resolveInstalledAppExe();

  if (parsed.kind === 'status') {
    const enabled = isAppAutostartEnabled();
    if (jsonMode) console.log(JSON.stringify({ enabled }));
    else console.log(`App autostart: ${enabled ? 'enabled' : 'disabled'}`);
    return;
  }
  const res = setAppAutostart(parsed.enabled, { appExe, dryRun });
  if (jsonMode) {
    console.log(JSON.stringify({ ok: true, ...res }));
  } else {
    console.log(`App autostart ${res.enabled ? 'enabled' : 'disabled'} (${res.plistPath})`);
  }
}

async function cmdProviders(args = [], flags = [], jsonMode = false) {
  const sub = args[0] || 'list';

  if (sub === 'import') {
    const srcPath = args[1];
    if (!srcPath) {
      console.error('Usage: ai-turn-meter providers import <path-to-plugin.mjs>');
      process.exit(1);
    }
    const content = readFileSync(srcPath, 'utf8');
    const fileName = basename(srcPath);
    const token = readDaemonToken();
    let result = null;
    let daemonError = null;
    if (token) {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/v1/providers/import`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', [AUTH_TOKEN_HEADER]: token },
          body: JSON.stringify({ fileName, content }),
          signal: AbortSignal.timeout(10_000),
        });
        if (res.status !== 404) {
          let data = null;
          try {
            data = await res.json();
          } catch {}
          if (!res.ok || data?.ok === false) {
            daemonError = { status: res.status, error: data?.error || `导入失败 (HTTP ${res.status})` };
          } else {
            result = data;
          }
        }
      } catch {}
    }
    if (daemonError) {
      if (jsonMode) {
        console.log(JSON.stringify({ ok: false, status: daemonError.status, error: daemonError.error }, null, 2));
      } else {
        console.error(daemonError.error);
      }
      process.exit(1);
    }
    if (!result) {
      const { ExternalProviderRegistry } = await import('../src/external-providers.mjs');
      const reg = new ExternalProviderRegistry();
      try {
        const imp = await reg.importPluginSource({ fileName, content });
        result = { ok: true, imported: imp.meta, providersDir: reg.providersDir };
      } catch (err) {
        console.error(err?.message || '导入失败');
        process.exit(1);
      }
    }
    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`已导入外部插件: ${result.imported.name} (${result.imported.key}) -> ${result.imported.filePath}`);
    }
    return;
  }

  if (sub === 'remove' || sub === 'rm' || sub === 'delete') {
    const target = args[1];
    if (!target) {
      console.error('Usage: ai-turn-meter providers remove <fileName.mjs|ext:id>');
      process.exit(1);
    }
    const qs = target.startsWith('ext:')
      ? `key=${encodeURIComponent(target)}`
      : `fileName=${encodeURIComponent(target)}`;
    const token = readDaemonToken();
    let result = null;
    let daemonError = null;
    if (token) {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/v1/providers?${qs}`, {
          method: 'DELETE',
          headers: { [AUTH_TOKEN_HEADER]: token },
          signal: AbortSignal.timeout(6_000),
        });
        if (res.status !== 404) {
          let data = null;
          try {
            data = await res.json();
          } catch {}
          if (!res.ok || data?.ok === false) {
            daemonError = { status: res.status, error: data?.error || `移除插件失败 (HTTP ${res.status})` };
          } else {
            result = data;
          }
        }
      } catch {}
    }
    if (daemonError) {
      if (jsonMode) {
        console.log(JSON.stringify({ ok: false, status: daemonError.status, error: daemonError.error }, null, 2));
      } else {
        console.error(`移除插件失败 (HTTP ${daemonError.status}): ${daemonError.error}`);
      }
      process.exit(1);
    }
    if (!result) {
      const { ExternalProviderRegistry } = await import('../src/external-providers.mjs');
      const reg = new ExternalProviderRegistry();
      const rmRes = await reg.removePlugin(target.startsWith('ext:') ? { key: target } : { fileName: target });
      result = { ok: true, ...rmRes };
    }
    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.deleted) {
      console.log(`已移除插件: ${result.fileName || target}`);
    } else {
      console.error(`未找到插件: ${target}`);
      process.exit(1);
    }
    return;
  }

  const refresh = flags.includes('--refresh');
  let payload = null;
  try {
    const qs = refresh ? '?refresh=1' : '';
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/providers${qs}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      payload = await res.json();
    }
  } catch {}

  if (!payload) {
    const { ExternalProviderRegistry } = await import('../src/external-providers.mjs');
    const reg = new ExternalProviderRegistry();
    const out = await reg.fetchAll({ forceRefresh: refresh });
    payload = { providersDir: out.providersDir, providers: out.providers, cards: out.cards };
  }

  if (jsonMode) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`External providers directory: ${payload.providersDir}`);
  const list = Array.isArray(payload.providers) ? payload.providers : [];
  if (list.length === 0) {
    console.log('未发现外部数据源插件（可执行 ai-turn-meter providers import <file.mjs> 导入）');
    return;
  }
  for (const p of list) {
    const status = !p.enabled ? 'DISABLED' : p.ok ? 'OK' : `ERR: ${p.error || 'unknown'}`;
    console.log(`- ${p.key.padEnd(20)} ${p.name} [${p.currency || 'USD'}] (${status})  ${p.fileName}`);
  }
}

async function cmdDaemon(flags) {
  const portFlag = flags.find((a) => a.startsWith('--port='));
  const port = portFlag ? Number(portFlag.split('=')[1]) : PORT;
  const ts = () => new Date().toISOString();
  const { createMeterServer } = await import('../src/server.mjs');
  const meter = createMeterServer({ port });

  let fatalHandled = false;
  const handleServerError = (err) => {
    if (fatalHandled) return;
    fatalHandled = true;
    if (err?.code === 'EADDRINUSE') {
      console.error(
        `[${ts()}] [ai-turn-meter] port 127.0.0.1:${port} is already in use (EADDRINUSE); another daemon may already be running. Exiting.`
      );
    } else {
      console.error(`[${ts()}] [ai-turn-meter] daemon server error: ${err?.message || err}`);
    }
    try {
      meter.store?.close?.();
    } catch {}
    process.exit(1);
  };

  meter.server.on('error', handleServerError);
  try {
    await meter.start();
  } catch (err) {
    handleServerError(err);
    return;
  }
  console.log(`[${ts()}] [ai-turn-meter] daemon listening on http://127.0.0.1:${port} (pid ${process.pid})`);

  let shuttingDown = false;
  const shutdown = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[${ts()}] [ai-turn-meter] received ${sig}, shutting down daemon (pid ${process.pid})...`);
    try {
      await meter.stop();
      console.log(`[${ts()}] [ai-turn-meter] daemon stopped cleanly.`);
      process.exit(0);
    } catch (err) {
      console.error(`[${ts()}] [ai-turn-meter] error during shutdown: ${err?.message || err}`);
      process.exit(1);
    }
  };

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      shutdown(sig);
    });
  }
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]));
  } catch {
    return false;
  }
}

async function main() {
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
  } else if (cmd === 'providers') {
    const pIdx = argv.indexOf('providers');
    const posArgs = argv.slice(pIdx + 1).filter((a) => !a.startsWith('-'));
    await cmdProviders(posArgs, flags, jsonMode);
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
    const posArgs = argv.slice(idx + 1).filter((a) => !a.startsWith('-'));
    const action = posArgs.length > 0 ? posArgs[0] : 'status';
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
}

if (isDirectExecution()) {
  await main();
}
