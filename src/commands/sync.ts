import { parseArgs } from "node:util";
import { UserError } from "../errors.ts";
import { GitError, type Git } from "../git.ts";
import { openRepo } from "../repo.ts";
import { NOTES_REF } from "../store.ts";

type FetchResult = "none" | "created" | "merged";

function trackingRef(remote: string): string {
  return `refs/notes/sem-remotes/${remote}`;
}

/**
 * Bring a remote's semantics into the local store. Notes from both sides are
 * unioned (cat_sort_uniq): each record is one line, so nothing ever conflicts
 * and nobody's artifacts overwrite anybody else's.
 */
async function fetchNotes(git: Git, remote: string): Promise<FetchResult> {
  const tracking = trackingRef(remote);
  const r = await git.run(["fetch", "--quiet", remote, `+${NOTES_REF}:${tracking}`], { allowFail: true });
  if (r.code !== 0) {
    if (/couldn't find remote ref/i.test(r.stderr)) return "none";
    throw new GitError(["fetch", remote], r);
  }

  const local = await git.resolve(NOTES_REF);
  if (!local) {
    await git.run(["update-ref", NOTES_REF, tracking]);
    return "created";
  }
  await git.run(["notes", "--ref", NOTES_REF, "merge", "--quiet", "--strategy=cat_sort_uniq", tracking]);
  return "merged";
}

async function pushNotes(git: Git, remote: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    await fetchNotes(git, remote);
    const r = await git.run(["push", "--quiet", remote, `${NOTES_REF}:${NOTES_REF}`], { allowFail: true });
    if (r.code === 0) return;
    const raced = /rejected|non-fast-forward|fetch first/i.test(r.stderr);
    if (!raced || attempt >= 3) throw new GitError(["push", remote, NOTES_REF], r);
  }
}

function remoteArg(args: string[]): string {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  return positionals[0] ?? "origin";
}

export async function fetchCommand(args: string[]): Promise<number> {
  const remote = remoteArg(args);
  const repo = await openRepo();
  const result = await fetchNotes(repo.git, remote);
  console.log(
    result === "none" ? `No semantics on ${remote} yet` : `Fetched semantics from ${remote} (${result})`,
  );
  return 0;
}

export async function pushCommand(args: string[]): Promise<number> {
  const remote = remoteArg(args);
  const repo = await openRepo();
  if (!(await repo.git.resolve(NOTES_REF))) throw new UserError("nothing to push: no semantics indexed yet");
  await pushNotes(repo.git, remote);
  console.log(`Pushed semantics to ${remote}`);
  return 0;
}
