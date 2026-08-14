# `orch prune` — Design

Date: 2026-08-14
Status: approved in design; not implemented

## 1. Purpose

Add `orch prune`: a command that reconciles the `orchestrator/<run-id>` branches actually present
in a repository against the run rows in the database, and reports which are provably safe to
delete.

It does not change policy. [`SPEC.md`](../../../SPEC.md) §5 says the worktree directory is removed
on any terminal state and "the branch itself is never deleted automatically"; §8 says "nothing is
auto-deleted on failure/cancellation … deletion is a manual action the user takes later if they
want it." Both stay exactly as written. What is missing today is not permission to clean up, it is
a safe way to do it.

Today that cleanup is entirely manual and entirely unaided:

- `orch list` prints run ids and statuses, never branch names, and never whether the branch still
  exists.
- Mapping a run to its branch requires knowing the `orchestrator/<run-id>` convention by hand.
- Nothing answers "which of these are merged, which came from failed runs, which still have a live
  worktree".
- Branches accrue one per run, forever, UUID-named — in the **target** repository, so they
  accumulate in whatever project the console is pointed at, not in the console's own checkout.

The motivating case is ordinary: on 2026-08-14 this repository had four leftover branches, and
sorting them took an `orch list` in one terminal and eyeballing UUIDs against `git branch` in
another.

## 2. Non-goals

- **Deleting worktree directories.** That stays `orch cancel`'s job. Two commands able to destroy
  Execute's uncommitted output is one more than should exist.
- **Touching remotes.** Run branches are local by construction. Nothing here pushes or deletes a
  remote ref.
- **Writing to the database.** Run rows are history and survive their branches. A pruned run still
  shows up in `orch list` and `orch show`.
- **Pruning across projects.** One repository per invocation, chosen the same way `orch run`
  chooses one.

## 3. Surface

```
orch prune [--project <path>] [--base <ref>] [--force] [--yes] [--json]
```

| flag | effect |
|---|---|
| *(none)* | report only — always safe |
| `--yes` | apply the deletions |
| `--force` | widen the delete set to unmerged terminal-run branches |
| `--base <ref>` | what "merged" is measured against; default resolved, always printed |
| `--project <path>` | repository to prune, default cwd |
| `--json` | machine-readable output; combines with `--yes` |

`--project` is `resolve()`d at the boundary in `index.ts`, exactly as `run` already does and for the
same reason recorded there: a relative path that reaches `src/lib/**` is stored and later read by a
different process with a different working directory.

### 3.1 No prompt, in either direction

A bare `orch prune` only ever reports. `--yes` is the only thing that deletes. There is deliberately
no interactive `y/N` confirmation, even on a TTY.

This is the same contract for a human and for an agent, needs no stdin, and — the deciding
reason — keeps a destructive command out of `prompt.ts`. `AGENTS.md` records two load-bearing
invariants in that file (SIGINT re-raise with a ref'd timer; the `close` rejection and the
registration order of the `interrupting` listener), each of which cost a review round to establish
under a pty, and neither of which has an automated guard. Adding a new caller there spends risk in
the worst available place.

## 4. Enumeration: git first, database second

`prune` walks the `orchestrator/*` branches that exist in the repository and looks each run up by
id — not the other way around.

Going through `listRuns` would cap at 20–50 rows, and would also assume this machine's database is
the one that created the refs. The repository is the only authority on which branches exist; the
database is the only authority on what their runs did. Each answers the half it owns.

## 5. Verdicts

Per branch:

| verdict | condition | reason code |
|---|---|---|
| `delete` | run terminal, every commit already upstream of base | `merged` |
| `delete` | run terminal, nothing beyond `plan_commit_sha` | `plan-only` |
| `delete-with-force` | run terminal, has real unmerged work | `unmerged-work` |
| `keep` | run in any non-terminal status | `run-active` |
| `keep` | branch checked out in a live worktree | `worktree-checked-out` |
| `keep` | no database row for that run id | `no-run-record` |

Rules are evaluated in that order, and the three `keep` rules outranking the merge test is
deliberate: a branch can be both fully merged and checked out by a live Execute, and deleting it
there is the one case that destroys work someone is actively producing.

**Orphans stay even under `--force`.** With no row there is no status, so nothing supports the
judgement. Forcing means "I know this run is over and I do not want its commits" — which is exactly
what an orphan branch cannot tell us.

**`plan-only` is a real deletion of a real commit.** The `orchestrator: add plan` commit is
genuinely unmerged, so `git branch -d` refuses it and the implementation must pass `-D` for this
verdict. Nothing is lost that is not also on the run row: `plan_text` holds the same content, and
`orch show` still prints it after the branch is gone.

### 5.1 The merge test is `git cherry`, not `merge-base --is-ancestor`

Ancestry answers "was this exact commit merged", which is false for any work that reached the base
by cherry-pick or rebase. That is not hypothetical here: run `0beeef4e`'s deck commit reached
`develop` as the cherry-pick `c57b619`, so its own branch is not an ancestor of `develop` despite
being merged in substance. An ancestry test would report it as carrying unmerged work — true of its
SHAs, false of its content, and wrong about the only thing the safe set is supposed to guarantee.

`git cherry <base> <branch>` compares patch ids and prints `-` for commits already upstream, `+`
for those that are not. Zero `+` lines means merged. Ancestry remains a valid cheap pre-check.

### 5.2 Base resolution

`origin/HEAD` → `develop` → `main` → `master` → current `HEAD`; first that resolves wins, and the
choice is printed in the report header. `--base` overrides and is verified before use.

Never hardcoded to `main`. `commands.ts` already carries the note explaining what that costs
elsewhere in this CLI: this repository's own workflow branches off `develop`, so a hardcoded base
produces output that is quietly about the wrong range. Here the failure would be worse than
confusing output — a wrong base makes real unmerged work test as merged.

### 5.3 Stale worktree records

`git worktree prune` runs before listing. Those stale administrative records are exactly what a
stranded run leaves behind, and they make `%(worktreepath)` report a branch as checked out when
nothing has it. `git worktree prune` only drops records for directories that no longer exist; it
never deletes a directory, which is what keeps §2's non-goal intact.

## 6. Output

Branch names print in full, never abbreviated — the same rule `list` follows for run ids, and for
the same reason recorded there: the point of the output is that a line can be pasted into the next
command, and a truncated `orchestrator/0beeef4e…` is not a ref anything resolves.

```
project /path/to/repo
base    develop

DELETE  orchestrator/0beeef4e-…  approved              merged into develop
DELETE  orchestrator/12331ac3-…  failed                plan-only, no work commits
KEEP    orchestrator/9a1f22b0-…  approved              3 unmerged commits — use --force
KEEP    orchestrator/44c0de11-…  executing             run is executing

2 to delete, 2 kept. Re-run with --yes to apply.
```

## 7. Agent contract

Read `--json`, decide, re-invoke with `--yes`. No TTY, no stdin, idempotent.

Reason codes are a closed set rather than prose, because a caller that has to regex an English
sentence to decide what to do next has no contract at all.

```json
{
  "project": "/path/to/repo",
  "base": "develop",
  "force": false,
  "applied": false,
  "branches": [
    {
      "branch": "orchestrator/0beeef4e-…",
      "runId": "0beeef4e-…",
      "status": "approved",
      "verdict": "delete",
      "reason": "merged",
      "commitsAhead": 0,
      "deleted": false,
      "error": null
    }
  ],
  "summary": { "delete": 2, "keep": 2, "deleted": 0, "failed": 0 }
}
```

`summary.delete` counts what *this* invocation would act on, i.e. `delete` plus `delete-with-force`
when `--force` is given — not the raw verdict tally.

### 7.1 Exit codes

Reusing `EXIT` from `exit-codes.ts`:

| code | when |
|---|---|
| `0` | reported or applied successfully — **including when nothing was deleted** |
| `64` (`USAGE`) | not a git repository, bad `--project`, unresolvable `--base` |
| `2` (`FAILED`) | a deletion was attempted and git refused or errored |

"Nothing to prune" is success. An agent that treats an empty result as failure will either retry
forever or escalate a clean repository, so idempotence has to be visible in the exit code and not
only in the text.

## 8. Structure

| file | change |
|---|---|
| `src/lib/db.ts` | export `TERMINAL_STATUSES` (currently a private const in `pipeline.ts`), alongside the existing `ACTIVE_`/`GATE_`/`UNFINISHED_STATUSES` |
| `src/lib/git.ts` | git primitives: repo check without the clean-tree requirement, list run branches, `git cherry` count, commits-since-sha count, resolve base, delete branch, prune worktree records |
| `src/cli/prune.ts` | **new, pure** — takes gathered facts, returns verdicts and rendered text/JSON |
| `src/cli/commands.ts` | `prune()`, wiring the git calls to that module |
| `src/cli/index.ts` | dispatch, `USAGE` line, four new `OPTIONS` |
| `src/cli/prune.test.ts` | the verdict matrix |
| `SPEC.md` | a subsection under §5 |
| `AGENTS.md` | a line under Commands |

Two constraints from `AGENTS.md` shape this and are not negotiable:

- **`src/cli/prune.ts` must import only *types* from `src/lib/**`.** Files under `src/cli/` that
  have unit tests run through Node's type-stripping loader, which cannot resolve the extensionless
  specifiers `src/lib/**` uses internally. Everything git or SQLite knows therefore arrives as a
  plain facts object gathered by `commands.ts`, which is verified end-to-end against the built
  bundle instead.
- **`src/cli/prune.test.ts` must be appended to the explicit file list in the `test` script.**
  `node --test src/` does not discover `.ts` tests on Node 22; a test file missing from that list
  never runs and the suite still reports green.

`validateProject` is not reused as-is. Its clean-tree check is right for starting a run and wrong
here: `prune` deletes refs and never touches the working tree, so refusing to clean up branches
because a file is edited would block the command for the most ordinary reason a person has the
repository open at all. The first three checks are extracted into `checkGitRepo` and shared.

## 9. Testing

`prune.ts` is pure, so the verdict matrix is unit-testable: all six reason codes, plus the
`--force` promotion of `delete-with-force`, plus the empty-repository and nothing-actionable
renderings.

`commands.ts` is not unit-testable in this repository, so its half is verified by hand against a
throwaway git repository, and the cherry-pick case is verified explicitly — it is the one an
ancestry check gets wrong, so a manual pass that omits it has not tested the rule that matters.

## 10. Open questions

None blocking. One thing is knowingly accepted: after a prune, `orch show` still names a branch
that no longer exists. Recording the deletion on the run row would need a new column and a
migration, which is not worth it for a display detail — but it should be a documented consequence
rather than a surprise.
