import http from 'node:http';
import { dirname } from 'node:path';
import { URL } from 'node:url';
import { CodexAdapter } from './adapters/codex.mjs';
import { AntigravityAdapter } from './adapters/antigravity.mjs';
import { CodeBuddyAdapter } from './adapters/codebuddy.mjs';
import { drainCursorSpool, processCursorHookPayload } from './adapters/cursor.mjs';
import { CdpInlineInjector } from './cdp-injector.mjs';
import { getPackageMeta } from './installer.mjs';
import { TurnStore } from './store.mjs';

export function createMeterServer({
  port = Number(process.env.AI_TURN_METER_PORT || 47831),
  dbPath,
  stateDir,
  enableWatchers = true,
  enableCdp = process.env.AI_TURN_METER_DISABLE_CDP !== '1',
  enableAntigravityRpc = true,
} = {}) {
  const store = new TurnStore(dbPath);
  const hookStateDir = stateDir || (dbPath && dbPath !== ':memory:' ? dirname(dbPath) : undefined);
  /** @type {Set<http.ServerResponse>} */
  const sseClients = new Set();

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
    const state = store.getState();
    broadcast('state', state);
    for (const r of records) {
      broadcast('turn', r);
    }
    if (cdpInjector) {
      const changedTools = [...new Set(records.map((r) => r.tool))];
      cdpInjector.pushAll({ force: true, tools: changedTools }).catch(() => {});
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
      res.end(JSON.stringify(store.getState(limit)));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/v1/turns') {
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 30));
      const tool = url.searchParams.get('tool') || null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ turns: store.getRecentTurns(limit, tool) }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/v1/match') {
      const tool = url.searchParams.get('tool') || null;
      const workspacePath = url.searchParams.get('workspace') || null;
      const workspaceHash = url.searchParams.get('workspaceHash') || null;
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
      res.write(`event: state\ndata: ${JSON.stringify(store.getState())}\n\n`);
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

    if (req.method === 'POST' && (url.pathname === '/v1/ingest' || url.pathname === '/v1/ingest/cursor-hook')) {
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

    return server.address();
  }

  async function stop() {
    codexAdapter.stop();
    antigravityAdapter.stop();
    codeBuddyAdapter.stop();
    cdpInjector?.stop();
    if (spoolTimer) clearInterval(spoolTimer);
    for (const res of sseClients) res.end();
    sseClients.clear();
    await new Promise((resolve) => server.close(resolve));
    store.close();
  }

  return { server, store, start, stop, codexAdapter, antigravityAdapter, codeBuddyAdapter };
}
