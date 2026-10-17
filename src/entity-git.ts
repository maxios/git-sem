import { keyOf, now, parseNote, type ArtifactRecord, type ChangeEntry, type ChangesValue } from "./artifacts.ts";
import type { CatFile } from "./batch.ts";
import { commitChanges } from "./changes.ts";
import { diffEntities, extractEntities, languageOf, type Entity, type EntityEvent, type FileVersion } from "./entities.ts";
import type { Git } from "./git.ts";
import { notesArgs } from "./refs.ts";
import { ENTITIES_VERSION } from "./versions.ts";

export { ENTITIES_VERSION };
export const ENTITY_EVENTS_KEY = `entity-events:derived:core:none:${ENTITIES_VERSION}`;
export const ENTITIES_KEY = `entities:derived:core:none:${ENTITIES_VERSION}`;
export const CHANGES_KEY = "changes:derived:core:none:changes/v1";

export interface EntityLink {
  from: { name: string; path: string };
  to: { name: string; path: string };
}

async function contentOf(cat: CatFile, blob: string | undefined): Promise<string | null> {
  return blob ? cat.text(blob) : null;
}

/** Entity-level events for a commit's changes, computed from blob contents (Tier 0/1, no model). */
export async function computeEntityEvents(cat: CatFile, changes: ChangeEntry[]): Promise<EntityEvent[]> {
  const before: FileVersion[] = [];
  const after: FileVersion[] = [];
  for (const c of changes) {
    const oldPath = c.from ?? c.path;
    if (c.status !== "A" && c.status !== "C" && languageOf(oldPath)) {
      const text = await contentOf(cat, c.oldBlob);
      if (text !== null) before.push({ path: oldPath, content: text });
    }
    if (c.status !== "D" && languageOf(c.path)) {
      const text = await contentOf(cat, c.blob);
      if (text !== null) after.push({ path: c.path, content: text });
    }
  }
  return diffEntities(before, after);
}

/**
 * For a merge, keep only the files whose result differs from every parent:
 * the merge's own work (conflict resolutions, evil edits), as `git diff --cc`
 * sees it. Diffing against the first parent alone would re-record everything
 * the merged branch already recorded.
 */
export async function ownChanges(git: Git, commit: string, parents: string[], changes: ChangeEntry[]): Promise<ChangeEntry[]> {
  if (parents.length < 2) return changes;
  let kept = changes;
  for (const other of parents.slice(1)) {
    const differs = new Set((await git.run(["diff", "--name-only", "-z", "--no-renames", other, commit, "--"])).stdout.split("\0").filter(Boolean));
    kept = kept.filter((c) => differs.has(c.path) || (c.from !== undefined && differs.has(c.from)));
  }
  return kept;
}

/** Older notes stored changes without previous blob ids; those need a fresh diff for entity work. */
export function hasOldBlobs(changes: ChangeEntry[]): boolean {
  return changes.every((c) => c.status === "A" || c.oldBlob !== undefined);
}

export function entityEventsRecord(commit: string, events: EntityEvent[]): ArtifactRecord {
  return {
    v: 1,
    kind: "entity-events",
    object: commit,
    source: "derived",
    engine: "core",
    model: "none",
    prompt: ENTITIES_VERSION,
    tier: events.some((e) => e.tier === 1) ? 1 : 0,
    confidence: 1,
    value: { events },
    evidence: [commit],
    createdAt: now(),
  };
}

export function entitiesRecord(blob: string, entities: Entity[]): ArtifactRecord {
  return {
    v: 1,
    kind: "entities",
    object: blob,
    source: "derived",
    engine: "core",
    model: "none",
    prompt: ENTITIES_VERSION,
    tier: 0,
    confidence: 1,
    value: { entities },
    evidence: [blob],
    createdAt: now(),
  };
}

const LEGACY_EVENTS_KEYS = ["entity-events:derived:core:none:entities/v2", "entity-events:derived:core:none:entities/v1"];

/**
 * Stored entity events. `allowLegacy` also accepts records from older
 * versions: fine where only names and paths matter (the search index), not
 * for lineage, which recomputes them so old merge echoes do not return.
 */
export function eventsIn(records: ArtifactRecord[], opts: { allowLegacy?: boolean } = {}): EntityEvent[] | undefined {
  const keys = opts.allowLegacy ? [ENTITY_EVENTS_KEY, ...LEGACY_EVENTS_KEYS] : [ENTITY_EVENTS_KEY];
  for (const key of keys) {
    const r = records.find((x) => keyOf(x) === key);
    if (r) return (r.value as { events: EntityEvent[] }).events ?? [];
  }
  return undefined;
}

/** Links a person confirmed for ambiguous entity successions on this commit. */
export function linksIn(records: ArtifactRecord[]): EntityLink[] {
  return records.filter((r) => r.kind === "entity-link" && r.source === "authored").map((r) => r.value as EntityLink);
}

/**
 * Entity events for any commit: from its note when indexed, otherwise
 * computed on the fly (Tier 0, nothing stored). Read paths stay model-free.
 */
export async function eventsForCommit(
  git: Git,
  cat: CatFile,
  commit: string,
  parents: string[],
  noteText: string,
): Promise<EntityEvent[]> {
  const records = parseNote(noteText);
  const stored = eventsIn(records);
  if (stored) return stored;
  const cached = records.find((r) => keyOf(r) === CHANGES_KEY)?.value as ChangesValue | undefined;
  const changes = cached?.paths && hasOldBlobs(cached.paths) ? cached.paths : await commitChanges(git, commit, parents);
  return computeEntityEvents(cat, await ownChanges(git, commit, parents, changes));
}

export interface CommitNote {
  commit: string;
  parents: string[];
  subject: string;
  committer: string;
  note: string;
}

/** Commits in a range (newest first) with their notes, in one git call. */
export async function commitsWithNotes(git: Git, range: string[], extra: string[] = []): Promise<CommitNote[]> {
  const out = (
    await git.run([
      "log",
      ...extra,
      ...notesArgs(),
      "--format=%H%x1f%P%x1f%s%x1f%ce%x1f%N%x1e",
      ...range,
      "--",
    ])
  ).stdout;
  const result: CommitNote[] = [];
  for (const raw of out.split("\x1e")) {
    const record = raw.replace(/^\n/, "");
    if (!record) continue;
    const [commit = "", parents = "", subject = "", committer = "", note = ""] = record.split("\x1f");
    result.push({ commit, parents: parents.split(" ").filter(Boolean), subject, committer, note });
  }
  return result;
}
