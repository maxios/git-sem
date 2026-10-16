import { parseArgs } from "node:util";
import { keyOf, parseNote, resolveIntent, type ChangeEntry, type ChangesValue } from "../artifacts.ts";
import { firstLine } from "../draft.ts";
import { CHANGES_KEY } from "../indexer.ts";
import { openRepo, type Repo } from "../repo.ts";
import { NOTES_REF } from "../store.ts";
import { currentIdentity } from "./context.ts";
import { intentBadge, intentView, short, type IntentView } from "./format.ts";

export interface LogEntry {
  commit: string;
  subject: string;
  status: "indexed" | "pending";
  intent: IntentView | null;
  paths: ChangeEntry[];
}

/**
 * History by meaning. Pure lookup: one `git log` call reads commits and their
 * notes together. No engine is ever invoked, and commits that are not indexed
 * yet are shown as pending instead of being waited for.
 */
export async function readLog(repo: Repo, range: string[] = [], maxCount?: number): Promise<LogEntry[]> {
  if (!(await repo.git.resolve("HEAD"))) return [];
  const gitArgs = ["log", "--no-notes", `--notes=${NOTES_REF}`, "--format=%H%x1f%s%x1f%N%x1e"];
  if (maxCount !== undefined) gitArgs.push(`--max-count=${maxCount}`);
  gitArgs.push(...(range.length ? range : ["HEAD"]), "--");

  const out = (await repo.git.run(gitArgs)).stdout;
  const identity = await currentIdentity(repo);
  const entries: LogEntry[] = [];
  for (const raw of out.split("\x1e")) {
    const record = raw.replace(/^\n/, "");
    if (!record) continue;
    const [commit = "", subject = "", note = ""] = record.split("\x1f");
    const records = parseNote(note);
    const intent = resolveIntent(records, identity);
    const changes = records.find((r) => keyOf(r) === CHANGES_KEY)?.value as ChangesValue | undefined;
    entries.push({
      commit,
      subject,
      status: intent ? "indexed" : "pending",
      intent: intentView(intent),
      paths: changes?.paths ?? [],
    });
  }
  return entries;
}

export async function logCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      "max-count": { type: "string", short: "n" },
      json: { type: "boolean" },
    },
  });

  const repo = await openRepo();
  const max = values["max-count"] === undefined ? undefined : Number(values["max-count"]);
  const entries = await readLog(repo, positionals, max);

  if (values.json) {
    console.log(JSON.stringify(entries, null, 2));
    return 0;
  }

  for (const e of entries) {
    if (!e.intent) {
      console.log(`${short(e.commit)}  pending  ${e.subject}`);
      continue;
    }
    console.log(`${short(e.commit)}  ${firstLine(e.intent.text)}  ${intentBadge(e.intent)}`);
    for (const p of e.paths) {
      console.log(`         ${p.status} ${p.from ? `${p.from} -> ` : ""}${p.path}`);
    }
  }
  return 0;
}
