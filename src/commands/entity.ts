import { parseArgs } from "node:util";
import { now, type ArtifactRecord } from "../artifacts.ts";
import { UserError } from "../errors.ts";
import { entityLineage, entityWorlds, explainEntity, findAmbiguity, type LineageStep } from "../lineage.ts";
import { openRepo } from "../repo.ts";
import { ArtifactStore } from "../store.ts";
import { authorOf, currentIdentity } from "./context.ts";
import { short } from "./format.ts";

function describe(s: LineageStep): string {
  const intent = s.intent ? `  "${s.intent.text.split("\n")[0]}" [${s.intent.source}]` : "";
  switch (s.type) {
    case "renamed":
    case "moved": {
      const what = s.from?.name !== s.name ? `${s.from?.name} -> ${s.name}` : s.name;
      const where = s.from?.path !== s.path ? `${s.from?.path} -> ${s.path}` : s.path;
      const how = s.confirmed ? "confirmed by you" : `score ${s.score?.toFixed(2)}, tier ${s.tier}`;
      return `${s.type} ${what}  ${where}  (${how})${intent}`;
    }
    case "ambiguous":
      return `ambiguous: ${s.from?.name} (${s.from?.path}) became one of${intent}`;
    default:
      return `${s.type}  ${s.path}${intent}`;
  }
}

/**
 * Follow a function, class or method through history.
 *
 *   git sem entity <name>                          lineage across renames and moves
 *   git sem entity <name> --worlds                 the entity on every branch
 *   git sem entity confirm <commit> <from> <to>    settle an ambiguous succession
 */
export async function entityCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { worlds: { type: "boolean" }, json: { type: "boolean" } },
  });
  const repo = await openRepo();

  if (positionals[0] === "confirm") {
    const [, rev, from, to] = positionals;
    if (!rev || !from || !to) throw new UserError("usage: git sem entity confirm <commit> <from> <to>");
    const commit = await repo.git.resolve(`${rev}^{commit}`);
    if (!commit) throw new UserError(`unknown commit: ${rev}`);
    const link = await findAmbiguity(repo.git, commit, from, to);
    if (!link) throw new UserError(`${short(commit)} has no ambiguous succession from ${from} to ${to}`);
    const record: ArtifactRecord = {
      v: 1,
      kind: "entity-link",
      object: commit,
      source: "authored",
      engine: "human",
      model: "none",
      prompt: "none",
      tier: 0,
      confidence: 1,
      value: link,
      evidence: [commit],
      author: await authorOf(repo.git),
      createdAt: now(),
    };
    await new ArtifactStore(repo.git).add(commit, [record]);
    console.log(`Linked ${from} -> ${to} at ${short(commit)}`);
    return 0;
  }

  const name = positionals[0];
  if (!name) throw new UserError("usage: git sem entity <name> [--worlds]");

  if (values.worlds) {
    const versions = await entityWorlds(repo.git, name);
    if (values.json) {
      console.log(JSON.stringify({ name, tier: 0, versions }, null, 2));
      return 0;
    }
    if (versions.length === 0) {
      console.log(`${name} was not found on any branch`);
      return 0;
    }
    const distinct = new Set(versions.map((v) => v.hash)).size;
    console.log(`${name} on ${versions.length} branch${versions.length === 1 ? "" : "es"} · ${distinct} distinct version${distinct === 1 ? "" : "s"}`);
    for (const v of versions) {
      console.log(`\n── ${v.branch} (${short(v.commit)})  ${v.path}:${v.start}-${v.end}  #${v.hash.slice(0, 8)}`);
      console.log(v.body);
    }
    return 0;
  }

  const lineage = await entityLineage(repo.git, name, await currentIdentity(repo));
  if (values.json) {
    console.log(JSON.stringify(lineage, null, 2));
    return 0;
  }
  if (lineage.steps.length === 0) {
    console.log(`No recorded history for ${name}. Is it indexed? Try \`git sem index --all\`.`);
    return 0;
  }
  console.log(`${lineage.names.join(" <- ")}   tier ${lineage.tier}`);
  for (const s of lineage.steps) {
    console.log(`  ${short(s.commit)}  ${describe(s)}`);
    if (s.type === "ambiguous") {
      for (const c of s.candidates ?? []) console.log(`             ${c.name}  ${c.path}  ${c.score.toFixed(2)}`);
      console.log(`           confirm with: git sem entity confirm ${short(s.commit)} ${s.from?.name} <name>`);
    }
  }
  return 0;
}

/** Why does this exist? Answers only from recorded intents, citing commits. */
export async function whyCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: "boolean" } } });
  const name = positionals[0];
  if (!name) throw new UserError("usage: git sem why <name>");
  const repo = await openRepo();
  const answer = await explainEntity(repo.git, name, await currentIdentity(repo));

  if (values.json) {
    console.log(JSON.stringify(answer, null, 2));
    return 0;
  }
  if (answer.lineage.steps.length === 0) {
    console.log(`No recorded history for ${name}.`);
    return 0;
  }
  if (!answer.sufficient) {
    console.log(`Recorded intent is insufficient to explain ${name}.`);
    console.log("What is recorded:");
    for (const s of answer.lineage.steps) {
      const bulk = s.addedInCommit > 1 ? ` (commit added ${s.addedInCommit} entities)` : "";
      console.log(`  ${short(s.commit)}  ${s.type} in ${s.path}${bulk}`);
    }
    console.log(`Record the reason with: git sem intent <commit> --set "..."`);
    return 0;
  }
  console.log(`Why ${name} exists:`);
  for (const r of answer.reasons) {
    console.log(`  ${short(r.commit)}  ${r.type} in ${r.path}`);
    console.log(`           "${r.intent.text.split("\n")[0]}"  [${r.intent.source}]`);
  }
  console.log(`cites: ${answer.cites.map(short).join(", ")}`);
  return 0;
}
