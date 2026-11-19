import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { TOOL_LABELS } from './format.mjs';
import { resolveCodexUsageUrl } from './quota.mjs';

const LIGHTWEIGHT_MODEL_RE = /(mini|nano|haiku|flash|lite|luna|small|instant|8b|7b|3b)/i;
const FLAGSHIP_MODEL_RE = /(opus|sonnet|pro|ultra|astra|sol|gpt-5|gpt-6|o1|o3|o4|claude-4|gemini-3|gemini-2\.5-pro|deepseek-r1)/i;

function median(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Compute Jensen-Shannon divergence (base 2, bounded in [0, 1]) between two discrete distributions.
 * Accepts either normalized probability maps or raw frequency counts.
 * @param {Record<string, number>} distA
 * @param {Record<string, number>} distB
 */
export function computeJsDivergence(distA, distB) {
  const keys = new Set([...Object.keys(distA || {}), ...Object.keys(distB || {})]);
  if (keys.size === 0) return 0;

  let sumA = 0;
  let sumB = 0;
  for (const k of keys) {
    sumA += Math.max(0, Number(distA?.[k]) || 0);
    sumB += Math.max(0, Number(distB?.[k]) || 0);
  }
  if (sumA <= 0 || sumB <= 0) return 1;

  let klAM = 0;
  let klBM = 0;
  for (const k of keys) {
    const p = Math.max(0, Number(distA?.[k]) || 0) / sumA;
    const q = Math.max(0, Number(distB?.[k]) || 0) / sumB;
    const m = 0.5 * (p + q);
    if (p > 0 && m > 0) klAM += p * Math.log2(p / m);
    if (q > 0 && m > 0) klBM += q * Math.log2(q / m);
  }
  return Number(Math.min(1, Math.max(0, 0.5 * klAM + 0.5 * klBM)).toFixed(4));
}

/**
 * Normalize single-token sample output into a canonical bucket key.
 * @param {string} raw
 * @param {'int' | 'word' | 'letter'} kind
 */
export function normalizeSingleTokenAnswer(raw, kind = 'word') {
  const text = String(raw || '').trim();
  if (!text) return '<empty>';
  if (kind === 'int') {
    const m = text.match(/-?\d+/);
    return m ? m[0] : text.toLowerCase().slice(0, 16);
  }
  if (kind === 'letter') {
    const m = text.match(/[a-zA-Z]/);
    return m ? m[0].toUpperCase() : text.slice(0, 8);
  }
  const m = text.match(/[a-zA-Z\u4e00-\u9fff0-9_-]+/);
  return m ? m[0].toLowerCase() : text.toLowerCase().slice(0, 20);
}

/**
 * L0: Passive anomaly detection over local turn telemetry across all 4 clients.
 * Detects TPS spikes (suspected lightweight swap), thinking-token drops, and in-session model downgrades.
 * @param {import('./store.mjs').TurnStore} store
 * @param {{ days?: number, tool?: string | null, nowMs?: number }} [opts]
 */
export function analyzePassiveTelemetry(store, { days = 7, tool = null, nowMs = Date.now() } = {}) {
  const sinceMs = nowMs - Math.max(1, Number(days) || 7) * 86_400_000;
  const rawRows = tool
    ? store.db
        .prepare(`SELECT * FROM turns WHERE tool = ? AND completed_at_ms >= ? ORDER BY completed_at_ms ASC`)
        .all(tool, sinceMs)
    : store.db
        .prepare(`SELECT * FROM turns WHERE completed_at_ms >= ? ORDER BY completed_at_ms ASC`)
        .all(sinceMs);

  const groupMap = new Map();
  const sessionModels = new Map();

  for (const r of rawRows) {
    const key = `${r.tool}\0${r.model || 'unknown'}`;
    if (!groupMap.has(key)) {
      groupMap.set(key, {
        tool: r.tool,
        model: r.model || 'unknown',
        tpsValues: [],
        outputValues: [],
        thinkingValues: [],
        thinkingKnownCount: 0,
        thinkingPositiveCount: 0,
        turnCount: 0,
      });
    }
    const g = groupMap.get(key);
    g.turnCount += 1;
    if (typeof r.tps === 'number' && Number.isFinite(r.tps) && r.tps > 0 && Number(r.output_tokens) >= 60) {
      g.tpsValues.push(r.tps);
    }
    if (Number(r.output_tokens) > 0) g.outputValues.push(Number(r.output_tokens));
    if (r.thinking_tokens !== null && r.thinking_tokens !== undefined) {
      g.thinkingKnownCount += 1;
      const tk = Number(r.thinking_tokens) || 0;
      if (tk > 0) {
        g.thinkingPositiveCount += 1;
        g.thinkingValues.push(tk);
      }
    }
  }

  const baselines = [];
  const baselineIndex = new Map();
  for (const [key, g] of groupMap.entries()) {
    const medTps = median(g.tpsValues);
    const medOut = median(g.outputValues);
    const medThink = median(g.thinkingValues);
    const thinkingRatio = g.thinkingKnownCount > 0 ? g.thinkingPositiveCount / g.thinkingKnownCount : null;
    const item = {
      tool: g.tool,
      toolLabel: TOOL_LABELS[g.tool] || g.tool,
      model: g.model,
      turnCount: g.turnCount,
      medianTps: medTps !== null ? Number(medTps.toFixed(1)) : null,
      medianOutputTokens: medOut !== null ? Math.round(medOut) : null,
      medianThinkingTokens: medThink !== null ? Math.round(medThink) : null,
      thinkingRatio: thinkingRatio !== null ? Number((thinkingRatio * 100).toFixed(1)) : null,
    };
    baselines.push(item);
    baselineIndex.set(key, { ...item, tpsSamples: g.tpsValues.length, thinkingSamples: g.thinkingKnownCount });
  }
  baselines.sort((a, b) => b.turnCount - a.turnCount);

  const anomalies = [];
  const recentRows = rawRows.slice(-80);
  for (const r of recentRows) {
    const model = r.model || 'unknown';
    const b = baselineIndex.get(`${r.tool}\0${model}`);
    const outTok = Number(r.output_tokens) || 0;
    const tps = typeof r.tps === 'number' && Number.isFinite(r.tps) && r.tps > 0 ? r.tps : null;

    // Signal 1: Sudden TPS spike (often indicates silent routing to smaller/faster model)
    if (
      b &&
      b.tpsSamples >= 4 &&
      b.medianTps !== null &&
      b.medianTps >= 8 &&
      b.medianTps <= 160 &&
      tps !== null &&
      outTok >= 80 &&
      tps >= b.medianTps * 2.2 &&
      tps - b.medianTps >= 60
    ) {
      const ratio = Number((tps / b.medianTps).toFixed(1));
      anomalies.push({
        id: `tps:${r.turn_uid}`,
        turnUid: r.turn_uid,
        tool: r.tool,
        toolLabel: TOOL_LABELS[r.tool] || r.tool,
        model,
        completedAtMs: r.completed_at_ms,
        kind: 'tps_spike',
        severity: ratio >= 3.0 ? 'high' : 'medium',
        title: `生成速度突增 ${ratio}x（疑似切轻量模型）`,
        detail: `本轮 ${tps.toFixed(1)} tok/s（输出 ${outTok}），近 ${days} 天同模型中位数为 ${b.medianTps} tok/s`,
      });
    }

    // Signal 2: Thinking tokens abruptly dropped to 0 or <15% on reasoning-heavy model
    if (
      b &&
      b.thinkingSamples >= 4 &&
      b.thinkingRatio !== null &&
      b.thinkingRatio >= 70 &&
      b.medianThinkingTokens !== null &&
      b.medianThinkingTokens >= 150 &&
      r.thinking_tokens !== null &&
      r.thinking_tokens !== undefined &&
      outTok >= 120
    ) {
      const tk = Number(r.thinking_tokens) || 0;
      if (tk === 0 || tk < b.medianThinkingTokens * 0.15) {
        anomalies.push({
          id: `think:${r.turn_uid}`,
          turnUid: r.turn_uid,
          tool: r.tool,
          toolLabel: TOOL_LABELS[r.tool] || r.tool,
          model,
          completedAtMs: r.completed_at_ms,
          kind: 'thinking_drop',
          severity: tk === 0 ? 'high' : 'medium',
          title: tk === 0 ? '思考 Token 突然归零（疑似关闭深度推理或换模）' : '思考深度骤降（不足历史 15%）',
          detail: `本轮 thinking=${tk}（输出 ${outTok}），历史中位数为 ${b.medianThinkingTokens}（含思考率 ${b.thinkingRatio}%）`,
        });
      }
    }

    // Signal 3: Same-session model downgrade from flagship -> lightweight
    const sessKey = `${r.tool}\0${r.session_id}`;
    const prevModel = sessionModels.get(sessKey);
    if (
      prevModel &&
      prevModel !== model &&
      FLAGSHIP_MODEL_RE.test(prevModel) &&
      LIGHTWEIGHT_MODEL_RE.test(model)
    ) {
      anomalies.push({
        id: `drift:${r.turn_uid}`,
        turnUid: r.turn_uid,
        tool: r.tool,
        toolLabel: TOOL_LABELS[r.tool] || r.tool,
        model,
        completedAtMs: r.completed_at_ms,
        kind: 'model_drift',
        severity: 'high',
        title: `同会话模型回退：${prevModel} → ${model}`,
        detail: `同一会话内检测到从旗舰模型切换为轻量模型，可能触发了配额或风控回退`,
      });
    }
    if (model !== 'unknown') sessionModels.set(sessKey, model);
  }

  anomalies.sort((a, b) => b.completedAtMs - a.completedAtMs);

  const tools = ['codex', 'antigravity', 'cursor', 'codebuddy'];
  const byTool = {};
  for (const t of tools) {
    const tRows = rawRows.filter((r) => r.tool === t);
    const tAnoms = anomalies.filter((a) => a.tool === t);
    const highCount = tAnoms.filter((a) => a.severity === 'high').length;
    const status =
      tRows.length < 3
        ? 'insufficient_data'
        : highCount > 0
          ? 'degraded'
          : tAnoms.length > 0
            ? 'warning'
            : 'healthy';
    byTool[t] = {
      tool: t,
      toolLabel: TOOL_LABELS[t] || t,
      status,
      turnCount: tRows.length,
      anomalyCount: tAnoms.length,
      highSeverityCount: highCount,
      latestModel: tRows.length > 0 ? tRows[tRows.length - 1].model : null,
    };
  }

  const overallStatus = anomalies.some((a) => a.severity === 'high')
    ? 'degraded'
    : anomalies.length > 0
      ? 'warning'
      : rawRows.length >= 3
        ? 'healthy'
        : 'insufficient_data';

  return {
    scannedAtMs: nowMs,
    days,
    totalTurnsScanned: rawRows.length,
    overallStatus,
    byTool,
    baselines: baselines.slice(0, 24),
    anomalies: anomalies.slice(0, 30),
  };
}

/**
 * Parse local ~/.codex/config.toml & auth.json to discover active Codex endpoint, model and credentials.
 * @param {string} [codexHome]
 */
export function inspectLocalCodexConfig(codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')) {
  const cfgPath = join(codexHome, 'config.toml');
  const authPath = join(codexHome, 'auth.json');
  let configText = '';
  if (existsSync(cfgPath)) {
    try {
      configText = readFileSync(cfgPath, 'utf8');
    } catch {}
  }

  let model = null;
  let modelProvider = null;
  let providerBaseUrl = null;
  let providerEnvKey = null;
  let wireApi = null;

  let currentSection = '';
  const providers = {};
  for (const rawLine of configText.split(/\r?\n/)) {
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;
    const secMatch = line.match(/^\[(.+)\]$/);
    if (secMatch) {
      currentSection = secMatch[1].trim();
      continue;
    }
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const k = line.slice(0, eqIdx).trim();
    let v = line.slice(eqIdx + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1).trim();
    }
    if (!currentSection) {
      if (k === 'model') model = v;
      else if (k === 'model_provider') modelProvider = v;
    } else {
      const pm = currentSection.match(/^model_providers\.([^\s]+)$/);
      if (pm) {
        const pName = pm[1].replace(/^["']|["']$/g, '');
        if (!providers[pName]) providers[pName] = {};
        providers[pName][k] = v;
      }
    }
  }

  if (modelProvider && providers[modelProvider]) {
    providerBaseUrl = providers[modelProvider].base_url || null;
    providerEnvKey = providers[modelProvider].env_key || null;
    wireApi = providers[modelProvider].wire_api || null;
  }

  let accessToken = null;
  let accountId = null;
  let apiKey = null;
  if (existsSync(authPath)) {
    try {
      const auth = JSON.parse(readFileSync(authPath, 'utf8'));
      accessToken = auth?.tokens?.access_token || null;
      accountId = auth?.tokens?.account_id || null;
      if (typeof auth?.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY.trim()) {
        apiKey = auth.OPENAI_API_KEY.trim();
      }
    } catch {}
  }
  if (!apiKey && providerEnvKey && process.env[providerEnvKey]) {
    apiKey = process.env[providerEnvKey].trim();
  }
  if (!apiKey && process.env.OPENAI_API_KEY) {
    apiKey = process.env.OPENAI_API_KEY.trim();
  }

  const { baseUrl: chatgptBaseUrl } = resolveCodexUsageUrl(codexHome, configText);
  const effectiveBaseUrl = providerBaseUrl || (accessToken ? `${chatgptBaseUrl}/codex` : 'https://api.openai.com/v1');
  const authMode = providerBaseUrl
    ? apiKey
      ? 'custom_provider'
      : 'custom_provider_no_key'
    : accessToken
      ? 'chatgpt_oauth'
      : apiKey
        ? 'openai_api_key'
        : 'none';

  return {
    codexHome,
    configured: authMode !== 'none',
    authMode,
    model: model || 'gpt-5-codex',
    modelProvider: modelProvider || (accessToken ? 'chatgpt-oauth' : 'openai'),
    baseUrl: effectiveBaseUrl,
    wireApi: wireApi || (accessToken && !providerBaseUrl ? 'responses' : 'chat'),
    hasAccessToken: Boolean(accessToken),
    hasApiKey: Boolean(apiKey),
    accessToken,
    accountId,
    apiKey,
  };
}

/**
 * Normalize an endpoint config for public API output (never expose raw apiKey).
 * @param {object} ep
 */
export function sanitizeEndpoint(ep) {
  const key = typeof ep?.apiKey === 'string' ? ep.apiKey.trim() : '';
  const preview =
    key.length >= 10
      ? `${key.slice(0, 4)}...${key.slice(-4)}`
      : key.length > 0
        ? '****'
        : '';
  return {
    id: String(ep.id || ''),
    name: String(ep.name || ep.model || '自定义端点'),
    protocol: ep.protocol === 'anthropic' ? 'anthropic' : 'openai',
    baseUrl: String(ep.baseUrl || '').trim(),
    model: String(ep.model || '').trim(),
    hasApiKey: key.length > 0,
    apiKeyPreview: preview,
    createdAtMs: Number(ep.createdAtMs) || Date.now(),
  };
}

/**
 * Low-level unified single-turn LLM call supporting OpenAI chat/responses & Anthropic messages.
 */
async function callModelOnce(
  { protocol = 'openai', baseUrl, apiKey, accessToken, accountId, model, prompt, maxTokens = 160, temperature = 0, wireApi = 'chat', timeoutMs = 20000 },
  fetchImpl = globalThis.fetch
) {
  const startedAt = Date.now();
  const cleanBase = String(baseUrl || '').replace(/\/+$/, '');
  const token = apiKey || accessToken || '';
  if (!cleanBase || !token) {
    throw new Error('缺少端点 Base URL 或鉴权密钥（API Key / Token）');
  }

  let url;
  let headers;
  let body;

  if (protocol === 'anthropic') {
    url = cleanBase.endsWith('/messages')
      ? cleanBase
      : cleanBase.endsWith('/v1')
        ? `${cleanBase}/messages`
        : `${cleanBase}/v1/messages`;
    headers = {
      'Content-Type': 'application/json',
      'x-api-key': token,
      'anthropic-version': '2023-06-01',
    };
    body = {
      model,
      max_tokens: maxTokens,
      temperature,
      messages: [{ role: 'user', content: prompt }],
    };
  } else if (wireApi === 'responses') {
    url = cleanBase.endsWith('/responses') ? cleanBase : `${cleanBase}/responses`;
    headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'codex-cli',
      'OpenAI-Beta': 'responses=experimental',
      ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
    };
    body = {
      model,
      input: prompt,
      max_output_tokens: maxTokens,
      store: false,
    };
  } else {
    url = cleanBase.endsWith('/chat/completions')
      ? cleanBase
      : cleanBase.endsWith('/v1')
        ? `${cleanBase}/chat/completions`
        : `${cleanBase}/v1/chat/completions`;
    headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
    };
    body = {
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      temperature,
    };
  }

  const res = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const latencyMs = Date.now() - startedAt;
  const rawHeaders = {};
  if (res.headers && typeof res.headers.forEach === 'function') {
    res.headers.forEach((v, k) => {
      rawHeaders[k.toLowerCase()] = v;
    });
  } else if (res.headers && typeof res.headers === 'object') {
    for (const [k, v] of Object.entries(res.headers)) {
      rawHeaders[k.toLowerCase()] = String(v);
    }
  }

  const textBody = await res.text();
  let json = null;
  try {
    json = JSON.parse(textBody);
  } catch {}

  if (!res.ok) {
    const errMsg = json?.error?.message || json?.detail || textBody.slice(0, 180) || `HTTP ${res.status}`;
    const err = new Error(`HTTP ${res.status}: ${errMsg}`);
    err.status = res.status;
    err.headers = rawHeaders;
    err.data = json;
    err.latencyMs = latencyMs;
    throw err;
  }

  let text = '';
  let responseModel = json?.model || rawHeaders['openai-model'] || null;

  if (protocol === 'anthropic') {
    if (Array.isArray(json?.content)) {
      text = json.content
        .filter((b) => b?.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n')
        .trim();
    }
  } else if (wireApi === 'responses' || Array.isArray(json?.output)) {
    if (typeof json?.output_text === 'string') {
      text = json.output_text.trim();
    } else if (Array.isArray(json?.output)) {
      const pieces = [];
      for (const item of json.output) {
        if (Array.isArray(item?.content)) {
          for (const c of item.content) {
            if (typeof c?.text === 'string') pieces.push(c.text);
          }
        }
      }
      text = pieces.join('\n').trim();
    }
  } else {
    const msg = json?.choices?.[0]?.message;
    text = typeof msg?.content === 'string' ? msg.content.trim() : '';
  }

  return {
    status: res.status,
    latencyMs,
    responseModel,
    text,
    headers: rawHeaders,
    usage: json?.usage || null,
  };
}

/**
 * Evaluate raw Codex response headers + model slug for silent downgrade / routing anomalies.
 * Pure helper exported for direct unit testing.
 */
export function evaluateCodexProtocolSignals({ requestedModel, responseModel, headers = {}, status = 200, latencyMs = 0 }) {
  const lower = {};
  for (const [k, v] of Object.entries(headers || {})) {
    lower[k.toLowerCase()] = String(v);
  }

  const findings = [];
  const turnState = lower['x-codex-turn-state'] || null;
  const safetyBuffering =
    lower['x-codex-safety-buffering-enabled'] || lower['x-safety-buffering'] || lower['safety-buffering'] || null;
  const actualModel = responseModel || lower['openai-model'] || lower['x-model'] || null;

  const normalizeSlug = (s) => String(s || '').trim().toLowerCase();
  const reqNorm = normalizeSlug(requestedModel);
  const actNorm = normalizeSlug(actualModel);

  let modelMismatch = false;
  if (reqNorm && actNorm && !actNorm.includes(reqNorm) && !reqNorm.includes(actNorm)) {
    modelMismatch = true;
    findings.push({
      severity: 'high',
      code: 'model_mismatch',
      message: `请求模型为 ${requestedModel}，但服务端实际返回 ${actualModel}`,
    });
  }

  if (safetyBuffering && /^(true|1|enabled|yes)$/i.test(safetyBuffering.trim())) {
    findings.push({
      severity: 'medium',
      code: 'safety_buffering',
      message: `命中 safety-buffering 路由头 (${safetyBuffering})，存在风控审查或降级缓冲可能`,
    });
  }

  if (turnState) {
    findings.push({
      severity: 'info',
      code: 'turn_state_present',
      message: `检测到 x-codex-turn-state（长度 ${turnState.length} 字节）`,
    });
  }

  const hasGatewayProxy = Boolean(lower['x-oneapi-request-id'] || lower['x-newapi-request-id'] || lower['x-relay-provider']);
  if (hasGatewayProxy) {
    findings.push({
      severity: 'medium',
      code: 'third_party_relay',
      message: '检测到第三方中转代理响应头特征，建议继续运行 L1/L2 行为指纹验证',
    });
  }

  const verdict = modelMismatch
    ? 'suspected_swap'
    : findings.some((f) => f.severity === 'medium')
      ? 'warning'
      : 'healthy';

  const interestingHeaders = {};
  const keepKeys = [
    'openai-model',
    'openai-organization',
    'openai-processing-ms',
    'x-request-id',
    'x-codex-turn-state',
    'x-codex-safety-buffering-enabled',
    'x-safety-buffering',
    'safety-buffering',
    'x-ratelimit-limit-requests',
    'x-ratelimit-remaining-requests',
    'x-oneapi-request-id',
    'x-newapi-request-id',
    'cf-ray',
  ];
  for (const k of keepKeys) {
    if (lower[k] !== undefined) {
      interestingHeaders[k] = k === 'x-codex-turn-state' ? `<len:${lower[k].length}>` : lower[k];
    }
  }

  return {
    status,
    latencyMs,
    requestedModel,
    responseModel: actualModel,
    modelMismatch,
    turnStateLength: turnState ? turnState.length : null,
    safetyBuffering,
    verdict,
    findings,
    headers: interestingHeaders,
  };
}

/**
 * L0.5: Probe local Codex endpoint headers & routing state.
 */
export async function probeCodexProtocol({ codexHome, modelOverride = null, fetchImpl = globalThis.fetch } = {}) {
  const cfg = inspectLocalCodexConfig(codexHome);
  const requestedModel = modelOverride || cfg.model;
  if (!cfg.configured) {
    return {
      ok: false,
      mode: 'codex_protocol',
      targetType: 'codex',
      targetName: 'Codex 本地配置',
      requestedModel,
      responseModel: null,
      verdict: 'unavailable',
      score: null,
      summary: '未在 ~/.codex 找到有效登录凭证（auth.json 或 API Key）',
      details: { authMode: cfg.authMode, baseUrl: cfg.baseUrl },
    };
  }

  try {
    const res = await callModelOnce(
      {
        protocol: 'openai',
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        accessToken: cfg.accessToken,
        accountId: cfg.accountId,
        model: requestedModel,
        wireApi: cfg.wireApi,
        prompt: 'Reply with OK only.',
        maxTokens: 16,
        temperature: 0,
        timeoutMs: 15000,
      },
      fetchImpl
    );
    const evalRes = evaluateCodexProtocolSignals({
      requestedModel,
      responseModel: res.responseModel,
      headers: res.headers,
      status: res.status,
      latencyMs: res.latencyMs,
    });
    const summary =
      evalRes.verdict === 'suspected_swap'
        ? `发现模型不一致：请求 ${requestedModel}，实际返回 ${evalRes.responseModel}`
        : evalRes.verdict === 'warning'
          ? evalRes.findings.find((f) => f.severity === 'medium')?.message || '检测到异常路由头'
          : `协议探查正常（${evalRes.responseModel || requestedModel} · ${res.latencyMs}ms）`;

    return {
      ok: true,
      mode: 'codex_protocol',
      targetType: 'codex',
      targetName: `Codex (${cfg.modelProvider})`,
      requestedModel,
      responseModel: evalRes.responseModel,
      verdict: evalRes.verdict,
      score: evalRes.verdict === 'healthy' ? 100 : evalRes.verdict === 'warning' ? 75 : 20,
      summary,
      details: {
        authMode: cfg.authMode,
        baseUrl: cfg.baseUrl,
        ...evalRes,
      },
    };
  } catch (err) {
    // Even on non-2xx, extract headers if present (e.g. safety-buffering / turn-state)
    const headerEval = err?.headers
      ? evaluateCodexProtocolSignals({
          requestedModel,
          responseModel: err?.data?.model || null,
          headers: err.headers,
          status: err.status || 0,
          latencyMs: err.latencyMs || 0,
        })
      : null;
    return {
      ok: false,
      mode: 'codex_protocol',
      targetType: 'codex',
      targetName: `Codex (${cfg.modelProvider})`,
      requestedModel,
      responseModel: headerEval?.responseModel || null,
      verdict: 'error',
      score: null,
      summary: `协议探查失败：${err.message}`,
      details: {
        authMode: cfg.authMode,
        baseUrl: cfg.baseUrl,
        error: err.message,
        headerEval,
      },
    };
  }
}

/**
 * L1: 8 deterministic capability probes (low-token, local scoring).
 */
export const QUICK_CAPABILITY_PROBES = [
  {
    id: 'exact_count',
    name: '精确字符计数',
    weight: 12,
    prompt:
      'Count the exact number of occurrences of the letter "r" (case-insensitive) in the word "strawberry" AND in "antigravity". Reply with ONLY two integers separated by a comma, e.g. 1,2.',
    evaluate(text) {
      const nums = String(text || '').match(/\d+/g) || [];
      const ok = nums.length >= 2 && Number(nums[0]) === 3 && Number(nums[1]) === 1;
      return { passed: ok, reason: ok ? '准确输出 3,1' : `期望 3,1，实际: ${String(text || '').slice(0, 60)}` };
    },
  },
  {
    id: 'math_mod',
    name: '多步算术取模',
    weight: 13,
    prompt: 'Compute (37 * 43 - 19) mod 17. Reply with ONLY the final integer.',
    evaluate(text) {
      // 37 * 43 = 1591; 1591 - 19 = 1572; 1572 = 17 * 92 + 8 => 8
      const m = String(text || '').trim().match(/-?\d+/g);
      const last = m ? Number(m[m.length - 1]) : NaN;
      const ok = last === 8;
      return { passed: ok, reason: ok ? '精确得出 8' : `期望 8，实际: ${String(text || '').slice(0, 60)}` };
    },
  },
  {
    id: 'json_strict',
    name: '严格纯 JSON 遵循',
    weight: 13,
    prompt:
      'Output ONLY a valid minified JSON object with no markdown fences and no extra text: {"sum": <14+29>, "rev": <"codex" reversed>, "even": <boolean whether 42 is even>}.',
    evaluate(text) {
      const trimmed = String(text || '').trim();
      const hasFence = /```/.test(trimmed);
      try {
        const obj = JSON.parse(trimmed);
        const ok = !hasFence && obj?.sum === 43 && obj?.rev === 'xedoc' && obj?.even === true;
        return {
          passed: ok,
          reason: ok ? '纯 JSON 结构与值完全正确' : `字段不符: ${trimmed.slice(0, 80)}`,
        };
      } catch {
        return { passed: false, reason: `非合法纯 JSON: ${trimmed.slice(0, 80)}` };
      }
    },
  },
  {
    id: 'logic_trap',
    name: '反直觉逻辑推理',
    weight: 14,
    prompt:
      'Alice has 3 sisters and 2 brothers. How many sisters does Alice\'s brother Bob have? Reply with ONLY the integer.',
    evaluate(text) {
      // Alice is female, so Bob has Alice + 3 sisters = 4 sisters.
      const m = String(text || '').match(/\d+/g);
      const val = m ? Number(m[m.length - 1]) : NaN;
      const ok = val === 4;
      return { passed: ok, reason: ok ? '正确计入 Alice 本人得出 4' : `期望 4，实际: ${String(text || '').slice(0, 60)}` };
    },
  },
  {
    id: 'code_trace',
    name: '代码执行追踪',
    weight: 14,
    prompt:
      'What does this JavaScript expression evaluate to? [1, 2, 3, 4].reduce((a, b, i) => a + (i % 2 === 0 ? b * 2 : -b), 0). Reply with ONLY the integer.',
    evaluate(text) {
      // i=0: +2; i=1: -2 => 0; i=2: +6 => 6; i=3: -4 => 2
      const m = String(text || '').match(/-?\d+/g);
      const val = m ? Number(m[m.length - 1]) : NaN;
      const ok = val === 2;
      return { passed: ok, reason: ok ? '准确追踪结果为 2' : `期望 2，实际: ${String(text || '').slice(0, 60)}` };
    },
  },
  {
    id: 'constraint_follow',
    name: '反向格式约束',
    weight: 12,
    prompt:
      'Write EXACTLY 3 short lines in English. Line 1 must start with "A", line 2 with "B", line 3 with "C". Do NOT use the letter "e" or "E" anywhere in your entire reply.',
    evaluate(text) {
      const lines = String(text || '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      const hasE = /e/i.test(lines.join('\n'));
      const startsOk =
        lines.length === 3 &&
        /^A/i.test(lines[0]) &&
        /^B/i.test(lines[1]) &&
        /^C/i.test(lines[2]);
      const ok = startsOk && !hasE;
      return {
        passed: ok,
        reason: ok
          ? '3 行首字母与禁字母约束全部满足'
          : `行数=${lines.length}, 含E=${hasE}, 首字母匹配=${startsOk}`,
      };
    },
  },
  {
    id: 'order_deduction',
    name: '序关系约束推理',
    weight: 12,
    prompt:
      'Four boxes P, Q, R, S have distinct weights. P is heavier than Q. R is lighter than Q. S is heavier than P. List them from lightest to heaviest as 4 uppercase letters separated by commas (e.g. A,B,C,D). Reply ONLY the list.',
    evaluate(text) {
      const letters = (String(text || '').toUpperCase().match(/[PQRS]/g) || []).join(',');
      const ok = letters === 'R,Q,P,S';
      return { passed: ok, reason: ok ? '排序准确 R,Q,P,S' : `期望 R,Q,P,S，实际: ${String(text || '').slice(0, 60)}` };
    },
  },
  {
    id: 'zh_semantic',
    name: '中文语义与标点精控',
    weight: 10,
    prompt:
      '请把句子“冬天能穿多少穿多少，夏天能穿多少穿多少”中前一个“穿多少”和后一个“穿多少”的意思，用不超过 20 个汉字的一句话分别解释，且句中必须包含中文分号“；”。',
    evaluate(text) {
      const s = String(text || '').trim();
      const hanCount = (s.match(/[\u4e00-\u9fff]/g) || []).length;
      const hasSemi = s.includes('；');
      const hasMore = /(多穿|尽量多|越厚|越多|保暖)/.test(s);
      const hasLess = /(少穿|尽量少|越薄|越少|清凉)/.test(s);
      const ok = hasSemi && hanCount > 0 && hanCount <= 28 && hasMore && hasLess;
      return {
        passed: ok,
        reason: ok ? `语义准确且含分号（${hanCount} 汉字）` : `汉字=${hanCount}, 分号=${hasSemi}, 语义=${hasMore && hasLess}`,
      };
    },
  },
];

/**
 * L1: Run all 8 quick capability probes against Codex or a custom OpenAI/Anthropic endpoint.
 */
export async function runQuickCapabilityProbes({
  targetType = 'endpoint',
  targetName,
  endpointConfig,
  codexHome,
  fetchImpl = globalThis.fetch,
} = {}) {
  let conn = endpointConfig;
  let name = targetName;
  if (targetType === 'codex') {
    const cfg = inspectLocalCodexConfig(codexHome);
    if (!cfg.configured) {
      return {
        ok: false,
        mode: 'quick',
        targetType: 'codex',
        targetName: 'Codex 本地配置',
        requestedModel: cfg.model,
        responseModel: null,
        verdict: 'unavailable',
        score: null,
        summary: '未在 ~/.codex 找到有效登录凭证',
        details: { probes: [] },
      };
    }
    conn = {
      protocol: 'openai',
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      accessToken: cfg.accessToken,
      accountId: cfg.accountId,
      model: endpointConfig?.model || cfg.model,
      wireApi: cfg.wireApi,
    };
    name = name || `Codex (${cfg.modelProvider})`;
  }

  const results = [];
  let responseModel = null;
  let totalScore = 0;
  let maxScore = 0;
  let latencySum = 0;
  let successCalls = 0;

  for (const probe of QUICK_CAPABILITY_PROBES) {
    maxScore += probe.weight;
    try {
      const res = await callModelOnce(
        {
          ...conn,
          prompt: probe.prompt,
          maxTokens: 160,
          temperature: 0,
          timeoutMs: 22000,
        },
        fetchImpl
      );
      if (!responseModel && res.responseModel) responseModel = res.responseModel;
      latencySum += res.latencyMs;
      successCalls += 1;
      const ev = probe.evaluate(res.text);
      if (ev.passed) totalScore += probe.weight;
      results.push({
        id: probe.id,
        name: probe.name,
        weight: probe.weight,
        passed: ev.passed,
        score: ev.passed ? probe.weight : 0,
        latencyMs: res.latencyMs,
        reason: ev.reason,
        snippet: res.text.slice(0, 120),
      });
    } catch (err) {
      results.push({
        id: probe.id,
        name: probe.name,
        weight: probe.weight,
        passed: false,
        score: 0,
        latencyMs: err.latencyMs || 0,
        reason: `请求失败: ${err.message}`,
        snippet: '',
      });
    }
  }

  if (successCalls === 0) {
    return {
      ok: false,
      mode: 'quick',
      targetType,
      targetName: name || conn?.model || '端点',
      requestedModel: conn?.model || 'unknown',
      responseModel: null,
      verdict: 'error',
      score: 0,
      summary: results[0]?.reason || '全部探针请求失败，请检查端点地址、模型名与密钥',
      details: { probes: results, avgLatencyMs: null },
    };
  }

  const pctScore = Math.round((totalScore / maxScore) * 100);
  const reqNorm = String(conn?.model || '').trim().toLowerCase();
  const actNorm = String(responseModel || '').trim().toLowerCase();
  const modelMismatch = Boolean(reqNorm && actNorm && !actNorm.includes(reqNorm) && !reqNorm.includes(actNorm));
  const passedCount = results.filter((r) => r.passed).length;
  const avgLatencyMs = Math.round(latencySum / successCalls);

  const verdict = modelMismatch
    ? 'suspected_swap'
    : pctScore >= 85
      ? 'healthy'
      : pctScore >= 60
        ? 'warning'
        : 'degraded';

  const summary = modelMismatch
    ? `得分 ${pctScore}/100（${passedCount}/${results.length} 通过），但实际返回模型为 ${responseModel}（疑似换模）`
    : verdict === 'healthy'
      ? `能力探针表现正常：${pctScore}/100（${passedCount}/${results.length} 通过 · 均延 ${avgLatencyMs}ms）`
      : verdict === 'warning'
        ? `轻度波动/疑似降智：${pctScore}/100（${passedCount}/${results.length} 通过）`
        : `高概率降智或弱模型替代：${pctScore}/100（仅 ${passedCount}/${results.length} 通过）`;

  return {
    ok: true,
    mode: 'quick',
    targetType,
    targetName: name || conn?.model || '端点',
    requestedModel: conn?.model || 'unknown',
    responseModel,
    verdict,
    score: pctScore,
    summary,
    details: {
      passedCount,
      totalCount: results.length,
      avgLatencyMs,
      modelMismatch,
      probes: results,
    },
  };
}

/**
 * Build a single copy-pasteable manual probe pack for private clients (Antigravity / Cursor / CodeBuddy).
 */
export function buildManualProbePack() {
  const prompt = [
    '[ATM-PROBE-V1] 请直接回答下面 5 题，只输出一个合法 JSON 对象（不要任何解释或 Markdown 代码块）：',
    '{"q1": "<strawberry 和 antigravity 各自包含几个字母 r，格式如 3,1>",',
    ' "q2": <(37 * 43 - 19) mod 17 的整数结果>,',
    ' "q3": <Alice 有 3 个姐妹和 2 个兄弟，她的兄弟 Bob 有几个姐妹（整数）>,',
    ' "q4": <[1,2,3,4].reduce((a,b,i)=>a+(i%2===0?b*2:-b),0) 的整数结果>,',
    ' "q5": "<P>Q, R<Q, S>P 按从轻到重排列，4 个大写字母用逗号隔开>"}',
  ].join('\n');

  return {
    marker: '[ATM-PROBE-V1]',
    prompt,
    questionCount: 5,
  };
}

/**
 * Score a reply captured from Antigravity / Cursor / CodeBuddy for the manual probe pack.
 * @param {string} replyText
 * @param {{ tool?: string, model?: string }} [meta]
 */
export function scoreManualProbeResponse(replyText, { tool = 'antigravity', model = 'unknown' } = {}) {
  const raw = String(replyText || '').trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    return {
      ok: false,
      mode: 'manual',
      targetType: 'client',
      targetName: TOOL_LABELS[tool] || tool,
      tool,
      requestedModel: model,
      responseModel: model,
      verdict: 'error',
      score: 0,
      summary: '未在回复中识别到 JSON 结果，请粘贴完整模型回复或先发送标准探针题',
      details: { probes: [], rawPreview: raw.slice(0, 160) },
    };
  }

  let parsed = null;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return {
      ok: false,
      mode: 'manual',
      targetType: 'client',
      targetName: TOOL_LABELS[tool] || tool,
      tool,
      requestedModel: model,
      responseModel: model,
      verdict: 'error',
      score: 0,
      summary: 'JSON 解析失败，模型未遵守严格输出格式',
      details: { probes: [], rawPreview: match[0].slice(0, 160) },
    };
  }

  const checks = [
    {
      id: 'q1',
      name: '精确字符计数 (3,1)',
      weight: 20,
      passed: (() => {
        const nums = String(parsed.q1 ?? '').match(/\d+/g) || [];
        return nums.length >= 2 && Number(nums[0]) === 3 && Number(nums[1]) === 1;
      })(),
      got: String(parsed.q1 ?? ''),
    },
    {
      id: 'q2',
      name: '多步算术取模 (8)',
      weight: 20,
      passed: Number(parsed.q2) === 8,
      got: String(parsed.q2 ?? ''),
    },
    {
      id: 'q3',
      name: '逻辑陷阱 (4)',
      weight: 20,
      passed: Number(parsed.q3) === 4,
      got: String(parsed.q3 ?? ''),
    },
    {
      id: 'q4',
      name: 'JS 代码追踪 (2)',
      weight: 20,
      passed: Number(parsed.q4) === 2,
      got: String(parsed.q4 ?? ''),
    },
    {
      id: 'q5',
      name: '序关系推理 (R,Q,P,S)',
      weight: 20,
      passed: (String(parsed.q5 ?? '').toUpperCase().match(/[PQRS]/g) || []).join(',') === 'R,Q,P,S',
      got: String(parsed.q5 ?? ''),
    },
  ];

  const score = checks.reduce((s, c) => s + (c.passed ? c.weight : 0), 0);
  const passedCount = checks.filter((c) => c.passed).length;
  const verdict = score >= 80 ? 'healthy' : score >= 60 ? 'warning' : 'degraded';
  const summary =
    verdict === 'healthy'
      ? `半自动探针通过：${score}/100（${passedCount}/5 正确）`
      : verdict === 'warning'
        ? `疑似波动：${score}/100（${passedCount}/5 正确）`
        : `疑似降智：${score}/100（仅 ${passedCount}/5 正确）`;

  return {
    ok: true,
    mode: 'manual',
    targetType: 'client',
    targetName: TOOL_LABELS[tool] || tool,
    tool,
    requestedModel: model,
    responseModel: model,
    verdict,
    score,
    summary,
    details: {
      passedCount,
      totalCount: checks.length,
      probes: checks.map((c) => ({
        id: c.id,
        name: c.name,
        weight: c.weight,
        passed: c.passed,
        score: c.passed ? c.weight : 0,
        reason: c.passed ? `正确 (${c.got})` : `回答为 "${c.got}"`,
      })),
    },
  };
}

/**
 * L2: Single-token instinct distribution probes ("One Token Is Enough").
 */
export const SINGLE_TOKEN_PROBES = [
  {
    id: 'int_1_10',
    label: '直觉选数字 (1-10)',
    kind: 'int',
    prompt: 'Pick a random integer from 1 to 10 on instinct. Reply with ONLY that single integer.',
  },
  {
    id: 'color',
    label: '直觉选颜色',
    kind: 'word',
    prompt: 'Pick one color word on instinct. Reply with ONLY one single English word.',
  },
  {
    id: 'fruit',
    label: '直觉选水果',
    kind: 'word',
    prompt: 'Pick one fruit on instinct. Reply with ONLY one single English word.',
  },
  {
    id: 'letter',
    label: '直觉选字母 (A-Z)',
    kind: 'letter',
    prompt: 'Pick a single uppercase English letter from A to Z on instinct. Reply with ONLY that letter.',
  },
  {
    id: 'animal',
    label: '直觉选动物',
    kind: 'word',
    prompt: 'Pick one animal on instinct. Reply with ONLY one single English word.',
  },
];

async function runWithConcurrency(tasks, concurrency = 5) {
  const results = new Array(tasks.length);
  let nextIdx = 0;
  async function worker() {
    while (nextIdx < tasks.length) {
      const cur = nextIdx;
      nextIdx += 1;
      results[cur] = await tasks[cur]();
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * L2: Run single-token distribution fingerprinting and optionally record or compare against a baseline.
 */
export async function runTokenDistributionFingerprint({
  targetType = 'endpoint',
  targetName,
  endpointConfig,
  codexHome,
  sampleCount = 50,
  recordBaseline = false,
  baselineName = null,
  baselineId = null,
  store = null,
  fetchImpl = globalThis.fetch,
} = {}) {
  let conn = endpointConfig;
  let name = targetName;
  if (targetType === 'codex') {
    const cfg = inspectLocalCodexConfig(codexHome);
    if (!cfg.configured) {
      return {
        ok: false,
        mode: 'deep',
        targetType: 'codex',
        targetName: 'Codex 本地配置',
        requestedModel: cfg.model,
        responseModel: null,
        verdict: 'unavailable',
        score: null,
        jsDistance: null,
        summary: '未在 ~/.codex 找到有效登录凭证',
        details: {},
      };
    }
    conn = {
      protocol: 'openai',
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      accessToken: cfg.accessToken,
      accountId: cfg.accountId,
      model: endpointConfig?.model || cfg.model,
      wireApi: cfg.wireApi,
    };
    name = name || `Codex (${cfg.modelProvider})`;
  }

  const clampedTotal = Math.min(150, Math.max(10, Number(sampleCount) || 50));
  const perProbe = Math.max(2, Math.round(clampedTotal / SINGLE_TOKEN_PROBES.length));

  const tasks = [];
  for (const probe of SINGLE_TOKEN_PROBES) {
    for (let i = 0; i < perProbe; i += 1) {
      tasks.push(async () => {
        try {
          const res = await callModelOnce(
            {
              ...conn,
              prompt: probe.prompt,
              maxTokens: 6,
              temperature: 1.0,
              timeoutMs: 18000,
            },
            fetchImpl
          );
          return {
            ok: true,
            probeId: probe.id,
            token: normalizeSingleTokenAnswer(res.text, probe.kind),
            responseModel: res.responseModel,
            latencyMs: res.latencyMs,
          };
        } catch (err) {
          return { ok: false, probeId: probe.id, error: err.message };
        }
      });
    }
  }

  const samples = await runWithConcurrency(tasks, 5);
  const okSamples = samples.filter((s) => s.ok);
  if (okSamples.length === 0) {
    return {
      ok: false,
      mode: 'deep',
      targetType,
      targetName: name || conn?.model || '端点',
      requestedModel: conn?.model || 'unknown',
      responseModel: null,
      verdict: 'error',
      score: 0,
      jsDistance: null,
      summary: `深度指纹采样失败：${samples[0]?.error || '全部请求出错'}`,
      details: { totalSamples: samples.length, succeededSamples: 0 },
    };
  }

  const responseModel = okSamples.find((s) => s.responseModel)?.responseModel || null;
  const distributions = {};
  for (const probe of SINGLE_TOKEN_PROBES) {
    const counts = {};
    let total = 0;
    for (const s of okSamples) {
      if (s.probeId !== probe.id) continue;
      counts[s.token] = (counts[s.token] || 0) + 1;
      total += 1;
    }
    const probs = {};
    for (const [tok, c] of Object.entries(counts)) {
      probs[tok] = total > 0 ? Number((c / total).toFixed(4)) : 0;
    }
    distributions[probe.id] = { label: probe.label, total, counts, probs };
  }

  let savedBaseline = null;
  if (recordBaseline && store) {
    savedBaseline = store.saveFingerprintBaseline({
      id: `bl-${randomUUID().slice(0, 8)}`,
      name: baselineName || `${name || conn?.model} 基线`,
      model: conn?.model || responseModel || 'unknown',
      targetName: name || conn?.model || '端点',
      sampleCount: okSamples.length,
      createdAtMs: Date.now(),
      distribution: distributions,
    });
  }

  // Match against explicit baselineId or latest baseline for the same model
  let matchedBaseline = null;
  if (!recordBaseline && store) {
    const allBaselines = store.listFingerprintBaselines();
    if (baselineId) {
      matchedBaseline = allBaselines.find((b) => b.id === baselineId) || null;
    } else if (conn?.model) {
      matchedBaseline =
        allBaselines.find((b) => b.model.toLowerCase() === String(conn.model).toLowerCase()) || null;
    }
  }

  let meanJsDistance = null;
  let maxJsDistance = null;
  const perProbeJs = {};

  if (matchedBaseline?.distribution) {
    const jsList = [];
    for (const probe of SINGLE_TOKEN_PROBES) {
      const curCounts = distributions[probe.id]?.counts || {};
      const baseCounts = matchedBaseline.distribution[probe.id]?.counts || matchedBaseline.distribution[probe.id]?.probs || {};
      if (Object.keys(curCounts).length > 0 && Object.keys(baseCounts).length > 0) {
        const js = computeJsDivergence(curCounts, baseCounts);
        perProbeJs[probe.id] = js;
        jsList.push(js);
      }
    }
    if (jsList.length > 0) {
      meanJsDistance = Number((jsList.reduce((a, b) => a + b, 0) / jsList.length).toFixed(4));
      maxJsDistance = Number(Math.max(...jsList).toFixed(4));
    }
  }

  let verdict = 'baseline_recorded';
  let score = 100;
  let summary = '';
  if (savedBaseline) {
    verdict = 'baseline_recorded';
    score = 100;
    summary = `已录制参考基线「${savedBaseline.name}」（成功采样 ${okSamples.length}/${samples.length} 次）`;
  } else if (meanJsDistance !== null) {
    if (meanJsDistance < 0.08) {
      verdict = 'healthy';
      score = Math.round((1 - meanJsDistance) * 100);
      summary = `单 Token 分布与基线「${matchedBaseline.name}」高度一致（JS 散度 ${meanJsDistance.toFixed(3)}）`;
    } else if (meanJsDistance < 0.18) {
      verdict = 'warning';
      score = Math.round((1 - meanJsDistance) * 100);
      summary = `分布轻度偏移（JS 散度 ${meanJsDistance.toFixed(3)}），可能存在量化或版本微调`;
    } else {
      verdict = 'suspected_swap';
      score = Math.max(0, Math.round((1 - meanJsDistance) * 100));
      summary = `分布显著偏离基线「${matchedBaseline.name}」（JS 散度 ${meanJsDistance.toFixed(3)}），高度疑似偷换模型或重度量化`;
    }
  } else {
    verdict = 'no_baseline';
    score = null;
    summary = `已完成 ${okSamples.length} 次单 Token 分布采样；当前模型尚无参考基线，建议点击「录制为基线」留档`;
  }

  return {
    ok: true,
    mode: 'deep',
    targetType,
    targetName: name || conn?.model || '端点',
    requestedModel: conn?.model || 'unknown',
    responseModel,
    verdict,
    score,
    jsDistance: meanJsDistance,
    summary,
    details: {
      totalSamples: samples.length,
      succeededSamples: okSamples.length,
      meanJsDistance,
      maxJsDistance,
      perProbeJs,
      baselineId: savedBaseline?.id || matchedBaseline?.id || null,
      baselineName: savedBaseline?.name || matchedBaseline?.name || null,
      distributions,
    },
  };
}
