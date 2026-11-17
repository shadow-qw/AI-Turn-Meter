const crypto = require('node:crypto');
const http = require('node:http');
const vscode = require('vscode');

function detectHostTool(appName) {
  const low = String(appName || '').toLowerCase();
  if (low.includes('cursor')) return 'cursor';
  if (low.includes('codebuddy')) return 'codebuddy';
  if (low.includes('antigravity')) return 'antigravity';
  return null;
}

function fmtTokens(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return 'N/A';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
}

function fmtTps(tps) {
  if (typeof tps !== 'number' || !Number.isFinite(tps) || tps <= 0) return 'N/A tok/s';
  const val = tps >= 100 ? Math.round(tps) : Number(tps.toFixed(1).replace(/\.0$/, ''));
  return `${val} tok/s`;
}

function httpGetJson(urlStr) {
  return new Promise((resolve, reject) => {
    const req = http.get(urlStr, { timeout: 1500 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        body += c;
      });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
  });
}

function buildTooltip(turn) {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = false;
  if (!turn) {
    md.appendMarkdown('**AI Turn Meter**\n\n等待本窗口完成首轮对话。');
    return md;
  }

  const cacheRate =
    turn.cacheRatePct !== null && turn.cacheRatePct !== undefined
      ? `${Number(turn.cacheRatePct).toFixed(1).replace(/\.0$/, '')}%`
      : '--';
  const modelText = turn.model && turn.model !== 'unknown' ? turn.model : turn.toolLabel || turn.tool;

  md.appendMarkdown(`**${modelText}** · ${turn.callCount || 1} 次调用\n\n`);
  md.appendMarkdown(`| 输入 | 输出 | 缓存率 | 速度 |\n| :---: | :---: | :---: | :---: |\n| **${fmtTokens(turn.totalInputTokens)}** | **${fmtTokens(turn.outputTokens)}** | **${cacheRate}** | **${fmtTps(turn.tps)}** |\n`);
  if (turn.sessionTotal) {
    md.appendMarkdown(
      `\n---\n会话 (${turn.sessionTotal.turnCount} 轮)：输入 ${fmtTokens(turn.sessionTotal.totalInputTokens)} · 输出 ${fmtTokens(turn.sessionTotal.outputTokens)}`
    );
  }
  return md;
}

function activate(context) {
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = 'aiTurnMeter.showRecent';
  statusItem.text = '$(pulse) 等待首轮回复';
  statusItem.tooltip = buildTooltip(null);
  statusItem.show();
  context.subscriptions.push(statusItem);

  let sseReq = null;
  let reconnectTimer = null;
  let pollTimer = null;
  let disposed = false;

  function getConfig() {
    const cfg = vscode.workspace.getConfiguration('aiTurnMeter');
    const baseUrl = String(cfg.get('daemonUrl') || 'http://127.0.0.1:47831').replace(/\/$/, '');
    const filter = String(cfg.get('toolFilter') || 'auto');
    const tool = filter === 'auto' ? detectHostTool(vscode.env.appName) : filter;
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || '';
    const workspaceHash = workspacePath
      ? crypto.createHash('md5').update(workspacePath).digest('hex')
      : '';
    return { baseUrl, tool, workspacePath, workspaceHash };
  }

  function renderTurn(turn) {
    if (!turn) {
      statusItem.text = '$(pulse) 等待首轮回复';
      statusItem.tooltip = buildTooltip(null);
      return;
    }
    statusItem.text = `$(pulse) ${turn.inlineText}`;
    statusItem.tooltip = buildTooltip(turn);
  }

  async function refreshOnce() {
    const { baseUrl, tool, workspacePath, workspaceHash } = getConfig();
    const qs = new URLSearchParams();
    if (tool) qs.set('tool', tool);
    if (workspacePath) qs.set('workspace', workspacePath);
    if (workspaceHash) qs.set('workspaceHash', workspaceHash);
    try {
      const data = await httpGetJson(`${baseUrl}/v1/match?${qs.toString()}`);
      renderTurn(data.turn || null);
    } catch {
      statusItem.text = '$(pulse) Daemon 未连接';
      statusItem.tooltip = `无法连接本机 ${baseUrl}`;
    }
  }

  function connectSse() {
    if (disposed) return;
    if (sseReq) {
      try {
        sseReq.destroy();
      } catch {}
      sseReq = null;
    }
    const { baseUrl } = getConfig();
    try {
      sseReq = http.get(`${baseUrl}/events`, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          scheduleReconnect();
          return;
        }
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buf += chunk;
          const parts = buf.split('\n\n');
          buf = parts.pop() || '';
          for (const part of parts) {
            if (part.includes('event: state') || part.includes('event: turn')) {
              refreshOnce().catch(() => {});
            }
          }
        });
        res.on('end', scheduleReconnect);
        res.on('error', scheduleReconnect);
      });
      sseReq.on('error', scheduleReconnect);
    } catch {
      scheduleReconnect();
    }
  }

  function scheduleReconnect() {
    if (disposed || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      refreshOnce().catch(() => {});
      connectSse();
    }, 3000);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('aiTurnMeter.refresh', () => {
      refreshOnce().catch(() => {});
    }),
    vscode.commands.registerCommand('aiTurnMeter.showRecent', async () => {
      const { baseUrl, tool } = getConfig();
      try {
        const qs = new URLSearchParams({ limit: '15' });
        if (tool) qs.set('tool', tool);
        const data = await httpGetJson(`${baseUrl}/v1/turns?${qs.toString()}`);
        const turns = data.turns || [];
        if (turns.length === 0) {
          vscode.window.showInformationMessage('AI Turn Meter: 暂无记录，等待新一轮对话完成。');
          return;
        }
        const items = turns.map((t) => ({
          label: `${t.toolLabel || t.tool} · ${t.inlineText}`,
          description: `${t.model !== 'unknown' ? t.model : ''} · ${new Date(t.completedAtMs).toLocaleTimeString()}`,
          detail: `新 ${fmtTokens(t.uncachedInputTokens)} · 缓存 ${fmtTokens(t.cacheReadTokens)} · ${t.tpsMethodLabel}${t.sessionTotal ? ` · 会话(${t.sessionTotal.turnCount}轮): 输入 ${fmtTokens(t.sessionTotal.totalInputTokens)} / 输出 ${fmtTokens(t.sessionTotal.outputTokens)}` : ''}`,
        }));
        await vscode.window.showQuickPick(items, {
          title: 'AI Turn Meter — 最近轮次明细',
          placeHolder: '按 Esc 关闭',
        });
      } catch {
        vscode.window.showWarningMessage(`AI Turn Meter: 无法连接本机 Daemon (${baseUrl})`);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('aiTurnMeter')) {
        refreshOnce().catch(() => {});
        connectSse();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      refreshOnce().catch(() => {});
    })
  );

  refreshOnce().catch(() => {});
  connectSse();
  pollTimer = setInterval(() => refreshOnce().catch(() => {}), 5000);

  context.subscriptions.push({
    dispose() {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (pollTimer) clearInterval(pollTimer);
      try {
        sseReq?.destroy();
      } catch {}
    },
  });
}

function deactivate() {}

module.exports = { activate, deactivate };
