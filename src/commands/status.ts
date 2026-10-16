import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { ProgressFile } from "../background.ts";
import { readConfig } from "../config.ts";
import { Queue } from "../queue.ts";
import { openRepo } from "../repo.ts";
import { NOTES_REF } from "../store.ts";

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export async function statusCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { json: { type: "boolean" } } });
  const repo = await openRepo();
  const config = await readConfig(repo.git);
  const pending = await new Queue(repo.semDir).pending();
  const indexing = (await readFile(join(repo.semDir, "index.lock"), "utf8").catch(() => null)) !== null;
  const progress = indexing ? await readJson<ProgressFile>(join(repo.semDir, "progress.json")) : null;
  const lastRun = await readJson<unknown>(join(repo.semDir, "last-run.json"));
  const notes = await repo.git.resolve(NOTES_REF);

  if (values.json) {
    console.log(JSON.stringify({ pending: pending.length, indexing, progress, notes: notes ?? null, config, lastRun }, null, 2));
    return 0;
  }
  const running = progress ? `running (${progress.done}/${progress.total})` : "running";
  console.log(`engine     ${config.engine}${config.model ? ` (${config.model})` : ""}`);
  console.log(`autoindex  ${config.autoindex ? "on" : "off"}`);
  console.log(`pending    ${pending.length} commit${pending.length === 1 ? "" : "s"}`);
  console.log(`indexing   ${indexing ? running : "idle"}`);
  console.log(`notes      ${notes ? `${NOTES_REF} @ ${notes.slice(0, 7)}` : "none yet"}`);
  return 0;
}
