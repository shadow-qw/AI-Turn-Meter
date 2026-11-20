import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ExternalProviderRegistry,
  isExternalProviderKey,
  sanitizePluginFileName,
} from '../packages/daemon/src/external-providers.mjs';
import { createMeterServer } from '../packages/daemon/src/server.mjs';

test('ExternalProviderRegistry loads, normalizes, hot-reloads, isolates errors, and falls back to stale cache', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'atm-ext-prov-'));
  const providersDir = join(tmpDir, 'providers');
  mkdirSync(providersDir, { recursive: true });

  try {
    // Skipped files
    writeFileSync(join(providersDir, '.hidden.mjs'), 'export default { id: "hidden", fetch: () => ({}) };');
    writeFileSync(join(providersDir, 'demo.example.mjs'), 'export default { id: "demo", fetch: () => ({}) };');
    writeFileSync(join(providersDir, 'off.disabled.mjs'), 'export default { id: "off", fetch: () => ({}) };');

    // Valid CNY billing plugin
    const gatewayPath = join(providersDir, 'custom-gateway.mjs');
    writeFileSync(
      gatewayPath,
      `
      export default {
        id: 'custom-gateway',
        name: 'Custom Token Gateway',
        shortName: 'Gateway',
        icon: 'building.2',
        accentColor: '#1677FF',
        currency: 'CNY',
        detailUrl: 'https://gateway.example.com/dashboard',
        cacheTtlMs: 60000,
        async fetch({ nowMs }) {
          return {
            account: 'alice',
            planTitle: 'Platform Team',
            footnote: '实时账单 · 人民币结算',
            quotaWindows: [
              {
                id: 'monthly',
                title: '本月额度',
                used: 350,
                limit: 1000,
                windowSeconds: 30 * 86400,
                resetAtMs: nowMs + 10 * 86400 * 1000,
              },
              {
                id: 'daily',
                title: '今日限额',
                usedPct: 40,
                used: 40,
                limit: 100,
                resetText: '今日 00:00 起',
              },
            ],
            metrics: {
              todayCost: 40,
              periodLabel: '本月',
              periodCost: 350,
              periodLimit: 1000,
            },
            daily: [
              { date: '2026-11-18', cost: 25.5 },
              { date: '2026-11-19', cost: 40.0 },
            ],
            breakdowns: [
              {
                id: 'products',
                title: '产品明细',
                items: [
                  { id: 'ide', name: 'IDE Assistant', cost: 220, limit: 500 },
                  { id: 'cli', name: 'CLI Agent', cost: 130, sharePct: 37.1 },
                ],
              },
              {
                id: 'models',
                title: '模型明细',
                items: [
                  { id: 'm1', name: 'flagship-pro', cost: 260, sharePct: 74.3 },
                ],
              },
            ],
          };
        },
      };
      `
    );

    // Malicious / invalid plugin (reserved id + unsafe URL + syntax/load failure)
    writeFileSync(
      join(providersDir, 'reserved.mjs'),
      `export default { id: 'codex', name: 'Hijack', fetch: () => ({}) };`
    );
    writeFileSync(
      join(providersDir, 'bad-url.mjs'),
      `export default { id: 'bad-url', name: 'Bad URL', detailUrl: 'javascript:alert(1)', fetch: () => ({ quotaWindows: [{ id: 'w', title: 'W', remainingPct: 80 }] }) };`
    );

    assert.equal(isExternalProviderKey('ext:custom-gateway'), true);
    assert.equal(isExternalProviderKey('codex'), false);
    assert.equal(isExternalProviderKey('ext:../evil'), false);

    const reg = new ExternalProviderRegistry({ providersDir });
    const nowMs = Date.parse('2026-11-20T12:00:00+08:00');
    const out1 = await reg.fetchAll({ nowMs });

    assert.equal(out1.providers.length, 3);
    const gwMeta = out1.providers.find((p) => p.key === 'ext:custom-gateway');
    assert.ok(gwMeta);
    assert.equal(gwMeta.ok, true);
    assert.equal(gwMeta.currencySymbol, '¥');
    assert.equal(gwMeta.detailUrl, 'https://gateway.example.com/dashboard');

    const badUrlMeta = out1.providers.find((p) => p.key === 'ext:bad-url');
    assert.ok(badUrlMeta);
    assert.equal(badUrlMeta.detailUrl, null);

    const reservedMeta = out1.providers.find((p) => p.fileName === 'reserved.mjs');
    assert.ok(reservedMeta);
    assert.equal(reservedMeta.ok, false);
    assert.ok(reservedMeta.error);

    const card = out1.cards['ext:custom-gateway'];
    assert.equal(card.isExternal, true);
    assert.equal(card.currencyCode, 'CNY');
    assert.equal(card.currencySymbol, '¥');
    assert.equal(card.accountEmail, 'alice');
    assert.equal(card.planTitle, 'Platform Team');
    assert.equal(card.topModel, 'flagship-pro');
    assert.equal(card.quotaWindows.length, 2);
    assert.equal(card.quotaWindows[0].remainingPct, 65);
    assert.ok(card.quotaWindows[0].subtitle.includes('¥350.00'));
    assert.equal(card.quotaWindows[1].remainingPct, 60);
    assert.equal(card.quotaWindows[1].resetText, '今日 00:00 起');
    assert.equal(card.billingSummary.todayCost, 40);
    assert.equal(card.billingSummary.periodCost, 350);
    assert.equal(card.billingSummary.periodLimit, 1000);
    assert.equal(card.billingSummary.periodRemaining, 650);
    assert.equal(card.daily30.length, 2);
    assert.equal(card.daily30[0].label, '11月18日');
    assert.equal(card.breakdowns.length, 2);
    assert.equal(card.breakdowns[0].items[0].usagePct, 44);
    assert.equal(out1.overviewWindows.some((w) => w.id === 'overview-ext:custom-gateway'), true);

    // Simulate plugin throwing after a good snapshot -> stale grace fallback keeps last good data
    writeFileSync(
      gatewayPath,
      `
      export default {
        id: 'custom-gateway',
        name: 'Custom Token Gateway v2',
        shortName: 'Gateway',
        currency: 'CNY',
        async fetch() {
          return {
            account: 'alice',
            metrics: { todayCost: 55, periodCost: 410, periodLimit: 1000 },
            quotaWindows: [{ id: 'monthly', title: '本月额度', used: 410, limit: 1000 }],
          };
        },
      };
      `
    );
    const bump = new Date(Date.now() + 5000);
    utimesSync(gatewayPath, bump, bump);

    const out2 = await reg.fetchAll({ nowMs: nowMs + 1000 });
    assert.equal(out2.cards['ext:custom-gateway'].providerName, 'Custom Token Gateway v2');
    assert.equal(out2.cards['ext:custom-gateway'].billingSummary.todayCost, 55);
    assert.equal(out2.cards['ext:custom-gateway'].quotaWindows[0].remainingPct, 59);

    // Timeout isolation test
    writeFileSync(
      join(providersDir, 'slow.mjs'),
      `
      export default {
        id: 'slow',
        name: 'Slow Plugin',
        timeoutMs: 1000,
        async fetch() {
          await new Promise((r) => setTimeout(r, 3000));
          return {};
        },
      };
      `
    );
    const out3 = await reg.fetchAll({ nowMs: nowMs + 2000 });
    const slowMeta = out3.providers.find((p) => p.key === 'ext:slow');
    assert.equal(slowMeta.ok, false);
    assert.ok(slowMeta.error.includes('超时'));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Daemon HTTP integrates /v1/providers, /v1/providers/reload auth, /v1/usage cards, and ext:* config toggles', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'atm-ext-srv-'));
  const providersDir = join(tmpDir, 'providers');
  mkdirSync(providersDir, { recursive: true });
  writeFileSync(
    join(providersDir, 'team-billing.mjs'),
    `
    export default {
      id: 'team-billing',
      name: 'Team Billing',
      shortName: 'Team',
      currency: 'CNY',
      async fetch() {
        return {
          account: 'bob',
          planTitle: 'Core Infra',
          quotaWindows: [{ id: 'm', title: '月额度', used: 200, limit: 800 }],
          metrics: { todayCost: 12.5, periodLabel: '本月', periodCost: 200, periodLimit: 800 },
        };
      },
    };
    `
  );

  const meter = createMeterServer({
    port: 0,
    dbPath: join(tmpDir, 'meter.db'),
    stateDir: tmpDir,
    providersDir,
    enableWatchers: false,
    enableCdp: false,
    enableAntigravityRpc: false,
    enableQuotaProbe: false,
    enableExternalProviders: true,
  });

  try {
    const addr = await meter.start();
    const base = `http://127.0.0.1:${addr.port}`;

    // /v1/providers/reload requires auth token
    const unauthReload = await fetch(`${base}/v1/providers/reload`, { method: 'POST', body: '{}' });
    assert.equal(unauthReload.status, 401);

    const okReload = await fetch(`${base}/v1/providers/reload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-atm-token': meter.authToken },
      body: '{}',
    });
    assert.equal(okReload.status, 200);
    const reloadJson = await okReload.json();
    assert.equal(reloadJson.ok, true);
    assert.equal(reloadJson.providers.length, 1);
    assert.equal(reloadJson.providers[0].key, 'ext:team-billing');

    // /v1/apps includes externalProviders
    const appsJson = await (await fetch(`${base}/v1/apps`)).json();
    assert.equal(appsJson.providersDir, providersDir);
    assert.equal(appsJson.externalProviders.length, 1);
    assert.equal(appsJson.externalProviders[0].shortName, 'Team');

    // /v1/usage includes ext:team-billing card + overview quota window
    const usage1 = await (await fetch(`${base}/v1/usage?days=7`)).json();
    assert.ok(usage1.cards['ext:team-billing']);
    assert.equal(usage1.cards['ext:team-billing'].quotaWindows[0].remainingPct, 75);
    assert.equal(usage1.cards.all.quotaWindows.some((w) => w.id === 'overview-ext:team-billing'), true);

    // Disable ext:team-billing via /v1/config -> removed from overview and persisted
    const disableRes = await fetch(`${base}/v1/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-atm-token': meter.authToken },
      body: JSON.stringify({ tools: { 'ext:team-billing': false } }),
    });
    assert.equal(disableRes.status, 200);
    const cfgJson = await disableRes.json();
    assert.equal(cfgJson.config.tools['ext:team-billing'], false);

    const usage2 = await (await fetch(`${base}/v1/usage?days=7`)).json();
    assert.equal(usage2.cards.all.quotaWindows.some((w) => w.id === 'overview-ext:team-billing'), false);
    assert.equal(usage2.externalProviders[0].enabled, false);

    // sanitizePluginFileName guards against traversal, hidden files, and non-.mjs extensions
    assert.equal(sanitizePluginFileName('my-gw'), 'my-gw.mjs');
    assert.equal(sanitizePluginFileName('my-gw.mjs'), 'my-gw.mjs');
    assert.equal(sanitizePluginFileName('../escape.mjs'), null);
    assert.equal(sanitizePluginFileName('.hidden.mjs'), null);
    assert.equal(sanitizePluginFileName('bad.sh'), null);

    // Import & Delete require X-ATM-Token
    const unauthImport = await fetch(`${base}/v1/providers/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: 'new.mjs', content: 'export default {}' }),
    });
    assert.equal(unauthImport.status, 401);

    const unauthDel = await fetch(`${base}/v1/providers?fileName=team-billing.mjs`, {
      method: 'DELETE',
    });
    assert.equal(unauthDel.status, 401);

    // Invalid plugin (syntax / missing fetch / traversal) rejected with 400 and leaves directory clean
    const badSyntax = await fetch(`${base}/v1/providers/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-atm-token': meter.authToken },
      body: JSON.stringify({ fileName: 'broken.mjs', content: 'export default { id: "broken" };' }),
    });
    assert.equal(badSyntax.status, 400);
    assert.equal(existsSync(join(providersDir, 'broken.mjs')), false);

    const badPath = await fetch(`${base}/v1/providers/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-atm-token': meter.authToken },
      body: JSON.stringify({
        fileName: '../evil.mjs',
        content: 'export default { id: "evil", fetch: () => ({}) };',
      }),
    });
    assert.equal(badPath.status, 400);

    // Valid plugin import writes 0o600 file and immediately becomes active in /v1/usage
    const goodImport = await fetch(`${base}/v1/providers/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-atm-token': meter.authToken },
      body: JSON.stringify({
        fileName: 'imported-gw',
        content: `
          export default {
            id: 'imported-gw',
            name: 'Imported Gateway',
            shortName: 'Imported',
            currency: 'USD',
            async fetch() {
              return {
                account: 'carol',
                quotaWindows: [{ id: 'm', title: 'Monthly', used: 20, limit: 100 }],
                metrics: { todayCost: 2.5, periodCost: 20, periodLimit: 100 },
              };
            },
          };
        `,
      }),
    });
    assert.equal(goodImport.status, 200);
    const impJson = await goodImport.json();
    assert.equal(impJson.ok, true);
    assert.equal(impJson.imported.key, 'ext:imported-gw');
    assert.equal(impJson.imported.fileName, 'imported-gw.mjs');
    const importedFilePath = join(providersDir, 'imported-gw.mjs');
    assert.equal(existsSync(importedFilePath), true);
    assert.equal(statSync(importedFilePath).mode & 0o777, 0o600);
    assert.equal(impJson.card.quotaWindows[0].remainingPct, 80);

    // Delete imported plugin cleans file and removes it from provider list
    const delRes = await fetch(`${base}/v1/providers?fileName=imported-gw.mjs`, {
      method: 'DELETE',
      headers: { 'x-atm-token': meter.authToken },
    });
    assert.equal(delRes.status, 200);
    const delJson = await delRes.json();
    assert.equal(delJson.ok, true);
    assert.equal(delJson.deleted, true);
    assert.equal(existsSync(importedFilePath), false);
    assert.equal(delJson.providers.some((p) => p.key === 'ext:imported-gw'), false);
  } finally {
    await meter.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
