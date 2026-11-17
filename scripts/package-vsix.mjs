#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXT_DIR = join(ROOT, 'packages', 'vscode-extension');
const DIST_DIR = join(ROOT, 'dist');
const STAGE_DIR = join(DIST_DIR, '.vsix-stage');
const OUT_VSIX = join(DIST_DIR, 'ai-turn-meter.vsix');

const pkg = JSON.parse(readFileSync(join(EXT_DIR, 'package.json'), 'utf8'));

rmSync(STAGE_DIR, { recursive: true, force: true });
mkdirSync(join(STAGE_DIR, 'extension'), { recursive: true });
mkdirSync(DIST_DIR, { recursive: true });

cpSync(join(EXT_DIR, 'package.json'), join(STAGE_DIR, 'extension', 'package.json'));
cpSync(join(EXT_DIR, 'extension.js'), join(STAGE_DIR, 'extension', 'extension.js'));

const contentTypes = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json"/>
  <Default Extension=".js" ContentType="application/javascript"/>
  <Default Extension=".vsixmanifest" ContentType="text/xml"/>
</Types>
`;

const vsixManifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${pkg.name}" Version="${pkg.version}" Publisher="${pkg.publisher}"/>
    <DisplayName>${pkg.displayName}</DisplayName>
    <Description xml:space="preserve">${pkg.description}</Description>
    <Categories>Other</Categories>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" Version="[1.75.0,)"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
  </Assets>
</PackageManifest>
`;

writeFileSync(join(STAGE_DIR, '[Content_Types].xml'), contentTypes);
writeFileSync(join(STAGE_DIR, 'extension.vsixmanifest'), vsixManifest);

rmSync(OUT_VSIX, { force: true });
execFileSync('python3', [
  '-c',
  `
import os, zipfile
stage, out = ${JSON.stringify(STAGE_DIR)}, ${JSON.stringify(OUT_VSIX)}
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as zf:
    for dp, _, fns in os.walk(stage):
        for fn in fns:
            fp = os.path.join(dp, fn)
            zf.write(fp, os.path.relpath(fp, stage))
`,
]);

rmSync(STAGE_DIR, { recursive: true, force: true });
console.log(`Packaged VSIX: ${OUT_VSIX}`);
