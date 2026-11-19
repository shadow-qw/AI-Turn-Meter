import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import https from 'node:https';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { zstdDecompressSync } from 'node:zlib';

const execFileAsync = promisify(execFile);

const CACHE_TTL_MS = 45_000;
const ERROR_RETRY_TTL_MS = 5_000;
const STALE_GRACE_MS = 15 * 60 * 1000;
const PROXY_CACHE_TTL_MS = 15_000;

let cachedResult = null;
let cachedAtMs = 0;
let cachedCookieKey = '';
let cachedTtlMs = CACHE_TTL_MS;
let inflightPromise = null;
let lastGoodByTool = {
  codex: null,
  cursor: null,
  antigravity: null,
};
let cachedProxyState = { checkedAt: 0, hasSystemProxy: false, fallbackProxyUrl: null };

export function resetQuotaCacheForTests() {
  cachedResult = null;
  cachedAtMs = 0;
  cachedCookieKey = '';
  cachedTtlMs = CACHE_TTL_MS;
  inflightPromise = null;
  lastGoodByTool = { codex: null, cursor: null, antigravity: null };
  cachedProxyState = { checkedAt: 0, hasSystemProxy: false, fallbackProxyUrl: null };
}

export function parseSystemProxyInfo(scutilOutput = '', env = process.env) {
  const envProxy =
    env.HTTPS_PROXY ||
    env.https_proxy ||
    env.ALL_PROXY ||
    env.all_proxy ||
    env.HTTP_PROXY ||
    env.http_proxy ||
    null;

  const text = String(scutilOutput || '');
  const getBool = (key) => new RegExp(`\\b${key}\\s*:\\s*1\\b`).test(text);
  const getVal = (key) => {
    const m = text.match(new RegExp(`\\b${key}\\s*:\\s*([^\\s\\n]+)`));
    return m?.[1] || null;
  };

  const httpEnabled = getBool('HTTPEnable');
  const httpsEnabled = getBool('HTTPSEnable');
  const socksEnabled = getBool('SOCKSEnable');
  const pacEnabled = getBool('ProxyAutoConfigEnable') || getBool('ProxyAutoDiscoveryEnable');
  const hasSystemProxy = Boolean(envProxy || httpEnabled || httpsEnabled || socksEnabled || pacEnabled);

  let fallbackProxyUrl = envProxy ? String(envProxy).trim() : null;
  if (!fallbackProxyUrl && httpsEnabled) {
    const host = getVal('HTTPSProxy');
    const port = getVal('HTTPSPort');
    if (host && port) fallbackProxyUrl = `http://${host}:${port}`;
  }
  if (!fallbackProxyUrl && httpEnabled) {
    const host = getVal('HTTPProxy');
    const port = getVal('HTTPPort');
    if (host && port) fallbackProxyUrl = `http://${host}:${port}`;
  }
  if (!fallbackProxyUrl && socksEnabled) {
    const host = getVal('SOCKSProxy');
    const port = getVal('SOCKSPort');
    if (host && port) fallbackProxyUrl = `socks5h://${host}:${port}`;
  }

  return { hasSystemProxy, fallbackProxyUrl };
}

function resolveAppHelperBin() {
  if (process.env.AI_TURN_METER_DISABLE_NATIVE_NET === '1' || process.env.NODE_TEST_CONTEXT) {
    return null;
  }
  const candidates = [];
  if (process.env.AI_TURN_METER_HELPER_BIN) {
    candidates.push(process.env.AI_TURN_METER_HELPER_BIN);
  }
  if (process.env.AI_TURN_METER_STABLE_ROOT) {
    candidates.push(join(process.env.AI_TURN_METER_STABLE_ROOT, '..', '..', 'MacOS', 'AITurnMeter'));
  }
  try {
    const srcDir = dirname(fileURLToPath(import.meta.url));
    candidates.push(join(srcDir, '..', '..', '..', '..', 'MacOS', 'AITurnMeter'));
  } catch {}
  candidates.push('/Applications/AI Turn Meter.app/Contents/MacOS/AITurnMeter');
  candidates.push(join(homedir(), 'Applications', 'AI Turn Meter.app', 'Contents', 'MacOS', 'AITurnMeter'));
  for (const p of candidates) {
    try {
      if (p && existsSync(p)) return p;
    } catch {}
  }
  return null;
}

async function getProxyState(nowMs = Date.now()) {
  if (process.env.AI_TURN_METER_DISABLE_NATIVE_NET === '1' || process.env.NODE_TEST_CONTEXT) {
    return parseSystemProxyInfo('', process.env);
  }
  if (nowMs - cachedProxyState.checkedAt < PROXY_CACHE_TTL_MS) {
    return cachedProxyState;
  }
  let scutilOut = '';
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('/usr/sbin/scutil', ['--proxy'], { timeout: 1000 });
      scutilOut = stdout || '';
    } catch {}
  }
  const parsed = parseSystemProxyInfo(scutilOut, process.env);
  cachedProxyState = { checkedAt: nowMs, ...parsed };
  return cachedProxyState;
}

function runProcessWithStdin(bin, args, inputStr, timeoutMs) {
  return new Promise((resolve) => {
    const child = execFile(
      bin,
      args,
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve({ ok: false, stdout: stdout || '', error: err.message });
          return;
        }
        resolve({ ok: true, stdout: stdout || '' });
      }
    );
    if (child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(inputStr || '');
    }
  });
}

async function nativeUrlSessionFetchJson(helperBin, url, { method = 'GET', headers = {}, body = null, timeoutMs = 8000 }) {
  const payload = JSON.stringify({
    url,
    method,
    headers,
    body: body !== null && body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : null,
    timeoutMs,
  });
  const res = await runProcessWithStdin(helperBin, ['--net-fetch-json'], payload, timeoutMs + 3000);
  if (!res.ok || !res.stdout.trim()) {
    return { ok: false, status: null, data: null, errorKind: 'network', errorMessage: res.error || 'native helper failed' };
  }
  try {
    const out = JSON.parse(res.stdout);
    const status = typeof out.status === 'number' ? out.status : null;
    if (!status) {
      return { ok: false, status: null, data: null, errorKind: 'network', errorMessage: out.error || 'network error' };
    }
    if (status === 401 || status === 403) {
      return { ok: false, status, data: null, errorKind: 'unauthorized', errorMessage: `HTTP ${status}` };
    }
    if (status < 200 || status >= 300) {
      return { ok: false, status, data: null, errorKind: 'http', errorMessage: `HTTP ${status}` };
    }
    try {
      return { ok: true, status, data: out.body ? JSON.parse(out.body) : null, errorKind: 'ok', errorMessage: null };
    } catch {
      return { ok: false, status, data: null, errorKind: 'parse', errorMessage: 'invalid json' };
    }
  } catch (e) {
    return { ok: false, status: null, data: null, errorKind: 'network', errorMessage: e?.message || 'native parse error' };
  }
}

async function curlFetchJson(url, { method = 'GET', headers = {}, body = null, timeoutMs = 8000, proxyUrl = null }) {
  if (!existsSync('/usr/bin/curl')) {
    return { ok: false, status: null, data: null, errorKind: 'network', errorMessage: 'curl unavailable' };
  }
  const args = [
    '-sS',
    '--max-time',
    String(Math.max(2, Math.ceil(timeoutMs / 1000))),
    '-X',
    method,
    '-w',
    '\n__ATM_HTTP:%{http_code}',
  ];
  if (proxyUrl) {
    args.push('--proxy', proxyUrl);
  }
  for (const [k, v] of Object.entries(headers || {})) {
    if (v !== undefined && v !== null) args.push('-H', `${k}: ${v}`);
  }
  const bodyStr = body !== null && body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
  if (bodyStr !== null) {
    args.push('--data-binary', '@-');
  }
  args.push(url);

  const res = await runProcessWithStdin('/usr/bin/curl', args, bodyStr || '', timeoutMs + 2500);
  if (!res.ok) {
    return { ok: false, status: null, data: null, errorKind: 'network', errorMessage: res.error || 'curl error' };
  }
  const marker = '\n__ATM_HTTP:';
  const idx = res.stdout.lastIndexOf(marker);
  if (idx === -1) {
    return { ok: false, status: null, data: null, errorKind: 'network', errorMessage: 'curl no status' };
  }
  const bodyOut = res.stdout.slice(0, idx);
  const status = Number(res.stdout.slice(idx + marker.length).trim()) || null;
  if (!status) {
    return { ok: false, status: null, data: null, errorKind: 'network', errorMessage: 'curl status 0' };
  }
  if (status === 401 || status === 403) {
    return { ok: false, status, data: null, errorKind: 'unauthorized', errorMessage: `HTTP ${status}` };
  }
  if (status < 200 || status >= 300) {
    return { ok: false, status, data: null, errorKind: 'http', errorMessage: `HTTP ${status}` };
  }
  try {
    return { ok: true, status, data: bodyOut ? JSON.parse(bodyOut) : null, errorKind: 'ok', errorMessage: null };
  } catch {
    return { ok: false, status, data: null, errorKind: 'parse', errorMessage: 'invalid json' };
  }
}

export async function httpRequestJson(
  url,
  { method = 'GET', headers = {}, body = null, timeoutMs = 8000 } = {}
) {
  const helperBin = resolveAppHelperBin();
  const proxyState = await getProxyState();
  const bodyStr = body !== null && body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined;

  if (helperBin && proxyState.hasSystemProxy) {
    return nativeUrlSessionFetchJson(helperBin, url, { method, headers, body: bodyStr ?? null, timeoutMs });
  }

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: bodyStr,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: res.status, data: null, errorKind: 'unauthorized', errorMessage: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { ok: false, status: res.status, data: null, errorKind: 'http', errorMessage: `HTTP ${res.status}` };
    }
    try {
      const data = await res.json();
      return { ok: true, status: res.status, data, errorKind: 'ok', errorMessage: null };
    } catch {
      return { ok: false, status: res.status, data: null, errorKind: 'parse', errorMessage: 'invalid json' };
    }
  } catch (err) {
    if (helperBin) {
      return nativeUrlSessionFetchJson(helperBin, url, { method, headers, body: bodyStr ?? null, timeoutMs });
    }
    if (proxyState.fallbackProxyUrl) {
      return curlFetchJson(url, { method, headers, body: bodyStr ?? null, timeoutMs, proxyUrl: proxyState.fallbackProxyUrl });
    }
    return {
      ok: false,
      status: null,
      data: null,
      errorKind: 'network',
      errorMessage: err?.cause?.code || err?.message || 'fetch failed',
    };
  }
}

function clampPct(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.min(100, Math.max(0, v));
}

export function formatDurationZh(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  if (days > 0) {
    return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`;
  }
  if (hours > 0) {
    return mins > 0 ? `${hours} 小时 ${mins} 分钟` : `${hours} 小时`;
  }
  return `${Math.max(1, mins)} 分钟`;
}

export function computeQuotaWindow({
  id,
  title,
  remainingPct = null,
  usedPct = null,
  windowSeconds = null,
  resetAtMs = null,
  nowMs = Date.now(),
  extraNote = null,
}) {
  let rem = clampPct(remainingPct);
  if (rem === null) {
    const used = clampPct(usedPct);
    if (used === null) return null;
    rem = 100 - used;
  }
  const actualUsed = 100 - rem;

  let resetText = null;
  let timeLeftSec = null;
  if (typeof resetAtMs === 'number' && Number.isFinite(resetAtMs) && resetAtMs > nowMs) {
    timeLeftSec = (resetAtMs - nowMs) / 1000;
    resetText = `${formatDurationZh(timeLeftSec)}后重置`;
  }

  let pacePct = null;
  let subtitle = null;

  if (
    typeof windowSeconds === 'number' &&
    windowSeconds > 0 &&
    timeLeftSec !== null &&
    timeLeftSec > 0 &&
    timeLeftSec <= windowSeconds
  ) {
    const elapsedSec = windowSeconds - timeLeftSec;
    const expectedUsed = Math.min(100, Math.max(0, (elapsedSec / windowSeconds) * 100));
    const expectedRem = Number((100 - expectedUsed).toFixed(1));
    pacePct = rem > 0.05 ? expectedRem : null;
    const deltaPct = rem - expectedRem; // positive = in reserve, negative = deficit

    if (elapsedSec > 60) {
      if (rem <= 0.05) {
        subtitle = '已用尽 · 等待重置';
      } else if (actualUsed <= 0.05) {
        const resRound = Math.round(deltaPct);
        subtitle = resRound > 1 ? `余量 ${resRound}% · 持续到重置` : '进度正常 · 持续到重置';
      } else {
        const ratePerSec = actualUsed / elapsedSec;
        const timeToEmptySec = rem / ratePerSec;
        const projectedRemainingUsage = actualUsed * (timeLeftSec / elapsedSec);
        const rawMult = projectedRemainingUsage > 0 ? rem / projectedRemainingUsage : 9.9;
        const clampedMult = Math.min(9.9, Math.max(0.1, rawMult));

        if (timeToEmptySec >= timeLeftSec) {
          const multText = clampedMult >= 1.05 ? ` · ${clampedMult.toFixed(1)} 倍余量` : '';
          const resRound = Math.round(deltaPct);
          subtitle =
            resRound > 0
              ? `余量 ${resRound}% · 持续到重置${multText}`
              : `进度平稳 · 持续到重置${multText}`;
        } else {
          const etaText = formatDurationZh(timeToEmptySec);
          const defRound = Math.round(-deltaPct);
          subtitle =
            defRound > 0
              ? `已多用 ${defRound}% · 预计 ${etaText}后耗尽`
              : `预计 ${etaText}后耗尽`;
        }
      }
    }
  }

  if (extraNote) {
    subtitle = subtitle ? `${extraNote} · ${subtitle}` : extraNote;
  }

  return {
    id,
    title,
    remainingPct: Number(rem.toFixed(1)),
    resetText,
    pacePct,
    subtitle,
  };
}

function decodeJwtPayload(jwt) {
  try {
    const parts = String(jwt || '').split('.');
    if (parts.length < 2) return null;
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function formatCodexPlan(planType) {
  if (!planType) return null;
  const map = {
    plus: 'Plus',
    pro: 'Pro',
    prolite: 'Pro Lite',
    pro_lite: 'Pro Lite',
    'pro-lite': 'Pro Lite',
    go: 'Go',
    team: 'Team',
    business: 'Business',
    enterprise: 'Enterprise',
    education: 'Education',
    edu: 'Edu',
    free: 'Free',
    free_workspace: 'Free Workspace',
    k12: 'K12',
  };
  const key = String(planType).trim().toLowerCase();
  return map[key] || String(planType);
}

function classifyCodexWindowRole(w, fallbackRole) {
  const secs = Number(w?.limit_window_seconds);
  if (Number.isFinite(secs) && secs > 0) {
    if (secs >= 25 * 86400) return 'monthly';
    if (secs >= 5 * 86400 && secs <= 10 * 86400) return 'weekly';
    if (secs >= 3600 && secs <= 12 * 3600) return 'session';
  }
  return fallbackRole;
}

export function normalizeCodexRateWindows(rateLimit, nowMs = Date.now()) {
  if (!rateLimit || typeof rateLimit !== 'object') return [];
  const roleMeta = {
    session: { id: 'codex-session', title: '会话', defaultSecs: 18000 },
    weekly: { id: 'codex-weekly', title: '每周', defaultSecs: 604800 },
    monthly: { id: 'codex-monthly', title: '每月', defaultSecs: 2592000 },
  };

  const rawEntries = [
    { raw: rateLimit.primary_window, fallbackRole: 'session' },
    { raw: rateLimit.secondary_window, fallbackRole: 'weekly' },
  ].filter(
    (entry) =>
      entry.raw && typeof entry.raw.used_percent === 'number' && Number.isFinite(entry.raw.used_percent)
  );

  const byRole = new Map();
  for (const { raw, fallbackRole } of rawEntries) {
    const role = classifyCodexWindowRole(raw, fallbackRole);
    if (!byRole.has(role)) {
      byRole.set(role, raw);
    }
  }

  // Mirror CodexBar's secondaryGloballyCapsPrimary: when weekly quota is exhausted and not yet reset,
  // the 5h session window is effectively capped at 0% remaining.
  const weeklyRaw = byRole.get('weekly');
  let weeklyCapsSession = false;
  if (weeklyRaw && weeklyRaw.used_percent >= 100) {
    const weeklyResetAtMs =
      typeof weeklyRaw.reset_at === 'number' && weeklyRaw.reset_at > 0
        ? weeklyRaw.reset_at * 1000
        : typeof weeklyRaw.reset_after_seconds === 'number' && weeklyRaw.reset_after_seconds > 0
          ? nowMs + weeklyRaw.reset_after_seconds * 1000
          : null;
    if (weeklyResetAtMs === null || weeklyResetAtMs > nowMs) {
      weeklyCapsSession = true;
    }
  }

  const quotaWindows = [];
  for (const role of ['session', 'weekly', 'monthly']) {
    const w = byRole.get(role);
    if (!w) continue;
    const meta = roleMeta[role];
    const resetAtMs =
      typeof w.reset_at === 'number' && w.reset_at > 0
        ? w.reset_at * 1000
        : typeof w.reset_after_seconds === 'number' && w.reset_after_seconds > 0
          ? nowMs + w.reset_after_seconds * 1000
          : null;
    const effectiveUsedPct = role === 'session' && weeklyCapsSession ? 100 : w.used_percent;
    const win = computeQuotaWindow({
      id: meta.id,
      title: meta.title,
      usedPct: effectiveUsedPct,
      windowSeconds:
        typeof w.limit_window_seconds === 'number' && w.limit_window_seconds > 0
          ? w.limit_window_seconds
          : meta.defaultSecs,
      resetAtMs,
      nowMs,
    });
    if (win) quotaWindows.push(win);
  }

  return quotaWindows;
}

function resolveCodexAuthCandidatePaths(codexHome, homeDir = homedir()) {
  const paths = [join(codexHome, 'auth.json')];
  if (!process.env.CODEX_HOME?.trim()) {
    paths.push(join(homeDir, '.config', 'codex', 'auth.json'));
  }
  return paths;
}

export function resolveCodexUsageUrl(codexHome, configContents = null) {
  const defaultBase = 'https://chatgpt.com/backend-api';
  let content = configContents;
  if (content === null && codexHome) {
    const cfgPath = join(codexHome, 'config.toml');
    if (existsSync(cfgPath)) {
      try {
        content = readFileSync(cfgPath, 'utf8');
      } catch {}
    }
  }
  let baseUrl = defaultBase;
  if (typeof content === 'string') {
    for (const rawLine of content.split(/\r?\n/)) {
      const noComment = rawLine.split('#')[0].trim();
      if (!noComment) continue;
      const eqIdx = noComment.indexOf('=');
      if (eqIdx === -1) continue;
      const key = noComment.slice(0, eqIdx).trim();
      if (key !== 'chatgpt_base_url') continue;
      let val = noComment.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1).trim();
      }
      if (val) baseUrl = val;
      break;
    }
  }
  let normalized = baseUrl.replace(/\/+$/, '') || defaultBase;
  if (
    (normalized.startsWith('https://chatgpt.com') || normalized.startsWith('https://chat.openai.com')) &&
    !normalized.includes('/backend-api')
  ) {
    normalized += '/backend-api';
  }
  const usagePath = normalized.includes('/backend-api') ? '/wham/usage' : '/api/codex/usage';
  return {
    baseUrl: normalized,
    usageUrl: `${normalized}${usagePath}`,
    resetCreditsUrl: `${normalized}/wham/rate-limit-reset-credits`,
  };
}

function findNewestCodexRateLimits(codexHome, nowMs = Date.now()) {
  try {
    const maxAgeMs = 30 * 86400 * 1000;
    const candidates = [];

    function walk(dir, depth) {
      if (depth > 4 || !existsSync(dir)) return;
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, ent.name);
        if (ent.isDirectory()) walk(p, depth + 1);
        else if (ent.name.endsWith('.jsonl') || ent.name.endsWith('.jsonl.zst')) {
          try {
            const st = statSync(p);
            if (nowMs - st.mtimeMs <= maxAgeMs) {
              candidates.push({ p, mtimeMs: st.mtimeMs });
            }
          } catch {}
        }
      }
    }

    walk(join(codexHome, 'sessions'), 0);
    if (candidates.length === 0) {
      walk(join(codexHome, 'archived_sessions'), 0);
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const { p } of candidates.slice(0, 40)) {
      let raw;
      try {
        raw = p.endsWith('.jsonl.zst')
          ? zstdDecompressSync(readFileSync(p)).toString('utf8')
          : readFileSync(p, 'utf8');
      } catch {
        continue;
      }
      const lines = raw.trim().split('\n');
      const minIdx = Math.max(0, lines.length - 4000);
      let fallbackRl = null;
      for (let i = lines.length - 1; i >= minIdx; i -= 1) {
        try {
          const obj = JSON.parse(lines[i]);
          const rl = obj?.payload?.rate_limits;
          if (
            rl &&
            (typeof rl.primary?.used_percent === 'number' || typeof rl.secondary?.used_percent === 'number')
          ) {
            if (!rl.limit_id || rl.limit_id === 'codex') {
              return rl;
            }
            if (!fallbackRl) fallbackRl = rl;
          }
        } catch {}
      }
      if (fallbackRl) return fallbackRl;
    }
  } catch {}
  return null;
}

export async function fetchCodexQuota(nowMs = Date.now(), { allowNetwork = true } = {}) {
  const empty = {
    accountEmail: null,
    planTitle: null,
    quotaWindows: [],
    resetCreditsText: null,
    quotaHint: null,
    _ok: false,
    _errorKind: null,
  };
  try {
    const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
    const authPaths = resolveCodexAuthCandidatePaths(codexHome);
    let accessToken = null;
    let accountId = null;
    let accountEmail = null;
    let planTitle = null;
    let isApiKeyOnly = false;

    for (const authPath of authPaths) {
      if (!existsSync(authPath)) continue;
      try {
        const auth = JSON.parse(readFileSync(authPath, 'utf8'));
        accessToken = auth?.tokens?.access_token || null;
        accountId = auth?.tokens?.account_id || null;
        const idClaims = decodeJwtPayload(auth?.tokens?.id_token);
        accountEmail = idClaims?.email || null;
        planTitle = formatCodexPlan(idClaims?.['https://api.openai.com/auth']?.chatgpt_plan_type);
        if (!accessToken && typeof auth?.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY.trim()) {
          isApiKeyOnly = true;
        }
        if (accessToken || accountEmail || isApiKeyOnly) break;
      } catch {}
    }

    let rateLimit = null;
    let resetCreditsText = null;
    let networkErrorKind = null;

    if (allowNetwork && accessToken) {
      const { usageUrl, resetCreditsUrl } = resolveCodexUsageUrl(codexHome);
      const headers = {
        Authorization: `Bearer ${accessToken}`,
        ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
        'User-Agent': 'codex-cli',
        Accept: 'application/json',
      };
      const res = await httpRequestJson(usageUrl, { headers, timeoutMs: 8000 });
      if (res.ok && res.data) {
        const data = res.data;
        if (data?.email) accountEmail = data.email;
        if (data?.plan_type) planTitle = formatCodexPlan(data.plan_type);
        if (data?.rate_limit && (data.rate_limit.primary_window || data.rate_limit.secondary_window)) {
          rateLimit = data.rate_limit;
        } else if (Array.isArray(data?.additional_rate_limits)) {
          const extra = data.additional_rate_limits.find(
            (e) => e?.rate_limit?.primary_window || e?.rate_limit?.secondary_window
          );
          if (extra?.rate_limit) rateLimit = extra.rate_limit;
        }
        const avail = data?.rate_limit_reset_credits?.available_count;
        if (typeof avail === 'number' && avail > 0) {
          resetCreditsText = `${avail} 次可用`;
        } else if (data?.credits?.unlimited) {
          resetCreditsText = '无限额度';
        } else if (data?.credits?.has_credits && data?.credits?.balance !== undefined && data?.credits?.balance !== null) {
          const bal = Number(data.credits.balance);
          if (Number.isFinite(bal) && bal > 0) resetCreditsText = `余额 $${bal.toFixed(2)}`;
        }
        if (!resetCreditsText && rateLimit && !data?.rate_limit_reset_credits) {
          const rcRes = await httpRequestJson(resetCreditsUrl, {
            headers: {
              ...headers,
              'OpenAI-Beta': 'codex-1',
              originator: 'Codex Desktop',
            },
            timeoutMs: 3000,
          });
          const rcAvail = rcRes?.data?.available_count;
          if (typeof rcAvail === 'number' && rcAvail > 0) {
            resetCreditsText = `${rcAvail} 次可用`;
          }
        }
      } else {
        networkErrorKind = res.errorKind;
      }
    }

    if (!rateLimit) {
      const localRl = findNewestCodexRateLimits(codexHome, nowMs);
      if (localRl) {
        if (localRl.plan_type) planTitle = formatCodexPlan(localRl.plan_type);
        const normalizeLocalWin = (w) => {
          if (!w || typeof w.used_percent !== 'number') return null;
          const resetSec = typeof w.resets_at === 'number' && w.resets_at > 0 ? w.resets_at : null;
          const elapsedReset = resetSec !== null && resetSec * 1000 <= nowMs;
          return {
            used_percent: elapsedReset ? 0 : w.used_percent,
            limit_window_seconds:
              typeof w.window_minutes === 'number' && w.window_minutes > 0 ? w.window_minutes * 60 : null,
            reset_at: elapsedReset ? null : resetSec,
          };
        };
        rateLimit = {
          primary_window: normalizeLocalWin(localRl.primary),
          secondary_window: normalizeLocalWin(localRl.secondary),
        };
      }
    }

    const quotaWindows = normalizeCodexRateWindows(rateLimit, nowMs);

    let quotaHint = null;
    if (quotaWindows.length === 0) {
      if (isApiKeyOnly) {
        quotaHint = '当前使用 API Key 按量模式 · 无固定个人会话限额';
      } else if (networkErrorKind === 'unauthorized') {
        quotaHint = 'Codex 登录凭证已过期，请在 Codex 重新登录';
      } else if (networkErrorKind === 'network' || networkErrorKind === 'http') {
        quotaHint = '无法连接 ChatGPT 配额接口，请检查网络或系统代理';
      } else if (accessToken || accountEmail) {
        quotaHint = '暂无可用配额窗口 · 点击刷新或运行一轮 Codex 后同步';
      }
    }

    return {
      accountEmail,
      planTitle,
      quotaWindows,
      resetCreditsText,
      quotaHint,
      _ok: quotaWindows.length > 0 || networkErrorKind === null,
      _errorKind: quotaWindows.length > 0 ? null : networkErrorKind,
    };
  } catch {
    return empty;
  }
}

function postLocalLsJson(port, csrf, path) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' },
    });
    const req = https.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        rejectUnauthorized: false,
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'x-codeium-csrf-token': csrf,
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 1500,
      },
      (res) => {
        let chunks = '';
        res.on('data', (d) => {
          chunks += d;
        });
        res.on('end', () => resolve({ status: res.statusCode, body: chunks }));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.write(body);
    req.end();
  });
}

function parseIsoMs(str) {
  if (!str) return null;
  const ms = Date.parse(str);
  return Number.isFinite(ms) ? ms : null;
}

export async function fetchAntigravityQuota(nowMs = Date.now()) {
  const empty = { accountEmail: null, planTitle: null, quotaWindows: [], resetCreditsText: null };
  try {
    const { stdout: psOut } = await execFileAsync('/bin/ps', ['-ax', '-o', 'pid=,command='], {
      timeout: 2000,
    });
    const lsLines = psOut
      .split('\n')
      .filter((l) => l.includes('language_server') && l.includes('csrf_token'));
    if (lsLines.length === 0) return empty;

    for (const line of lsLines.slice(0, 3)) {
      const mPid = line.trim().match(/^(\d+)\s+/);
      const mCsrf = line.match(/--csrf_token[=\s]+([^\s]+)/);
      if (!mPid || !mCsrf) continue;
      const pid = mPid[1];
      const csrf = mCsrf[1];

      let lsofOut = '';
      try {
        ({ stdout: lsofOut } = await execFileAsync(
          '/usr/sbin/lsof',
          ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', pid],
          { timeout: 2000 }
        ));
      } catch {
        continue;
      }

      const ports = [...new Set([...lsofOut.matchAll(/:(\d+)\s+\(LISTEN\)/g)].map((m) => Number(m[1])))];
      for (const port of ports) {
        try {
          const uRes = await postLocalLsJson(
            port,
            csrf,
            '/exa.language_server_pb.LanguageServerService/GetUserStatus'
          );
          if (uRes.status !== 200) continue;
          const uJson = JSON.parse(uRes.body);
          const us = uJson?.userStatus;
          if (!us) continue;

          const accountEmail = us.email || null;
          const planTitle = us.userTier?.name || us.planStatus?.planInfo?.planName || null;

          let quotaWindows = [];
          try {
            const qRes = await postLocalLsJson(
              port,
              csrf,
              '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary'
            );
            if (qRes.status === 200) {
              const qJson = JSON.parse(qRes.body);
              const groups = qJson?.response?.groups || qJson?.groups || [];
              const bucketMap = new Map();
              for (const g of groups) {
                for (const b of g.buckets || []) {
                  if (!b.disabled && typeof b.remainingFraction === 'number') {
                    bucketMap.set(b.bucketId || b.id, b);
                  }
                }
              }

              const addBucket = (bucketId, id, title, defaultSecs) => {
                const b = bucketMap.get(bucketId);
                if (!b) return null;
                const wSec = b.window === 'weekly' ? 604800 : b.window === '5h' ? 18000 : defaultSecs;
                return computeQuotaWindow({
                  id,
                  title,
                  remainingPct: b.remainingFraction * 100,
                  windowSeconds: wSec,
                  resetAtMs: parseIsoMs(b.resetTime),
                  nowMs,
                });
              };

              const g5h = addBucket('gemini-5h', 'ag-gemini-5h', 'Gemini 会话', 18000);
              if (g5h) quotaWindows.push(g5h);
              const gWk = addBucket('gemini-weekly', 'ag-gemini-weekly', 'Gemini 每周', 604800);
              if (gWk) quotaWindows.push(gWk);

              const p5h = bucketMap.get('3p-5h');
              const pWk = bucketMap.get('3p-weekly');
              if (p5h && pWk) {
                const chosen = p5h.remainingFraction <= pWk.remainingFraction ? p5h : pWk;
                const wSec = chosen.window === '5h' ? 18000 : 604800;
                const win = computeQuotaWindow({
                  id: 'ag-claude-gpt',
                  title: 'Claude / GPT',
                  remainingPct: chosen.remainingFraction * 100,
                  windowSeconds: wSec,
                  resetAtMs: parseIsoMs(chosen.resetTime),
                  nowMs,
                });
                if (win) quotaWindows.push(win);
              } else {
                const cWin =
                  addBucket('3p-5h', 'ag-claude-gpt', 'Claude / GPT', 18000) ||
                  addBucket('3p-weekly', 'ag-claude-gpt', 'Claude / GPT', 604800);
                if (cWin) quotaWindows.push(cWin);
              }

              const argon = addBucket('gemini-argon-wtu-weekly', 'ag-argon-weekly', 'Gemini 4 Argon', 604800);
              if (argon) quotaWindows.push(argon);
            }
          } catch {}

          // Fallback to GetUserStatus model configs if summary endpoint had no buckets
          if (quotaWindows.length === 0) {
            const configs = us.cascadeModelConfigData?.clientModelConfigs || [];
            let bestGemini = null;
            let bestClaude = null;
            for (const c of configs) {
              const frac = c?.quotaInfo?.remainingFraction;
              if (typeof frac !== 'number') continue;
              const label = String(c.label || '').toLowerCase();
              const item = { frac, resetAtMs: parseIsoMs(c?.quotaInfo?.resetTime) };
              if (label.includes('claude') || label.includes('gpt')) {
                if (!bestClaude || item.frac < bestClaude.frac) bestClaude = item;
              } else if (label.includes('gemini')) {
                if (!bestGemini || item.frac < bestGemini.frac) bestGemini = item;
              }
            }
            if (bestGemini) {
              quotaWindows.push(
                computeQuotaWindow({
                  id: 'ag-gemini',
                  title: 'Gemini Models',
                  remainingPct: bestGemini.frac * 100,
                  windowSeconds: 18000,
                  resetAtMs: bestGemini.resetAtMs,
                  nowMs,
                })
              );
            }
            if (bestClaude) {
              quotaWindows.push(
                computeQuotaWindow({
                  id: 'ag-claude-gpt',
                  title: 'Claude / GPT',
                  remainingPct: bestClaude.frac * 100,
                  windowSeconds: 18000,
                  resetAtMs: bestClaude.resetAtMs,
                  nowMs,
                })
              );
            }
          }

          return { accountEmail, planTitle, quotaWindows, resetCreditsText: null };
        } catch {}
      }
    }
  } catch {}
  return empty;
}

function normalizeCursorCookieInput(raw) {
  if (typeof raw !== 'string') return null;
  let text = raw.trim();
  if (!text) return null;
  if (text.toLowerCase().startsWith('cookie:')) {
    text = text.slice(7).trim();
  }
  if (!text) return null;
  if (text.includes('WorkosCursorSessionToken=')) return text;
  if (text.includes('=')) return text;
  return `WorkosCursorSessionToken=${encodeURIComponent(text)}`;
}

function readCodexBarCursorSessionCookie() {
  try {
    const p = join(homedir(), 'Library/Application Support/CodexBar/cursor-session.json');
    if (!existsSync(p)) return null;
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    if (typeof raw?.cookieHeader === 'string' && raw.cookieHeader.trim()) {
      return raw.cookieHeader.trim();
    }
    if (Array.isArray(raw?.cookies)) {
      const pairs = raw.cookies
        .filter((c) => c && c.name && c.value)
        .map((c) => `${c.name}=${c.value}`);
      if (pairs.length > 0) return pairs.join('; ');
    }
    if (Array.isArray(raw)) {
      const pairs = raw
        .filter((c) => c && c.name && c.value)
        .map((c) => `${c.name}=${c.value}`);
      if (pairs.length > 0) return pairs.join('; ');
    }
  } catch {}
  return null;
}

export function decryptCursorSafeStorageToken(encryptedValue, passwords = []) {
  if (typeof encryptedValue !== 'string') return null;
  const prefix = 'cursor-safe-storage:v1:';
  if (!encryptedValue.startsWith(prefix)) return null;
  const b64 = encryptedValue.slice(prefix.length).trim();
  if (!b64) return null;
  const encrypted = Buffer.from(b64, 'base64');
  if (encrypted.length <= 3 || encrypted.subarray(0, 3).toString('utf8') !== 'v10') return null;
  const payload = encrypted.subarray(3);
  if (payload.length === 0 || payload.length % 16 !== 0) return null;
  const iv = Buffer.alloc(16, 0x20);

  for (const password of passwords) {
    if (typeof password !== 'string' || !password) continue;
    try {
      const key = pbkdf2Sync(Buffer.from(password, 'utf8'), Buffer.from('saltysalt', 'utf8'), 1003, 16, 'sha1');
      const decipher = createDecipheriv('aes-128-cbc', key, iv);
      const dec = Buffer.concat([decipher.update(payload), decipher.final()]).toString('utf8').trim();
      if (dec && dec.split('.').length >= 3) {
        return dec;
      }
    } catch {}
  }
  return null;
}

function decodeSqliteItemValue(val) {
  if (typeof val === 'string') return val;
  if (val instanceof Uint8Array || Buffer.isBuffer(val)) {
    const buf = Buffer.from(val);
    if (buf.length >= 2 && buf.length % 2 === 0) {
      let looksUtf16Le = true;
      for (let i = 0; i < buf.length; i += 2) {
        if (buf[i] < 1 || buf[i] >= 128 || buf[i + 1] !== 0) {
          looksUtf16Le = false;
          break;
        }
      }
      if (looksUtf16Le) return buf.toString('utf16le');
    }
    return buf.toString('utf8');
  }
  return null;
}

function readCursorStateDb(dbPath) {
  if (!existsSync(dbPath)) return null;
  const openRead = (target) => {
    const db = new DatabaseSync(target, { readOnly: true });
    try {
      const getVal = (key) => decodeSqliteItemValue(db.prepare('SELECT value FROM ItemTable WHERE key = ? LIMIT 1').get(key)?.value);
      return {
        email: getVal('cursorAuth/cachedEmail') || null,
        membership: getVal('cursorAuth/stripeMembershipType') || null,
        cachedTeam: getVal('cursorAuth/cachedTeam') || null,
        accessToken: getVal('cursorAuth/accessToken') || null,
        authId: getVal('cursorAuth/stripeMembershipAuthId') || null,
      };
    } finally {
      db.close();
    }
  };
  try {
    return openRead(dbPath);
  } catch {
    if (!existsSync(`${dbPath}-wal`) && !existsSync(`${dbPath}-shm`)) {
      try {
        return openRead(`file://${encodeURI(dbPath)}?immutable=1`);
      } catch {}
    }
    return null;
  }
}

function resolveCursorJwtCookie(rawToken, { safeStoragePasswords = [] } = {}) {
  if (typeof rawToken !== 'string') return null;
  let trimmed = rawToken.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('cursor-safe-storage:')) {
    const decrypted = decryptCursorSafeStorageToken(trimmed, safeStoragePasswords);
    if (!decrypted) return { encryptedNeedsKeychain: true };
    trimmed = decrypted;
  }
  const payload = decodeJwtPayload(trimmed);
  if (!payload || typeof payload.sub !== 'string') return null;
  if (typeof payload.exp === 'number' && payload.exp * 1000 <= Date.now() + 60_000) {
    return null;
  }
  const userId = payload.sub.split('|').filter(Boolean).pop();
  if (!userId) return null;
  return {
    userId,
    email: typeof payload.email === 'string' ? payload.email : null,
    cookieHeader: `WorkosCursorSessionToken=${userId}%3A%3A${trimmed}`,
  };
}

function readCursorAgentCookie(homeDir = homedir()) {
  const cfgHome =
    process.env.XDG_CONFIG_HOME?.startsWith('/') ? process.env.XDG_CONFIG_HOME : join(homeDir, '.config');
  for (const p of [join(cfgHome, 'cursor', 'auth.json'), join(homeDir, '.cursor', 'auth.json')]) {
    try {
      if (!existsSync(p)) continue;
      const obj = JSON.parse(readFileSync(p, 'utf8'));
      const res = resolveCursorJwtCookie(obj?.accessToken || obj?.token);
      if (res?.cookieHeader) return res.cookieHeader;
    } catch {}
  }
  return null;
}

async function cursorApiFetch(
  url,
  cookieHeader,
  { method = 'GET', body = null, timeoutMs = 8000 } = {}
) {
  const headers = {
    Cookie: cookieHeader,
    Accept: 'application/json',
    Origin: 'https://cursor.com',
    Referer: 'https://cursor.com/dashboard?tab=usage',
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  };
  if (body !== null) {
    headers['Content-Type'] = 'application/json';
  }
  return httpRequestJson(url, { method, headers, body, timeoutMs });
}

export async function cursorApiJson(
  url,
  cookieHeader,
  { method = 'GET', body = null, timeoutMs = 8000 } = {}
) {
  const res = await cursorApiFetch(url, cookieHeader, { method, body, timeoutMs });
  return res.ok ? res.data : null;
}

export async function resolveCursorCookieCandidates({
  cursorCookie = null,
  safeStoragePasswords = [],
  allowSilentKeychain = false,
  homeDir = homedir(),
} = {}) {
  const seen = new Set();
  const candidates = [];
  let hasEncryptedTokenWithoutKey = false;
  let dbMeta = null;

  const pushCandidate = (hdr, source) => {
    const normalized = normalizeCursorCookieInput(hdr);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push({ cookieHeader: normalized, source });
  };

  pushCandidate(cursorCookie, 'config');

  const dbPath = join(homeDir, 'Library/Application Support/Cursor/User/globalStorage/state.vscdb');
  dbMeta = readCursorStateDb(dbPath);
  if (dbMeta?.accessToken) {
    let passwords = [...safeStoragePasswords];
    if (
      dbMeta.accessToken.startsWith('cursor-safe-storage:') &&
      passwords.length === 0 &&
      allowSilentKeychain
    ) {
      const helperBin = resolveAppHelperBin();
      if (helperBin) {
        const res = await runProcessWithStdin(helperBin, ['--read-cursor-safe-storage'], '', 2000);
        if (res.ok && res.stdout.trim()) {
          try {
            const parsed = JSON.parse(res.stdout);
            if (Array.isArray(parsed?.passwords)) {
              passwords = parsed.passwords.filter((p) => typeof p === 'string' && p.length > 0);
            }
          } catch {}
        }
      }
    }
    const jwtRes = resolveCursorJwtCookie(dbMeta.accessToken, { safeStoragePasswords: passwords });
    if (jwtRes?.cookieHeader) {
      pushCandidate(jwtRes.cookieHeader, 'cursor-app-db');
    } else if (jwtRes?.encryptedNeedsKeychain) {
      hasEncryptedTokenWithoutKey = true;
    }
  }

  pushCandidate(readCodexBarCursorSessionCookie(), 'codexbar-cache');
  pushCandidate(readCursorAgentCookie(homeDir), 'cursor-agent');

  return { candidates, dbMeta, hasEncryptedTokenWithoutKey };
}

export function resolveCursorCookieHeader(cursorCookie = null) {
  const direct = normalizeCursorCookieInput(cursorCookie);
  if (direct) return direct;
  const dbPath = join(homedir(), 'Library/Application Support/Cursor/User/globalStorage/state.vscdb');
  const dbMeta = readCursorStateDb(dbPath);
  const jwtRes = resolveCursorJwtCookie(dbMeta?.accessToken);
  if (jwtRes?.cookieHeader) return jwtRes.cookieHeader;
  return readCodexBarCursorSessionCookie() || readCursorAgentCookie();
}

export function parseCursorQuotaSummary(
  summary,
  {
    nowMs = Date.now(),
    accountEmail = null,
    planTitle = null,
    teamBudget = null,
    reqUsage = null,
    sandUsage = null,
    unifiedUsage = null,
  } = {}
) {
  if (!summary || typeof summary !== 'object') {
    return { accountEmail, planTitle, quotaWindows: [], resetCreditsText: null };
  }

  const resolvedEmail = accountEmail || summary.email || null;
  const startMs = summary.billingCycleStart ? Date.parse(summary.billingCycleStart) : NaN;
  const endMs = summary.billingCycleEnd ? Date.parse(summary.billingCycleEnd) : NaN;
  const cycleSecs =
    Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
      ? (endMs - startMs) / 1000
      : 30 * 86400;
  const resetAtMs = Number.isFinite(endMs) ? endMs : null;

  const plan = summary.individualUsage?.plan;
  const overall = summary.individualUsage?.overall;
  const pooled = summary.teamUsage?.pooled;

  const hasAutoPct = typeof plan?.autoPercentUsed === 'number' && Number.isFinite(plan.autoPercentUsed);
  const hasApiPct = typeof plan?.apiPercentUsed === 'number' && Number.isFinite(plan.apiPercentUsed);
  const hasTotalPct = typeof plan?.totalPercentUsed === 'number' && Number.isFinite(plan.totalPercentUsed);
  const hasPlanCents = typeof plan?.limit === 'number' && plan.limit > 0 && typeof plan?.used === 'number';

  const sandStartMs = sandUsage?.currentPeriodStart ? Date.parse(sandUsage.currentPeriodStart) : NaN;
  const sandResetMs = sandUsage?.nextResetTimestampUtc ? Date.parse(sandUsage.nextResetTimestampUtc) : NaN;
  const sandWindowSecs =
    Number.isFinite(sandStartMs) && Number.isFinite(sandResetMs) && sandResetMs > sandStartMs
      ? (sandResetMs - sandStartMs) / 1000
      : 7 * 86400;
  const sandHasLimit =
    typeof sandUsage?.includedLimitZero === 'boolean'
      ? !sandUsage.includedLimitZero
      : Boolean(sandUsage?.hasNonZeroIncludedLimit);
  const sandUsedPct =
    typeof sandUsage?.usagePercent === 'number' && Number.isFinite(sandUsage.usagePercent)
      ? sandUsage.usagePercent
      : null;
  const hasUnifiedWeekly = Boolean(
    sandUsage?.isUnified &&
      sandHasLimit &&
      sandUsedPct !== null &&
      Number.isFinite(sandResetMs) &&
      sandResetMs > nowMs
  );
  const hasGrokBotPool = Boolean(
    !hasUnifiedWeekly &&
      sandHasLimit &&
      sandUsedPct !== null &&
      (sandUsage?.grokPlanLabel || (Number.isFinite(sandResetMs) && sandResetMs > nowMs))
  );

  const quotaWindows = [];

  if (hasUnifiedWeekly && !hasAutoPct && !hasApiPct) {
    const win = computeQuotaWindow({
      id: 'cursor-weekly',
      title: '每周共享池',
      usedPct: sandUsedPct,
      windowSeconds: sandWindowSecs,
      resetAtMs: sandResetMs,
      nowMs,
    });
    if (win) quotaWindows.push(win);
  } else if (hasAutoPct || hasApiPct) {
    // Cursor's dual-pool plans track Auto/Composer ("Cursor Models") and third-party API ("Other Models")
    // separately; surfacing both pools matches Cursor's dashboard and avoids mixing the $20 API pool cap into total%.
    if (hasAutoPct) {
      const autoWin = computeQuotaWindow({
        id: 'cursor-auto',
        title: 'Cursor 模型',
        usedPct: plan.autoPercentUsed,
        windowSeconds: cycleSecs,
        resetAtMs,
        nowMs,
      });
      if (autoWin) quotaWindows.push(autoWin);
    }
    if (hasApiPct) {
      const apiWin = computeQuotaWindow({
        id: 'cursor-api',
        title: '其他模型',
        usedPct: plan.apiPercentUsed,
        windowSeconds: cycleSecs,
        resetAtMs,
        nowMs,
      });
      if (apiWin) quotaWindows.push(apiWin);
    }
  } else {
    let usedUSD = null;
    let limitUSD = null;
    let usedPct = null;
    let includeBudgetNote = false;

    if (
      teamBudget &&
      Number.isFinite(teamBudget.limitUSD) &&
      teamBudget.limitUSD > 0 &&
      Number.isFinite(teamBudget.usedUSD) &&
      teamBudget.usedUSD >= 0
    ) {
      usedUSD = teamBudget.usedUSD;
      limitUSD = teamBudget.limitUSD;
      usedPct = (usedUSD / limitUSD) * 100;
      includeBudgetNote = true;
    } else if (hasTotalPct || hasPlanCents) {
      if (hasTotalPct) {
        usedPct = plan.totalPercentUsed;
      } else {
        usedPct = (plan.used / plan.limit) * 100;
      }
      if (hasPlanCents) {
        usedUSD = plan.used / 100;
        limitUSD = plan.limit / 100;
        const pctFromCents = (usedUSD / limitUSD) * 100;
        // Only attach "$used / $limit" when consistent with usedPct so API caps never contradict percentage bars.
        includeBudgetNote = !hasTotalPct || Math.abs(pctFromCents - usedPct) < 5;
      }
    } else if (overall && typeof overall.limit === 'number' && overall.limit > 0 && typeof overall.used === 'number') {
      usedUSD = overall.used / 100;
      limitUSD = overall.limit / 100;
      usedPct = (overall.used / overall.limit) * 100;
      includeBudgetNote = true;
    } else if (pooled && typeof pooled.limit === 'number' && pooled.limit > 0 && typeof pooled.used === 'number') {
      usedUSD = pooled.used / 100;
      limitUSD = pooled.limit / 100;
      usedPct = (pooled.used / pooled.limit) * 100;
      includeBudgetNote = true;
    }

    if (usedPct !== null) {
      const budgetNote =
        includeBudgetNote && usedUSD !== null && limitUSD !== null && limitUSD > 0
          ? `已用 $${usedUSD.toFixed(2)} / $${Math.round(limitUSD)}`
          : null;
      const win = computeQuotaWindow({
        id: 'cursor-plan',
        title: '套餐额度',
        usedPct,
        windowSeconds: cycleSecs,
        resetAtMs,
        nowMs,
        extraNote: budgetNote,
      });
      if (win) quotaWindows.push(win);
    } else if (reqUsage) {
      const maxReq = Number(reqUsage?.['gpt-4']?.maxRequestUsage);
      const usedReq = Number(reqUsage?.['gpt-4']?.numRequestsTotal ?? reqUsage?.['gpt-4']?.numRequests);
      if (Number.isFinite(maxReq) && maxReq > 0 && Number.isFinite(usedReq) && usedReq >= 0) {
        const win = computeQuotaWindow({
          id: 'cursor-requests',
          title: '快速请求',
          usedPct: (usedReq / maxReq) * 100,
          windowSeconds: cycleSecs,
          resetAtMs,
          nowMs,
          extraNote: `${Math.round(usedReq)} / ${Math.round(maxReq)} 次`,
        });
        if (win) quotaWindows.push(win);
      }
    }
  }

  // Append standalone Grok Bot / Sand weekly quota pool when present alongside dual-pool plans.
  if (hasGrokBotPool) {
    const rawLabel = typeof sandUsage?.grokPlanLabel === 'string' && sandUsage.grokPlanLabel.trim()
      ? sandUsage.grokPlanLabel.trim().replace(/\s+plan$/i, '')
      : 'Grok Bot';
    const grokWin = computeQuotaWindow({
      id: 'cursor-grok-bot',
      title: rawLabel,
      usedPct: sandUsedPct,
      windowSeconds: sandWindowSecs,
      resetAtMs: Number.isFinite(sandResetMs) ? sandResetMs : null,
      nowMs,
    });
    if (grokWin) quotaWindows.push(grokWin);
  }

  let resetCreditsText = null;
  if (
    unifiedUsage &&
    typeof unifiedUsage.usedCents === 'number' &&
    unifiedUsage.usedCents >= 0 &&
    typeof unifiedUsage.limitCents === 'number' &&
    unifiedUsage.limitCents > 0
  ) {
    resetCreditsText = `$${(unifiedUsage.usedCents / 100).toFixed(2)} / $${(unifiedUsage.limitCents / 100).toFixed(2)}`;
  } else {
    const indOnDemand = summary.individualUsage?.onDemand;
    const teamOnDemand = summary.teamUsage?.onDemand;
    const onDemand =
      indOnDemand && (typeof indOnDemand.used === 'number' || typeof indOnDemand.limit === 'number')
        ? indOnDemand
        : teamOnDemand;
    const onDemandUsed = onDemand?.used;
    const onDemandLimit = onDemand?.limit;
    if (
      typeof onDemandUsed === 'number' &&
      onDemandUsed >= 0 &&
      onDemand?.enabled !== false &&
      (onDemandUsed > 0 || (typeof onDemandLimit === 'number' && onDemandLimit > 0))
    ) {
      const usdStr = `$${(onDemandUsed / 100).toFixed(2)}`;
      resetCreditsText =
        typeof onDemandLimit === 'number' && onDemandLimit > 0
          ? `${usdStr} / $${(onDemandLimit / 100).toFixed(2)}`
          : `${usdStr} / 无上限`;
    }
  }

  return {
    accountEmail: resolvedEmail,
    planTitle: planTitle || (summary.membershipType ? String(summary.membershipType) : null),
    quotaWindows,
    resetCreditsText,
  };
}

export async function fetchCursorQuota(
  nowMs = Date.now(),
  { allowNetwork = true, cursorCookie = null, safeStoragePasswords = [] } = {}
) {
  let accountEmail = null;
  let planTitle = null;
  let teamId = null;
  let userId = null;

  const { candidates, dbMeta, hasEncryptedTokenWithoutKey } = await resolveCursorCookieCandidates({
    cursorCookie,
    safeStoragePasswords,
    allowSilentKeychain: allowNetwork,
  });

  if (dbMeta) {
    accountEmail = dbMeta.email || null;
    const membership = dbMeta.membership;
    let teamName = null;
    try {
      const teamObj = JSON.parse(dbMeta.cachedTeam || 'null');
      teamName = teamObj?.name || null;
      if (typeof teamObj?.teamId === 'number') teamId = teamObj.teamId;
    } catch {}
    if (typeof dbMeta.authId === 'string' && dbMeta.authId.includes('|')) {
      userId = dbMeta.authId.split('|').filter(Boolean).pop() || null;
    }
    const planNames = {
      enterprise: 'Enterprise',
      pro: 'Pro',
      pro_plus: 'Pro+',
      ultra: 'Ultra',
      team: 'Team',
      free: 'Free',
      free_trial: 'Pro Trial',
      hobby: 'Hobby',
    };
    const basePlan = membership ? planNames[String(membership).toLowerCase()] || String(membership) : null;
    planTitle = basePlan && teamName ? `${basePlan} · ${teamName}` : basePlan || teamName;
  }

  if (candidates.length === 0 || !allowNetwork) {
    let quotaHint = null;
    if (allowNetwork) {
      quotaHint = hasEncryptedTokenWithoutKey
        ? '检测到本机 Cursor 已登录，请点下方「读取本机登录」或「网页登录」授权同步'
        : '需连接 Cursor 会话，才可同步套餐剩余百分比与重置时间';
    }
    return {
      accountEmail,
      planTitle,
      quotaWindows: [],
      resetCreditsText: null,
      quotaHint,
      hasEncryptedTokenWithoutKey,
      _ok: false,
      _errorKind: candidates.length === 0 ? 'no_credentials' : null,
    };
  }

  let activeCookie = null;
  let summary = null;
  let authMe = null;
  let sandUsage = null;
  let lastErrorKind = null;

  for (const cand of candidates) {
    const hdr = cand.cookieHeader;
    if (!userId) {
      try {
        const m = decodeURIComponent(hdr).match(/WorkosCursorSessionToken=([^;\s]+?)::/);
        if (m?.[1]) userId = m[1];
      } catch {}
    }

    const [sumRes, meRes, sandRes] = await Promise.all([
      cursorApiFetch('https://cursor.com/api/usage-summary', hdr, { timeoutMs: 8000 }),
      cursorApiFetch('https://cursor.com/api/auth/me', hdr, { timeoutMs: 6000 }),
      cursorApiFetch('https://cursor.com/api/dashboard/get-sand-usage-status', hdr, {
        method: 'POST',
        body: {},
        timeoutMs: 5000,
      }),
    ]);

    if (sumRes.ok && sumRes.data) {
      activeCookie = hdr;
      summary = sumRes.data;
      authMe = meRes.ok ? meRes.data : null;
      sandUsage = sandRes.ok ? sandRes.data : null;
      break;
    }

    lastErrorKind = sumRes.errorKind;
    if (sumRes.errorKind === 'network') {
      break;
    }
  }

  if (!summary || !activeCookie) {
    let quotaHint = null;
    if (lastErrorKind === 'unauthorized') {
      quotaHint = hasEncryptedTokenWithoutKey
        ? '当前 Cookie 已过期，请点下方「读取本机登录」或「重新登录」'
        : 'Cursor 会话已过期，请点击下方重新登录同步额度';
    } else if (lastErrorKind === 'network' || lastErrorKind === 'http') {
      quotaHint = '无法连接 cursor.com 配额接口，请检查网络或系统代理';
    }
    return {
      accountEmail,
      planTitle,
      quotaWindows: [],
      resetCreditsText: null,
      quotaHint,
      hasEncryptedTokenWithoutKey,
      _ok: false,
      _errorKind: lastErrorKind,
    };
  }

  if (authMe?.email) accountEmail = authMe.email;
  else if (!accountEmail && summary.email) accountEmail = summary.email;
  if (!userId && typeof authMe?.sub === 'string' && authMe.sub) {
    userId = authMe.sub.split('|').filter(Boolean).pop() || null;
  }

  const plan = summary.individualUsage?.plan;
  const hasPlanData = Boolean(
    plan &&
      (typeof plan.autoPercentUsed === 'number' ||
        typeof plan.apiPercentUsed === 'number' ||
        typeof plan.totalPercentUsed === 'number' ||
        (typeof plan.limit === 'number' && plan.limit > 0))
  );

  let unifiedUsage = null;
  if (summary.limitType === 'user' && summary.isUnlimited === false) {
    const v2Res = await cursorApiFetch(
      'https://cursor.com/api/dashboard/v2/usage-status?scope=user',
      activeCookie,
      { timeoutMs: 5000 }
    );
    if (v2Res.ok && v2Res.data && typeof v2Res.data.usedCents === 'number') {
      unifiedUsage = v2Res.data;
    }
  }

  let teamBudget = null;
  if (
    !hasPlanData &&
    (summary.membershipType === 'enterprise' ||
      summary.membershipType === 'team' ||
      summary.isTeam ||
      summary.limitType === 'team') &&
    (accountEmail || userId)
  ) {
    const teamsRes = await cursorApiJson('https://cursor.com/api/dashboard/teams', activeCookie, {
      method: 'POST',
      body: {},
    });
    const teams = Array.isArray(teamsRes?.teams) ? teamsRes.teams : [];
    const targetTeamId =
      teams.find((t) => t.id === teamId)?.id ??
      (teams.length === 1 ? teams[0]?.id : teamId);
    if (typeof targetTeamId === 'number') {
      const spendRes = await cursorApiJson('https://cursor.com/api/dashboard/get-team-spend', activeCookie, {
        method: 'POST',
        body: {
          teamId: targetTeamId,
          page: 1,
          pageSize: 50,
          ...(accountEmail ? { search: accountEmail } : {}),
        },
      });
      const members = Array.isArray(spendRes?.teamMemberSpend) ? spendRes.teamMemberSpend : [];
      const me = members.find(
        (m) =>
          (m.email && accountEmail && m.email.toLowerCase() === accountEmail.toLowerCase()) ||
          (userId && m.userId === userId)
      );
      if (me) {
        const effLimit = Number(me.effectivePerUserLimitDollars ?? me.monthlyLimitDollars);
        const spendCents = Number(me.overallSpendCents);
        if (Number.isFinite(effLimit) && effLimit > 0 && Number.isFinite(spendCents) && spendCents >= 0) {
          teamBudget = { usedUSD: spendCents / 100, limitUSD: effLimit };
        }
      }
    }
  }

  let reqUsage = null;
  const hasAnyFallback = Boolean(
    hasPlanData ||
      teamBudget ||
      (summary.individualUsage?.overall && summary.individualUsage.overall.limit > 0) ||
      (summary.teamUsage?.pooled && summary.teamUsage.pooled.limit > 0)
  );
  if (!hasAnyFallback && userId) {
    reqUsage = await cursorApiJson(
      `https://cursor.com/api/usage?user=${encodeURIComponent(userId)}`,
      activeCookie
    );
  }

  const parsed = parseCursorQuotaSummary(summary, {
    nowMs,
    accountEmail,
    planTitle,
    teamBudget,
    reqUsage,
    sandUsage,
    unifiedUsage,
  });

  return {
    ...parsed,
    resolvedCookieHeader: activeCookie,
    hasEncryptedTokenWithoutKey,
    quotaHint: parsed.quotaWindows.length === 0 ? '未读取到套餐限额，可刷新或重新登录确认套餐状态' : null,
    _ok: true,
    _errorKind: null,
  };
}

export function fetchCodeBuddyQuota() {
  const empty = { accountEmail: null, planTitle: null, quotaWindows: [], resetCreditsText: null };
  try {
    const dbPath = join(homedir(), 'Library/Application Support/CodeBuddy CN/User/globalStorage/state.vscdb');
    if (!existsSync(dbPath)) return empty;
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const getVal = (key) => db.prepare('SELECT value FROM ItemTable WHERE key = ? LIMIT 1').get(key)?.value;
      let accountEmail = null;
      try {
        const replay = JSON.parse(getVal('codebuddy-replay.codebuddy-replay') || 'null');
        accountEmail = replay?.['codebuddyRecorder.weWorkId'] || null;
      } catch {}

      let planTitle = null;
      try {
        const copilot = JSON.parse(getVal('Tencent-Cloud.coding-copilot') || 'null');
        const flag = copilot?.cloud_product_config_cache?.[0]?.data?._configFlag || '';
        if (flag.includes('众测') && flag.includes('IOA')) {
          planTitle = 'iOA 众测';
        } else if (flag.includes('IOA')) {
          planTitle = '企业 iOA';
        } else if (copilot?.enterpriseId) {
          planTitle = 'Enterprise';
        }
      } catch {}

      return { accountEmail, planTitle, quotaWindows: [], resetCreditsText: null };
    } finally {
      db.close();
    }
  } catch {
    return empty;
  }
}

function assembleAllQuotas(raw, enabledTools = null) {
  const isEnabled = (k) => !enabledTools || enabledTools[k] !== false;
  const { codex, antigravity, cursor, codebuddy } = raw;

  const overviewWindows = [];
  if (isEnabled('codex') && codex.quotaWindows.length > 0) {
    const cPrimary = codex.quotaWindows[0];
    const cSecondary = codex.quotaWindows[1];
    overviewWindows.push({
      ...cPrimary,
      id: 'overview-codex',
      title: `Codex ${cPrimary.title}`,
      subtitle: cPrimary.subtitle
        ? `${cPrimary.subtitle}${cSecondary ? ` · ${cSecondary.title} ${Math.round(cSecondary.remainingPct)}%` : ''}`
        : cSecondary
          ? `${cSecondary.title}剩余 ${Math.round(cSecondary.remainingPct)}%`
          : null,
    });
  }
  if (isEnabled('cursor') && cursor.quotaWindows.length > 0) {
    const curWin = cursor.quotaWindows[0];
    const extraSubs = cursor.quotaWindows
      .slice(1)
      .map((w) => `${w.title} ${Math.round(w.remainingPct)}%`);
    const curSub = [curWin.subtitle, ...extraSubs].filter(Boolean).join(' · ');
    overviewWindows.push({
      ...curWin,
      id: 'overview-cursor',
      title: cursor.quotaWindows.length > 1 ? 'Cursor 模型' : 'Cursor',
      subtitle: curSub || null,
    });
  }
  if (isEnabled('antigravity') && antigravity.quotaWindows.length > 0) {
    const g5h = antigravity.quotaWindows[0];
    const gWk = antigravity.quotaWindows.find((w) => w.id === 'ag-gemini-weekly');
    const agSub = [g5h.subtitle, gWk ? `每周 ${Math.round(gWk.remainingPct)}%` : null]
      .filter(Boolean)
      .join(' · ');
    overviewWindows.push({
      ...g5h,
      id: 'overview-antigravity',
      title: 'Antigravity',
      subtitle: agSub || null,
    });
  }

  const activeAccounts = [
    isEnabled('codex') ? codex : null,
    isEnabled('antigravity') ? antigravity : null,
    isEnabled('cursor') ? cursor : null,
    isEnabled('codebuddy') ? codebuddy : null,
  ].filter((q) => q && q.accountEmail).length;

  const all = {
    accountEmail: activeAccounts > 0 ? `${activeAccounts} 个已登录账号` : null,
    planTitle: '多客户端额度总览',
    quotaWindows: overviewWindows,
    resetCreditsText: isEnabled('codex') ? codex.resetCreditsText : null,
  };

  return { all, codex, antigravity, cursor, codebuddy };
}

function reconcileWithStaleGrace(toolKey, fresh, nowMs) {
  if (fresh?.quotaWindows?.length > 0) {
    lastGoodByTool[toolKey] = { snapshot: fresh, atMs: nowMs };
    return fresh;
  }
  const prev = lastGoodByTool[toolKey];
  if (
    prev &&
    nowMs - prev.atMs <= STALE_GRACE_MS &&
    fresh?._errorKind === 'network' &&
    (!fresh.accountEmail ||
      !prev.snapshot.accountEmail ||
      fresh.accountEmail.toLowerCase() === prev.snapshot.accountEmail.toLowerCase())
  ) {
    return prev.snapshot;
  }
  return fresh;
}

export async function getAllQuotas(
  nowMs = Date.now(),
  { forceRefresh = false, allowNetwork = true, cursorCookie = null, enabledTools = null } = {}
) {
  const cookieKey = cursorCookie ? String(cursorCookie).trim() : '';
  if (!forceRefresh && cachedResult && cachedCookieKey === cookieKey && nowMs - cachedAtMs < cachedTtlMs) {
    return assembleAllQuotas(cachedResult, enabledTools);
  }
  if (!forceRefresh && inflightPromise && cachedCookieKey === cookieKey) {
    const raw = await inflightPromise;
    return assembleAllQuotas(raw, enabledTools);
  }
  cachedCookieKey = cookieKey;

  inflightPromise = (async () => {
    const [codexRaw, antigravityRaw, cursorRaw] = await Promise.all([
      fetchCodexQuota(nowMs, { allowNetwork }),
      fetchAntigravityQuota(nowMs),
      fetchCursorQuota(nowMs, { allowNetwork, cursorCookie }),
    ]);
    const codebuddy = fetchCodeBuddyQuota();
    const codex = reconcileWithStaleGrace('codex', codexRaw, nowMs);
    const antigravity = reconcileWithStaleGrace('antigravity', antigravityRaw, nowMs);
    const cursor = reconcileWithStaleGrace('cursor', cursorRaw, nowMs);

    const anyTransientFailure = Boolean(
      (codexRaw?._errorKind === 'network' && !codexRaw.quotaWindows?.length) ||
        (cursorRaw?._errorKind === 'network' && !cursorRaw.quotaWindows?.length)
    );
    cachedTtlMs = anyTransientFailure ? ERROR_RETRY_TTL_MS : CACHE_TTL_MS;

    const raw = { codex, antigravity, cursor, codebuddy };
    cachedResult = raw;
    cachedAtMs = Date.now();
    return raw;
  })().finally(() => {
    inflightPromise = null;
  });

  const raw = await inflightPromise;
  return assembleAllQuotas(raw, enabledTools);
}
