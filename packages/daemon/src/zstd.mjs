import { execFileSync } from 'node:child_process';
import * as zlib from 'node:zlib';

const nativeZstdDecompressSync = typeof zlib.zstdDecompressSync === 'function' ? zlib.zstdDecompressSync : null;

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
 * @param {{ nativeImpl?: ((buf: Buffer) => Buffer) | null, cliFallback?: ((buf: Buffer) => Buffer | null) | null }} [opts]
 * @returns {Buffer | null}
 */
export function decompressZstdSync(buf, { nativeImpl = nativeZstdDecompressSync, cliFallback } = {}) {
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
      maxBuffer: 64 * 1024 * 1024,
      timeout: 5000,
    });
  } catch {
    return null;
  }
}
