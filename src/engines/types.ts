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
  /**
   * Drafting only: recent commits that touched the same files, with their
   * recorded intents. Lets a model write with context instead of guessing.
   */
  history?: Array<{ commit: string; subject: string; intent: string | null; source: string | null; paths: string[] }>;
  /** Drafting only: past commits this change exactly undoes, detected at Tier 0. */
  reversals?: Array<{ path: string; commit: string; subject: string; intent: string | null }>;
}

/** Roll many commit intents up into one statement (a branch). */
export interface SummarizeInput {
  protocol: 1;
  task: "summarize";
  model: string;
  promptVersion: string;
  subject: string;
  intents: string[];
}

/** Propose a resolution for one conflicted file. The proposal is never written without consent. */
export interface ResolveInput {
  protocol: 1;
  task: "resolve";
  model: string;
  promptVersion: string;
  path: string;
  base: string | null;
  ours: string;
  theirs: string;
  oursIntents: string[];
  theirsIntents: string[];
}

/** Review two sides of a merge for assumptions that contradict each other. */
export interface ContradictionInput {
  protocol: 1;
  task: "contradictions";
  model: string;
  promptVersion: string;
  a: { ref: string; intents: string[] };
  b: { ref: string; intents: string[] };
  warnings: string[];
}

export interface IntentProposal {
  text: string;
  /** 0..1 */
  confidence: number;
  /** What the engine could not know and wants the author to answer. */
  questions?: string[];
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
  summarize?(input: SummarizeInput): Promise<IntentProposal>;
  /** Null when this engine cannot propose anything for the conflict. */
  resolveConflict?(input: ResolveInput): Promise<IntentProposal | null>;
  findContradictions?(input: ContradictionInput): Promise<IntentProposal>;
}

export type EngineInput = IntentInput | SummarizeInput | ResolveInput | ContradictionInput;
