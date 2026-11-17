import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_SPECS, DEFAULT_DAEMON_PORT, readActivePort, resolveAppPaths } from './apps.mjs';

export const LAUNCH_AGENT_LABEL = 'com.local.ai-turn-meter.daemon';
export const VSIX_EXT_ID = 'local-ai-turn-meter.ai-turn-meter';

export const CURSOR_EVENTS = [
  'beforeSubmitPrompt',
  'beforeShellExecution',
  'afterShellExecution',
  'beforeMCPExecution',
  'afterMCPExecution',
  'afterAgentResponse',
  'stop',
];

const LEGACY_APPS = [
  'AI Turn Meter.app',
  'Codex (Meter).app',
  'Cursor (Meter).app',
  'CodeBuddy CN (Meter).app',
];

/**
 * Resolve runtime package root. Prefers stable Homebrew opt_libexec when provided
 * so LaunchAgent and Cursor hooks survive patch upgrades across Cellar versions.
 */
export function resolvePackageRoot() {
  const fromFile = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const stable = process.env.AI_TURN_METER_STABLE_ROOT;
  if (stable && existsSync(join(stable, 'packages', 'daemon', 'bin', 'daemon.mjs'))) {
    return stable;
  }
  return fromFile;
}

export function getPackageMeta(root = resolvePackageRoot()) {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    return {
      version: pkg.version || '0.0.0',
      root,
      updateFeedUrl: process.env.AI_TURN_METER_UPDATE_URL || pkg.updateFeedUrl || null,
    };
  } catch {
    return {
      version: '0.0.0',
      root,
      updateFeedUrl: process.env.AI_TURN_METER_UPDATE_URL || null,
    };
  }
}

export function resolveNodeBin() {
  const envNode = process.env.AI_TURN_METER_NODE_BIN;
  if (envNode && existsSync(envNode)) return envNode;
  return process.execPath;
}

function quoteShellArg(arg) {
  return /[\s"'\\$&|;<>()!*?~`]/.test(arg) ? `'${arg.replace(/'/g, `'\\''`)}'` : arg;
}

export function buildHookCommand({ nodeBin = resolveNodeBin(), root = resolvePackageRoot() } = {}) {
  const hookScript = join(root, 'packages', 'daemon', 'bin', 'cursor-hook.mjs');
  return `${quoteShellArg(nodeBin)} ${quoteShellArg(hookScript)}`;
}

/**
 * Verify Node version (>= 22.5, required for built-in `node:sqlite`).
 */
export async function checkNodeRuntime() {
  const version = process.versions.node || '0.0.0';
  const [major = 0, minor = 0] = version.split('.').map(Number);
  const versionOk = major > 22 || (major === 22 && minor >= 5);
  return { ok: versionOk, version, sqlite: versionOk };
}

function defaultLog(dryRun) {
  return (msg) => console.log(`${dryRun ? '[dry-run] ' : ''}${msg}`);
}

export function patchCursorHooks({
  dryRun = false,
  homeDir = homedir(),
  hookCmd = buildHookCommand(),
  log = defaultLog(dryRun),
} = {}) {
  const hooksPath = join(homeDir, '.cursor', 'hooks.json');
  let raw = {};
  if (existsSync(hooksPath)) {
    raw = JSON.parse(readFileSync(hooksPath, 'utf8'));
    if (!dryRun) {
      copyFileSync(hooksPath, `${hooksPath}.bak-ai-turn-meter`);
    }
  }
  const hooks = raw.hooks && typeof raw.hooks === 'object' ? { ...raw.hooks } : {};

  for (const ev of CURSOR_EVENTS) {
    const existing = Array.isArray(hooks[ev]) ? hooks[ev] : [];
    const filtered = existing.filter(
      (item) => !(typeof item?.command === 'string' && item.command.includes('cursor-hook.mjs'))
    );
    filtered.push({ command: hookCmd });
    hooks[ev] = filtered;
  }

  const version = typeof raw.version === 'number' ? raw.version : 1;
  const config = { version, ...raw, hooks };

  log(`Update Cursor hooks: ${hooksPath}`);
  if (!dryRun) {
    mkdirSync(dirname(hooksPath), { recursive: true });
    writeFileSync(hooksPath, `${JSON.stringify(config, null, 2)}\n`);
  }
  return hooksPath;
}

export function cleanCursorHooks({
  dryRun = false,
  homeDir = homedir(),
  log = defaultLog(dryRun),
} = {}) {
  const hooksPath = join(homeDir, '.cursor', 'hooks.json');
  if (!existsSync(hooksPath)) return false;
  const cfg = JSON.parse(readFileSync(hooksPath, 'utf8'));
  if (!cfg.hooks || typeof cfg.hooks !== 'object') return false;
  for (const [k, arr] of Object.entries(cfg.hooks)) {
    if (Array.isArray(arr)) {
      cfg.hooks[k] = arr.filter(
        (item) => !(typeof item?.command === 'string' && item.command.includes('cursor-hook.mjs'))
      );
    }
  }
  log(`Clean Cursor hooks: ${hooksPath}`);
  if (!dryRun) {
    writeFileSync(hooksPath, `${JSON.stringify(cfg, null, 2)}\n`);
  }
  return true;
}

export function installVsix({
  dryRun = false,
  root = resolvePackageRoot(),
  homeDir = homedir(),
  log = defaultLog(dryRun),
} = {}) {
  const vsixPath = join(root, 'dist', 'ai-turn-meter.vsix');
  if (!existsSync(vsixPath)) {
    throw new Error(`Missing ${vsixPath}. Run "npm run package:vsix" first.`);
  }
  for (const key of ['cursor', 'codebuddy']) {
    const app = resolveAppPaths(APP_SPECS[key], { homeDir });
    if (!app.cliPath) {
      log(`Skip ${app.name} (CLI not found in /Applications or ~/Applications)`);
      continue;
    }
    log(`Install VSIX into ${app.name}: ${app.cliPath} --install-extension ${vsixPath} --force`);
    if (!dryRun) {
      execFileSync(app.cliPath, ['--install-extension', vsixPath, '--force'], { stdio: 'inherit' });
    }
  }
}

export function uninstallVsix({
  dryRun = false,
  homeDir = homedir(),
  log = defaultLog(dryRun),
} = {}) {
  for (const key of ['cursor', 'codebuddy']) {
    const app = resolveAppPaths(APP_SPECS[key], { homeDir });
    if (!app.cliPath) continue;
    log(`Uninstall VSIX from ${app.name}`);
    if (!dryRun) {
      try {
        execFileSync(app.cliPath, ['--uninstall-extension', VSIX_EXT_ID], { stdio: 'inherit' });
      } catch {
        // Ignore if not installed
      }
    }
  }
}

export function removeLegacyApps({
  dryRun = false,
  homeDir = homedir(),
  log = defaultLog(dryRun),
} = {}) {
  if (!dryRun) {
    try {
      execFileSync('pkill', ['-f', 'AITurnMeterBar'], { stdio: 'ignore' });
    } catch {}
  }
  for (const name of LEGACY_APPS) {
    const p = join(homeDir, 'Applications', name);
    if (!existsSync(p)) continue;
    // Never delete a newly installed standalone AI Turn Meter.app in ~/Applications
    if (name === 'AI Turn Meter.app' && !existsSync(join(p, 'Contents', 'MacOS', 'AITurnMeterBar'))) {
      continue;
    }
    log(`Remove legacy app: ${p}`);
    if (!dryRun) rmSync(p, { recursive: true, force: true });
  }
}

export function installCliLink({
  dryRun = false,
  root = resolvePackageRoot(),
  nodeBin = resolveNodeBin(),
  homeDir = homedir(),
  log = defaultLog(dryRun),
} = {}) {
  if (process.env.AI_TURN_METER_MANAGED_BY === 'homebrew') {
    log('Skip ~/.local/bin symlink (managed by Homebrew)');
    return null;
  }
  const cliSrc = join(root, 'packages', 'daemon', 'bin', 'cli.mjs');
  const cliDst = join(homeDir, '.local', 'bin', 'ai-turn-meter');
  if (process.env.AI_TURN_METER_STABLE_ROOT && process.env.AI_TURN_METER_NODE_BIN) {
    log(`Write CLI wrapper: ${cliDst}`);
    if (!dryRun) {
      mkdirSync(dirname(cliDst), { recursive: true });
      rmSync(cliDst, { force: true });
      const wrapper = `#!/bin/sh
export AI_TURN_METER_NODE_BIN=${quoteShellArg(nodeBin)}
export AI_TURN_METER_STABLE_ROOT=${quoteShellArg(root)}
exec ${quoteShellArg(nodeBin)} ${quoteShellArg(cliSrc)} "$@"
`;
      writeFileSync(cliDst, wrapper, { mode: 0o755 });
    }
    return cliDst;
  }

  log(`Link CLI: ${cliDst} -> ${cliSrc}`);
  if (!dryRun) {
    try {
      chmodSync(cliSrc, 0o755);
    } catch {}
    mkdirSync(dirname(cliDst), { recursive: true });
    rmSync(cliDst, { force: true });
    symlinkSync(cliSrc, cliDst);
  }
  return cliDst;
}

function xmlEscape(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function buildLaunchAgentPlist({
  nodeBin = resolveNodeBin(),
  root = resolvePackageRoot(),
  homeDir = homedir(),
} = {}) {
  const logDir = join(homeDir, '.local', 'share', 'ai-turn-meter', 'logs');
  const daemonBin = join(root, 'packages', 'daemon', 'bin', 'daemon.mjs');
  const runtimePath = `${dirname(nodeBin)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodeBin)}</string>
    <string>${xmlEscape(daemonBin)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(runtimePath)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(join(logDir, 'daemon.out.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(join(logDir, 'daemon.err.log'))}</string>
</dict>
</plist>
`;
}

export function installLaunchAgent({
  dryRun = false,
  nodeBin = resolveNodeBin(),
  root = resolvePackageRoot(),
  homeDir = homedir(),
  log = defaultLog(dryRun),
} = {}) {
  const plistPath = join(homeDir, 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);
  const logDir = join(homeDir, '.local', 'share', 'ai-turn-meter', 'logs');
  const plist = buildLaunchAgentPlist({ nodeBin, root, homeDir });

  log(`Install LaunchAgent: ${plistPath}`);
  if (!dryRun) {
    mkdirSync(dirname(plistPath), { recursive: true });
    mkdirSync(logDir, { recursive: true });
    writeFileSync(plistPath, plist);
    const uid = process.getuid();
    try {
      execFileSync('launchctl', ['bootout', `gui/${uid}`, plistPath], { stdio: 'ignore' });
    } catch {}
    execFileSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath], { stdio: 'inherit' });
  }
  return plistPath;
}

export function uninstallLaunchAgent({
  dryRun = false,
  homeDir = homedir(),
  log = defaultLog(dryRun),
} = {}) {
  const plistPath = join(homeDir, 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);
  if (!existsSync(plistPath)) return false;
  log(`Remove LaunchAgent: ${plistPath}`);
  if (!dryRun) {
    try {
      execFileSync('launchctl', ['bootout', `gui/${process.getuid()}`, plistPath], { stdio: 'ignore' });
    } catch {}
    rmSync(plistPath, { force: true });
  }
  return true;
}

export async function installAll({
  dryRun = false,
  skipCliLink = false,
  skipLaunchAgent = false,
  homeDir = homedir(),
  root = resolvePackageRoot(),
  nodeBin = resolveNodeBin(),
} = {}) {
  const log = defaultLog(dryRun);
  const rt = await checkNodeRuntime();
  if (!rt.ok) {
    throw new Error(
      `需要 Node.js >= 22.5（含 node:sqlite），当前版本为 ${rt.version}${rt.error ? `: ${rt.error}` : ''}`
    );
  }
  patchCursorHooks({ dryRun, homeDir, hookCmd: buildHookCommand({ nodeBin, root }), log });
  installVsix({ dryRun, root, homeDir, log });
  removeLegacyApps({ dryRun, homeDir, log });
  if (!skipCliLink) installCliLink({ dryRun, root, homeDir, log });
  if (!skipLaunchAgent) installLaunchAgent({ dryRun, nodeBin, root, homeDir, log });
  log('Install complete.');
}

export function uninstallAll({ dryRun = false, homeDir = homedir() } = {}) {
  const log = defaultLog(dryRun);
  cleanCursorHooks({ dryRun, homeDir, log });
  uninstallLaunchAgent({ dryRun, homeDir, log });
  uninstallVsix({ dryRun, homeDir, log });
  const cliDst = join(homeDir, '.local', 'bin', 'ai-turn-meter');
  if (existsSync(cliDst)) {
    log(`Remove ${cliDst}`);
    if (!dryRun) rmSync(cliDst, { force: true });
  }
  removeLegacyApps({ dryRun, homeDir, log });
  log('Uninstall complete.');
}

/**
 * Inspect local environment readiness (Node, Daemon, LaunchAgent, Cursor hooks, 4 apps + VSIX + CDP).
 */
export async function runDoctor({ port = DEFAULT_DAEMON_PORT, homeDir = homedir() } = {}) {
  const meta = getPackageMeta();
  const node = await checkNodeRuntime();
  let daemon = { ok: false, port };
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1200) });
    if (res.ok) daemon = { ...(await res.json()), port };
  } catch {}

  const plistPath = join(homeDir, 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);
  const plistExists = existsSync(plistPath);
  let launchAgentLoaded = false;
  let programDaemonPath = null;
  if (plistExists) {
    try {
      const plistRaw = readFileSync(plistPath, 'utf8');
      const m = plistRaw.match(/<string>([^<]*daemon\.mjs)<\/string>/);
      if (m && m[1]) programDaemonPath = m[1];
    } catch {}
    try {
      execFileSync('launchctl', ['print', `gui/${process.getuid()}/${LAUNCH_AGENT_LABEL}`], {
        stdio: 'ignore',
      });
      launchAgentLoaded = true;
    } catch {}
  }
  const expectedDaemonPath = join(meta.root, 'packages', 'daemon', 'bin', 'daemon.mjs');

  const hooksPath = join(homeDir, '.cursor', 'hooks.json');
  const hooksReport = { path: hooksPath, exists: existsSync(hooksPath), validVersion: false, configured: false };
  if (hooksReport.exists) {
    try {
      const cfg = JSON.parse(readFileSync(hooksPath, 'utf8'));
      hooksReport.validVersion = typeof cfg.version === 'number';
      hooksReport.configured = ['afterAgentResponse', 'stop'].every(
        (ev) =>
          Array.isArray(cfg.hooks?.[ev]) &&
          cfg.hooks[ev].some((x) => typeof x?.command === 'string' && x.command.includes('cursor-hook.mjs'))
      );
    } catch {
      hooksReport.parseError = true;
    }
  }

  const apps = {};
  for (const [key, spec] of Object.entries(APP_SPECS)) {
    const info = resolveAppPaths(spec, { homeDir });
    const cdpPort = info.installed ? readActivePort(info, homeDir) : null;
    let vsixVersion = null;
    if (info.cliPath) {
      try {
        const listOut = execFileSync(info.cliPath, ['--list-extensions', '--show-versions'], {
          encoding: 'utf8',
          timeout: 3000,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        const line = listOut
          .split(/\r?\n/)
          .find((l) => l.startsWith(`${VSIX_EXT_ID}@`));
        if (line) vsixVersion = line.split('@')[1] || 'installed';
      } catch {}
    }
    apps[key] = {
      name: info.name,
      appPath: info.appPath,
      installed: info.installed,
      cdpPort,
      vsixVersion,
    };
  }

  return {
    node,
    packageRoot: meta.root,
    updateFeedUrl: meta.updateFeedUrl,
    daemon,
    launchAgent: {
      plistPath,
      plistExists,
      launchAgentLoaded,
      programDaemonPath,
      pointsToCurrentRoot: programDaemonPath === expectedDaemonPath,
      managedByApp: Boolean(programDaemonPath?.includes('.app/Contents/Resources/runtime/')),
    },
    cursorHooks: hooksReport,
    apps,
  };
}
