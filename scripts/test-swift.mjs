#!/usr/bin/env node
/**
 * Run Swift Testing suite for AITurnMeterCore.
 * Supports both full Xcode installations and standalone Apple Command Line Tools.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = join(ROOT, 'packages', 'desktop-macos');

let devDir = '';
try {
  devDir = execFileSync('/usr/bin/xcode-select', ['-p'], { encoding: 'utf8' }).trim();
} catch {}

const args = ['test', '--package-path', pkgPath];
if (devDir.includes('CommandLineTools')) {
  const frameworksDir = join(devDir, 'Library', 'Developer', 'Frameworks');
  const usrLibDir = join(devDir, 'Library', 'Developer', 'usr', 'lib');
  if (existsSync(frameworksDir)) {
    args.push(
      '--disable-xctest',
      '-Xswiftc',
      '-F',
      '-Xswiftc',
      frameworksDir,
      '-Xlinker',
      '-F',
      '-Xlinker',
      frameworksDir,
      '-Xlinker',
      '-rpath',
      '-Xlinker',
      frameworksDir
    );
    if (existsSync(usrLibDir)) {
      args.push('-Xlinker', '-rpath', '-Xlinker', usrLibDir);
    }
  }
}

execFileSync('/usr/bin/swift', args, { stdio: 'inherit' });
