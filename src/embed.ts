/**
 * Tier 1 local embedding: feature hashing of words, word pairs and character
 * trigrams into a fixed-size vector. Deterministic, offline and instant.
 * Identifiers are split (retryWithBackoff -> retry with backoff) so code and
 * prose share a vocabulary. A model-backed embedder can replace this behind
 * the same signature.
 */

export const DIM = 512;

const STOPWORDS = new Set(["the", "a", "an", "of", "to", "and", "or", "in", "on", "for", "is", "it", "this", "that", "be", "as", "at", "by"]);

export function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function add(vec: Float32Array, feature: string, weight: number): void {
  const h = fnv1a(feature);
  const i = h % DIM;
  vec[i] = (vec[i] ?? 0) + (h & 0x40000000 ? weight : -weight);
}

export function embed(text: string): Float32Array {
  const vec = new Float32Array(DIM);
  const ws = words(text);
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i]!;
    add(vec, `w:${w}`, 1);
    if (i + 1 < ws.length) add(vec, `b:${w} ${ws[i + 1]}`, 0.5);
    const padded = `^${w}$`;
    for (let j = 0; j + 3 <= padded.length; j++) add(vec, `t:${padded.slice(j, j + 3)}`, 0.3);
  }
  let norm = 0;
  for (const x of vec) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < DIM; i++) vec[i]! /= norm;
  return vec;
}

/** Cosine similarity of two normalized vectors. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < DIM; i++) dot += a[i]! * b[i]!;
  return dot;
}
