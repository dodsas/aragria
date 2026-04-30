// In-memory description-hash cache. Two players who type the same name +
// description get the same SVG instantly without re-classifying. Sized for
// the ~1k-concurrent target — at 500 entries × ~3 KB SVG ≈ 1.5 MB worst case.

import { createHash } from 'node:crypto';

const MAX_ENTRIES = 500;

// Insertion-ordered Map; on hit we delete + re-set so the LRU ordering by
// access time falls out of Map's iteration order naturally.
const cache = new Map();

function normalize(s) {
  return String(s ?? '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function key(name, description) {
  const h = createHash('sha1');
  h.update(`${normalize(name)}|${normalize(description)}`);
  return h.digest('hex').slice(0, 16);
}

export function get(k) {
  const v = cache.get(k);
  if (v === undefined) return undefined;
  cache.delete(k);
  cache.set(k, v);
  return v;
}

export function set(k, v) {
  if (cache.has(k)) cache.delete(k);
  cache.set(k, v);
  if (cache.size > MAX_ENTRIES) {
    // Map iteration order is insertion order — first key is the LRU.
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}
