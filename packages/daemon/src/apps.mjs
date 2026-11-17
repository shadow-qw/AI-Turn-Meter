import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_DAEMON_PORT = Number(process.env.AI_TURN_METER_PORT || 47831);

export const APP_SPECS = {
  antigravity: {
    key: 'antigravity',
    name: 'Antigravity',
    bundleName: 'Antigravity.app',
    exeRelPath: 'Contents/MacOS/Electron',
    portFileRel: ['Library', 'Application Support', 'Antigravity', 'DevToolsActivePort'],
  },
  codex: {
    key: 'codex',
    name: 'ChatGPT',
    bundleName: 'ChatGPT.app',
    exeRelPath: 'Contents/MacOS/ChatGPT',
    port: Number(process.env.AI_TURN_METER_CODEX_CDP_PORT || 47921),
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

export function isPortListening(port) {
  if (!port) return false;
  try {
    execFileSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function readActivePort(spec, homeDir = homedir()) {
  if (spec.port) return isPortListening(spec.port) ? spec.port : null;
  const portFile = spec.portFile || (spec.portFileRel ? join(homeDir, ...spec.portFileRel) : null);
  if (portFile && existsSync(portFile)) {
    try {
      const p = Number(readFileSync(portFile, 'utf8').trim().split(/\r?\n/)[0]);
      return Number.isInteger(p) && isPortListening(p) ? p : null;
    } catch {
      return null;
    }
  }
  return null;
}
