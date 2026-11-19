import { formatTokens, formatTps, TOOL_LABELS } from './format.mjs';

const ZH_WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const EN_WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

/**
 * Format local YYYY-MM-DD key from timestamp.
 * @param {number} ms
 */
export function toLocalDateString(ms = Date.now()) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Parse YYYY-MM-DD into local start-of-day timestamp.
 * @param {string | null | undefined} dateStr
 * @param {number} [fallbackMs]
 */
export function parseLocalDateRange(dateStr, scope = 'day', fallbackMs = Date.now()) {
  let anchor;
  if (typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateStr.trim())) {
    const [y, m, d] = dateStr.trim().split('-').map(Number);
    anchor = new Date(y, m - 1, d);
  } else {
    const now = new Date(fallbackMs);
    anchor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }

  const normalizedScope = scope === 'week' || scope === 'month' ? scope : 'day';
  const endMs = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + 1).getTime();
  let startDate;
  if (normalizedScope === 'week') {
    startDate = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - 6);
  } else if (normalizedScope === 'month') {
    startDate = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - 29);
  } else {
    startDate = anchor;
  }
  const startMs = startDate.getTime();
  const dateKey = toLocalDateString(anchor.getTime());
  const startKey = toLocalDateString(startMs);
  const weekdayIdx = anchor.getDay();
  const weekdayLabel = `${ZH_WEEKDAYS[weekdayIdx]} · ${EN_WEEKDAYS[weekdayIdx]}`;
  const rangeLabel =
    normalizedScope === 'day'
      ? `${dateKey} (${weekdayLabel})`
      : normalizedScope === 'week'
        ? `${startKey} ~ ${dateKey} (近 7 天)`
        : `${startKey} ~ ${dateKey} (近 30 天)`;

  return {
    scope: normalizedScope,
    date: dateKey,
    startDate: startKey,
    startMs,
    endMs,
    weekdayLabel,
    rangeLabel,
  };
}

/**
 * Generate deterministic barcode bar pattern (0/1 widths) from seed string.
 * @param {string} seed
 * @param {number} [count]
 */
export function buildBarcodeBars(seed, count = 42) {
  let h = 2166136261 >>> 0;
  const str = String(seed || 'ATM-RECEIPT');
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  const bars = [];
  for (let i = 0; i < count; i += 1) {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    const width = (h & 3) === 0 ? 3 : (h & 1) === 0 ? 2 : 1;
    const gap = ((h >>> 2) & 3) === 0 ? 2 : 1;
    bars.push({ width, gap });
  }
  return bars;
}

/**
 * Pick witty thermal-receipt punchlines tailored to the receipt metrics.
 * @param {object} receipt
 */
export function buildReceiptPunchlines(receipt) {
  const totals = receipt?.totals || {};
  const cost = Number(totals.estimatedCostUsd) || 0;
  const saved = Number(totals.cacheSavingsUsd) || 0;
  const cacheRate = typeof totals.cacheRatePct === 'number' ? totals.cacheRatePct : 0;
  const turns = Number(totals.turnCount) || 0;
  const totalTokens = Number(totals.totalTokens) || 0;
  const lastAt = receipt?.highlights?.lastTurnAtMs;
  const lastHour = typeof lastAt === 'number' ? new Date(lastAt).getHours() : null;

  const list = [];
  if (turns === 0) {
    return [
      '今日未开张，Token 账户稳如泰山。',
      '零消费日！模型正在后厨待命。',
      '今天一行提示词没花钱，省到就是赚到。',
    ];
  }
  if (cost >= 30) {
    list.push('今日算力尊享黑卡 VIP，硅谷显卡为您持续发热。');
  } else if (cost >= 10) {
    list.push('大额算力买单日：代码有没有写完先不说，Token 气势拉满了。');
  } else if (cost >= 2) {
    list.push('一杯精品咖啡换一整天 AI 副驾，这笔买卖血赚。');
  } else {
    list.push('精打细算模范开发者，小预算撬动大产出。');
  }

  if (cacheRate >= 90 && saved >= 0.5) {
    list.push(`缓存命中 ${cacheRate.toFixed(0)}%，靠 Prompt Cache 薅回 $${saved.toFixed(2)}，资深羊毛党认证。`);
  } else if (cacheRate >= 75) {
    list.push(`Prompt Cache 稳稳兜底（${cacheRate.toFixed(0)}%），少交了不少智商税。`);
  }

  if (lastHour !== null && (lastHour >= 23 || lastHour <= 4)) {
    list.push('深夜食堂仍在出餐，建议给模型和自己都留点休息时间。');
  }
  if (totalTokens >= 20_000_000) {
    list.push('千万级 Token 吞吐达成，今天读的上下文比整套百科全书还厚。');
  } else if (turns >= 40) {
    list.push(`单期狂聊 ${turns} 轮，AI 已经快比你更懂这个仓库了。`);
  }

  list.push('小票请妥善保管，作为今日与 AI 并肩作战的唯一凭证。');
  list.push('THANK YOU FOR CODING WITH TOKENS · 欢迎下次光临');
  return list;
}

/**
 * Format currency value according to mode ('usd' | 'both' | 'cny') and exchange rate.
 * @param {number | null | undefined} usd
 * @param {{ currency?: string, usdToCny?: number }} [opts]
 */
export function formatReceiptMoney(usd, { currency = 'both', usdToCny = 7 } = {}) {
  if (typeof usd !== 'number' || !Number.isFinite(usd)) return 'N/A';
  const rate = Number.isFinite(Number(usdToCny)) && Number(usdToCny) > 0 ? Number(usdToCny) : 7;
  const fmtNum = (n) => {
    const abs = Math.abs(n);
    if (abs === 0) return '0.00';
    if (abs < 0.01) return abs.toFixed(4);
    return abs.toFixed(2);
  };
  const sign = usd < 0 ? '-' : '';
  const usdStr = `${sign}$${fmtNum(usd)}`;
  const cnyStr = `${sign}¥${fmtNum(usd * rate)}`;
  if (currency === 'usd') return usdStr;
  if (currency === 'cny') return cnyStr;
  return `${usdStr} (${cnyStr})`;
}

function padRow(left, right, width = 46) {
  const l = String(left);
  const r = String(right);
  const len = (s) => {
    let w = 0;
    for (const ch of s) {
      w += /[\u1100-\u115f\u2e80-\u9fff\uac00-\ud7a3\uff00-\uffef]/.test(ch) ? 2 : 1;
    }
    return w;
  };
  const space = Math.max(1, width - len(l) - len(r));
  return `${l}${' '.repeat(space)}${r}`;
}

function truncateText(text, maxChars = 28) {
  const str = String(text || '');
  if (str.length <= maxChars) return str;
  return `${str.slice(0, Math.max(4, maxChars - 1))}…`;
}

function formatClock(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '--:--';
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Render thermal-paper style ASCII receipt for terminal or clipboard sharing.
 * @param {object} receipt
 * @param {{ currency?: string, usdToCny?: number, hideProjects?: boolean, punchlineIndex?: number }} [opts]
 */
export function renderReceiptAscii(
  receipt,
  { currency = 'both', usdToCny = 7, hideProjects = false, punchlineIndex = 0 } = {}
) {
  const W = 48;
  const hr = '-'.repeat(W);
  const dhr = '='.repeat(W);
  const zigzagTop = '/\\'.repeat(W / 2);
  const zigzagBot = '\\/'.repeat(W / 2);
  const fmt = (val) => formatReceiptMoney(val, { currency, usdToCny });
  const totals = receipt.totals || {};
  const toolsText =
    Array.isArray(receipt.activeTools) && receipt.activeTools.length > 0
      ? receipt.activeTools.map((t) => TOOL_LABELS[t] || t).join(' / ')
      : '无活跃客户端';
  const punchlines = Array.isArray(receipt.punchlines) && receipt.punchlines.length > 0
    ? receipt.punchlines
    : buildReceiptPunchlines(receipt);
  const punchline = punchlines[Math.abs(Number(punchlineIndex) || 0) % punchlines.length];

  const lines = [
    zigzagTop,
    '',
    '          AI TURN METER  ·  DAILY RECEIPT',
    '               本地算力消费热敏小票',
    dhr,
    padRow(`单号 RECEIPT #`, receipt.receiptNo || '-', W),
    padRow(`日期 DATE`, receipt.rangeLabel || receipt.date || '-', W),
    padRow(`终端 CLIENTS`, truncateText(toolsText, 30), W),
    padRow(`汇总分组 GROUP`, receipt.groupBy === 'tool' ? '按提供商' : receipt.groupBy === 'project' ? '按项目' : '按模型', W),
    hr,
    padRow('ITEM / TOKENS', 'AMOUNT', W),
    hr,
  ];

  const items = Array.isArray(receipt.items) ? receipt.items : [];
  if (items.length === 0) {
    lines.push('  (当日暂无对话消费记录)');
  } else {
    for (const item of items.slice(0, 14)) {
      const displayName =
        hideProjects && receipt.groupBy === 'project'
          ? `Project #${items.indexOf(item) + 1}`
          : truncateText(item.label, 28);
      const money = item.priced ? fmt(item.estimatedCostUsd) : '未定价';
      lines.push(padRow(displayName, money, W));
      const cacheTag = item.cacheRatePct !== null && item.cacheRatePct !== undefined ? `缓存${item.cacheRatePct}%` : '无缓存';
      const prefixTag = receipt.groupBy === 'model' && item.sublabel ? `${item.sublabel} · ` : '';
      const detail = `  ${prefixTag}${item.turnCount}轮 · 入${formatTokens(item.totalInputTokens)}(${cacheTag}) · 出${formatTokens(item.outputTokens)}`;
      lines.push(detail);
    }
    if (items.length > 14) {
      lines.push(`  ... 其余 ${items.length - 14} 项已合并计入总计`);
    }
  }

  lines.push(hr);
  if (typeof totals.grossCostUsd === 'number' && totals.cacheSavingsUsd > 0) {
    lines.push(padRow('原价 SUBTOTAL (无缓存)', fmt(totals.grossCostUsd), W));
    lines.push(
      padRow(
        `会员立减 CACHE SAVED (${totals.cacheRatePct ?? 0}%)`,
        `-${formatReceiptMoney(totals.cacheSavingsUsd, { currency, usdToCny })}`,
        W
      )
    );
  }
  lines.push(dhr);
  lines.push(padRow('实付 TOTAL (API 等效)', fmt(totals.estimatedCostUsd), W));
  lines.push(dhr);
  lines.push(padRow('总计 TOKENS', `${formatTokens(totals.totalTokens)} (${totals.turnCount || 0} 轮 / ${totals.callCount || 0} 次)`, W));
  lines.push(
    padRow(
      '输入 / 输出',
      `${formatTokens(totals.totalInputTokens)} / ${formatTokens(totals.outputTokens)}`,
      W
    )
  );
  if (totals.avgTps) {
    lines.push(padRow('平均生成速度 AVG TPS', formatTps(totals.avgTps), W));
  }
  if (receipt.highlights?.firstTurnAtMs && receipt.highlights?.lastTurnAtMs) {
    lines.push(
      padRow(
        '活跃时段 HOURS',
        `${formatClock(receipt.highlights.firstTurnAtMs)} - ${formatClock(receipt.highlights.lastTurnAtMs)}`,
        W
      )
    );
  }
  if (!hideProjects && receipt.highlights?.topProject?.name) {
    lines.push(
      padRow(
        '最耗项目 TOP PROJECT',
        truncateText(receipt.highlights.topProject.name, 22),
        W
      )
    );
  }
  if (currency !== 'usd') {
    const rate = Number.isFinite(Number(usdToCny)) && Number(usdToCny) > 0 ? Number(usdToCny) : 7;
    lines.push(padRow('折算汇率 FX RATE', `1 USD = ${rate} CNY`, W));
  }

  lines.push(hr);
  lines.push(`  “${punchline}”`);
  lines.push('');
  lines.push('  |||| ||| || |||| | ||| |||| || ||| |||| ||| ||');
  lines.push(`             ${receipt.receiptNo || 'ATM-RECEIPT'}`);
  lines.push('');
  lines.push(zigzagBot);
  return lines.join('\n');
}

function escapeXml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Render shareable vector thermal-paper receipt SVG (paper or dark theme).
 * @param {object} receipt
 * @param {{ theme?: 'paper' | 'dark', currency?: string, usdToCny?: number, hideProjects?: boolean, punchlineIndex?: number }} [opts]
 */
export function renderReceiptSvg(
  receipt,
  { theme = 'paper', currency = 'both', usdToCny = 7, hideProjects = false, punchlineIndex = 0 } = {}
) {
  const dark = theme === 'dark';
  const bgOuter = dark ? '#0F1115' : '#EAE6DF';
  const paperBg = dark ? '#181B22' : '#FCFBF7';
  const ink = dark ? '#F3F4F6' : '#1E1D1A';
  const muted = dark ? '#9CA3AF' : '#6B675E';
  const accent = dark ? '#34D399' : '#0F766E';
  const dashColor = dark ? '#313744' : '#D4CFC3';
  const badgeBg = dark ? '#232834' : '#F2EFE8';

  const fmt = (val) => formatReceiptMoney(val, { currency, usdToCny });
  const totals = receipt.totals || {};
  const items = Array.isArray(receipt.items) ? receipt.items.slice(0, 12) : [];
  const punchlines =
    Array.isArray(receipt.punchlines) && receipt.punchlines.length > 0
      ? receipt.punchlines
      : buildReceiptPunchlines(receipt);
  const punchline = punchlines[Math.abs(Number(punchlineIndex) || 0) % punchlines.length];

  const cardX = 28;
  const cardW = 424;
  const totalW = cardW + cardX * 2;
  const padX = cardX + 24;
  const rightX = cardX + cardW - 24;

  const rowHeight = 40;
  const itemsBlockH = items.length === 0 ? 44 : items.length * rowHeight;
  const hasDiscount = typeof totals.cacheSavingsUsd === 'number' && totals.cacheSavingsUsd > 0;
  const cardTop = 24;
  const cardBodyH = 220 + itemsBlockH + (hasDiscount ? 48 : 0) + 215;
  const totalH = cardTop + cardBodyH + 34;

  // Build zigzag polygon for paper shape
  const toothW = 12;
  const toothH = 7;
  const teethCount = Math.floor(cardW / toothW);
  const pts = [];
  for (let i = 0; i <= teethCount; i += 1) {
    const x = cardX + Math.min(cardW, i * toothW);
    const y = i % 2 === 0 ? cardTop : cardTop + toothH;
    pts.push(`${x},${y}`);
  }
  const bottomY = cardTop + cardBodyH;
  for (let i = teethCount; i >= 0; i -= 1) {
    const x = cardX + Math.min(cardW, i * toothW);
    const y = i % 2 === 0 ? bottomY : bottomY - toothH;
    pts.push(`${x},${y}`);
  }

  let y = cardTop + 38;
  const parts = [];
  const addText = (x, yy, text, opts = {}) => {
    const size = opts.size || 12;
    const weight = opts.weight || 400;
    const fill = opts.fill || ink;
    const anchor = opts.anchor || 'start';
    parts.push(
      `<text x="${x}" y="${yy}" font-family="'SF Mono','Menlo','PingFang SC',monospace" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${escapeXml(text)}</text>`
    );
  };
  const addDash = (yy) => {
    parts.push(
      `<line x1="${padX}" y1="${yy}" x2="${rightX}" y2="${yy}" stroke="${dashColor}" stroke-width="1" stroke-dasharray="4 3"/>`
    );
  };

  addText(totalW / 2, y, 'AI TURN METER', { size: 17, weight: 700, anchor: 'middle' });
  y += 18;
  addText(totalW / 2, y, 'DAILY TOKEN RECEIPT · 算力消费小票', { size: 10.5, fill: muted, anchor: 'middle' });
  y += 16;
  addDash(y);
  y += 20;

  const toolsText =
    Array.isArray(receipt.activeTools) && receipt.activeTools.length > 0
      ? receipt.activeTools.map((t) => TOOL_LABELS[t] || t).join(' · ')
      : '无记录';
  addText(padX, y, `RECEIPT # ${receipt.receiptNo || '-'}`, { size: 10.5, fill: muted });
  addText(rightX, y, receipt.weekdayLabel || '', { size: 10.5, fill: muted, anchor: 'end' });
  y += 17;
  addText(padX, y, receipt.rangeLabel || receipt.date || '-', { size: 11, weight: 600 });
  y += 17;
  addText(padX, y, `CLIENTS: ${truncateText(toolsText, 38)}`, { size: 10.5, fill: muted });
  y += 14;
  addDash(y);
  y += 18;

  addText(padX, y, 'ITEM / BREAKDOWN', { size: 10, weight: 700, fill: muted });
  addText(rightX, y, 'AMOUNT', { size: 10, weight: 700, fill: muted, anchor: 'end' });
  y += 12;
  addDash(y);
  y += 22;

  if (items.length === 0) {
    addText(totalW / 2, y + 6, '当日暂无消费记录', { size: 12, fill: muted, anchor: 'middle' });
    y += 32;
  } else {
    items.forEach((item, idx) => {
      const label =
        hideProjects && receipt.groupBy === 'project'
          ? `Project #${idx + 1}`
          : truncateText(item.label, 26);
      const money = item.priced ? fmt(item.estimatedCostUsd) : '未定价';
      addText(padX, y, label, { size: 12, weight: 600 });
      addText(rightX, y, money, { size: 12, weight: 600, anchor: 'end' });
      const cacheTag = item.cacheRatePct !== null && item.cacheRatePct !== undefined ? `${item.cacheRatePct}%` : '--';
      const prefixTag = receipt.groupBy === 'model' && item.sublabel ? `${item.sublabel} · ` : '';
      addText(
        padX,
        y + 15,
        `${prefixTag}${item.turnCount} 轮 · 入 ${formatTokens(item.totalInputTokens)} (缓存 ${cacheTag}) · 出 ${formatTokens(item.outputTokens)}`,
        { size: 10, fill: muted }
      );
      y += rowHeight;
    });
  }

  addDash(y);
  y += 20;

  if (hasDiscount) {
    addText(padX, y, '原价 SUBTOTAL', { size: 11, fill: muted });
    addText(rightX, y, fmt(totals.grossCostUsd), { size: 11, fill: muted, anchor: 'end' });
    y += 18;
    addText(padX, y, `缓存立减 CACHE SAVED (${totals.cacheRatePct ?? 0}%)`, { size: 11, fill: accent, weight: 600 });
    addText(rightX, y, `-${fmt(totals.cacheSavingsUsd)}`, { size: 11, fill: accent, weight: 600, anchor: 'end' });
    y += 16;
    addDash(y);
    y += 24;
  }

  addText(padX, y, 'TOTAL 实付等效', { size: 13.5, weight: 700 });
  addText(rightX, y, fmt(totals.estimatedCostUsd), { size: 15, weight: 700, anchor: 'end' });
  y += 22;

  // Compact stats bar
  parts.push(`<rect x="${padX}" y="${y}" width="${cardW - 48}" height="44" rx="6" fill="${badgeBg}"/>`);
  const colW = (cardW - 48) / 3;
  const statCols = [
    ['TOKENS', formatTokens(totals.totalTokens)],
    ['TURNS', `${totals.turnCount || 0} 轮`],
    ['AVG TPS', totals.avgTps ? `${totals.avgTps} t/s` : '--'],
  ];
  statCols.forEach(([k, v], i) => {
    const cx = padX + colW * i + colW / 2;
    addText(cx, y + 16, k, { size: 9, fill: muted, anchor: 'middle' });
    addText(cx, y + 33, v, { size: 12, weight: 700, anchor: 'middle' });
  });
  y += 60;

  const metaBits = [];
  if (receipt.highlights?.firstTurnAtMs && receipt.highlights?.lastTurnAtMs) {
    metaBits.push(`活跃 ${formatClock(receipt.highlights.firstTurnAtMs)}-${formatClock(receipt.highlights.lastTurnAtMs)}`);
  }
  if (!hideProjects && receipt.highlights?.topProject?.name) {
    metaBits.push(`最耗项目 ${truncateText(receipt.highlights.topProject.name, 16)}`);
  }
  if (currency !== 'usd') {
    const rate = Number.isFinite(Number(usdToCny)) && Number(usdToCny) > 0 ? Number(usdToCny) : 7;
    metaBits.push(`汇率 1:${rate}`);
  }
  if (metaBits.length > 0) {
    addText(totalW / 2, y, metaBits.join(' · '), { size: 10, fill: muted, anchor: 'middle' });
    y += 18;
  }

  addDash(y);
  y += 20;
  addText(totalW / 2, y, truncateText(`“${punchline}”`, 34), { size: 10.5, fill: muted, anchor: 'middle' });
  y += 18;

  // Deterministic barcode
  const bars = buildBarcodeBars(receipt.barcodeSeed || receipt.receiptNo || receipt.date, 48);
  const totalBarW = bars.reduce((s, b) => s + b.width + b.gap, 0);
  let bx = (totalW - totalBarW) / 2;
  for (const b of bars) {
    parts.push(`<rect x="${bx.toFixed(1)}" y="${y}" width="${b.width}" height="28" fill="${ink}" opacity="0.88"/>`);
    bx += b.width + b.gap;
  }
  y += 42;
  addText(totalW / 2, y, `${receipt.receiptNo || 'ATM'} · LOCAL PRIVACY RECEIPT`, {
    size: 9,
    fill: muted,
    anchor: 'middle',
  });

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${totalH}" viewBox="0 0 ${totalW} ${totalH}">`,
    `<defs><filter id="shadow" x="-10%" y="-5%" width="120%" height="115%"><feDropShadow dx="0" dy="6" stdDeviation="8" flood-color="#000000" flood-opacity="${dark ? '0.45' : '0.12'}"/></filter></defs>`,
    `<rect width="${totalW}" height="${totalH}" fill="${bgOuter}"/>`,
    `<polygon points="${pts.join(' ')}" fill="${paperBg}" filter="url(#shadow)"/>`,
    ...parts,
    `</svg>`,
  ].join('\n');
}
