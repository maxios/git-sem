import { parseArgs } from "node:util";
import { intentKeyFor, keyOf, now, resolveIntent, type ArtifactRecord } from "../artifacts.ts";
import { readConfig } from "../config.ts";
import { buildDraft } from "../draft.ts";
import { resolveEngine } from "../engines/index.ts";
import { UserError } from "../errors.ts";
import { openRepo } from "../repo.ts";
import { ArtifactStore } from "../store.ts";
import { authorOf, currentIdentity } from "./context.ts";
import { intentBadge, intentView } from "./format.ts";

function authoredRecord(object: string, text: string, author: string, evidence: string[]): ArtifactRecord {
  return {
    v: 1,
    kind: "intent",
    object,
    source: "authored",
    engine: "human",
    model: "none",
    prompt: "none",
    tier: 0,
    confidence: 1,
    value: { text },
    evidence,
    author,
    createdAt: now(),
  };
}

/**
 * Capture the "why" of a change.
 *
 *   git sem intent --staged          propose an intent for staged changes (nothing stored)
 *   git sem intent [<rev>]           show the current intent
 *   git sem intent <rev> --set TEXT  record your own intent (authoritative)
 *   git sem intent <rev> --accept    adopt the inferred proposal as authored
 */
export async function intentCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      staged: { type: "boolean" },
      set: { type: "string" },
      accept: { type: "boolean" },
      json: { type: "boolean" },
    },
  });

  const repo = await openRepo();

  if (values.staged) {
    if (positionals.length || values.set !== undefined || values.accept) {
      throw new UserError("--staged cannot be combined with a revision, --set or --accept");
    }
    const engine = resolveEngine(await readConfig(repo.git), repo.root);
    const draft = await buildDraft(repo.git, engine);
    if (!draft) throw new UserError("nothing staged");
    if (values.json) {
      console.log(JSON.stringify(draft, null, 2));
      return 0;
    }
    const { proposal } = draft;
    console.log(`Proposed intent: ${proposal.text}`);
    console.log(
      `  confidence ${proposal.confidence.toFixed(2)} · engine=${engine.id} model=${engine.model} prompt=${engine.promptVersion}`,
    );
    for (const r of draft.reversals) console.log(`  WARNING: reverts ${r.commit.slice(0, 7)} "${r.subject}" on ${r.path}`);
    for (const q of draft.questions) console.log(`  ? ${q}`);
    console.log("  Not stored. Use `git sem commit` to commit with this draft.");
    return 0;
  }

  if (values.set !== undefined && values.accept) throw new UserError("use either --set or --accept, not both");

  const rev = positionals[0] ?? "HEAD";
  const commit = await repo.git.resolve(`${rev}^{commit}`);
  if (!commit) throw new UserError(`unknown commit: ${rev}`);

  const store = new ArtifactStore(repo.git);
  const records = await store.read(commit);
  const identity = await currentIdentity(repo);

  if (values.set !== undefined) {
    const text = values.set.trim();
    if (!text) throw new UserError("--set needs a non-empty intent");
    const proposal = resolveIntent(records.filter((r) => r.source === "inferred"), identity);
    const evidence = [commit, ...(proposal ? [keyOf(proposal)] : [])];
    const record = authoredRecord(commit, text, await authorOf(repo.git), evidence);
    await store.add(commit, [record]);
    print(values.json, record);
    return 0;
  }

  if (values.accept) {
    const inferred = records.filter((r) => r.kind === "intent" && r.source === "inferred");
    const preferred = identity ? inferred.find((r) => keyOf(r) === intentKeyFor(identity)) : undefined;
    const proposal = preferred ?? resolveIntent(inferred);
    const text = (proposal?.value as { text?: string } | undefined)?.text;
    if (!proposal || !text) throw new UserError(`no proposal for ${rev} yet; run \`git sem index\` first`);
    const record = authoredRecord(commit, text, await authorOf(repo.git), [commit, keyOf(proposal)]);
    await store.add(commit, [record]);
    print(values.json, record);
    return 0;
  }

  print(values.json, resolveIntent(records, identity));
  return 0;
}

function print(json: boolean | undefined, record: ArtifactRecord | undefined): void {
  const view = intentView(record);
  if (json) console.log(JSON.stringify(view, null, 2));
  else console.log(view ? `${view.text}  ${intentBadge(view)}` : "pending");
}
