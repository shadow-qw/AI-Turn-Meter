#!/usr/bin/env node
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defaultStateDir, processCursorHookPayload } from '../src/adapters/cursor.mjs';
import { AUTH_TOKEN_HEADER, readDaemonToken } from '../src/auth.mjs';

const PORT = Number(process.env.AI_TURN_METER_PORT || 47831);

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) return;

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }

  const stateDir = defaultStateDir();
  const token = readDaemonToken(stateDir);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 600);
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/ingest/cursor-hook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { [AUTH_TOKEN_HEADER]: token } : {}),
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (res.ok) return;
  } catch {
    // Daemon offline: fall back to local inflight processing + spool file so turn is never lost
  } finally {
    clearTimeout(timer);
  }

  const turn = processCursorHookPayload(payload, { stateDir });
  if (!turn) return;

  const spoolFile = join(stateDir, 'cursor-spool.jsonl');
  mkdirSync(dirname(spoolFile), { recursive: true });
  appendFileSync(spoolFile, `${JSON.stringify(turn)}\n`);
}

main().catch(() => {});
