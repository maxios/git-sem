# git-sem

A semantic layer over git.

Git made parallel worlds cheap. Agents now create those worlds faster than
people can read them. `git-sem` records what each change *means*, follows
code through renames and branches, and makes merges legible, so the worlds
stay understandable.

```
  inference at WRITE time  (background)
                ≠
  lookup at READ time      (instant)

  the layer proposes · you decide
```

## How it works

```
  git commit / git merge
      │
      ▼
  hooks append the commit
  to a queue, return at once
      │
      ▼
  background indexer
  ├─ Tier 0  changes, file facts,
  │          entities (functions,
  │          classes, methods),
  │          renames and moves
  └─ engine  proposes an intent
      │
      ▼
  refs/notes/sem
  immutable records keyed by
  object + engine + model + prompt
      │
      ├─► log, show, entity, why    lookup
      ├─► search, similar           local index
      └─► merge-view, check         Tier 0/1
```

Semantics live in a git notes ref, so they push, fetch and clone with the
repository. Nothing is ever overwritten: a new model or prompt adds a record
under a new key, and an intent you write always outranks a proposal.

## Install

Requires [Bun](https://bun.sh) ≥ 1.1 and git ≥ 2.31.

```sh
git clone https://github.com/maxios/git-sem
cd git-sem
bun install
bun link                   # puts `git-sem` on PATH, so `git sem` works
```

In any repository:

```sh
git sem init               # installs the post-commit and post-merge hooks
git sem init --backfill    # ...and indexes every branch and tag in the background
```

## Usage

### Read history by meaning

```sh
git sem log                     # commits with their intents
git sem show HEAD --provenance  # every artifact and where it came from
git sem status                  # queue, engine, backfill progress
```

### Follow code, not files

```sh
git sem entity loadUser           # lineage across renames and moves
git sem entity loadUser --worlds  # the entity on every branch
git sem why computeQuota          # why it exists, citing commits
git sem entity confirm <commit> fetchUser loadUser   # settle an ambiguity
```

Entities are functions, classes, methods and types in TypeScript/JavaScript,
Python, Go and Rust. A pure rename or move links exactly (Tier 0); a rename
with edits links by similarity (Tier 1), but only when both bodies are big
enough to tell apart. When two new entities match equally
well, git-sem shows both and waits for you to confirm.

`why` answers only from intents that are authored by a person or proposed
with enough confidence outside a bulk import. Otherwise it says the record
is insufficient instead of inventing a reason.

### Search everything

```sh
git sem search "retry with backoff"                  # every branch
git sem search "warm cache" --include-unreachable    # also reflog-only work
git sem similar computeQuota
git sem rebuild                                      # recreate the local index
```

Search runs on a local SQLite index built from `refs/notes/sem` with a
deterministic local embedding: no model, works offline, and safe to delete.

### Write and judge intent

```sh
git sem commit                  # commit with a history-aware draft
git sem commit --draft          # just show the draft
git sem intent HEAD --set "Cap retries at three attempts"
git sem intent HEAD --accept    # adopt the proposal as yours
git sem intent --branch feature/timeouts --base main   # one intent per branch
```

The draft lists what earlier commits on the same files were for, warns when
a file returns exactly to a state an earlier commit replaced, and asks
questions instead of inventing reasons:

```
Change src/config.env

# git-sem draft · engine=heuristic model=none confidence=0.10
#
# WARNING: this reverts eb0c994 "wip" on src/config.env
#   its intent: Raise retries to five for the flaky upstream [authored]
#
# Questions for you:
#   - This undoes eb0c994 ... Is that intended, and why?
#   - Why is this change needed? The draft only says what changed.
#
# Related history (touched the same files):
#   eb0c994  Raise retries to five for the flaky upstream [authored]
```

### Merge with your eyes open

```sh
git sem merge-view a b            # entities both sides changed, with both intents
git sem check a b                 # clean-as-text but suspect-as-logic warnings
git sem check a b --deep          # plus a Tier 3 review (budgeted)
git sem resolve <path>            # propose a resolution for a conflicted file
git sem resolve <path> --accept   # write it (you still stage it)
```

`check` warns when both sides export the same name from different files of
the same language, or when one side renames or removes something the other
side starts using.
Warnings never block. When you merge anyway, the merge commit records that
decision and who made it.

### Share with the team

```sh
git sem push origin    # share refs/notes/sem
git sem fetch origin   # receive and union theirs
git sem prune          # keep shared notes to what can't be recomputed
```

Only what nobody else could rebuild is shared: intents from a model, an
agent or a person, merge decisions, confirmed links and roll-ups. Everything
git-sem can recompute from the code without a model (changes, file facts,
entities, entity events, heuristic intents) lives in `refs/notes/sem-local`,
which is never pushed. A fresh clone recomputes it on `git sem index`, with
no model calls for commits a teammate already described.

```
 refs/notes/sem        shared · pushed
   intents (model, agent, person)
   decisions · links · roll-ups
 refs/notes/sem-local  this clone only
   changes · file · entities ·
   entity-events · heuristic intents
```

Set `sem.share = derived` to share everything, as 0.2 did, if your team
would rather skip the recompute on fresh clones.

Every push applies the same rule after merging, so records that were moved
or dropped cannot come back through a teammate's notes. To also drop the
shared notes' old snapshots:

```sh
git sem prune --squash
git sem push origin --force-with-lease   # refused if anyone pushed since your fetch
git sem fetch origin --reset             # teammates: take the squashed notes
```

### For agents

```ts
import { openSemantic } from "git-sem/src/api.ts";

const sem = await openSemantic("/path/to/repo");
await sem.entity("loadUser");   // versions, intents, commit ids
await sem.why("computeQuota");
await sem.search("retry with backoff");
await sem.proposeIntent("HEAD", "Move loading behind the service layer", { agent: "my-agent" });
```

The same operations are available over MCP on stdio:

```json
{ "mcpServers": { "git-sem": { "command": "git", "args": ["sem", "mcp"] } } }
```

Tools: `sem_log`, `sem_show`, `sem_entity`, `sem_why`, `sem_search`,
`sem_propose_intent`. Agent proposals are stored with the agent's name and
stay proposals until a person runs `git sem intent <rev> --accept --agent <name>`.

## Tiers

```
 Tier 0  deterministic    entity lineage, changes,
                          reversals, check
            │
 Tier 1  local, no model  search, similar,
                          fuzzy rename links
            │
 Tier 2  intent engine    intents, drafts,
         (background)     roll-ups, resolve
            │
 Tier 3  frontier engine  check --deep only,
         (on request)     daily budget
```

Every answering command reports its tier in `--json`. Indexing never uses
Tier 3.

## Engines

An engine proposes meaning. Two are built in:

| Engine | Tier | What it does |
|---|---|---|
| `heuristic` (default) | 0 | Trusts a descriptive commit subject, otherwise describes the touched paths. Summarizes by listing; resolves only one-sided conflicts. No model. |
| `command` | configurable | Runs any program that speaks the JSON protocol below. |

The program receives one JSON object on stdin with `protocol: 1` and a
`task`:

| task | input | output `text` |
|---|---|---|
| `intent` | subject, body, changes, diff; when drafting also `history` and `reversals` | one-sentence intent |
| `summarize` | `intents[]` of a branch | one branch-level intent |
| `resolve` | `path`, `base`, `ours`, `theirs` | the proposed file contents |
| `contradictions` | intents of both sides, Tier 0 `warnings[]` | a review |

It prints `{"text": "...", "confidence": 0.0-1.0, "questions": ["..."]}`
(`questions` optional). See [`examples/engines/ollama.ts`](examples/engines/ollama.ts)
for a local model.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `sem.autoindex` | `true` | Index in the background after each commit and merge |
| `sem.engine` | `heuristic` | `heuristic` or `command` |
| `sem.command` | — | Shell command for the command engine |
| `sem.model` | — | Model id recorded in provenance |
| `sem.promptVersion` | `intent/v1` | Prompt version recorded in provenance |
| `sem.tier` | `2` | Tier recorded for the command engine |
| `sem.timeout` | `120000` | Engine timeout in ms |
| `sem.frontier.command` | — | Tier 3 engine command (used only on request) |
| `sem.frontier.model` | — | Tier 3 model id |
| `sem.frontier.dailyBudget` | unlimited | Maximum Tier 3 calls per day |
| `sem.share` | — | `derived` to also share records that can be recomputed |

## Upgrading

From 0.2: run `git sem prune` once, then `git sem push`. Recomputable
records move out of the shared notes, superseded ones are dropped, and the
push shares the smaller notes. On a 40-commit test history with a model
engine the shared notes went from 91 KB to 12 KB.

Entity events also changed format (wrapped signatures, same-name moves).
Run `git sem index --all` once to store the new events; until then they
are recomputed on the fly when read.

## Performance

On a 500-commit history with the heuristic engine: backfill 1.9 s, an
idempotent re-run 0.25 s, `git sem log` 0.07 s, the first search 0.22 s
(including building the index) and later searches 0.10 s.

## Development

```sh
bun test          # unit + end-to-end
bun run typecheck
```

The user stories in [`features/`](features) are executable. Each scenario
runs as an end-to-end test in a sandbox with its own HOME, real git
repositories, bare remotes for team scenarios, and deterministic fake
engines that log every call, so "no inference happened" is asserted from
behavior.

## Status

| | Feature | Status |
|---|---|---|
| F1 | Non-blocking indexing | ✅ |
| F2 | Intent capture and branch roll-up | ✅ |
| F3 | Semantic log | ✅ |
| F4 | Semantic search | ✅ |
| F5 | "Why does this exist?" | ✅ |
| F6 | Cross-world identity | ✅ |
| F7 | Semantic merge assist | ✅ |
| F8 | Contradiction detection | ✅ |
| F9 | Provenance and replay | ✅ |
| F10 | Model upgrades | ✅ |
| F11 | Tiered escalation | ✅ |
| F12 | Team sharing | ✅ |
| F13 | Local-first index | ✅ |
| F14 | Agent API and MCP | ✅ |
| F15 | History-aware commit drafting | ✅ |
| F16 | Adopt an existing project | ✅ |

Known limits are listed in [docs/architecture.md](docs/architecture.md#known-limits).
See [docs/principles.md](docs/principles.md) for the reasoning.
