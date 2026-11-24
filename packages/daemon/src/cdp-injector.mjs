import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function getDefaultCdpSpecs() {
  return [
    {
      tool: 'antigravity',
      portFile: join(homedir(), 'Library', 'Application Support', 'Antigravity', 'DevToolsActivePort'),
      port: Number(process.env.AI_TURN_METER_ANTIGRAVITY_CDP_PORT || 47924),
    },
    {
      tool: 'codex',
      port: Number(process.env.AI_TURN_METER_CODEX_CDP_PORT || 47921),
    },
    {
      tool: 'cursor',
      port: Number(process.env.AI_TURN_METER_CURSOR_CDP_PORT || 47922),
    },
    {
      tool: 'codebuddy',
      port: Number(process.env.AI_TURN_METER_CODEBUDDY_CDP_PORT || 47923),
    },
  ];
}

/**
 * Self-contained browser runtime injected via loopback CDP into Electron/Chromium apps
 * (Antigravity Desktop, Codex Desktop, Cursor, CodeBuddy CN).
 * Uses pure DOM APIs (zero innerHTML) for strict Trusted Types / CSP compliance.
 */
export function buildInjectedRuntimeSource() {
  return `(() => {
  const RUNTIME_VERSION = 12;
  if (window.__aiTurnMeterVersion === RUNTIME_VERSION) return;
  if (typeof window.__aiTurnMeterCleanup === 'function') {
    try { window.__aiTurnMeterCleanup(); } catch {}
  }
  window.__aiTurnMeterVersion = RUNTIME_VERSION;
  window.__aiTurnMeterInstalled = true;

  const PILL_CLASS = 'ai-turn-meter-inline-pill';
  const POPOVER_ID = 'ai-turn-meter-inline-popover';
  const STYLE_ID = 'ai-turn-meter-inline-style';

  let activeTool = null;
  let allTurns = [];
  const turnsByUid = new Map();
  const seenTurnUids = new Set();
  let hideTimer = null;
  let remountTimer = null;

  function removeAllExisting() {
    document
      .querySelectorAll('#ai-turn-meter-inline-pill, .' + PILL_CLASS + ', #' + POPOVER_ID)
      .forEach((el) => el.remove());
  }

  function ensureStyles() {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      document.head.appendChild(style);
    }
    style.textContent = [
      '.' + PILL_CLASS + ' {',
      '  display: inline-flex; align-items: center; gap: 5px;',
      '  padding: 2px 8px; border-radius: 999px; font-size: 11.5px; line-height: 16px;',
      '  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif;',
      '  font-variant-numeric: tabular-nums;',
      '  color: var(--muted-foreground, var(--vscode-descriptionForeground, rgba(120, 126, 138, 0.92)));',
      '  background: transparent;',
      '  border: 1px solid transparent;',
      '  cursor: default; user-select: none; white-space: nowrap; flex-shrink: 0;',
      '  margin-right: 8px; max-width: 100%; overflow: hidden;',
      '  transition: background-color 160ms ease, border-color 160ms ease, color 160ms ease;',
      '}',
      '.' + PILL_CLASS + '[data-wide-row="1"]:not([data-align="right"]) { margin-right: auto; }',
      '.' + PILL_CLASS + '[data-align="right"] { margin-left: 10px; margin-right: 0; }',
      '.' + PILL_CLASS + '[data-compact="1"] { font-size: 10.5px; padding: 1px 6px; margin-right: 6px; }',
      '.' + PILL_CLASS + ':hover {',
      '  color: var(--foreground, var(--vscode-editor-foreground, inherit));',
      '  background: color-mix(in srgb, var(--foreground, var(--vscode-editor-foreground, #888)) 6%, transparent);',
      '  border-color: color-mix(in srgb, var(--foreground, var(--vscode-editor-foreground, #888)) 10%, transparent);',
      '}',
      '.' + PILL_CLASS + '[data-flash="1"] {',
      '  background: color-mix(in srgb, var(--primary, #4f8cff) 10%, transparent);',
      '  border-color: color-mix(in srgb, var(--primary, #4f8cff) 32%, transparent);',
      '}',
      '.' + PILL_CLASS + ' .atm-dot {',
      '  width: 5px; height: 5px; border-radius: 999px; flex-shrink: 0;',
      '  background: color-mix(in srgb, var(--primary, #4f8cff) 75%, currentColor);',
      '  opacity: 0.7;',
      '}',
      '.' + PILL_CLASS + ' .atm-lbl { opacity: 0.56; font-size: 11px; }',
      '.' + PILL_CLASS + ' .atm-val { font-weight: 500; opacity: 0.92; }',
      '.' + PILL_CLASS + ' .atm-sub { opacity: 0.62; font-size: 11px; }',
      '.' + PILL_CLASS + ' .atm-sep-dot { opacity: 0.34; padding: 0 1px; }',

      '#' + POPOVER_ID + ' {',
      '  position: fixed; z-index: 2147483647; display: none; min-width: 284px; max-width: 360px;',
      '  padding: 11px 14px; border-radius: 12px; font-size: 12px; line-height: 1.45;',
      '  background: color-mix(in srgb, var(--popover, var(--card, var(--vscode-editorHoverWidget-background, #ffffff))) 86%, transparent);',
      '  backdrop-filter: blur(18px) saturate(150%); -webkit-backdrop-filter: blur(18px) saturate(150%);',
      '  color: var(--popover-foreground, var(--foreground, var(--vscode-editorHoverWidget-foreground, #1f2328)));',
      '  border: 1px solid color-mix(in srgb, var(--foreground, var(--vscode-editor-foreground, #888)) 12%, transparent);',
      '  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.14), 0 1px 4px rgba(0, 0, 0, 0.06);',
      '  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif;',
      '  font-variant-numeric: tabular-nums;',
      '}',
      '#' + POPOVER_ID + ' .atm-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; }',
      '#' + POPOVER_ID + ' .atm-title { font-weight: 600; font-size: 12px; letter-spacing: -0.01em; }',
      '#' + POPOVER_ID + ' .atm-badge {',
      '  font-size: 10.5px; padding: 1px 7px; border-radius: 999px; opacity: 0.72;',
      '  background: color-mix(in srgb, var(--foreground, #888) 7%, transparent);',
      '}',
      '#' + POPOVER_ID + ' .atm-grid { display: grid; grid-template-columns: repeat(4, minmax(0, auto)); justify-content: space-between; column-gap: 18px; padding: 2px 0; }',
      '#' + POPOVER_ID + ' .atm-col { display: flex; flex-direction: column; gap: 2px; }',
      '#' + POPOVER_ID + ' .atm-divider { height: 1px; margin: 9px 0 7px; background: color-mix(in srgb, var(--foreground, #888) 10%, transparent); }',
      '#' + POPOVER_ID + ' .atm-row { display: flex; align-items: baseline; justify-content: space-between; gap: 14px; padding: 1px 0; }',
      '#' + POPOVER_ID + ' .atm-k { opacity: 0.56; font-size: 11px; white-space: nowrap; flex-shrink: 0; }',
      '#' + POPOVER_ID + ' .atm-main { font-weight: 600; font-size: 13px; line-height: 1.3; white-space: nowrap; }',
      '#' + POPOVER_ID + ' .atm-foot-v { opacity: 0.72; font-size: 11.5px; white-space: nowrap; text-align: right; }'
    ].join('\\n');
  }

  function fmtTok(n) {
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return 'N/A';
    if (n < 1000) return String(Math.round(n));
    if (n < 1000000) return (n / 1000).toFixed(1).replace(/\\.0$/, '') + 'k';
    return (n / 1000000).toFixed(2).replace(/\\.?0+$/, '') + 'M';
  }

  function fmtTpsVal(tps) {
    if (typeof tps !== 'number' || !Number.isFinite(tps) || tps <= 0) return 'N/A';
    return tps >= 100 ? String(Math.round(tps)) : tps.toFixed(1).replace(/\\.0$/, '');
  }

  function span(cls, text) {
    const el = document.createElement('span');
    if (cls) el.className = cls;
    el.textContent = text;
    return el;
  }

  function renderPillContents(pill, t) {
    while (pill.firstChild) pill.removeChild(pill.firstChild);
    const cacheStr = t.cacheRatePct !== null && t.cacheRatePct !== undefined ? Math.round(t.cacheRatePct) + '%' : '--';
    pill.appendChild(span('atm-dot', ''));
    pill.appendChild(span('atm-lbl', '输入'));
    pill.appendChild(span('atm-val', fmtTok(t.totalInputTokens)));
    pill.appendChild(span('atm-sub', '(' + cacheStr + ')'));
    pill.appendChild(span('atm-sep-dot', '·'));
    pill.appendChild(span('atm-lbl', '输出'));
    pill.appendChild(span('atm-val', fmtTok(t.outputTokens)));
    pill.appendChild(span('atm-sep-dot', '·'));
    pill.appendChild(span('atm-val', fmtTpsVal(t.tps)));
    pill.appendChild(span('atm-lbl', 'tok/s'));
  }

  function ensurePopover() {
    let pop = document.getElementById(POPOVER_ID);
    if (!pop) {
      pop = document.createElement('div');
      pop.id = POPOVER_ID;
      pop.addEventListener('mouseenter', () => {
        if (hideTimer) clearTimeout(hideTimer);
      });
      pop.addEventListener('mouseleave', () => scheduleHide());
      document.body.appendChild(pop);
    }
    return pop;
  }

  function addCol(parent, label, val) {
    const col = document.createElement('div');
    col.className = 'atm-col';
    col.appendChild(span('atm-k', label));
    col.appendChild(span('atm-main', val));
    parent.appendChild(col);
  }

  function renderPopover(pop, t) {
    while (pop.firstChild) pop.removeChild(pop.firstChild);

    const head = document.createElement('div');
    head.className = 'atm-head';
    const toolName = t.toolLabel || t.tool || 'AI';
    const modelName = t.model && t.model !== 'unknown' ? t.model : toolName;
    head.appendChild(span('atm-title', modelName));
    head.appendChild(span('atm-badge', (t.callCount || 1) + ' 次调用'));
    pop.appendChild(head);

    const grid = document.createElement('div');
    grid.className = 'atm-grid';
    const cachePct = t.cacheRatePct !== null && t.cacheRatePct !== undefined ? t.cacheRatePct.toFixed(1).replace(/\\.0$/, '') + '%' : '--';
    addCol(grid, '输入', fmtTok(t.totalInputTokens));
    addCol(grid, '输出', fmtTok(t.outputTokens));
    addCol(grid, '缓存率', cachePct);
    addCol(grid, '速度', fmtTpsVal(t.tps) + ' tok/s');
    pop.appendChild(grid);

    if (t.sessionTotal) {
      const div = document.createElement('div');
      div.className = 'atm-divider';
      pop.appendChild(div);
      const row = document.createElement('div');
      row.className = 'atm-row';
      row.appendChild(span('atm-k', '会话 (' + t.sessionTotal.turnCount + ' 轮)'));
      row.appendChild(span('atm-foot-v', '输入 ' + fmtTok(t.sessionTotal.totalInputTokens) + ' · 输出 ' + fmtTok(t.sessionTotal.outputTokens)));
      pop.appendChild(row);
    }
  }

  function positionPopover(pill, pop) {
    const rect = pill.getBoundingClientRect();
    pop.style.display = 'block';
    const pw = pop.offsetWidth || 280;
    const ph = pop.offsetHeight || 135;
    let left = Math.min(window.innerWidth - pw - 12, Math.max(12, rect.left));
    let top = rect.top - ph - 8;
    if (top < 12) top = rect.bottom + 8;
    pop.style.left = Math.round(left) + 'px';
    pop.style.top = Math.round(top) + 'px';
  }

  function scheduleHide() {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      const pop = document.getElementById(POPOVER_ID);
      if (pop) pop.style.display = 'none';
    }, 200);
  }

  function findChatComposerRect() {
    const explicitSelectors = [
      '[data-testid="agent-input-box"]',
      '[data-testid="prompt-textarea"]',
      '.aislash-editor-container',
    ];
    for (const sel of explicitSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        const r = el.getBoundingClientRect();
        if (r.width >= 180 && r.height >= 24 && r.bottom >= window.innerHeight * 0.4) {
          return { el, rect: r };
        }
      }
    }

    const editors = Array.from(document.querySelectorAll('[contenteditable="true"], textarea, .ProseMirror'));
    let best = null;
    for (const ed of editors) {
      const r = ed.getBoundingClientRect();
      if (r.width < 180 || r.height < 16) continue;
      if (r.bottom < window.innerHeight * 0.45) continue;
      let box = ed;
      for (let i = 0; i < 4 && box.parentElement; i += 1) {
        const pr = box.parentElement.getBoundingClientRect();
        if (pr.width >= r.width && pr.width <= window.innerWidth * 0.92 && pr.height <= 280) {
          box = box.parentElement;
        }
      }
      const br = box.getBoundingClientRect();
      if (!best || br.bottom > best.rect.bottom) {
        best = { el: box, rect: br };
      }
    }
    return best;
  }

  function cleanTextWithoutPill(el) {
    if (!el) return '';
    let out = '';
    const walk = (node) => {
      if (!node) return;
      if (node.nodeType === 3) {
        out += node.nodeValue || '';
        return;
      }
      if (node.nodeType !== 1) return;
      const tag = (node.tagName || '').toUpperCase();
      if (tag === 'STYLE' || tag === 'SCRIPT' || tag === 'SVG' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') {
        return;
      }
      if (node.classList?.contains(PILL_CLASS) || node.id === POPOVER_ID || node.id === 'ai-turn-meter-inline-pill') {
        return;
      }
      for (const ch of node.childNodes) walk(ch);
      out += ' ';
    };
    walk(el);
    return out.replace(/\\s+/g, ' ').trim();
  }

  function findChatScrollContainer(cRect) {
    const candidates = Array.from(document.querySelectorAll('div, main, section'));
    let best = null;
    let bestScore = -Infinity;
    for (const el of candidates) {
      const style = window.getComputedStyle(el);
      if (!/(auto|scroll)/.test(style.overflowY)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < cRect.width * 0.72 || r.height < 120) continue;
      if (r.top > cRect.top || r.bottom > window.innerHeight + 48) continue;
      let depth = 0;
      for (let p = el.parentElement; p; p = p.parentElement) depth += 1;
      const hasOverflow = el.scrollHeight > el.clientHeight + 4 ? 10000 : 0;
      const score = hasOverflow + depth * 10 - (r.height > window.innerHeight * 0.96 ? 50 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return best;
  }

  function findAllAssistantFooters() {
    const composerInfo = findChatComposerRect();
    if (!composerInfo) return { scrollRoot: null, footers: [] };

    const cEl = composerInfo.el;
    const cRect = composerInfo.rect;
    const scrollRoot = findChatScrollContainer(cRect);
    const scope = scrollRoot || document;
    const minTop = scrollRoot ? scrollRoot.getBoundingClientRect().top - 12000 : 44;
    const candidates = Array.from(scope.querySelectorAll('div, footer'));

    const raw = [];
    for (const el of candidates) {
      if (el.id === POPOVER_ID || el.classList?.contains(PILL_CLASS)) continue;
      if (cEl.contains(el) || el.contains(cEl)) continue;
      if (el.closest('pre, code, nav, aside, header, [data-pending="true"], [role="tablist"], [role="menubar"], [role="navigation"]')) {
        continue;
      }

      const isIdeChat = activeTool === 'cursor' || activeTool === 'codebuddy';
      const isExplicitCursorFooter =
        activeTool === 'cursor' &&
        (el.classList?.contains('agent-transcript-turn-actions') ||
          el.classList?.contains('agent-transcript-turn-actions-trailing'));

      const rect = el.getBoundingClientRect();
      if (rect.left < cRect.left - 64 || rect.right > cRect.right + 64) continue;
      if (rect.width < (isExplicitCursorFooter ? 40 : 70) || rect.width > cRect.width + 64) continue;
      if (rect.height < 16 || rect.height > 56) continue;
      if (rect.top < minTop || rect.bottom > cRect.top + 8) continue;

      const btns = Array.from(el.querySelectorAll('button'));
      const minBtns = isExplicitCursorFooter ? 1 : isIdeChat ? 2 : 3;
      if (btns.length < minBtns || btns.length > 7) continue;
      const svgBtns = btns.filter((b) => b.querySelector('svg, .codicon, [data-icon-name], .ui-icon'));
      if (svgBtns.length < (isExplicitCursorFooter ? 1 : 2)) continue;

      const style = window.getComputedStyle(el);
      if (!style.display.includes('flex') || style.flexDirection.startsWith('column')) continue;
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;

      const text = cleanTextWithoutPill(el);
      if (text.length > 48) continue;

      const hasTimeHint = /(?:just now|ago|刚刚|秒前|分钟前|小时前|星期|今天|昨天|\\d{1,2}:\\d{2}|\\d+[smh])/i.test(text);
      if (isIdeChat && btns.length === 2 && !hasTimeHint && !isExplicitCursorFooter) continue;

      const firstBtnOffset = btns[0].getBoundingClientRect().left - rect.left;
      const alignRight = isIdeChat && style.justifyContent !== 'flex-end' && firstBtnOffset <= 24;

      const score =
        (isExplicitCursorFooter && el.classList?.contains('agent-transcript-turn-actions') ? 1000 : 0) +
        (hasTimeHint ? 2000 : 0) +
        (btns.length >= 3 && btns.length <= 6 ? 600 : 0) +
        Math.round(rect.width * 0.2) -
        Math.round(rect.height);

      raw.push({
        el,
        rect,
        score,
        alignRight,
        isWideRow: rect.width >= cRect.width * 0.55,
        isCompact: rect.width < 340,
      });
    }

    // Keep one canonical action bar per message reply (avoid nested wrapper duplication)
    raw.sort((a, b) => b.score - a.score);
    const deduped = [];
    for (const cand of raw) {
      const overlaps = deduped.some((kept) => {
        if (kept.el.contains(cand.el) || cand.el.contains(kept.el)) return true;
        return (
          Math.abs(kept.rect.top - cand.rect.top) <= 12 &&
          Math.abs(kept.rect.bottom - cand.rect.bottom) <= 12
        );
      });
      if (!overlaps) deduped.push(cand);
    }

    deduped.sort((a, b) => a.rect.top - b.rect.top);
    const footerEls = deduped.map((d) => d.el);

    for (const f of deduped) {
      const vRow = f.el.closest?.('.virtualized-composer-messages-row');
      if (vRow && vRow.parentElement) {
        const chunks = [];
        let totalLen = 0;
        let prev = vRow.previousElementSibling;
        for (let i = 0; i < 16 && prev && totalLen < 2500; i += 1) {
          if (footerEls.some((fe) => prev === fe || prev.contains(fe))) break;
          const hasHumanMarker =
            prev.getAttribute?.('data-human-row') === 'true' ||
            Boolean(prev.querySelector?.('[data-human-row="true"]'));
          const txt = cleanTextWithoutPill(prev);
          if (txt) {
            chunks.unshift(txt);
            totalLen += txt.length;
          }
          if (hasHumanMarker) break;
          prev = prev.previousElementSibling;
        }
        f.contextText = chunks.join(' ');
        f.msgSig = f.contextText.slice(0, 64);
        continue;
      }
      let msgBox = f.el.parentElement;
      let cur = msgBox;
      for (let i = 0; i < 5 && cur && cur !== scrollRoot && cur !== document.body; i += 1) {
        const containedFooters = footerEls.filter((fe) => cur.contains(fe));
        if (containedFooters.length > 1) break;
        msgBox = cur;
        cur = cur.parentElement;
      }
      f.contextText = cleanTextWithoutPill(msgBox);
      f.msgSig = f.contextText.slice(0, 64);
    }

    return { scrollRoot, footers: deduped };
  }

  function normalizeMatchText(s) {
    return String(s || '')
      .replace(/!\\[([^\\]]*)\\]\\([^)]*\\)/g, '$1')
      .replace(/\\[([^\\]]+)\\]\\([^)]*\\)/g, '$1')
      .replace(/[\\x60*_>#~\\[\\]]+/g, ' ')
      .replace(/\\s+/g, ' ')
      .trim();
  }

  function matchPreview(contextText, preview) {
    if (!contextText || !preview) return false;
    if (contextText.includes(preview)) return true;
    const normCtx = normalizeMatchText(contextText);
    const normPre = normalizeMatchText(preview);
    if (normPre.length < 4) return false;
    if (normCtx.includes(normPre)) return true;
    if (normPre.length >= 24 && normCtx.includes(normPre.slice(0, 24))) return true;
    if (normPre.length >= 12 && normCtx.includes(normPre.slice(-Math.min(24, normPre.length)))) return true;
    return false;
  }

  function assignTurnsToFooters(footers, turns) {
    const urlMatch = window.location.pathname.match(/^\\/c\\/([a-f0-9-]{8,})/i);
    const urlSessionId = urlMatch ? urlMatch[1] : null;
    let pool = urlSessionId ? turns.filter((t) => t.sessionId === urlSessionId) : turns.slice();
    if (pool.length === 0) return new Map();

    const assignedByFooter = new Map();
    const usedTurnUids = new Set();
    let detectedSessionId = urlSessionId;

    // Pass 1: exact text preview match (prioritize longer previews)
    const previewPool = pool
      .filter((t) => typeof t.replyPreview === 'string' && t.replyPreview.length >= 4)
      .sort(
        (a, b) =>
          b.replyPreview.length - a.replyPreview.length ||
          (b.completedAtMs || 0) - (a.completedAtMs || 0)
      );

    for (const f of footers) {
      const hit = previewPool.find(
        (t) => !usedTurnUids.has(t.turnUid) && matchPreview(f.contextText, t.replyPreview)
      );
      if (hit) {
        assignedByFooter.set(f, hit);
        usedTurnUids.add(hit.turnUid);
      }
    }

    if (!detectedSessionId && assignedByFooter.size > 0) {
      const sessionStats = new Map();
      for (const hit of assignedByFooter.values()) {
        const cur = sessionStats.get(hit.sessionId) || { count: 0, maxLen: 0, latestMs: 0 };
        cur.count += 1;
        cur.maxLen = Math.max(cur.maxLen, (hit.replyPreview || '').length);
        cur.latestMs = Math.max(cur.latestMs, hit.completedAtMs || 0);
        sessionStats.set(hit.sessionId, cur);
      }
      let bestSid = null;
      let bestStat = null;
      for (const [sid, st] of sessionStats.entries()) {
        if (
          !bestStat ||
          st.count > bestStat.count ||
          (st.count === bestStat.count && st.maxLen > bestStat.maxLen) ||
          (st.count === bestStat.count &&
            st.maxLen === bestStat.maxLen &&
            st.latestMs > bestStat.latestMs)
        ) {
          bestSid = sid;
          bestStat = st;
        }
      }
      detectedSessionId = bestSid;
    }

    if (detectedSessionId) {
      pool = pool.filter((t) => t.sessionId === detectedSessionId);
      let evicted = false;
      for (const [f, t] of Array.from(assignedByFooter.entries())) {
        if (t.sessionId !== detectedSessionId) {
          assignedByFooter.delete(f);
          usedTurnUids.delete(t.turnUid);
          evicted = true;
        }
      }
      if (evicted) {
        const scopedPreviewPool = previewPool.filter((t) => t.sessionId === detectedSessionId);
        for (const f of footers) {
          if (assignedByFooter.has(f)) continue;
          const hit = scopedPreviewPool.find(
            (t) => !usedTurnUids.has(t.turnUid) && matchPreview(f.contextText, t.replyPreview)
          );
          if (hit) {
            assignedByFooter.set(f, hit);
            usedTurnUids.add(hit.turnUid);
          }
        }
      }
    }

    // Pass 2: preserve already-mounted turn pins when the message wrapper wasn't recycled
    for (const f of footers) {
      if (assignedByFooter.has(f)) continue;
      const existingPill = f.el.querySelector(':scope > .' + PILL_CLASS);
      const prevUid = existingPill?.dataset?.atmTurnUid;
      const prevSig = f.el.dataset?.atmMsgSig || '';
      if (prevUid && !usedTurnUids.has(prevUid) && prevSig === f.msgSig) {
        const found = pool.find(
          (t) => t.turnUid === prevUid && (!detectedSessionId || t.sessionId === detectedSessionId)
        );
        if (found) {
          assignedByFooter.set(f, found);
          usedTurnUids.add(found.turnUid);
          if (!detectedSessionId) {
            detectedSessionId = found.sessionId;
            pool = pool.filter((t) => t.sessionId === detectedSessionId);
          }
        }
      }
    }

    // Pass 3: align remaining session turns chronologically bottom-up within anchored segments
    let workspaceSessionId = null;
    if (!detectedSessionId && !urlSessionId) {
      const rawTitle = (document.title || '').split(' [')[0].split(' — ')[0].trim();
      const wsMatch = rawTitle
        ? pool.find((t) => typeof t.workspacePath === 'string' && t.workspacePath.split('/').pop() === rawTitle)
        : null;
      if (wsMatch) workspaceSessionId = wsMatch.sessionId;
      else if (new Set(pool.map((t) => t.sessionId)).size === 1) workspaceSessionId = pool[0]?.sessionId;
    }
    const activeSessionId =
      detectedSessionId ||
      workspaceSessionId ||
      (!urlSessionId && pool.every((t) => !t.replyPreview) ? pool[0]?.sessionId : null);
    if (activeSessionId) {
      const sessionTurns = pool
        .filter((t) => t.sessionId === activeSessionId)
        .sort((a, b) => (a.completedAtMs || 0) - (b.completedAtMs || 0));

      const anchorIndices = [];
      for (let i = 0; i < footers.length; i += 1) {
        if (assignedByFooter.has(footers[i])) anchorIndices.push(i);
      }

      if (anchorIndices.length === 0) {
        const unusedTurns = sessionTurns.filter((t) => !usedTurnUids.has(t.turnUid));
        let fi = footers.length - 1;
        let ti = unusedTurns.length - 1;
        while (fi >= 0 && ti >= 0) {
          assignedByFooter.set(footers[fi], unusedTurns[ti]);
          usedTurnUids.add(unusedTurns[ti].turnUid);
          fi -= 1;
          ti -= 1;
        }
      } else {
        const segStarts = [-1, ...anchorIndices];
        const segEnds = [...anchorIndices, footers.length];
        for (let s = 0; s < segStarts.length; s += 1) {
          const leftIdx = segStarts[s];
          const rightIdx = segEnds[s];
          if (rightIdx - leftIdx <= 1) continue;
          const lowerTurn = leftIdx >= 0 ? assignedByFooter.get(footers[leftIdx]) : null;
          const upperTurn = rightIdx < footers.length ? assignedByFooter.get(footers[rightIdx]) : null;
          const lowerMs = lowerTurn ? lowerTurn.completedAtMs || 0 : -Infinity;
          const upperMs = upperTurn ? upperTurn.completedAtMs || 0 : Infinity;
          if (lowerMs > upperMs) continue;

          const segFooters = footers.slice(leftIdx + 1, rightIdx);
          const segTurns = sessionTurns.filter((t) => {
            if (usedTurnUids.has(t.turnUid)) return false;
            const ms = t.completedAtMs || 0;
            return ms >= lowerMs && ms <= upperMs;
          });
          let fi = segFooters.length - 1;
          let ti = segTurns.length - 1;
          while (fi >= 0 && ti >= 0) {
            assignedByFooter.set(segFooters[fi], segTurns[ti]);
            usedTurnUids.add(segTurns[ti].turnUid);
            fi -= 1;
            ti -= 1;
          }
        }
      }
    }

    return assignedByFooter;
  }

  function createPillElement() {
    const pill = document.createElement('span');
    pill.className = PILL_CLASS;
    pill.addEventListener('mouseenter', () => {
      if (hideTimer) clearTimeout(hideTimer);
      const uid = pill.dataset.atmTurnUid;
      const t = uid ? turnsByUid.get(uid) : null;
      if (!t) return;
      const pop = ensurePopover();
      renderPopover(pop, t);
      positionPopover(pill, pop);
    });
    pill.addEventListener('mouseleave', () => scheduleHide());
    pill.addEventListener('click', (e) => {
      e.stopPropagation();
      const uid = pill.dataset.atmTurnUid;
      const t = uid ? turnsByUid.get(uid) : null;
      if (!t) return;
      const pop = ensurePopover();
      if (pop.style.display === 'block' && pop.dataset.atmUid === uid) {
        pop.style.display = 'none';
      } else {
        pop.dataset.atmUid = uid;
        renderPopover(pop, t);
        positionPopover(pill, pop);
      }
    });
    return pill;
  }

  function mountAllTurns(flashNew) {
    if (allTurns.length === 0) return;
    ensureStyles();

    const { footers } = findAllAssistantFooters();
    if (footers.length === 0) return;

    const assigned = assignTurnsToFooters(footers, allTurns);
    for (const f of footers) {
      const t = assigned.get(f);
      let pill = f.el.querySelector(':scope > .' + PILL_CLASS);
      if (!t) {
        if (pill) pill.remove();
        continue;
      }
      if (!pill) {
        pill = createPillElement();
        if (f.alignRight) f.el.appendChild(pill);
        else f.el.insertBefore(pill, f.el.firstChild);
      } else if (f.alignRight && f.el.lastElementChild !== pill) {
        f.el.appendChild(pill);
      } else if (!f.alignRight && f.el.firstElementChild !== pill) {
        f.el.insertBefore(pill, f.el.firstChild);
      }
      pill.setAttribute('data-align', f.alignRight ? 'right' : 'left');
      pill.setAttribute('data-wide-row', f.isWideRow ? '1' : '0');
      pill.setAttribute('data-compact', f.isCompact ? '1' : '0');
      f.el.dataset.atmMsgSig = f.msgSig;

      const sig = [
        t.turnUid,
        t.totalInputTokens,
        t.cacheReadTokens,
        t.outputTokens,
        t.tps,
      ].join(':');
      const isNewTurn = !seenTurnUids.has(t.turnUid);
      seenTurnUids.add(t.turnUid);

      if (pill.dataset.atmRenderSig !== sig || !pill.firstChild) {
        pill.dataset.atmTurnUid = t.turnUid;
        pill.dataset.atmRenderSig = sig;
        renderPillContents(pill, t);
      }
      if (flashNew && isNewTurn) {
        pill.setAttribute('data-flash', '1');
        const targetPill = pill;
        setTimeout(() => targetPill && targetPill.removeAttribute('data-flash'), 900);
      }
    }
  }

  function scheduleRemount() {
    if (remountTimer || allTurns.length === 0) return;
    remountTimer = setTimeout(() => {
      remountTimer = null;
      mountAllTurns(false);
    }, 220);
  }

  window.__aiTurnMeterUpdateTurns = (turns, tool) => {
    if (!Array.isArray(turns)) return;
    if (tool) activeTool = tool;
    else if (turns[0]?.tool) activeTool = turns[0].tool;
    const isInitialLoad = seenTurnUids.size === 0;
    allTurns = turns;
    turnsByUid.clear();
    for (const t of turns) {
      if (t?.turnUid) turnsByUid.set(t.turnUid, t);
    }
    if (isInitialLoad) {
      for (const t of turns) {
        if (t?.turnUid) seenTurnUids.add(t.turnUid);
      }
    }
    mountAllTurns(!isInitialLoad);
    setTimeout(() => mountAllTurns(false), 450);
  };

  window.__aiTurnMeterUpdate = (turn) => {
    window.__aiTurnMeterUpdateTurns(turn ? [turn] : []);
  };

  const obs = new MutationObserver((mutations) => {
    if (allTurns.length === 0) return;
    const onlySelf = mutations.every((m) => {
      const t = m.target;
      return (
        t &&
        (t.id === POPOVER_ID ||
          t.classList?.contains(PILL_CLASS) ||
          t.closest?.('.' + PILL_CLASS + ', #' + POPOVER_ID))
      );
    });
    if (onlySelf) return;
    scheduleRemount();
  });
  obs.observe(document.body, { childList: true, subtree: true });
  document.addEventListener('scroll', scheduleRemount, true);

  window.__aiTurnMeterCleanup = () => {
    if (remountTimer) clearTimeout(remountTimer);
    obs.disconnect();
    document.removeEventListener('scroll', scheduleRemount, true);
    removeAllExisting();
  };

  removeAllExisting();
})();`;
}

const IGNORED_CDP_URL_PREFIXES = [
  'devtools://',
  'chrome-extension://',
  'chrome://',
  'data:',
  'about:',
  'blob:',
  'codex-sandbox://',
];

export function isEligibleCdpTarget(t) {
  if (!t || typeof t !== 'object') return false;
  if (t.type !== 'page' && t.type !== 'webview') return false;
  if (typeof t.webSocketDebuggerUrl !== 'string' || !t.webSocketDebuggerUrl.startsWith('ws://127.0.0.1')) {
    return false;
  }
  if (typeof t.url !== 'string' || t.url.length === 0) return false;
  if (IGNORED_CDP_URL_PREFIXES.some((prefix) => t.url.startsWith(prefix))) return false;
  if (
    t.url.includes('/api/auth/') ||
    t.url.includes('initialRoute=%2Favatar-overlay') ||
    t.url.includes('initialRoute=/avatar-overlay')
  ) {
    return false;
  }
  return true;
}

/**
 * Multi-host loopback CDP inline pill injector.
 */
export class CdpInlineInjector {
  constructor({
    specs = getDefaultCdpSpecs(),
    getTurnForTool = null,
    getTurnsForTool = null,
    shouldPushTool = null,
  }) {
    this.specs = specs;
    this.getTurnForTool = getTurnForTool;
    this.getTurnsForTool = getTurnsForTool;
    this.shouldPushTool = shouldPushTool;
    this.timer = null;
    this.lastPushedByTarget = new Map();
    this.runtimeSource = buildInjectedRuntimeSource();
  }

  resolvePort(spec, { listeningPorts = null, isListening = null } = {}) {
    const checkPort = (p) => {
      if (typeof isListening === 'function') return Boolean(isListening(p));
      if (listeningPorts instanceof Set) return listeningPorts.has(p);
      return true;
    };
    if (spec.portFile && existsSync(spec.portFile)) {
      try {
        const lines = readFileSync(spec.portFile, 'utf8').trim().split(/\r?\n/);
        const port = Number(lines[0]);
        if (Number.isInteger(port) && port > 0 && port <= 65535 && checkPort(port)) return port;
      } catch {}
    }
    if (typeof spec.port === 'number' && spec.port > 0 && spec.port <= 65535 && checkPort(spec.port)) {
      return spec.port;
    }
    return null;
  }

  async findTargets(port) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 900);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: ctrl.signal });
      if (!res.ok) return [];
      const targets = await res.json();
      if (!Array.isArray(targets)) return [];
      return targets.filter(isEligibleCdpTarget);
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  async findTargetsForSpec(spec) {
    const primaryPort = this.resolvePort(spec);
    if (!primaryPort) return [];
    const primaryTargets = await this.findTargets(primaryPort);
    if (primaryTargets.length > 0) return primaryTargets;
    const fallbackPort =
      typeof spec.port === 'number' && spec.port > 0 && spec.port <= 65535 ? spec.port : null;
    if (fallbackPort && fallbackPort !== primaryPort) {
      return this.findTargets(fallbackPort);
    }
    return [];
  }

  evaluateOnTarget(wsUrl, expression) {
    return new Promise((resolve) => {
      let settled = false;
      let timeout = null;
      const done = (val) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        resolve(val);
      };
      let ws;
      try {
        ws = new WebSocket(wsUrl);
      } catch {
        return done(false);
      }
      timeout = setTimeout(() => {
        try {
          ws.close();
        } catch {}
        done(false);
      }, 1400);

      ws.addEventListener('open', () => {
        try {
          ws.send(
            JSON.stringify({
              id: 1,
              method: 'Runtime.evaluate',
              params: { expression, returnByValue: true },
            })
          );
        } catch {
          done(false);
        }
      });
      ws.addEventListener('message', (ev) => {
        try {
          const msg = JSON.parse(String(ev.data));
          if (msg.id === 1) {
            done(!msg.error);
            try {
              ws.close();
            } catch {}
          }
        } catch {
          // ignore
        }
      });
      ws.addEventListener('error', () => {
        done(false);
      });
      ws.addEventListener('close', () => {
        done(false);
      });
    });
  }

  async pushTool(spec, { force = false } = {}) {
    if (typeof this.shouldPushTool === 'function' && !this.shouldPushTool(spec.tool)) {
      return false;
    }

    const targets = await this.findTargetsForSpec(spec);
    const prefix = `${spec.tool}:`;
    const activeKeys = new Set();
    for (const target of targets) {
      activeKeys.add(`${prefix}${target.id || target.webSocketDebuggerUrl}`);
    }
    for (const k of Array.from(this.lastPushedByTarget.keys())) {
      if (k.startsWith(prefix) && !activeKeys.has(k)) {
        this.lastPushedByTarget.delete(k);
      }
    }
    if (targets.length === 0) return false;

    let turns = [];
    if (typeof this.getTurnsForTool === 'function') {
      turns = (this.getTurnsForTool(spec.tool) || []).filter(
        (t) => t && t.host !== 'cursor-cloud' && t.host !== 'antigravity-subagent'
      );
    } else if (typeof this.getTurnForTool === 'function') {
      const one = this.getTurnForTool(spec.tool);
      if (one && one.host !== 'cursor-cloud' && one.host !== 'antigravity-subagent') turns = [one];
    }
    if (turns.length === 0) return false;

    const sig = turns
      .slice(0, 16)
      .map((t) => `${t.turnUid}:${t.completedAtMs}:${t.tps}:${t.totalInputTokens}:${t.replyPreview || ''}`)
      .join('|');

    let payloadExpr = null;
    let anyOk = false;
    for (const target of targets) {
      const targetKey = `${prefix}${target.id || target.webSocketDebuggerUrl}`;
      const targetUrl = target.url || '';
      const prev = this.lastPushedByTarget.get(targetKey);
      if (!force && prev && prev.sig === sig && prev.url === targetUrl) {
        continue;
      }
      if (!payloadExpr) {
        payloadExpr = `${this.runtimeSource}\nwindow.__aiTurnMeterUpdateTurns(${JSON.stringify(turns)}, ${JSON.stringify(spec.tool)});`;
      }
      const ok = await this.evaluateOnTarget(target.webSocketDebuggerUrl, payloadExpr);
      if (ok) {
        this.lastPushedByTarget.set(targetKey, { sig, url: targetUrl });
        anyOk = true;
      }
    }
    return anyOk;
  }

  async clearTool(tool) {
    const spec = this.specs.find((s) => s.tool === tool);
    if (!spec) return false;
    const prefix = `${tool}:`;
    for (const k of Array.from(this.lastPushedByTarget.keys())) {
      if (k.startsWith(prefix)) {
        this.lastPushedByTarget.delete(k);
      }
    }
    const targets = await this.findTargetsForSpec(spec);
    if (targets.length === 0) return false;
    const expr = 'if (typeof window.__aiTurnMeterCleanup === "function") { window.__aiTurnMeterCleanup(); } window.__aiTurnMeterVersion = 0;';
    await Promise.all(targets.map((t) => this.evaluateOnTarget(t.webSocketDebuggerUrl, expr)));
    return true;
  }

  async clearAll() {
    await Promise.all(this.specs.map((s) => this.clearTool(s.tool).catch(() => false)));
  }

  async pushAll({ force = false, tools = null } = {}) {
    const list = tools ? this.specs.filter((s) => tools.includes(s.tool)) : this.specs;
    await Promise.all(list.map((s) => this.pushTool(s, { force })));
  }

  start() {
    this.pushAll({ force: true }).catch(() => {});
    this.timer = setInterval(() => {
      this.pushAll().catch(() => {});
    }, 3000);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}
