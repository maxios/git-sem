import { keyOf, type ArtifactRecord } from "./artifacts.ts";
import { CHANGES_VERSION, ENTITIES_VERSION, FILE_VERSION } from "./versions.ts";

/**
 * Where records live (#9).
 *
 *   refs/notes/sem        shared, pushed: what cannot be recomputed —
 *                         intents from a model, an agent or a person,
 *                         merge decisions, confirmed links, roll-ups
 *   refs/notes/sem-local  local, never pushed: everything git-sem can
 *                         recompute from the code without a model
 *
 * `sem.share = derived` puts derived records in the shared ref too, for
 * teams who want fresh clones to skip the recompute.
 */
export interface SharePolicy {
  shareDerived: boolean;
}

export const DEFAULT_POLICY: SharePolicy = { shareDerived: false };

const DERIVED_KINDS = new Set(["changes", "file", "entities", "entity-events"]);

/** Recomputable from the repository alone: no model time, no human judgment. */
export function isRecomputable(r: ArtifactRecord): boolean {
  if (DERIVED_KINDS.has(r.kind) && r.source === "derived") return true;
  // The heuristic engine restates the subject or the touched paths.
  return r.kind === "intent" && r.source === "inferred" && r.engine === "heuristic";
}

export function isShared(r: ArtifactRecord, policy: SharePolicy = DEFAULT_POLICY): boolean {
  return policy.shareDerived || !isRecomputable(r);
}

/** The prompt each derived kind is produced with today; older prompts are superseded. */
export const CURRENT_DERIVED: Record<string, string> = {
  changes: CHANGES_VERSION,
  file: FILE_VERSION,
  entities: ENTITIES_VERSION,
  "entity-events": ENTITIES_VERSION,
};

/**
 * Records that add nothing once something better exists for the same object:
 *
 *   - a derived record from an older format, when the current one exists
 *   - a heuristic intent, when a model, an agent or a person gave one
 *
 * Intents from models, agents and people are never superseded: together
 * they are the history of who said what.
 */
export function superseded(records: ArtifactRecord[]): Set<string> {
  const keys = new Set(records.map(keyOf));
  const out = new Set<string>();
  const hasBetterIntent = records.some((r) => r.kind === "intent" && !(r.source === "inferred" && r.engine === "heuristic"));
  for (const r of records) {
    const current = CURRENT_DERIVED[r.kind];
    if (current && r.source === "derived" && r.engine === "core" && r.prompt !== current) {
      const currentKey = keyOf({ ...r, prompt: current });
      if (keys.has(currentKey)) out.add(keyOf(r));
    }
    if (r.kind === "intent" && r.source === "inferred" && r.engine === "heuristic" && hasBetterIntent) out.add(keyOf(r));
  }
  return out;
}

export interface Placement {
  shared: ArtifactRecord[];
  local: ArtifactRecord[];
  dropped: ArtifactRecord[];
}

/**
 * Where an object's records belong under the policy. Records are judged
 * together, because whether one is superseded depends on the others.
 */
export function place(records: ArtifactRecord[], policy: SharePolicy = DEFAULT_POLICY): Placement {
  const gone = superseded(records);
  const out: Placement = { shared: [], local: [], dropped: [] };
  for (const r of records) {
    if (gone.has(keyOf(r))) out.dropped.push(r);
    else if (isShared(r, policy)) out.shared.push(r);
    else out.local.push(r);
  }
  return out;
}
