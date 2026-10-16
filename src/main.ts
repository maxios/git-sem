import { commitCommand } from "./commands/commit.ts";
import { entityCommand, whyCommand } from "./commands/entity.ts";
import { indexCommand } from "./commands/index-cmd.ts";
import { initCommand } from "./commands/init.ts";
import { intentCommand } from "./commands/intent.ts";
import { logCommand } from "./commands/log.ts";
import { showCommand } from "./commands/show.ts";
import { statusCommand } from "./commands/status.ts";
import { fetchCommand, pushCommand } from "./commands/sync.ts";
import { messageOf, UserError } from "./errors.ts";

const VERSION = "0.1.0";

const HELP = `git-sem ${VERSION} — a semantic layer over git

Inference happens at write time, in the background.
Reads are lookups. The layer proposes; you decide.

usage: git sem <command> [options]

setup
  init                     install the post-commit hook and notes config
    --backfill             also index existing history in the background

write side (background)
  index                    index queued commits
    --rev <rev>            index specific commits (repeatable)
    --since <rev>          index commits in <rev>..HEAD
    --all                  index every commit reachable from HEAD
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

judgment (yours)
  commit                   commit with a history-aware draft in your editor
    --no-edit              commit the draft as is
    --draft                print the draft only (commits and stores nothing)
    -- <git commit args>   passed through to git commit
  intent --staged          propose an intent for staged changes (not stored)
  intent [<rev>]           show the current intent
  intent <rev> --set TEXT  record your own intent
  intent <rev> --accept    adopt the inferred proposal as yours

team
  push [<remote>]          share semantics (refs/notes/sem)
  fetch [<remote>]         receive and union a remote's semantics

All read and write commands accept --json.`;

type Command = (args: string[]) => Promise<number>;

const COMMANDS: Record<string, Command> = {
  init: initCommand,
  commit: commitCommand,
  entity: entityCommand,
  why: whyCommand,
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
