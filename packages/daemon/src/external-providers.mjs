import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { httpRequestJson, httpRequestRaw } from './net.mjs';
import { computeQuotaWindow, formatDurationZh } from './quota.mjs';

const RESERVED_IDS = new Set(['all', 'antigravity', 'codex', 'claude', 'cursor', 'codebuddy']);
const VALID_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const VALID_EXT_KEY_RE = /^ext:[a-z0-9][a-z0-9_-]{0,31}$/;
const VALID_PLUGIN_FILENAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}\.mjs$/;
const VALID_ICON_RE = /^[a-zA-Z0-9._-]{1,64}$/;
const VALID_HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const VALID_DOMAIN_RE = /^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$/;
const MAX_PLUGIN_BYTES = 256 * 1024;
const DEFAULT_AUTH_EXCLUDE_KEYWORDS = [
  'login',
  'signin',
  'sign-in',
  'auth',
  'oauth',
  'passport',
  'sso',
  'callback',
];

const DEFAULT_CACHE_TTL_MS = 45_000;
const MIN_CACHE_TTL_MS = 5_000;
const MAX_CACHE_TTL_MS = 600_000;
const DEFAULT_TIMEOUT_MS = 8_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 15_000;
const STALE_GRACE_MS = 15 * 60 * 1000;

export function isExternalProviderKey(key) {
  return typeof key === 'string' && VALID_EXT_KEY_RE.test(key);
}

export function defaultExternalProvidersDir(stateDir = null) {
  const envDir = process.env.AI_TURN_METER_PROVIDERS_DIR?.trim();
  if (envDir) return envDir;
  const base = stateDir || join(homedir(), '.local', 'share', 'ai-turn-meter');
  return join(base, 'providers');
}

function currencySymbolFor(currencyCode, explicitSymbol = null) {
  if (typeof explicitSymbol === 'string' && explicitSymbol.trim()) {
    return explicitSymbol.trim().slice(0, 4);
  }
  const code = String(currencyCode || 'USD').trim().toUpperCase();
  if (code === 'CNY' || code === 'RMB' || code === 'JPY') return '¥';
  if (code === 'EUR') return '€';
  if (code === 'GBP') return '£';
  return '$';
}

function sanitizeHttpUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return parsed.toString();
    }
  } catch {}
  return null;
}

function normalizeStringList(raw, { max = 20, maxLen = 128, lower = false } = {}) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    let s = item.trim();
    if (!s) continue;
    if (lower) s = s.toLowerCase();
    s = s.slice(0, maxLen);
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

function normalizeAuthConfig(rawAuth) {
  if (!rawAuth || typeof rawAuth !== 'object') return null;
  const loginUrl = sanitizeHttpUrl(rawAuth.loginUrl);
  const rawType =
    typeof rawAuth.type === 'string' && rawAuth.type.trim()
      ? rawAuth.type.trim().toLowerCase()
      : loginUrl
        ? 'web_cookie'
        : 'token';
  if (rawType !== 'web_cookie' && rawType !== 'token') return null;
  if (rawType === 'web_cookie' && !loginUrl) return null;

  let cookieDomains = normalizeStringList(rawAuth.cookieDomains, {
    max: 10,
    maxLen: 128,
    lower: true,
  })
    .map((d) => d.replace(/^\.+/, ''))
    .filter((d) => VALID_DOMAIN_RE.test(d));
  if (cookieDomains.length === 0 && loginUrl) {
    try {
      const host = new URL(loginUrl).hostname.toLowerCase();
      if (VALID_DOMAIN_RE.test(host)) cookieDomains = [host];
    } catch {}
  }

  const requiredCookies = normalizeStringList(rawAuth.requiredCookies, { max: 20, maxLen: 128 });
  const successUrlPrefixes = Array.isArray(rawAuth.successUrlPrefixes)
    ? rawAuth.successUrlPrefixes
        .map((u) => sanitizeHttpUrl(u))
        .filter(Boolean)
        .slice(0, 10)
    : [];
  const excludePathKeywords =
    Array.isArray(rawAuth.excludePathKeywords) && rawAuth.excludePathKeywords.length > 0
      ? normalizeStringList(rawAuth.excludePathKeywords, { max: 20, maxLen: 64, lower: true })
      : [...DEFAULT_AUTH_EXCLUDE_KEYWORDS];
  const captureStorageKeys = normalizeStringList(rawAuth.captureStorageKeys, {
    max: 30,
    maxLen: 128,
  });

  const label =
    typeof rawAuth.label === 'string' && rawAuth.label.trim()
      ? rawAuth.label.trim().slice(0, 32)
      : rawType === 'web_cookie'
        ? '网页登录授权'
        : '配置凭证';
  const hint =
    typeof rawAuth.hint === 'string' && rawAuth.hint.trim()
      ? rawAuth.hint.trim().slice(0, 180)
      : null;

  return {
    type: rawType,
    loginUrl: loginUrl || null,
    cookieDomains,
    requiredCookies,
    successUrlPrefixes,
    excludePathKeywords,
    captureStorageKeys,
    label,
    hint,
  };
}

function sanitizeStringRecord(raw, { maxEntries = 100, maxKeyLen = 128, maxValLen = 32768 } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  let count = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (count >= maxEntries) break;
    const key = String(k || '').trim().slice(0, maxKeyLen);
    if (!key || typeof v !== 'string') continue;
    out[key] = v.slice(0, maxValLen);
    count += 1;
  }
  return count > 0 ? out : null;
}

export function sanitizeCredentialsInput(raw) {
  if (!raw || typeof raw !== 'object') return null;
  let cookie =
    typeof raw.cookie === 'string' && raw.cookie.trim()
      ? raw.cookie.trim().slice(0, 65536)
      : null;
  const cookies = sanitizeStringRecord(raw.cookies, {
    maxEntries: 120,
    maxKeyLen: 128,
    maxValLen: 8192,
  });
  if (!cookie && cookies) {
    cookie = Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ')
      .slice(0, 65536);
  }
  const token =
    typeof raw.token === 'string' && raw.token.trim()
      ? raw.token.trim().slice(0, 16384)
      : null;
  const userAgent =
    typeof raw.userAgent === 'string' && raw.userAgent.trim()
      ? raw.userAgent.trim().slice(0, 512)
      : null;
  const origin = sanitizeHttpUrl(raw.origin);

  let storage = null;
  if (raw.storage && typeof raw.storage === 'object' && !Array.isArray(raw.storage)) {
    const local = sanitizeStringRecord(raw.storage.local, {
      maxEntries: 64,
      maxKeyLen: 128,
      maxValLen: 32768,
    });
    const session = sanitizeStringRecord(raw.storage.session, {
      maxEntries: 64,
      maxKeyLen: 128,
      maxValLen: 32768,
    });
    if (local || session) {
      storage = {
        ...(local ? { local } : {}),
        ...(session ? { session } : {}),
      };
    }
  }

  let extra = null;
  if (raw.extra && typeof raw.extra === 'object' && !Array.isArray(raw.extra)) {
    try {
      const serialized = JSON.stringify(raw.extra);
      if (serialized && serialized.length <= 32768 && serialized !== '{}') {
        extra = JSON.parse(serialized);
      }
    } catch {}
  }

  if (!cookie && !token && !storage && !extra) return null;

  return {
    ...(cookie ? { cookie } : {}),
    ...(cookies ? { cookies } : {}),
    ...(token ? { token } : {}),
    ...(userAgent ? { userAgent } : {}),
    ...(origin ? { origin } : {}),
    ...(storage ? { storage } : {}),
    ...(extra ? { extra } : {}),
    savedAtMs: typeof raw.savedAtMs === 'number' && Number.isFinite(raw.savedAtMs)
      ? raw.savedAtMs
      : Date.now(),
  };
}

function sanitizeSlug(raw, fallbackStem) {
  const base = String(raw || fallbackStem || '')
    .trim()
    .toLowerCase()
    .replace(/^ext:/, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  if (!base || !VALID_SLUG_RE.test(base) || RESERVED_IDS.has(base)) {
    return null;
  }
  return base;
}

function toFiniteNumber(val) {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (typeof val === 'string' && val.trim() !== '') {
    const n = Number(val);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function toNonNegInt(val) {
  const n = toFiniteNumber(val);
  if (n === null || n < 0) return null;
  return Math.round(n);
}

function formatMoneyAmount(val, symbol) {
  const n = toFiniteNumber(val);
  if (n === null) return null;
  if (n <= 0) return `${symbol}0.00`;
  if (n < 0.01) return `${symbol}${n.toFixed(4)}`;
  return `${symbol}${n.toFixed(2)}`;
}

function toZhMonthDayFromYmd(ymd) {
  const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return String(ymd || '');
  return `${Number(m[2])}月${Number(m[3])}日`;
}

function normalizeQuotaWindow(raw, idx, { key, currencySymbol, nowMs }) {
  if (!raw || typeof raw !== 'object') return null;
  const id =
    typeof raw.id === 'string' && raw.id.trim() ? `${key}:${raw.id.trim()}` : `${key}:win-${idx}`;
  const title =
    typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : `额度 ${idx + 1}`;

  const used = toFiniteNumber(raw.used ?? raw.usedAmount);
  const limit = toFiniteNumber(raw.limit ?? raw.limitAmount);
  const remaining = toFiniteNumber(raw.remaining ?? raw.remainingAmount);

  let usedPct = toFiniteNumber(raw.usedPct ?? raw.usagePercent);
  let remainingPct = toFiniteNumber(raw.remainingPct ?? raw.remainingPercent);

  if (usedPct === null && remainingPct === null && used !== null && limit !== null && limit > 0) {
    usedPct = (used / limit) * 100;
  }
  if (remainingPct === null && usedPct !== null) {
    remainingPct = Math.max(0, Math.min(100, 100 - usedPct));
  }
  if (remainingPct === null && remaining !== null && limit !== null && limit > 0) {
    remainingPct = Math.max(0, Math.min(100, (remaining / limit) * 100));
  }
  if (remainingPct === null) return null;

  const windowSeconds = toFiniteNumber(raw.windowSeconds);
  const resetAtMs = toFiniteNumber(raw.resetAtMs);
  const group = typeof raw.group === 'string' && raw.group.trim() ? raw.group.trim() : null;
  const windowKind =
    typeof raw.windowKind === 'string' && raw.windowKind.trim() ? raw.windowKind.trim() : null;

  const resolvedUsed =
    used !== null ? used : remaining !== null && limit !== null && limit > 0 ? Math.max(0, limit - remaining) : null;
  let autoNote = null;
  if (resolvedUsed !== null && limit !== null && limit > 0) {
    const usedStr = formatMoneyAmount(resolvedUsed, currencySymbol);
    const limitStr = formatMoneyAmount(limit, currencySymbol);
    const remVal = remaining !== null ? remaining : Math.max(0, limit - resolvedUsed);
    const remStr = formatMoneyAmount(remVal, currencySymbol);
    autoNote = `已用 ${usedStr} / ${limitStr} · 剩余 ${remStr}`;
  } else if (resolvedUsed !== null) {
    autoNote = `已用 ${formatMoneyAmount(resolvedUsed, currencySymbol)}`;
  }

  const explicitSub = typeof raw.subtitle === 'string' && raw.subtitle.trim() ? raw.subtitle.trim() : null;
  const computed = computeQuotaWindow({
    id,
    title,
    remainingPct,
    windowSeconds,
    resetAtMs,
    nowMs,
    extraNote: explicitSub ? null : autoNote,
    group,
    windowKind,
  });
  if (!computed) return null;

  const explicitResetText =
    typeof raw.resetText === 'string' && raw.resetText.trim() ? raw.resetText.trim() : null;

  return {
    ...computed,
    ...(group ? { group } : {}),
    ...(windowKind ? { windowKind } : {}),
    resetText: explicitResetText ?? computed.resetText,
    subtitle: explicitSub ?? computed.subtitle,
  };
}

function normalizeDailyPoints(rawDaily) {
  if (!Array.isArray(rawDaily) || rawDaily.length === 0) return [];
  const byDate = new Map();
  for (const pt of rawDaily) {
    if (!pt || typeof pt !== 'object') continue;
    const date = typeof pt.date === 'string' ? pt.date.trim() : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const cost = toFiniteNumber(pt.cost ?? pt.costUsd ?? pt.usedCny ?? pt.amount);
    const tokens = toNonNegInt(pt.tokens ?? pt.totalTokens) ?? 0;
    const turnCount = toNonNegInt(pt.turnCount) ?? 0;
    const models = Array.isArray(pt.models)
      ? pt.models
          .filter((m) => m && typeof m.model === 'string' && m.model.trim())
          .slice(0, 6)
          .map((m) => ({
            model: m.model.trim(),
            costUsd: toFiniteNumber(m.cost ?? m.costUsd),
            totalTokens: toNonNegInt(m.tokens ?? m.totalTokens) ?? 0,
          }))
      : [];
    byDate.set(date, {
      date,
      label: typeof pt.label === 'string' && pt.label.trim() ? pt.label.trim() : toZhMonthDayFromYmd(date),
      totalTokens: tokens,
      costUsd: cost !== null ? Number(cost.toFixed(4)) : null,
      turnCount,
      models,
    });
  }
  return Array.from(byDate.values())
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-31);
}

function normalizeBreakdowns(rawBreakdowns) {
  if (!Array.isArray(rawBreakdowns) || rawBreakdowns.length === 0) return [];
  const sections = [];
  for (let sIdx = 0; sIdx < rawBreakdowns.length; sIdx += 1) {
    const sec = rawBreakdowns[sIdx];
    if (!sec || typeof sec !== 'object' || !Array.isArray(sec.items)) continue;
    const secId =
      typeof sec.id === 'string' && sec.id.trim() ? sec.id.trim() : `section-${sIdx}`;
    const secTitle =
      typeof sec.title === 'string' && sec.title.trim() ? sec.title.trim() : secId;
    const items = [];
    for (let i = 0; i < sec.items.length && items.length < 30; i += 1) {
      const it = sec.items[i];
      if (!it || typeof it !== 'object') continue;
      const name = typeof it.name === 'string' && it.name.trim() ? it.name.trim() : null;
      if (!name) continue;
      const cost = toFiniteNumber(it.cost ?? it.usedCny ?? it.costUsd);
      const limit = toFiniteNumber(it.limit ?? it.quotaCny);
      let usagePct = toFiniteNumber(it.usagePct ?? it.usagePercent);
      if (usagePct === null && cost !== null && limit !== null && limit > 0) {
        usagePct = Number(((cost / limit) * 100).toFixed(1));
      }
      const sharePct = toFiniteNumber(it.sharePct ?? it.usageSharePercent);
      const tokens = toNonNegInt(it.tokens ?? it.totalTokens);
      items.push({
        id: typeof it.id === 'string' && it.id.trim() ? it.id.trim() : `${secId}-${i}`,
        name,
        cost: cost !== null ? Number(cost.toFixed(4)) : null,
        limit: limit !== null && limit > 0 ? Number(limit.toFixed(4)) : null,
        usagePct: usagePct !== null ? Number(usagePct.toFixed(1)) : null,
        sharePct: sharePct !== null ? Number(sharePct.toFixed(1)) : null,
        tokens,
        subtitle: typeof it.subtitle === 'string' && it.subtitle.trim() ? it.subtitle.trim() : null,
      });
    }
    if (items.length > 0) {
      sections.push({ id: secId, title: secTitle, items });
    }
  }
  return sections;
}

function buildNormalizedCard(meta, raw, { nowMs, stale = false, errorMessage = null } = {}) {
  const data = raw && typeof raw === 'object' ? raw : {};
  const currencyCode = String(data.currency || meta.currency || 'USD').trim().toUpperCase();
  const currencySymbol = currencySymbolFor(currencyCode, data.currencySymbol || meta.currencySymbol);

  const quotaWindows = Array.isArray(data.quotaWindows)
    ? data.quotaWindows
        .map((w, idx) => normalizeQuotaWindow(w, idx, { key: meta.key, currencySymbol, nowMs }))
        .filter(Boolean)
    : [];

  const daily30 = normalizeDailyPoints(data.daily ?? data.daily30);
  const breakdowns = normalizeBreakdowns(data.breakdowns);

  const m = data.metrics && typeof data.metrics === 'object' ? data.metrics : {};
  const todayCost = toFiniteNumber(m.todayCost ?? data.todayCost);
  const todayTokens = toNonNegInt(m.todayTokens ?? data.todayTokens);
  const periodLabel =
    typeof m.periodLabel === 'string' && m.periodLabel.trim() ? m.periodLabel.trim() : '本月';
  const periodCost = toFiniteNumber(m.periodCost ?? data.periodCost);
  const periodLimit = toFiniteNumber(m.periodLimit ?? data.periodLimit);
  const periodRemaining =
    toFiniteNumber(m.periodRemaining ?? data.periodRemaining) ??
    (periodCost !== null && periodLimit !== null ? Math.max(0, periodLimit - periodCost) : null);
  const periodTokens = toNonNegInt(m.periodTokens ?? data.periodTokens);
  const updatedAtMs = toFiniteNumber(m.updatedAtMs ?? data.updatedAtMs) ?? nowMs;

  let topModel =
    typeof data.topModel === 'string' && data.topModel.trim() ? data.topModel.trim() : null;
  if (!topModel) {
    const modelSec = breakdowns.find(
      (s) => s.id.toLowerCase().includes('model') || s.title.includes('模型')
    );
    if (modelSec?.items?.[0]?.name) {
      topModel = modelSec.items[0].name;
    }
  }

  const detailUrl = sanitizeHttpUrl(data.detailUrl) || meta.detailUrl || null;
  const accountEmail =
    typeof (data.account ?? data.accountEmail) === 'string' &&
    String(data.account ?? data.accountEmail).trim()
      ? String(data.account ?? data.accountEmail).trim()
      : null;
  const planTitle =
    typeof (data.planTitle ?? data.orgName) === 'string' &&
    String(data.planTitle ?? data.orgName).trim()
      ? String(data.planTitle ?? data.orgName).trim()
      : null;
  const quotaHint =
    typeof (data.hint ?? data.quotaHint) === 'string' &&
    String(data.hint ?? data.quotaHint).trim()
      ? String(data.hint ?? data.quotaHint).trim()
      : errorMessage || null;
  const statusText =
    typeof data.statusText === 'string' && data.statusText.trim()
      ? data.statusText.trim()
      : errorMessage
        ? stale
          ? '缓存数据'
          : '同步异常'
        : '已同步';
  const footnote =
    typeof data.footnote === 'string' && data.footnote.trim()
      ? data.footnote.trim()
      : currencyCode === 'CNY'
        ? '外部数据源插件 · 人民币口径'
        : '外部数据源插件';

  return {
    isExternal: true,
    providerName: meta.name,
    providerShortName: meta.shortName,
    providerIcon: meta.icon,
    accentColor: meta.accentColor,
    currencyCode,
    currencySymbol,
    detailUrl,
    statusText,
    footnote,
    stale: Boolean(stale || data.stale),
    needsAuth: Boolean(data.needsAuth),
    accountEmail,
    planTitle,
    quotaWindows,
    resetCreditsText:
      typeof data.resetCreditsText === 'string' && data.resetCreditsText.trim()
        ? data.resetCreditsText.trim()
        : null,
    quotaHint,
    latestTpsText: null,
    latestCacheText: null,
    latestTurnSubline: null,
    billingSummary: {
      todayCost: todayCost !== null ? Number(todayCost.toFixed(4)) : null,
      todayTokens,
      periodLabel,
      periodCost: periodCost !== null ? Number(periodCost.toFixed(4)) : null,
      periodLimit: periodLimit !== null && periodLimit > 0 ? Number(periodLimit.toFixed(4)) : null,
      periodRemaining: periodRemaining !== null ? Number(periodRemaining.toFixed(4)) : null,
      periodTokens,
      updatedAtMs,
    },
    today: {
      costUsd: todayCost !== null ? Number(todayCost.toFixed(4)) : null,
      totalTokens: todayTokens ?? 0,
      totalInputTokens: 0,
      outputTokens: 0,
      turnCount: 0,
      callCount: 0,
      cacheRatePct: null,
      avgTps: null,
      cacheSavingsUsd: null,
    },
    currentWindow: {
      costUsd: periodCost !== null ? Number(periodCost.toFixed(4)) : null,
      totalTokens: periodTokens ?? 0,
      turnCount: 0,
    },
    days30: {
      costUsd: periodCost !== null ? Number(periodCost.toFixed(4)) : null,
      totalTokens: periodTokens ?? 0,
      turnCount: 0,
    },
    daily30,
    projects: [],
    recentWindows: [],
    breakdowns,
    topModel,
  };
}

function buildOverviewWindow(meta, card) {
  const wins = card?.quotaWindows;
  if (!Array.isArray(wins) || wins.length === 0) return null;
  const primary = wins[0];
  const secondary = wins[1];
  const subParts = [];
  if (primary.subtitle) subParts.push(primary.subtitle);
  if (secondary) {
    subParts.push(`${secondary.title} ${Math.round(secondary.remainingPct)}%`);
  }
  return {
    ...primary,
    id: `overview-${meta.key}`,
    title: meta.shortName,
    subtitle: subParts.length > 0 ? subParts.join(' · ') : null,
  };
}

async function runWithTimeout(promise, timeoutMs, label) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`插件 ${label} 响应超时 (${timeoutMs}ms)`));
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function sanitizePluginFileName(raw) {
  if (typeof raw !== 'string') return null;
  let trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..') || trimmed.includes('\0')) {
    return null;
  }
  if (trimmed.startsWith('.')) return null;
  if (!trimmed.includes('.')) {
    trimmed = `${trimmed}.mjs`;
  }
  if (trimmed.endsWith('.example.mjs') || trimmed.endsWith('.disabled.mjs')) {
    return null;
  }
  if (!VALID_PLUGIN_FILENAME_RE.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function resolveSafeExistingPluginFileName(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (
    trimmed.startsWith('.') ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.includes('..') ||
    trimmed.includes('\0') ||
    basename(trimmed) !== trimmed ||
    extname(trimmed).toLowerCase() !== '.mjs' ||
    trimmed.endsWith('.example.mjs') ||
    trimmed.endsWith('.disabled.mjs')
  ) {
    return null;
  }
  return trimmed;
}

function parseLoadedPluginModule(mod, { stem, fileName, filePath }) {
  const def = mod?.default && typeof mod.default === 'object' ? mod.default : mod;
  const fetchFn =
    typeof def?.fetch === 'function'
      ? def.fetch.bind(def)
      : typeof mod?.fetch === 'function'
        ? mod.fetch
        : typeof def?.fetchQuota === 'function'
          ? def.fetchQuota.bind(def)
          : typeof mod?.default === 'function'
            ? mod.default
            : null;

  const slug = sanitizeSlug(def?.id ?? mod?.id, stem);
  if (!slug) {
    throw new Error('无效的插件 id（不能与内置名称冲突，需匹配 [a-z0-9_-]）');
  }
  if (!fetchFn) {
    throw new Error('插件缺少 fetch(ctx) 导出函数');
  }

  const currency = String(def?.currency ?? mod?.currency ?? 'USD')
    .trim()
    .toUpperCase();
  const currencySymbol = currencySymbolFor(
    currency,
    def?.currencySymbol ?? mod?.currencySymbol
  );
  const rawName = typeof (def?.name ?? mod?.name) === 'string' ? (def?.name ?? mod?.name).trim() : '';
  const rawShort =
    typeof (def?.shortName ?? mod?.shortName) === 'string'
      ? (def?.shortName ?? mod?.shortName).trim()
      : '';
  const rawIcon = typeof (def?.icon ?? mod?.icon) === 'string' ? (def?.icon ?? mod?.icon).trim() : '';
  const rawAccent =
    typeof (def?.accentColor ?? mod?.accentColor) === 'string'
      ? (def?.accentColor ?? mod?.accentColor).trim()
      : '';

  const rawTtl = toFiniteNumber(def?.cacheTtlMs ?? mod?.cacheTtlMs);
  const cacheTtlMs =
    rawTtl !== null
      ? Math.min(MAX_CACHE_TTL_MS, Math.max(MIN_CACHE_TTL_MS, Math.round(rawTtl)))
      : DEFAULT_CACHE_TTL_MS;
  const rawTimeout = toFiniteNumber(def?.timeoutMs ?? mod?.timeoutMs);
  const timeoutMs =
    rawTimeout !== null
      ? Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(rawTimeout)))
      : DEFAULT_TIMEOUT_MS;

  return {
    plugin: { fetch: fetchFn },
    meta: {
      key: `ext:${slug}`,
      providerId: slug,
      name: rawName || slug,
      shortName: rawShort || rawName || slug,
      icon: VALID_ICON_RE.test(rawIcon) ? rawIcon : 'puzzlepiece.extension',
      accentColor: VALID_HEX_COLOR_RE.test(rawAccent) ? rawAccent : null,
      currency,
      currencySymbol,
      detailUrl: sanitizeHttpUrl(def?.detailUrl ?? mod?.detailUrl),
      auth: normalizeAuthConfig(def?.auth ?? mod?.auth),
      fileName,
      filePath,
      cacheTtlMs,
      timeoutMs,
    },
  };
}

export class ExternalProviderRegistry {
  constructor({ providersDir = null, credentialsPath = undefined } = {}) {
    this.providersDir = providersDir || defaultExternalProvidersDir();
    this.credentialsPath =
      credentialsPath === undefined
        ? join(dirname(this.providersDir), 'provider-credentials.json')
        : credentialsPath;
    /** @type {Map<string, { mtimeMs: number, sizeBytes: number, plugin: any, meta: any, loadError: string | null }>} */
    this.moduleCache = new Map();
    /** @type {Map<string, { fetchedAtMs: number, card: any, ok: boolean, error: string | null, lastGoodCard: any, lastGoodAtMs: number }>} */
    this.resultCache = new Map();
    /** @type {Map<string, Promise<any>>} */
    this.inflight = new Map();
    /** @type {Record<string, any>} */
    this.credentialsMap = this.loadCredentialsFromDisk();
  }

  loadCredentialsFromDisk() {
    if (!this.credentialsPath || !existsSync(this.credentialsPath)) return {};
    try {
      chmodSync(this.credentialsPath, 0o600);
    } catch {}
    try {
      const raw = JSON.parse(readFileSync(this.credentialsPath, 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
      const cleaned = {};
      for (const [k, v] of Object.entries(raw)) {
        if (!isExternalProviderKey(k)) continue;
        const sanitized = sanitizeCredentialsInput(v);
        if (sanitized) cleaned[k] = sanitized;
      }
      return cleaned;
    } catch {
      return {};
    }
  }

  persistCredentials() {
    if (!this.credentialsPath) return;
    mkdirSync(dirname(this.credentialsPath), { recursive: true, mode: 0o700 });
    const tmpPath = `${this.credentialsPath}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
    writeFileSync(tmpPath, `${JSON.stringify(this.credentialsMap, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(tmpPath, this.credentialsPath);
    try {
      chmodSync(this.credentialsPath, 0o600);
    } catch {}
  }

  hasCredentials(key) {
    return Boolean(isExternalProviderKey(key) && this.credentialsMap[key]);
  }

  getCredentialsUpdatedAt(key) {
    const rec = isExternalProviderKey(key) ? this.credentialsMap[key] : null;
    return typeof rec?.savedAtMs === 'number' ? rec.savedAtMs : null;
  }

  getCredentials(key) {
    if (!isExternalProviderKey(key)) return null;
    const rec = this.credentialsMap[key];
    if (!rec) return null;
    try {
      return JSON.parse(JSON.stringify(rec));
    } catch {
      return { ...rec };
    }
  }

  setCredentials(key, payload, { merge = false } = {}) {
    if (!isExternalProviderKey(key)) {
      throw new Error('无效的插件标识');
    }
    const existing = merge ? this.credentialsMap[key] || {} : {};
    const combined = merge
      ? {
          ...existing,
          ...payload,
          cookies:
            existing.cookies || payload?.cookies
              ? { ...(existing.cookies || {}), ...(payload?.cookies || {}) }
              : undefined,
          storage:
            existing.storage || payload?.storage
              ? {
                  local: {
                    ...(existing.storage?.local || {}),
                    ...(payload?.storage?.local || {}),
                  },
                  session: {
                    ...(existing.storage?.session || {}),
                    ...(payload?.storage?.session || {}),
                  },
                }
              : undefined,
          extra:
            existing.extra || payload?.extra
              ? { ...(existing.extra || {}), ...(payload?.extra || {}) }
              : undefined,
          savedAtMs: Date.now(),
        }
      : { ...payload, savedAtMs: Date.now() };
    const sanitized = sanitizeCredentialsInput(combined);
    if (!sanitized) {
      throw new Error('凭证内容为空或格式无效');
    }
    this.credentialsMap[key] = sanitized;
    this.persistCredentials();
    this.resultCache.delete(key);
    return {
      hasCredentials: true,
      savedAtMs: sanitized.savedAtMs,
    };
  }

  clearCredentials(key) {
    if (!isExternalProviderKey(key)) return false;
    const existed = Object.prototype.hasOwnProperty.call(this.credentialsMap, key);
    if (existed) {
      delete this.credentialsMap[key];
      this.persistCredentials();
    }
    this.resultCache.delete(key);
    return existed;
  }

  clearCaches() {
    this.moduleCache.clear();
    this.resultCache.clear();
  }

  async importPluginSource({ fileName, content }) {
    const cleanName = sanitizePluginFileName(fileName);
    if (!cleanName) {
      throw new Error('插件文件名无效（仅支持字母、数字、连字符或下划线，且须为 .mjs 文件）');
    }
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error('插件内容不能为空');
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_PLUGIN_BYTES) {
      throw new Error('插件文件过大（最大支持 256 KB）');
    }

    mkdirSync(this.providersDir, { recursive: true, mode: 0o700 });
    const targetPath = join(this.providersDir, cleanName);
    const tmpName = `.import-${process.pid}-${randomUUID().slice(0, 8)}.mjs`;
    const tmpPath = join(this.providersDir, tmpName);
    const stem = basename(cleanName, '.mjs');

    let parsed;
    try {
      writeFileSync(tmpPath, content, { encoding: 'utf8', mode: 0o600 });
      const url = `${pathToFileURL(tmpPath).href}?validate=${Date.now()}`;
      const mod = await import(url);
      parsed = parseLoadedPluginModule(mod, {
        stem,
        fileName: cleanName,
        filePath: targetPath,
      });
      const existing = await this.loadPlugins();
      const collision = existing.find(
        (e) => e.meta.key === parsed.meta.key && e.meta.fileName !== cleanName
      );
      if (collision) {
        throw new Error(
          `已存在相同 ID (${parsed.meta.providerId}) 的插件文件（${collision.meta.fileName}），请先移除旧插件或更换 ID。`
        );
      }
      renameSync(tmpPath, targetPath);
      try {
        chmodSync(targetPath, 0o600);
      } catch {}
    } catch (err) {
      try {
        if (existsSync(tmpPath)) unlinkSync(tmpPath);
      } catch {}
      throw err;
    }

    this.moduleCache.delete(targetPath);
    this.resultCache.delete(parsed.meta.key);
    return {
      fileName: cleanName,
      filePath: targetPath,
      meta: parsed.meta,
    };
  }

  async removePlugin({ fileName = null, key = null } = {}) {
    let targetFile = fileName
      ? sanitizePluginFileName(fileName) || resolveSafeExistingPluginFileName(fileName)
      : null;
    let resolvedKey = typeof key === 'string' && isExternalProviderKey(key) ? key : null;

    if ((!targetFile && resolvedKey) || (targetFile && !resolvedKey)) {
      const loaded = await this.loadPlugins();
      if (!targetFile && resolvedKey) {
        const found = loaded.find((e) => e.meta.key === resolvedKey);
        if (found) targetFile = found.meta.fileName;
      } else if (targetFile && !resolvedKey) {
        const found = loaded.find((e) => e.meta.fileName === targetFile);
        if (found) resolvedKey = found.meta.key;
      }
    }
    if (!targetFile) {
      return { deleted: false, fileName: null, key: resolvedKey };
    }

    const fullPath = join(this.providersDir, targetFile);
    if (!existsSync(fullPath)) {
      return { deleted: false, fileName: targetFile, key: resolvedKey };
    }

    if (!resolvedKey) {
      const cached = this.moduleCache.get(fullPath);
      resolvedKey = cached?.meta?.key || null;
    }

    unlinkSync(fullPath);
    this.moduleCache.delete(fullPath);
    if (resolvedKey) {
      this.resultCache.delete(resolvedKey);
      this.clearCredentials(resolvedKey);
    }
    return { deleted: true, fileName: targetFile, key: resolvedKey };
  }

  listPluginFiles() {
    if (!this.providersDir || !existsSync(this.providersDir)) return [];
    let entries;
    try {
      entries = readdirSync(this.providersDir);
    } catch {
      return [];
    }
    const files = [];
    for (const name of entries) {
      if (!name || name.startsWith('.')) continue;
      if (name.includes('/') || name.includes('..')) continue;
      if (extname(name).toLowerCase() !== '.mjs') continue;
      if (name.endsWith('.example.mjs') || name.endsWith('.disabled.mjs')) continue;
      const fullPath = join(this.providersDir, name);
      try {
        const st = statSync(fullPath);
        if (!st.isFile()) continue;
        files.push({ fileName: name, filePath: fullPath, mtimeMs: st.mtimeMs, sizeBytes: st.size });
      } catch {
        // Ignore broken symlinks or unreadable entries
      }
    }
    return files.sort((a, b) => a.fileName.localeCompare(b.fileName));
  }

  async loadPlugins() {
    const files = this.listPluginFiles();
    const activePaths = new Set(files.map((f) => f.filePath));
    for (const cachedPath of this.moduleCache.keys()) {
      if (!activePaths.has(cachedPath)) {
        this.moduleCache.delete(cachedPath);
      }
    }

    const loaded = [];
    const seenKeys = new Set();

    for (const f of files) {
      const stem = basename(f.fileName, '.mjs');
      const cached = this.moduleCache.get(f.filePath);
      let entry = cached;

      if (!entry || entry.mtimeMs !== f.mtimeMs || entry.sizeBytes !== f.sizeBytes) {
        try {
          const url = `${pathToFileURL(f.filePath).href}?v=${Math.round(f.mtimeMs)}-${f.sizeBytes}`;
          const mod = await import(url);
          const parsed = parseLoadedPluginModule(mod, {
            stem,
            fileName: f.fileName,
            filePath: f.filePath,
          });
          entry = {
            mtimeMs: f.mtimeMs,
            sizeBytes: f.sizeBytes,
            plugin: parsed.plugin,
            meta: parsed.meta,
            loadError: null,
          };
          // Invalidate previous runtime result when plugin source changed
          this.resultCache.delete(parsed.meta.key);
        } catch (err) {
          const fallbackSlug = sanitizeSlug(stem, 'plugin') || `plugin-${loaded.length + 1}`;
          entry = {
            mtimeMs: f.mtimeMs,
            sizeBytes: f.sizeBytes,
            plugin: null,
            meta: {
              key: `ext:${fallbackSlug}`,
              providerId: fallbackSlug,
              name: stem,
              shortName: stem,
              icon: 'exclamationmark.triangle',
              accentColor: null,
              currency: 'USD',
              currencySymbol: '$',
              detailUrl: null,
              auth: null,
              fileName: f.fileName,
              filePath: f.filePath,
              cacheTtlMs: DEFAULT_CACHE_TTL_MS,
              timeoutMs: DEFAULT_TIMEOUT_MS,
            },
            loadError: err?.message ? String(err.message) : '插件加载失败',
          };
        }
        this.moduleCache.set(f.filePath, entry);
      }

      if (seenKeys.has(entry.meta.key)) continue;
      seenKeys.add(entry.meta.key);
      loaded.push(entry);
    }

    return loaded;
  }

  async listMetadata({ enabledTools = null } = {}) {
    const loaded = await this.loadPlugins();
    return loaded.map((entry) => {
      const enabled = !enabledTools || enabledTools[entry.meta.key] !== false;
      const res = this.resultCache.get(entry.meta.key);
      return {
        key: entry.meta.key,
        providerId: entry.meta.providerId,
        name: entry.meta.name,
        shortName: entry.meta.shortName,
        icon: entry.meta.icon,
        accentColor: entry.meta.accentColor,
        currency: entry.meta.currency,
        currencySymbol: entry.meta.currencySymbol,
        detailUrl: entry.meta.detailUrl,
        auth: entry.meta.auth || null,
        hasCredentials: this.hasCredentials(entry.meta.key),
        credentialsSavedAtMs: this.getCredentialsUpdatedAt(entry.meta.key),
        fileName: entry.meta.fileName,
        filePath: entry.meta.filePath,
        enabled,
        ok: entry.loadError ? false : res ? res.ok : true,
        error: entry.loadError || res?.error || null,
      };
    });
  }

  async fetchSingle(entry, { nowMs = Date.now(), forceRefresh = false } = {}) {
    const { meta, plugin, loadError } = entry;
    if (loadError || !plugin) {
      return {
        meta,
        ok: false,
        error: loadError || '插件不可用',
        card: buildNormalizedCard(meta, {}, { nowMs, errorMessage: loadError || '插件不可用' }),
      };
    }

    if (!forceRefresh && this.inflight.has(meta.key)) {
      return this.inflight.get(meta.key);
    }

    const cached = this.resultCache.get(meta.key);
    if (!forceRefresh && cached && nowMs - cached.fetchedAtMs < meta.cacheTtlMs) {
      return {
        meta,
        ok: cached.ok,
        error: cached.error,
        card: cached.card,
      };
    }

    let p;
    p = (async () => {
      try {
        const ctx = {
          nowMs,
          forceRefresh,
          credentials: this.getCredentials(meta.key),
          saveCredentials: (patch) => {
            const clean = sanitizeCredentialsInput(patch);
            if (!clean) return false;
            this.setCredentials(meta.key, clean, { merge: true });
            return true;
          },
          clearCredentials: () => this.clearCredentials(meta.key),
          helpers: {
            httpRequestJson,
            httpRequestRaw,
            computeQuotaWindow,
            formatDurationZh,
          },
        };
        const raw = await runWithTimeout(
          Promise.resolve().then(() => plugin.fetch(ctx)),
          meta.timeoutMs,
          meta.name
        );
        const card = buildNormalizedCard(meta, raw, { nowMs });
        const ok = raw?.ok !== false;
        const errMsg =
          typeof raw?.error === 'string' && raw.error.trim() ? raw.error.trim() : null;
        const prev = this.resultCache.get(meta.key);
        const hasUsefulData =
          card.quotaWindows.length > 0 ||
          card.daily30.length > 0 ||
          card.breakdowns.length > 0 ||
          card.billingSummary.periodCost !== null ||
          card.billingSummary.todayCost !== null;

        if (this.inflight.get(meta.key) === p) {
          this.resultCache.set(meta.key, {
            fetchedAtMs: Date.now(),
            card,
            ok: ok && !errMsg,
            error: errMsg,
            lastGoodCard: hasUsefulData ? card : prev?.lastGoodCard || null,
            lastGoodAtMs: hasUsefulData ? Date.now() : prev?.lastGoodAtMs || 0,
          });
        }

        return { meta, ok: ok && !errMsg, error: errMsg, card };
      } catch (err) {
        const errMsg = err?.message ? String(err.message) : '插件执行失败';
        const prev = this.resultCache.get(meta.key);
        if (prev?.lastGoodCard && nowMs - prev.lastGoodAtMs <= STALE_GRACE_MS) {
          const staleCard = {
            ...prev.lastGoodCard,
            stale: true,
            statusText: '缓存数据',
            quotaHint: prev.lastGoodCard.quotaHint || errMsg,
          };
          if (this.inflight.get(meta.key) === p) {
            this.resultCache.set(meta.key, {
              ...prev,
              fetchedAtMs: Date.now(),
              card: staleCard,
              ok: false,
              error: errMsg,
            });
          }
          return { meta, ok: false, error: errMsg, card: staleCard };
        }
        const errCard = buildNormalizedCard(meta, {}, { nowMs, errorMessage: errMsg });
        if (this.inflight.get(meta.key) === p) {
          this.resultCache.set(meta.key, {
            fetchedAtMs: Date.now(),
            card: errCard,
            ok: false,
            error: errMsg,
            lastGoodCard: prev?.lastGoodCard || null,
            lastGoodAtMs: prev?.lastGoodAtMs || 0,
          });
        }
        return { meta, ok: false, error: errMsg, card: errCard };
      }
    })().finally(() => {
      if (this.inflight.get(meta.key) === p) {
        this.inflight.delete(meta.key);
      }
    });

    this.inflight.set(meta.key, p);
    return p;
  }

  async fetchAll({ nowMs = Date.now(), forceRefresh = false, enabledTools = null, onlyKey = null } = {}) {
    const loaded = await this.loadPlugins();
    const results = await Promise.all(
      loaded.map(async (entry) => {
        const enabled = !enabledTools || enabledTools[entry.meta.key] !== false;
        if (!enabled) {
          const prev = this.resultCache.get(entry.meta.key);
          return {
            meta: entry.meta,
            enabled: false,
            ok: entry.loadError ? false : prev ? prev.ok : true,
            error: entry.loadError || null,
            card: prev?.card || buildNormalizedCard(entry.meta, { statusText: '已关闭' }, { nowMs }),
          };
        }
        const res = await this.fetchSingle(entry, {
          nowMs,
          forceRefresh: onlyKey ? entry.meta.key === onlyKey : forceRefresh,
        });
        return { ...res, enabled: true };
      })
    );

    const cards = {};
    const overviewWindows = [];
    const providers = [];
    let activeAccounts = 0;

    for (const r of results) {
      cards[r.meta.key] = r.card;
      providers.push({
        key: r.meta.key,
        providerId: r.meta.providerId,
        name: r.meta.name,
        shortName: r.meta.shortName,
        icon: r.meta.icon,
        accentColor: r.meta.accentColor,
        currency: r.meta.currency,
        currencySymbol: r.meta.currencySymbol,
        detailUrl: r.card?.detailUrl || r.meta.detailUrl || null,
        auth: r.meta.auth || null,
        hasCredentials: this.hasCredentials(r.meta.key),
        credentialsSavedAtMs: this.getCredentialsUpdatedAt(r.meta.key),
        fileName: r.meta.fileName,
        filePath: r.meta.filePath,
        enabled: r.enabled,
        ok: r.ok,
        error: r.error,
      });
      if (r.enabled) {
        if (r.card?.accountEmail) activeAccounts += 1;
        const ov = buildOverviewWindow(r.meta, r.card);
        if (ov) overviewWindows.push(ov);
      }
    }

    return {
      providersDir: this.providersDir,
      providers,
      cards,
      overviewWindows,
      activeAccounts,
    };
  }
}
