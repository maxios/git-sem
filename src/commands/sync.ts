import { parseArgs } from "node:util";
import { UserError } from "../errors.ts";
import { GitError, type Git } from "../git.ts";
import { noteLines } from "../artifacts.ts";
import { CatFile, NotesBatch } from "../batch.ts";
import { applyPolicy } from "../prune.ts";
import { isRecomputable } from "../sharing.ts";
import { openRepo } from "../repo.ts";
import { NOTES_REF, readPolicy } from "../store.ts";

interface FetchResult {
  result: "none" | "created" | "merged" | "reset";
}

function trackingRef(remote: string): string {
  return `refs/notes/sem-remotes/${remote}`;
}

function incomingRef(remote: string): string {
  return `refs/notes/sem-incoming/${remote}`;
}

/** Fetch the remote's shared notes into a staging ref. False if the remote has none. */
async function fetchIncoming(git: Git, remote: string): Promise<boolean> {
  const r = await git.run(["fetch", "--quiet", remote, `+${NOTES_REF}:${incomingRef(remote)}`], { allowFail: true });
  if (r.code === 0) return true;
  if (/couldn't find remote ref/i.test(r.stderr)) return false;
  throw new GitError(["fetch", remote], r);
}

/**
 * Lines in `before` that `after` lacks and that cannot be recomputed:
 * intents from a model, an agent or a person, decisions, links, and lines
 * git-sem does not understand (it cannot know they are safe to drop).
 */
async function unpushedJudgment(git: Git, before: string, after: string): Promise<Map<string, string[]>> {
  const cat = new CatFile(git.cwd);
  const keep = new Map<string, string[]>();
  try {
    const old = await NotesBatch.open(git, NOTES_REF, cat, before);
    const now = await NotesBatch.open(git, NOTES_REF, cat, after);
    for (const object of old.objects()) {
      const present = new Set(await now.lines(object));
      const missing = noteLines((await old.lines(object)).join("\n")).filter(
        (l) => !present.has(l.line) && (!l.record || !isRecomputable(l.record)),
      );
      if (missing.length) keep.set(object, missing.map((l) => l.line));
    }
  } finally {
    await cat.close();
  }
  return keep;
}

/**
 * Bring a remote's semantics into the local store. Notes from both sides are
 * unioned (cat_sort_uniq): each record is one line, so nothing ever conflicts
 * and nobody's artifacts overwrite anybody else's.
 *
 * With `reset` (after a teammate squashed the shared notes) the local ref
 * takes the remote's history, but anything of yours that cannot be
 * recomputed and that the remote lacks is carried over, so the next push
 * shares it instead of losing it.
 *
 * The tracking ref only moves once the merge or reset has succeeded, so a
 * lease can never approve notes that were not taken in.
 */
async function fetchNotes(git: Git, remote: string, opts: { reset?: boolean } = {}): Promise<FetchResult & { kept: number }> {
  if (!(await fetchIncoming(git, remote))) return { result: "none", kept: 0 };
  const incoming = incomingRef(remote);
  const theirs = (await git.resolve(incoming))!;
  const local = await git.resolve(NOTES_REF);
  let result: FetchResult["result"];
  let kept = 0;

  if (!local) {
    await git.run(["update-ref", NOTES_REF, theirs]);
    result = "created";
  } else if (opts.reset) {
    const carry = await unpushedJudgment(git, local, theirs);
    await git.run(["update-ref", NOTES_REF, theirs, local]);
    if (carry.size) {
      const batch = await NotesBatch.open(git, NOTES_REF);
      for (const [object, lines] of carry) {
        batch.edit(object, { add: lines, remove: [] });
        kept += lines.length;
      }
      await batch.close();
    }
    result = "reset";
  } else {
    await git.run(["notes", "--ref", NOTES_REF, "merge", "--quiet", "--strategy=cat_sort_uniq", incoming]);
    result = "merged";
  }
  await git.run(["update-ref", trackingRef(remote), theirs]);
  await git.run(["update-ref", "-d", incoming]);
  return { result, kept };
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
  const { result, kept } = await fetchNotes(repo.git, remote, { reset: values.reset });
  console.log(result === "none" ? `No semantics on ${remote} yet` : `Fetched semantics from ${remote} (${result})`);
  if (kept) console.log(`Kept ${kept} record${kept === 1 ? "" : "s"} of yours that ${remote} did not have; \`git sem push\` shares them.`);
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
