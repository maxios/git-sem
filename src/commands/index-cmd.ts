import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { readConfig } from "../config.ts";
import { resolveEngine } from "../engines/index.ts";
import { UserError } from "../errors.ts";
import type { Git } from "../git.ts";
import { addStats, emptyStats, Indexer, type IndexStats } from "../indexer.ts";
import { tryLock, waitLock } from "../lock.ts";
import { Queue } from "../queue.ts";
import { openRepo } from "../repo.ts";
import { short } from "./format.ts";

async function revList(git: Git, args: string[]): Promise<string[]> {
  const out = await git.out(["rev-list", "--reverse", ...args]);
  return out ? out.split("\n") : [];
}

async function drain(queue: Queue, indexer: Indexer, total: IndexStats): Promise<void> {
  for (;;) {
    const batch = await queue.claim();
    if (batch.length === 0) return;
    const stats = await indexer.run(batch);
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
  const engine = resolveEngine(await readConfig(repo.git), repo.root);
  const indexer = new Indexer(repo.git, engine);
  const queue = new Queue(repo.semDir);
  const lockPath = join(repo.semDir, "index.lock");

  let explicit: string[] | undefined;
  if (values.all) explicit = await revList(repo.git, ["HEAD"]);
  else if (values.since) explicit = await revList(repo.git, [`${values.since}..HEAD`]);
  if (values.rev?.length) explicit = [...(explicit ?? []), ...values.rev];

  const total = emptyStats(engine);

  if (values.background) {
    // Started by the hook: never wait. If another indexer holds the lock it
    // will pick up our entry; re-check after releasing to close the gap.
    for (;;) {
      const release = await tryLock(lockPath);
      if (!release) return 0;
      try {
        await drain(queue, indexer, total);
        await writeFile(join(repo.semDir, "last-run.json"), JSON.stringify(total, null, 2));
      } finally {
        await release();
      }
      if (!(await queue.hasNew())) return 0;
    }
  }

  const release = await waitLock(lockPath, 60_000);
  if (!release) throw new UserError("another git-sem index is still running; try again shortly");
  try {
    if (explicit) addStats(total, await indexer.run(explicit));
    else await drain(queue, indexer, total);
    await writeFile(join(repo.semDir, "last-run.json"), JSON.stringify(total, null, 2));
  } finally {
    await release();
  }

  if (values.json) console.log(JSON.stringify(total, null, 2));
  else if (!values.quiet) report(total);
  for (const f of total.failed) console.error(`failed  ${short(f.commit)}  ${f.error}`);
  return total.failed.length ? 1 : 0;
}
