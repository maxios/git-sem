import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { spendFrontierCall } from "../budget.ts";
import { readConfig } from "../config.ts";
import { resolveEngine, resolveFrontier } from "../engines/index.ts";
import { UserError } from "../errors.ts";
import { coTouched, findContradictions, readSides } from "../merge.ts";
import { openRepo } from "../repo.ts";
import { currentIdentity } from "./context.ts";
import { short } from "./format.ts";

const first = (text: string | null) => (text ?? "").split("\n")[0];

/**
 * Before merging, see what both sides did to the same entities and why.
 *
 *   git sem merge-view <a> <b>
 */
export async function mergeViewCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: "boolean" } } });
  const [a, b] = positionals;
  if (!a || !b) throw new UserError("usage: git sem merge-view <a> <b>");
  const repo = await openRepo();
  const sides = await readSides(repo.git, a, b, await currentIdentity(repo));
  const entities = coTouched(sides);

  if (values.json) {
    console.log(JSON.stringify({ base: sides.base, a, b, tier: 1, entities, decision: "yours", pending: [...sides.a.pending, ...sides.b.pending] }, null, 2));
    return 0;
  }
  console.log(`merge-view ${a} ⇄ ${b}  (base ${short(sides.base)})`);
  if (entities.length === 0) console.log("No entity was changed on both sides.");
  for (const e of entities) {
    console.log(`\n${e.name}${e.redundant ? `   likely redundant (similarity ${e.similarity.toFixed(2)})` : ""}`);
    for (const [ref, touches] of [
      [a, e.a],
      [b, e.b],
    ] as const) {
      for (const t of touches) console.log(`  ${ref.padEnd(10)} ${short(t.commit)}  ${t.type}  "${first(t.intent)}"${t.source === "authored" ? " [authored]" : ""}`);
    }
  }
  console.log("\nDecision: yours. git-sem never merges or picks a side.");
  return 0;
}

interface Proposal {
  path: string;
  text: string;
  engine: string;
  model: string;
  confidence: number;
  stages: { ours: string; theirs: string };
  createdAt: string;
}

/**
 * Propose a resolution for a conflicted file. Nothing is written until you
 * run it again with --accept, and even then the file is not staged.
 *
 *   git sem resolve <path>
 *   git sem resolve <path> --accept
 */
export async function resolveCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { accept: { type: "boolean" }, json: { type: "boolean" } } });
  const path = positionals[0];
  if (!path) throw new UserError("usage: git sem resolve <path> [--accept]");
  const repo = await openRepo();

  const stages = new Map<string, string>();
  for (const line of (await repo.git.out(["ls-files", "-u", "--", path])).split("\n").filter(Boolean)) {
    const [, oid, stage] = line.split("\t")[0]!.split(" ");
    if (oid && stage) stages.set(stage, oid);
  }
  const ours = stages.get("2");
  const theirs = stages.get("3");
  if (!ours || !theirs) throw new UserError(`${path} is not in conflict`);

  const dir = join(repo.semDir, "proposals");
  const file = join(dir, `${createHash("sha1").update(path).digest("hex")}.json`);

  if (values.accept) {
    if (!existsSync(file)) throw new UserError(`no proposal for ${path}; run \`git sem resolve ${path}\` first`);
    const proposal = JSON.parse(await readFile(file, "utf8")) as Proposal;
    if (proposal.stages.ours !== ours || proposal.stages.theirs !== theirs) {
      throw new UserError(`the conflict in ${path} changed since the proposal; run \`git sem resolve ${path}\` again`);
    }
    await writeFile(join(repo.root, path), proposal.text);
    await rm(file);
    console.log(`Wrote the proposal to ${path}. Review it, then \`git add ${path}\`.`);
    return 0;
  }

  const show = async (oid: string | undefined) => (oid ? await repo.git.run(["cat-file", "blob", oid]).then((r) => r.stdout) : null);
  const config = await readConfig(repo.git);
  const engine = resolveEngine(config, repo.root);
  if (!engine.resolveConflict) throw new UserError(`the ${engine.id} engine cannot propose resolutions`);
  const result = await engine.resolveConflict({
    protocol: 1,
    task: "resolve",
    model: engine.model,
    promptVersion: engine.promptVersion,
    path,
    base: await show(stages.get("1")),
    ours: (await show(ours))!,
    theirs: (await show(theirs))!,
    oursIntents: [],
    theirsIntents: [],
  });

  if (!result) {
    console.log(`No proposal for ${path}: both sides changed it and the ${engine.id} engine only resolves one-sided changes.`);
    return 0;
  }
  const proposal: Proposal = {
    path,
    text: result.text,
    engine: engine.id,
    model: engine.model,
    confidence: result.confidence,
    stages: { ours, theirs },
    createdAt: new Date().toISOString(),
  };
  await mkdir(dir, { recursive: true });
  await writeFile(file, JSON.stringify(proposal, null, 2));

  if (values.json) {
    console.log(JSON.stringify({ ...proposal, written: false }, null, 2));
    return 0;
  }
  console.log(`Suggested resolution for ${path} (engine=${engine.id} model=${engine.model} confidence=${result.confidence.toFixed(2)}), not written:`);
  console.log("──────");
  process.stdout.write(result.text.endsWith("\n") ? result.text : `${result.text}\n`);
  console.log("──────");
  console.log(`Apply it with: git sem resolve ${path} --accept`);
  return 0;
}

/**
 * Warn about merges that are clean as text but suspect as logic. Never
 * blocks. --deep asks the frontier engine (Tier 3) for a second opinion.
 *
 *   git sem check <a> <b> [--deep]
 */
export async function checkCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { deep: { type: "boolean" }, json: { type: "boolean" } } });
  const [a, b] = positionals;
  if (!a || !b) throw new UserError("usage: git sem check <a> <b> [--deep]");
  const repo = await openRepo();
  const sides = await readSides(repo.git, a, b, await currentIdentity(repo));
  const warnings = await findContradictions(repo.git, sides);

  let review: { text: string; confidence: number; questions?: string[]; model: string } | undefined;
  if (values.deep) {
    const config = await readConfig(repo.git);
    const frontier = resolveFrontier(config, repo.root);
    if (!frontier?.findContradictions) throw new UserError("--deep needs a Tier 3 engine: set sem.frontier.command and sem.frontier.model");
    await spendFrontierCall(repo.semDir, config.frontier.dailyBudget);
    const r = await frontier.findContradictions({
      protocol: 1,
      task: "contradictions",
      model: frontier.model,
      promptVersion: frontier.promptVersion,
      a: { ref: a, intents: sides.a.intents },
      b: { ref: b, intents: sides.b.intents },
      warnings: warnings.map((w) => w.message),
    });
    review = { ...r, model: frontier.model };
  }

  if (values.json) {
    console.log(JSON.stringify({ base: sides.base, a, b, tier: values.deep ? 3 : 0, warnings, review: review ?? null }, null, 2));
    return 0;
  }
  if (warnings.length === 0) console.log(`No contradictions found between ${a} and ${b} (Tier 0 checks).`);
  for (const w of warnings) {
    console.log(`WARNING ${w.kind}: ${w.message}`);
    console.log(`  ${w.a.ref}: ${short(w.a.commit)} ${w.a.path}`);
    console.log(`  ${w.b.ref}: ${short(w.b.commit)} ${w.b.path}`);
  }
  if (review) {
    console.log(`\nTier 3 review (${review.model}, confidence ${review.confidence.toFixed(2)}): ${review.text}`);
    for (const q of review.questions ?? []) console.log(`  ? ${q}`);
  }
  if (warnings.length) console.log("\nThese warnings do not block the merge. The decision is yours.");
  return 0;
}
