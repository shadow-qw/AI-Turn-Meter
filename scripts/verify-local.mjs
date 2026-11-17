#!/usr/bin/env node
/**
 * Read-only verification against real local session logs on this Mac using :memory: SQLite.
 * Never modifies ~/.cursor, ~/.codex, ~/.gemini, or CodeBuddy files.
 */
import { TurnStore } from '../packages/daemon/src/store.mjs';
import { CodexAdapter } from '../packages/daemon/src/adapters/codex.mjs';
import { AntigravityAdapter } from '../packages/daemon/src/adapters/antigravity.mjs';
import { CodeBuddyAdapter } from '../packages/daemon/src/adapters/codebuddy.mjs';

const store = new TurnStore(':memory:');
const codex = new CodexAdapter({ store });
const agy = new AntigravityAdapter({ store, enableRpc: true });
const codebuddy = new CodeBuddyAdapter({ store });

codex.scan({ maxRecentFiles: 10 });
await agy.scan({ maxRecentFiles: 10 });
codebuddy.scan({ maxRecent: 15 });

const state = store.getState(10);
console.log('=== LOCAL READ-ONLY VERIFICATION SUMMARY ===');
for (const tool of ['codex', 'antigravity', 'codebuddy', 'cursor']) {
  const t = state.byTool[tool];
  if (!t) {
    console.log(`[${tool}] no completed turns found locally (expected for cursor until hook runs)`);
    continue;
  }
  const ttftText = t.ttftMs !== null && t.ttftMs !== undefined ? `${t.ttftMs}ms` : 'N/A';
  console.log(
    `[${tool}] model=${t.model} | ${t.inlineText} | method=${t.tpsMethodLabel} | ttft=${ttftText} | calls=${t.callCount} | session=${t.sessionTotal?.turnCount} turns (in=${t.sessionTotal?.totalInputTokens}, out=${t.sessionTotal?.outputTokens})`
  );
}
store.close();
