import { parseArgs } from "node:util";
import { keyOf, resolveIntent, type ChangesValue } from "../artifacts.ts";
import { UserError } from "../errors.ts";
import { CHANGES_KEY } from "../indexer.ts";
import { openRepo } from "../repo.ts";
import { ArtifactStore } from "../store.ts";
import { currentIdentity } from "./context.ts";
import { intentBadge, intentView, provenanceLine } from "./format.ts";

/** Show the semantics attached to one object. Lookup only. */
export async function showCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      provenance: { type: "boolean" },
      json: { type: "boolean" },
    },
  });

  const repo = await openRepo();
  const rev = positionals[0] ?? "HEAD";
  const object = await repo.git.resolve(rev);
  if (!object) throw new UserError(`unknown revision or object: ${rev}`);

  const records = await new ArtifactStore(repo.git).read(object);
  const intent = resolveIntent(records, await currentIdentity(repo));

  if (values.json) {
    console.log(JSON.stringify({ object, intent: intentView(intent), artifacts: records }, null, 2));
    return 0;
  }

  console.log(`object   ${object}`);
  const view = intentView(intent);
  console.log(view ? `intent   ${view.text}  ${intentBadge(view)}` : "intent   pending");

  const changes = records.find((r) => keyOf(r) === CHANGES_KEY)?.value as ChangesValue | undefined;
  if (changes) {
    console.log("changes");
    for (const p of changes.paths) console.log(`  ${p.status} ${p.from ? `${p.from} -> ` : ""}${p.path}`);
  }

  if (values.provenance) {
    console.log(`artifacts (${records.length})`);
    const sorted = [...records].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const r of sorted) console.log(`  ${provenanceLine(r)}`);
  }
  return 0;
}
