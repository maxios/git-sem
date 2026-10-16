import type { FileSink } from "bun";
import { mergeRecords, parseNote, serializeNote, type ArtifactRecord } from "./artifacts.ts";
import type { Git } from "./git.ts";
import { spawnText } from "./proc.ts";
import { NOTES_REF } from "./store.ts";

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
 * Batched access to refs/notes/sem for bulk work such as backfills.
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
  private readonly pending = new Map<string, ArtifactRecord[]>();

  private constructor(
    private readonly git: Git,
    readonly cat: CatFile,
  ) {}

  static async open(git: Git): Promise<NotesBatch> {
    const batch = new NotesBatch(git, new CatFile(git.cwd));
    await batch.load();
    return batch;
  }

  private async load(): Promise<void> {
    this.tip = await this.git.resolve(NOTES_REF);
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
      this.paths.set(object, object);
      this.blobs.delete(object);
    }
    this.pending.clear();
  }

  async close(): Promise<void> {
    try {
      await this.flush();
    } finally {
      await this.cat.close();
    }
  }

  /** Reload the notes ref and merge our pending records onto what is there now. */
  private async rebase(): Promise<void> {
    const mine = [...this.pending];
    this.pending.clear();
    await this.load();
    for (const [object, records] of mine) await this.add(object, records);
  }

  private async write(): Promise<void> {
    const ident = await this.git.out(["var", "GIT_COMMITTER_IDENT"]);
    const message = `git-sem: ${this.pending.size} note${this.pending.size === 1 ? "" : "s"}`;
    const chunks: string[] = [
      `commit ${NOTES_REF}\n`,
      `committer ${ident}\n`,
      `data ${encoder.encode(message).length}\n${message}\n`,
    ];
    if (this.tip) chunks.push(`from ${this.tip}\n`);
    for (const [object, records] of this.pending) {
      const old = this.paths.get(object);
      if (old && old !== object) chunks.push(`D ${old}\n`);
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
    this.tip = await this.git.resolve(NOTES_REF);
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
