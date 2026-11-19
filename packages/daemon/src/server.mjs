import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { URL } from 'node:url';
import { CodexAdapter } from './adapters/codex.mjs';
import { AntigravityAdapter } from './adapters/antigravity.mjs';
import { CodeBuddyAdapter } from './adapters/codebuddy.mjs';
import { drainCursorSpool, processCursorHookPayload, syncCursorHistoryEvents } from './adapters/cursor.mjs';
import { CdpInlineInjector } from './cdp-injector.mjs';
import {
  analyzePassiveTelemetry,
  buildManualProbePack,
  inspectLocalCodexConfig,
  probeCodexProtocol,
  runQuickCapabilityProbes,
  runTokenDistributionFingerprint,
  sanitizeEndpoint,
  scoreManualProbeResponse,
} from './fingerprint.mjs';
import { getPackageMeta } from './installer.mjs';
import { fetchCursorQuota, getAllQuotas } from './quota.mjs';
import { renderReceiptAscii, renderReceiptSvg } from './receipt.mjs';
import { TurnStore } from './store.mjs';

const TOOL_KEYS = ['antigravity', 'codex', 'cursor', 'codebuddy'];

function loadMeterConfig(configPath) {
  const defaults = {
    enabled: true,
    tools: { antigravity: true, codex: true, cursor: true, codebuddy: true },
    inlineEnabled: true,
    inlineTools: { antigravity: true, codex: true, cursor: true, codebuddy: true },
    cursorCookie: null,
    fingerprintEndpoints: [],
  };
  if (!configPath || !existsSync(configPath)) return defaults;
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    const tools = { ...defaults.tools };
    const inlineTools = { ...defaults.inlineTools };
    for (const k of TOOL_KEYS) {
      if (typeof raw?.tools?.[k] === 'boolean') tools[k] = raw.tools[k];
      if (typeof raw?.inlineTools?.[k] === 'boolean') inlineTools[k] = raw.inlineTools[k];
    }
    const cursorCookie =
      typeof raw?.cursorCookie === 'string' && raw.cursorCookie.trim()
        ? raw.cursorCookie.trim()
        : null;
    const fingerprintEndpoints = Array.isArray(raw?.fingerprintEndpoints)
      ? raw.fingerprintEndpoints
          .filter((ep) => ep && typeof ep === 'object' && typeof ep.baseUrl === 'string' && ep.baseUrl.trim())
          .map((ep) => ({
            id: typeof ep.id === 'string' && ep.id.trim() ? ep.id.trim() : `ep-${randomUUID().slice(0, 8)}`,
            name: typeof ep.name === 'string' && ep.name.trim() ? ep.name.trim() : ep.model || '自定义端点',
            protocol: ep.protocol === 'anthropic' ? 'anthropic' : 'openai',
            baseUrl: ep.baseUrl.trim(),
            model: typeof ep.model === 'string' ? ep.model.trim() : '',
            apiKey: typeof ep.apiKey === 'string' ? ep.apiKey.trim() : '',
            createdAtMs: Number(ep.createdAtMs) || Date.now(),
          }))
      : [];
    return {
      enabled: typeof raw?.enabled === 'boolean' ? raw.enabled : true,
      tools,
      inlineEnabled: typeof raw?.inlineEnabled === 'boolean' ? raw.inlineEnabled : true,
      inlineTools,
      cursorCookie,
      fingerprintEndpoints,
    };
  } catch {
    return defaults;
  }
}

function publicConfig(cfg) {
  return {
    enabled: cfg.enabled,
    tools: cfg.tools,
    inlineEnabled: cfg.inlineEnabled !== false,
    inlineTools: cfg.inlineTools,
    hasCursorCookie: Boolean(cfg.cursorCookie && cfg.cursorCookie.trim()),
  };
}

export function createMeterServer({
  port = Number(process.env.AI_TURN_METER_PORT || 47831),
  dbPath,
  stateDir,
  enableWatchers = true,
  enableCdp = process.env.AI_TURN_METER_DISABLE_CDP !== '1',
  enableAntigravityRpc = true,
  enableQuotaProbe = enableWatchers,
} = {}) {
  const store = new TurnStore(dbPath);
  const effectiveDbPath = dbPath !== undefined ? dbPath : store.dbPath;
  const hookStateDir =
    stateDir || (effectiveDbPath && effectiveDbPath !== ':memory:' ? dirname(effectiveDbPath) : undefined);
  const configPath = hookStateDir ? join(hookStateDir, 'config.json') : null;
  let config = loadMeterConfig(configPath);
  /** @type {Set<http.ServerResponse>} */
  const sseClients = new Set();

  function isToolEnabled(tool) {
    if (!config.enabled) return false;
    if (!tool) return true;
    return config.tools[tool] !== false;
  }

  function isInlineEnabled(tool) {
    if (!config.enabled || config.inlineEnabled === false) return false;
    if (!tool) return true;
    return config.tools[tool] !== false && config.inlineTools[tool] !== false;
  }

  function persistConfig() {
    if (!configPath) return;
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  }

  function broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(payload);
      } catch {
        sseClients.delete(res);
      }
    }
  }

  let cdpInjector = null;

  function onTurnsChanged(records) {
    if (!records || records.length === 0) return;
    const state = { ...store.getState(20, config.tools), config: publicConfig(config) };
    broadcast('state', state);
    if (records.length <= 15) {
      for (const r of records) {
        broadcast('turn', r);
      }
    }
    if (cdpInjector) {
      const liveRecords = records.filter((r) => r.host !== 'cursor-cloud');
      const changedTools = [...new Set(liveRecords.map((r) => r.tool))].filter((t) => isInlineEnabled(t));
      if (changedTools.length > 0) {
        cdpInjector.pushAll({ force: true, tools: changedTools }).catch(() => {});
      }
    }
  }

  let cursorSyncInflight = null;
  let lastCursorSyncAtMs = 0;

  function triggerCursorHistorySync({ force = false } = {}) {
    if (!enableQuotaProbe || config.tools.cursor === false) return null;
    if (cursorSyncInflight) return cursorSyncInflight;
    const now = Date.now();
    const backfilled = store.getMeta?.('cursor_history_backfilled_v1') === '1';
    if (!force && backfilled && now - lastCursorSyncAtMs < 60_000) {
      return null;
    }
    lastCursorSyncAtMs = now;
    cursorSyncInflight = syncCursorHistoryEvents(store, {
      cursorCookie: config.cursorCookie,
      onBatch: (records) => onTurnsChanged(records),
    })
      .catch(() => ({ synced: 0, completed: false }))
      .finally(() => {
        cursorSyncInflight = null;
      });
    return cursorSyncInflight;
  }

  const codexAdapter = new CodexAdapter({ store, onTurns: onTurnsChanged });
  const antigravityAdapter = new AntigravityAdapter({
    store,
    onTurns: onTurnsChanged,
    enableRpc: enableAntigravityRpc,
  });
  const codeBuddyAdapter = new CodeBuddyAdapter({ store, onTurns: onTurnsChanged });

  if (enableCdp) {
    cdpInjector = new CdpInlineInjector({
      shouldPushTool: (tool) => isInlineEnabled(tool),
      getTurnsForTool: (tool) => {
        const recent = store.getRecentTurns(60, tool);
        if (tool === 'antigravity') {
          return recent.filter((t) => t.host !== 'antigravity-subagent');
        }
        return recent;
      },
    });
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (req.method === 'GET' && url.pathname === '/health') {
      const meta = getPackageMeta();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, pid: process.pid, port, version: meta.version, root: meta.root }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/v1/state') {
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...store.getState(limit, config.tools), config: publicConfig(config) }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/v1/config') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(publicConfig(config)));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/v1/turns') {
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 30));
      const tool = url.searchParams.get('tool') || null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ turns: store.getRecentTurns(limit, tool) }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/v1/usage') {
      const rawDays = url.searchParams.get('days');
      const days =
        rawDays === 'all' || rawDays === '0'
          ? 0
          : rawDays
            ? Math.max(1, Math.round(Number(rawDays) || 7))
            : 7;
      const tool = url.searchParams.get('tool') || null;
      const forceRefresh = url.searchParams.get('refresh') === '1';
      if (forceRefresh) {
        triggerCursorHistorySync({ force: false });
      }
      const sendUsage = async () => {
        const quotasByTool = enableQuotaProbe
          ? await getAllQuotas(Date.now(), {
              forceRefresh,
              cursorCookie: config.cursorCookie,
              enabledTools: config.tools,
            }).catch(() => null)
          : null;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify(
            store.getUsageSummary({ days, tool, quotasByTool, enabledTools: config.tools })
          )
        );
      };
      sendUsage().catch(() => {
        if (!res.headersSent) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify(store.getUsageSummary({ days, tool, enabledTools: config.tools }))
          );
        }
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/v1/receipt') {
      const date = url.searchParams.get('date') || null;
      const scope = url.searchParams.get('scope') || 'day';
      const tool = url.searchParams.get('tool') || null;
      const groupBy = url.searchParams.get('groupBy') || 'model';
      const format = (url.searchParams.get('format') || 'json').toLowerCase();
      const theme = url.searchParams.get('theme') === 'dark' ? 'dark' : 'paper';
      const currency = url.searchParams.get('currency') || 'both';
      const rateRaw = Number(url.searchParams.get('rate'));
      const usdToCny = Number.isFinite(rateRaw) && rateRaw > 0 ? rateRaw : 7;
      const hideProjects = url.searchParams.get('hideProjects') === '1' || url.searchParams.get('hideProjects') === 'true';
      const punchlineIndex = Number(url.searchParams.get('punchline')) || 0;

      const receipt = store.getReceiptData({
        date,
        scope,
        tool,
        groupBy,
        enabledTools: config.tools,
      });

      if (format === 'ascii' || format === 'text') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(renderReceiptAscii(receipt, { currency, usdToCny, hideProjects, punchlineIndex }));
        return;
      }
      if (format === 'svg') {
        res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8' });
        res.end(renderReceiptSvg(receipt, { theme, currency, usdToCny, hideProjects, punchlineIndex }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(receipt));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/v1/fingerprint/overview') {
      const days = Math.max(1, Math.min(90, Number(url.searchParams.get('days')) || 7));
      const passive = analyzePassiveTelemetry(store, { days });
      const codexRaw = inspectLocalCodexConfig();
      const codex = {
        configured: codexRaw.configured,
        authMode: codexRaw.authMode,
        model: codexRaw.model,
        modelProvider: codexRaw.modelProvider,
        baseUrl: codexRaw.baseUrl,
        wireApi: codexRaw.wireApi,
        hasAccessToken: codexRaw.hasAccessToken,
        hasApiKey: codexRaw.hasApiKey,
      };
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          passive,
          codex,
          endpoints: (config.fingerprintEndpoints || []).map(sanitizeEndpoint),
          baselines: store.listFingerprintBaselines(),
          runs: store.listFingerprintRuns(25),
          manualProbe: buildManualProbePack(),
        })
      );
      return;
    }

    if (req.method === 'DELETE' && url.pathname === '/v1/fingerprint/endpoints') {
      const id = url.searchParams.get('id');
      if (!id) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'missing id' }));
        return;
      }
      const prevLen = (config.fingerprintEndpoints || []).length;
      config.fingerprintEndpoints = (config.fingerprintEndpoints || []).filter((ep) => ep.id !== id);
      persistConfig();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          deleted: config.fingerprintEndpoints.length < prevLen,
          endpoints: config.fingerprintEndpoints.map(sanitizeEndpoint),
        })
      );
      return;
    }

    if (req.method === 'DELETE' && url.pathname === '/v1/fingerprint/baselines') {
      const id = url.searchParams.get('id');
      if (!id) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'missing id' }));
        return;
      }
      const deleted = store.deleteFingerprintBaseline(id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, deleted, baselines: store.listFingerprintBaselines() }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/v1/match') {
      const tool = url.searchParams.get('tool') || null;
      const workspacePath = url.searchParams.get('workspace') || null;
      const workspaceHash = url.searchParams.get('workspaceHash') || null;
      if (!isInlineEnabled(tool)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ turn: null, disabled: true }));
        return;
      }
      const turn = store.getMatchForIde({ tool, workspacePath, workspaceHash });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ turn }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      sseClients.add(res);
      res.write(
        `event: state\ndata: ${JSON.stringify({ ...store.getState(20, config.tools), config: publicConfig(config) })}\n\n`
      );
      const keepAlive = setInterval(() => {
        try {
          res.write(': keepalive\n\n');
        } catch {
          clearInterval(keepAlive);
          sseClients.delete(res);
        }
      }, 15000);
      req.on('close', () => {
        clearInterval(keepAlive);
        sseClients.delete(res);
      });
      return;
    }

    if (
      req.method === 'POST' &&
      (url.pathname === '/v1/ingest' ||
        url.pathname === '/v1/ingest/cursor-hook' ||
        url.pathname === '/v1/config' ||
        url.pathname === '/v1/cursor/sync-local' ||
        url.pathname === '/v1/fingerprint/endpoints' ||
        url.pathname === '/v1/fingerprint/run')
    ) {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 1024 * 1024) {
          res.writeHead(413);
          res.end('Payload too large');
          req.destroy();
        }
      });
      req.on('end', () => {
        try {
          const payload = body.trim() ? JSON.parse(body) : {};
          if (url.pathname === '/v1/fingerprint/endpoints') {
            const baseUrl = typeof payload?.baseUrl === 'string' ? payload.baseUrl.trim() : '';
            const model = typeof payload?.model === 'string' ? payload.model.trim() : '';
            if (!baseUrl || !model) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: '请填写 Base URL 和模型名称' }));
              return;
            }
            const id =
              typeof payload?.id === 'string' && payload.id.trim()
                ? payload.id.trim()
                : `ep-${randomUUID().slice(0, 8)}`;
            const existing = (config.fingerprintEndpoints || []).find((e) => e.id === id);
            const nextEp = {
              id,
              name:
                typeof payload?.name === 'string' && payload.name.trim()
                  ? payload.name.trim()
                  : model,
              protocol: payload?.protocol === 'anthropic' ? 'anthropic' : 'openai',
              baseUrl,
              model,
              apiKey:
                typeof payload?.apiKey === 'string' && payload.apiKey.trim()
                  ? payload.apiKey.trim()
                  : existing?.apiKey || '',
              createdAtMs: existing?.createdAtMs || Date.now(),
            };
            config.fingerprintEndpoints = [
              ...(config.fingerprintEndpoints || []).filter((e) => e.id !== id),
              nextEp,
            ];
            persistConfig();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                ok: true,
                endpoint: sanitizeEndpoint(nextEp),
                endpoints: config.fingerprintEndpoints.map(sanitizeEndpoint),
              })
            );
            return;
          }

          if (url.pathname === '/v1/fingerprint/run') {
            const mode = String(payload?.mode || 'passive').trim();
            const handleRun = async () => {
              if (mode === 'one_click') {
                const days = Math.max(1, Math.min(90, Number(payload?.days) || 7));
                const passive = analyzePassiveTelemetry(store, { days });
                const codexCfg = inspectLocalCodexConfig();
                let codexProto = null;
                if (codexCfg.configured) {
                  codexProto = await probeCodexProtocol();
                }

                const issues = [];
                if (codexProto && codexProto.ok) {
                  if (codexProto.verdict === 'suspected_swap') {
                    issues.push(`Codex 疑似换模（返回 ${codexProto.responseModel}）`);
                  } else if (codexProto.verdict === 'warning') {
                    issues.push(codexProto.summary);
                  }
                }
                if (passive.anomalies.length > 0) {
                  issues.push(`近 ${days} 天日志发现 ${passive.anomalies.length} 条波动信号`);
                }

                const verdict =
                  codexProto?.verdict === 'suspected_swap'
                    ? 'suspected_swap'
                    : passive.overallStatus === 'degraded'
                      ? 'degraded'
                      : codexProto?.verdict === 'warning' || passive.overallStatus === 'warning'
                        ? 'warning'
                        : 'healthy';

                const codexNote = codexProto?.ok
                  ? `Codex 路由正常（${codexProto.responseModel || codexCfg.model}）`
                  : codexCfg.configured
                    ? 'Codex 路由暂不可达'
                    : null;

                const summary =
                  issues.length > 0
                    ? `${issues.join('；')}${codexNote && verdict !== 'suspected_swap' ? `；${codexNote}` : ''}`
                    : `全部正常（扫描 ${passive.totalTurnsScanned} 轮${codexNote ? ` · ${codexNote}` : ''}）`;

                const saved = store.saveFingerprintRun({
                  targetType: 'one_click',
                  targetName: '一键全面体检',
                  requestedModel: codexCfg.configured ? codexCfg.model : null,
                  responseModel: codexProto?.responseModel || null,
                  mode: 'one_click',
                  verdict,
                  score:
                    verdict === 'healthy'
                      ? 100
                      : verdict === 'warning'
                        ? 75
                        : verdict === 'degraded'
                          ? 50
                          : 20,
                  summary,
                  details: {
                    days,
                    anomalyCount: passive.anomalies.length,
                    headers: codexProto?.details?.headers || undefined,
                  },
                });
                return { ok: true, mode, passive, codexProto, run: saved };
              }

              if (mode === 'passive') {
                const days = Math.max(1, Math.min(90, Number(payload?.days) || 7));
                const passive = analyzePassiveTelemetry(store, { days, tool: payload?.tool || null });
                const saved = store.saveFingerprintRun({
                  targetType: 'passive',
                  targetName: payload?.tool ? `被动诊断 (${payload.tool})` : '全客户端被动诊断',
                  tool: payload?.tool || null,
                  mode: 'passive',
                  verdict: passive.overallStatus,
                  score:
                    passive.overallStatus === 'healthy'
                      ? 100
                      : passive.overallStatus === 'warning'
                        ? 75
                        : passive.overallStatus === 'degraded'
                          ? 40
                          : null,
                  summary: `扫描 ${passive.totalTurnsScanned} 轮，发现 ${passive.anomalies.length} 条异常信号`,
                  details: {
                    days: passive.days,
                    anomalyCount: passive.anomalies.length,
                    anomalies: passive.anomalies.slice(0, 10),
                  },
                });
                return { ok: true, mode, passive, run: saved };
              }

              if (mode === 'codex_protocol') {
                const result = await probeCodexProtocol({
                  modelOverride: typeof payload?.model === 'string' && payload.model.trim() ? payload.model.trim() : null,
                });
                const saved = store.saveFingerprintRun(result);
                return { ok: result.ok, mode, run: saved };
              }

              if (mode === 'manual_score') {
                const tool = typeof payload?.tool === 'string' && payload.tool.trim() ? payload.tool.trim() : 'antigravity';
                let replyText = typeof payload?.replyText === 'string' ? payload.replyText.trim() : '';
                let model = typeof payload?.model === 'string' && payload.model.trim() ? payload.model.trim() : 'unknown';
                if (!replyText) {
                  const latest = store.getRecentTurns(5, tool).find((t) => t.replyPreview);
                  if (latest) {
                    replyText = latest.replyPreview || '';
                    if (model === 'unknown' && latest.model) model = latest.model;
                  }
                }
                const result = scoreManualProbeResponse(replyText, { tool, model });
                const saved = result.ok ? store.saveFingerprintRun(result) : result;
                return { ok: result.ok, mode, run: saved };
              }

              // L1 quick or L2 deep
              const target = payload?.target || 'codex';
              let targetType = 'endpoint';
              let targetName = null;
              let endpointConfig = null;
              if (target === 'codex') {
                targetType = 'codex';
                endpointConfig =
                  typeof payload?.model === 'string' && payload.model.trim()
                    ? { model: payload.model.trim() }
                    : undefined;
              } else {
                const savedEp = (config.fingerprintEndpoints || []).find(
                  (e) => e.id === target || e.id === payload?.endpointId
                );
                if (savedEp) {
                  endpointConfig = savedEp;
                  targetName = savedEp.name;
                } else if (payload?.endpoint && typeof payload.endpoint === 'object') {
                  endpointConfig = payload.endpoint;
                  targetName = payload.endpoint.name || payload.endpoint.model || '临时端点';
                } else {
                  return { ok: false, error: '未找到指定端点配置' };
                }
              }

              if (mode === 'quick') {
                const result = await runQuickCapabilityProbes({
                  targetType,
                  targetName,
                  endpointConfig,
                });
                const saved = store.saveFingerprintRun(result);
                return { ok: result.ok, mode, run: saved };
              }

              if (mode === 'deep') {
                const result = await runTokenDistributionFingerprint({
                  targetType,
                  targetName,
                  endpointConfig,
                  sampleCount: Number(payload?.sampleCount) || 50,
                  recordBaseline: Boolean(payload?.recordBaseline),
                  baselineName: typeof payload?.baselineName === 'string' ? payload.baselineName.trim() : null,
                  baselineId: typeof payload?.baselineId === 'string' ? payload.baselineId.trim() : null,
                  store,
                });
                const saved = store.saveFingerprintRun(result);
                return { ok: result.ok, mode, run: saved, baselines: store.listFingerprintBaselines() };
              }

              return { ok: false, error: `不支持的检测模式: ${mode}` };
            };

            handleRun()
              .then((out) => {
                if (!res.headersSent) {
                  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                  res.end(JSON.stringify(out));
                }
              })
              .catch((err) => {
                if (!res.headersSent) {
                  res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
                  res.end(JSON.stringify({ ok: false, error: err?.message || '检测执行失败' }));
                }
              });
            return;
          }

          if (url.pathname === '/v1/cursor/sync-local') {
            const safeStoragePasswords = Array.isArray(payload?.passwords)
              ? payload.passwords.filter((p) => typeof p === 'string' && p.length > 0)
              : [];
            fetchCursorQuota(Date.now(), {
              allowNetwork: true,
              cursorCookie: null,
              safeStoragePasswords,
            })
              .then(async (q) => {
                if (q?.resolvedCookieHeader) {
                  config.cursorCookie = q.resolvedCookieHeader;
                  persistConfig();
                  const pubCfg = publicConfig(config);
                  broadcast('state', { ...store.getState(20, config.tools), config: pubCfg });
                  if (enableQuotaProbe) {
                    await getAllQuotas(Date.now(), {
                      forceRefresh: true,
                      cursorCookie: config.cursorCookie,
                      enabledTools: config.tools,
                    }).catch(() => {});
                  }
                  triggerCursorHistorySync({ force: true });
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  res.end(
                    JSON.stringify({
                      ok: true,
                      email: q.accountEmail || null,
                      quotaWindows: q.quotaWindows || [],
                    })
                  );
                  return;
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(
                  JSON.stringify({
                    ok: false,
                    hasEncryptedTokenWithoutKey: Boolean(q?.hasEncryptedTokenWithoutKey),
                    error: q?.quotaHint || '未读取到有效的 Cursor 登录会话',
                  })
                );
              })
              .catch(() => {
                if (!res.headersSent) {
                  res.writeHead(500, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ ok: false, error: '同步 Cursor 本地登录态失败' }));
                }
              });
            return;
          }
          if (url.pathname === '/v1/config') {
            const prevInline = Object.fromEntries(TOOL_KEYS.map((k) => [k, isInlineEnabled(k)]));
            let refreshQuota = false;
            if (typeof payload?.enabled === 'boolean') config.enabled = payload.enabled;
            if (payload?.tools && typeof payload.tools === 'object') {
              for (const k of TOOL_KEYS) {
                if (typeof payload.tools[k] === 'boolean') config.tools[k] = payload.tools[k];
              }
            }
            if (typeof payload?.inlineEnabled === 'boolean') config.inlineEnabled = payload.inlineEnabled;
            if (payload?.inlineTools && typeof payload.inlineTools === 'object') {
              for (const k of TOOL_KEYS) {
                if (typeof payload.inlineTools[k] === 'boolean') config.inlineTools[k] = payload.inlineTools[k];
              }
            }
            if (payload?.cursorCookie !== undefined) {
              config.cursorCookie =
                typeof payload.cursorCookie === 'string' && payload.cursorCookie.trim()
                  ? payload.cursorCookie.trim()
                  : null;
              refreshQuota = true;
            }
            persistConfig();
            const pubCfg = publicConfig(config);
            broadcast('state', { ...store.getState(20, config.tools), config: pubCfg });
            if (cdpInjector) {
              for (const k of TOOL_KEYS) {
                const was = prevInline[k];
                const now = isInlineEnabled(k);
                if (was && !now) cdpInjector.clearTool(k).catch(() => {});
                else if (!was && now) cdpInjector.pushAll({ force: true, tools: [k] }).catch(() => {});
              }
            }
            if (refreshQuota && enableQuotaProbe) {
              getAllQuotas(Date.now(), { forceRefresh: true, cursorCookie: config.cursorCookie }).catch(() => {});
              triggerCursorHistorySync({ force: true });
            } else if (payload?.tools?.cursor === true) {
              triggerCursorHistorySync({ force: false });
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, config: pubCfg }));
            return;
          }

          let turn = payload;
          if (url.pathname === '/v1/ingest/cursor-hook') {
            turn = processCursorHookPayload(payload, hookStateDir ? { stateDir: hookStateDir } : undefined);
            if (!turn) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, buffered: true }));
              return;
            }
          }
          if (!turn || !turn.turnUid || !turn.tool || !turn.sessionId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'invalid turn payload' }));
            return;
          }
          const result = store.upsertTurn(turn);
          if (result.changed) onTurnsChanged([result.record]);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, record: result.record }));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'invalid json' }));
        }
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  let spoolTimer = null;
  let cursorHistoryTimer = null;
  let cursorInitialSyncTimer = null;

  async function start() {
    await new Promise((resolve) => {
      server.listen(port, '127.0.0.1', resolve);
    });

    const spooled = drainCursorSpool(store, hookStateDir);
    if (spooled.length > 0) onTurnsChanged(spooled);

    if (enableWatchers) {
      codexAdapter.start();
      await antigravityAdapter.start();
      codeBuddyAdapter.start();
      spoolTimer = setInterval(() => {
        const drained = drainCursorSpool(store, hookStateDir);
        if (drained.length > 0) onTurnsChanged(drained);
      }, 2500);
      spoolTimer.unref?.();
    }
    cdpInjector?.start();
    if (enableQuotaProbe) {
      getAllQuotas().catch(() => {});
      cursorInitialSyncTimer = setTimeout(() => {
        cursorInitialSyncTimer = null;
        triggerCursorHistorySync({ force: true });
      }, 400);
      cursorInitialSyncTimer.unref?.();
      cursorHistoryTimer = setInterval(() => {
        triggerCursorHistorySync({ force: false });
      }, 300_000);
      cursorHistoryTimer.unref?.();
    }

    return server.address();
  }

  async function stop() {
    codexAdapter.stop();
    antigravityAdapter.stop();
    codeBuddyAdapter.stop();
    cdpInjector?.stop();
    if (cdpInjector) {
      await Promise.race([
        cdpInjector.clearAll().catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 800)),
      ]);
    }
    if (spoolTimer) clearInterval(spoolTimer);
    if (cursorHistoryTimer) clearInterval(cursorHistoryTimer);
    if (cursorInitialSyncTimer) clearTimeout(cursorInitialSyncTimer);
    for (const res of sseClients) res.end();
    sseClients.clear();
    await new Promise((resolve) => server.close(resolve));
    store.close();
  }

  return { server, store, start, stop, codexAdapter, antigravityAdapter, codeBuddyAdapter };
}
