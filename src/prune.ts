import { mergeRecords, type ArtifactRecord } from "./artifacts.ts";
import { CatFile, NotesBatch } from "./batch.ts";
import type { Git } from "./git.ts";
import { place, type SharePolicy } from "./sharing.ts";
import { LOCAL_NOTES_REF, NOTES_REF } from "./store.ts";

export interface PruneStats {
  /** Recomputable records moved from the shared ref to the local one. */
  moved: Record<string, { records: number; bytes: number }>;
  /** Superseded records removed from both refs. */
  dropped: Record<string, { records: number; bytes: number }>;
  objects: number;
}

const bytesOf = (r: ArtifactRecord) => JSON.stringify(r).length + 1;
const label = (r: ArtifactRecord) => `${r.kind} ${r.prompt}${r.engine === "heuristic" ? " (heuristic)" : ""}`;

function count(into: PruneStats["moved"], r: ArtifactRecord): void {
  const k = label(r);
  const e = (into[k] ??= { records: 0, bytes: 0 });
  e.records++;
  e.bytes += bytesOf(r);
}

/**
 * Bring both notes refs in line with the sharing policy (#9):
 *
 *   - records that can be recomputed move from the shared ref to the local one
 *     (unless sem.share = derived)
 *   - superseded records are dropped: older formats once the current one
 *     exists, heuristic intents once a model, an agent or a person gave one
 *
 * Intents from models, agents and people, decisions and confirmed links are
 * never removed. `scope: "shared"` only looks at objects in the shared ref,
 * which is what push needs; `"all"` also cleans the local ref.
 */
export async function applyPolicy(
  git: Git,
  policy: SharePolicy,
  opts: { scope: "shared" | "all"; dryRun?: boolean },
): Promise<PruneStats> {
  const stats: PruneStats = { moved: {}, dropped: {}, objects: 0 };
  const cat = new CatFile(git.cwd);
  const shared = await NotesBatch.open(git, NOTES_REF, cat);
  const local = await NotesBatch.open(git, LOCAL_NOTES_REF, cat);
  try {
    const objects = new Set(shared.objects());
    if (opts.scope === "all") for (const o of local.objects()) objects.add(o);

    for (const object of objects) {
      const inShared = await shared.read(object);
      const inLocal = await local.read(object);
      const placement = place(mergeRecords(inShared, inLocal), policy);
      const sharedKeys = new Set(inShared.map((r) => JSON.stringify(r)));
      for (const r of placement.local) if (sharedKeys.has(JSON.stringify(r))) count(stats.moved, r);
      for (const r of placement.dropped) count(stats.dropped, r);

      const changedShared = await shared.replace(object, placement.shared);
      const changedLocal = await local.replace(object, placement.local);
      if (changedShared || changedLocal) stats.objects++;
    }
    if (!opts.dryRun) {
      await local.flush(); // local first: a moved record is never absent from both
      await shared.flush();
    }
  } finally {
    await cat.close();
  }
  return stats;
}

/**
 * Replace a notes ref's history with a single commit holding its current
 * tree. Earlier snapshots of the notes have little value and most of the
 * bytes. The update is guarded by the ref's current value.
 */
export async function squashRef(git: Git, ref: string): Promise<boolean> {
  const tip = await git.resolve(ref);
  if (!tip) return false;
  const parents = (await git.out(["rev-list", "--count", tip, "--"])) ?? "1";
  if (parents === "1") return false;
  const tree = await git.out(["rev-parse", `${tip}^{tree}`]);
  const squashed = await git.out(["commit-tree", tree, "-m", "git-sem: squashed notes"]);
  await git.run(["update-ref", ref, squashed, tip]);
  return true;
}

export function totals(stats: PruneStats["moved"]): { records: number; bytes: number } {
  return Object.values(stats).reduce((a, b) => ({ records: a.records + b.records, bytes: a.bytes + b.bytes }), { records: 0, bytes: 0 });
}
