import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const bytes=readFileSync(new URL('./policy.json',import.meta.url));
function freeze(x) { Object.values(x).forEach(v=>{if(v&&typeof v==='object')freeze(v);});return Object.freeze(x); }
export const policy=freeze(JSON.parse(bytes));
// Fingerprint, NOT approval: deployment must independently pin this bundle.
const trustedFiles=['contracts.mjs','policy.mjs','policy.json','state.mjs','sandbox.mjs'];
export const policyRevision=createHash('sha256').update(JSON.stringify(trustedFiles.map(name=>[name,createHash('sha256').update(readFileSync(new URL(name,import.meta.url))).digest('hex')]))).digest('hex');
const prefixes=['.git/','.github/','scripts/','packaging/','tools/','docs/autopilot/','docs/superpowers/','packages/desktop-macos/','packages/daemon/bin/','packages/vscode-extension/'];
const protectedFiles=['package.json','package-lock.json','npm-shrinkwrap.json','AGENTS.md','CLAUDE.md','.npmrc','.gitmodules','.gitignore','.gitattributes','.nvmrc','.node-version','yarn.lock','pnpm-lock.yaml','bun.lock','bun.lockb','Makefile','Dockerfile'];
const benignDaemon=['packages/daemon/src/format.mjs'];
/** Offline scope filter only: true NEVER grants execution, merging or publication. */
export function classifyScope(input) {
 const deny=reason=>({allowed:false,reason});
 if(!input||Object.getPrototypeOf(input)!==Object.prototype)return deny('INVALID_SCOPE');
 if(Object.keys(input).some(k=>!['paths','added','deleted','action','binary','symlink','submodule','renamed'].includes(k)))return deny('INVALID_SCOPE');
 const {paths,added,deleted,action}=input;
 if(action!=='code'||!Array.isArray(paths)||!paths.length||paths.length>policy.limits.files||new Set(paths).size!==paths.length||![added,deleted].every(n=>Number.isSafeInteger(n)&&n>=0)||added+deleted>policy.limits.lines)return deny('LIMIT_OR_ACTION');
 if(['binary','symlink','submodule','renamed'].some(k=>input[k]!==undefined&&input[k]!==false))return deny('UNSAFE_GIT_OBJECT');
 for(const p of paths) {
  if(typeof p!=='string'||p.length>500||p!==p.trim()||!p||p.startsWith('/')||/[\\%\x00-\x1f\x7f:]/.test(p)||p.split('/').some(x=>!x||['.','..','.git','.github','node_modules'].includes(x.toLowerCase())))return deny('PROTECTED_PATH');
  const lower=p.toLowerCase();
  if(prefixes.some(x=>lower.startsWith(x))||protectedFiles.some(x=>lower===x.toLowerCase())||/(?:^|\/)(?:package(?:-lock)?\.json|\.env(?:\..*)?|agents\.md|claude\.md)$/.test(lower)||/\.(?:dmg|vsix|exe|dll|so|dylib|zip|gz|png|jpg|sqlite|db)$/.test(lower))return deny('PROTECTED_PATH');
  if(lower.startsWith('packages/daemon/src/')&&!benignDaemon.includes(p))return deny('SENSITIVE_MODULE');
  if(lower.startsWith('tests/')&&deleted>0)return deny('TEST_DELETION_REQUIRES_REVIEW');
 }
 return {allowed:true,reason:'SCOPE_ONLY_NOT_AUTHORIZATION'};
}
