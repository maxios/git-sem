import { parseArgs } from "node:util";
import { resolveIntent, type ArtifactRecord } from "../artifacts.ts";
import { readConfig } from "../config.ts";
import { buildDraft } from "../draft.ts";
import { resolveEngine } from "../engines/index.ts";
import { UserError } from "../errors.ts";
import { acceptProposal, proposeAsAgent, resolveCommit, rollupBranch, setIntent } from "../intents.ts";
import { openRepo } from "../repo.ts";
import { ArtifactStore } from "../store.ts";
import { authorOf, currentIdentity } from "./context.ts";
import { intentBadge, intentView } from "./format.ts";

/**
 * Capture the "why" of a change.
 *
 *   git sem intent --staged                    propose an intent for staged changes (nothing stored)
 *   git sem intent [<rev>]                     show the current intent
 *   git sem intent <rev> --set TEXT            record your own intent (authoritative)
 *   git sem intent <rev> --accept              adopt the engine's proposal as yours
 *   git sem intent <rev> --propose TEXT --agent ID
 *                                              record an agent's proposal (stays a proposal)
 *   git sem intent <rev> --accept --agent ID   adopt that agent's proposal
 *   git sem intent --branch NAME [--base REF]  one intent for a whole branch
 */
export async function intentCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      staged: { type: "boolean" },
      set: { type: "string" },
      accept: { type: "boolean" },
      propose: { type: "string" },
      agent: { type: "string" },
      confidence: { type: "string" },
      branch: { type: "string" },
      base: { type: "string" },
      json: { type: "boolean" },
    },
  });

  const repo = await openRepo();
  const modes = [values.staged, values.set !== undefined, values.accept, values.propose !== undefined, values.branch !== undefined].filter(Boolean);
  if (modes.length > 1) throw new UserError("use only one of --staged, --set, --accept, --propose, --branch");

  if (values.staged) {
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

  if (values.branch !== undefined) {
    const rollup = await rollupBranch(repo, values.branch, values.base, await currentIdentity(repo));
    if (values.json) {
      console.log(JSON.stringify(rollup, null, 2));
      return 0;
    }
    const model = rollup.model === "none" ? rollup.engine : rollup.model;
    console.log(`Branch intent: ${rollup.text}  [inferred ${model} · ${rollup.confidence.toFixed(2)}]`);
    console.log(`  ${rollup.branch} vs ${rollup.base}: ${rollup.commits} commits, ${rollup.intents.length} with intents${rollup.pending ? `, ${rollup.pending} pending` : ""}`);
    return 0;
  }

  const commit = await resolveCommit(repo.git, positionals[0] ?? "HEAD");
  const current = await currentIdentity(repo);

  if (values.set !== undefined) {
    print(values.json, await setIntent(repo.git, commit, values.set, await authorOf(repo.git), current));
    return 0;
  }
  if (values.propose !== undefined) {
    if (!values.agent) throw new UserError("--propose needs --agent <id>");
    const confidence = values.confidence === undefined ? undefined : Number(values.confidence);
    print(values.json, await proposeAsAgent(repo.git, commit, values.propose, values.agent, confidence));
    return 0;
  }
  if (values.accept) {
    print(values.json, await acceptProposal(repo.git, commit, await authorOf(repo.git), { current, agent: values.agent }));
    return 0;
  }

  print(values.json, resolveIntent(await new ArtifactStore(repo.git).read(commit), current));
  return 0;
}

function print(json: boolean | undefined, record: ArtifactRecord | undefined): void {
  const view = intentView(record);
  if (json) console.log(JSON.stringify(view, null, 2));
  else console.log(view ? `${view.text}  ${intentBadge(view)}` : "pending");
}
