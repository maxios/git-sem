import { Database } from "bun:sqlite";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { keyOf, parseNote, resolveIntent, type ChangesValue } from "./artifacts.ts";
import { CatFile } from "./batch.ts";
import { cosine, DIM, embed, words } from "./embed.ts";
import { bodyOf, extractEntities } from "./entities.ts";
import { CHANGES_KEY, eventsIn } from "./entity-git.ts";
import type { Git } from "./git.ts";
import type { Repo } from "./repo.ts";
import { NOTES_REF } from "./store.ts";

const SCHEMA = "1";

export interface Doc {
  kind: "commit" | "entity";
  name: string | null;
  path: string | null;
  commit: string;
  text: string;
}

export interface Hit extends Doc {
  score: number;
}

function toBlob(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer.slice(0));
}

function fromBlob(blob: Uint8Array): Float32Array {
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer, 0, DIM);
}

/**
 * The local read cache for search (F4, F13). Lives in .git/sem/index.sqlite,
 * is never shared, and is always rebuildable from refs/notes/sem without any
 * model: deleting it loses nothing.
 */
export class SearchIndex {
  private constructor(
    readonly path: string,
    private readonly db: Database,
  ) {}

  static pathFor(repo: Repo): string {
    return join(repo.semDir, "index.sqlite");
  }

  /** Open the index, rebuilding it first if it is missing or older than the notes. */
  static async open(repo: Repo, opts: { rebuild?: boolean } = {}): Promise<{ index: SearchIndex; rebuilt: boolean }> {
    const path = SearchIndex.pathFor(repo);
    const tip = (await repo.git.resolve(NOTES_REF)) ?? "";
    if (opts.rebuild) rmSync(path, { force: true });

    let db = new Database(path, { create: true });
    const meta = (key: string) =>
      (db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null)?.value;
    let fresh = false;
    try {
      fresh = meta("schema") === SCHEMA && meta("notes") === tip;
    } catch {
      fresh = false;
    }
    if (!fresh) {
      db.close();
      rmSync(path, { force: true });
      db = new Database(path, { create: true });
      await build(db, repo.git, tip);
    }
    return { index: new SearchIndex(path, db), rebuilt: !fresh };
  }

  count(): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM docs").get() as { n: number }).n;
  }

  /** Nearest documents to a query, best version per entity, newest wins ties. */
  search(query: string, limit = 10, minScore = 0.15): Hit[] {
    return this.rank(embed(query), limit, minScore);
  }

  /** Entities most like the named one (excluding itself). */
  similar(name: string, limit = 5): { target: Doc | null; hits: Hit[] } {
    const target = this.db.query("SELECT kind, name, path, commit_id AS [commit], text, vec FROM docs WHERE kind = 'entity' AND name = ? ORDER BY rowid DESC LIMIT 1").get(name) as
      | (Doc & { vec: Uint8Array })
      | null;
    if (!target) return { target: null, hits: [] };
    const hits = this.rank(fromBlob(target.vec), limit + 1, 0.1).filter((h) => h.kind === "entity" && h.name !== name);
    const { vec: _vec, ...doc } = target;
    return { target: doc, hits: hits.slice(0, limit) };
  }

  close(): void {
    this.db.close();
  }

  private rank(q: Float32Array, limit: number, minScore: number): Hit[] {
    const rows = this.db.query("SELECT rowid, kind, name, path, commit_id AS [commit], text, vec FROM docs").all() as Array<
      Doc & { rowid: number; vec: Uint8Array }
    >;
    const best = new Map<string, Hit & { rowid: number }>();
    for (const row of rows) {
      const score = cosine(q, fromBlob(row.vec));
      if (score < minScore) continue;
      const key = row.kind === "entity" ? `e\0${row.path}\0${row.name}` : `c\0${row.commit}`;
      const prev = best.get(key);
      if (!prev || score > prev.score + 1e-9 || (Math.abs(score - prev.score) < 1e-9 && row.rowid > prev.rowid)) {
        const { vec: _vec, ...doc } = row;
        best.set(key, { ...doc, score: Math.round(score * 1000) / 1000 });
      }
    }
    return [...best.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ rowid: _rowid, ...hit }) => hit);
  }
}

async function build(db: Database, git: Git, tip: string): Promise<void> {
  db.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
  db.run("CREATE TABLE docs (kind TEXT, name TEXT, path TEXT, commit_id TEXT, text TEXT, vec BLOB)");
  const insert = db.prepare("INSERT INTO docs (kind, name, path, commit_id, text, vec) VALUES (?, ?, ?, ?, ?, ?)");

  const docs: Doc[] = [];
  if (tip) {
    const listing = (await git.run(["ls-tree", "-r", "-z", tip])).stdout;
    const cat = new CatFile(git.cwd);
    try {
      for (const entry of listing.split("\0")) {
        const tab = entry.indexOf("\t");
        if (tab < 0) continue;
        const blob = entry.slice(0, tab).split(" ")[2]!;
        const object = entry.slice(tab + 1).replaceAll("/", "");
        const records = parseNote((await cat.text(blob)) ?? "");
        const changes = records.find((r) => keyOf(r) === CHANGES_KEY)?.value as ChangesValue | undefined;
        if (!changes) continue; // not a commit note (blob facts, etc.)

        const intent = (resolveIntent(records)?.value as { text?: string } | undefined)?.text ?? "";
        docs.push({ kind: "commit", name: null, path: null, commit: object, text: `${intent}\n${changes.subject}` });

        for (const e of eventsIn(records) ?? []) {
          if (e.type === "removed") continue;
          const names = e.type === "ambiguous" ? (e.candidates ?? []).map((c) => ({ name: c.name, path: c.path })) : [{ name: e.name, path: e.path }];
          for (const target of names) {
            const fileBlob = changes.paths.find((p) => p.path === target.path)?.blob;
            const content = fileBlob ? await cat.text(fileBlob) : null;
            const entity = content ? extractEntities(target.path, content).find((x) => x.name === target.name) : undefined;
            const body = content && entity ? bodyOf(content, entity) : "";
            const nameWords = words(target.name).join(" ");
            docs.push({
              kind: "entity",
              name: target.name,
              path: target.path,
              commit: object,
              text: `${nameWords} ${nameWords} ${nameWords}\n${intent}\n${body}`,
            });
          }
        }
      }
    } finally {
      await cat.close();
    }
  }

  db.transaction(() => {
    for (const d of docs) insert.run(d.kind, d.name, d.path, d.commit, d.text, toBlob(embed(d.text)));
    db.run("INSERT INTO meta (key, value) VALUES ('schema', ?), ('notes', ?)", [SCHEMA, tip]);
  })();
}

export function indexExists(repo: Repo): boolean {
  return existsSync(SearchIndex.pathFor(repo));
}

export interface Reachability {
  branches: Map<string, string[]>;
  reflog: Set<string>;
}

/** Which branches contain each commit, and which commits survive only in reflogs. */
export async function reachability(git: Git): Promise<Reachability> {
  const branches = new Map<string, string[]>();
  const refs = (await git.out(["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/tags"])).split("\n").filter(Boolean);
  for (const ref of refs) {
    for (const c of (await git.out(["rev-list", ref, "--"])).split("\n").filter(Boolean)) {
      const list = branches.get(c) ?? [];
      list.push(ref);
      branches.set(c, list);
    }
  }
  const reflogOut = await git.run(["log", "-g", "--format=%H", "HEAD"], { allowFail: true });
  return { branches, reflog: new Set(reflogOut.stdout.split("\n").filter(Boolean)) };
}
