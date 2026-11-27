import { execFileSync, spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import * as zlib from 'node:zlib';

const nativeZstdDecompressSync = typeof zlib.zstdDecompressSync === 'function' ? zlib.zstdDecompressSync : null;
const nativeCreateZstdDecompress = typeof zlib.createZstdDecompress === 'function' ? zlib.createZstdDecompress : null;

let cachedZstdBin;

function resolveZstdCliBin() {
  if (cachedZstdBin !== undefined) return cachedZstdBin;
  for (const cand of ['/opt/homebrew/bin/zstd', '/usr/local/bin/zstd', 'zstd']) {
    try {
      execFileSync(cand, ['--version'], { stdio: 'ignore', timeout: 1500 });
      cachedZstdBin = cand;
      return cand;
    } catch {
      // Try next candidate
    }
  }
  cachedZstdBin = null;
  return null;
}

export function supportsNativeZstd() {
  return Boolean(nativeZstdDecompressSync);
}

/**
 * Decompress a zstd Buffer. Uses native `zlib.zstdDecompressSync` on Node >= 22.15, and
 * gracefully falls back to a local `zstd` CLI (or `null` when unavailable) on Node 22.5-22.14.
 *
 * @param {Buffer} buf
 * @param {{ nativeImpl?: ((buf: Buffer) => Buffer) | null, cliFallback?: ((buf: Buffer) => Buffer | null) | null, warn?: (msg: string) => void }} [opts]
 * @returns {Buffer | null}
 */
export function decompressZstdSync(
  buf,
  { nativeImpl = nativeZstdDecompressSync, cliFallback, warn = (msg) => console.warn(msg) } = {}
) {
  if (typeof nativeImpl === 'function') {
    return nativeImpl(buf);
  }
  if (cliFallback === null) {
    return null;
  }
  if (typeof cliFallback === 'function') {
    return cliFallback(buf);
  }
  const bin = resolveZstdCliBin();
  if (!bin) return null;
  try {
    return execFileSync(bin, ['-dc', '--quiet'], {
      input: buf,
      maxBuffer: 256 * 1024 * 1024,
      timeout: 15000,
    });
  } catch (err) {
    warn(`[ai-turn-meter] zstd CLI decompress failed: ${err?.code || err?.message || err}`);
    return null;
  }
}

/**
 * Stream a `.zst` file line-by-line without buffering the full decompressed file in memory
 * and without any `maxBuffer` cap. Returns `true` when the stream completes cleanly, `false` on error.
 * @param {string} filePath
 * @param {(line: string) => void | Promise<void>} onLine
 * @param {{ nativeStreamFactory?: (() => import('node:stream').Transform) | null, cliBin?: string | null, warn?: (msg: string) => void }} [opts]
 */
export async function forEachZstdLine(
  filePath,
  onLine,
  {
    nativeStreamFactory = nativeCreateZstdDecompress,
    cliBin = undefined,
    warn = (msg) => console.warn(msg),
  } = {}
) {
  if (typeof nativeStreamFactory === 'function') {
    const fileStream = createReadStream(filePath);
    const decompressor = nativeStreamFactory();
    const rl = createInterface({ input: decompressor, crlfDelay: Infinity });
    let streamErr = null;
    const onErr = (err) => {
      if (!streamErr) streamErr = err;
      rl.close();
      fileStream.destroy();
      decompressor.destroy();
    };
    fileStream.on('error', onErr);
    decompressor.on('error', onErr);
    fileStream.pipe(decompressor);
    try {
      for await (const line of rl) {
        await onLine(line);
      }
      if (streamErr) {
        warn(`[ai-turn-meter] zstd stream failed for ${filePath}: ${streamErr?.message || streamErr}`);
        return false;
      }
      return true;
    } catch (err) {
      warn(`[ai-turn-meter] zstd stream failed for ${filePath}: ${err?.message || err}`);
      return false;
    } finally {
      rl.close();
      fileStream.destroy();
      decompressor.destroy();
    }
  }

  const bin = cliBin === undefined ? resolveZstdCliBin() : cliBin;
  if (!bin) {
    warn(`[ai-turn-meter] zstd CLI unavailable to decompress ${filePath}`);
    return false;
  }

  const child = spawn(bin, ['-dc', '--quiet', filePath], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderrSnippet = '';
  let spawnErr = null;
  child.stderr.on('data', (chunk) => {
    if (stderrSnippet.length < 1024) {
      stderrSnippet += chunk.toString('utf8', 0, Math.max(0, 1024 - stderrSnippet.length));
    }
  });
  const closePromise = new Promise((resolve) => {
    child.on('error', (err) => {
      spawnErr = err;
      resolve(1);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      await onLine(line);
    }
    const exitCode = await closePromise;
    if (spawnErr || exitCode !== 0) {
      warn(
        `[ai-turn-meter] zstd CLI failed for ${filePath} (code=${exitCode}): ${
          spawnErr?.message || stderrSnippet.trim() || 'unknown error'
        }`
      );
      return false;
    }
    return true;
  } catch (err) {
    try {
      child.kill();
    } catch {}
    warn(`[ai-turn-meter] zstd CLI failed for ${filePath}: ${err?.message || err}`);
    return false;
  } finally {
    rl.close();
  }
}

/**
 * Stream a `.jsonl` or `.jsonl.zst` file line-by-line. Returns `true` on clean completion, `false` on error.
 * @param {string} filePath
 * @param {(line: string) => void | Promise<void>} onLine
 * @param {object} [opts]
 */
export async function forEachFileLine(filePath, onLine, opts = {}) {
  if (filePath.endsWith('.zst')) {
    return forEachZstdLine(filePath, onLine, opts);
  }
  const warn = opts.warn || ((msg) => console.warn(msg));
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let streamErr = null;
  stream.on('error', (err) => {
    if (!streamErr) streamErr = err;
    rl.close();
    stream.destroy();
  });
  try {
    for await (const line of rl) {
      await onLine(line);
    }
    if (streamErr) {
      warn(`[ai-turn-meter] stream read failed for ${filePath}: ${streamErr?.message || streamErr}`);
      return false;
    }
    return true;
  } catch (err) {
    warn(`[ai-turn-meter] stream read failed for ${filePath}: ${err?.message || err}`);
    return false;
  } finally {
    rl.close();
    stream.destroy();
  }
}
