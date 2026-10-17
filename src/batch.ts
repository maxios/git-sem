import type { FileSink } from "bun";
import { mergeRecords, parseNote, serializeNote, type ArtifactRecord } from "./artifacts.ts";
import type { Git } from "./git.ts";
import { spawnText } from "./proc.ts";
import { isShared, type SharePolicy } from "./sharing.ts";
import { LOCAL_NOTES_REF, NOTES_REF } from "./store.ts";

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

/**
 * Batched access to one notes ref for bulk work such as backfills.
 *
 *   reads   the notes tree is listed once; note bodies come from one
 *           cat-file process
 *   writes  buffered in memory and committed with one `git fast-import`
 *           per flush instead of two processes per object
 *
 * Writes only ever add records. If someone else moved the notes ref while we
 * worked, the flush reloads, re-merges and tries again.
 */
export class NotesBatch {
  private tip: string | undefined;
  /** object id → path of its note in the notes tree */
  private paths = new Map<string, string>();
  /** object id → path → blob, for reading */
  private blobs = new Map<string, string>();
  private readonly cache = new Map<string, ArtifactRecord[]>();
  /** Notes to write at the next flush; an empty list deletes the note. */
  private readonly pending = new Map<string, ArtifactRecord[]>();

  private constructor(
    private readonly git: Git,
    readonly cat: CatFile,
    readonly ref: string,
    private readonly ownsCat: boolean,
  ) {}

  static async open(git: Git, ref: string = NOTES_REF, cat?: CatFile): Promise<NotesBatch> {
    const batch = new NotesBatch(git, cat ?? new CatFile(git.cwd), ref, !cat);
    await batch.load();
    return batch;
  }

  /** Every object that has a note in this ref. */
  objects(): string[] {
    return [...new Set([...this.paths.keys(), ...this.pending.keys()])];
  }

  private async load(): Promise<void> {
    this.tip = await this.git.resolve(this.ref);
    this.paths.clear();
    this.blobs.clear();
    this.cache.clear();
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

  async read(object: string): Promise<ArtifactRecord[]> {
    const pending = this.pending.get(object);
    if (pending) return pending;
    const cached = this.cache.get(object);
    if (cached) return cached;
    const blob = this.blobs.get(object);
    const records = blob ? parseNote((await this.cat.text(blob)) ?? "") : [];
    this.cache.set(object, records);
    return records;
  }

  async add(object: string, records: ArtifactRecord[]): Promise<void> {
    const existing = await this.read(object);
    const merged = mergeRecords(existing, records);
    if (merged.length !== existing.length) this.pending.set(object, merged);
  }

  /** Make an object's note exactly these records; an empty list removes the note. For prune only. */
  async replace(object: string, records: ArtifactRecord[]): Promise<boolean> {
    const existing = await this.read(object);
    const same = existing.length === records.length && serializeNote(existing) === serializeNote(records);
    if (!same) this.pending.set(object, records);
    return !same;
  }

  async flush(): Promise<void> {
    if (this.pending.size === 0) return;
    for (let attempt = 1; ; attempt++) {
      try {
        await this.write();
        break;
      } catch (e) {
        if (!(e instanceof NotFastForward) || attempt >= 3) throw e;
        await this.rebase();
      }
    }
    for (const [object, records] of this.pending) {
      this.cache.set(object, records);
      this.blobs.delete(object);
      if (records.length) this.paths.set(object, object);
      else this.paths.delete(object);
    }
    this.pending.clear();
  }

  async close(): Promise<void> {
    try {
      await this.flush();
    } finally {
      if (this.ownsCat) await this.cat.close();
    }
  }

  /** Reload the notes ref and merge our pending records onto what is there now. */
  private async rebase(): Promise<void> {
    const mine = [...this.pending];
    this.pending.clear();
    await this.load();
    for (const [object, records] of mine) {
      if (records.length) await this.add(object, records);
      else this.pending.set(object, records);
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
    for (const [object, records] of this.pending) {
      const old = this.paths.get(object);
      if (old && (old !== object || records.length === 0)) chunks.push(`D ${old}\n`);
      if (records.length === 0) continue;
      const body = serializeNote(records);
      chunks.push(`M 100644 inline ${object}\ndata ${encoder.encode(body).length}\n${body}\n`);
    }

    const r = await spawnText(["git", "fast-import", "--quiet", "--date-format=raw"], {
      cwd: this.git.cwd,
      input: chunks.join(""),
    });
    if (r.code !== 0) {
      if (/not updating|does not contain|fast.forward/i.test(r.stderr)) throw new NotFastForward(r.stderr);
      throw new Error(`git fast-import failed: ${r.stderr.trim()}`);
    }
    this.tip = await this.git.resolve(this.ref);
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
