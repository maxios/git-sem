import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { readConfig } from "../config.ts";
import { Queue } from "../queue.ts";
import { openRepo } from "../repo.ts";
import { NOTES_REF } from "../store.ts";

export async function statusCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { json: { type: "boolean" } } });
  const repo = await openRepo();
  const config = await readConfig(repo.git);
  const pending = await new Queue(repo.semDir).pending();
  const indexing = await readFile(join(repo.semDir, "index.lock"), "utf8").then(
    () => true,
    () => false,
  );
  const lastRun = await readFile(join(repo.semDir, "last-run.json"), "utf8").then(
    (t) => JSON.parse(t) as unknown,
    () => null,
  );
  const notes = await repo.git.resolve(NOTES_REF);

  const status = { pending: pending.length, indexing, notes: notes ?? null, config, lastRun };
  if (values.json) {
    console.log(JSON.stringify(status, null, 2));
    return 0;
  }
  console.log(`engine     ${config.engine}${config.model ? ` (${config.model})` : ""}`);
  console.log(`autoindex  ${config.autoindex ? "on" : "off"}`);
  console.log(`pending    ${pending.length} commit${pending.length === 1 ? "" : "s"}`);
  console.log(`indexing   ${indexing ? "running" : "idle"}`);
  console.log(`notes      ${notes ? `${NOTES_REF} @ ${notes.slice(0, 7)}` : "none yet"}`);
  return 0;
}
