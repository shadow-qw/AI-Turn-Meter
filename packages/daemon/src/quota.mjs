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
    pacePct = Number((100 - expectedUsed).toFixed(1));
    const deltaPct = rem - pacePct; // positive = in reserve, negative = deficit

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

export function fetchCursorQuota() {
  const empty = { accountEmail: null, planTitle: null, quotaWindows: [], resetCreditsText: null };
  try {
    const dbPath = join(homedir(), 'Library/Application Support/Cursor/User/globalStorage/state.vscdb');
    if (!existsSync(dbPath)) return empty;
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const getVal = (key) => db.prepare('SELECT value FROM ItemTable WHERE key = ? LIMIT 1').get(key)?.value;
      const accountEmail = getVal('cursorAuth/cachedEmail') || null;
      const membership = getVal('cursorAuth/stripeMembershipType');
      let teamName = null;
      try {
        const teamObj = JSON.parse(getVal('cursorAuth/cachedTeam') || 'null');
        teamName = teamObj?.name || null;
      } catch {}

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
      const planTitle = basePlan && teamName ? `${basePlan} · ${teamName}` : basePlan || teamName;

      return { accountEmail, planTitle, quotaWindows: [], resetCreditsText: null };
    } finally {
      db.close();
    }
  } catch {
    return empty;
  }
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

export async function getAllQuotas(nowMs = Date.now(), { forceRefresh = false, allowNetwork = true } = {}) {
  if (!forceRefresh && cachedResult && nowMs - cachedAtMs < CACHE_TTL_MS) {
    return cachedResult;
  }
  if (!forceRefresh && inflightPromise) {
    return inflightPromise;
  }

  inflightPromise = (async () => {
    const [codex, antigravity] = await Promise.all([
      fetchCodexQuota(nowMs, { allowNetwork }),
      fetchAntigravityQuota(nowMs),
    ]);
    const cursor = fetchCursorQuota();
    const codebuddy = fetchCodeBuddyQuota();

    const overviewWindows = [];
    if (codex.quotaWindows.length > 0) {
      const sessionWin = codex.quotaWindows[0];
      const weeklyWin = codex.quotaWindows[1];
      const weeklyNote = weeklyWin ? `每周剩余 ${Math.round(weeklyWin.remainingPct)}%` : null;
      overviewWindows.push({
        ...sessionWin,
        id: 'overview-codex',
        title: `Codex ${sessionWin.title}`,
        subtitle: weeklyNote
          ? sessionWin.subtitle
            ? `${weeklyNote} · ${sessionWin.subtitle}`
            : weeklyNote
          : sessionWin.subtitle,
      });
    }
    if (antigravity.quotaWindows.length > 0) {
      const g5h = antigravity.quotaWindows[0];
      const gWk = antigravity.quotaWindows.find((w) => w.id === 'ag-gemini-weekly');
      const argon = antigravity.quotaWindows.find((w) => w.id === 'ag-argon-weekly');
      const parts = [];
      if (gWk) parts.push(`每周 ${Math.round(gWk.remainingPct)}%`);
      if (argon) parts.push(`Argon ${Math.round(argon.remainingPct)}%`);
      const extra = parts.length > 0 ? parts.join(' · ') : null;
      overviewWindows.push({
        ...g5h,
        id: 'overview-antigravity',
        title: 'Antigravity (Gemini)',
        subtitle: extra ? (g5h.subtitle ? `${extra} · ${g5h.subtitle}` : extra) : g5h.subtitle,
      });
    }

    const activeAccounts = [codex, antigravity, cursor, codebuddy].filter((q) => q.accountEmail).length;
    const all = {
      accountEmail: activeAccounts > 0 ? `${activeAccounts} 个已登录账号` : null,
      planTitle: '多客户端额度总览',
      quotaWindows: overviewWindows,
      resetCreditsText: codex.resetCreditsText,
    };

    const result = { all, codex, antigravity, cursor, codebuddy };
    cachedResult = result;
    cachedAtMs = Date.now();
    return result;
  })().finally(() => {
    inflightPromise = null;
  });

  return inflightPromise;
}
