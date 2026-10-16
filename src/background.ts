import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Progress } from "./indexer.ts";
import { spawnText } from "./proc.ts";

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/**
 * Start `git sem index --background` fully detached (double fork via a
 * subshell), so the caller can exit immediately and the indexer survives it.
 * Uses this process's own runtime and entry point, so it works even when
 * `git-sem` is not on PATH.
 */
export async function startBackgroundIndexer(cwd: string): Promise<void> {
  const cmd = `${shellQuote(process.execPath)} ${shellQuote(Bun.main)} index --background`;
  await spawnText(["sh", "-c", `(${cmd} </dev/null >/dev/null 2>&1 &)`], { cwd });
}

export interface ProgressFile {
  done: number;
  total: number;
  updatedAt: string;
}

/**
 * Report progress to sem/progress.json (for `git sem status`) and, when
 * attached to a terminal, as a single updating line on stderr.
 */
export function progressReporter(semDir: string, toTerminal: boolean): { report: Progress; finish: () => void } {
  const file = join(semDir, "progress.json");
  let lastWrite = 0;
  let drew = false;
  return {
    report(done, total) {
      const now = Date.now();
      if (done !== total && now - lastWrite < 200) return;
      lastWrite = now;
      const body: ProgressFile = { done, total, updatedAt: new Date(now).toISOString() };
      writeFileSync(file, JSON.stringify(body));
      if (toTerminal) {
        process.stderr.write(`\rindexing ${done}/${total}`);
        drew = true;
      }
    },
    finish() {
      rmSync(file, { force: true });
      if (drew) process.stderr.write("\n");
    },
  };
}
