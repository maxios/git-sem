import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { progressReporter, startBackgroundIndexer } from "../background.ts";
import { resolveCommits } from "../batch.ts";
import { readConfig } from "../config.ts";
import { resolveEngine } from "../engines/index.ts";
import { UserError } from "../errors.ts";
import type { Git } from "../git.ts";
import { addStats, emptyStats, Indexer, type IndexStats, type Progress } from "../indexer.ts";
import { tryLock, waitLock } from "../lock.ts";
import { Queue } from "../queue.ts";
import { openRepo, type Repo } from "../repo.ts";
import { short } from "./format.ts";

export async function revList(git: Git, args: string[]): Promise<string[]> {
  const out = await git.out(["rev-list", "--reverse", ...args]);
  return out ? out.split("\n") : [];
}

async function drain(queue: Queue, indexer: Indexer, total: IndexStats, progress: Progress): Promise<void> {
  for (;;) {
    const batch = await queue.claim();
    if (batch.length === 0) return;
    const stats = await indexer.run(batch, progress);
    addStats(total, stats);
    await queue.settle(stats.failed.map((f) => f.commit));
    if (!(await queue.hasNew())) return;
  }
}

function report(stats: IndexStats): void {
  const { commits, intents, files } = stats;
  if (commits === 0 && stats.failed.length === 0) {
    console.log("Nothing to index");
    return;
  }
  console.log(
    `Indexed ${commits} commit${commits === 1 ? "" : "s"}` +
      ` · intents: ${intents.computed} computed, ${intents.reused} reused` +
      ` · files: ${files.computed} computed, ${files.reused} reused`,
  );
}

/** Queue commits and hand them to a detached indexer. Returns immediately. */
export async function enqueueInBackground(repo: Repo, commits: string[]): Promise<number> {
  await new Queue(repo.semDir).enqueue(commits);
  await startBackgroundIndexer(repo.root);
  return commits.length;
}

export async function indexCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      rev: { type: "string", multiple: true },
      since: { type: "string" },
      all: { type: "boolean" },
      background: { type: "boolean" },
      json: { type: "boolean" },
      quiet: { type: "boolean", short: "q" },
    },
  });

  const repo = await openRepo();
  const queue = new Queue(repo.semDir);
  const lockPath = join(repo.semDir, "index.lock");

  let explicit: string[] | undefined;
  if (values.all) explicit = await revList(repo.git, ["HEAD"]);
  else if (values.since) explicit = await revList(repo.git, [`${values.since}..HEAD`]);
  if (values.rev?.length) explicit = [...(explicit ?? []), ...values.rev];

  if (values.background && explicit) {
    // Pin names like HEAD to ids now; they may move before the indexer runs.
    const resolved = await resolveCommits(repo.git, explicit);
    const missing = explicit.filter((rev) => !resolved.get(rev));
    if (missing.length) throw new UserError(`not a commit: ${missing.join(", ")}`);
    const n = await enqueueInBackground(repo, explicit.map((rev) => resolved.get(rev)!));
    if (!values.quiet) {
      console.log(`Queued ${n} commit${n === 1 ? "" : "s"}; indexing in the background. See \`git sem status\`.`);
    }
    return 0;
  }

  const engine = resolveEngine(await readConfig(repo.git), repo.root);
  const indexer = new Indexer(repo.git, engine);
  const total = emptyStats(engine);
  const progress = progressReporter(repo.semDir, !values.background && !values.quiet && !values.json && process.stderr.isTTY);

  if (values.background) {
    // Started by the hook or by enqueueInBackground: never wait. If another
    // indexer holds the lock it will pick up our entries; re-check after
    // releasing to close the gap.
    for (;;) {
      const release = await tryLock(lockPath);
      if (!release) return 0;
      try {
        await drain(queue, indexer, total, progress.report);
        await writeFile(join(repo.semDir, "last-run.json"), JSON.stringify(total, null, 2));
      } finally {
        progress.finish();
        await release();
      }
      if (!(await queue.hasNew())) return 0;
    }
  }

  const release = await waitLock(lockPath, 60_000);
  if (!release) throw new UserError("another git-sem index is still running; try again shortly");
  try {
    if (explicit) addStats(total, await indexer.run(explicit, progress.report));
    else await drain(queue, indexer, total, progress.report);
    await writeFile(join(repo.semDir, "last-run.json"), JSON.stringify(total, null, 2));
  } finally {
    progress.finish();
    await release();
  }

  if (values.json) console.log(JSON.stringify(total, null, 2));
  else if (!values.quiet) report(total);
  for (const f of total.failed) console.error(`failed  ${short(f.commit)}  ${f.error}`);
  return total.failed.length ? 1 : 0;
}
