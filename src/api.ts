/**
 * The programmatic surface for agents and tools. Every call is the same code
 * the CLI runs, returns plain JSON-serializable data, and never invokes a
 * model except where the method says so (none of these do).
 *
 *   import { openSemantic } from "git-sem/src/api.ts";
 *   const sem = await openSemantic("/path/to/repo");
 *   const history = await sem.entity("loadUser");
 */
import { resolveIntent, type ArtifactRecord } from "./artifacts.ts";
import { currentIdentity } from "./commands/context.ts";
import { intentView, type IntentView } from "./commands/format.ts";
import { readLog, type LogEntry } from "./commands/log.ts";
import { runSearch, type SearchResult } from "./commands/search.ts";
import { proposeAsAgent, resolveCommit } from "./intents.ts";
import { entityLineage, explainEntity, type Explanation } from "./lineage.ts";
import { openRepo } from "./repo.ts";
import { ArtifactStore } from "./store.ts";

export interface EntityVersion {
  commit: string;
  type: string;
  name: string;
  path: string;
  /** The blob holding this version, when recorded. */
  blob: string | null;
  intent: { text: string; source: string; confidence: number } | null;
}

export interface EntityHistory {
  name: string;
  /** Every name the entity has had, newest first. */
  names: string[];
  tier: number;
  versions: EntityVersion[];
  /** Ambiguous successions that a person has not confirmed. */
  unresolved: Array<{ commit: string; from: string | undefined; candidates: string[] }>;
}

export interface ObjectSemantics {
  object: string;
  intent: IntentView | null;
  artifacts: ArtifactRecord[];
}

export interface SemanticRepo {
  readonly root: string;
  log(opts?: { range?: string[]; limit?: number }): Promise<LogEntry[]>;
  show(rev?: string): Promise<ObjectSemantics>;
  entity(name: string): Promise<EntityHistory>;
  why(name: string): Promise<Explanation>;
  search(query: string, opts?: { includeUnreachable?: boolean; limit?: number }): Promise<SearchResult[]>;
  /** Record an agent's intent proposal. It stays a proposal until a person accepts it. */
  proposeIntent(rev: string, text: string, opts: { agent: string; confidence?: number }): Promise<ArtifactRecord>;
}

export async function openSemantic(cwd: string = process.cwd()): Promise<SemanticRepo> {
  const repo = await openRepo(cwd);
  return {
    root: repo.root,
    log: (opts = {}) => readLog(repo, opts.range ?? [], opts.limit),
    async show(rev = "HEAD") {
      const object = await repo.git.resolve(rev);
      if (!object) throw new Error(`unknown revision or object: ${rev}`);
      const artifacts = await new ArtifactStore(repo.git).read(object);
      return { object, intent: intentView(resolveIntent(artifacts, await currentIdentity(repo))), artifacts };
    },
    async entity(name) {
      const lineage = await entityLineage(repo.git, name, await currentIdentity(repo));
      return {
        name: lineage.name,
        names: lineage.names,
        tier: lineage.tier,
        versions: lineage.steps
          .filter((s) => s.type !== "ambiguous")
          .map((s) => ({
            commit: s.commit,
            type: s.type,
            name: s.name,
            path: s.path,
            blob: s.blob ?? null,
            intent: s.intent ? { text: s.intent.text, source: s.intent.source, confidence: s.intent.confidence } : null,
          })),
        unresolved: lineage.unresolved.map((s) => ({
          commit: s.commit,
          from: s.from?.name,
          candidates: (s.candidates ?? []).map((c) => c.name),
        })),
      };
    },
    why: async (name) => explainEntity(repo.git, name, await currentIdentity(repo)),
    search: async (query, opts = {}) => (await runSearch(repo, query, opts)).results,
    proposeIntent: async (rev, text, opts) => proposeAsAgent(repo.git, await resolveCommit(repo.git, rev), text, opts.agent, opts.confidence),
  };
}
