import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { now, type ArtifactRecord } from "../artifacts.ts";
import { readConfig } from "../config.ts";
import { buildDraft, renderTemplate } from "../draft.ts";
import { resolveEngine } from "../engines/index.ts";
import { UserError } from "../errors.ts";
import { openRepo } from "../repo.ts";
import { ArtifactStore } from "../store.ts";
import { authorOf } from "./context.ts";

/**
 * Commit with a history-aware draft.
 *
 *   git sem commit              open the editor on the draft, then commit
 *   git sem commit --no-edit    commit the draft as is
 *   git sem commit --draft      print the draft; commit and store nothing
 *   git sem commit -- <args>    pass extra arguments to git commit
 *
 * The message you commit is recorded as your authored intent. Plain
 * `git commit` is untouched: drafting is opt-in because it waits for a model.
 */
export async function commitCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      draft: { type: "boolean" },
      "no-edit": { type: "boolean" },
      json: { type: "boolean" },
    },
  });

  const repo = await openRepo();
  const engine = resolveEngine(await readConfig(repo.git), repo.root);
  const draft = await buildDraft(repo.git, engine);
  if (!draft) throw new UserError("nothing staged");

  if (values.draft) {
    if (values.json) console.log(JSON.stringify(draft, null, 2));
    else process.stdout.write(renderTemplate(draft));
    return 0;
  }

  const templatePath = join(repo.commonDir, "SEM_COMMIT_EDITMSG");
  await writeFile(templatePath, renderTemplate(draft));

  const before = await repo.git.resolve("HEAD");
  const gitArgs = ["commit", "--cleanup=strip", "-F", templatePath];
  if (!values["no-edit"]) gitArgs.push("--edit");
  gitArgs.push(...positionals);

  const proc = Bun.spawn(["git", ...gitArgs], { cwd: repo.root, stdio: ["inherit", "inherit", "inherit"] });
  const code = await proc.exited;
  const after = await repo.git.resolve("HEAD");
  if (code !== 0 || !after || after === before) return code || 1;

  const message = (await repo.git.out(["log", "-1", "--format=%B", after])).trim();
  const record: ArtifactRecord = {
    v: 1,
    kind: "intent",
    object: after,
    source: "authored",
    engine: "human",
    model: "none",
    prompt: "none",
    tier: 0,
    confidence: 1,
    value: { text: message },
    evidence: [after, `draft:${draft.engine.engine}:${draft.engine.model}:${draft.engine.prompt}`],
    author: await authorOf(repo.git),
    createdAt: now(),
  };
  await new ArtifactStore(repo.git).add(after, [record]);
  return 0;
}
