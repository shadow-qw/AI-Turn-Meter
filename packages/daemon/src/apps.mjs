import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const DEFAULT_DAEMON_PORT = Number(process.env.AI_TURN_METER_PORT || 47831);

export const APP_SPECS = {
  antigravity: {
    key: 'antigravity',
    name: 'Antigravity',
    bundleName: 'Antigravity.app',
    exeRelPath: 'Contents/MacOS/Antigravity',
    portFileRel: ['Library', 'Application Support', 'Antigravity', 'DevToolsActivePort'],
    port: Number(process.env.AI_TURN_METER_ANTIGRAVITY_CDP_PORT || 47924),
  },
  codex: {
    key: 'codex',
    name: 'ChatGPT',
    bundleName: 'ChatGPT.app',
    exeRelPath: 'Contents/MacOS/ChatGPT',
    port: Number(process.env.AI_TURN_METER_CODEX_CDP_PORT || 47921),
  },
  claude: {
    key: 'claude',
    name: 'Claude',
    bundleName: 'Claude.app',
    exeRelPath: 'Contents/MacOS/Claude',
    supportsCdp: false,
  },
  cursor: {
    key: 'cursor',
    name: 'Cursor',
    bundleName: 'Cursor.app',
    exeRelPath: 'Contents/MacOS/Cursor',
    cliRelPath: 'Contents/Resources/app/bin/cursor',
    port: Number(process.env.AI_TURN_METER_CURSOR_CDP_PORT || 47922),
  },
  codebuddy: {
    key: 'codebuddy',
    name: 'CodeBuddy CN',
    bundleName: 'CodeBuddy CN.app',
    exeRelPath: 'Contents/MacOS/Electron',
    cliRelPath: 'Contents/Resources/app/bin/code',
    port: Number(process.env.AI_TURN_METER_CODEBUDDY_CDP_PORT || 47923),
  },
};

/**
 * Locate a macOS `.app` bundle across /Applications, ~/Applications, and Spotlight fallback.
 * @param {string} bundleName
 * @param {{ homeDir?: string, searchDirs?: string[], allowMdfind?: boolean }} [opts]
 * @returns {string | null}
 */
export function findAppBundle(
  bundleName,
  { homeDir = homedir(), searchDirs = ['/Applications', join(homeDir, 'Applications')], allowMdfind = true } = {}
) {
  for (const dir of searchDirs) {
    const candidate = join(dir, bundleName);
    if (existsSync(candidate)) return candidate;
  }
  if (!allowMdfind) return null;

  try {
    const query = `kMDItemFSName == "${bundleName.replace(/"/g, '\\"')}"`;
    const out = execFileSync(
      '/usr/bin/mdfind',
      ['-onlyin', '/Applications', '-onlyin', join(homeDir, 'Applications'), query],
      { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const first = out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s.endsWith(`/${bundleName}`) && existsSync(s));
    return first || null;
  } catch {
    return null;
  }
}

/**
 * Resolve `.app`, main executable, CLI binary, and portFile paths for a known app spec.
 * @param {typeof APP_SPECS[keyof typeof APP_SPECS]} spec
 * @param {{ homeDir?: string, searchDirs?: string[], allowMdfind?: boolean }} [opts]
 */
export function resolveAppPaths(spec, opts = {}) {
  const homeDir = opts.homeDir || homedir();
  const appPath = findAppBundle(spec.bundleName, opts);
  const exePath = appPath ? join(appPath, spec.exeRelPath) : join('/Applications', spec.bundleName, spec.exeRelPath);
  const cliPath =
    spec.cliRelPath && appPath
      ? join(appPath, spec.cliRelPath)
      : spec.cliRelPath
        ? join('/Applications', spec.bundleName, spec.cliRelPath)
        : null;
  const portFile = spec.portFileRel ? join(homeDir, ...spec.portFileRel) : null;
  return {
    ...spec,
    appPath,
    installed: Boolean(appPath),
    exePath,
    cliPath: cliPath && existsSync(cliPath) ? cliPath : null,
    portFile,
  };
}

function parseListeningTcpPortsOutput(out) {
  const ports = new Set();
  for (const line of String(out || '').split(/\r?\n/)) {
    if (!line.startsWith('n')) continue;
    const m = line.match(/:(\d+)(?:\s|$)/);
    if (m) ports.add(Number(m[1]));
  }
  return ports;
}

/**
 * Collect all currently listening TCP ports in a single `lsof` invocation.
 * @returns {Set<number> | null}
 */
export function readListeningTcpPorts() {
  try {
    const out = execFileSync('/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fn'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseListeningTcpPortsOutput(out);
  } catch {
    return null;
  }
}

export async function readListeningTcpPortsAsync() {
  try {
    const { stdout } = await execFileAsync('/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fn'], {
      encoding: 'utf8',
      timeout: 2500,
    });
    return parseListeningTcpPortsOutput(stdout);
  } catch {
    return null;
  }
}

/**
 * Collect all process command lines in a single `ps` invocation.
 * @returns {string[] | null}
 */
export function readProcessCommandLines() {
  try {
    const out = execFileSync('/bin/ps', ['-axo', 'command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split(/\r?\n/);
  } catch {
    return null;
  }
}

export async function readProcessCommandLinesAsync() {
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'command='], {
      encoding: 'utf8',
      timeout: 2500,
    });
    return String(stdout || '').split(/\r?\n/);
  } catch {
    return null;
  }
}

export function isPortListening(port, listeningPorts = null) {
  if (!port) return false;
  if (listeningPorts instanceof Set) {
    return listeningPorts.has(Number(port));
  }
  try {
    execFileSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function isAppRunning(spec, processLines = null) {
  if (!spec?.installed || !spec?.exePath) return false;
  if (Array.isArray(processLines)) {
    return processLines.some((line) => line.includes(spec.exePath));
  }
  try {
    execFileSync('pgrep', ['-f', spec.exePath], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function readActivePort(spec, homeDir = homedir(), listeningPorts = null) {
  const portFile = spec.portFile || (spec.portFileRel ? join(homeDir, ...spec.portFileRel) : null);
  if (portFile && existsSync(portFile)) {
    try {
      const p = Number(readFileSync(portFile, 'utf8').trim().split(/\r?\n/)[0]);
      if (Number.isInteger(p) && isPortListening(p, listeningPorts)) return p;
    } catch {}
  }
  if (spec.port) return isPortListening(spec.port, listeningPorts) ? spec.port : null;
  return null;
}

/**
 * Extract user/wrapper `--flag` arguments from a running app main process so relaunches preserve them.
 * @param {string} commandLine
 * @param {string} exePath
 * @returns {string[]}
 */
export function extractPreservableArgs(commandLine, exePath) {
  if (!commandLine || !exePath) return [];
  const trimmed = String(commandLine).trim();
  if (trimmed !== exePath && (!trimmed.startsWith(exePath) || !/\s/.test(trimmed[exePath.length]))) {
    return [];
  }
  const rest = trimmed.slice(exePath.length).trim();
  if (!rest) return [];
  const tokens = rest.split(/\s+/);
  const preserved = [];
  let skipNext = false;
  for (const tok of tokens) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (tok === '--remote-debugging-port') {
      skipNext = true;
      continue;
    }
    if (
      tok === '--remote-debugging-pipe' ||
      tok.startsWith('--remote-debugging-port=') ||
      tok.startsWith('-psn_') ||
      !tok.startsWith('--')
    ) {
      continue;
    }
    if (!preserved.includes(tok)) preserved.push(tok);
  }
  return preserved;
}

/**
 * Read preserved CLI flags from a currently running main app binary, if any.
 * @param {{ exePath?: string }} spec
 * @returns {string[]}
 */
export function readRunningProcessArgs(spec) {
  if (!spec?.exePath) return [];
  const lines = readProcessCommandLines();
  if (!lines) return [];
  for (const line of lines) {
    const args = extractPreservableArgs(line, spec.exePath);
    if (args.length > 0) return args;
  }
  return [];
}

/**
 * Check whether any framework/helper child processes inside an app bundle are still running.
 * @param {{ installed?: boolean, appPath?: string | null }} spec
 * @returns {boolean}
 */
export function hasAppHelpersRunning(spec) {
  if (!spec?.installed || !spec?.appPath) return false;
  const frameworksMarker = join(spec.appPath, 'Contents', 'Frameworks');
  const lines = readProcessCommandLines();
  return lines ? lines.some((line) => line.includes(frameworksMarker)) : false;
}

/**
 * Verify Chrome DevTools HTTP target list is actually responsive on `127.0.0.1:<port>`.
 * @param {number} port
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
export async function isCdpHttpReady(port, timeoutMs = 800) {
  if (!port) return false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: ctrl.signal });
    if (!res.ok) return false;
    const data = await res.json();
    return Array.isArray(data);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe installed status, running state, and active CDP ports across all 4 client apps asynchronously.
 */
export async function inspectAppsStatusAsync({
  byTool = {},
  homeDir = homedir(),
  allowMdfind = true,
} = {}) {
  const [listeningPorts, processLines] = await Promise.all([
    readListeningTcpPortsAsync(),
    readProcessCommandLinesAsync(),
  ]);
  const safePorts = listeningPorts ?? new Set();
  const safeLines = processLines ?? [];
  const apps = {};
  for (const [key, spec] of Object.entries(APP_SPECS)) {
    const resolved = resolveAppPaths(spec, { homeDir, allowMdfind });
    const cdpPort = resolved.installed ? readActivePort(resolved, homeDir, safePorts) : null;
    apps[key] = {
      name: resolved.name,
      appPath: resolved.appPath,
      installed: resolved.installed,
      running: isAppRunning(resolved, safeLines),
      cdpPort,
      latestTurn: byTool?.[key] || null,
    };
  }
  return apps;
}
