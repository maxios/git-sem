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
git sem init        # installs the post-commit hook
```

## Usage

```sh
git sem log                    # history by intent
git sem show HEAD --provenance # every artifact and where it came from
git sem intent --staged        # propose an intent before committing
git sem intent HEAD --set "Cap retries at three attempts"
git sem intent HEAD --accept   # adopt the proposal as yours
git sem index --all            # backfill existing history
git sem push origin            # share semantics with the team
git sem fetch origin           # receive and union theirs
git sem status
```

Every read command accepts `--json`.

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
  "diff": "<unified diff, truncated>"
}
```

and prints `{"text": "...", "confidence": 0.0-1.0}`. See
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
| F10 | Model upgrades | ✅ (background backfill planned) |
| F11 | Tiered escalation | planned |
| F12 | Team sharing | ✅ |
| F13 | Local-first index | planned |
| F14 | Agent API | planned |

See [docs/principles.md](docs/principles.md) for the reasoning and
[docs/architecture.md](docs/architecture.md) for the design.
