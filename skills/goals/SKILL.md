---
name: goals
description: Use when planning or running long multi-step work with the pi-goals extension — creating runtime goals, TODO/subtodo trees, delegated claims, or oracle-gated completion. Read this before calling goal tools or /goal and /todo commands.
---

# pi-goals — goal/TODO work-graph usage

Parent-owned goal work graph: one active goal, a TODO tree under it,
delegated lanes return claims, and completion is oracle-gated.

## When to use

- work is clearly long, multi-step, delegated, or evidence-gated;
- you need visible progress (HUD + TODO tree) and honest completion blockers;
- you delegate lanes to children and must accept/reject their claims.

## Non-negotiable invariants

- **No floating TODOs** — TODOs exist only under an active runtime goal
  (`create_goal` / `/goal <objective>` first).
- **No completion before oracle PASS** — `update_goal status=complete` only
  after `propose_goal_completion` AND a bound oracle decision with
  `verdict=PASS, no_ship=false`. Never complete from TODO status alone.
- **Never propose while required TODOs are open** — required todos must be
  `done`/`skipped` (with reason/evidence); no_ship=true blocks proposal.
- **`resolve_goal_todo` is the primary transition API**
  (auto/complete/accept_claim/reject_claim/block/skip/reopen).
  `update_goal_todo` is metadata-only — it can never change status.
- **Claims are parent-owned** — a delegated child returns a claim
  (claim_hash); only the parent validates and accepts/rejects it. A child
  never mutates the canonical TODO graph or completes the parent todo.
- **No stale todo refs** — refresh ids with `get_goal_todos`; prefer the
  canonical `todo_id`; use `todo_path` (e.g. "1.2") only as a safe fallback,
  never path text inside `todo_id`.
- **CAS is optional but recommended** — pass the `cas` block (mutation_id +
  current revisions from the last result) for idempotent mutations: same
  mutation_id replays as a no-op; a provided-but-stale revision fails
  `cas_stale`, never silently overwrites. Without `cas` the mutation still
  applies (fresh auto-generated id, not replay-idempotent).
- **The store is canonical** — `.goals/` under the project (override
  `GOALS_STATE_DIR` or CLI `--state-dir`); streams are append-only,
  fail-closed on corruption (quarantine, never partial replay).
- **Persisted records stay hash-only** — claim text, reasons, summaries,
  and blocking issues are stored as hashes; evidence lives in refs, not
  bodies.
- **Delegation is parent-owned** — launch attempts with
  `link_goal_todo_delegation` (policy frozen at launch), children return
  claims with `return_goal_todo_claim` (claim_text or exact claim_hash);
  `oracle_required` claims are accepted ONLY after a strict-PASS
  `validate_goal_todo_claim` (verdict PASS, no_ship false).

## Lifecycle

    /goal <objective>            create (single active goal)
    add_goal_todos               batch a bounded plan (3-9 top-level, subtodos for breadth)
    resolve_goal_todo            work the tree (complete/skip/block)
    link lane → child returns claim → validate_goal_todo_claim → accept_goal_todo_claim
    propose_goal_completion      when completionReady=true, no_ship=false
    record_goal_oracle           PASS/no_ship=false binds the decision
    update_goal status=complete  finish; /goal clear archives the view
    /goal pause|resume <reason>  hold or continue (loop off/on)

## Statuses

Goal: `active → ready_for_oracle → complete` (plus `oracle_failed`,
`paused`, `blocked`, `budget_limited`; all resume with a reason).
TODO: `planned → ready → in_progress → delegated → claim_returned → done`
(sides: `needs_review`, `needs_oracle`, `needs_user`, `blocked`, `skipped`).
