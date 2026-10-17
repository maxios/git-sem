# Architecture

## Layout

```
src/
  cli.ts            entry point (`git-sem`, so `git sem` works)
  main.ts           command dispatch and help
  commands/         one file per command
  artifacts.ts      record schema, keys, note format, intent resolution
  store.ts          notes-backed artifact store
  indexer.ts        commits → artifacts
  changes.ts        raw diff parsing (diff-tree, diff --cached)
  engines/          heuristic and command engines
  batch.ts          cat-file --batch reader, fast-import note writer
  draft.ts          commit drafting: history, reversals, questions
  background.ts     detached indexer, progress reporting
  entities.ts       Tier 0 entity extraction and per-commit diffing
  entity-git.ts     entity records, events for any commit
  lineage.ts        entity lineage, worlds, why
  embed.ts          Tier 1 local embedding (feature hashing)
  search-index.ts   SQLite read cache rebuilt from notes
  merge.ts          sides of a merge, co-touched entities, checks
  intents.ts        set, accept, agent proposals, branch roll-up
  budget.ts         daily Tier 3 budget
  api.ts            library API for agents (MCP: commands/mcp.ts)
  queue.ts          commit queue written by the hook
  lock.ts           single-indexer lock
  config.ts         `sem.*` git config
features/           user stories, executable
test/e2e/           Gherkin runner, steps, sandbox world
test/unit/          pure-function tests
```

## Write path

```
  git commit / git merge
      │
      ▼
  .git/hooks/post-commit
  .git/hooks/post-merge
  ├─ git rev-parse HEAD >> sem/queue
  └─ if sem.autoindex:
       (git sem index --background &)
      │
      ▼
  git sem index --background
  ├─ tryLock(sem/index.lock)
  │    held? exit; the holder
  │    will drain our entry
  ├─ claim: rename queue →
  │    queue.processing
  ├─ index each commit
  ├─ settle: keep failures,
  │    drop the rest
  └─ release; re-check queue
```

The hook is plain shell. It starts the indexer detached, so nothing on the
commit path waits for a runtime or a model. Claiming work by `rename` is
atomic, so a hook appending at the same moment starts a new queue file and no
entry is lost.

## Indexing one commit

```
  commit
    │
    ├─► changes   derived · Tier 0
    │   diff-tree -r -M vs first parent
    │
    ├─► file      derived · Tier 0
    │   one per new blob, stored on
    │   the blob itself; reused by hash
    │
    ├─► entities  derived · Tier 0
    │   per source blob: functions,
    │   classes, methods, types
    │
    ├─► entity-events  derived · 0/1
    │   added, modified, removed,
    │   renamed, moved, ambiguous
    │
    ├─► decision  derived · Tier 0
    │   merge commits only: merged
    │   despite check warnings, by whom
    │
    └─► intent    inferred · engine tier
        keyed by engine+model+prompt;
        skipped if that key exists
```

Indexing is idempotent. Running it twice does nothing the second time, which
is what makes retries, backfills and model upgrades safe.

### Batching

```
  git cat-file --batch   one process
     note bodies, blob contents
          │
          ▼
  index in memory
          │
          ▼
  git fast-import        every 200
     one notes commit      commits
     for all new records
```

Reads list the notes tree once (`ls-tree -r`) and fetch bodies through one
long-lived `cat-file --batch`. Writes are buffered and committed with one
`fast-import` per flush. Notes git stored under fan-out directories are
deleted and rewritten flat, so an object never has two notes. If another
writer moved the notes ref meanwhile, the flush reloads, re-merges and
retries.

## Records

Each note is JSON Lines: one immutable record per line.

```json
{
  "v": 1,
  "kind": "intent",
  "object": "<sha>",
  "source": "inferred",
  "engine": "command",
  "model": "m1",
  "prompt": "intent/v1",
  "tier": 2,
  "confidence": 0.9,
  "value": { "text": "..." },
  "evidence": ["<sha>"],
  "createdAt": "2026-10-16T10:00:00.000Z"
}
```

| source | meaning | key |
|---|---|---|
| `derived` | deterministic fact from git | kind + engine + model + prompt |
| `inferred` | proposal from a heuristic or model | kind + engine + model + prompt |
| `authored` | statement by a person | kind + author + time |

Displayed intent is resolved in this order:

```
  1. latest authored
  2. inferred from the configured engine
  3. inferred, highest tier, then latest
```

## Storage and sharing

```
  refs/notes/sem                 shared: what cannot be recomputed
  refs/notes/sem-local           local: recomputable, never pushed
  refs/notes/sem-remotes/<r>     last fetched or pushed copy of <r>
  .git/sem/                      local only
    queue, queue.processing
    index.lock, last-run.json
    progress.json, budget.json
    index.sqlite                 search cache
    proposals/                   resolve proposals
```

Records are written with `hash-object` + `notes add -C`, so git stores the
exact bytes. Notes merge with `cat_sort_uniq`: concatenate, sort, deduplicate.
Because every record is a single line, two teammates' notes always union
without conflict, and readers deduplicate by key.

Which ref a record goes to is decided in one place (`src/sharing.ts`):
records git-sem can recompute without a model (changes, file, entities,
entity-events, heuristic intents) are local unless `sem.share = derived`.
Readers always see both refs: `git log` takes both with two `--notes`
options, and the indexer and search index read them as one store.

A union merge cannot express deletion, so the same rule runs before every
push: after merging the remote, recomputable records move to the local ref
and superseded ones (older formats once the current one exists, heuristic
intents once a better intent exists) are dropped. `git sem prune` runs it
over both refs on demand and squashes the local ref's history;
`--squash` also squashes the shared ref, which only
`push --force-with-lease` (guarded by the last fetched value) can share.

`git sem push` fetches and merges before pushing and retries if it races
another pusher.

## Drafting a commit

```
  staged changes
       │
       ├─► related history
       │   git log --notes -- <paths>
       │   (lookup only)
       │
       ├─► reversals (Tier 0)
       │   staged blob == the old blob
       │   of a past commit on that path
       │
       └─► engine proposal
           with history + reversals
                │
                ▼
  editor template: subject, then
  warnings, questions, history
  as # comments (stripped by git)
                │
                ▼
  committed message is stored
  as an authored intent
```

Low confidence never becomes confident prose: it becomes a question.

## Entities

```
  blob contents
       │  declaration patterns +
       │  brace / indent matching
       ▼
  entities: name, kind, lines,
  hash(body without own name)
       │
       ▼
  per commit, across all
  changed files:
  ├─ same name+path, new hash  modified
  ├─ equal hash elsewhere      renamed/moved  (Tier 0)
  ├─ similarity ≥ 0.7          renamed/moved  (Tier 1)
  │  of meaningful tokens,
  │  both bodies ≥ 6 of them
  ├─ two within 0.05           ambiguous: shown, not decided
  └─ otherwise                 added / removed
```

A merge commit records only files that differ from every parent (as
`git diff --cc` sees them), so a merged branch's events are not repeated.
Lineage walks history newest-first in topological order and follows `from`
links. An ambiguous
succession is followed only after `git sem entity confirm` records an
authored `entity-link`. `why` keeps only intents that are authored, or
inferred with confidence ≥ 0.5 from a commit that added fewer than 10
entities, and reports "insufficient" otherwise.

## Search

```
  refs/notes/sem
       │  rebuild when the notes
       │  tip changes (no model)
       ▼
  .git/sem/index.sqlite
  commit docs   intent + subject
  entity docs   split name + intent
                + body
       │  split identifiers, light
       │  stemming, 512-dim
       │  feature hashing
       ▼
  cosine ranking, best version
  per entity, labeled with
  branches / reflog / unreachable
```

## Merging

`readSides(a, b)` reads the commits in `base..a` and `base..b` with their
notes, computing entity events on the fly for anything not indexed yet. On
top of that:

- `merge-view` keeps entities both sides touched and compares the sides'
  intents with the Tier 1 embedding (≥ 0.4 means likely redundant).
- `check` applies Tier 0 rules: duplicate definitions of an exported name in
  different files of the same language (tests excluded), and renames or
  removals that the other side still adds uses of (`git log -S`, a plain
  string match that behaves the same on every platform, then a word-boundary
  check of added lines in TypeScript).
- `resolve` asks the engine for file contents and stores the proposal under
  `.git/sem/proposals`; `--accept` writes it only if the conflict has not
  changed, and never stages it.

## Agents

`src/api.ts` exposes `log`, `show`, `entity`, `why`, `search` and
`proposeIntent` as plain JSON, and `git sem mcp` serves the same over MCP
(newline-delimited JSON-RPC on stdio). Agent proposals are `inferred`
records with `engine: "agent"` and the agent's name as `model`; only a
person turns them into `authored` intents.

## Read path

`git sem log` is one `git log --notes=refs/notes/sem` call that returns
commits and notes together. Commits without an intent are shown as `pending`.
No read command ever constructs a request to an engine.

## Testing

```
  features/*.feature
        │  @cucumber/gherkin → pickles
        ▼
  test/e2e/features.test.ts
        │  one bun test per scenario
        ▼
  World (sandbox)
  ├─ temp HOME + .gitconfig
  ├─ git-sem shim on PATH
  ├─ repos, bare remotes, teammates
  └─ fake engine that logs calls
```

Assertions about "no inference happened" count the fake engine's log lines
before and after a command, so they test behavior rather than implementation.

## Known limits

- **Entity extraction is pattern-based.** It covers common declarations in
  TS/JS, Python, Go and Rust, not every syntax. A tree-sitter extractor can
  replace it behind the same `extractEntities` signature.
- **Search is lexical.** The Tier 1 embedding matches stemmed words, split
  identifiers and character trigrams, not concepts. A model-backed embedder
  can replace `embed()`.
- **`check` does not scope by package.** Two packages in one repository can
  still both export the same name and warn; scoping by the nearest
  `package.json`, `go.mod` or `pyproject.toml` is the next step.
- **The search index rebuilds fully** when the notes move. Fine for
  thousands of commits; very large histories want incremental updates.
- **Reversal detection is exact.** Partial undos are left to the engine,
  which sees the relevant history.
- **Privacy controls are not built yet**: no `.semignore` or per-path tier
  ceilings. Choose a local engine for sensitive code.
