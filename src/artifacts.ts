/**
 * Semantic artifacts are immutable records attached to git objects.
 *
 * Every record carries its full provenance. Its key is derived from that
 * provenance, so a new model or prompt version produces a new key instead of
 * overwriting an old result.
 */

export type Tier = 0 | 1 | 2 | 3;

/**
 * - derived:  deterministic facts computed from git (Tier 0, always correct)
 * - inferred: proposals from a heuristic or a model (may be wrong)
 * - authored: statements a human made; authoritative
 */
export type Source = "derived" | "inferred" | "authored";

export type Kind =
  | "changes"
  | "file"
  | "intent"
  | "entities"
  | "entity-events"
  | "entity-link"
  | "decision"
  | "rollup";

export interface ChangeEntry {
  /** A, M, D, R, C, T (git raw diff status letter). */
  status: string;
  path: string;
  /** Previous path for renames and copies. */
  from?: string;
  /** Object id of the new blob; absent for deletions. */
  blob?: string;
  /** Object id of the previous blob; absent for additions. */
  oldBlob?: string;
  /** File mode of the new blob, e.g. 100644. */
  mode?: string;
  /** Rename/copy similarity percentage. */
  similarity?: number;
}

export interface ChangesValue {
  parents: string[];
  subject: string;
  paths: ChangeEntry[];
}

export interface FileValue {
  bytes: number;
  lines: number;
  binary: boolean;
}

export interface IntentValue {
  text: string;
}

export interface ArtifactRecord {
  v: 1;
  kind: Kind;
  /** The git object this record describes. */
  object: string;
  source: Source;
  engine: string;
  model: string;
  prompt: string;
  tier: Tier;
  /** 0..1; derived facts are 1. */
  confidence: number;
  value: unknown;
  /** References this record rests on: object ids or other artifact keys. */
  evidence: string[];
  /** Who authored it (authored records only). */
  author?: string;
  createdAt: string;
}

export function keyOf(r: ArtifactRecord): string {
  if (r.source === "authored") return `${r.kind}:authored:${r.author ?? "unknown"}:${r.createdAt}`;
  return `${r.kind}:${r.source}:${r.engine}:${r.model}:${r.prompt}`;
}

function isRecord(x: unknown): x is ArtifactRecord {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  return r.v === 1 && typeof r.kind === "string" && typeof r.object === "string" && typeof r.source === "string";
}

/**
 * Parse a note body (JSON Lines). Unknown or malformed lines are skipped so
 * newer writers never break older readers. Records with the same key are
 * deduplicated, keeping the earliest, which makes the result independent of
 * line order after a union merge.
 */
export function parseNote(text: string): ArtifactRecord[] {
  const byKey = new Map<string, ArtifactRecord>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    const key = keyOf(parsed);
    const existing = byKey.get(key);
    if (!existing || parsed.createdAt < existing.createdAt) byKey.set(key, parsed);
  }
  return [...byKey.values()];
}

/** Serialize records as sorted JSON Lines, compatible with git's cat_sort_uniq merge. */
export function serializeNote(records: ArtifactRecord[]): string {
  return `${records.map((r) => JSON.stringify(r)).sort().join("\n")}\n`;
}

/** Add incoming records whose keys are not already present. Existing records are never replaced. */
export function mergeRecords(existing: ArtifactRecord[], incoming: ArtifactRecord[]): ArtifactRecord[] {
  const keys = new Set(existing.map(keyOf));
  const merged = [...existing];
  for (const r of incoming) {
    const key = keyOf(r);
    if (keys.has(key)) continue;
    keys.add(key);
    merged.push(r);
  }
  return merged;
}

export interface EngineIdentity {
  engine: string;
  model: string;
  prompt: string;
}

export function intentKeyFor(id: EngineIdentity): string {
  return `intent:inferred:${id.engine}:${id.model}:${id.prompt}`;
}

/**
 * Pick the intent to show for an object:
 *   1. the latest authored intent (humans decide)
 *   2. the inferred intent from the currently configured engine
 *   3. the highest-tier, then latest, inferred intent
 */
export function resolveIntent(records: ArtifactRecord[], current?: EngineIdentity): ArtifactRecord | undefined {
  const intents = records.filter((r) => r.kind === "intent");

  const authored = intents
    .filter((r) => r.source === "authored")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (authored) return authored;

  const inferred = intents.filter((r) => r.source === "inferred");
  if (current) {
    const key = intentKeyFor(current);
    const match = inferred.find((r) => keyOf(r) === key);
    if (match) return match;
  }
  return inferred.sort((a, b) => b.tier - a.tier || b.createdAt.localeCompare(a.createdAt))[0];
}

export function intentText(r: ArtifactRecord | undefined): string | undefined {
  const value = r?.value as Partial<IntentValue> | undefined;
  return typeof value?.text === "string" ? value.text : undefined;
}

export function clampConfidence(n: unknown, fallback = 0.5): number {
  const x = typeof n === "number" && Number.isFinite(n) ? n : fallback;
  return Math.min(1, Math.max(0, x));
}

export function now(): string {
  return new Date().toISOString();
}
