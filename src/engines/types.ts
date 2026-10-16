import type { ChangeEntry, Tier } from "../artifacts.ts";

/** What an engine receives when asked for the intent of a change. Protocol version 1. */
export interface IntentInput {
  protocol: 1;
  task: "intent";
  model: string;
  promptVersion: string;
  /** Commit id, or null for staged (uncommitted) changes. */
  commit: string | null;
  subject: string;
  body: string;
  changes: ChangeEntry[];
  /** Unified diff, possibly truncated; empty when the engine does not want it. */
  diff: string;
}

export interface IntentProposal {
  text: string;
  /** 0..1 */
  confidence: number;
}

/**
 * An engine proposes meaning. It never decides: proposals are stored as
 * `inferred` records and a human can accept or replace them.
 */
export interface Engine {
  readonly id: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly tier: Tier;
  /** Whether the indexer should compute and send the unified diff. */
  readonly wantsDiff: boolean;
  proposeIntent(input: IntentInput): Promise<IntentProposal>;
}
