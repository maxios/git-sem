import { parseArgs } from "node:util";
import { UserError } from "../errors.ts";
import { GitError, type Git } from "../git.ts";
import { applyPolicy } from "../prune.ts";
import { openRepo } from "../repo.ts";
import { NOTES_REF, readPolicy } from "../store.ts";

type FetchResult = "none" | "created" | "merged" | "reset";

function trackingRef(remote: string): string {
  return `refs/notes/sem-remotes/${remote}`;
}

async function fetchTracking(git: Git, remote: string): Promise<boolean> {
  const r = await git.run(["fetch", "--quiet", remote, `+${NOTES_REF}:${trackingRef(remote)}`], { allowFail: true });
  if (r.code === 0) return true;
  if (/couldn't find remote ref/i.test(r.stderr)) return false;
  throw new GitError(["fetch", remote], r);
}

/**
 * Bring a remote's semantics into the local store. Notes from both sides are
 * unioned (cat_sort_uniq): each record is one line, so nothing ever conflicts
 * and nobody's artifacts overwrite anybody else's. With `reset`, the local
 * shared ref is replaced by the remote's instead (after a teammate squashed it).
 */
async function fetchNotes(git: Git, remote: string, opts: { reset?: boolean } = {}): Promise<FetchResult> {
  if (!(await fetchTracking(git, remote))) return "none";
  const tracking = trackingRef(remote);
  const local = await git.resolve(NOTES_REF);
  if (!local || opts.reset) {
    await git.run(["update-ref", NOTES_REF, tracking]);
    return local ? "reset" : "created";
  }
  await git.run(["notes", "--ref", NOTES_REF, "merge", "--quiet", "--strategy=cat_sort_uniq", tracking]);
  return "merged";
}

/**
 * Share semantics. The merged notes are brought in line with the sharing
 * policy before every push: a union merge cannot express deletion, so this
 * is what keeps recomputable and superseded records from coming back (#9).
 */
async function pushNotes(git: Git, remote: string): Promise<void> {
  const policy = await readPolicy(git);
  for (let attempt = 1; ; attempt++) {
    await fetchNotes(git, remote);
    await applyPolicy(git, policy, { scope: "shared" });
    const r = await git.run(["push", "--quiet", remote, `${NOTES_REF}:${NOTES_REF}`], { allowFail: true });
    if (r.code === 0) {
      // The remote now has exactly what we pushed; remember it for leases.
      await git.run(["update-ref", trackingRef(remote), NOTES_REF]);
      return;
    }
    const raced = /rejected|non-fast-forward|fetch first/i.test(r.stderr);
    if (!raced || attempt >= 3) throw new GitError(["push", remote, NOTES_REF], r);
  }
}

/**
 * Replace the remote's shared ref with ours, e.g. after `prune --squash`.
 * Guarded by the value we last fetched: if a teammate pushed since, this
 * fails instead of discarding their work.
 */
async function forcePushNotes(git: Git, remote: string): Promise<void> {
  const seen = await git.resolve(trackingRef(remote));
  if (!seen) throw new UserError(`run \`git sem fetch ${remote}\` first, so the push can check nobody pushed since`);
  await applyPolicy(git, await readPolicy(git), { scope: "shared" });
  const r = await git.run(["push", "--quiet", `--force-with-lease=${NOTES_REF}:${seen}`, remote, `${NOTES_REF}:${NOTES_REF}`], {
    allowFail: true,
  });
  if (r.code !== 0) {
    if (/stale info|rejected/i.test(r.stderr)) {
      throw new UserError(`${remote} changed since your last fetch. Run \`git sem fetch ${remote}\`, then \`git sem prune --squash\` again.`);
    }
    throw new GitError(["push", "--force-with-lease", remote, NOTES_REF], r);
  }
  await git.run(["update-ref", trackingRef(remote), NOTES_REF]);
}

export async function fetchCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { reset: { type: "boolean" } } });
  const remote = positionals[0] ?? "origin";
  const repo = await openRepo();
  const result = await fetchNotes(repo.git, remote, { reset: values.reset });
  console.log(result === "none" ? `No semantics on ${remote} yet` : `Fetched semantics from ${remote} (${result})`);
  return 0;
}

export async function pushCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { "force-with-lease": { type: "boolean" } },
  });
  const remote = positionals[0] ?? "origin";
  const repo = await openRepo();
  if (!(await repo.git.resolve(NOTES_REF))) {
    throw new UserError(
      "nothing to share yet: refs/notes/sem holds what cannot be recomputed (intents from a model, an agent or a person, and decisions)",
    );
  }
  if (values["force-with-lease"]) await forcePushNotes(repo.git, remote);
  else await pushNotes(repo.git, remote);
  console.log(`Pushed semantics to ${remote}${values["force-with-lease"] ? " (replaced)" : ""}`);
  return 0;
}
