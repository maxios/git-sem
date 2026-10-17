import { commitCommand } from "./commands/commit.ts";
import { entityCommand, whyCommand } from "./commands/entity.ts";
import { indexCommand } from "./commands/index-cmd.ts";
import { initCommand } from "./commands/init.ts";
import { intentCommand } from "./commands/intent.ts";
import { logCommand } from "./commands/log.ts";
import { mcpCommand } from "./commands/mcp.ts";
import { pruneCommand } from "./commands/prune.ts";
import { checkCommand, mergeViewCommand, resolveCommand } from "./commands/merge.ts";
import { rebuildCommand, searchCommand, similarCommand } from "./commands/search.ts";
import { showCommand } from "./commands/show.ts";
import { statusCommand } from "./commands/status.ts";
import { fetchCommand, pushCommand } from "./commands/sync.ts";
import { messageOf, UserError } from "./errors.ts";

const VERSION = "0.2.0";

const HELP = `git-sem ${VERSION} — a semantic layer over git

Inference happens at write time, in the background.
Reads are lookups. The layer proposes; you decide.

usage: git sem <command> [options]

setup
  init                     install the post-commit hook and notes config
    --backfill             also index all branches and tags in the background

write side (background)
  index                    index queued commits
    --rev <rev>            index specific commits (repeatable)
    --since <rev>          index commits in <rev>..HEAD
    --all                  index every commit on every branch and tag
    --background           queue the targets and return immediately
    --json | --quiet

read side (lookup only)
  log [<range>] [-n N]     history by intent; unindexed commits show as pending
  show [<rev>]             semantics for one object
    --provenance           every artifact with engine, model, prompt, tier, time
  status                   queue, engine and indexer state

entities (functions, classes, methods)
  entity <name>            lineage across renames and moves
    --worlds               the entity at the tip of every branch
  entity confirm <commit> <from> <to>
                           settle an ambiguous succession
  why <name>               why it exists, from recorded intents only

search (local index, Tier 1, no model)
  search <query>           find code and commits by meaning on every branch
    --include-unreachable  also show results only kept alive by the reflog
  similar <entity>         entities that look like this one
  rebuild                  recreate the local index from refs/notes/sem

judgment (yours)
  commit                   commit with a history-aware draft in your editor
    --no-edit              commit the draft as is
    --draft                print the draft only (commits and stores nothing)
    -- <git commit args>   passed through to git commit
  intent --staged          propose an intent for staged changes (not stored)
  intent [<rev>]           show the current intent
  intent <rev> --set TEXT  record your own intent
  intent <rev> --accept    adopt the inferred proposal as yours
  intent --branch <name>   one intent for a whole branch (--base <ref>)

agents
  intent <rev> --propose TEXT --agent ID
                           record an agent's proposal (stays a proposal)
  intent <rev> --accept --agent ID
                           adopt that agent's proposal as yours
  mcp                      MCP server on stdio for agents

merging (you decide; nothing is merged for you)
  merge-view <a> <b>       entities both sides changed, with each side's intent
  check <a> <b>            Tier 0 warnings for clean-but-suspect merges
    --deep                 also ask the Tier 3 frontier engine (budgeted)
  resolve <path>           propose a resolution for a conflicted file
    --accept               write the last proposal (does not stage it)

team
  push [<remote>]          share refs/notes/sem (intents, decisions, links)
    --force-with-lease     replace the remote's notes (after prune --squash)
  fetch [<remote>]         receive and union a remote's semantics
    --reset                replace yours with the remote's (after a squash)
  prune                    keep shared notes to what cannot be recomputed
    --dry-run              show what would move or be dropped
    --squash               also squash the shared notes' history

All read and write commands accept --json.`;

type Command = (args: string[]) => Promise<number>;

const COMMANDS: Record<string, Command> = {
  init: initCommand,
  commit: commitCommand,
  entity: entityCommand,
  why: whyCommand,
  search: searchCommand,
  similar: similarCommand,
  rebuild: rebuildCommand,
  "merge-view": mergeViewCommand,
  resolve: resolveCommand,
  check: checkCommand,
  mcp: mcpCommand,
  prune: pruneCommand,
  index: indexCommand,
  log: logCommand,
  show: showCommand,
  intent: intentCommand,
  status: statusCommand,
  push: pushCommand,
  fetch: fetchCommand,
};

export async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  if (!name || name === "help" || name === "--help" || name === "-h") {
    console.log(HELP);
    return 0;
  }
  if (name === "--version" || name === "version") {
    console.log(VERSION);
    return 0;
  }
  const command = COMMANDS[name];
  if (!command) {
    console.error(`git-sem: unknown command '${name}'. See 'git sem help'.`);
    return 2;
  }
  try {
    return await command(rest);
  } catch (e) {
    console.error(`git-sem: ${messageOf(e)}`);
    if (!(e instanceof UserError) && process.env.GIT_SEM_DEBUG) console.error(e);
    return 1;
  }
}
