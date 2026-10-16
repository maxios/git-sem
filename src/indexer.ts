import {
  intentKeyFor,
  keyOf,
  now,
  type ArtifactRecord,
  type ChangeEntry,
  type ChangesValue,
  type FileValue,
} from "./artifacts.ts";
import { commitChanges, commitDiff, isRegularFile } from "./changes.ts";
import { identityOf, type Engine } from "./engines/index.ts";
import { messageOf } from "./errors.ts";
import type { Git } from "./git.ts";
import { ArtifactStore } from "./store.ts";

export const CHANGES_KEY = "changes:derived:core:none:changes/v1";
export const FILE_KEY = "file:derived:core:none:file/v1";

export interface CommitMeta {
  hash: string;
  parents: string[];
  subject: string;
  body: string;
}

export interface IndexStats {
  commits: number;
  intents: { computed: number; reused: number };
  files: { computed: number; reused: number };
  failed: Array<{ commit: string; error: string }>;
  engine: { id: string; model: string; prompt: string; tier: number };
  startedAt: string;
  finishedAt: string;
}

export function emptyStats(engine: Engine): IndexStats {
  const t = now();
  return {
    commits: 0,
    intents: { computed: 0, reused: 0 },
    files: { computed: 0, reused: 0 },
    failed: [],
    engine: { id: engine.id, model: engine.model, prompt: engine.promptVersion, tier: engine.tier },
    startedAt: t,
    finishedAt: t,
  };
}

export function addStats(into: IndexStats, from: IndexStats): void {
  into.commits += from.commits;
  into.intents.computed += from.intents.computed;
  into.intents.reused += from.intents.reused;
  into.files.computed += from.files.computed;
  into.files.reused += from.files.reused;
  into.failed.push(...from.failed);
  into.finishedAt = from.finishedAt;
}

/** Read subject, body and parents for many commits in a single git call. */
export async function readCommitMeta(git: Git, commits: string[]): Promise<Map<string, CommitMeta>> {
  const metas = new Map<string, CommitMeta>();
  if (commits.length === 0) return metas;
  const r = await git.run(["log", "--no-walk=unsorted", "--stdin", "--format=%H%x1f%P%x1f%s%x1f%b%x1e"], {
    input: `${commits.join("\n")}\n`,
  });
  for (const raw of r.stdout.split("\x1e")) {
    const record = raw.replace(/^\n/, "");
    if (!record) continue;
    const [hash = "", parents = "", subject = "", body = ""] = record.split("\x1f");
    if (!hash) continue;
    metas.set(hash, { hash, parents: parents.split(" ").filter(Boolean), subject, body: body.trim() });
  }
  return metas;
}

/**
 * Turns commits into artifacts. Every step is keyed by content, so running it
 * twice does nothing the second time, and unchanged blobs are never revisited:
 *
 *   commit ─► changes  (Tier 0, derived)
 *     │
 *     ├─► file per new blob  (Tier 0, derived, reused by hash)
 *     │
 *     └─► intent  (engine tier, inferred; keyed by engine+model+prompt)
 */
export class Indexer {
  private readonly store: ArtifactStore;

  constructor(
    private readonly git: Git,
    private readonly engine: Engine,
  ) {
    this.store = new ArtifactStore(git);
  }

  async run(commits: string[]): Promise<IndexStats> {
    const stats = emptyStats(this.engine);
    const ids: string[] = [];
    for (const c of new Set(commits)) {
      const id = await this.git.resolve(`${c}^{commit}`);
      if (id) ids.push(id);
      else stats.failed.push({ commit: c, error: "not a commit in this repository" });
    }

    const metas = await readCommitMeta(this.git, ids);
    for (const id of ids) {
      const meta = metas.get(id);
      if (!meta) {
        stats.failed.push({ commit: id, error: "commit metadata unavailable" });
        continue;
      }
      try {
        await this.indexCommit(meta, stats);
        stats.commits++;
      } catch (e) {
        stats.failed.push({ commit: id, error: messageOf(e) });
      }
    }
    stats.finishedAt = now();
    return stats;
  }

  private async indexCommit(meta: CommitMeta, stats: IndexStats): Promise<void> {
    const existing = await this.store.read(meta.hash);
    const fresh: ArtifactRecord[] = [];

    try {
      const cached = existing.find((r) => keyOf(r) === CHANGES_KEY)?.value as ChangesValue | undefined;
      const changes = cached?.paths ?? (await commitChanges(this.git, meta.hash, meta.parents));
      if (!cached) fresh.push(this.changesRecord(meta, changes));

      for (const entry of changes) {
        if (!entry.blob || !isRegularFile(entry)) continue;
        if (await this.ensureFile(entry.blob)) stats.files.reused++;
        else stats.files.computed++;
      }

      const intentKey = intentKeyFor(identityOf(this.engine));
      if (existing.some((r) => keyOf(r) === intentKey)) {
        stats.intents.reused++;
      } else {
        fresh.push(await this.proposeIntent(meta, changes));
        stats.intents.computed++;
      }
    } finally {
      // Keep whatever was derived even if the engine failed.
      if (fresh.length) await this.store.add(meta.hash, fresh);
    }
  }

  private async proposeIntent(meta: CommitMeta, changes: ChangeEntry[]): Promise<ArtifactRecord> {
    const diff = this.engine.wantsDiff ? await commitDiff(this.git, meta.hash, meta.parents) : "";
    const proposal = await this.engine.proposeIntent({
      protocol: 1,
      task: "intent",
      model: this.engine.model,
      promptVersion: this.engine.promptVersion,
      commit: meta.hash,
      subject: meta.subject,
      body: meta.body,
      changes,
      diff,
    });
    return {
      v: 1,
      kind: "intent",
      object: meta.hash,
      source: "inferred",
      engine: this.engine.id,
      model: this.engine.model,
      prompt: this.engine.promptVersion,
      tier: this.engine.tier,
      confidence: proposal.confidence,
      value: { text: proposal.text },
      evidence: [meta.hash],
      createdAt: now(),
    };
  }

  private changesRecord(meta: CommitMeta, paths: ChangeEntry[]): ArtifactRecord {
    const value: ChangesValue = { parents: meta.parents, subject: meta.subject, paths };
    return {
      v: 1,
      kind: "changes",
      object: meta.hash,
      source: "derived",
      engine: "core",
      model: "none",
      prompt: "changes/v1",
      tier: 0,
      confidence: 1,
      value,
      evidence: [meta.hash, ...meta.parents],
      createdAt: now(),
    };
  }

  /** Returns true if the blob already had a file artifact (reused), false if it was computed now. */
  private async ensureFile(blob: string): Promise<boolean> {
    const existing = await this.store.read(blob);
    if (existing.some((r) => keyOf(r) === FILE_KEY)) return true;

    const bytes = await this.git.bytes(["cat-file", "blob", blob]);
    let lines = 0;
    let binary = false;
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (b === 10) lines++;
      else if (b === 0 && i < 8000) binary = true;
    }
    if (bytes.length > 0 && bytes[bytes.length - 1] !== 10) lines++;

    const value: FileValue = { bytes: bytes.length, lines: binary ? 0 : lines, binary };
    await this.store.add(blob, [
      {
        v: 1,
        kind: "file",
        object: blob,
        source: "derived",
        engine: "core",
        model: "none",
        prompt: "file/v1",
        tier: 0,
        confidence: 1,
        value,
        evidence: [blob],
        createdAt: now(),
      },
    ]);
    return false;
  }
}
