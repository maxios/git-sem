import type { ChangeEntry } from "../artifacts.ts";
import type { Engine, IntentProposal } from "./types.ts";

const VAGUE = new Set(["wip", "fix", "fixes", "update", "updates", "changes", "misc", "tmp", "temp", "stuff", "."]);

const VERBS: Record<string, string> = { A: "Add", D: "Remove", R: "Rename", C: "Copy", M: "Change", T: "Change" };

export function describeChanges(changes: ChangeEntry[]): string {
  if (changes.length === 0) return "No file changes";
  if (changes.length > 3) return `Change ${changes.length} files`;
  return changes
    .map((c) => {
      const verb = VERBS[c.status] ?? "Change";
      return c.from ? `${verb} ${c.from} to ${c.path}` : `${verb} ${c.path}`;
    })
    .join("; ");
}

/**
 * Tier 0 fallback that needs no model. It trusts a descriptive commit subject
 * and otherwise describes the touched paths. Confidence is deliberately low:
 * it restates what changed, not why.
 */
export function heuristicEngine(): Engine {
  return {
    id: "heuristic",
    model: "none",
    promptVersion: "heuristic/v1",
    tier: 0,
    wantsDiff: false,
    async proposeIntent(input): Promise<IntentProposal> {
      const subject = input.subject.trim();
      const descriptive = subject.split(/\s+/).filter(Boolean).length >= 2 && !VAGUE.has(subject.toLowerCase());
      if (descriptive) return { text: subject, confidence: 0.3 };
      return { text: describeChanges(input.changes), confidence: 0.1 };
    },
    async summarize(input): Promise<IntentProposal> {
      const unique = [...new Set(input.intents.map((i) => i.split("\n")[0]!.trim()).filter(Boolean))];
      if (unique.length === 0) return { text: "No recorded intents", confidence: 0 };
      if (unique.length === 1) return { text: unique[0]!, confidence: 0.3 };
      const shown = unique.slice(0, 3).join("; ");
      const more = unique.length > 3 ? `; and ${unique.length - 3} more` : "";
      return { text: `${unique.length} changes: ${shown}${more}`, confidence: 0.2 };
    },
    /** Only the unambiguous cases: one side left the file as it was. */
    async resolveConflict(input): Promise<IntentProposal | null> {
      if (input.base === null) return null;
      if (input.ours === input.base) return { text: input.theirs, confidence: 1 };
      if (input.theirs === input.base) return { text: input.ours, confidence: 1 };
      return null;
    },
  };
}
