import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const PROXY_CACHE_TTL_MS = 15_000;
let cachedProxyState = { checkedAt: 0, hasSystemProxy: false, fallbackProxyUrl: null };

export function resetNetProxyCacheForTests() {
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

export async function getProxyState(nowMs = Date.now()) {
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
  { method = 'GET', headers = {}, body = null, timeoutMs = 8000 }
) {
  const startedAt = Date.now();
  const payload = JSON.stringify({
    url,
    method,
    headers,
    body: body !== null && body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : null,
    timeoutMs,
  });
  const res = await runProcessWithStdin(helperBin, ['--net-fetch-json'], payload, timeoutMs + 3000);
  const latencyMs = Date.now() - startedAt;
  if (!res.ok || !res.stdout.trim()) {
    return {
      ok: false,
      status: null,
      text: '',
      headers: {},
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
    if (!status) {
      return {
        ok: false,
        status: null,
        text,
        headers: respHeaders,
        latencyMs,
        errorKind: 'network',
        errorMessage: out.error || 'network error',
      };
    }
    return classifyHttpResult(status, text, respHeaders, latencyMs);
  } catch (e) {
    return {
      ok: false,
      status: null,
      text: '',
      headers: {},
      latencyMs,
      errorKind: 'network',
      errorMessage: e?.message || 'native parse error',
    };
  }
}

async function curlFetchRaw(
  url,
  { method = 'GET', headers = {}, body = null, timeoutMs = 8000, proxyUrl = null }
) {
  const startedAt = Date.now();
  if (!existsSync('/usr/bin/curl')) {
    return {
      ok: false,
      status: null,
      text: '',
      headers: {},
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
      '--max-time',
      String(Math.max(2, Math.ceil(timeoutMs / 1000))),
      '-X',
      method,
      '-D',
      hdrFile,
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
        latencyMs,
        errorKind: 'network',
        errorMessage: 'curl no status',
      };
    }
    const bodyOut = res.stdout.slice(0, idx);
    const status = Number(res.stdout.slice(idx + marker.length).trim()) || null;
    if (!status) {
      return {
        ok: false,
        status: null,
        text: bodyOut,
        headers: respHeaders,
        latencyMs,
        errorKind: 'network',
        errorMessage: 'curl status 0',
      };
    }
    return classifyHttpResult(status, bodyOut, respHeaders, latencyMs);
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
  { method = 'GET', headers = {}, body = null, timeoutMs = 8000, fetchImpl = null } = {}
) {
  const startedAt = Date.now();
  const bodyStr =
    body !== null && body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined;

  if (typeof fetchImpl === 'function') {
    try {
      const res = await fetchImpl(url, {
        method,
        headers,
        body: bodyStr,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const latencyMs = Date.now() - startedAt;
      const respHeaders = normalizeResponseHeaders(res.headers);
      const text = typeof res.text === 'function' ? await res.text() : '';
      return classifyHttpResult(res.status, text, respHeaders, latencyMs);
    } catch (err) {
      return {
        ok: false,
        status: null,
        text: '',
        headers: {},
        latencyMs: Date.now() - startedAt,
        errorKind: 'network',
        errorMessage: err?.cause?.code || err?.message || 'fetch failed',
      };
    }
  }

  const helperBin = resolveAppHelperBin();
  const proxyState = await getProxyState();

  if (helperBin && proxyState.hasSystemProxy) {
    return nativeUrlSessionFetchRaw(helperBin, url, { method, headers, body: bodyStr ?? null, timeoutMs });
  }

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: bodyStr,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Date.now() - startedAt;
    const respHeaders = normalizeResponseHeaders(res.headers);
    const text = await res.text();
    return classifyHttpResult(res.status, text, respHeaders, latencyMs);
  } catch (err) {
    if (helperBin) {
      return nativeUrlSessionFetchRaw(helperBin, url, { method, headers, body: bodyStr ?? null, timeoutMs });
    }
    if (proxyState.fallbackProxyUrl) {
      return curlFetchRaw(url, {
        method,
        headers,
        body: bodyStr ?? null,
        timeoutMs,
        proxyUrl: proxyState.fallbackProxyUrl,
      });
    }
    return {
      ok: false,
      status: null,
      text: '',
      headers: {},
      latencyMs: Date.now() - startedAt,
      errorKind: 'network',
      errorMessage: err?.cause?.code || err?.message || 'fetch failed',
    };
  }
}

export async function httpRequestJson(
  url,
  { method = 'GET', headers = {}, body = null, timeoutMs = 8000, fetchImpl = null } = {}
) {
  const raw = await httpRequestRaw(url, { method, headers, body, timeoutMs, fetchImpl });
  if (!raw.ok) {
    return {
      ok: false,
      status: raw.status,
      data: null,
      errorKind: raw.errorKind,
      errorMessage: raw.errorMessage,
    };
  }
  try {
    const data = raw.text ? JSON.parse(raw.text) : null;
    return { ok: true, status: raw.status, data, errorKind: 'ok', errorMessage: null };
  } catch {
    return { ok: false, status: raw.status, data: null, errorKind: 'parse', errorMessage: 'invalid json' };
  }
}
