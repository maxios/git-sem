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
  queue.ts          commit queue written by the hook
  lock.ts           single-indexer lock
  config.ts         `sem.*` git config
features/           user stories, executable
test/e2e/           Gherkin runner, steps, sandbox world
test/unit/          pure-function tests
```

## Write path

```
  git commit
      │
      ▼
  .git/hooks/post-commit
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
    └─► intent    inferred · engine tier
        keyed by engine+model+prompt;
        skipped if that key exists
```

Indexing is idempotent. Running it twice does nothing the second time, which
is what makes retries, backfills and model upgrades safe.

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
  refs/notes/sem                 source of truth
  refs/notes/sem-remotes/<r>     last fetched copy of <r>
  .git/sem/                      local only
    queue, queue.processing
    index.lock, last-run.json
```

Records are written with `hash-object` + `notes add -C`, so git stores the
exact bytes. Notes merge with `cat_sort_uniq`: concatenate, sort, deduplicate.
Because every record is a single line, two teammates' notes always union
without conflict, and readers deduplicate by key.

`git sem push` fetches and merges before pushing and retries if it races
another pusher.

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

## Next

```
  F6  entities via tree-sitter;
      rename/move identity
  F4  embeddings + local vector
      index (cache, rebuildable)
  F13 SQLite read cache built
      from refs/notes/sem
  F11 tier routing and budgets
  F7  merge-view over co-touched
      entities
```

Performance work worth doing before large backfills: read notes with
`cat-file --batch` instead of one `notes show` per object, and write notes in
batches via `fast-import`.
