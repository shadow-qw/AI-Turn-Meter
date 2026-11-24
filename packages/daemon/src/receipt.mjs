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

export function formatZhDate(dateStr) {
  if (typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateStr.trim())) {
    const [y, m, d] = dateStr.trim().split('-').map(Number);
    return `${y}年${m}月${d}日`;
  }
  return String(dateStr || '-');
}

export function formatZhDateTime(ms = Date.now()) {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
}

/**
 * Parse YYYY-MM-DD into local start-of-day timestamp.
 * @param {string | null | undefined} dateStr
 * @param {string} [scope]
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
  if (turns === 0) {
    return ['今日未开张，Token 账户稳如泰山。'];
  }
  const list = [];
  if (cost >= 30) list.push('今日算力尊享 VIP，硅谷显卡为您持续发热。');
  else if (cost >= 10) list.push('大额算力买单日，Token 气势拉满了。');
  else list.push('精打细算模范开发者，小预算撬动大产出。');
  if (cacheRate >= 85 && saved >= 0.5) {
    list.push(`缓存命中 ${cacheRate.toFixed(0)}%，靠 Prompt Cache 省下 $${saved.toFixed(2)}。`);
  }
  list.push('按 API 价格折算 · 非发票');
  return list;
}

function fmtCommaNumber(n) {
  const num = Math.round(Number(n) || 0);
  return num.toLocaleString('en-US');
}

function fmtMoneyCore(n) {
  const abs = Math.abs(n);
  if (abs === 0) return '0.00';
  if (abs < 0.01) return abs.toFixed(4);
  return abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Format currency value according to mode ('usd' | 'both' | 'cny') and exchange rate.
 * @param {number | null | undefined} usd
 * @param {{ currency?: string, usdToCny?: number }} [opts]
 */
export function formatReceiptMoney(usd, { currency = 'both', usdToCny = 7 } = {}) {
  if (typeof usd !== 'number' || !Number.isFinite(usd)) return 'N/A';
  const rate = Number.isFinite(Number(usdToCny)) && Number(usdToCny) > 0 ? Number(usdToCny) : 7;
  const sign = usd < 0 ? '-' : '';
  const usdStr = `${sign}$${fmtMoneyCore(usd)}`;
  const cnyStr = `${sign}¥${fmtMoneyCore(usd * rate)}`;
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

function receiptTitleForScope(scope) {
  if (scope === 'week') return '7 日 AI 账单';
  if (scope === 'month') return '30 日 AI 账单';
  return '每日 AI 账单';
}

/**
 * Render clean thermal-paper style ASCII receipt matching the Magpie editorial bill structure.
 * @param {object} receipt
 * @param {{ currency?: string, usdToCny?: number, hideProjects?: boolean, punchlineIndex?: number }} [opts]
 */
export function renderReceiptAscii(
  receipt,
  { currency = 'both', usdToCny = 7, hideProjects = false } = {}
) {
  const W = 48;
  const hr = '-'.repeat(W);
  const fmt = (val) => formatReceiptMoney(val, { currency, usdToCny });
  const fmtLine = (val) => {
    if (typeof val !== 'number' || !Number.isFinite(val)) return 'N/A';
    return currency === 'cny' ? formatReceiptMoney(val, { currency: 'cny', usdToCny }) : formatReceiptMoney(val, { currency: 'usd', usdToCny });
  };
  const totals = receipt.totals || {};
  const title = receiptTitleForScope(receipt.scope);
  const dateDisplay =
    receipt.scope === 'day'
      ? formatZhDate(receipt.date)
      : `${formatZhDate(receipt.startDate)} - ${formatZhDate(receipt.date)}`;
  const issuedDisplay = formatZhDateTime(receipt.generatedAtMs || Date.now());
  const rate = Number.isFinite(Number(usdToCny)) && Number(usdToCny) > 0 ? Number(usdToCny) : 7;

  const lines = [
    '================================================',
    `                  ${title}`,
    '              AI TURN METER · DAILY RECEIPT',
    '               由 AI Turn Meter 统计',
    '',
    padRow('单号', receipt.receiptNo || '-', W),
    padRow('日期', dateDisplay, W),
    padRow('开具', issuedDisplay, W),
    hr,
    '                   API 总费用',
    `              ${fmt(totals.estimatedCostUsd)}`,
    '             按 API 价格折算 · 非发票',
    hr,
    padRow('连续使用', `${receipt.streakDays || 0} 天`, W),
    padRow('请求数', fmtCommaNumber(totals.callCount || 0), W),
    padRow('对话轮次', `${fmtCommaNumber(totals.turnCount || 0)} 轮`, W),
    padRow(
      '对比日均',
      typeof receipt.vsDailyAvgRatio === 'number' && Number.isFinite(receipt.vsDailyAvgRatio)
        ? `${receipt.vsDailyAvgRatio}×`
        : '--',
      W
    ),
    hr,
  ];

  const useHierarchy =
    receipt.groupBy !== 'project' &&
    Array.isArray(receipt.agentBreakdown) &&
    receipt.agentBreakdown.length > 0;

  if (useHierarchy) {
    lines.push(padRow('AGENT / 模型', '费用', W));
    lines.push('');
    for (const ag of receipt.agentBreakdown) {
      lines.push(padRow(`■ ${ag.label}`, ag.priced ? fmtLine(ag.estimatedCostUsd) : '未定价', W));
      for (const m of ag.models.slice(0, 8)) {
        lines.push(padRow(`  • ${truncateText(m.label, 28)}`, m.priced ? fmtLine(m.estimatedCostUsd) : '未定价', W));
      }
      lines.push('');
    }
  } else {
    lines.push(padRow(receipt.groupBy === 'project' ? '项目' : 'AGENT / 模型', '费用', W));
    lines.push('');
    const items = Array.isArray(receipt.items) ? receipt.items : [];
    if (items.length === 0) {
      lines.push('  (当日暂无消费记录)');
    } else {
      items.slice(0, 14).forEach((item, idx) => {
        const name =
          hideProjects && receipt.groupBy === 'project'
            ? `PROJECT #${idx + 1}`
            : truncateText(String(item.label || '').toUpperCase(), 28);
        lines.push(padRow(`• ${name}`, item.priced ? fmtLine(item.estimatedCostUsd) : '未定价', W));
      });
    }
    lines.push('');
  }

  lines.push(hr);
  lines.push(padRow('TOKEN 总量', formatTokens(totals.totalTokens), W));
  lines.push(padRow('输入', formatTokens(totals.totalInputTokens), W));
  lines.push(padRow('输出', formatTokens(totals.outputTokens), W));
  lines.push(
    padRow(
      '缓存命中率',
      totals.cacheRatePct !== null && totals.cacheRatePct !== undefined ? `${Math.round(totals.cacheRatePct)}%` : '--',
      W
    )
  );
  if (totals.cacheSavingsUsd > 0) {
    lines.push(padRow('缓存节省', fmt(totals.cacheSavingsUsd), W));
  }
  if (currency !== 'usd') {
    lines.push(padRow('折算汇率', `1 USD = ${rate} CNY`, W));
  }
  if (totals.unpricedTurnCount > 0) {
    lines.push(`${totals.unpricedTurnCount} 次请求没有价格`);
  }
  lines.push(hr);
  lines.push('      在 macOS 上统计每个 Agent 的 AI 用量');
  lines.push('\\/'.repeat(W / 2));
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
 * Render Magpie-style editorial thermal-paper receipt SVG with misty forest backdrop,
 * flat top edge, crisp bottom serrated teeth, hero total, streak/ratio block,
 * and 2-level AGENT -> MODEL breakdown.
 * @param {object} receipt
 * @param {{ theme?: 'paper' | 'dark', currency?: string, usdToCny?: number, hideProjects?: boolean, punchlineIndex?: number }} [opts]
 */
export function renderReceiptSvg(
  receipt,
  { theme = 'paper', currency = 'both', usdToCny = 7, hideProjects = false } = {}
) {
  const dark = theme === 'dark';
  const paperBg = dark ? '#181A1F' : '#F6F4EE';
  const ink = dark ? '#F2F3F5' : '#171717';
  const muted = dark ? '#9298A3' : '#6E6C66';
  const subtle = dark ? '#6C727E' : '#96938B';
  const dashColor = dark ? '#2F343F' : '#D8D4CA';

  const rate = Number.isFinite(Number(usdToCny)) && Number(usdToCny) > 0 ? Number(usdToCny) : 7;
  const totals = receipt.totals || {};

  const fmtSingle = (usd) => {
    if (typeof usd !== 'number' || !Number.isFinite(usd)) return 'N/A';
    if (currency === 'cny') return formatReceiptMoney(usd, { currency: 'cny', usdToCny: rate });
    return formatReceiptMoney(usd, { currency: 'usd', usdToCny: rate });
  };

  const heroPrimary =
    currency === 'cny'
      ? formatReceiptMoney(totals.estimatedCostUsd, { currency: 'cny', usdToCny: rate })
      : formatReceiptMoney(totals.estimatedCostUsd, { currency: 'usd', usdToCny: rate });
  const heroSecondary =
    currency === 'both' && typeof totals.estimatedCostUsd === 'number'
      ? `≈ ${formatReceiptMoney(totals.estimatedCostUsd, { currency: 'cny', usdToCny: rate })} · 1:${rate}`
      : null;

  const useHierarchy =
    receipt.groupBy !== 'project' &&
    Array.isArray(receipt.agentBreakdown) &&
    receipt.agentBreakdown.length > 0;

  const agents = useHierarchy ? receipt.agentBreakdown : [];
  const flatItems = !useHierarchy && Array.isArray(receipt.items) ? receipt.items.slice(0, 14) : [];

  // Calculate dynamic paper height cleanly
  let ledgerHeight = 36;
  if (useHierarchy) {
    for (const ag of agents) {
      ledgerHeight += 28 + ag.models.slice(0, 8).length * 22 + 12;
    }
  } else if (flatItems.length === 0) {
    ledgerHeight += 36;
  } else {
    ledgerHeight += flatItems.length * 24 + 10;
  }

  const cardX = 56;
  const cardW = 368;
  const totalW = cardW + cardX * 2;
  const padX = cardX + 28;
  const rightX = cardX + cardW - 28;
  const cardTop = 44;

  const hasUnpriced = (totals.unpricedTurnCount || 0) > 0;
  const hasSavings = (totals.cacheSavingsUsd || 0) > 0;
  const cardBodyH =
    126 + // Header + Date/Issued
    (heroSecondary ? 128 : 112) + // Hero total
    118 + // 4 summary metrics
    ledgerHeight +
    126 + (hasSavings ? 22 : 0) + (hasUnpriced ? 20 : 0) + // Token summary
    76; // Footer

  const bottomY = cardTop + cardBodyH;
  const totalH = bottomY + 54;

  // Flat top edge, serrated bottom edge (exact reference geometry)
  const toothW = 9;
  const toothH = 6;
  const teethCount = Math.floor(cardW / toothW);
  const pts = [`${cardX},${cardTop}`, `${cardX + cardW},${cardTop}`, `${cardX + cardW},${bottomY - toothH}`];
  for (let i = teethCount; i >= 0; i -= 1) {
    const x = cardX + (cardW * i) / teethCount;
    const y = i % 2 === 0 ? bottomY : bottomY - toothH;
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }

  const parts = [];
  const mono = "'SF Mono','Menlo','PingFang SC',monospace";
  const sans = "'PingFang SC','-apple-system','Helvetica Neue',sans-serif";
  const addText = (x, yy, text, opts = {}) => {
    const size = opts.size || 12;
    const weight = opts.weight || 400;
    const fill = opts.fill || ink;
    const anchor = opts.anchor || 'start';
    const family = opts.family || mono;
    const ls = opts.spacing ? ` letter-spacing="${opts.spacing}"` : '';
    parts.push(
      `<text x="${x}" y="${yy}" font-family="${family}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"${ls}>${escapeXml(text)}</text>`
    );
  };
  const addDash = (yy) => {
    parts.push(
      `<line x1="${padX}" y1="${yy}" x2="${rightX}" y2="${yy}" stroke="${dashColor}" stroke-width="1" stroke-dasharray="3 3"/>`
    );
  };

  let y = cardTop + 40;
  // Section 1: Title & Dates
  addText(totalW / 2, y, receiptTitleForScope(receipt.scope), {
    size: 20,
    weight: 700,
    anchor: 'middle',
    family: sans,
    spacing: '2',
  });
  y += 20;
  addText(totalW / 2, y, '由 AI Turn Meter 统计', { size: 10.5, fill: muted, anchor: 'middle', family: sans });
  y += 24;

  const dateText =
    receipt.scope === 'day'
      ? formatZhDate(receipt.date)
      : `${formatZhDate(receipt.startDate)} - ${formatZhDate(receipt.date)}`;
  addText(padX, y, '日期', { size: 11, fill: muted, family: sans });
  addText(rightX, y, dateText, { size: 11, fill: ink, anchor: 'end' });
  y += 19;
  addText(padX, y, '开具', { size: 11, fill: muted, family: sans });
  addText(rightX, y, formatZhDateTime(receipt.generatedAtMs || Date.now()), { size: 11, fill: ink, anchor: 'end' });
  y += 16;
  addDash(y);

  // Section 2: Hero API Cost
  y += 24;
  addText(totalW / 2, y, 'API 总费用', { size: 11, fill: muted, anchor: 'middle', family: sans });
  y += 42;
  addText(totalW / 2, y, heroPrimary, { size: 36, weight: 800, anchor: 'middle', spacing: '-0.5' });
  if (heroSecondary) {
    y += 18;
    addText(totalW / 2, y, heroSecondary, { size: 11, fill: muted, anchor: 'middle' });
  }
  y += 18;
  addText(totalW / 2, y, '按 API 价格折算 · 非发票', { size: 10, fill: subtle, anchor: 'middle', family: sans });
  y += 18;
  addDash(y);

  // Section 3: 4 Key Stats (Streak / Requests / Turns / vs Daily Avg)
  y += 22;
  const statsRows = [
    ['连续使用', `${receipt.streakDays || 0} 天`],
    ['请求数', fmtCommaNumber(totals.callCount || 0)],
    ['对话轮次', `${fmtCommaNumber(totals.turnCount || 0)}`],
    [
      '对比日均',
      typeof receipt.vsDailyAvgRatio === 'number' && Number.isFinite(receipt.vsDailyAvgRatio)
        ? `${receipt.vsDailyAvgRatio}×`
        : '--',
    ],
  ];
  for (const [k, v] of statsRows) {
    addText(padX, y, k, { size: 11.5, fill: muted, family: sans });
    addText(rightX, y, v, { size: 11.5, fill: ink, anchor: 'end' });
    y += 22;
  }
  y += 4;
  addDash(y);

  // Section 4: 2-Level AGENT / MODEL Ledger
  y += 22;
  addText(padX, y, receipt.groupBy === 'project' ? '项目' : 'AGENT / 模型', { size: 10.5, fill: subtle, family: sans });
  addText(rightX, y, '费用', { size: 10.5, fill: subtle, anchor: 'end', family: sans });
  y += 22;

  if (useHierarchy) {
    for (const ag of agents) {
      parts.push(`<circle cx="${padX + 5}" cy="${y - 4}" r="4" fill="${ink}"/>`);
      addText(padX + 16, y, ag.label, { size: 12.5, weight: 700 });
      addText(rightX, y, ag.priced ? fmtSingle(ag.estimatedCostUsd) : '未定价', {
        size: 12.5,
        weight: 700,
        anchor: 'end',
      });
      y += 23;
      for (const m of ag.models.slice(0, 8)) {
        parts.push(`<circle cx="${padX + 20}" cy="${y - 3.5}" r="2.2" fill="${muted}"/>`);
        addText(padX + 30, y, truncateText(m.label, 24), { size: 11, fill: ink });
        addText(rightX, y, m.priced ? fmtSingle(m.estimatedCostUsd) : '未定价', {
          size: 11,
          fill: ink,
          anchor: 'end',
        });
        y += 22;
      }
      y += 10;
    }
  } else if (flatItems.length === 0) {
    addText(totalW / 2, y + 6, '当日暂无消费记录', { size: 11.5, fill: muted, anchor: 'middle', family: sans });
    y += 32;
  } else {
    flatItems.forEach((item, idx) => {
      const label =
        hideProjects && receipt.groupBy === 'project'
          ? `PROJECT #${idx + 1}`
          : truncateText(String(item.label || '').toUpperCase(), 25);
      parts.push(`<circle cx="${padX + 5}" cy="${y - 4}" r="3" fill="${ink}"/>`);
      addText(padX + 15, y, label, { size: 11.5, weight: 600 });
      addText(rightX, y, item.priced ? fmtSingle(item.estimatedCostUsd) : '未定价', {
        size: 11.5,
        weight: 600,
        anchor: 'end',
      });
      y += 24;
    });
    y += 6;
  }

  addDash(y);

  // Section 5: Bottom Token Summary
  y += 22;
  const tokenRows = [
    ['TOKEN 总量', formatTokens(totals.totalTokens)],
    ['输入', formatTokens(totals.totalInputTokens)],
    ['输出', formatTokens(totals.outputTokens)],
    [
      '缓存命中率',
      totals.cacheRatePct !== null && totals.cacheRatePct !== undefined ? `${Math.round(totals.cacheRatePct)}%` : '--',
    ],
  ];
  if (hasSavings) {
    tokenRows.push(['缓存节省', fmtSingle(totals.cacheSavingsUsd)]);
  }
  for (const [k, v] of tokenRows) {
    addText(padX, y, k, { size: 11.5, fill: muted, family: sans });
    addText(rightX, y, v, { size: 11.5, fill: ink, anchor: 'end' });
    y += 22;
  }
  if (hasUnpriced) {
    addText(padX, y + 2, `${totals.unpricedTurnCount} 次请求没有价格`, { size: 10, fill: subtle, family: sans });
    y += 18;
  }
  y += 8;
  addDash(y);

  // Section 6: Clean Centered Footer
  y += 24;
  addText(totalW / 2, y, `${receipt.receiptNo || 'AI TURN METER'} · AI Turn Meter`, {
    size: 10,
    fill: subtle,
    anchor: 'middle',
  });
  y += 17;
  addText(totalW / 2, y, '在 macOS 上统计每个 Agent 的 AI 用量', {
    size: 10,
    fill: subtle,
    anchor: 'middle',
    family: sans,
  });

  // Misty alpine lake gradient backdrop (inspired by the reference wallpaper frame)
  const bgDef = dark
    ? `<linearGradient id="mistBg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#1E2528"/>
        <stop offset="48%" stop-color="#141C1E"/>
        <stop offset="100%" stop-color="#0E1416"/>
      </linearGradient>`
    : `<linearGradient id="mistBg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#C8CEC9"/>
        <stop offset="36%" stop-color="#8B9A94"/>
        <stop offset="68%" stop-color="#4A5D57"/>
        <stop offset="100%" stop-color="#374945"/>
      </linearGradient>`;

  const mountains = dark
    ? `<path d="M0,${totalH * 0.42} L${totalW * 0.25},${totalH * 0.26} L${totalW * 0.52},${totalH * 0.38} L${totalW * 0.82},${totalH * 0.22} L${totalW},${totalH * 0.35} L${totalW},${totalH} L0,${totalH} Z" fill="#111819" opacity="0.55"/>`
    : `<path d="M0,${totalH * 0.40} L${totalW * 0.22},${totalH * 0.24} L${totalW * 0.50},${totalH * 0.36} L${totalW * 0.84},${totalH * 0.20} L${totalW},${totalH * 0.34} L${totalW},${totalH} L0,${totalH} Z" fill="#2F403A" opacity="0.38"/>
       <path d="M0,${totalH * 0.62} Q${totalW * 0.5},${totalH * 0.55} ${totalW},${totalH * 0.64} L${totalW},${totalH} L0,${totalH} Z" fill="#23332F" opacity="0.45"/>`;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${totalH}" viewBox="0 0 ${totalW} ${totalH}">`,
    `<defs>${bgDef}<filter id="shadow" x="-12%" y="-4%" width="124%" height="112%"><feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="#000000" flood-opacity="${dark ? '0.55' : '0.28'}"/></filter></defs>`,
    `<rect width="${totalW}" height="${totalH}" fill="url(#mistBg)"/>`,
    mountains,
    `<polygon points="${pts.join(' ')}" fill="${paperBg}" filter="url(#shadow)"/>`,
    ...parts,
    `</svg>`,
  ].join('\n');
}
