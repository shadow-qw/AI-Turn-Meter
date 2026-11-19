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
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;
const repoArg = process.argv.find((a) => a.startsWith('--repo='));
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
        !normalized.endsWith('/.DS_Store')
      );
    },
  });
}
cpSync(join(distDir, 'ai-turn-meter.vsix'), join(stagePkg, 'dist', 'ai-turn-meter.vsix'));

rmSync(outTarball, { force: true });
execFileSync('tar', ['-czf', outTarball, '-C', stageRoot, folderName], {
  env: { ...process.env, COPYFILE_DISABLE: '1' },
});
rmSync(stageRoot, { recursive: true, force: true });

const sha256 = createHash('sha256').update(readFileSync(outTarball)).digest('hex');
writeFileSync(`${outTarball}.sha256`, `${sha256}  ${basename(outTarball)}\n`);

const formulaPath = join(ROOT, 'packaging', 'homebrew', 'ai-turn-meter.rb');
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
  rb = rb.replace(/v[0-9]+\.[0-9]+\.[0-9]+\/ai-turn-meter-[0-9]+\.[0-9]+\.[0-9]+\.tar\.gz/g, `v${version}/ai-turn-meter-${version}.tar.gz`);
}
writeFileSync(formulaPath, rb);

console.log(`Release tarball: ${outTarball}`);
console.log(`SHA-256:         ${sha256}`);
console.log(`Updated formula: ${formulaPath}`);
