import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * USD per 1M tokens. Rates mirror public API list prices and CodexBar CostUsagePricing.
 * `thresholdTokens` indicates per-request input size above which long-context rates apply.
 */
const MODEL_PRICING_PER_M = {
  // OpenAI / Codex
  'gpt-6.2-sol': {
    input: 2.0,
    cacheRead: 0.1,
    cacheWrite: 2.5,
    output: 10.0,
    thresholdTokens: 272_000,
    above: { input: 4.0, cacheRead: 0.2, cacheWrite: 5.0, output: 15.0 },
  },
  'gpt-6.2-astra': {
    input: 8.0,
    cacheRead: 0.4,
    cacheWrite: 10.0,
    output: 40.0,
    thresholdTokens: 272_000,
    above: { input: 16.0, cacheRead: 0.8, cacheWrite: 20.0, output: 60.0 },
  },
  'gpt-6.1-sol': {
    input: 2.0,
    cacheRead: 0.1,
    cacheWrite: 2.5,
    output: 10.0,
    thresholdTokens: 272_000,
    above: { input: 4.0, cacheRead: 0.2, cacheWrite: 5.0, output: 15.0 },
  },
  'gpt-6.1-terra': {
    input: 1.0,
    cacheRead: 0.05,
    cacheWrite: 1.25,
    output: 5.0,
    thresholdTokens: 272_000,
    above: { input: 2.0, cacheRead: 0.1, cacheWrite: 2.5, output: 7.5 },
  },
  'gpt-6-astra': {
    input: 10.0,
    cacheRead: 1.0,
    cacheWrite: 12.5,
    output: 50.0,
    thresholdTokens: 272_000,
    above: { input: 20.0, cacheRead: 2.0, cacheWrite: 25.0, output: 75.0 },
  },
  'gpt-6-sol': {
    input: 2.0,
    cacheRead: 0.2,
    cacheWrite: 2.5,
    output: 10.0,
    thresholdTokens: 272_000,
    above: { input: 4.0, cacheRead: 0.4, cacheWrite: 5.0, output: 15.0 },
  },
  'gpt-6-luna': {
    input: 0.1,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    output: 0.5,
    thresholdTokens: 272_000,
    above: { input: 0.2, cacheRead: 0.02, cacheWrite: 0.25, output: 0.75 },
  },
  'gpt-5.6-sol': {
    input: 4.0,
    cacheRead: 0.4,
    cacheWrite: 5.0,
    output: 20.0,
    thresholdTokens: 272_000,
    above: { input: 8.0, cacheRead: 0.8, cacheWrite: 10.0, output: 30.0 },
  },
  'gpt-5.6-terra': {
    input: 2.0,
    cacheRead: 0.2,
    cacheWrite: 2.5,
    output: 12.0,
    thresholdTokens: 272_000,
    above: { input: 4.0, cacheRead: 0.4, cacheWrite: 5.0, output: 18.0 },
  },
  'gpt-5.6-luna': {
    input: 0.2,
    cacheRead: 0.02,
    cacheWrite: 0.25,
    output: 1.2,
    thresholdTokens: 272_000,
    above: { input: 0.4, cacheRead: 0.04, cacheWrite: 0.5, output: 1.8 },
  },
  'gpt-5.6-cyber': { input: 12.5, cacheRead: 1.25, cacheWrite: 15.625, output: 75.0 },
  'gpt-5.5-cyber': { input: 12.5, cacheRead: 1.25, output: 75.0 },
  'gpt-5.5': {
    input: 5.0,
    cacheRead: 0.5,
    output: 30.0,
    thresholdTokens: 272_000,
    above: { input: 10.0, cacheRead: 1.0, output: 45.0 },
  },
  'gpt-5.4': {
    input: 2.5,
    cacheRead: 0.25,
    output: 15.0,
    thresholdTokens: 272_000,
    above: { input: 5.0, cacheRead: 0.5, output: 22.5 },
  },
  'gpt-5.4-mini': { input: 0.75, cacheRead: 0.075, output: 4.5 },
  'gpt-5.4-nano': { input: 0.2, cacheRead: 0.02, output: 1.25 },
  'gpt-5.3-codex': { input: 1.75, cacheRead: 0.175, output: 14.0 },
  'gpt-5.3': { input: 1.75, cacheRead: 0.175, output: 14.0 },
  'gpt-5.4-codex': { input: 2.5, cacheRead: 0.25, output: 15.0 },
  'gpt-5.3-codex-spark': { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
  'gpt-5.2': { input: 1.75, cacheRead: 0.175, output: 14.0 },
  'gpt-5.2-codex': { input: 1.75, cacheRead: 0.175, output: 14.0 },
  'gpt-5.1': { input: 1.25, cacheRead: 0.125, output: 10.0 },
  'gpt-5.1-codex': { input: 1.25, cacheRead: 0.125, output: 10.0 },
  'gpt-5.1-codex-max': { input: 1.25, cacheRead: 0.125, output: 10.0 },
  'gpt-5.1-codex-mini': { input: 0.25, cacheRead: 0.025, output: 2.0 },
  'gpt-5': { input: 1.25, cacheRead: 0.125, output: 10.0 },
  'gpt-5-codex': { input: 1.25, cacheRead: 0.125, output: 10.0 },
  'gpt-5-mini': { input: 0.25, cacheRead: 0.025, output: 2.0 },
  'gpt-5-nano': { input: 0.05, cacheRead: 0.005, output: 0.4 },
  'gpt-6-mini': { input: 0.25, cacheRead: 0.025, cacheWrite: 0.3, output: 2.0 },
  'gpt-6.1-mini': { input: 0.25, cacheRead: 0.025, cacheWrite: 0.3, output: 2.0 },
  'gpt-6.2-mini': { input: 0.25, cacheRead: 0.025, cacheWrite: 0.3, output: 2.0 },
  'gpt-6-nano': { input: 0.05, cacheRead: 0.005, cacheWrite: 0.0625, output: 0.4 },
  'gpt-4.1': { input: 2.0, cacheRead: 0.5, output: 8.0 },
  'gpt-4.1-mini': { input: 0.4, cacheRead: 0.1, output: 1.6 },
  'gpt-4.1-nano': { input: 0.1, cacheRead: 0.025, output: 0.4 },
  'gpt-4o': { input: 2.5, cacheRead: 1.25, output: 10.0 },
  'gpt-4o-mini': { input: 0.15, cacheRead: 0.075, output: 0.6 },
  o3: { input: 2.0, cacheRead: 0.5, output: 8.0 },
  'o3-pro': { input: 20.0, cacheRead: 5.0, output: 80.0 },
  'o3-mini': { input: 1.1, cacheRead: 0.55, output: 4.4 },
  'o4-mini': { input: 1.1, cacheRead: 0.275, output: 4.4 },
  'codex-mini-latest': { input: 1.5, cacheRead: 0.375, output: 6.0 },
  'codex-auto-review': { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },

  // Google / Antigravity
  'gemini-4-neon': {
    input: 2.0,
    cacheRead: 0.2,
    output: 12.0,
    thresholdTokens: 200_000,
    above: { input: 4.0, cacheRead: 0.4, output: 18.0 },
  },
  'gemini-4-hydrogen': {
    input: 2.0,
    cacheRead: 0.2,
    output: 12.0,
    thresholdTokens: 200_000,
    above: { input: 4.0, cacheRead: 0.4, output: 18.0 },
  },
  'gemini-pro-orchestrator-g1-pro': {
    input: 2.0,
    cacheRead: 0.2,
    output: 12.0,
    thresholdTokens: 200_000,
    above: { input: 4.0, cacheRead: 0.4, output: 18.0 },
  },
  'gemini-4-carbon': {
    input: 2.0,
    cacheRead: 0.2,
    output: 12.0,
    thresholdTokens: 200_000,
    above: { input: 4.0, cacheRead: 0.4, output: 18.0 },
  },
  'gemini-4-argon': { input: 0.3, cacheRead: 0.03, output: 2.5 },
  'gemini-4-argon-trial': { input: 0.3, cacheRead: 0.03, output: 2.5 },
  'gemini-3.8-flash-n': { input: 0.3, cacheRead: 0.03, output: 2.5 },
  'gemini-3.8-flash': { input: 0.3, cacheRead: 0.03, output: 2.5 },
  'gemini-flash-worker-agy': { input: 0.3, cacheRead: 0.03, output: 2.5 },
  'gemini-3.1-pro': {
    input: 2.0,
    cacheRead: 0.2,
    output: 12.0,
    thresholdTokens: 200_000,
    above: { input: 4.0, cacheRead: 0.4, output: 18.0 },
  },
  'gemini-3.1-pro-preview': {
    input: 2.0,
    cacheRead: 0.2,
    output: 12.0,
    thresholdTokens: 200_000,
    above: { input: 4.0, cacheRead: 0.4, output: 18.0 },
  },
  'gemini-2.5-pro': {
    input: 1.25,
    cacheRead: 0.125,
    output: 10.0,
    thresholdTokens: 200_000,
    above: { input: 2.5, cacheRead: 0.25, output: 15.0 },
  },
  'gemini-2.5-flash': { input: 0.3, cacheRead: 0.03, output: 2.5 },

  // Anthropic Claude
  'claude-opus-5.5': { input: 5.0, cacheRead: 0.5, cacheWrite: 6.25, output: 25.0 },
  'claude-opus-5-5-high': { input: 5.0, cacheRead: 0.5, cacheWrite: 6.25, output: 25.0 },
  'claude-opus-5': { input: 5.0, cacheRead: 0.5, cacheWrite: 6.25, output: 25.0 },
  'claude-opus-4.8': { input: 5.0, cacheRead: 0.5, cacheWrite: 6.25, output: 25.0 },
  'claude-opus-4.7': { input: 5.0, cacheRead: 0.5, cacheWrite: 6.25, output: 25.0 },
  'claude-opus-4.6': { input: 5.0, cacheRead: 0.5, cacheWrite: 6.25, output: 25.0 },
  'claude-opus-4.5': { input: 5.0, cacheRead: 0.5, cacheWrite: 6.25, output: 25.0 },
  'claude-sonnet-5.5': { input: 3.0, cacheRead: 0.3, cacheWrite: 3.75, output: 15.0 },
  'claude-sonnet-5': { input: 3.0, cacheRead: 0.3, cacheWrite: 3.75, output: 15.0 },
  'claude-sonnet-4.6': { input: 3.0, cacheRead: 0.3, cacheWrite: 3.75, output: 15.0 },
  'claude-sonnet-4.5': {
    input: 3.0,
    cacheRead: 0.3,
    cacheWrite: 3.75,
    output: 15.0,
    thresholdTokens: 200_000,
    above: { input: 6.0, cacheRead: 0.6, cacheWrite: 7.5, output: 22.5 },
  },
  'claude-sonnet-4': {
    input: 3.0,
    cacheRead: 0.3,
    cacheWrite: 3.75,
    output: 15.0,
    thresholdTokens: 200_000,
    above: { input: 6.0, cacheRead: 0.6, cacheWrite: 7.5, output: 22.5 },
  },
  'claude-haiku-4.5': { input: 1.0, cacheRead: 0.1, cacheWrite: 1.25, output: 5.0 },
  'claude-mythos-5': { input: 10.0, cacheRead: 1.0, cacheWrite: 12.5, output: 50.0 },

  // Other coding models
  'kimi-k3.1-pro': { input: 0.6, cacheRead: 0.1, cacheWrite: 0.6, output: 2.5 },
  'kimi-k3': { input: 0.6, cacheRead: 0.1, cacheWrite: 0.6, output: 2.5 },
  k3: { input: 0.6, cacheRead: 0.1, cacheWrite: 0.6, output: 2.5 },
  'deepseek-v4': { input: 0.27, cacheRead: 0.07, output: 1.1 },
  'deepseek-v4-pro': { input: 0.55, cacheRead: 0.14, output: 2.19 },
  'deepseek-flash-cyber': { input: 0.27, cacheRead: 0.07, output: 1.1 },
  'deepseek-v3': { input: 0.27, cacheRead: 0.07, output: 1.1 },
  'deepseek-r1': { input: 0.55, cacheRead: 0.14, output: 2.19 },
  'grok-4.7': { input: 3.0, cacheRead: 0.75, output: 15.0 },
  'grok-4.6': { input: 3.0, cacheRead: 0.75, output: 15.0 },
  'grok-4.5': { input: 3.0, cacheRead: 0.75, output: 15.0 },
  'grok-4': { input: 3.0, cacheRead: 0.75, output: 15.0 },
  hy4: { input: 1.0, cacheRead: 0.25, output: 4.0 },
  hy4std: { input: 1.0, cacheRead: 0.25, output: 4.0 },
  'hy4-preview': { input: 1.0, cacheRead: 0.25, output: 4.0 },
  'hy4-dev': { input: 1.0, cacheRead: 0.25, output: 4.0 },
  'hy4-flash': { input: 0.2, cacheRead: 0.05, output: 0.8 },
  hy3: { input: 0.2, cacheRead: 0.05, output: 0.8 },
  'glm-5.3-flash': { input: 0.15, cacheRead: 0.03, output: 0.6 },
  'glm-5.3': { input: 0.6, cacheRead: 0.12, output: 2.2 },
  'glm-5.2': { input: 0.6, cacheRead: 0.12, output: 2.2 },
  'glm-5.0': { input: 0.6, cacheRead: 0.12, output: 2.2 },
  'glm-5v-turbo': { input: 0.2, cacheRead: 0.04, output: 0.8 },
};

const MODEL_ALIASES = {
  'gpt-daybreak-blue-latest': 'gpt-5.6-sol',
  'gpt-daybreak-red-latest': 'gpt-5.6-cyber',
  'gemini-pro-default': 'gemini-3.1-pro',
  'gemini-pro-agent': 'gemini-3.1-pro',
  'gemini-3.7-flash-safety-le': 'gemini-2.5-flash',
  'gemini-3.7-flash': 'gemini-2.5-flash',
};

export function defaultCustomPricingPath() {
  return join(homedir(), '.local', 'share', 'ai-turn-meter', 'custom-pricing.json');
}

const customCache = new Map();

export function loadCustomPricing(filePath = defaultCustomPricingPath()) {
  if (!filePath || !existsSync(filePath)) return null;
  try {
    const st = statSync(filePath);
    const cached = customCache.get(filePath);
    if (cached && cached.mtimeMs === st.mtimeMs) return cached.rates;
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    const normalized = {};
    for (const [k, v] of Object.entries(raw)) {
      if (v && typeof v === 'object' && typeof v.input === 'number' && typeof v.output === 'number') {
        normalized[String(k).trim().toLowerCase()] = v;
      }
    }
    customCache.set(filePath, { mtimeMs: st.mtimeMs, rates: normalized });
    return normalized;
  } catch {
    return null;
  }
}

function normalizeModelCandidates(rawModel) {
  if (typeof rawModel !== 'string') return [];
  const raw = rawModel.trim().toLowerCase();
  if (!raw || raw === 'unknown' || raw.startsWith('测试模型')) return [];

  const candidates = new Set([raw]);
  const slashParts = raw.split('/');
  if (slashParts.length > 1) {
    candidates.add(slashParts[slashParts.length - 1]);
    candidates.add(slashParts[0]);
  }

  for (const c of Array.from(candidates)) {
    // Strip trailing parenthetical qualifiers like "(1M context)" or "(Auto Balanced)"
    const noParens = c.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
    const spaced = noParens.replace(/\s+/g, '-');
    candidates.add(spaced);
    // Strip optional provider prefix like "cursor-"
    const noPrefix = spaced.replace(/^cursor-/, '');
    candidates.add(noPrefix);
    // Strip trailing YYYYMMDD snapshots (e.g. claude-opus-4-5-20251101)
    const noDate = noPrefix.replace(/-\d{8}$/, '');
    candidates.add(noDate);
    // Strip context / reasoning-effort / speed suffixes (e.g. -1m, -thinking-high, -xhigh-fast, -max)
    const noEffort = noDate
      .replace(/-(?:1m|200k)$/, '')
      .replace(/(?:-(?:thinking|xhigh|high|medium|low|fast|max))+$/, '');
    candidates.add(noEffort);
    // Normalize claude-opus-5-5 -> claude-opus-5.5 and glm-5p3 -> glm-5.3
    const dotted = noEffort
      .replace(/(\d+)-(\d+)(?=-|$)/g, '$1.$2')
      .replace(/(\d+)p(\d+)(?=-|$)/g, '$1.$2');
    candidates.add(dotted);
    // Normalize inverted Claude ordering: claude-4.5-opus -> claude-opus-4.5, claude-4.0-sonnet -> claude-sonnet-4
    const revClaude = dotted.match(/^claude-(\d+(?:\.\d+)?)-(opus|sonnet|haiku)$/);
    if (revClaude) {
      const ver = revClaude[1].replace(/\.0$/, '');
      candidates.add(`claude-${revClaude[2]}-${ver}`);
    }
    // Map newer gpt-6.<minor>-<tier> (e.g. gpt-6.2-astra, gpt-6.3-mini) to known rates
    const gpt6Match = dotted.match(/^gpt-6(?:\.\d+)?-([a-z]+)$/);
    if (gpt6Match) {
      candidates.add(`gpt-6.1-${gpt6Match[1]}`);
      candidates.add(`gpt-6-${gpt6Match[1]}`);
    }
    // Map hy3-dev* variants to hy3
    if (/^hy3-dev/.test(dotted)) candidates.add('hy3');
  }

  for (const c of Array.from(candidates)) {
    if (MODEL_ALIASES[c]) candidates.add(MODEL_ALIASES[c]);
  }
  return Array.from(candidates);
}

/**
 * Resolve per-1M-token pricing entry for a model name, checking optional customRates first.
 * @param {string} model
 * @param {Record<string, any> | null} [customRates]
 */
export function resolveModelPricing(model, customRates = null) {
  const candidates = normalizeModelCandidates(model);
  if (candidates.length === 0) return null;

  if (customRates && typeof customRates === 'object') {
    for (const c of candidates) {
      if (customRates[c]) return customRates[c];
    }
  }
  for (const c of candidates) {
    if (MODEL_PRICING_PER_M[c]) return MODEL_PRICING_PER_M[c];
  }
  return null;
}

/**
 * Estimate API-equivalent USD cost & cache savings for a normalized turn.
 * Returns `{ priced: false, costUsd: null, savingsUsd: null }` for unknown models.
 * @param {object} turn
 * @param {Record<string, any> | null} [customRates]
 */
export function estimateTurnCost(turn, customRates = null) {
  const explicitCost =
    typeof turn?.explicitCostUsd === 'number' && Number.isFinite(turn.explicitCostUsd) && turn.explicitCostUsd >= 0
      ? Number(turn.explicitCostUsd.toFixed(6))
      : null;
  const base = resolveModelPricing(turn?.model, customRates);
  if (!base) {
    return {
      priced: explicitCost !== null,
      costUsd: explicitCost,
      savingsUsd: explicitCost !== null ? 0 : null,
      uncachedCostUsd: null,
      cacheReadCostUsd: null,
      cacheWriteCostUsd: null,
      outputCostUsd: null,
    };
  }

  const totalInputTokens = Math.max(0, Number(turn.totalInputTokens) || 0);
  const uncachedInputTokens = Math.max(0, Number(turn.uncachedInputTokens) || 0);
  const cacheReadTokens = Math.max(0, Number(turn.cacheReadTokens) || 0);
  const cacheWriteTokens = Math.max(0, Number(turn.cacheWriteTokens) || 0);
  const outputTokens = Math.max(0, Number(turn.outputTokens) || 0);
  const callCount = Math.max(1, Number(turn.callCount) || 1);

  const avgContextTokens = totalInputTokens / callCount;
  const useLongTier =
    typeof base.thresholdTokens === 'number' &&
    base.above &&
    avgContextTokens > base.thresholdTokens;
  const tier = useLongTier ? { ...base, ...base.above } : base;

  const inputRate = Number(tier.input) || 0;
  const cacheReadRate = tier.cacheRead !== undefined && tier.cacheRead !== null ? Number(tier.cacheRead) : inputRate;
  const cacheWriteRate = tier.cacheWrite !== undefined && tier.cacheWrite !== null ? Number(tier.cacheWrite) : inputRate;
  const outputRate = Number(tier.output) || 0;

  const uncachedCostUsd = (uncachedInputTokens / 1_000_000) * inputRate;
  const cacheReadCostUsd = (cacheReadTokens / 1_000_000) * cacheReadRate;
  const cacheWriteCostUsd = (cacheWriteTokens / 1_000_000) * cacheWriteRate;
  const outputCostUsd = (outputTokens / 1_000_000) * outputRate;
  const costUsd = explicitCost !== null ? explicitCost : uncachedCostUsd + cacheReadCostUsd + cacheWriteCostUsd + outputCostUsd;

  const savingsUsd = Math.max(0, (cacheReadTokens / 1_000_000) * (inputRate - cacheReadRate));

  return {
    priced: true,
    costUsd: Number(costUsd.toFixed(6)),
    savingsUsd: Number(savingsUsd.toFixed(6)),
    uncachedCostUsd: Number(uncachedCostUsd.toFixed(6)),
    cacheReadCostUsd: Number(cacheReadCostUsd.toFixed(6)),
    cacheWriteCostUsd: Number(cacheWriteCostUsd.toFixed(6)),
    outputCostUsd: Number(outputCostUsd.toFixed(6)),
  };
}
