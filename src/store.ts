import { mergeRecords, parseNote, serializeNote, type ArtifactRecord } from "./artifacts.ts";
import type { Git } from "./git.ts";

/**
 * The source of truth for semantics: one git notes ref.
 *
 * Notes attach to any object id (commits, blobs, trees) and travel with the
 * repository through push and fetch. Each note is JSON Lines, one immutable
 * record per line, so git's `cat_sort_uniq` merge strategy can union two
 * teammates' notes without conflicts.
 */
export const NOTES_REF = "refs/notes/sem";

export class ArtifactStore {
  constructor(private readonly git: Git) {}

  async read(object: string): Promise<ArtifactRecord[]> {
    const r = await this.git.run(["notes", "--ref", NOTES_REF, "show", object], { allowFail: true });
    return r.code === 0 ? parseNote(r.stdout) : [];
  }

  /**
   * Append records to an object's note. Records whose key already exists are
   * ignored: artifacts are immutable, so nothing is ever overwritten.
   */
  async add(object: string, records: ArtifactRecord[]): Promise<ArtifactRecord[]> {
    const existing = await this.read(object);
    const merged = mergeRecords(existing, records);
    if (merged.length === existing.length) return existing;

    // Store the exact bytes as a blob, then attach it with -C so git does not
    // reformat the note body.
    const blob = await this.git.out(["hash-object", "-w", "--stdin"], { input: serializeNote(merged) });
    for (let attempt = 0; ; attempt++) {
      const r = await this.git.run(["notes", "--ref", NOTES_REF, "add", "-f", "-C", blob, object], {
        allowFail: attempt < 2,
      });
      if (r.code === 0) break;
      await Bun.sleep(25 * (attempt + 1)); // another writer held the notes ref lock
    }
    return merged;
  }

  /** True if any note exists in the store. */
  async isEmpty(): Promise<boolean> {
    const r = await this.git.run(["notes", "--ref", NOTES_REF, "list"], { allowFail: true });
    return r.code !== 0 || r.stdout.trim() === "";
  }
}
