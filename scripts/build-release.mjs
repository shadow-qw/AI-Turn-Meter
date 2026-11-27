#!/usr/bin/env node
/**
 * Build a reproducible release tarball (including dist/ai-turn-meter.vsix) and
 * update packaging/homebrew/ai-turn-meter.rb with the matching version & sha256.
 *
 * Usage:
 *   node scripts/build-release.mjs [--repo=owner/ai-turn-meter]
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function writeOctalField(buf, offset, length, value) {
  const digits = Math.max(0, Number(value) || 0).toString(8).padStart(length - 1, '0');
  if (digits.length > length - 1) {
    throw new Error(`Tar octal field overflow: ${value} for width ${length}`);
  }
  buf.write(digits, offset, length - 1, 'ascii');
  buf[offset + length - 1] = 0;
}

function splitUstarPath(relPath) {
  const bytes = Buffer.from(relPath, 'utf8');
  if (bytes.length <= 100) {
    return { nameBytes: bytes, prefixBytes: Buffer.alloc(0), needsPax: false };
  }
  const slashIdx = relPath.lastIndexOf('/');
  if (slashIdx > 0) {
    const prefix = relPath.slice(0, slashIdx);
    const name = relPath.slice(slashIdx + 1);
    const prefixBytes = Buffer.from(prefix, 'utf8');
    const nameBytes = Buffer.from(name, 'utf8');
    if (prefixBytes.length <= 155 && nameBytes.length <= 100) {
      return { nameBytes, prefixBytes, needsPax: false };
    }
  }
  return {
    nameBytes: bytes.subarray(0, 100),
    prefixBytes: Buffer.alloc(0),
    needsPax: true,
  };
}

function buildTarHeader({ nameBytes, prefixBytes, mode, size, typeflag }) {
  const header = Buffer.alloc(512, 0);
  nameBytes.copy(header, 0, 0, Math.min(nameBytes.length, 100));
  writeOctalField(header, 100, 8, mode);
  writeOctalField(header, 108, 8, 0);
  writeOctalField(header, 116, 8, 0);
  writeOctalField(header, 124, 12, size);
  writeOctalField(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = typeflag.charCodeAt(0);
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  writeOctalField(header, 329, 8, 0);
  writeOctalField(header, 337, 8, 0);
  if (prefixBytes && prefixBytes.length > 0) {
    prefixBytes.copy(header, 345, 0, Math.min(prefixBytes.length, 155));
  }
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += header[i];
  const chk = sum.toString(8).padStart(6, '0');
  header.write(chk, 148, 6, 'ascii');
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function buildPaxPathRecord(relPath) {
  const payload = ` path=${relPath}\n`;
  let totalLen = Buffer.byteLength(payload, 'utf8') + 1;
  while (true) {
    const line = `${totalLen}${payload}`;
    const byteLen = Buffer.byteLength(line, 'utf8');
    if (byteLen === totalLen) return Buffer.from(line, 'utf8');
    totalLen = byteLen;
  }
}

function padTarBlock(buf) {
  const rem = buf.length % 512;
  if (rem === 0) return buf;
  return Buffer.concat([buf, Buffer.alloc(512 - rem, 0)]);
}

function collectDeterministicEntries(stageRoot, folderName) {
  const entries = [];
  function walk(absDir, relDir) {
    entries.push({ relPath: `${relDir}/`, absPath: absDir, isDir: true, mode: 0o755 });
    const items = readdirSync(absDir, { withFileTypes: true }).sort((a, b) =>
      Buffer.compare(Buffer.from(a.name, 'utf8'), Buffer.from(b.name, 'utf8'))
    );
    for (const ent of items) {
      const abs = join(absDir, ent.name);
      const rel = `${relDir}/${ent.name}`;
      if (ent.isDirectory()) {
        walk(abs, rel);
      } else {
        const st = statSync(abs);
        const mode = (st.mode & 0o111) !== 0 ? 0o755 : 0o644;
        entries.push({ relPath: rel, absPath: abs, isDir: false, mode });
      }
    }
  }
  walk(join(stageRoot, folderName), folderName);
  return entries;
}

/**
 * Build a reproducible `.tar.gz` archive (fixed mtime=0, uid/gid=0, sorted entries, zeroed gzip header MTIME).
 */
export function createDeterministicTarGz(stageRoot, folderName, outTarball) {
  const entries = collectDeterministicEntries(stageRoot, folderName);
  const chunks = [];
  for (const ent of entries) {
    const data = ent.isDir ? Buffer.alloc(0) : readFileSync(ent.absPath);
    const { nameBytes, prefixBytes, needsPax } = splitUstarPath(ent.relPath);
    if (needsPax) {
      const paxData = buildPaxPathRecord(ent.relPath);
      const paxName = Buffer.from(`PaxHeader/${basename(ent.relPath)}`.slice(0, 100), 'utf8');
      chunks.push(
        buildTarHeader({
          nameBytes: paxName,
          prefixBytes: Buffer.alloc(0),
          mode: 0o644,
          size: paxData.length,
          typeflag: 'x',
        })
      );
      chunks.push(padTarBlock(paxData));
    }
    chunks.push(
      buildTarHeader({
        nameBytes,
        prefixBytes,
        mode: ent.mode,
        size: data.length,
        typeflag: ent.isDir ? '5' : '0',
      })
    );
    if (data.length > 0) {
      chunks.push(padTarBlock(data));
    }
  }
  chunks.push(Buffer.alloc(1024, 0));
  const gz = gzipSync(Buffer.concat(chunks), { level: 9 });
  // Zero gzip MTIME (bytes 4..7) and set OS=Unix (byte 9) for cross-platform determinism.
  if (gz.length >= 10) {
    gz.writeUInt32LE(0, 4);
    gz[9] = 3;
  }
  writeFileSync(outTarball, gz);
  return createHash('sha256').update(gz).digest('hex');
}

export function verifyFormulaSha256(formulaPath, expectedSha256) {
  const rb = readFileSync(formulaPath, 'utf8');
  const m = rb.match(/^\s*sha256\s+"([0-9a-fA-F]{64})"/m);
  if (!m) {
    throw new Error(`No sha256 field found in ${formulaPath}`);
  }
  const actual = m[1].toLowerCase();
  const expected = String(expectedSha256 || '').trim().toLowerCase();
  if (actual !== expected) {
    throw new Error(`Homebrew formula sha256 mismatch: formula=${actual} !== expected=${expected}`);
  }
  return { actual, expected };
}

export async function syncOrVerifyReleaseSha256({
  formulaPath = join(ROOT, 'packaging', 'homebrew', 'ai-turn-meter.rb'),
  verifyOnly = false,
  fetchImpl = fetch,
} = {}) {
  const rb = readFileSync(formulaPath, 'utf8');
  const urlMatch = rb.match(/^\s*url\s+"([^"]+)"/m);
  if (!urlMatch) {
    throw new Error(`No url field found in ${formulaPath}`);
  }
  const url = urlMatch[1];
  const res = await fetchImpl(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const remoteSha256 = createHash('sha256').update(buf).digest('hex');
  if (verifyOnly) {
    verifyFormulaSha256(formulaPath, remoteSha256);
  } else {
    const nextRb = rb.replace(/^(\s*sha256\s+)"[^"]*"/m, `$1"${remoteSha256}"`);
    writeFileSync(formulaPath, nextRb);
  }
  return { url, remoteSha256, bytes: buf.length };
}

export function assertVersionParity(rootDir = ROOT, { warn = (msg) => console.warn(msg) } = {}) {
  const rootPkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
  const extPkg = JSON.parse(readFileSync(join(rootDir, 'packages', 'vscode-extension', 'package.json'), 'utf8'));
  const rootVersion = String(rootPkg.version || '').trim();
  const vsixVersion = String(extPkg.version || '').trim();
  if (!rootVersion || rootVersion !== vsixVersion) {
    throw new Error(
      `Version mismatch: package.json (${rootVersion || 'missing'}) !== packages/vscode-extension/package.json (${vsixVersion || 'missing'}). Align both versions before releasing.`
    );
  }
  const vmSwiftPath = join(
    rootDir,
    'packages',
    'desktop-macos',
    'Sources',
    'AITurnMeterApp',
    'Runtime',
    'MeterViewModel.swift'
  );
  if (existsSync(vmSwiftPath)) {
    const swiftSrc = readFileSync(vmSwiftPath, 'utf8');
    const m = swiftSrc.match(/CFBundleShortVersionString[^\n]*\?\?\s*"([^"]+)"/);
    if (m && m[1] !== rootVersion) {
      warn(
        `[WARN] MeterViewModel.swift fallback version (${m[1]}) differs from package.json (${rootVersion})`
      );
    }
  }
  return { rootVersion, vsixVersion };
}

async function main() {
  const args = process.argv.slice(2);
  const verifyFormulaOnly = args.includes('--verify-formula');
  const syncRelease = args.includes('--sync-release');
  const verifyOnly = args.includes('--verify-only');
  const formulaPath = join(ROOT, 'packaging', 'homebrew', 'ai-turn-meter.rb');

  if (syncRelease) {
    const res = await syncOrVerifyReleaseSha256({ formulaPath, verifyOnly });
    console.log(`Remote release tarball: ${res.url} (${res.bytes} bytes)`);
    console.log(`Remote SHA-256:         ${res.remoteSha256}`);
    console.log(verifyOnly ? `Verified formula:       ${formulaPath}` : `Updated formula:        ${formulaPath}`);
    return;
  }

  const { rootVersion: version } = assertVersionParity(ROOT);
  const repoArg = args.find((a) => a.startsWith('--repo='));
  const repo = repoArg ? repoArg.split('=')[1].trim() : null;

  execFileSync(process.execPath, [join(ROOT, 'scripts', 'package-vsix.mjs')], { stdio: 'inherit' });

  const distDir = join(ROOT, 'dist');
  mkdirSync(distDir, { recursive: true });
  for (const f of readdirSync(distDir)) {
    if (/^ai-turn-meter-.*\.tar\.gz(\.sha256)?$/.test(f)) {
      rmSync(join(distDir, f), { force: true });
    }
  }
  const stageRoot = join(distDir, '.release-stage');
  const folderName = `ai-turn-meter-${version}`;
  const stagePkg = join(stageRoot, folderName);
  const outTarball = join(distDir, `${folderName}.tar.gz`);

  rmSync(stageRoot, { recursive: true, force: true });
  mkdirSync(join(stagePkg, 'dist'), { recursive: true });

  for (const item of ['package.json', 'README.md', 'packages', 'scripts']) {
    cpSync(join(ROOT, item), join(stagePkg, item), {
      recursive: true,
      filter: (src) => {
        const normalized = src.replace(/\\/g, '/');
        return (
          !normalized.includes('/.build') &&
          !normalized.includes('/.swiftpm') &&
          basename(normalized) !== '.DS_Store'
        );
      },
    });
  }
  cpSync(join(distDir, 'ai-turn-meter.vsix'), join(stagePkg, 'dist', 'ai-turn-meter.vsix'));

  rmSync(outTarball, { force: true });
  const sha256 = createDeterministicTarGz(stageRoot, folderName, outTarball);
  rmSync(stageRoot, { recursive: true, force: true });
  writeFileSync(`${outTarball}.sha256`, `${sha256}  ${basename(outTarball)}\n`);

  if (verifyFormulaOnly) {
    verifyFormulaSha256(formulaPath, sha256);
    console.log(`Release tarball: ${outTarball}`);
    console.log(`SHA-256:         ${sha256}`);
    console.log(`Verified formula:${formulaPath}`);
    return;
  }

  let rb = readFileSync(formulaPath, 'utf8');
  rb = rb.replace(/^(\s*sha256\s+)"[^"]*"/m, `$1"${sha256}"`);
  if (repo) {
    rb = rb
      .replace(/^(\s*homepage\s+)"[^"]*"/m, `$1"https://github.com/${repo}"`)
      .replace(
        /^(\s*url\s+)"[^"]*"/m,
        `$1"https://github.com/${repo}/releases/download/v${version}/ai-turn-meter-${version}.tar.gz"`
      );
  } else {
    rb = rb.replace(
      /v[0-9]+\.[0-9]+\.[0-9]+\/ai-turn-meter-[0-9]+\.[0-9]+\.[0-9]+\.tar\.gz/g,
      `v${version}/ai-turn-meter-${version}.tar.gz`
    );
  }
  writeFileSync(formulaPath, rb);

  console.log(`Release tarball: ${outTarball}`);
  console.log(`SHA-256:         ${sha256}`);
  console.log(`Updated formula: ${formulaPath}`);
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]));
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  main().catch((err) => {
    console.error(err?.message || err);
    process.exit(1);
  });
}
