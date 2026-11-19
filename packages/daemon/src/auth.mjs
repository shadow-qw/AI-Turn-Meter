import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const AUTH_TOKEN_HEADER = 'x-atm-token';

const ALLOWED_LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function defaultTokenPath(stateDir = null) {
  const dir =
    stateDir && stateDir !== ':memory:'
      ? stateDir
      : process.env.AI_TURN_METER_STATE_DIR || join(homedir(), '.local', 'share', 'ai-turn-meter');
  return join(dir, 'daemon.token');
}

export function loadOrCreateDaemonToken(stateDir = null) {
  if (!stateDir || stateDir === ':memory:') {
    return randomBytes(24).toString('hex');
  }
  const tokenPath = defaultTokenPath(stateDir);
  if (existsSync(tokenPath)) {
    try {
      const existing = readFileSync(tokenPath, 'utf8').trim();
      if (existing.length >= 32) {
        try {
          chmodSync(tokenPath, 0o600);
        } catch {}
        return existing;
      }
    } catch {}
  }

  const token = randomBytes(24).toString('hex');
  mkdirSync(dirname(tokenPath), { recursive: true });
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  try {
    chmodSync(tokenPath, 0o600);
  } catch {}
  return token;
}

export function readDaemonToken(stateDir = null) {
  const envTok = process.env.AI_TURN_METER_TOKEN;
  if (typeof envTok === 'string' && envTok.trim()) {
    return envTok.trim();
  }
  const tokenPath = defaultTokenPath(stateDir);
  if (!existsSync(tokenPath)) return null;
  try {
    const raw = readFileSync(tokenPath, 'utf8').trim();
    return raw || null;
  } catch {
    return null;
  }
}

export function verifyDaemonToken(req, expectedToken) {
  if (!expectedToken || typeof expectedToken !== 'string') return false;
  const headers = req?.headers || {};
  const rawHeader = headers[AUTH_TOKEN_HEADER];
  let candidate = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  if (typeof candidate !== 'string' || !candidate.trim()) {
    const authz = Array.isArray(headers.authorization) ? headers.authorization[0] : headers.authorization;
    if (typeof authz === 'string') {
      const m = authz.match(/^Bearer\s+(.+)$/i);
      if (m) candidate = m[1];
    }
  }
  if (typeof candidate !== 'string') return false;
  const trimmed = candidate.trim();
  if (!trimmed) return false;

  const bufA = Buffer.from(trimmed, 'utf8');
  const bufB = Buffer.from(expectedToken, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function validateLocalRequest(req) {
  const headers = req?.headers || {};
  const hostHeader = Array.isArray(headers.host) ? headers.host[0] : headers.host;
  if (typeof hostHeader === 'string' && hostHeader.trim() !== '') {
    let hostname = '';
    try {
      hostname = new URL(`http://${hostHeader.trim()}`).hostname.toLowerCase();
    } catch {
      return { ok: false, status: 403, error: 'forbidden host' };
    }
    if (!ALLOWED_LOCAL_HOSTS.has(hostname)) {
      return { ok: false, status: 403, error: 'forbidden host' };
    }
  }

  const origin = Array.isArray(headers.origin) ? headers.origin[0] : headers.origin;
  if (typeof origin === 'string' && origin.trim() !== '') {
    return { ok: false, status: 403, error: 'browser origin forbidden' };
  }

  const secFetchSite = Array.isArray(headers['sec-fetch-site'])
    ? headers['sec-fetch-site'][0]
    : headers['sec-fetch-site'];
  if (
    typeof secFetchSite === 'string' &&
    secFetchSite.trim() !== '' &&
    secFetchSite.trim().toLowerCase() !== 'none'
  ) {
    return { ok: false, status: 403, error: 'browser origin forbidden' };
  }

  return { ok: true };
}
