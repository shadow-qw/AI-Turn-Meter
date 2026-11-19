import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

function parseIsoMs(ts) {
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
  if (typeof ts !== 'string') return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

export function workspaceMd5(workspacePath) {
  return createHash('md5').update(workspacePath).digest('hex');
}

function extractWorkspaceFromMessageObj(msgObj) {
  try {
    const inner = typeof msgObj.message === 'string' ? JSON.parse(msgObj.message) : msgObj.message;
    const text = inner?.content?.[0]?.text;
    if (typeof text === 'string') {
      const m = text.match(/Workspace Folder:\s*([^\n\r<]+)/);
      if (m && m[1]) return m[1].trim();
    }
  } catch {
    // ignore
  }
  try {
    const extra = typeof msgObj.extra === 'string' ? JSON.parse(msgObj.extra) : msgObj.extra;
    const fp = extra?.selectionContexts?.[0]?.filePath;
    if (typeof fp === 'string' && fp.includes('/')) {
      return null;
    }
  } catch {
    // ignore
  }
  return null;
}

function extractAssistantText(msgObj) {
  try {
    const inner =
      msgObj?.message !== undefined
        ? typeof msgObj.message === 'string'
          ? JSON.parse(msgObj.message)
          : msgObj.message
        : msgObj;
    const content = inner?.content ?? msgObj?.content;
    if (typeof content === 'string') return content.trim() || null;
    if (Array.isArray(content)) {
      const joined = content
        .map((part) => (typeof part?.text === 'string' ? part.text : ''))
        .join(' ')
        .trim();
      return joined || null;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Parse a CodeBuddy CN IDE conversation directory (index.json + messages/*.json).
 * @param {string} sessionDir
 * @param {string} [workspaceHash]
 */
export function parseCodeBuddyIdeSessionDir(sessionDir, workspaceHash = null) {
  const indexPath = join(sessionDir, 'index.json');
  if (!existsSync(indexPath)) return [];

  let idx;
  try {
    idx = JSON.parse(readFileSync(indexPath, 'utf8'));
  } catch {
    return [];
  }

  const sessionId = basename(sessionDir);
  const projHash = workspaceHash || basename(dirname(sessionDir));
  const requests = Array.isArray(idx.requests) ? idx.requests : [];
  if (requests.length === 0) return [];

  let discoveredWorkspacePath = null;
  const completed = [];

  for (const req of requests) {
    if (req?.state !== 'complete') continue;
    const msgIds = Array.isArray(req.messages) ? req.messages : [];
    const reqUsage = req.usage || {};

    let model = 'unknown';
    let lastMsg = null;
    let lastExtra = null;
    let lastCreatedMs = null;

    // Extract workspace from first user message if available
    if (!discoveredWorkspacePath && msgIds.length > 0) {
      const firstPath = join(sessionDir, 'messages', `${msgIds[0]}.json`);
      if (existsSync(firstPath)) {
        try {
          discoveredWorkspacePath = extractWorkspaceFromMessageObj(
            JSON.parse(readFileSync(firstPath, 'utf8'))
          );
        } catch {
          // ignore
        }
      }
    }

    // Walk backward to find the final assistant message with extra.statsSnapshot
    for (let i = msgIds.length - 1; i >= 0; i -= 1) {
      const mp = join(sessionDir, 'messages', `${msgIds[i]}.json`);
      if (!existsSync(mp)) continue;
      try {
        const mObj = JSON.parse(readFileSync(mp, 'utf8'));
        const extra = typeof mObj.extra === 'string' ? JSON.parse(mObj.extra) : mObj.extra;
        if (mObj.role === 'assistant') {
          if (!lastMsg) {
            lastMsg = mObj;
            lastExtra = extra;
            lastCreatedMs = parseIsoMs(mObj.createdAt);
          }
          if (model === 'unknown' && (extra?.modelName || extra?.modelId)) {
            model = extra.modelName || extra.modelId;
          }
          if (lastMsg && model !== 'unknown') break;
        }
      } catch {
        // ignore
      }
    }

    const snap = lastExtra?.statsSnapshot || {};
    const totalInputTokens = Number(snap.inputTokens ?? reqUsage.inputTokens) || 0;
    const cacheReadTokens = Number(snap.cachedInputTokens ?? reqUsage.cacheTokens) || 0;
    const cacheWriteTokens = Number(snap.cacheWriteTokens ?? reqUsage.cachedWriteTokens) || 0;
    const outputTokens = Number(snap.outputTokens ?? reqUsage.outputTokens) || 0;
    const thinkingTokensRaw = snap.thinkingTokens;
    const thinkingTokens =
      typeof thinkingTokensRaw === 'number' && thinkingTokensRaw >= 0 ? thinkingTokensRaw : null;

    if (totalInputTokens === 0 && outputTokens === 0) continue;

    const startedAtMs = typeof req.startedAt === 'number' ? req.startedAt : null;
    const completedAtMs = lastCreatedMs ?? (startedAtMs ?? Date.now());
    const durationMs =
      startedAtMs !== null && completedAtMs >= startedAtMs ? completedAtMs - startedAtMs : null;

    const elapsedMs =
      typeof snap.elapsedMs === 'number' && snap.elapsedMs >= 150 ? snap.elapsedMs : null;
    const modelActiveMs = elapsedMs ?? durationMs;
    const tpsMethod = elapsedMs !== null ? 'active_model' : durationMs !== null ? 'e2e_turn' : 'unavailable';

    const assistantMsgCount =
      typeof lastExtra?.agentMessageCount === 'number' && lastExtra.agentMessageCount > 0
        ? lastExtra.agentMessageCount
        : Math.max(1, msgIds.filter((_, idxPos) => idxPos > 0).length);

    completed.push({
      turnUid: `codebuddy:${sessionId}:${req.id}`,
      tool: 'codebuddy',
      host: 'codebuddy-cn-ide',
      sessionId,
      turnId: String(req.id),
      model,
      workspacePath: discoveredWorkspacePath,
      workspaceHash: projHash,
      startedAtMs,
      completedAtMs,
      callCount: assistantMsgCount,
      totalInputTokens,
      uncachedInputTokens: Math.max(0, totalInputTokens - cacheReadTokens - cacheWriteTokens),
      cacheReadTokens,
      cacheWriteTokens,
      outputTokens,
      thinkingTokens,
      durationMs,
      modelActiveMs,
      ttftMs: null,
      tpsMethod,
      replyPreview: lastMsg ? extractAssistantText(lastMsg) : null,
    });
  }

  return completed;
}

/**
 * Parse a CodeBuddy CLI (~/.codebuddy/projects JSONL) string into TurnRecords.
 * @param {string} content
 * @param {string} filePath
 */
export function parseCodeBuddyCliContent(content, filePath = '') {
  const lines = content.split(/\r?\n/);
  let sessionId = basename(filePath, '.jsonl') || 'codebuddy-cli';
  let workspacePath = null;

  const rawTurns = [];
  let current = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    if (obj.sessionId) sessionId = obj.sessionId;
    if (obj.cwd && !workspacePath) workspacePath = obj.cwd;

    const tsMs = typeof obj.timestamp === 'number' ? obj.timestamp : null;

    if (obj.type === 'message' && obj.role === 'user') {
      if (current) {
        current.closedByNextUser = true;
        rawTurns.push(current);
      }
      current = {
        turnId: obj.id || `turn-${rawTurns.length + 1}`,
        model: 'unknown',
        startedAtMs: tsMs,
        lastAtMs: tsMs,
        calls: new Map(),
        toolWaitMs: 0,
        lastToolStartMs: null,
        lastEventType: 'user',
        replyPreview: null,
      };
      continue;
    }

    if (!current) continue;
    if (tsMs !== null) current.lastAtMs = tsMs;
    current.lastEventType = obj.type;

    if (
      obj.role === 'assistant' &&
      (obj.type === 'message' || obj.content !== undefined || obj.message !== undefined)
    ) {
      const text = extractAssistantText(obj);
      if (text) current.replyPreview = text;
    }

    if (obj.type === 'function_call' && tsMs !== null) {
      current.lastToolStartMs = tsMs;
    } else if (obj.type === 'function_call_result' && tsMs !== null && current.lastToolStartMs !== null) {
      if (tsMs >= current.lastToolStartMs) {
        current.toolWaitMs += tsMs - current.lastToolStartMs;
      }
      current.lastToolStartMs = null;
    }

    const pd = obj.providerData;
    if (pd && typeof pd === 'object') {
      if (pd.requestModelName || pd.model) current.model = pd.requestModelName || pd.model;
      const raw = pd.rawUsage;
      if (raw && typeof raw === 'object') {
        const key = pd.messageId || `${pd.conversationRequestId || ''}:${pd.stepSeq || ''}` || obj.id;
        current.calls.set(key, {
          input: Number(raw.prompt_tokens) || 0,
          cacheRead: Number(raw.prompt_cache_hit_tokens || raw.cache_read_input_tokens) || 0,
          cacheWrite: Number(raw.cache_creation_input_tokens || raw.prompt_cache_write_tokens) || 0,
          output: Number(raw.completion_tokens) || 0,
          thinking:
            typeof raw.completion_thinking_tokens === 'number'
              ? raw.completion_thinking_tokens
              : null,
        });
      }
    }
  }
  if (current) rawTurns.push(current);

  const completed = [];
  for (const rt of rawTurns) {
    if (rt.calls.size === 0) continue;
    // Only emit turns closed by next user or ending cleanly on a message
    if (!rt.closedByNextUser && rt.lastEventType !== 'message') continue;

    let totalInputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let outputTokens = 0;
    let thinkingTokens = 0;
    let hasThinking = false;

    for (const c of rt.calls.values()) {
      totalInputTokens += c.input;
      cacheReadTokens += c.cacheRead;
      cacheWriteTokens += c.cacheWrite;
      outputTokens += c.output;
      if (c.thinking !== null) {
        thinkingTokens += c.thinking;
        hasThinking = true;
      }
    }
    if (totalInputTokens === 0 && outputTokens === 0) continue;

    const durationMs =
      rt.startedAtMs !== null && rt.lastAtMs !== null && rt.lastAtMs >= rt.startedAtMs
        ? rt.lastAtMs - rt.startedAtMs
        : null;
    const modelActiveMs =
      durationMs !== null ? Math.max(150, durationMs - rt.toolWaitMs) : null;

    completed.push({
      turnUid: `codebuddy-cli:${sessionId}:${rt.turnId}`,
      tool: 'codebuddy',
      host: 'codebuddy-cli',
      sessionId,
      turnId: rt.turnId,
      model: rt.model,
      workspacePath,
      workspaceHash: workspacePath ? workspaceMd5(workspacePath) : null,
      startedAtMs: rt.startedAtMs,
      completedAtMs: rt.lastAtMs ?? Date.now(),
      callCount: rt.calls.size,
      totalInputTokens,
      uncachedInputTokens: Math.max(0, totalInputTokens - cacheReadTokens - cacheWriteTokens),
      cacheReadTokens,
      cacheWriteTokens,
      outputTokens,
      thinkingTokens: hasThinking ? thinkingTokens : null,
      durationMs,
      modelActiveMs,
      ttftMs: null,
      tpsMethod: rt.toolWaitMs > 0 ? 'e2e_minus_tools' : 'e2e_turn',
      replyPreview: rt.replyPreview || null,
    });
  }

  return completed;
}

export class CodeBuddyAdapter {
  constructor({
    store,
    onTurns,
    extDataDir = join(homedir(), 'Library', 'Application Support', 'CodeBuddyExtension', 'Data'),
    cliProjectsDir = join(homedir(), '.codebuddy', 'projects'),
    isEnabled = () => true,
  }) {
    this.store = store;
    this.onTurns = onTurns;
    this.extDataDir = extDataDir;
    this.cliProjectsDir = cliProjectsDir;
    this.isEnabled = isEnabled;
    this.indexMtimes = new Map();
    this.cliMtimes = new Map();
    this.watchers = [];
    this.timer = null;
    this.backfillTimer = null;
  }

  findIdeSessions() {
    const found = [];
    if (!existsSync(this.extDataDir)) return found;

    let userDirs;
    try {
      userDirs = readdirSync(this.extDataDir, { withFileTypes: true });
    } catch {
      return found;
    }

    for (const u of userDirs) {
      if (!u.isDirectory()) continue;
      const histRoot = join(this.extDataDir, u.name, 'CodeBuddyIDE', u.name, 'history');
      if (!existsSync(histRoot)) continue;
      let projDirs;
      try {
        projDirs = readdirSync(histRoot, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const p of projDirs) {
        if (!p.isDirectory()) continue;
        const projPath = join(histRoot, p.name);
        let sessDirs;
        try {
          sessDirs = readdirSync(projPath, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const s of sessDirs) {
          if (!s.isDirectory()) continue;
          const idxFile = join(projPath, s.name, 'index.json');
          try {
            const st = statSync(idxFile);
            found.push({
              sessionDir: join(projPath, s.name),
              idxFile,
              workspaceHash: p.name,
              mtimeMs: st.mtimeMs,
              sizeBytes: st.size,
            });
          } catch {
            // No index.json
          }
        }
      }
    }
    return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  findCliFiles() {
    const found = [];
    if (!existsSync(this.cliProjectsDir)) return found;
    let projDirs;
    try {
      projDirs = readdirSync(this.cliProjectsDir, { withFileTypes: true });
    } catch {
      return found;
    }
    for (const p of projDirs) {
      if (!p.isDirectory()) continue;
      const pDir = join(this.cliProjectsDir, p.name);
      let files;
      try {
        files = readdirSync(pDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
        const fp = join(pDir, f.name);
        try {
          const st = statSync(fp);
          found.push({ fp, mtimeMs: st.mtimeMs, sizeBytes: st.size });
        } catch {
          // ignore
        }
      }
    }
    return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  scan({ maxRecent = 25 } = {}) {
    if (this.isEnabled && !this.isEnabled()) return [];
    const changed = [];

    let ideSessions = this.findIdeSessions();
    if (Number.isFinite(maxRecent)) ideSessions = ideSessions.slice(0, maxRecent);
    for (const { sessionDir, idxFile, workspaceHash, mtimeMs, sizeBytes } of ideSessions.reverse()) {
      if (this.indexMtimes.get(idxFile) === mtimeMs) continue;
      const cached = this.store.getIngestedFile?.(idxFile);
      if (cached && cached.mtimeMs === mtimeMs && cached.sizeBytes === sizeBytes) {
        this.indexMtimes.set(idxFile, mtimeMs);
        continue;
      }
      this.indexMtimes.set(idxFile, mtimeMs);
      for (const t of parseCodeBuddyIdeSessionDir(sessionDir, workspaceHash)) {
        const res = this.store.upsertTurn(t);
        if (res.changed) changed.push(res.record);
      }
      this.store.setIngestedFile?.(idxFile, mtimeMs, sizeBytes);
    }

    let cliFiles = this.findCliFiles();
    if (Number.isFinite(maxRecent)) cliFiles = cliFiles.slice(0, maxRecent);
    for (const { fp, mtimeMs, sizeBytes } of cliFiles.reverse()) {
      if (this.cliMtimes.get(fp) === mtimeMs) continue;
      const cached = this.store.getIngestedFile?.(fp);
      if (cached && cached.mtimeMs === mtimeMs && cached.sizeBytes === sizeBytes) {
        this.cliMtimes.set(fp, mtimeMs);
        continue;
      }
      this.cliMtimes.set(fp, mtimeMs);
      try {
        const content = readFileSync(fp, 'utf8');
        for (const t of parseCodeBuddyCliContent(content, fp)) {
          const res = this.store.upsertTurn(t);
          if (res.changed) changed.push(res.record);
        }
        this.store.setIngestedFile?.(fp, mtimeMs, sizeBytes);
      } catch {
        // ignore
      }
    }

    if (changed.length > 0 && this.onTurns) {
      this.onTurns(changed);
    }
    return changed;
  }

  start() {
    this.scan({ maxRecent: 25 });
    this.backfillTimer = setTimeout(() => {
      this.backfillTimer = null;
      this.scan({ maxRecent: Infinity });
    }, 250);
    this.backfillTimer.unref?.();
    for (const dir of [this.extDataDir, this.cliProjectsDir]) {
      if (!existsSync(dir)) continue;
      try {
        const w = watch(dir, { recursive: true }, () => this.scheduleScan());
        this.watchers.push(w);
      } catch {
        // Poll covers fallback
      }
    }
    this.timer = setInterval(() => this.scan({ maxRecent: 10 }), 2000);
    this.timer.unref?.();
  }

  scheduleScan() {
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      this.scan({ maxRecent: 10 });
    }, 150);
  }

  stop() {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    if (this.timer) clearInterval(this.timer);
    if (this.backfillTimer) clearTimeout(this.backfillTimer);
    if (this.pending) clearTimeout(this.pending);
  }
}
