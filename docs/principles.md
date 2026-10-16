# Principles

## Git as a multiverse manager

A multiverse reduces to three primitives:

```
  State     a complete snapshot of a world
  Pointer   a name that refers to a state
  Observer  whoever stands at a pointer
```

Git avoids every time-travel paradox with one kernel:

```
  immutable, content-addressed states
            +
  parent edges (a DAG)
            +
  mutable named pointers
            =
  a paradox-free multiverse
```

| Problem | Invariant that resolves it |
|---|---|
| Paradox | states are immutable |
| Identity | identity = hash(content) |
| Provenance | every state records its parents |
| Orientation | position is a pointer, separate from state |
| Contradiction | unresolvable conflicts escalate to an observer |
| Explosion | share structure; prune what is unreachable |
| Consensus | reality is negotiated (push/fetch) |
| **Meaning** | **unsolved by the kernel** |

The kernel understands text, not meaning. Two worlds can merge cleanly line by
line and still be logically incompatible. `git-sem` is a layer for the
missing row.

## The rules of the layer

1. **Inference at write time, lookup at read time.** Models run in the
   background after commits land. `log`, `show` and every read path are
   lookups and never call a model.
2. **Key everything by content.** An artifact is keyed by the object it
   describes plus the engine, model and prompt that produced it. Objects never
   change, so artifacts never go stale and never need invalidation.
3. **Never overwrite.** A new model or prompt version adds a record beside
   the old one. Replays are new states, exactly like commits.
4. **The layer proposes; the user decides.** Model output is stored as
   `inferred`. Human statements are stored as `authored` and always win.
5. **Ground every claim.** Each record carries its evidence and provenance.
   "Insufficient evidence" is a valid answer.
6. **Semantics live in git.** The source of truth is `refs/notes/sem`, which
   travels with the repository. Any local index is a disposable cache.
7. **Cheapest tier first.** Deterministic facts (Tier 0) come before small
   local models, which come before large ones. Frontier models run only on
   request.

## Known limits and planned mitigations

| Limit | Mechanism | Today |
|---|---|---|
| Over-trust | cite evidence, show confidence inline, separate authored from inferred | ✅ |
| Privacy | per-path tier ceilings and a `.semignore`; redact before any remote call | planned |
| Garbage in | enrich inputs (PRs, issues, tests); low confidence is shown, not hidden; drafts ask instead of inventing | partial |
| Backfill cost | Tier 0 everywhere, model tiers lazily and by priority; share results through git | ✅ |
| Correctness | crystallize accepted intents into tests and invariants; track intent coverage | planned |
