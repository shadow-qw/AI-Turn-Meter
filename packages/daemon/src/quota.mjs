import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import https from 'node:https';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const CACHE_TTL_MS = 45_000;
let cachedResult = null;
let cachedAtMs = 0;
let cachedCookieKey = '';
let inflightPromise = null;

function clampPct(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.min(100, Math.max(0, v));
}

export function formatDurationZh(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  if (days > 0) {
    return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`;
  }
  if (hours > 0) {
    return mins > 0 ? `${hours} 小时 ${mins} 分钟` : `${hours} 小时`;
  }
  return `${Math.max(1, mins)} 分钟`;
}

export function computeQuotaWindow({
  id,
  title,
  remainingPct = null,
  usedPct = null,
  windowSeconds = null,
  resetAtMs = null,
  nowMs = Date.now(),
  extraNote = null,
}) {
  let rem = clampPct(remainingPct);
  if (rem === null) {
    const used = clampPct(usedPct);
    if (used === null) return null;
    rem = 100 - used;
  }
  const actualUsed = 100 - rem;

  let resetText = null;
  let timeLeftSec = null;
  if (typeof resetAtMs === 'number' && Number.isFinite(resetAtMs) && resetAtMs > nowMs) {
    timeLeftSec = (resetAtMs - nowMs) / 1000;
    resetText = `${formatDurationZh(timeLeftSec)}后重置`;
  }

  let pacePct = null;
  let subtitle = null;

  if (
    typeof windowSeconds === 'number' &&
    windowSeconds > 0 &&
    timeLeftSec !== null &&
    timeLeftSec > 0 &&
    timeLeftSec <= windowSeconds
  ) {
    const elapsedSec = windowSeconds - timeLeftSec;
    const expectedUsed = Math.min(100, Math.max(0, (elapsedSec / windowSeconds) * 100));
    const expectedRem = Number((100 - expectedUsed).toFixed(1));
    pacePct = rem > 0.05 ? expectedRem : null;
    const deltaPct = rem - expectedRem; // positive = in reserve, negative = deficit

    if (elapsedSec > 60) {
      if (rem <= 0.05) {
        subtitle = '已用尽 · 等待重置';
      } else if (actualUsed <= 0.05) {
        const resRound = Math.round(deltaPct);
        subtitle = resRound > 1 ? `余量 ${resRound}% · 持续到重置` : '进度正常 · 持续到重置';
      } else {
        const ratePerSec = actualUsed / elapsedSec;
        const timeToEmptySec = rem / ratePerSec;
        const projectedRemainingUsage = actualUsed * (timeLeftSec / elapsedSec);
        const rawMult = projectedRemainingUsage > 0 ? rem / projectedRemainingUsage : 9.9;
        const clampedMult = Math.min(9.9, Math.max(0.1, rawMult));

        if (timeToEmptySec >= timeLeftSec) {
          const multText = clampedMult >= 1.05 ? ` · ${clampedMult.toFixed(1)} 倍余量` : '';
          const resRound = Math.round(deltaPct);
          subtitle =
            resRound > 0
              ? `余量 ${resRound}% · 持续到重置${multText}`
              : `进度平稳 · 持续到重置${multText}`;
        } else {
          const etaText = formatDurationZh(timeToEmptySec);
          const defRound = Math.round(-deltaPct);
          subtitle =
            defRound > 0
              ? `已多用 ${defRound}% · 预计 ${etaText}后耗尽`
              : `预计 ${etaText}后耗尽`;
        }
      }
    }
  }

  if (extraNote) {
    subtitle = subtitle ? `${extraNote} · ${subtitle}` : extraNote;
  }

  return {
    id,
    title,
    remainingPct: Number(rem.toFixed(1)),
    resetText,
    pacePct,
    subtitle,
  };
}

function decodeJwtPayload(jwt) {
  try {
    const parts = String(jwt || '').split('.');
    if (parts.length < 2) return null;
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function formatCodexPlan(planType) {
  if (!planType) return null;
  const map = {
    plus: 'Plus',
    pro: 'Pro',
    team: 'Team',
    enterprise: 'Enterprise',
    edu: 'Edu',
    free: 'Free',
    k12: 'K12',
  };
  const key = String(planType).trim().toLowerCase();
  return map[key] || String(planType);
}

function findNewestCodexRateLimits(codexHome) {
  try {
    const sessionsRoot = join(codexHome, 'sessions');
    if (!existsSync(sessionsRoot)) return null;
    let bestPath = null;
    let bestMtime = 0;

    function walk(dir, depth) {
      if (depth > 4) return;
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, ent.name);
        if (ent.isDirectory()) walk(p, depth + 1);
        else if (ent.name.endsWith('.jsonl')) {
          try {
            const st = statSync(p);
            if (st.mtimeMs > bestMtime) {
              bestMtime = st.mtimeMs;
              bestPath = p;
            }
          } catch {}
        }
      }
    }

    walk(sessionsRoot, 0);
    if (!bestPath) return null;
    const raw = readFileSync(bestPath, 'utf8');
    const lines = raw.trim().split('\n');
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 80); i -= 1) {
      try {
        const obj = JSON.parse(lines[i]);
        if (obj?.payload?.rate_limits) return obj.payload.rate_limits;
      } catch {}
    }
  } catch {}
  return null;
}

export async function fetchCodexQuota(nowMs = Date.now(), { allowNetwork = true } = {}) {
  const empty = { accountEmail: null, planTitle: null, quotaWindows: [], resetCreditsText: null };
  try {
    const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
    const authPath = join(codexHome, 'auth.json');
    if (!existsSync(authPath)) return empty;

    const auth = JSON.parse(readFileSync(authPath, 'utf8'));
    const accessToken = auth?.tokens?.access_token;
    const accountId = auth?.tokens?.account_id;
    const idClaims = decodeJwtPayload(auth?.tokens?.id_token);

    let accountEmail = idClaims?.email || null;
    let planTitle = formatCodexPlan(idClaims?.['https://api.openai.com/auth']?.chatgpt_plan_type);
    let rateLimit = null;
    let resetCreditsText = null;

    if (allowNetwork && accessToken) {
      try {
        const res = await fetch('https://chatgpt.com/backend-api/wham/usage', {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(2500),
        });
        if (res.ok) {
          const data = await res.json();
          if (data?.email) accountEmail = data.email;
          if (data?.plan_type) planTitle = formatCodexPlan(data.plan_type);
          if (data?.rate_limit) rateLimit = data.rate_limit;
          const avail = data?.rate_limit_reset_credits?.available_count;
          if (typeof avail === 'number' && avail > 0) {
            resetCreditsText = `${avail} 次可用`;
          }
        }
      } catch {}
    }

    if (!rateLimit) {
      const localRl = findNewestCodexRateLimits(codexHome);
      if (localRl) {
        if (localRl.plan_type) planTitle = formatCodexPlan(localRl.plan_type);
        const normalizeLocalWin = (w, defaultSecs) => {
          if (!w || typeof w.used_percent !== 'number') return null;
          return {
            used_percent: w.used_percent,
            limit_window_seconds: w.window_minutes ? w.window_minutes * 60 : defaultSecs,
            reset_at: w.resets_at || null,
          };
        };
        rateLimit = {
          primary_window: normalizeLocalWin(localRl.primary, 18000),
          secondary_window: normalizeLocalWin(localRl.secondary, 604800),
        };
      }
    }

    const quotaWindows = [];
    const buildCodexWin = (w, id, title, defaultSecs) => {
      if (!w || typeof w.used_percent !== 'number') return null;
      const resetAtMs =
        typeof w.reset_at === 'number' && w.reset_at > 0
          ? w.reset_at * 1000
          : typeof w.reset_after_seconds === 'number'
            ? nowMs + w.reset_after_seconds * 1000
            : null;
      return computeQuotaWindow({
        id,
        title,
        usedPct: w.used_percent,
        windowSeconds: w.limit_window_seconds || defaultSecs,
        resetAtMs,
        nowMs,
      });
    };

    const pWin = buildCodexWin(rateLimit?.primary_window, 'codex-session', '会话', 18000);
    if (pWin) quotaWindows.push(pWin);
    const sWin = buildCodexWin(rateLimit?.secondary_window, 'codex-weekly', '每周', 604800);
    if (sWin) quotaWindows.push(sWin);

    return { accountEmail, planTitle, quotaWindows, resetCreditsText };
  } catch {
    return empty;
  }
}

function postLocalLsJson(port, csrf, path) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' },
    });
    const req = https.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        rejectUnauthorized: false,
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'x-codeium-csrf-token': csrf,
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 1500,
      },
      (res) => {
        let chunks = '';
        res.on('data', (d) => {
          chunks += d;
        });
        res.on('end', () => resolve({ status: res.statusCode, body: chunks }));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.write(body);
    req.end();
  });
}

function parseIsoMs(str) {
  if (!str) return null;
  const ms = Date.parse(str);
  return Number.isFinite(ms) ? ms : null;
}

export async function fetchAntigravityQuota(nowMs = Date.now()) {
  const empty = { accountEmail: null, planTitle: null, quotaWindows: [], resetCreditsText: null };
  try {
    const { stdout: psOut } = await execFileAsync('/bin/ps', ['-ax', '-o', 'pid=,command='], {
      timeout: 2000,
    });
    const lsLines = psOut
      .split('\n')
      .filter((l) => l.includes('language_server') && l.includes('csrf_token'));
    if (lsLines.length === 0) return empty;

    for (const line of lsLines.slice(0, 3)) {
      const mPid = line.trim().match(/^(\d+)\s+/);
      const mCsrf = line.match(/--csrf_token[=\s]+([^\s]+)/);
      if (!mPid || !mCsrf) continue;
      const pid = mPid[1];
      const csrf = mCsrf[1];

      let lsofOut = '';
      try {
        ({ stdout: lsofOut } = await execFileAsync(
          '/usr/sbin/lsof',
          ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', pid],
          { timeout: 2000 }
        ));
      } catch {
        continue;
      }

      const ports = [...new Set([...lsofOut.matchAll(/:(\d+)\s+\(LISTEN\)/g)].map((m) => Number(m[1])))];
      for (const port of ports) {
        try {
          const uRes = await postLocalLsJson(
            port,
            csrf,
            '/exa.language_server_pb.LanguageServerService/GetUserStatus'
          );
          if (uRes.status !== 200) continue;
          const uJson = JSON.parse(uRes.body);
          const us = uJson?.userStatus;
          if (!us) continue;

          const accountEmail = us.email || null;
          const planTitle = us.userTier?.name || us.planStatus?.planInfo?.planName || null;

          let quotaWindows = [];
          try {
            const qRes = await postLocalLsJson(
              port,
              csrf,
              '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary'
            );
            if (qRes.status === 200) {
              const qJson = JSON.parse(qRes.body);
              const groups = qJson?.response?.groups || qJson?.groups || [];
              const bucketMap = new Map();
              for (const g of groups) {
                for (const b of g.buckets || []) {
                  if (!b.disabled && typeof b.remainingFraction === 'number') {
                    bucketMap.set(b.bucketId || b.id, b);
                  }
                }
              }

              const addBucket = (bucketId, id, title, defaultSecs) => {
                const b = bucketMap.get(bucketId);
                if (!b) return null;
                const wSec = b.window === 'weekly' ? 604800 : b.window === '5h' ? 18000 : defaultSecs;
                return computeQuotaWindow({
                  id,
                  title,
                  remainingPct: b.remainingFraction * 100,
                  windowSeconds: wSec,
                  resetAtMs: parseIsoMs(b.resetTime),
                  nowMs,
                });
              };

              const g5h = addBucket('gemini-5h', 'ag-gemini-5h', 'Gemini 会话', 18000);
              if (g5h) quotaWindows.push(g5h);
              const gWk = addBucket('gemini-weekly', 'ag-gemini-weekly', 'Gemini 每周', 604800);
              if (gWk) quotaWindows.push(gWk);

              const p5h = bucketMap.get('3p-5h');
              const pWk = bucketMap.get('3p-weekly');
              if (p5h && pWk) {
                const chosen = p5h.remainingFraction <= pWk.remainingFraction ? p5h : pWk;
                const wSec = chosen.window === '5h' ? 18000 : 604800;
                const win = computeQuotaWindow({
                  id: 'ag-claude-gpt',
                  title: 'Claude / GPT',
                  remainingPct: chosen.remainingFraction * 100,
                  windowSeconds: wSec,
                  resetAtMs: parseIsoMs(chosen.resetTime),
                  nowMs,
                });
                if (win) quotaWindows.push(win);
              } else {
                const cWin =
                  addBucket('3p-5h', 'ag-claude-gpt', 'Claude / GPT', 18000) ||
                  addBucket('3p-weekly', 'ag-claude-gpt', 'Claude / GPT', 604800);
                if (cWin) quotaWindows.push(cWin);
              }

              const argon = addBucket('gemini-argon-wtu-weekly', 'ag-argon-weekly', 'Gemini 4 Argon', 604800);
              if (argon) quotaWindows.push(argon);
            }
          } catch {}

          // Fallback to GetUserStatus model configs if summary endpoint had no buckets
          if (quotaWindows.length === 0) {
            const configs = us.cascadeModelConfigData?.clientModelConfigs || [];
            let bestGemini = null;
            let bestClaude = null;
            for (const c of configs) {
              const frac = c?.quotaInfo?.remainingFraction;
              if (typeof frac !== 'number') continue;
              const label = String(c.label || '').toLowerCase();
              const item = { frac, resetAtMs: parseIsoMs(c?.quotaInfo?.resetTime) };
              if (label.includes('claude') || label.includes('gpt')) {
                if (!bestClaude || item.frac < bestClaude.frac) bestClaude = item;
              } else if (label.includes('gemini')) {
                if (!bestGemini || item.frac < bestGemini.frac) bestGemini = item;
              }
            }
            if (bestGemini) {
              quotaWindows.push(
                computeQuotaWindow({
                  id: 'ag-gemini',
                  title: 'Gemini Models',
                  remainingPct: bestGemini.frac * 100,
                  windowSeconds: 18000,
                  resetAtMs: bestGemini.resetAtMs,
                  nowMs,
                })
              );
            }
            if (bestClaude) {
              quotaWindows.push(
                computeQuotaWindow({
                  id: 'ag-claude-gpt',
                  title: 'Claude / GPT',
                  remainingPct: bestClaude.frac * 100,
                  windowSeconds: 18000,
                  resetAtMs: bestClaude.resetAtMs,
                  nowMs,
                })
              );
            }
          }

          return { accountEmail, planTitle, quotaWindows, resetCreditsText: null };
        } catch {}
      }
    }
  } catch {}
  return empty;
}

function normalizeCursorCookieInput(raw) {
  if (typeof raw !== 'string') return null;
  let text = raw.trim();
  if (!text) return null;
  if (text.toLowerCase().startsWith('cookie:')) {
    text = text.slice(7).trim();
  }
  if (!text) return null;
  if (text.includes('WorkosCursorSessionToken=')) return text;
  if (text.includes('=')) return text;
  return `WorkosCursorSessionToken=${encodeURIComponent(text)}`;
}

function readCodexBarCursorSessionCookie() {
  try {
    const p = join(homedir(), 'Library/Application Support/CodexBar/cursor-session.json');
    if (!existsSync(p)) return null;
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    if (typeof raw?.cookieHeader === 'string' && raw.cookieHeader.trim()) {
      return raw.cookieHeader.trim();
    }
    if (Array.isArray(raw?.cookies)) {
      const pairs = raw.cookies
        .filter((c) => c && c.name && c.value)
        .map((c) => `${c.name}=${c.value}`);
      if (pairs.length > 0) return pairs.join('; ');
    }
    if (Array.isArray(raw)) {
      const pairs = raw
        .filter((c) => c && c.name && c.value)
        .map((c) => `${c.name}=${c.value}`);
      if (pairs.length > 0) return pairs.join('; ');
    }
  } catch {}
  return null;
}

function resolveCursorJwtCookie(rawToken) {
  if (typeof rawToken !== 'string') return null;
  const trimmed = rawToken.trim();
  if (!trimmed || trimmed.startsWith('cursor-safe-storage:')) return null;
  const payload = decodeJwtPayload(trimmed);
  if (!payload || typeof payload.sub !== 'string') return null;
  if (typeof payload.exp === 'number' && payload.exp * 1000 <= Date.now() + 60_000) {
    return null;
  }
  const userId = payload.sub.split('|').filter(Boolean).pop();
  if (!userId) return null;
  return {
    userId,
    cookieHeader: `WorkosCursorSessionToken=${userId}%3A%3A${trimmed}`,
  };
}

export async function cursorApiJson(
  url,
  cookieHeader,
  { method = 'GET', body = null, timeoutMs = 8000 } = {}
) {
  try {
    const headers = {
      Cookie: cookieHeader,
      Accept: 'application/json',
      Origin: 'https://cursor.com',
      Referer: 'https://cursor.com/dashboard?tab=usage',
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
    };
    if (body !== null) {
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(url, {
      method,
      headers,
      body: body !== null ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export function resolveCursorCookieHeader(cursorCookie = null) {
  let cookieHeader = normalizeCursorCookieInput(cursorCookie);
  if (cookieHeader) return cookieHeader;
  try {
    const dbPath = join(homedir(), 'Library/Application Support/Cursor/User/globalStorage/state.vscdb');
    if (existsSync(dbPath)) {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const token = db.prepare('SELECT value FROM ItemTable WHERE key = ? LIMIT 1').get('cursorAuth/accessToken')?.value;
        const jwtRes = resolveCursorJwtCookie(token);
        if (jwtRes) return jwtRes.cookieHeader;
      } finally {
        db.close();
      }
    }
  } catch {}
  return readCodexBarCursorSessionCookie();
}

export function parseCursorQuotaSummary(
  summary,
  {
    nowMs = Date.now(),
    accountEmail = null,
    planTitle = null,
    teamBudget = null,
    reqUsage = null,
  } = {}
) {
  if (!summary || typeof summary !== 'object') {
    return { accountEmail, planTitle, quotaWindows: [], resetCreditsText: null };
  }

  const resolvedEmail = accountEmail || summary.email || null;
  const startMs = summary.billingCycleStart ? Date.parse(summary.billingCycleStart) : NaN;
  const endMs = summary.billingCycleEnd ? Date.parse(summary.billingCycleEnd) : NaN;
  const cycleSecs =
    Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
      ? (endMs - startMs) / 1000
      : 30 * 86400;
  const resetAtMs = Number.isFinite(endMs) ? endMs : null;

  const plan = summary.individualUsage?.plan;
  const overall = summary.individualUsage?.overall;
  const pooled = summary.teamUsage?.pooled;

  const hasAutoPct = typeof plan?.autoPercentUsed === 'number' && Number.isFinite(plan.autoPercentUsed);
  const hasApiPct = typeof plan?.apiPercentUsed === 'number' && Number.isFinite(plan.apiPercentUsed);
  const hasTotalPct = typeof plan?.totalPercentUsed === 'number' && Number.isFinite(plan.totalPercentUsed);
  const hasPlanCents = typeof plan?.limit === 'number' && plan.limit > 0 && typeof plan?.used === 'number';

  const quotaWindows = [];

  if (hasAutoPct || hasApiPct) {
    // Cursor's dual-pool plans track Auto/Composer ("Cursor Models") and third-party API ("Other Models")
    // separately; surfacing both pools matches Cursor's dashboard and avoids mixing the $20 API pool cap into total%.
    if (hasAutoPct) {
      const autoWin = computeQuotaWindow({
        id: 'cursor-auto',
        title: 'Cursor 模型',
        usedPct: plan.autoPercentUsed,
        windowSeconds: cycleSecs,
        resetAtMs,
        nowMs,
      });
      if (autoWin) quotaWindows.push(autoWin);
    }
    if (hasApiPct) {
      const apiWin = computeQuotaWindow({
        id: 'cursor-api',
        title: '其他模型',
        usedPct: plan.apiPercentUsed,
        windowSeconds: cycleSecs,
        resetAtMs,
        nowMs,
      });
      if (apiWin) quotaWindows.push(apiWin);
    }
  } else {
    let usedUSD = null;
    let limitUSD = null;
    let usedPct = null;
    let includeBudgetNote = false;

    if (hasTotalPct || hasPlanCents) {
      if (hasTotalPct) {
        usedPct = plan.totalPercentUsed;
      } else {
        usedPct = (plan.used / plan.limit) * 100;
      }
      if (hasPlanCents) {
        usedUSD = plan.used / 100;
        limitUSD = plan.limit / 100;
        const pctFromCents = (usedUSD / limitUSD) * 100;
        // Only attach "$used / $limit" when consistent with usedPct so API caps never contradict percentage bars.
        includeBudgetNote = !hasTotalPct || Math.abs(pctFromCents - usedPct) < 5;
      }
    } else if (
      teamBudget &&
      Number.isFinite(teamBudget.limitUSD) &&
      teamBudget.limitUSD > 0 &&
      Number.isFinite(teamBudget.usedUSD) &&
      teamBudget.usedUSD >= 0
    ) {
      usedUSD = teamBudget.usedUSD;
      limitUSD = teamBudget.limitUSD;
      usedPct = (usedUSD / limitUSD) * 100;
      includeBudgetNote = true;
    } else if (overall && typeof overall.limit === 'number' && overall.limit > 0 && typeof overall.used === 'number') {
      usedUSD = overall.used / 100;
      limitUSD = overall.limit / 100;
      usedPct = (overall.used / overall.limit) * 100;
      includeBudgetNote = true;
    } else if (pooled && typeof pooled.limit === 'number' && pooled.limit > 0 && typeof pooled.used === 'number') {
      usedUSD = pooled.used / 100;
      limitUSD = pooled.limit / 100;
      usedPct = (pooled.used / pooled.limit) * 100;
      includeBudgetNote = true;
    }

    if (usedPct !== null) {
      const budgetNote =
        includeBudgetNote && usedUSD !== null && limitUSD !== null && limitUSD > 0
          ? `已用 $${usedUSD.toFixed(2)} / $${Math.round(limitUSD)}`
          : null;
      const win = computeQuotaWindow({
        id: 'cursor-plan',
        title: '套餐额度',
        usedPct,
        windowSeconds: cycleSecs,
        resetAtMs,
        nowMs,
        extraNote: budgetNote,
      });
      if (win) quotaWindows.push(win);
    } else if (reqUsage) {
      const maxReq = Number(reqUsage?.['gpt-4']?.maxRequestUsage);
      const usedReq = Number(reqUsage?.['gpt-4']?.numRequestsTotal ?? reqUsage?.['gpt-4']?.numRequests);
      if (Number.isFinite(maxReq) && maxReq > 0 && Number.isFinite(usedReq) && usedReq >= 0) {
        const win = computeQuotaWindow({
          id: 'cursor-requests',
          title: '快速请求',
          usedPct: (usedReq / maxReq) * 100,
          windowSeconds: cycleSecs,
          resetAtMs,
          nowMs,
          extraNote: `${Math.round(usedReq)} / ${Math.round(maxReq)} 次`,
        });
        if (win) quotaWindows.push(win);
      }
    }
  }

  const indOnDemand = summary.individualUsage?.onDemand;
  const teamOnDemand = summary.teamUsage?.onDemand;
  const onDemand =
    indOnDemand && (typeof indOnDemand.used === 'number' || typeof indOnDemand.limit === 'number')
      ? indOnDemand
      : teamOnDemand;
  const onDemandUsed = onDemand?.used;
  const onDemandLimit = onDemand?.limit;
  let resetCreditsText = null;
  if (
    typeof onDemandUsed === 'number' &&
    onDemandUsed >= 0 &&
    onDemand?.enabled !== false &&
    (onDemandUsed > 0 || (typeof onDemandLimit === 'number' && onDemandLimit > 0))
  ) {
    const usdStr = `$${(onDemandUsed / 100).toFixed(2)}`;
    resetCreditsText =
      typeof onDemandLimit === 'number' && onDemandLimit > 0
        ? `${usdStr} / $${(onDemandLimit / 100).toFixed(2)}`
        : `${usdStr} / 无上限`;
  }

  return {
    accountEmail: resolvedEmail,
    planTitle: planTitle || (summary.membershipType ? String(summary.membershipType) : null),
    quotaWindows,
    resetCreditsText,
  };
}

export async function fetchCursorQuota(nowMs = Date.now(), { allowNetwork = true, cursorCookie = null } = {}) {
  const empty = { accountEmail: null, planTitle: null, quotaWindows: [], resetCreditsText: null };
  let accountEmail = null;
  let planTitle = null;
  let teamId = null;
  let cookieHeader = normalizeCursorCookieInput(cursorCookie);
  let userId = null;

  try {
    const dbPath = join(homedir(), 'Library/Application Support/Cursor/User/globalStorage/state.vscdb');
    if (existsSync(dbPath)) {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const getVal = (key) => db.prepare('SELECT value FROM ItemTable WHERE key = ? LIMIT 1').get(key)?.value;
        accountEmail = getVal('cursorAuth/cachedEmail') || null;
        const membership = getVal('cursorAuth/stripeMembershipType');
        let teamName = null;
        try {
          const teamObj = JSON.parse(getVal('cursorAuth/cachedTeam') || 'null');
          teamName = teamObj?.name || null;
          if (typeof teamObj?.teamId === 'number') teamId = teamObj.teamId;
        } catch {}

        if (!cookieHeader) {
          const jwtRes = resolveCursorJwtCookie(getVal('cursorAuth/accessToken'));
          if (jwtRes) {
            cookieHeader = jwtRes.cookieHeader;
            userId = jwtRes.userId;
          }
        }
        if (!userId) {
          const authId = getVal('cursorAuth/stripeMembershipAuthId');
          if (typeof authId === 'string' && authId.includes('|')) {
            userId = authId.split('|').filter(Boolean).pop() || null;
          }
        }

        const planNames = {
          enterprise: 'Enterprise',
          pro: 'Pro',
          pro_plus: 'Pro+',
          ultra: 'Ultra',
          team: 'Team',
          free: 'Free',
          free_trial: 'Pro Trial',
          hobby: 'Hobby',
        };
        const basePlan = membership ? planNames[String(membership).toLowerCase()] || String(membership) : null;
        planTitle = basePlan && teamName ? `${basePlan} · ${teamName}` : basePlan || teamName;
      } finally {
        db.close();
      }
    }
  } catch {}

  if (!cookieHeader) {
    cookieHeader = readCodexBarCursorSessionCookie();
  }
  if (!userId && cookieHeader) {
    try {
      const m = decodeURIComponent(cookieHeader).match(/WorkosCursorSessionToken=([^;\s]+?)::/);
      if (m?.[1]) userId = m[1];
    } catch {}
  }
  if (!cookieHeader || !allowNetwork) {
    return { accountEmail, planTitle, quotaWindows: [], resetCreditsText: null };
  }

  const summary = await cursorApiJson('https://cursor.com/api/usage-summary', cookieHeader);
  if (!summary) {
    return { accountEmail, planTitle, quotaWindows: [], resetCreditsText: null };
  }

  if (!accountEmail && summary.email) accountEmail = summary.email;
  const plan = summary.individualUsage?.plan;
  const hasPlanData = Boolean(
    plan &&
      (typeof plan.autoPercentUsed === 'number' ||
        typeof plan.apiPercentUsed === 'number' ||
        typeof plan.totalPercentUsed === 'number' ||
        (typeof plan.limit === 'number' && plan.limit > 0))
  );

  let teamBudget = null;
  if (
    !hasPlanData &&
    (summary.membershipType === 'enterprise' ||
      summary.membershipType === 'team' ||
      summary.isTeam ||
      summary.limitType === 'team') &&
    accountEmail
  ) {
    const teamsRes = await cursorApiJson('https://cursor.com/api/dashboard/teams', cookieHeader, {
      method: 'POST',
      body: {},
    });
    const teams = Array.isArray(teamsRes?.teams) ? teamsRes.teams : [];
    const targetTeamId =
      teams.find((t) => t.id === teamId)?.id ??
      (teams.length === 1 ? teams[0]?.id : teamId);
    if (typeof targetTeamId === 'number') {
      const spendRes = await cursorApiJson('https://cursor.com/api/dashboard/get-team-spend', cookieHeader, {
        method: 'POST',
        body: {
          teamId: targetTeamId,
          page: 1,
          pageSize: 50,
          ...(accountEmail ? { search: accountEmail } : {}),
        },
      });
      const members = Array.isArray(spendRes?.teamMemberSpend) ? spendRes.teamMemberSpend : [];
      const me = members.find(
        (m) =>
          (m.email && accountEmail && m.email.toLowerCase() === accountEmail.toLowerCase()) ||
          (userId && m.userId === userId)
      );
      if (me) {
        const effLimit = Number(me.effectivePerUserLimitDollars ?? me.monthlyLimitDollars);
        const spendCents = Number(me.overallSpendCents);
        if (Number.isFinite(effLimit) && effLimit > 0 && Number.isFinite(spendCents) && spendCents >= 0) {
          teamBudget = { usedUSD: spendCents / 100, limitUSD: effLimit };
        }
      }
    }
  }

  let reqUsage = null;
  const hasAnyFallback = Boolean(
    hasPlanData ||
      teamBudget ||
      (summary.individualUsage?.overall && summary.individualUsage.overall.limit > 0) ||
      (summary.teamUsage?.pooled && summary.teamUsage.pooled.limit > 0)
  );
  if (!hasAnyFallback && userId) {
    reqUsage = await cursorApiJson(
      `https://cursor.com/api/usage?user=${encodeURIComponent(userId)}`,
      cookieHeader
    );
  }

  return parseCursorQuotaSummary(summary, {
    nowMs,
    accountEmail,
    planTitle,
    teamBudget,
    reqUsage,
  });
}

export function fetchCodeBuddyQuota() {
  const empty = { accountEmail: null, planTitle: null, quotaWindows: [], resetCreditsText: null };
  try {
    const dbPath = join(homedir(), 'Library/Application Support/CodeBuddy CN/User/globalStorage/state.vscdb');
    if (!existsSync(dbPath)) return empty;
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const getVal = (key) => db.prepare('SELECT value FROM ItemTable WHERE key = ? LIMIT 1').get(key)?.value;
      let accountEmail = null;
      try {
        const replay = JSON.parse(getVal('codebuddy-replay.codebuddy-replay') || 'null');
        accountEmail = replay?.['codebuddyRecorder.weWorkId'] || null;
      } catch {}

      let planTitle = null;
      try {
        const copilot = JSON.parse(getVal('Tencent-Cloud.coding-copilot') || 'null');
        const flag = copilot?.cloud_product_config_cache?.[0]?.data?._configFlag || '';
        if (flag.includes('众测') && flag.includes('IOA')) {
          planTitle = 'iOA 众测';
        } else if (flag.includes('IOA')) {
          planTitle = '企业 iOA';
        } else if (copilot?.enterpriseId) {
          planTitle = 'Enterprise';
        }
      } catch {}

      return { accountEmail, planTitle, quotaWindows: [], resetCreditsText: null };
    } finally {
      db.close();
    }
  } catch {
    return empty;
  }
}

function assembleAllQuotas(raw, enabledTools = null) {
  const isEnabled = (k) => !enabledTools || enabledTools[k] !== false;
  const { codex, antigravity, cursor, codebuddy } = raw;

  const overviewWindows = [];
  if (isEnabled('codex') && codex.quotaWindows.length > 0) {
    const c5h = codex.quotaWindows[0];
    const cWk = codex.quotaWindows[1];
    overviewWindows.push({
      ...c5h,
      id: 'overview-codex',
      title: `Codex ${c5h.title}`,
      subtitle: c5h.subtitle
        ? `${c5h.subtitle}${cWk ? ` · 每周 ${Math.round(cWk.remainingPct)}%` : ''}`
        : cWk
          ? `每周剩余 ${Math.round(cWk.remainingPct)}%`
          : null,
    });
  }
  if (isEnabled('cursor') && cursor.quotaWindows.length > 0) {
    const curWin = cursor.quotaWindows[0];
    const curSecond = cursor.quotaWindows[1];
    const curSub = [
      curWin.subtitle,
      curSecond ? `${curSecond.title} ${Math.round(curSecond.remainingPct)}%` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    overviewWindows.push({
      ...curWin,
      id: 'overview-cursor',
      title: curSecond ? 'Cursor 模型' : 'Cursor',
      subtitle: curSub || null,
    });
  }
  if (isEnabled('antigravity') && antigravity.quotaWindows.length > 0) {
    const g5h = antigravity.quotaWindows[0];
    const gWk = antigravity.quotaWindows.find((w) => w.id === 'ag-gemini-weekly');
    const agSub = [g5h.subtitle, gWk ? `每周 ${Math.round(gWk.remainingPct)}%` : null]
      .filter(Boolean)
      .join(' · ');
    overviewWindows.push({
      ...g5h,
      id: 'overview-antigravity',
      title: 'Antigravity',
      subtitle: agSub || null,
    });
  }

  const activeAccounts = [
    isEnabled('codex') ? codex : null,
    isEnabled('antigravity') ? antigravity : null,
    isEnabled('cursor') ? cursor : null,
    isEnabled('codebuddy') ? codebuddy : null,
  ].filter((q) => q && q.accountEmail).length;

  const all = {
    accountEmail: activeAccounts > 0 ? `${activeAccounts} 个已登录账号` : null,
    planTitle: '多客户端额度总览',
    quotaWindows: overviewWindows,
    resetCreditsText: isEnabled('codex') ? codex.resetCreditsText : null,
  };

  return { all, codex, antigravity, cursor, codebuddy };
}

export async function getAllQuotas(
  nowMs = Date.now(),
  { forceRefresh = false, allowNetwork = true, cursorCookie = null, enabledTools = null } = {}
) {
  const cookieKey = cursorCookie ? String(cursorCookie).trim() : '';
  if (!forceRefresh && cachedResult && cachedCookieKey === cookieKey && nowMs - cachedAtMs < CACHE_TTL_MS) {
    return assembleAllQuotas(cachedResult, enabledTools);
  }
  if (!forceRefresh && inflightPromise && cachedCookieKey === cookieKey) {
    const raw = await inflightPromise;
    return assembleAllQuotas(raw, enabledTools);
  }
  cachedCookieKey = cookieKey;

  inflightPromise = (async () => {
    const [codex, antigravity, cursor] = await Promise.all([
      fetchCodexQuota(nowMs, { allowNetwork }),
      fetchAntigravityQuota(nowMs),
      fetchCursorQuota(nowMs, { allowNetwork, cursorCookie }),
    ]);
    const codebuddy = fetchCodeBuddyQuota();

    const raw = { codex, antigravity, cursor, codebuddy };
    cachedResult = raw;
    cachedAtMs = Date.now();
    return raw;
  })().finally(() => {
    inflightPromise = null;
  });

  const raw = await inflightPromise;
  return assembleAllQuotas(raw, enabledTools);
}
