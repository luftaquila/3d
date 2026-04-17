import fs from 'node:fs/promises';
import { config } from './config.js';

export async function validateStl(filePath) {
  const fh = await fs.open(filePath, 'r');
  try {
    const stat = await fh.stat();
    const size = stat.size;
    if (size < 15) return fail('too small');

    const headBuf = Buffer.alloc(Math.min(size, 512));
    await fh.read(headBuf, 0, headBuf.length, 0);

    if (size >= 84) {
      const headerTail = Buffer.alloc(4);
      await fh.read(headerTail, 0, 4, 80);
      const triCount = headerTail.readUInt32LE(0);
      const expected = 84 + triCount * 50;
      if (expected === size) {
        if (triCount > config.limits.maxTriangles) {
          return fail('triangle count exceeds limit');
        }
        return { ok: true, format: 'binary', triangleCount: triCount };
      }
    }

    const text = headBuf.toString('utf8').trimStart().toLowerCase();
    if (text.startsWith('solid ') || text.startsWith('solid\n') || text.startsWith('solid\r')) {
      const triCount = await countAsciiFacets(fh, size);
      if (triCount > config.limits.maxTriangles) {
        return fail('triangle count exceeds limit');
      }
      return { ok: true, format: 'ascii', triangleCount: triCount };
    }

    return fail('not a valid STL file');
  } finally {
    await fh.close();
  }
}

async function countAsciiFacets(fh, size) {
  const chunk = Buffer.alloc(64 * 1024);
  let triCount = 0;
  let offset = 0;
  let leftover = '';
  while (offset < size) {
    const toRead = Math.min(chunk.length, size - offset);
    const { bytesRead } = await fh.read(chunk, 0, toRead, offset);
    if (bytesRead <= 0) break;
    const text = leftover + chunk.slice(0, bytesRead).toString('utf8');
    const nl = text.lastIndexOf('\n');
    let scanEnd = text.length;
    if (nl !== -1 && offset + bytesRead < size) {
      scanEnd = nl + 1;
      leftover = text.slice(scanEnd);
    } else {
      leftover = '';
    }
    let idx = 0;
    while ((idx = text.indexOf('facet normal', idx)) !== -1 && idx < scanEnd) {
      triCount += 1;
      if (triCount > config.limits.maxTriangles) return triCount;
      idx += 12;
    }
    offset += bytesRead;
  }
  return triCount;
}

function fail(reason) {
  return { ok: false, reason };
}
