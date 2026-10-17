import type { FileSink } from "bun";
import { lineOf, mergeRecords, noteLines, parseNote, serializeLines, type ArtifactRecord } from "./artifacts.ts";
import type { Git } from "./git.ts";
import { spawnText } from "./proc.ts";
import { isShared, type SharePolicy } from "./sharing.ts";
import { LOCAL_NOTES_REF, NOTES_REF } from "./refs.ts";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/**
 * One long-lived `git cat-file --batch` process. Requests are serialized, so
 * any number of object reads cost a single spawn.
 */
export class CatFile {
  private readonly proc;
  private readonly sink: FileSink;
  private readonly reader: { read(): Promise<{ value?: Uint8Array; done: boolean }> };
  private buffer = new Uint8Array(0);
  private chain: Promise<unknown> = Promise.resolve();

  constructor(cwd: string) {
    this.proc = Bun.spawn(["git", "cat-file", "--batch"], { cwd, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    this.sink = this.proc.stdin as unknown as FileSink;
    this.reader = this.proc.stdout.getReader();
  }

  /** Object contents, or null if the object does not exist. */
  read(oid: string): Promise<Uint8Array | null> {
    const next = this.chain.then(() => this.readOne(oid));
    this.chain = next.catch(() => undefined);
    return next;
  }

  async text(oid: string): Promise<string | null> {
    const bytes = await this.read(oid);
    return bytes === null ? null : decoder.decode(bytes);
  }

  async close(): Promise<void> {
    await this.chain;
    await this.sink.end();
    await this.proc.exited;
  }

  private async readOne(oid: string): Promise<Uint8Array | null> {
    this.sink.write(`${oid}\n`);
    await this.sink.flush();
    const header = await this.readLine();
    if (header.endsWith(" missing") || header.endsWith(" ambiguous")) return null;
    const size = Number(header.split(" ")[2]);
    const body = await this.take(size + 1); // contents + trailing LF
    return body.subarray(0, size);
  }

  private async fill(): Promise<void> {
    const { value, done } = await this.reader.read();
    if (done || !value) throw new Error("git cat-file --batch ended unexpectedly");
    const merged = new Uint8Array(this.buffer.length + value.length);
    merged.set(this.buffer);
    merged.set(value, this.buffer.length);
    this.buffer = merged;
  }

  private async readLine(): Promise<string> {
    for (;;) {
      const nl = this.buffer.indexOf(10);
      if (nl >= 0) {
        const line = decoder.decode(this.buffer.subarray(0, nl));
        this.buffer = this.buffer.subarray(nl + 1);
        return line;
      }
      await this.fill();
    }
  }

  private async take(n: number): Promise<Uint8Array> {
    while (this.buffer.length < n) await this.fill();
    const out = this.buffer.slice(0, n);
    this.buffer = this.buffer.subarray(n);
    return out;
  }
}

class NotFastForward extends Error {}

/** Lost races before a flush gives up; each retry re-applies the edits to the new state. */
const MAX_WRITE_ATTEMPTS = 12;

/** A change to one note, applied to whatever the note holds when it is written. */
export interface NoteEdit {
  add: string[];
  remove: Set<string>;
}

function applyEdit(lines: string[], edit: NoteEdit | undefined): string[] {
  if (!edit) return lines;
  const out = lines.filter((l) => !edit.remove.has(l));
  for (const l of edit.add) if (!out.includes(l)) out.push(l);
  return out;
}

/**
 * Batched access to one notes ref for bulk work such as backfills.
 *
 *   reads   the notes tree is listed once; note bodies come from one
 *           cat-file process
 *   writes  buffered as edits (lines to add, exact lines to remove) and
 *           committed with one `git fast-import` per flush
 *
 * Edits are applied to the note's raw lines at write time. If another writer
 * moved the ref meanwhile, the flush reloads and applies the same edits to
 * the new state, so lines it never touched (a teammate's intent written
 * concurrently, a record from a newer git-sem) are always kept.
 */
export class NotesBatch {
  private tip: string | undefined;
  /** object id → path of its note in the notes tree */
  private paths = new Map<string, string>();
  /** object id → blob of its note */
  private blobs = new Map<string, string>();
  private readonly committed = new Map<string, string[]>();
  private readonly pending = new Map<string, NoteEdit>();

  private constructor(
    private readonly git: Git,
    readonly cat: CatFile,
    readonly ref: string,
    private readonly ownsCat: boolean,
    private readonly at?: string,
  ) {}

  /** Open a ref for reading and writing, or with `at` a fixed commit for reading only. */
  static async open(git: Git, ref: string = NOTES_REF, cat?: CatFile, at?: string): Promise<NotesBatch> {
    const batch = new NotesBatch(git, cat ?? new CatFile(git.cwd), ref, !cat, at);
    await batch.load();
    return batch;
  }

  /** Every object that has a note in this ref. */
  objects(): string[] {
    return [...new Set([...this.paths.keys(), ...this.pending.keys()])];
  }

  private async load(): Promise<void> {
    this.tip = this.at ?? (await this.git.resolve(this.ref));
    this.paths.clear();
    this.blobs.clear();
    this.committed.clear();
    if (!this.tip) return;
    const out = (await this.git.run(["ls-tree", "-r", "-z", this.tip])).stdout;
    for (const entry of out.split("\0")) {
      const tab = entry.indexOf("\t");
      if (tab < 0) continue;
      const [, type, blob] = entry.slice(0, tab).split(" ");
      const path = entry.slice(tab + 1);
      if (type !== "blob" || !blob) continue;
      const object = path.replaceAll("/", "");
      this.paths.set(object, path);
      this.blobs.set(object, blob);
    }
  }

  get size(): number {
    return this.pending.size;
  }

  private async committedLines(object: string): Promise<string[]> {
    const cached = this.committed.get(object);
    if (cached) return cached;
    const blob = this.blobs.get(object);
    const lines = blob ? noteLines((await this.cat.text(blob)) ?? "").map((l) => l.line) : [];
    this.committed.set(object, lines);
    return lines;
  }

  /** The note's raw lines, including pending edits. */
  async lines(object: string): Promise<string[]> {
    return applyEdit(await this.committedLines(object), this.pending.get(object));
  }

  /** Records as readers see them (one per key). */
  async read(object: string): Promise<ArtifactRecord[]> {
    return parseNote((await this.lines(object)).join("\n"));
  }

  /** Add records whose keys the note does not have yet. Nothing is ever replaced. */
  async add(object: string, records: ArtifactRecord[]): Promise<void> {
    const existing = await this.read(object);
    const fresh = mergeRecords(existing, records).slice(existing.length);
    if (fresh.length) this.edit(object, { add: fresh.map(lineOf), remove: [] });
  }

  /** Queue lines to add and exact lines to remove. For prune and reset. */
  edit(object: string, change: { add: string[]; remove: string[] }): void {
    if (change.add.length === 0 && change.remove.length === 0) return;
    const e = this.pending.get(object) ?? { add: [], remove: new Set<string>() };
    for (const l of change.remove) e.remove.add(l);
    e.add = e.add.filter((l) => !e.remove.has(l));
    for (const l of change.add) if (!e.add.includes(l)) e.add.push(l);
    this.pending.set(object, e);
  }

  async flush(): Promise<void> {
    if (this.pending.size === 0) return;
    if (this.at) throw new Error(`notes at ${this.at} are read-only`);
    for (let attempt = 1; ; attempt++) {
      try {
        await this.write();
        break;
      } catch (e) {
        if (!(e instanceof NotFastForward) || attempt >= MAX_WRITE_ATTEMPTS) throw e;
        // Back off with jitter so contending writers stop colliding.
        await Bun.sleep(Math.min(2_000, 20 * 2 ** attempt) * (0.5 + Math.random()));
        await this.load(); // edits are re-applied to the new state
      }
    }
    this.pending.clear();
    await this.load();
  }

  async close(): Promise<void> {
    try {
      await this.flush();
    } finally {
      if (this.ownsCat) await this.cat.close();
    }
  }

  private async write(): Promise<void> {
    const ident = await this.git.out(["var", "GIT_COMMITTER_IDENT"]);
    const message = `git-sem: ${this.pending.size} note${this.pending.size === 1 ? "" : "s"}`;
    const chunks: string[] = [
      `commit ${this.ref}\n`,
      `committer ${ident}\n`,
      `data ${encoder.encode(message).length}\n${message}\n`,
    ];
    if (this.tip) chunks.push(`from ${this.tip}\n`);
    let changes = 0;
    for (const [object, edit] of this.pending) {
      const before = await this.committedLines(object);
      const after = applyEdit(before, edit);
      if (serializeLines(before) === serializeLines(after) && (before.length > 0) === this.paths.has(object)) continue;
      changes++;
      const old = this.paths.get(object);
      if (old && (old !== object || after.length === 0)) chunks.push(`D ${old}\n`);
      if (after.length === 0) continue;
      const body = serializeLines(after);
      chunks.push(`M 100644 inline ${object}\ndata ${encoder.encode(body).length}\n${body}\n`);
    }
    if (changes === 0) return;

    const r = await spawnText(["git", "fast-import", "--quiet", "--date-format=raw"], {
      cwd: this.git.cwd,
      input: chunks.join(""),
    });
    if (r.code !== 0) {
      // Another writer moved the ref, or holds its lock right now: retry.
      if (/not updating|does not contain|fast.forward|cannot lock|unable to create .*\.lock/i.test(r.stderr)) {
        throw new NotFastForward(r.stderr);
      }
      throw new Error(`git fast-import failed: ${r.stderr.trim()}`);
    }
  }
}

/**
 * Both notes refs as one store: reads see every record, and each new record
 * goes to the ref the sharing policy assigns it (#9).
 */
export class NotesPair {
  private constructor(
    readonly shared: NotesBatch,
    readonly local: NotesBatch,
    readonly policy: SharePolicy,
    readonly cat: CatFile,
  ) {}

  static async open(git: Git, policy: SharePolicy): Promise<NotesPair> {
    const cat = new CatFile(git.cwd);
    return new NotesPair(await NotesBatch.open(git, NOTES_REF, cat), await NotesBatch.open(git, LOCAL_NOTES_REF, cat), policy, cat);
  }

  async read(object: string): Promise<ArtifactRecord[]> {
    return mergeRecords(await this.shared.read(object), await this.local.read(object));
  }

  async add(object: string, records: ArtifactRecord[]): Promise<void> {
    const toShared = records.filter((r) => isShared(r, this.policy));
    const toLocal = records.filter((r) => !isShared(r, this.policy));
    if (toShared.length) await this.shared.add(object, toShared);
    if (toLocal.length) await this.local.add(object, toLocal);
  }

  get size(): number {
    return this.shared.size + this.local.size;
  }

  async flush(): Promise<void> {
    await this.shared.flush();
    await this.local.flush();
  }

  async close(): Promise<void> {
    try {
      await this.shared.close();
      await this.local.close();
    } finally {
      await this.cat.close();
    }
  }
}

/** Resolve many revisions to commit ids with one process. Unknown revisions map to undefined. */
export async function resolveCommits(git: Git, revs: string[]): Promise<Map<string, string | undefined>> {
  const result = new Map<string, string | undefined>();
  if (revs.length === 0) return result;
  const r = await git.run(["cat-file", "--batch-check=%(objectname) %(objecttype)"], {
    input: `${revs.map((rev) => `${rev}^{commit}`).join("\n")}\n`,
  });
  const lines = r.stdout.split("\n");
  revs.forEach((rev, i) => {
    const [oid, type] = (lines[i] ?? "").split(" ");
    result.set(rev, type === "commit" ? oid : undefined);
  });
  return result;
}
