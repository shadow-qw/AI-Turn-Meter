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
    fastMultiplier: 2,
    ultrafastMultiplier: 3,
  },
  'gpt-6.2-astra': {
    input: 8.0,
    cacheRead: 0.4,
    cacheWrite: 10.0,
    output: 40.0,
    thresholdTokens: 272_000,
    above: { input: 16.0, cacheRead: 0.8, cacheWrite: 20.0, output: 60.0 },
    fastMultiplier: 2,
    ultrafastMultiplier: 3,
  },
  'gpt-6.1-sol': {
    input: 2.0,
    cacheRead: 0.1,
    cacheWrite: 2.5,
    output: 10.0,
    thresholdTokens: 272_000,
    above: { input: 4.0, cacheRead: 0.2, cacheWrite: 5.0, output: 15.0 },
    fastMultiplier: 2,
    ultrafastMultiplier: 3,
  },
  'gpt-6.1-terra': {
    input: 1.0,
    cacheRead: 0.05,
    cacheWrite: 1.25,
    output: 5.0,
    thresholdTokens: 272_000,
    above: { input: 2.0, cacheRead: 0.1, cacheWrite: 2.5, output: 7.5 },
    fastMultiplier: 2,
  },
  'gpt-6-astra': {
    input: 10.0,
    cacheRead: 1.0,
    cacheWrite: 12.5,
    output: 50.0,
    thresholdTokens: 272_000,
    above: { input: 20.0, cacheRead: 2.0, cacheWrite: 25.0, output: 75.0 },
    fastMultiplier: 2,
  },
  'gpt-6-sol': {
    input: 2.0,
    cacheRead: 0.2,
    cacheWrite: 2.5,
    output: 10.0,
    thresholdTokens: 272_000,
    above: { input: 4.0, cacheRead: 0.4, cacheWrite: 5.0, output: 15.0 },
    fastMultiplier: 2,
  },
  'gpt-6-luna': {
    input: 0.1,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    output: 0.5,
    thresholdTokens: 272_000,
    above: { input: 0.2, cacheRead: 0.02, cacheWrite: 0.25, output: 0.75 },
    fastMultiplier: 2,
  },
  'gpt-5.6-sol': {
    input: 4.0,
    cacheRead: 0.4,
    cacheWrite: 5.0,
    output: 20.0,
    thresholdTokens: 272_000,
    above: { input: 8.0, cacheRead: 0.8, cacheWrite: 10.0, output: 30.0 },
    fastMultiplier: 2,
  },
  'gpt-5.6-terra': {
    input: 2.0,
    cacheRead: 0.2,
    cacheWrite: 2.5,
    output: 12.0,
    thresholdTokens: 272_000,
    above: { input: 4.0, cacheRead: 0.4, cacheWrite: 5.0, output: 18.0 },
    fastMultiplier: 2,
  },
  'gpt-5.6-luna': {
    input: 0.2,
    cacheRead: 0.02,
    cacheWrite: 0.25,
    output: 1.2,
    thresholdTokens: 272_000,
    above: { input: 0.4, cacheRead: 0.04, cacheWrite: 0.5, output: 1.8 },
    fastMultiplier: 2,
  },
  'gpt-5.6-cyber': { input: 12.5, cacheRead: 1.25, cacheWrite: 15.625, output: 75.0, fastMultiplier: 2 },
  'gpt-5.5-cyber': { input: 12.5, cacheRead: 1.25, output: 75.0 },
  'gpt-5.5': {
    input: 5.0,
    cacheRead: 0.5,
    output: 30.0,
    thresholdTokens: 272_000,
    above: { input: 10.0, cacheRead: 1.0, output: 45.0 },
    fastMultiplier: 2,
  },
  'gpt-5.5-pro': {
    input: 30.0,
    output: 180.0,
    thresholdTokens: 272_000,
    above: { input: 60.0, output: 270.0 },
  },
  'gpt-5.4': {
    input: 2.5,
    cacheRead: 0.25,
    output: 15.0,
    thresholdTokens: 272_000,
    above: { input: 5.0, cacheRead: 0.5, output: 22.5 },
    fastMultiplier: 2,
  },
  'gpt-5.4-pro': {
    input: 30.0,
    output: 180.0,
    thresholdTokens: 272_000,
    above: { input: 60.0, output: 270.0 },
  },
  'gpt-5.4-mini': { input: 0.75, cacheRead: 0.075, output: 4.5 },
  'gpt-5.4-nano': { input: 0.2, cacheRead: 0.02, output: 1.25 },
  'gpt-5.3-codex': { input: 1.75, cacheRead: 0.175, output: 14.0, fastMultiplier: 2 },
  'gpt-5.3': { input: 1.75, cacheRead: 0.175, output: 14.0, fastMultiplier: 2 },
  'gpt-5.4-codex': { input: 2.5, cacheRead: 0.25, output: 15.0, fastMultiplier: 2 },
  'gpt-5.3-codex-spark': { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
  'gpt-5.2': { input: 1.75, cacheRead: 0.175, output: 14.0, fastMultiplier: 2 },
  'gpt-5.2-codex': { input: 1.75, cacheRead: 0.175, output: 14.0, fastMultiplier: 2 },
  'gpt-5.1': { input: 1.25, cacheRead: 0.125, output: 10.0, fastMultiplier: 2 },
  'gpt-5.1-codex': { input: 1.25, cacheRead: 0.125, output: 10.0, fastMultiplier: 2 },
  'gpt-5.1-codex-max': { input: 1.25, cacheRead: 0.125, output: 10.0 },
  'gpt-5.1-codex-mini': { input: 0.25, cacheRead: 0.025, output: 2.0 },
  'gpt-5': { input: 1.25, cacheRead: 0.125, output: 10.0, fastMultiplier: 2 },
  'gpt-5-pro': { input: 15.0, output: 120.0 },
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
  'gemini-4-neon': { input: 3.0, cacheRead: 0.15, output: 15.0 },
  'gemini-4-hydrogen': { input: 1.5, cacheRead: 0.075, output: 7.5 },
  'gemini-4-carbon': {
    input: 2.0,
    cacheRead: 0.1,
    output: 10.0,
    effectiveChanges: [{ fromMs: Date.UTC(2026, 11, 1), input: 4.0, cacheRead: 0.2, output: 20.0 }],
  },
  'gemini-4-argon': {
    input: 2.0,
    cacheRead: 0.1,
    output: 10.0,
    effectiveChanges: [{ fromMs: Date.UTC(2026, 11, 1), input: 4.0, cacheRead: 0.2, output: 20.0 }],
  },
  'gemini-4-argon-trial': {
    input: 2.0,
    cacheRead: 0.1,
    output: 10.0,
    effectiveChanges: [{ fromMs: Date.UTC(2026, 11, 1), input: 4.0, cacheRead: 0.2, output: 20.0 }],
  },
  // Gemini 3.6 / 3.8 Flash: aistudio.google.com/docs/pricing (checked 2026-11-27) lists $0.75 / $0.075 / $3.75
  // through 2026-12-31 and $1.50 / $0.15 / $7.50 from 2027-01-01. Antigravity reports the 3.8 Flash
  // variant as gemini-3.8-flash-n ("Gemini 3.8 Flash" in gen_metadata display names).
  'gemini-3.8-flash': {
    input: 0.75,
    cacheRead: 0.075,
    output: 3.75,
    effectiveChanges: [{ fromMs: Date.UTC(2027, 0, 1), input: 1.5, cacheRead: 0.15, output: 7.5 }],
  },
  'gemini-3.8-flash-n': {
    input: 0.75,
    cacheRead: 0.075,
    output: 3.75,
    effectiveChanges: [{ fromMs: Date.UTC(2027, 0, 1), input: 1.5, cacheRead: 0.15, output: 7.5 }],
  },
  'gemini-3.6-flash': {
    input: 0.75,
    cacheRead: 0.075,
    output: 3.75,
    effectiveChanges: [{ fromMs: Date.UTC(2027, 0, 1), input: 1.5, cacheRead: 0.15, output: 7.5 }],
  },
  // Gemini 3 Flash (gemini-3-flash-preview): $0.50 / $0.05 / $3.00.
  'gemini-3-flash-preview': { input: 0.5, cacheRead: 0.05, output: 3.0 },
  // Gemini 3.5 Flash is retired from the pricing page; rate from models.dev / LiteLLM.
  'gemini-3.5-flash': { input: 1.5, cacheRead: 0.15, output: 9.0 },
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
  'claude-opus-5.5': {
    input: 4.0,
    cacheRead: 0.2,
    cacheWrite: 5.0,
    cacheWrite1h: 8.0,
    output: 20.0,
    fastMultiplier: 2,
    regionalUsMultiplier: 1.1,
  },
  'claude-opus-5-5-high': {
    input: 4.0,
    cacheRead: 0.2,
    cacheWrite: 5.0,
    cacheWrite1h: 8.0,
    output: 20.0,
    fastMultiplier: 2,
    regionalUsMultiplier: 1.1,
  },
  'claude-opus-5': {
    input: 5.0,
    cacheRead: 0.5,
    cacheWrite: 6.25,
    cacheWrite1h: 10.0,
    output: 25.0,
    fastMultiplier: 2,
    regionalUsMultiplier: 1.1,
  },
  'claude-opus-4.8': {
    input: 5.0,
    cacheRead: 0.5,
    cacheWrite: 6.25,
    cacheWrite1h: 10.0,
    output: 25.0,
    fastMultiplier: 2,
    regionalUsMultiplier: 1.1,
  },
  'claude-opus-4.7': {
    input: 5.0,
    cacheRead: 0.5,
    cacheWrite: 6.25,
    cacheWrite1h: 10.0,
    output: 25.0,
    fastMultiplier: 2,
    regionalUsMultiplier: 1.1,
  },
  'claude-opus-4.6': {
    input: 5.0,
    cacheRead: 0.5,
    cacheWrite: 6.25,
    cacheWrite1h: 10.0,
    output: 25.0,
    fastMultiplier: 6,
    regionalUsMultiplier: 1.1,
  },
  'claude-opus-4.5': { input: 5.0, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10.0, output: 25.0 },
  'claude-opus-4.1': { input: 15.0, cacheRead: 1.5, cacheWrite: 18.75, cacheWrite1h: 30.0, output: 75.0 },
  'claude-opus-4': { input: 15.0, cacheRead: 1.5, cacheWrite: 18.75, cacheWrite1h: 30.0, output: 75.0 },
  'claude-sonnet-5.5': {
    input: 2.0,
    cacheRead: 0.1,
    cacheWrite: 2.5,
    cacheWrite1h: 4.0,
    output: 10.0,
    fastMultiplier: 2,
    regionalUsMultiplier: 1.1,
  },
  'claude-sonnet-5': {
    input: 2.0,
    cacheRead: 0.2,
    cacheWrite: 2.5,
    cacheWrite1h: 4.0,
    output: 10.0,
    regionalUsMultiplier: 1.1,
  },
  'claude-sonnet-4.6': {
    input: 3.0,
    cacheRead: 0.3,
    cacheWrite: 3.75,
    cacheWrite1h: 6.0,
    output: 15.0,
    regionalUsMultiplier: 1.1,
  },
  'claude-sonnet-4.5': {
    input: 3.0,
    cacheRead: 0.3,
    cacheWrite: 3.75,
    cacheWrite1h: 6.0,
    output: 15.0,
    thresholdTokens: 200_000,
    above: { input: 6.0, cacheRead: 0.6, cacheWrite: 7.5, cacheWrite1h: 12.0, output: 22.5 },
  },
  'claude-sonnet-4': {
    input: 3.0,
    cacheRead: 0.3,
    cacheWrite: 3.75,
    cacheWrite1h: 6.0,
    output: 15.0,
    thresholdTokens: 200_000,
    above: { input: 6.0, cacheRead: 0.6, cacheWrite: 7.5, cacheWrite1h: 12.0, output: 22.5 },
  },
  'claude-3.7-sonnet': { input: 3.0, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6.0, output: 15.0 },
  'claude-3-7-sonnet': { input: 3.0, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6.0, output: 15.0 },
  'claude-3.5-sonnet': { input: 3.0, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6.0, output: 15.0 },
  'claude-3-5-sonnet': { input: 3.0, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6.0, output: 15.0 },
  'claude-haiku-5.5': {
    input: 0.1,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    cacheWrite1h: 0.2,
    output: 0.5,
    thresholdTokens: 100_000,
    above: { input: 0.5, cacheRead: 0.05, cacheWrite: 0.625, cacheWrite1h: 1.0, output: 2.5 },
    regionalUsMultiplier: 1.1,
  },
  'claude-haiku-4.5': { input: 1.0, cacheRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 2.0, output: 5.0 },
  'claude-3.5-haiku': { input: 0.8, cacheRead: 0.08, cacheWrite: 1.0, cacheWrite1h: 1.6, output: 4.0 },
  'claude-3-5-haiku': { input: 0.8, cacheRead: 0.08, cacheWrite: 1.0, cacheWrite1h: 1.6, output: 4.0 },
  'claude-fable-5': {
    input: 10.0,
    cacheRead: 1.0,
    cacheWrite: 12.5,
    cacheWrite1h: 20.0,
    output: 50.0,
    regionalUsMultiplier: 1.1,
  },
  'claude-fable-5.1': {
    input: 10.0,
    cacheRead: 0.25,
    cacheWrite: 12.5,
    cacheWrite1h: 20.0,
    output: 50.0,
    regionalUsMultiplier: 1.1,
  },
  'claude-fable-5.2': {
    input: 8.0,
    cacheRead: 0.2,
    cacheWrite: 10.0,
    cacheWrite1h: 16.0,
    output: 40.0,
    fastMultiplier: 2,
    regionalUsMultiplier: 1.1,
  },
  'claude-mythos-5': {
    input: 10.0,
    cacheRead: 1.0,
    cacheWrite: 12.5,
    cacheWrite1h: 20.0,
    output: 50.0,
    regionalUsMultiplier: 1.1,
  },
  'claude-mythos-5.1': {
    input: 10.0,
    cacheRead: 0.25,
    cacheWrite: 12.5,
    cacheWrite1h: 20.0,
    output: 50.0,
    regionalUsMultiplier: 1.1,
  },
  'claude-mythos-5.2': {
    input: 8.0,
    cacheRead: 0.2,
    cacheWrite: 10.0,
    cacheWrite1h: 16.0,
    output: 40.0,
    fastMultiplier: 2,
    regionalUsMultiplier: 1.1,
  },

  // Cursor Composer
  'composer-2.5': { input: 0.5, cacheRead: 0.2, output: 2.5 },
  'composer-2.5-fast': { input: 3.0, cacheRead: 0.5, output: 15.0 },

  // Other coding models
  'kimi-k3.1-pro': { input: 0.6, cacheRead: 0.1, cacheWrite: 0.6, output: 2.5 },
  'kimi-k3': { input: 0.6, cacheRead: 0.1, cacheWrite: 0.6, output: 2.5 },
  k3: { input: 0.6, cacheRead: 0.1, cacheWrite: 0.6, output: 2.5 },
  'deepseek-v4': { input: 0.27, cacheRead: 0.07, output: 1.1 },
  'deepseek-v4-pro': { input: 0.55, cacheRead: 0.14, output: 2.19 },
  'deepseek-flash-cyber': { input: 0.27, cacheRead: 0.07, output: 1.1 },
  'deepseek-flash': { input: 0.27, cacheRead: 0.07, output: 1.1 },
  'deepseek-v3': { input: 0.27, cacheRead: 0.07, output: 1.1 },
  'deepseek-r1': { input: 0.55, cacheRead: 0.14, output: 2.19 },
  'grok-4.7': {
    input: 2.0,
    cacheRead: 0.5,
    output: 6.0,
    thresholdTokens: 200_000,
    above: { input: 4.0, cacheRead: 1.0, output: 12.0 },
    fastMultiplier: 2,
    regionalUsMultiplier: 1.1,
  },
  'grok-4.6': {
    input: 2.0,
    cacheRead: 0.5,
    output: 6.0,
    thresholdTokens: 200_000,
    above: { input: 4.0, cacheRead: 1.0, output: 12.0 },
    fastMultiplier: 2,
    regionalUsMultiplier: 1.1,
  },
  'grok-4.5': { input: 2.0, cacheRead: 0.5, output: 6.0, fastMultiplier: 2 },
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
  'gpt-5.6': 'gpt-5.6-sol',
  'gpt-reserve': 'gpt-5.6-luna',
  'gpt-daybreak-blue-latest': 'gpt-5.6-sol',
  'gpt-daybreak-red-latest': 'gpt-5.6-cyber',
  'gemini-pro-default': 'gemini-3.1-pro',
  'gemini-pro-agent': 'gemini-3.1-pro',
  // Gemini 3.7 Flash is not on Google's pricing page; models.dev and LiteLLM list the same
  // $0.75 / $0.075 / $3.75 as 3.6 and 3.8 Flash, so it follows their schedule.
  'gemini-3.7-flash-safety-le': 'gemini-3.6-flash',
  'gemini-3.7-flash-exp-b': 'gemini-3.6-flash',
  'gemini-3.7-flash': 'gemini-3.6-flash',
  // Antigravity response-model codenames, mapped the same way as ccusage and tokscale: the
  // gemini-3-flash-a/-b/-agent family is the legacy responseModel of Gemini 3.5 Flash.
  'gemini-3-flash-a': 'gemini-3.5-flash',
  'gemini-3-flash-b': 'gemini-3.5-flash',
  'gemini-3-flash-agent': 'gemini-3.5-flash',
  'gemini-3-flash-agent-a': 'gemini-3.5-flash',
  'gemini-3-flash-agent-b': 'gemini-3.5-flash',
  'gemini-3-flash-c': 'gemini-3-flash-preview',
  'gemini-3-flash': 'gemini-3-flash-preview',
  // Orchestrator mode (antigravity.google/docs/models#orchestrator): planner steps report the
  // orchestrator id, executor steps report gemini-flash-worker-agy, which is Gemini 4 Hydrogen
  // (google-antigravity/antigravity-cli#1710). g1-pro is "Orchestrator (Argon)"; the plain id is the
  // Enterprise pairing with a Gemini 4 Carbon planner.
  'gemini-pro-orchestrator': 'gemini-4-carbon',
  'gemini-pro-orchestrator-argon': 'gemini-4-argon',
  'gemini-pro-orchestrator-g1-pro': 'gemini-4-argon',
  'gemini-pro-orchestrator-neon': 'gemini-4-neon',
  'gemini-flash-worker-agy': 'gemini-4-hydrogen',
  'claude-sonnet-3.7': 'claude-3.7-sonnet',
  'claude-sonnet-3.5': 'claude-3.5-sonnet',
  'claude-haiku-3.5': 'claude-3.5-haiku',
};

// Per-call prompt-size bands, bounded at every published long-context threshold (100K, 200K,
// 272K) so a bucket never straddles one. 'le_200k' is the legacy band of rows stored before the
// 100K boundary existed.
const BAND_RANGES = {
  le_100k: [0, 100_000],
  '100k_200k': [100_000, 200_000],
  le_200k: [0, 200_000],
  '200k_272k': [200_000, 272_000],
  gt_272k: [272_000, Infinity],
};
const VALID_BANDS = new Set(Object.keys(BAND_RANGES));

export function classifyContextBand(callInputTokens) {
  const n = Number(callInputTokens) || 0;
  if (n > 272_000) return 'gt_272k';
  if (n > 200_000) return '200k_272k';
  if (n > 100_000) return '100k_200k';
  return 'le_100k';
}

export function normalizeServiceTier(raw) {
  if (typeof raw !== 'string') return null;
  const norm = raw.trim().toLowerCase().replace(/^ultra_fast$/, 'ultrafast');
  if (norm === 'priority' || norm === 'fast' || norm === 'ultrafast' || norm === 'flex' || norm === 'batch') {
    return norm;
  }
  return null;
}

export function normalizeInferenceGeo(raw) {
  if (typeof raw !== 'string') return null;
  const norm = raw.trim().toLowerCase();
  if (!norm || norm === 'global') return null;
  if (norm === 'us' || norm.startsWith('us_') || norm.startsWith('us-')) return 'us';
  return norm;
}

function toNonNegIntVal(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function normalizeBucketModel(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.toLowerCase() === 'unknown') return null;
  return trimmed;
}

export function accumulateUsageBucket(bucketMap, call) {
  if (!(bucketMap instanceof Map) || !call || typeof call !== 'object') return;
  const u = toNonNegIntVal(call.uncachedInput);
  const cr = toNonNegIntVal(call.cacheRead);
  const cw5 = toNonNegIntVal(call.cacheWrite5m);
  const cw1h = toNonNegIntVal(call.cacheWrite1h);
  const out = toNonNegIntVal(call.output);
  const callInput = u + cr + cw5 + cw1h;
  if (callInput === 0 && out === 0) return;

  const b = classifyContextBand(callInput);
  const m = normalizeBucketModel(call.model);
  const st = normalizeServiceTier(call.serviceTier);
  const geo = normalizeInferenceGeo(call.inferenceGeo);
  const key = `${m || ''}\0${st || ''}\0${geo || ''}\0${b}`;

  let bkt = bucketMap.get(key);
  if (!bkt) {
    bkt = {
      ...(m ? { m } : {}),
      ...(st ? { st } : {}),
      ...(geo ? { geo } : {}),
      b,
      c: 0,
      in: 0,
      u: 0,
      cr: 0,
      cw5: 0,
      cw1h: 0,
      out: 0,
    };
    bucketMap.set(key, bkt);
  }
  bkt.c += Math.max(1, toNonNegIntVal(call.calls) || 1);
  bkt.in += callInput;
  bkt.u += u;
  bkt.cr += cr;
  bkt.cw5 += cw5;
  bkt.cw1h += cw1h;
  bkt.out += out;
}

export function finalizeUsageBuckets(bucketMap) {
  if (!(bucketMap instanceof Map) || bucketMap.size === 0) return null;
  return Array.from(bucketMap.values());
}

export function sanitizeUsageBuckets(raw) {
  let arr = raw;
  if (typeof arr === 'string') {
    const trimmed = arr.trim();
    if (!trimmed) return null;
    try {
      arr = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(arr) || arr.length === 0) return null;

  const outList = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const u = toNonNegIntVal(item.u);
    const cr = toNonNegIntVal(item.cr);
    const cw5 = toNonNegIntVal(item.cw5);
    const cw1h = toNonNegIntVal(item.cw1h);
    const out = toNonNegIntVal(item.out);
    const sumIn = u + cr + cw5 + cw1h;
    const totalIn = Math.max(sumIn, toNonNegIntVal(item.in));
    if (totalIn === 0 && out === 0) continue;

    const b = typeof item.b === 'string' && VALID_BANDS.has(item.b) ? item.b : classifyContextBand(totalIn);
    const m = normalizeBucketModel(item.m);
    const st = normalizeServiceTier(item.st);
    const geo = normalizeInferenceGeo(item.geo);
    const c = Math.max(1, toNonNegIntVal(item.c) || 1);

    outList.push({
      ...(m ? { m } : {}),
      ...(st ? { st } : {}),
      ...(geo ? { geo } : {}),
      b,
      c,
      in: totalIn,
      u,
      cr,
      cw5,
      cw1h,
      out,
    });
  }
  return outList.length > 0 ? outList : null;
}

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

function addCandidate(map, name, inferredServiceTier = null) {
  if (!name) return;
  if (!map.has(name)) {
    map.set(name, inferredServiceTier);
  } else if (inferredServiceTier === null && map.get(name) !== null) {
    map.set(name, null);
  }
}

function normalizeModelCandidateEntries(rawModel) {
  if (typeof rawModel !== 'string') return [];
  const raw = rawModel.trim().toLowerCase();
  if (!raw || raw === 'unknown' || raw.startsWith('测试模型')) return [];

  const candidateMap = new Map();
  addCandidate(candidateMap, raw, null);
  const slashParts = raw.split('/');
  if (slashParts.length > 1) {
    addCandidate(candidateMap, slashParts[slashParts.length - 1], null);
    addCandidate(candidateMap, slashParts[0], null);
  }

  for (const c of Array.from(candidateMap.keys())) {
    // Strip trailing parenthetical qualifiers like "(1M context)" or "(Auto Balanced)"
    const noParens = c.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
    const spaced = noParens.replace(/\s+/g, '-');
    addCandidate(candidateMap, spaced, null);
    // Strip optional provider prefix like "cursor-"
    const noPrefix = spaced.replace(/^cursor-/, '');
    addCandidate(candidateMap, noPrefix, null);
    // Strip trailing YYYYMMDD snapshots (e.g. claude-opus-4-5-20251101)
    const noDate = noPrefix.replace(/-\d{8}$/, '');
    addCandidate(candidateMap, noDate, null);
    // Normalize dotted versions before stripping -fast/-high so distinct speed tiers (e.g. composer-2-5-fast) match first
    const dottedNoDate = noDate
      .replace(/(\d+)-(\d+)(?=-|$)/g, '$1.$2')
      .replace(/(\d+)p(\d+)(?=-|$)/g, '$1.$2');
    addCandidate(candidateMap, dottedNoDate, null);

    // Strip context / reasoning-effort / speed suffixes (e.g. -1m, -thinking-high, -xhigh-fast, -tiered-high, -max)
    const noContext = noDate.replace(/-(?:1m|200k)$/, '');
    const effortRe = /(?:-(?:tiered|thinking|xhigh|high|medium|low|ultrafast|fast|max))+$/;
    const strippedMatch = noContext.match(effortRe);
    const strippedSuffix = strippedMatch ? strippedMatch[0] : '';
    const inferredTier = /(?:^|-)ultrafast(?:-|$)/.test(strippedSuffix)
      ? 'ultrafast'
      : /(?:^|-)fast(?:-|$)/.test(strippedSuffix)
        ? 'fast'
        : null;
    const noEffort = noContext.replace(effortRe, '');
    addCandidate(candidateMap, noEffort, inferredTier);

    // Normalize claude-opus-5-5 -> claude-opus-5.5 and glm-5p3 -> glm-5.3
    const dotted = noEffort
      .replace(/(\d+)-(\d+)(?=-|$)/g, '$1.$2')
      .replace(/(\d+)p(\d+)(?=-|$)/g, '$1.$2');
    addCandidate(candidateMap, dotted, inferredTier);

    // Normalize inverted Claude ordering: claude-4.5-opus -> claude-opus-4.5, claude-4.0-sonnet -> claude-sonnet-4
    const revClaude = dotted.match(/^claude-(\d+(?:\.\d+)?)-(opus|sonnet|haiku)$/);
    if (revClaude) {
      const ver = revClaude[1].replace(/\.0$/, '');
      addCandidate(candidateMap, `claude-${revClaude[2]}-${ver}`, inferredTier);
    }
    // Map newer gpt-6.<minor>-<tier> (e.g. gpt-6.2-astra, gpt-6.3-mini) to known rates
    const gpt6Match = dotted.match(/^gpt-6(?:\.\d+)?-([a-z]+)$/);
    if (gpt6Match) {
      addCandidate(candidateMap, `gpt-6.1-${gpt6Match[1]}`, inferredTier);
      addCandidate(candidateMap, `gpt-6-${gpt6Match[1]}`, inferredTier);
    }
    // Map hy3-dev* variants to hy3
    if (/^hy3-dev/.test(dotted)) addCandidate(candidateMap, 'hy3', inferredTier);
    // Map deepseek-v41-flash-* variants to deepseek-flash
    if (/^deepseek-v\d+-flash\b/.test(dotted)) addCandidate(candidateMap, 'deepseek-flash', inferredTier);
  }

  for (const [c, tier] of Array.from(candidateMap.entries())) {
    if (MODEL_ALIASES[c]) addCandidate(candidateMap, MODEL_ALIASES[c], tier);
  }

  return Array.from(candidateMap.entries()).map(([candidate, inferredServiceTier]) => ({
    candidate,
    inferredServiceTier,
  }));
}

/**
 * A speed tier inferred from a name suffix (e.g. "-fast") only applies to a base model that
 * actually has that tier. Otherwise the suffix names a separate SKU (e.g. grok-4-fast is a
 * cheaper model, not grok-4 at 2x), so the base rate must not be borrowed.
 */
function rateSupportsInferredTier(rate, inferredServiceTier) {
  if (inferredServiceTier === 'fast') return typeof rate?.fastMultiplier === 'number';
  if (inferredServiceTier === 'ultrafast') return typeof rate?.ultrafastMultiplier === 'number';
  return true;
}

function resolveModelPricingMeta(model, customRates = null) {
  const entries = normalizeModelCandidateEntries(model);
  if (entries.length === 0) return null;

  for (const table of [customRates && typeof customRates === 'object' ? customRates : null, MODEL_PRICING_PER_M]) {
    if (!table) continue;
    for (const { candidate, inferredServiceTier } of entries) {
      const rate = table[candidate];
      if (rate && rateSupportsInferredTier(rate, inferredServiceTier)) {
        return { rate, inferredServiceTier };
      }
    }
  }
  return null;
}

/**
 * Resolve per-1M-token pricing entry for a model name, checking optional customRates first.
 * @param {string} model
 * @param {Record<string, any> | null} [customRates]
 */
export function resolveModelPricing(model, customRates = null) {
  const meta = resolveModelPricingMeta(model, customRates);
  return meta ? meta.rate : null;
}

function applyEffectiveSchedule(base, completedAtMs) {
  if (
    !base ||
    !Array.isArray(base.effectiveChanges) ||
    typeof completedAtMs !== 'number' ||
    !Number.isFinite(completedAtMs)
  ) {
    return base;
  }
  let resolved = base;
  for (const chg of base.effectiveChanges) {
    if (chg && typeof chg.fromMs === 'number' && completedAtMs >= chg.fromMs) {
      resolved = { ...resolved, ...chg };
    }
  }
  return resolved;
}

function resolveBandLongTier(band, thresholdTokens, avgContextTokens) {
  const range = BAND_RANGES[band];
  if (!range) return avgContextTokens > thresholdTokens;
  // Every call in the band is above (or at/below) the threshold: exact per-request decision.
  if (thresholdTokens <= range[0]) return true;
  if (thresholdTokens >= range[1]) return false;
  // Threshold inside the band (only legacy 'le_200k' rows vs. a 100K threshold): approximate.
  return avgContextTokens > thresholdTokens;
}

function resolveTierMultiplier(rate, serviceTier, inferenceGeo) {
  let stMult = 1;
  const st = normalizeServiceTier(serviceTier);
  if (st === 'priority' || st === 'fast') {
    stMult = typeof rate.fastMultiplier === 'number' && rate.fastMultiplier > 0 ? rate.fastMultiplier : 2;
  } else if (st === 'ultrafast') {
    stMult = typeof rate.ultrafastMultiplier === 'number' && rate.ultrafastMultiplier > 0 ? rate.ultrafastMultiplier : 3;
  } else if (st === 'flex' || st === 'batch') {
    stMult = typeof rate.batchMultiplier === 'number' && rate.batchMultiplier > 0 ? rate.batchMultiplier : 0.5;
  }

  let geoMult = 1;
  const geo = normalizeInferenceGeo(inferenceGeo);
  if (geo === 'us') {
    geoMult = typeof rate.regionalUsMultiplier === 'number' && rate.regionalUsMultiplier > 0 ? rate.regionalUsMultiplier : 1;
  }

  return stMult * geoMult;
}

function computeTieredBreakdown({
  base,
  serviceTier,
  inferenceGeo,
  useLongTier,
  uncachedInputTokens,
  cacheReadTokens,
  cacheWrite5mTokens,
  cacheWrite1hTokens,
  outputTokens,
}) {
  const tier = useLongTier ? { ...base, ...base.above } : base;
  const mult = resolveTierMultiplier(tier, serviceTier, inferenceGeo);

  const baseInput = Number(tier.input) || 0;
  const inputRate = baseInput * mult;
  const cacheReadRate =
    (tier.cacheRead !== undefined && tier.cacheRead !== null ? Number(tier.cacheRead) : baseInput) * mult;
  const cacheWrite5mRate =
    (tier.cacheWrite !== undefined && tier.cacheWrite !== null ? Number(tier.cacheWrite) : baseInput) * mult;
  const cacheWrite1hRate =
    (tier.cacheWrite1h !== undefined && tier.cacheWrite1h !== null ? Number(tier.cacheWrite1h) : baseInput * 2) * mult;
  const outputRate = (Number(tier.output) || 0) * mult;

  const uncachedCostUsd = (uncachedInputTokens / 1_000_000) * inputRate;
  const cacheReadCostUsd = (cacheReadTokens / 1_000_000) * cacheReadRate;
  const cacheWriteCostUsd =
    (cacheWrite5mTokens / 1_000_000) * cacheWrite5mRate +
    (cacheWrite1hTokens / 1_000_000) * cacheWrite1hRate;
  const outputCostUsd = (outputTokens / 1_000_000) * outputRate;
  const savingsUsd = Math.max(0, (cacheReadTokens / 1_000_000) * (inputRate - cacheReadRate));

  return { uncachedCostUsd, cacheReadCostUsd, cacheWriteCostUsd, outputCostUsd, savingsUsd };
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

  const buckets = sanitizeUsageBuckets(turn?.usageBuckets);
  if (buckets) {
    let pricedBuckets = 0;
    let unpricedBuckets = 0;
    let uncachedCostUsd = 0;
    let cacheReadCostUsd = 0;
    let cacheWriteCostUsd = 0;
    let outputCostUsd = 0;
    let savingsUsd = 0;

    for (const bkt of buckets) {
      const meta = resolveModelPricingMeta(bkt.m || turn?.model, customRates);
      if (!meta) {
        // Never price an unknown model at another model's rate; report it as unpriced instead.
        unpricedBuckets += 1;
        continue;
      }
      pricedBuckets += 1;

      const base = applyEffectiveSchedule(meta.rate, turn?.completedAtMs);
      const bktCalls = Math.max(1, Number(bkt.c) || 1);
      const avgContextTokens = bkt.in / bktCalls;
      const useLongTier =
        typeof base.thresholdTokens === 'number' &&
        base.above &&
        resolveBandLongTier(bkt.b, base.thresholdTokens, avgContextTokens);

      const part = computeTieredBreakdown({
        base,
        serviceTier: bkt.st || turn?.serviceTier || meta.inferredServiceTier,
        inferenceGeo: bkt.geo || turn?.inferenceGeo,
        useLongTier,
        uncachedInputTokens: bkt.u,
        cacheReadTokens: bkt.cr,
        cacheWrite5mTokens: bkt.cw5,
        cacheWrite1hTokens: bkt.cw1h,
        outputTokens: bkt.out,
      });

      uncachedCostUsd += part.uncachedCostUsd;
      cacheReadCostUsd += part.cacheReadCostUsd;
      cacheWriteCostUsd += part.cacheWriteCostUsd;
      outputCostUsd += part.outputCostUsd;
      savingsUsd += part.savingsUsd;
    }

    if (pricedBuckets === 0) {
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

    const costUsd =
      explicitCost !== null
        ? explicitCost
        : uncachedCostUsd + cacheReadCostUsd + cacheWriteCostUsd + outputCostUsd;

    return {
      priced: true,
      // Some calls in this turn used a model with no known rate: the cost covers the rest only.
      partial: explicitCost === null && unpricedBuckets > 0,
      costUsd: Number(costUsd.toFixed(6)),
      savingsUsd: Number(savingsUsd.toFixed(6)),
      uncachedCostUsd: Number(uncachedCostUsd.toFixed(6)),
      cacheReadCostUsd: Number(cacheReadCostUsd.toFixed(6)),
      cacheWriteCostUsd: Number(cacheWriteCostUsd.toFixed(6)),
      outputCostUsd: Number(outputCostUsd.toFixed(6)),
    };
  }

  const meta = resolveModelPricingMeta(turn?.model, customRates);
  if (!meta) {
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

  const base = applyEffectiveSchedule(meta.rate, turn?.completedAtMs);
  const totalInputTokens = Math.max(0, Number(turn.totalInputTokens) || 0);
  const rawCacheRead = Math.max(0, Number(turn.cacheReadTokens) || 0);
  const rawCacheWrite = Math.max(0, Number(turn.cacheWriteTokens) || 0);
  const cacheReadTokens = totalInputTokens > 0 ? Math.min(rawCacheRead, totalInputTokens) : rawCacheRead;
  const cacheWriteTokens =
    totalInputTokens > 0
      ? Math.min(rawCacheWrite, Math.max(0, totalInputTokens - cacheReadTokens))
      : rawCacheWrite;
  const rawCacheWrite1h = Math.max(0, Number(turn.cacheWrite1hTokens) || 0);
  const cacheWrite1hTokens = Math.min(rawCacheWrite1h, cacheWriteTokens);
  const cacheWrite5mTokens = Math.max(0, cacheWriteTokens - cacheWrite1hTokens);
  const uncachedInputTokens =
    turn.uncachedInputTokens !== undefined && turn.uncachedInputTokens !== null
      ? Math.max(0, Number(turn.uncachedInputTokens) || 0)
      : Math.max(0, totalInputTokens - cacheReadTokens - cacheWriteTokens);
  const outputTokens = Math.max(0, Number(turn.outputTokens) || 0);
  const callCount = Math.max(1, Number(turn.callCount) || 1);

  const avgContextTokens = totalInputTokens / callCount;
  const isCursorHookCumulative = turn?.host === 'cursor-ide' && callCount <= 1;
  const useLongTier =
    !isCursorHookCumulative &&
    typeof base.thresholdTokens === 'number' &&
    base.above &&
    avgContextTokens > base.thresholdTokens;

  const part = computeTieredBreakdown({
    base,
    serviceTier: turn?.serviceTier || meta.inferredServiceTier,
    inferenceGeo: turn?.inferenceGeo,
    useLongTier,
    uncachedInputTokens,
    cacheReadTokens,
    cacheWrite5mTokens,
    cacheWrite1hTokens,
    outputTokens,
  });
  const costUsd =
    explicitCost !== null
      ? explicitCost
      : part.uncachedCostUsd + part.cacheReadCostUsd + part.cacheWriteCostUsd + part.outputCostUsd;

  return {
    priced: true,
    costUsd: Number(costUsd.toFixed(6)),
    savingsUsd: Number(part.savingsUsd.toFixed(6)),
    uncachedCostUsd: Number(part.uncachedCostUsd.toFixed(6)),
    cacheReadCostUsd: Number(part.cacheReadCostUsd.toFixed(6)),
    cacheWriteCostUsd: Number(part.cacheWriteCostUsd.toFixed(6)),
    outputCostUsd: Number(part.outputCostUsd.toFixed(6)),
  };
}
