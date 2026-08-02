Type: grilling
Status: resolved

## Question

What should the console track and display about token usage, cost, and duration per pipeline stage (Plan / Execute / Review)?

Decide:
- What metrics to capture: tokens in/out, estimated cost, wall-clock duration — per stage and/or per run.
- Where each metric is actually sourced from (Claude Code's `stream-json` result events carry usage/cost fields; OpenCode's `--format json` output per ticket 01 — confirm what it exposes, if anything, for a free-tier model where "cost" may not be meaningful).
- Where it's stored (presumably alongside the run record in the SQLite history from Notes) and how it's surfaced in the UI (per-run summary, aggregate stats across runs, both).

## Answer

**Metrics**: capture **duration for every stage** (trivial to measure regardless of CLI), plus **whatever token/cost figures each CLI actually reports** — don't compute or estimate anything ourselves. Claude Code's `stream-json` result event carries token usage and cost, so Plan/Review get real numbers. OpenCode (Execute, free-tier model) is recorded as whatever its `--format json` output exposes; if it reports nothing, that field is simply left empty rather than fabricated — a free model's "cost" isn't a meaningful number to invent.

**Storage & surfacing**: stored as extra columns/fields on the existing per-run SQLite record (Notes). Surfaced as a **per-run summary only** for v1 (e.g. "Plan: 12s, 3.2k tokens · Execute: 45s · Review: 8s, 1.1k tokens, $0.02" on the run detail view) — no cross-run aggregate/rollup dashboard yet; that's a cheap follow-on query over already-stored data whenever it's wanted.
