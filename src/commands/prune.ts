import { parseArgs } from "node:util";
import { applyPolicy, squashRef, totals, type PruneStats } from "../prune.ts";
import { openRepo } from "../repo.ts";
import { LOCAL_NOTES_REF, NOTES_REF, readPolicy } from "../store.ts";

function kb(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function table(title: string, rows: PruneStats["moved"]): void {
  const entries = Object.entries(rows).sort((a, b) => b[1].bytes - a[1].bytes);
  if (entries.length === 0) return;
  const t = totals(rows);
  console.log(`${title}: ${t.records} records, ${kb(t.bytes)}`);
  for (const [k, v] of entries) console.log(`  ${k.padEnd(34)} ${String(v.records).padStart(6)}  ${kb(v.bytes).padStart(9)}`);
}

/**
 * Keep refs/notes/sem to what a team needs to share (#9).
 *
 *   git sem prune              move recomputable records to the local ref,
 *                              drop superseded ones, squash the local ref
 *   git sem prune --dry-run    show what would change
 *   git sem prune --squash     also squash the shared ref's history; share
 *                              it with `git sem push --force-with-lease`
 */
export async function pruneCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { "dry-run": { type: "boolean" }, squash: { type: "boolean" }, json: { type: "boolean" } },
  });
  const repo = await openRepo();
  const policy = await readPolicy(repo.git);
  const dryRun = values["dry-run"] === true;
  const stats = await applyPolicy(repo.git, policy, { scope: "all", dryRun });

  const squashed: string[] = [];
  if (!dryRun) {
    // The local ref is never shared, so its history can always go.
    if (await squashRef(repo.git, LOCAL_NOTES_REF)) squashed.push(LOCAL_NOTES_REF);
    if (values.squash && (await squashRef(repo.git, NOTES_REF))) squashed.push(NOTES_REF);
  }

  if (values.json) {
    console.log(JSON.stringify({ dryRun, policy, ...stats, squashed }, null, 2));
    return 0;
  }
  const moved = totals(stats.moved);
  const dropped = totals(stats.dropped);
  if (moved.records === 0 && dropped.records === 0) console.log("Nothing to prune: shared notes hold only what cannot be recomputed.");
  table(dryRun ? "Would move to local notes" : "Moved to local notes", stats.moved);
  table(dryRun ? "Would drop (superseded)" : "Dropped (superseded)", stats.dropped);
  if (squashed.length) console.log(`Squashed history of ${squashed.join(", ")}`);
  if (squashed.includes(NOTES_REF)) {
    console.log("Share it with `git sem push --force-with-lease`; teammates then run `git sem fetch --reset`.");
  } else if (!dryRun && moved.records + dropped.records > 0) {
    console.log("The next `git sem push` shares the cleaned notes.");
  }
  return 0;
}
