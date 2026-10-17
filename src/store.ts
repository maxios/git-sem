import { mergeRecords, parseNote, serializeNote, type ArtifactRecord } from "./artifacts.ts";
import type { Git } from "./git.ts";
import { isShared, type SharePolicy } from "./sharing.ts";

/**
 * Semantics live in two git notes refs (see sharing.ts):
 *
 *   NOTES_REF        shared with the team by `git sem push`
 *   LOCAL_NOTES_REF  this clone only; recomputable, never pushed
 *
 * Notes attach to any object id and are JSON Lines, one immutable record
 * per line, so git's `cat_sort_uniq` strategy unions two teammates' notes
 * without conflicts. Readers always see both refs together.
 */
export const NOTES_REF = "refs/notes/sem";
export const LOCAL_NOTES_REF = "refs/notes/sem-local";
export const ALL_NOTES_REFS = [NOTES_REF, LOCAL_NOTES_REF] as const;

/** `git log` arguments that attach both refs' notes to %N. */
export function notesArgs(): string[] {
  return ["--no-notes", ...ALL_NOTES_REFS.map((ref) => `--notes=${ref}`)];
}

export async function readPolicy(git: Git): Promise<SharePolicy> {
  const r = await git.run(["config", "--get", "sem.share"], { allowFail: true });
  return { shareDerived: r.stdout.trim().toLowerCase() === "derived" };
}

export class ArtifactStore {
  private policy?: SharePolicy;

  constructor(
    private readonly git: Git,
    policy?: SharePolicy,
  ) {
    this.policy = policy;
  }

  /** Every record for an object, from both refs. */
  async read(object: string): Promise<ArtifactRecord[]> {
    const parts = await Promise.all(ALL_NOTES_REFS.map((ref) => this.readRef(ref, object)));
    return parseNote(parts.join("\n"));
  }

  private async readRef(ref: string, object: string): Promise<string> {
    const r = await this.git.run(["notes", "--ref", ref, "show", object], { allowFail: true });
    return r.code === 0 ? r.stdout : "";
  }

  /**
   * Append records to an object's note in the ref each belongs to. Records
   * whose key already exists are ignored: artifacts are immutable, so nothing
   * is ever overwritten.
   */
  async add(object: string, records: ArtifactRecord[]): Promise<void> {
    this.policy ??= await readPolicy(this.git);
    const policy = this.policy;
    const existing = await this.read(object);
    const fresh = mergeRecords(existing, records).slice(existing.length);
    if (fresh.length === 0) return;
    for (const ref of ALL_NOTES_REFS) {
      const mine = fresh.filter((r) => isShared(r, policy) === (ref === NOTES_REF));
      if (mine.length) await this.append(ref, object, mine);
    }
  }

  private async append(ref: string, object: string, records: ArtifactRecord[]): Promise<void> {
    const merged = mergeRecords(parseNote(await this.readRef(ref, object)), records);
    // Store the exact bytes as a blob, then attach it with -C so git does not
    // reformat the note body.
    const blob = await this.git.out(["hash-object", "-w", "--stdin"], { input: serializeNote(merged) });
    for (let attempt = 0; ; attempt++) {
      const r = await this.git.run(["notes", "--ref", ref, "add", "-f", "-C", blob, object], { allowFail: attempt < 2 });
      if (r.code === 0) return;
      await Bun.sleep(25 * (attempt + 1)); // another writer held the notes ref lock
    }
  }
}
