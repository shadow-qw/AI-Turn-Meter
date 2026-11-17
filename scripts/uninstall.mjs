#!/usr/bin/env node
import { uninstallAll } from '../packages/daemon/src/installer.mjs';

const args = new Set(process.argv.slice(2));
uninstallAll({ dryRun: args.has('--dry-run') });
