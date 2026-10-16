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
  };
}
