import { clampConfidence, intentKeyFor, keyOf, now, parseNote, resolveIntent, type ArtifactRecord, type EngineIdentity } from "./artifacts.ts";
import { readConfig } from "./config.ts";
import { commitsWithNotes } from "./entity-git.ts";
import { resolveEngine } from "./engines/index.ts";
import { UserError } from "./errors.ts";
import type { Git } from "./git.ts";
import type { Repo } from "./repo.ts";
import { ArtifactStore } from "./store.ts";

export const AGENT_PROMPT = "agent/v1";

function authoredRecord(object: string, text: string, author: string, evidence: string[]): ArtifactRecord {
  return {
    v: 1,
    kind: "intent",
    object,
    source: "authored",
    engine: "human",
    model: "none",
    prompt: "none",
    tier: 0,
    confidence: 1,
    value: { text },
    evidence,
    author,
    createdAt: now(),
  };
}

export async function resolveCommit(git: Git, rev: string): Promise<string> {
  const commit = await git.resolve(`${rev}^{commit}`);
  if (!commit) throw new UserError(`unknown commit: ${rev}`);
  return commit;
}

/** Record a person's own intent. Authoritative over every proposal. */
export async function setIntent(git: Git, commit: string, text: string, author: string, current?: EngineIdentity): Promise<ArtifactRecord> {
  const trimmed = text.trim();
  if (!trimmed) throw new UserError("an intent cannot be empty");
  const store = new ArtifactStore(git);
  const records = await store.read(commit);
  const proposal = resolveIntent(records.filter((r) => r.source === "inferred"), current);
  const record = authoredRecord(commit, trimmed, author, [commit, ...(proposal ? [keyOf(proposal)] : [])]);
  await store.add(commit, [record]);
  return record;
}

/**
 * An agent's proposal: stored as an inferred record tagged with the agent's
 * identity. It stays a proposal until a person accepts it.
 */
export async function proposeAsAgent(git: Git, commit: string, text: string, agent: string, confidence = 0.5): Promise<ArtifactRecord> {
  const trimmed = text.trim();
  if (!trimmed) throw new UserError("a proposal cannot be empty");
  if (!agent.trim()) throw new UserError("an agent proposal needs an agent identity");
  const record: ArtifactRecord = {
    v: 1,
    kind: "intent",
    object: commit,
    source: "inferred",
    engine: "agent",
    model: agent.trim(),
    prompt: AGENT_PROMPT,
    tier: 2,
    confidence: clampConfidence(confidence),
    value: { text: trimmed },
    evidence: [commit],
    createdAt: now(),
  };
  await new ArtifactStore(git).add(commit, [record]);
  return record;
}

/** Adopt a proposal as the person's own: the configured engine's by default, or a named agent's. */
export async function acceptProposal(
  git: Git,
  commit: string,
  author: string,
  opts: { current?: EngineIdentity; agent?: string } = {},
): Promise<ArtifactRecord> {
  const store = new ArtifactStore(git);
  const inferred = (await store.read(commit)).filter((r) => r.kind === "intent" && r.source === "inferred");
  let proposal: ArtifactRecord | undefined;
  if (opts.agent) {
    proposal = inferred.filter((r) => r.engine === "agent" && r.model === opts.agent).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (!proposal) throw new UserError(`no proposal from agent ${opts.agent} on ${commit.slice(0, 7)}`);
  } else {
    const preferred = opts.current ? inferred.find((r) => keyOf(r) === intentKeyFor(opts.current!)) : undefined;
    proposal = preferred ?? resolveIntent(inferred);
  }
  const text = (proposal?.value as { text?: string } | undefined)?.text;
  if (!proposal || !text) throw new UserError(`no proposal for ${commit.slice(0, 7)} yet; run \`git sem index\` first`);
  const record = authoredRecord(commit, text, author, [commit, keyOf(proposal)]);
  await store.add(commit, [record]);
  return record;
}

export interface Rollup {
  branch: string;
  base: string;
  commits: number;
  /** Commits whose intent is not indexed yet. */
  pending: number;
  intents: string[];
  text: string;
  confidence: number;
  engine: string;
  model: string;
  tier: number;
}

async function defaultBase(git: Git): Promise<string> {
  for (const candidate of ["main", "master"]) if (await git.resolve(`refs/heads/${candidate}`)) return candidate;
  throw new UserError("could not find main or master; pass --base <ref>");
}

/** One intent for a whole branch, summarized from its commits' recorded intents. */
export async function rollupBranch(repo: Repo, branch: string, base?: string, current?: EngineIdentity): Promise<Rollup> {
  const tip = await resolveCommit(repo.git, branch);
  const from = base ?? (await defaultBase(repo.git));
  const commits = await commitsWithNotes(repo.git, [`${from}..${tip}`]);
  if (commits.length === 0) throw new UserError(`${branch} has no commits that are not on ${from}`);

  const intents: string[] = [];
  let pending = 0;
  for (const c of [...commits].reverse()) {
    const text = (resolveIntent(parseNote(c.note), current)?.value as { text?: string } | undefined)?.text;
    if (text) intents.push(text);
    else pending++;
  }

  const engine = resolveEngine(await readConfig(repo.git), repo.root);
  if (!engine.summarize) throw new UserError(`the ${engine.id} engine cannot summarize`);
  const summary = await engine.summarize({
    protocol: 1,
    task: "summarize",
    model: engine.model,
    promptVersion: engine.promptVersion,
    subject: branch,
    intents,
  });

  await new ArtifactStore(repo.git).add(tip, [
    {
      v: 1,
      kind: "rollup",
      object: tip,
      source: "inferred",
      engine: engine.id,
      model: engine.model,
      prompt: engine.promptVersion,
      tier: engine.tier,
      confidence: summary.confidence,
      value: { text: summary.text, base: from, commits: commits.length },
      evidence: commits.map((c) => c.commit),
      createdAt: now(),
    },
  ]);

  return {
    branch,
    base: from,
    commits: commits.length,
    pending,
    intents,
    text: summary.text,
    confidence: summary.confidence,
    engine: engine.id,
    model: engine.model,
    tier: engine.tier,
  };
}
