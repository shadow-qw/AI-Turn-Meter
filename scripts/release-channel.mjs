import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function classifyRelease({eventName, ref, tag, version, extensionVersion, confirmedStableTag}) {
  const number = '(0|[1-9][0-9]*)';
  const pattern = new RegExp(`^${number}\\.${number}\\.${number}(-rc\\.[1-9][0-9]*)?$`);
  if (typeof version !== 'string' || !pattern.test(version) || tag !== `v${version}` || extensionVersion !== version) throw new Error('Tag and manifest versions must match strict stable/RC versions');
  if (eventName !== 'push' && eventName !== 'workflow_dispatch') throw new Error('Unsupported release event');
  if (eventName === 'push' && ref !== `refs/tags/${tag}`) throw new Error('Tag/ref mismatch');
  if (eventName === 'workflow_dispatch' && ref !== 'refs/heads/main') throw new Error('Manual release must use trusted main workflow');
  if (version.includes('-rc.')) return {channel:'rc', prerelease:true, makeLatest:false};
  if (eventName !== 'workflow_dispatch' || confirmedStableTag !== tag) throw new Error('Stable release requires manual main dispatch and exact tag confirmation');
  return {channel:'stable', prerelease:false, makeLatest:true};
}

export function assertChannelProof(channel, sourceSha, proofSha) {
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('Invalid source SHA');
  if (channel === 'rc' && proofSha !== sourceSha) throw new Error('RC channel proof for exact source SHA is not approved');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const git = (...args) => execFileSync('git', args, {encoding:'utf8'}).trim();
  const tag = process.env.GITHUB_EVENT_NAME === 'push' ? process.env.GITHUB_REF_NAME : process.env.INPUT_TAG;
  if (!/^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-rc\.[1-9][0-9]*)?$/.test(tag || '')) throw new Error('Invalid release tag');
  const sourceSha = git('rev-parse', `refs/tags/${tag}^{commit}`);
  const version = JSON.parse(git('show', `${sourceSha}:package.json`)).version;
  const extensionVersion = JSON.parse(git('show', `${sourceSha}:packages/vscode-extension/package.json`)).version;
  const result = classifyRelease({eventName:process.env.GITHUB_EVENT_NAME, ref:process.env.GITHUB_REF, tag, version, extensionVersion, confirmedStableTag:process.env.CONFIRM_STABLE_TAG});
  assertChannelProof(result.channel, sourceSha, process.env.RC_CHANNEL_PROOF_SHA);
  appendFileSync(process.env.GITHUB_OUTPUT, `channel=${result.channel}\nprerelease=${result.prerelease}\nmake_latest=${result.makeLatest}\nsource_sha=${sourceSha}\ntag=${tag}\n`);
}
