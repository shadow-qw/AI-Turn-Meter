import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const PROXY_CACHE_TTL_MS = 15_000;
let cachedProxyState = { checkedAt: 0, hasSystemProxy: false, fallbackProxyUrl: null };
let inflightProxyPromise = null;

export function resetNetProxyCacheForTests() {
  cachedProxyState = { checkedAt: 0, hasSystemProxy: false, fallbackProxyUrl: null };
  inflightProxyPromise = null;
}

export function normalizeProxyUrl(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    const scheme = parsed.protocol.toLowerCase();
    if (
      scheme !== 'http:' &&
      scheme !== 'https:' &&
      scheme !== 'socks5:' &&
      scheme !== 'socks5h:'
    ) {
      return null;
    }
    if (!parsed.hostname) return null;
    const defaultPort = scheme === 'https:' ? '443' : scheme === 'http:' ? '80' : '1080';
    const portNum = Number(parsed.port || defaultPort);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) return null;
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export function isLoopbackUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return false;
  try {
    const host = new URL(rawUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch {
    return false;
  }
}

export const PROXY_ENV_KEYS = [
  'HTTPS_PROXY',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
  'HTTP_PROXY',
  'http_proxy',
];

export function readClaudeSettingsProxyUrl(homeDir = homedir()) {
  try {
    const settingsPath = join(homeDir, '.claude', 'settings.json');
    if (!existsSync(settingsPath)) return null;
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const envObj = parsed?.env;
    if (!envObj || typeof envObj !== 'object') return null;
    for (const k of PROXY_ENV_KEYS) {
      const normalized = normalizeProxyUrl(envObj[k]);
      if (normalized) return normalized;
    }
    return null;
  } catch {
    return null;
  }
}

export function resolveClaudeProxyConfig({
  claudeProxyUrl = null,
  homeDir = homedir(),
  env = process.env,
  systemProxyState = null,
} = {}) {
  const fromConfig = normalizeProxyUrl(claudeProxyUrl);
  if (fromConfig) {
    return { proxyUrl: fromConfig, source: 'config' };
  }
  const fromSettings = readClaudeSettingsProxyUrl(homeDir);
  if (fromSettings) {
    return { proxyUrl: fromSettings, source: 'claude_settings' };
  }
  if (env && typeof env === 'object') {
    for (const k of PROXY_ENV_KEYS) {
      const fromEnv = normalizeProxyUrl(env[k]);
      if (fromEnv) {
        return { proxyUrl: fromEnv, source: 'env' };
      }
    }
  }
  const fromSystem = normalizeProxyUrl(systemProxyState?.fallbackProxyUrl);
  if (fromSystem) {
    return { proxyUrl: fromSystem, source: 'system' };
  }
  if (systemProxyState?.hasSystemProxy) {
    return { proxyUrl: null, source: 'system' };
  }
  return { proxyUrl: null, source: 'none' };
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

export function resolveAppHelperBin() {
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

export async function getProxyState(nowMs = Date.now(), { runScutil = null } = {}) {
  if (!runScutil && (process.env.AI_TURN_METER_DISABLE_NATIVE_NET === '1' || process.env.NODE_TEST_CONTEXT)) {
    return parseSystemProxyInfo('', process.env);
  }
  if (nowMs - cachedProxyState.checkedAt < PROXY_CACHE_TTL_MS) {
    return cachedProxyState;
  }
  if (inflightProxyPromise) {
    return inflightProxyPromise;
  }
  let p;
  p = (async () => {
    let scutilOut = '';
    if (typeof runScutil === 'function') {
      try {
        scutilOut = (await runScutil()) || '';
      } catch {}
    } else if (process.platform === 'darwin') {
      try {
        const { stdout } = await execFileAsync('/usr/sbin/scutil', ['--proxy'], { timeout: 1000 });
        scutilOut = stdout || '';
      } catch {}
    }
    const parsed = parseSystemProxyInfo(scutilOut, process.env);
    const nextState = { checkedAt: nowMs, ...parsed };
    if (inflightProxyPromise === p) {
      cachedProxyState = nextState;
    }
    return nextState;
  })().finally(() => {
    if (inflightProxyPromise === p) {
      inflightProxyPromise = null;
    }
  });
  inflightProxyPromise = p;
  return p;
}

export function runProcessWithStdin(bin, args, inputStr, timeoutMs) {
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

function normalizeResponseHeaders(headersObj) {
  const out = {};
  if (!headersObj) return out;
  if (typeof headersObj.forEach === 'function') {
    headersObj.forEach((v, k) => {
      out[String(k).toLowerCase()] = String(v);
    });
  } else if (typeof headersObj === 'object') {
    for (const [k, v] of Object.entries(headersObj)) {
      if (v !== undefined && v !== null) {
        out[String(k).toLowerCase()] = String(v);
      }
    }
  }
  return out;
}

function parseCurlHeaderDump(rawHeadersText) {
  const text = String(rawHeadersText || '');
  const blocks = text
    .split(/\r?\n\r?\n/)
    .map((b) => b.trim())
    .filter((b) => /^HTTP\//i.test(b));
  const lastBlock = blocks[blocks.length - 1];
  if (!lastBlock) return {};
  const headers = {};
  const lines = lastBlock.split(/\r?\n/);
  for (let i = 1; i < lines.length; i += 1) {
    const idx = lines[i].indexOf(':');
    if (idx === -1) continue;
    const k = lines[i].slice(0, idx).trim().toLowerCase();
    const v = lines[i].slice(idx + 1).trim();
    if (k) headers[k] = v;
  }
  return headers;
}

function classifyHttpResult(status, text, headers, latencyMs) {
  if (status === 401 || status === 403) {
    return {
      ok: false,
      status,
      text,
      headers,
      latencyMs,
      errorKind: 'unauthorized',
      errorMessage: `HTTP ${status}`,
    };
  }
  if (status < 200 || status >= 300) {
    return {
      ok: false,
      status,
      text,
      headers,
      latencyMs,
      errorKind: 'http',
      errorMessage: `HTTP ${status}`,
    };
  }
  return {
    ok: true,
    status,
    text,
    headers,
    latencyMs,
    errorKind: 'ok',
    errorMessage: null,
  };
}

async function nativeUrlSessionFetchRaw(
  helperBin,
  url,
  {
    method = 'GET',
    headers = {},
    body = null,
    timeoutMs = 8000,
    redirect = 'follow',
    proxyUrl = null,
    strictProxy = false,
  }
) {
  const startedAt = Date.now();
  const payload = JSON.stringify({
    url,
    method,
    headers,
    body: body !== null && body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : null,
    timeoutMs,
    redirect,
    proxyUrl: proxyUrl || null,
    strictProxy: Boolean(strictProxy),
  });
  const res = await runProcessWithStdin(helperBin, ['--net-fetch-json'], payload, timeoutMs + 3000);
  const latencyMs = Date.now() - startedAt;
  if (!res.ok || !res.stdout.trim()) {
    return {
      ok: false,
      status: null,
      text: '',
      headers: {},
      finalUrl: null,
      latencyMs,
      errorKind: 'network',
      errorMessage: res.error || 'native helper failed',
    };
  }
  try {
    const out = JSON.parse(res.stdout);
    const status = typeof out.status === 'number' ? out.status : null;
    const respHeaders = normalizeResponseHeaders(out.headers);
    const text = typeof out.body === 'string' ? out.body : '';
    const finalUrl = typeof out.url === 'string' ? out.url : null;
    if (!status) {
      return {
        ok: false,
        status: null,
        text,
        headers: respHeaders,
        finalUrl,
        latencyMs,
        errorKind: 'network',
        errorMessage: out.error || 'network error',
      };
    }
    return { ...classifyHttpResult(status, text, respHeaders, latencyMs), finalUrl };
  } catch (e) {
    return {
      ok: false,
      status: null,
      text: '',
      headers: {},
      finalUrl: null,
      latencyMs,
      errorKind: 'network',
      errorMessage: e?.message || 'native parse error',
    };
  }
}

export async function curlFetchRaw(
  url,
  { method = 'GET', headers = {}, body = null, timeoutMs = 8000, proxyUrl = null, redirect = 'follow' } = {}
) {
  const startedAt = Date.now();
  if (!existsSync('/usr/bin/curl')) {
    return {
      ok: false,
      status: null,
      text: '',
      headers: {},
      finalUrl: null,
      latencyMs: 0,
      errorKind: 'network',
      errorMessage: 'curl unavailable',
    };
  }
  let hdrTmpDir = null;
  try {
    hdrTmpDir = mkdtempSync(join(tmpdir(), 'atm-curl-hdr-'));
    const hdrFile = join(hdrTmpDir, 'headers.txt');
    const args = [
      '-sS',
      ...(redirect !== 'manual' ? ['-L'] : []),
      '--max-time',
      String(Math.max(2, Math.ceil(timeoutMs / 1000))),
      '-X',
      method,
      '-D',
      hdrFile,
      '-w',
      '\n__ATM_HTTP:%{http_code}\n__ATM_URL:%{url_effective}',
    ];
    if (proxyUrl) {
      args.push('--proxy', proxyUrl, '--noproxy', '');
    }
    const escapeCurlCfgVal = (s) =>
      String(s).replace(/[\r\n\0]+/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const cfgLines = [];
    for (const [k, v] of Object.entries(headers || {})) {
      if (v === undefined || v === null) continue;
      const cleanKey = String(k).replace(/[\r\n:\0]+/g, '').trim();
      if (!cleanKey) continue;
      cfgLines.push(`header = "${escapeCurlCfgVal(`${cleanKey}: ${v}`)}"`);
    }
    if (cfgLines.length > 0) {
      const cfgFile = join(hdrTmpDir, 'curl-config.txt');
      writeFileSync(cfgFile, `${cfgLines.join('\n')}\n`, { mode: 0o600 });
      args.push('-K', cfgFile);
    }
    const bodyStr = body !== null && body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    if (bodyStr !== null) {
      args.push('--data-binary', '@-');
    }
    args.push(url);

    const res = await runProcessWithStdin('/usr/bin/curl', args, bodyStr || '', timeoutMs + 2500);
    const latencyMs = Date.now() - startedAt;
    let respHeaders = {};
    try {
      if (existsSync(hdrFile)) {
        respHeaders = parseCurlHeaderDump(readFileSync(hdrFile, 'utf8'));
      }
    } catch {}

    if (!res.ok) {
      return {
        ok: false,
        status: null,
        text: '',
        headers: respHeaders,
        finalUrl: null,
        latencyMs,
        errorKind: 'network',
        errorMessage: res.error || 'curl error',
      };
    }
    const marker = '\n__ATM_HTTP:';
    const idx = res.stdout.lastIndexOf(marker);
    if (idx === -1) {
      return {
        ok: false,
        status: null,
        text: res.stdout,
        headers: respHeaders,
        finalUrl: null,
        latencyMs,
        errorKind: 'network',
        errorMessage: 'curl no status',
      };
    }
    const bodyOut = res.stdout.slice(0, idx);
    const trailer = res.stdout.slice(idx + marker.length);
    const urlMarker = '\n__ATM_URL:';
    const urlIdx = trailer.indexOf(urlMarker);
    const statusStr = (urlIdx === -1 ? trailer : trailer.slice(0, urlIdx)).trim();
    const finalUrl = urlIdx === -1 ? url : trailer.slice(urlIdx + urlMarker.length).trim() || url;
    const status = Number(statusStr) || null;
    if (!status) {
      return {
        ok: false,
        status: null,
        text: bodyOut,
        headers: respHeaders,
        finalUrl: null,
        latencyMs,
        errorKind: 'network',
        errorMessage: 'curl status 0',
      };
    }
    return { ...classifyHttpResult(status, bodyOut, respHeaders, latencyMs), finalUrl };
  } finally {
    if (hdrTmpDir) {
      try {
        rmSync(hdrTmpDir, { recursive: true, force: true });
      } catch {}
    }
  }
}

export async function httpRequestRaw(
  url,
  {
    method = 'GET',
    headers = {},
    body = null,
    timeoutMs = 8000,
    redirect = 'follow',
    preferNative = false,
    proxyUrl = null,
    strictProxy = false,
    fetchImpl = null,
    _nativeHelperBin = undefined,
    _proxyState = undefined,
    _directFetch = null,
  } = {}
) {
  const startedAt = Date.now();
  const bodyStr =
    body !== null && body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined;

  const helperBin = _nativeHelperBin !== undefined ? _nativeHelperBin : resolveAppHelperBin();
  const proxyState = _proxyState !== undefined ? _proxyState : await getProxyState();
  const explicitProxy = normalizeProxyUrl(proxyUrl);
  const effectiveProxyUrl = explicitProxy || proxyState.fallbackProxyUrl || null;
  const hasUsableProxy = Boolean(effectiveProxyUrl || proxyState.hasSystemProxy);
  const targetIsLoopback = isLoopbackUrl(url);

  if (strictProxy && !targetIsLoopback && !hasUsableProxy) {
    return {
      ok: false,
      status: null,
      text: '',
      headers: {},
      finalUrl: null,
      latencyMs: 0,
      errorKind: 'proxy_required',
      errorMessage: '未检测到可用代理，已阻止直连',
    };
  }

  if (typeof fetchImpl === 'function') {
    try {
      const res = await fetchImpl(url, {
        method,
        headers,
        body: bodyStr,
        redirect,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const latencyMs = Date.now() - startedAt;
      const respHeaders = normalizeResponseHeaders(res.headers);
      const text = typeof res.text === 'function' ? await res.text() : '';
      return {
        ...classifyHttpResult(res.status, text, respHeaders, latencyMs),
        finalUrl: typeof res.url === 'string' && res.url ? res.url : url,
      };
    } catch (err) {
      return {
        ok: false,
        status: null,
        text: '',
        headers: {},
        finalUrl: null,
        latencyMs: Date.now() - startedAt,
        errorKind: 'network',
        errorMessage: err?.cause?.code || err?.message || 'fetch failed',
      };
    }
  }

  const directFetch = typeof _directFetch === 'function' ? _directFetch : fetch;
  const enforceNoDirect = Boolean(!targetIsLoopback && (strictProxy || explicitProxy || proxyState.hasSystemProxy));

  if (helperBin && (preferNative || hasUsableProxy)) {
    const nativeRes = await nativeUrlSessionFetchRaw(helperBin, url, {
      method,
      headers,
      body: bodyStr ?? null,
      timeoutMs,
      redirect,
      proxyUrl: effectiveProxyUrl,
      strictProxy: Boolean(strictProxy && !targetIsLoopback),
    });
    if (nativeRes.status !== null) {
      return nativeRes;
    }
    if (effectiveProxyUrl) {
      const curlRes = await curlFetchRaw(url, {
        method,
        headers,
        body: bodyStr ?? null,
        timeoutMs,
        proxyUrl: effectiveProxyUrl,
        redirect,
      });
      if (curlRes.status !== null) {
        return curlRes;
      }
      if (enforceNoDirect) {
        return curlRes;
      }
    }
    if (!preferNative || enforceNoDirect) {
      return nativeRes;
    }
  }

  if (effectiveProxyUrl && (explicitProxy || (!helperBin && proxyState.hasSystemProxy) || strictProxy)) {
    const curlRes = await curlFetchRaw(url, {
      method,
      headers,
      body: bodyStr ?? null,
      timeoutMs,
      proxyUrl: effectiveProxyUrl,
      redirect,
    });
    if (curlRes.status !== null || enforceNoDirect) {
      return curlRes;
    }
  }

  if (enforceNoDirect) {
    return {
      ok: false,
      status: null,
      text: '',
      headers: {},
      finalUrl: null,
      latencyMs: Date.now() - startedAt,
      errorKind: 'network',
      errorMessage: '代理连接失败，已阻止直连',
    };
  }

  try {
    const res = await directFetch(url, {
      method,
      headers,
      body: bodyStr,
      redirect,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Date.now() - startedAt;
    const respHeaders = normalizeResponseHeaders(res.headers);
    const text = await res.text();
    return {
      ...classifyHttpResult(res.status, text, respHeaders, latencyMs),
      finalUrl: typeof res.url === 'string' && res.url ? res.url : url,
    };
  } catch (err) {
    let nativeErrRes = null;
    if (helperBin) {
      const nativeRes = await nativeUrlSessionFetchRaw(helperBin, url, {
        method,
        headers,
        body: bodyStr ?? null,
        timeoutMs,
        redirect,
        proxyUrl: effectiveProxyUrl,
        strictProxy: Boolean(strictProxy && !targetIsLoopback),
      });
      if (nativeRes.status !== null) {
        return nativeRes;
      }
      nativeErrRes = nativeRes;
    }
    if (effectiveProxyUrl) {
      const curlRes = await curlFetchRaw(url, {
        method,
        headers,
        body: bodyStr ?? null,
        timeoutMs,
        proxyUrl: effectiveProxyUrl,
        redirect,
      });
      if (curlRes.status !== null || !nativeErrRes) {
        return curlRes;
      }
    }
    if (nativeErrRes) {
      return nativeErrRes;
    }
    return {
      ok: false,
      status: null,
      text: '',
      headers: {},
      finalUrl: null,
      latencyMs: Date.now() - startedAt,
      errorKind: 'network',
      errorMessage: err?.cause?.code || err?.message || 'fetch failed',
    };
  }
}

export async function httpRequestJson(
  url,
  {
    method = 'GET',
    headers = {},
    body = null,
    timeoutMs = 8000,
    redirect = 'follow',
    preferNative = false,
    proxyUrl = null,
    strictProxy = false,
    fetchImpl = null,
    _nativeHelperBin = undefined,
    _proxyState = undefined,
    _directFetch = null,
  } = {}
) {
  const raw = await httpRequestRaw(url, {
    method,
    headers,
    body,
    timeoutMs,
    redirect,
    preferNative,
    proxyUrl,
    strictProxy,
    fetchImpl,
    _nativeHelperBin,
    _proxyState,
    _directFetch,
  });
  if (!raw.ok) {
    return {
      ok: false,
      status: raw.status,
      headers: raw.headers || {},
      finalUrl: raw.finalUrl || null,
      data: null,
      errorKind: raw.errorKind,
      errorMessage: raw.errorMessage,
    };
  }
  try {
    const data = raw.text ? JSON.parse(raw.text) : null;
    return {
      ok: true,
      status: raw.status,
      headers: raw.headers || {},
      finalUrl: raw.finalUrl || null,
      data,
      errorKind: 'ok',
      errorMessage: null,
    };
  } catch {
    return {
      ok: false,
      status: raw.status,
      headers: raw.headers || {},
      finalUrl: raw.finalUrl || null,
      data: null,
      errorKind: 'parse',
      errorMessage: 'invalid json',
    };
  }
}
