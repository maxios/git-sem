import { noteLines, type ArtifactRecord } from "./artifacts.ts";
import { CatFile, NotesBatch } from "./batch.ts";
import type { Git } from "./git.ts";
import { place, type SharePolicy } from "./sharing.ts";
import { LOCAL_NOTES_REF, NOTES_REF } from "./refs.ts";

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
    const edits: Array<{ object: string; shared: { add: string[]; remove: string[] }; local: { add: string[]; remove: string[] } }> = [];
    const objects = new Set(shared.objects());
    if (opts.scope === "all") for (const o of local.objects()) objects.add(o);

    for (const object of objects) {
      const sharedLines = await shared.lines(object);
      const localLines = await local.lines(object);
      // Judge every distinct record line once, whichever ref holds it. Lines
      // git-sem does not understand are never moved or removed.
      const byLine = new Map<string, ArtifactRecord>();
      for (const { line, record } of noteLines([...sharedLines, ...localLines].join("\n"))) {
        if (record) byLine.set(line, record);
      }
      const lineFor = new Map<ArtifactRecord, string>([...byLine].map(([l, r]) => [r, l]));
      const placement = place([...byLine.values()], policy);

      const inShared = new Set(sharedLines);
      const inLocal = new Set(localLines);
      const toShared = placement.shared.map((r) => lineFor.get(r)!);
      const toLocal = placement.local.map((r) => lineFor.get(r)!);
      const dropped = placement.dropped.map((r) => lineFor.get(r)!);

      for (const r of placement.local) if (inShared.has(lineFor.get(r)!)) count(stats.moved, r);
      for (const r of placement.dropped) count(stats.dropped, r);

      const sharedEdit = {
        add: toShared.filter((l) => !inShared.has(l)),
        remove: [...toLocal, ...dropped].filter((l) => inShared.has(l)),
      };
      const localEdit = {
        add: toLocal.filter((l) => !inLocal.has(l)),
        remove: [...toShared, ...dropped].filter((l) => inLocal.has(l)),
      };
      if (sharedEdit.add.length + sharedEdit.remove.length + localEdit.add.length + localEdit.remove.length) stats.objects++;
      edits.push({ object, shared: sharedEdit, local: localEdit });
    }
    if (!opts.dryRun) {
      // Two phases, so a record that moves between refs is never absent from
      // both, whichever direction it moves and wherever a crash happens.
      for (const e of edits) {
        shared.edit(e.object, { add: e.shared.add, remove: [] });
        local.edit(e.object, { add: e.local.add, remove: [] });
      }
      await local.flush();
      await shared.flush();
      for (const e of edits) {
        shared.edit(e.object, { add: [], remove: e.shared.remove });
        local.edit(e.object, { add: [], remove: e.local.remove });
      }
      await local.flush();
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
