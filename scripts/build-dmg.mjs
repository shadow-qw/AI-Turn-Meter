#!/usr/bin/env node
/**
 * Build standalone macOS `AI Turn Meter.app` (Apple Silicon arm64) and package into
 * `dist/AI-Turn-Meter-<version>-arm64.dmg` with self-contained Node >= 22.5 runtime.
 */
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;

function isStandaloneNodeBinary(binPath) {
  if (!binPath || !existsSync(binPath)) return false;
  try {
    const ver = execFileSync(binPath, ['-p', 'process.versions.node'], {
      encoding: 'utf8',
      timeout: 2000,
    }).trim();
    const [major = 0, minor = 0] = ver.split('.').map(Number);
    if (!(major > 22 || (major === 22 && minor >= 5))) return false;

    const arch = execFileSync('/usr/bin/file', [binPath], { encoding: 'utf8' });
    if (!arch.includes('arm64')) return false;

    const otoolOut = execFileSync('/usr/bin/otool', ['-L', binPath], { encoding: 'utf8' });
    const deps = otoolOut
      .split(/\r?\n/)
      .slice(1)
      .map((l) => l.trim().split(' ')[0])
      .filter(Boolean);
    return deps.every((d) => d.startsWith('/System/') || d.startsWith('/usr/lib/'));
  } catch {
    return false;
  }
}

function findStandaloneNode() {
  const argNode = process.argv.find((a) => a.startsWith('--node='));
  const candidates = [];
  if (argNode) candidates.push(argNode.split('=')[1]);
  if (process.env.AI_TURN_METER_BUNDLE_NODE) candidates.push(process.env.AI_TURN_METER_BUNDLE_NODE);
  candidates.push(process.execPath);

  const nvmDir = join(homedir(), '.nvm', 'versions', 'node');
  if (existsSync(nvmDir)) {
    for (const v of readdirSync(nvmDir).sort().reverse()) {
      candidates.push(join(nvmDir, v, 'bin', 'node'));
    }
  }

  for (const c of candidates) {
    if (isStandaloneNodeBinary(c)) return c;
  }
  throw new Error(
    '未找到只依赖系统库的独立 arm64 Node (>=22.5) 二进制；请使用 --node=/path/to/standalone/node（例如 nvm 安装的 Node 24）。'
  );
}

function generateAppIcon(iconsetDir, icnsOut) {
  mkdirSync(iconsetDir, { recursive: true });
  const swiftScript = join(dirname(icnsOut), 'gen-icon.swift');
  const scriptSrc = `
import AppKit
import CoreGraphics
import Foundation

let iconset = CommandLine.arguments[1]
let sizes: [(String, Int)] = [
  ("icon_16x16.png", 16),
  ("icon_16x16@2x.png", 32),
  ("icon_32x32.png", 32),
  ("icon_32x32@2x.png", 64),
  ("icon_128x128.png", 128),
  ("icon_128x128@2x.png", 256),
  ("icon_256x256.png", 256),
  ("icon_256x256@2x.png", 512),
  ("icon_512x512.png", 512),
  ("icon_512x512@2x.png", 1024),
]

for (name, px) in sizes {
  let s = CGFloat(px)
  guard let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px,
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
  ) else { continue }
  NSGraphicsContext.saveGraphicsState()
  let nsCtx = NSGraphicsContext(bitmapImageRep: rep)
  NSGraphicsContext.current = nsCtx
  let ctx = nsCtx!.cgContext

  let inset = s * 0.06
  let box = CGRect(x: inset, y: inset, width: s - inset * 2, height: s - inset * 2)
  let path = CGPath(roundedRect: box, cornerWidth: s * 0.22, cornerHeight: s * 0.22, transform: nil)
  ctx.addPath(path)
  ctx.clip()

  let cs = CGColorSpaceCreateDeviceRGB()
  let grad = CGGradient(
    colorsSpace: cs,
    colors: [
      CGColor(red: 0.09, green: 0.12, blue: 0.19, alpha: 1.0),
      CGColor(red: 0.15, green: 0.21, blue: 0.34, alpha: 1.0),
    ] as CFArray,
    locations: [0.0, 1.0]
  )!
  ctx.drawLinearGradient(grad, start: CGPoint(x: 0, y: s), end: CGPoint(x: s, y: 0), options: [])

  ctx.resetClip()
  ctx.setStrokeColor(CGColor(red: 1, green: 1, blue: 1, alpha: 0.14))
  ctx.setLineWidth(max(1.0, s * 0.015))
  ctx.addPath(path)
  ctx.strokePath()

  // Clean speedometer / pulse arc
  let cx = s * 0.5
  let cy = s * 0.48
  let r = s * 0.27
  ctx.setLineCap(.round)
  ctx.setLineWidth(max(1.5, s * 0.068))
  ctx.setStrokeColor(CGColor(red: 1, green: 1, blue: 1, alpha: 0.18))
  ctx.addArc(center: CGPoint(x: cx, y: cy), radius: r, startAngle: .pi * 1.15, endAngle: -.pi * 0.15, clockwise: true)
  ctx.strokePath()

  ctx.setStrokeColor(CGColor(red: 0.36, green: 0.85, blue: 0.98, alpha: 1.0))
  ctx.addArc(center: CGPoint(x: cx, y: cy), radius: r, startAngle: .pi * 1.15, endAngle: .pi * 0.22, clockwise: true)
  ctx.strokePath()

  // Center pulse dot
  let dotR = s * 0.06
  ctx.setFillColor(CGColor(red: 0.98, green: 0.99, blue: 1.0, alpha: 0.96))
  ctx.fillEllipse(in: CGRect(x: cx - dotR, y: cy - dotR, width: dotR * 2, height: dotR * 2))

  // Needle toward 0.22 pi
  let ang = CGFloat.pi * 0.22
  ctx.setLineWidth(max(1.2, s * 0.045))
  ctx.setStrokeColor(CGColor(red: 0.98, green: 0.99, blue: 1.0, alpha: 0.96))
  ctx.move(to: CGPoint(x: cx, y: cy))
  ctx.addLine(to: CGPoint(x: cx + cos(ang) * r * 0.78, y: cy + sin(ang) * r * 0.78))
  ctx.strokePath()

  NSGraphicsContext.restoreGraphicsState()
  if let png = rep.representation(using: .png, properties: [:]) {
    try? png.write(to: URL(fileURLWithPath: iconset + "/" + name))
  }
}
`;
  writeFileSync(swiftScript, scriptSrc);
  execFileSync('/usr/bin/swift', [swiftScript, iconsetDir], { stdio: 'inherit' });
  rmSync(swiftScript, { force: true });
  execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconsetDir, '-o', icnsOut], { stdio: 'inherit' });
}

const nodeBin = findStandaloneNode();
console.log(`Using standalone Node runtime: ${nodeBin}`);

execFileSync(process.execPath, [join(ROOT, 'scripts', 'package-vsix.mjs')], { stdio: 'inherit' });

const distDir = join(ROOT, 'dist');
mkdirSync(distDir, { recursive: true });
for (const f of readdirSync(distDir)) {
  if (/^AI-Turn-Meter-.*\.dmg$/.test(f)) {
    rmSync(join(distDir, f), { force: true });
  }
}
const stageDir = join(distDir, '.dmg-stage');
const appDir = join(stageDir, 'AI Turn Meter.app');
const contentsDir = join(appDir, 'Contents');
const macosDir = join(contentsDir, 'MacOS');
const resDir = join(contentsDir, 'Resources');
const runtimeDir = join(resDir, 'runtime');
const iconsetDir = join(distDir, '.AppIcon.iconset');
const outDmg = join(distDir, `AI-Turn-Meter-${version}-arm64.dmg`);

rmSync(stageDir, { recursive: true, force: true });
rmSync(iconsetDir, { recursive: true, force: true });
mkdirSync(macosDir, { recursive: true });
mkdirSync(join(runtimeDir, 'packages'), { recursive: true });
mkdirSync(join(runtimeDir, 'dist'), { recursive: true });

// 1. Compile native Swift app binary
const swiftSrc = join(ROOT, 'packages', 'desktop-macos', 'main.swift');
const appExe = join(macosDir, 'AITurnMeter');
execFileSync(
  '/usr/bin/swiftc',
  [
    '-O',
    '-swift-version',
    '5',
    '-target',
    'arm64-apple-macosx13.0',
    swiftSrc,
    '-o',
    appExe,
    '-framework',
    'AppKit',
    '-framework',
    'SwiftUI',
    '-framework',
    'Foundation',
    '-framework',
    'WebKit',
  ],
  { stdio: 'inherit' }
);

// 2. Icon + Info.plist
generateAppIcon(iconsetDir, join(resDir, 'AppIcon.icns'));
rmSync(iconsetDir, { recursive: true, force: true });

const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>zh_CN</string>
  <key>CFBundleDisplayName</key>
  <string>AI Turn Meter</string>
  <key>CFBundleExecutable</key>
  <string>AITurnMeter</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleIdentifier</key>
  <string>com.local.ai-turn-meter.app</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>AI Turn Meter</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
  <key>CFBundleVersion</key>
  <string>${version}</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`;
writeFileSync(join(contentsDir, 'Info.plist'), infoPlist);

// 3. Copy standalone Node runtime + JS packages + packaged VSIX
const bundledNode = join(runtimeDir, 'node');
cpSync(nodeBin, bundledNode);
chmodSync(bundledNode, 0o755);

const repoArg = process.argv.find((a) => a.startsWith('--repo='));
const updateUrlArg = process.argv.find((a) => a.startsWith('--update-url='));
const resolvedFeedUrl = updateUrlArg
  ? updateUrlArg.split('=')[1].trim()
  : repoArg
    ? `https://github.com/${repoArg.split('=')[1].trim()}/releases/latest`
    : pkg.updateFeedUrl || null;
const runtimePkg = resolvedFeedUrl ? { ...pkg, updateFeedUrl: resolvedFeedUrl } : pkg;
writeFileSync(join(runtimeDir, 'package.json'), `${JSON.stringify(runtimePkg, null, 2)}\n`);

cpSync(join(ROOT, 'packages', 'daemon'), join(runtimeDir, 'packages', 'daemon'), { recursive: true });
cpSync(join(ROOT, 'packages', 'vscode-extension'), join(runtimeDir, 'packages', 'vscode-extension'), {
  recursive: true,
});
cpSync(join(distDir, 'ai-turn-meter.vsix'), join(runtimeDir, 'dist', 'ai-turn-meter.vsix'));
chmodSync(join(runtimeDir, 'packages', 'daemon', 'bin', 'cli.mjs'), 0o755);
chmodSync(join(runtimeDir, 'packages', 'daemon', 'bin', 'daemon.mjs'), 0o755);
chmodSync(join(runtimeDir, 'packages', 'daemon', 'bin', 'cursor-hook.mjs'), 0o755);

// 4. Ad-hoc sign inside-out and verify bundle signature
execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', bundledNode], { stdio: 'inherit' });
execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', appExe], { stdio: 'inherit' });
execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appDir], { stdio: 'inherit' });
execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appDir], { stdio: 'inherit' });

// 5. Add Applications drag-drop link and create compressed DMG
symlinkSync('/Applications', join(stageDir, 'Applications'));
rmSync(outDmg, { force: true });
execFileSync(
  '/usr/bin/hdiutil',
  ['create', '-volname', 'AI Turn Meter', '-srcfolder', stageDir, '-ov', '-format', 'UDZO', outDmg],
  { stdio: 'inherit' }
);

rmSync(stageDir, { recursive: true, force: true });
console.log(`Built DMG: ${outDmg}`);
