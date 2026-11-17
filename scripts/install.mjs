#!/usr/bin/env node
import { installAll } from '../packages/daemon/src/installer.mjs';

const args = new Set(process.argv.slice(2));
await installAll({
  dryRun: args.has('--dry-run'),
  skipCliLink: args.has('--no-link'),
  skipLaunchAgent: args.has('--no-daemon'),
});
