# git-sem

A semantic layer over git.

Git made parallel worlds cheap. Agents now create those worlds faster than
people can read them. `git-sem` records what each change *means*, so the
worlds stay understandable.

```
  inference at WRITE time  (background)
                ≠
  lookup at READ time      (instant)

  the layer proposes · you decide
```

## How it works

```
  git commit
      │
      ▼
  post-commit hook
  appends the hash to a queue,
  returns immediately
      │
      ▼
  background indexer
  ├─ Tier 0  derive changes,
  │          file facts by blob hash
  └─ engine  propose an intent
      │
      ▼
  refs/notes/sem
  immutable records keyed by
  object + engine + model + prompt
      │
      ▼
  git sem log / show
  pure lookup, no inference
```

Semantics live in a git notes ref, so they push, fetch and clone with the
repository. Nothing is ever overwritten: a new model or prompt adds a record
under a new key, and a human-authored intent always outranks a proposal.

## Install

Requires [Bun](https://bun.sh) ≥ 1.1 and git ≥ 2.31.

```sh
git clone https://github.com/maxios/git-sem
cd git-sem
bun install
bun link            # puts `git-sem` on PATH, so `git sem` works
```

Then, in any repository:

```sh
git sem init               # installs the post-commit hook
git sem init --backfill    # ...and indexes existing history in the background
```

## Usage

```sh
git sem log                    # history by intent
git sem show HEAD --provenance # every artifact and where it came from
git sem commit                 # commit with a history-aware draft
git sem commit --draft         # just show the draft
git sem intent HEAD --set "Cap retries at three attempts"
git sem intent HEAD --accept   # adopt the proposal as yours
git sem index --all            # backfill history in the foreground
git sem index --all --background
git sem push origin            # share semantics with the team
git sem fetch origin           # receive and union theirs
git sem status                 # queue, engine, backfill progress
```

Every read command accepts `--json`.

### Writing commits with `git sem commit`

The draft knows what the touched files were for. It lists recent commits on
the same paths with their intents, flags a staged file that returns to the
exact content an earlier commit replaced, and asks questions instead of
inventing a reason:

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
#   48c7471  Set retries
```

What you commit is stored as your authored intent, so every message you
write makes the next draft better. Plain `git commit` is untouched.

### Adopting an existing project

```
  git sem init --backfill
     cheap Tier 0 pass over all
     history, in the background
          │
          ▼
  switch sem.engine to a model
  git sem index --since <tag> --background
     real intents where it matters
          │
          ▼
  git sem push origin
     teammates fetch; nobody re-indexes
```

A 500-commit backfill with the heuristic engine takes about 1.6 s; a re-run
that finds everything indexed takes about 0.25 s.

## Engines

An engine proposes intents. Two are built in:

| Engine | Tier | What it does |
|---|---|---|
| `heuristic` (default) | 0 | Uses a descriptive commit subject, otherwise describes the touched paths. No model. |
| `command` | configurable | Runs any program that speaks the JSON protocol below. |

The command engine receives this on stdin:

```json
{
  "protocol": 1, "task": "intent",
  "model": "llama3.2:3b", "promptVersion": "intent/v1",
  "commit": "<sha or null>", "subject": "...", "body": "...",
  "changes": [{ "status": "M", "path": "src/retry.ts" }],
  "diff": "<unified diff, truncated>",
  "history":   [{ "commit": "...", "subject": "...", "intent": "...", "paths": ["..."] }],
  "reversals": [{ "commit": "...", "path": "...", "intent": "..." }]
}
```

`history` and `reversals` are sent when drafting commits. The engine prints
`{"text": "...", "confidence": 0.0-1.0, "questions": ["..."]}`; `questions`
is optional and is shown to the author. See
[`examples/engines/ollama.ts`](examples/engines/ollama.ts) for a local model.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `sem.autoindex` | `true` | Index in the background after each commit |
| `sem.engine` | `heuristic` | `heuristic` or `command` |
| `sem.command` | — | Shell command for the command engine |
| `sem.model` | — | Model id recorded in provenance |
| `sem.promptVersion` | `intent/v1` | Prompt version recorded in provenance |
| `sem.tier` | `2` | Tier recorded for the command engine |
| `sem.timeout` | `120000` | Engine timeout in ms |

## Development

```sh
bun test          # unit + end-to-end
bun run typecheck
```

The user stories in [`features/`](features) are executable. Each scenario
runs as an end-to-end test in a sandbox with its own HOME, real git
repositories, bare remotes for team scenarios, and a deterministic fake
model that logs every invocation. Scenarios tagged `@wip` are reported as
todo until they are implemented.

## Status

| | Feature | Status |
|---|---|---|
| F1 | Non-blocking indexing | ✅ |
| F2 | Intent capture | ✅ (branch roll-up planned) |
| F3 | Semantic log | ✅ |
| F4 | Semantic search | planned |
| F5 | "Why does this exist?" | planned |
| F6 | Cross-world identity | planned |
| F7 | Semantic merge assist | planned |
| F8 | Contradiction detection | planned |
| F9 | Provenance and replay | ✅ |
| F10 | Model upgrades | ✅ |
| F11 | Tiered escalation | planned |
| F12 | Team sharing | ✅ |
| F13 | Local-first index | planned |
| F14 | Agent API | planned |
| F15 | History-aware commit drafting | ✅ |
| F16 | Adopt an existing project | ✅ |

See [docs/principles.md](docs/principles.md) for the reasoning and
[docs/architecture.md](docs/architecture.md) for the design.
