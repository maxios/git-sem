import { appendFile, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

async function readLines(path: string): Promise<string[]> {
  try {
    return (await readFile(path, "utf8")).split("\n").map((l) => l.trim()).filter(Boolean);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

function unique(lines: string[]): string[] {
  return [...new Set(lines)];
}

/**
 * The commit queue the post-commit hook writes to.
 *
 *   queue             appended by the hook (plain shell, no locking)
 *   queue.processing  owned by the indexer while it works
 *
 * The indexer claims work by atomically renaming `queue`, so a hook appending
 * at the same moment simply starts a fresh `queue` file and nothing is lost.
 */
export class Queue {
  readonly file: string;
  readonly processing: string;

  constructor(semDir: string) {
    this.file = join(semDir, "queue");
    this.processing = join(semDir, "queue.processing");
  }

  /** Everything not yet indexed: claimed but unfinished work plus new entries. */
  async pending(): Promise<string[]> {
    return unique([...(await readLines(this.processing)), ...(await readLines(this.file))]);
  }

  async hasNew(): Promise<boolean> {
    return (await readLines(this.file)).length > 0;
  }

  async enqueue(commits: string[]): Promise<void> {
    if (commits.length) await appendFile(this.file, `${commits.join("\n")}\n`);
  }

  /** Move new entries into the processing file and return all claimed work. Call under the index lock. */
  async claim(): Promise<string[]> {
    const staging = `${this.file}.claim-${process.pid}`;
    try {
      await rename(this.file, staging);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      return unique(await readLines(this.processing));
    }
    const fresh = await readLines(staging);
    if (fresh.length) await appendFile(this.processing, `${fresh.join("\n")}\n`);
    await rm(staging, { force: true });
    return unique(await readLines(this.processing));
  }

  /** Finish a claimed batch; failed commits stay claimed for the next run. */
  async settle(failed: string[]): Promise<void> {
    if (failed.length) await writeFile(this.processing, `${unique(failed).join("\n")}\n`);
    else await rm(this.processing, { force: true });
  }
}
