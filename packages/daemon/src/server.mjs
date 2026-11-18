import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { URL } from 'node:url';
import { CodexAdapter } from './adapters/codex.mjs';
import { AntigravityAdapter } from './adapters/antigravity.mjs';
import { CodeBuddyAdapter } from './adapters/codebuddy.mjs';
import { drainCursorSpool, processCursorHookPayload } from './adapters/cursor.mjs';
import { CdpInlineInjector } from './cdp-injector.mjs';
import { getPackageMeta } from './installer.mjs';
import { getAllQuotas } from './quota.mjs';
import { TurnStore } from './store.mjs';

const TOOL_KEYS = ['antigravity', 'codex', 'cursor', 'codebuddy'];

function loadMeterConfig(configPath) {
  const defaults = {
    enabled: true,
    tools: { antigravity: true, codex: true, cursor: true, codebuddy: true },
    inlineEnabled: true,
    inlineTools: { antigravity: true, codex: true, cursor: true, codebuddy: true },
    cursorCookie: null,
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
    return {
      enabled: typeof raw?.enabled === 'boolean' ? raw.enabled : true,
      tools,
      inlineEnabled: typeof raw?.inlineEnabled === 'boolean' ? raw.inlineEnabled : true,
      inlineTools,
      cursorCookie,
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
    for (const r of records) {
      broadcast('turn', r);
    }
    if (cdpInjector) {
      const changedTools = [...new Set(records.map((r) => r.tool))].filter((t) => isInlineEnabled(t));
      if (changedTools.length > 0) {
        cdpInjector.pushAll({ force: true, tools: changedTools }).catch(() => {});
      }
    }
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
        url.pathname === '/v1/config')
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
          const payload = JSON.parse(body);
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
    for (const res of sseClients) res.end();
    sseClients.clear();
    await new Promise((resolve) => server.close(resolve));
    store.close();
  }

  return { server, store, start, stop, codexAdapter, antigravityAdapter, codeBuddyAdapter };
}
