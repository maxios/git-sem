import { parseArgs } from "node:util";
import { UserError } from "../errors.ts";
import { openRepo } from "../repo.ts";
import { reachability, SearchIndex, type Hit } from "../search-index.ts";
import { short } from "./format.ts";

export interface SearchResult extends Omit<Hit, "text"> {
  branches: string[];
  /** reachable: on a branch or tag · reflog: only in the reflog · unreachable: neither */
  reach: "reachable" | "reflog" | "unreachable";
}

function label(r: SearchResult): string {
  if (r.reach === "reachable") return `[${r.branches.join(", ")}]`;
  return r.reach === "reflog" ? "[unreachable · reflog]" : "[unreachable]";
}

/**
 * Search by meaning across every indexed timeline. Tier 1: local embeddings
 * from the local index, no model call. Results not on any branch or tag are
 * hidden unless --include-unreachable is given.
 */
export async function searchCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      "include-unreachable": { type: "boolean" },
      limit: { type: "string", short: "n" },
      json: { type: "boolean" },
    },
  });
  const query = positionals.join(" ").trim();
  if (!query) throw new UserError("usage: git sem search <query>");

  const repo = await openRepo();
  const { index, rebuilt } = await SearchIndex.open(repo);
  const limit = Number(values.limit ?? 10);
  const hits = index.search(query, limit * 3);
  index.close();

  const reach = await reachability(repo.git);
  const results: SearchResult[] = hits
    .map(({ text: _text, ...h }) => {
      const branches = reach.branches.get(h.commit) ?? [];
      const where: SearchResult["reach"] = branches.length ? "reachable" : reach.reflog.has(h.commit) ? "reflog" : "unreachable";
      return { ...h, branches, reach: where };
    })
    .filter((r) => values["include-unreachable"] || r.reach === "reachable")
    .slice(0, limit);

  if (values.json) {
    console.log(JSON.stringify({ query, tier: 1, source: "local-index", index: index.path, rebuilt, results }, null, 2));
    return 0;
  }
  if (results.length === 0) {
    console.log(`No matches for "${query}"`);
    return 0;
  }
  for (const r of results) {
    const what = r.kind === "entity" ? `entity  ${r.name}  ${r.path}` : "commit";
    console.log(`${r.score.toFixed(2)}  ${what}  @ ${short(r.commit)}  ${label(r)}`);
  }
  return 0;
}

/** Entities that look like the named one. Tier 1, local index. */
export async function similarCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: "boolean" } } });
  const name = positionals[0];
  if (!name) throw new UserError("usage: git sem similar <entity>");
  const repo = await openRepo();
  const { index } = await SearchIndex.open(repo);
  const { target, hits } = index.similar(name);
  index.close();
  if (!target) throw new UserError(`no indexed entity named ${name}`);

  const results = hits.map(({ text: _text, ...h }) => h);
  if (values.json) {
    console.log(JSON.stringify({ name, tier: 1, results }, null, 2));
    return 0;
  }
  if (results.length === 0) console.log(`Nothing similar to ${name}`);
  for (const r of results) console.log(`${r.score.toFixed(2)}  ${r.name}  ${r.path}  @ ${short(r.commit)}`);
  return 0;
}

/** Recreate the local index from refs/notes/sem. Never calls a model. */
export async function rebuildCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { json: { type: "boolean" } } });
  const repo = await openRepo();
  const { index } = await SearchIndex.open(repo, { rebuild: true });
  const documents = index.count();
  index.close();
  if (values.json) console.log(JSON.stringify({ index: index.path, documents, tier: 0, inference: false }, null, 2));
  else console.log(`Rebuilt the local index from refs/notes/sem: ${documents} documents (no inference)`);
  return 0;
}
