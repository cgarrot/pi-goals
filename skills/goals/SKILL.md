---
name: goals
description: Use when planning or running long multi-step work with the pi-goals extension — creating runtime goals, TODO/subtodo trees, delegated claims, or oracle-gated completion. Read this before calling goal tools or /goal and /todo commands.
---

# pi-goals — goal/TODO work-graph usage

Parent-owned goal work graph: one active goal **per scope**, a TODO tree
under it, delegated lanes return claims, and completion is oracle-gated.

## Scopes (multi-agent swarms)

Every Pi agent sharing the project cwd shares ONE `.goals` store. Scopes
keep lanes independent:

- **`local`** — solo default; bare `create_goal` targets it; pre-scope
  stores behave exactly as before (bare mutations resolve the single
  active goal).
- **`agent:<sessionId>`** — private lane, shorthand `scope: "agent"`
  (stable across /reload; mesh alias shown as scopeLabel).
- **`room:<roomId>`** — shared lane for mesh agents of that room;
  shorthand `scope: "room"` only when the session joined exactly one room,
  otherwise `room:<id>` explicitly.

Rules you MUST follow:

- one active goal PER scope — never assume your goal is the only one in
  the store; different agents' lanes coexist;
- when several lanes are active, bare calls fail `scope_ambiguous` —
  retry with `scope` or `goal_id`; `get_goals` lists every lane;
- in a swarm (mesh session detected), ALWAYS pass an explicit `scope` on
  `create_goal` (`agent` for your private work, `room:<id>` for shared
  work) — the default stays `local` and only prints a hint;
- children returning claims don't need the parent's scope:
  `return_goal_todo_claim` resolves the owning goal by attempt id.

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

    /goal <objective> [--scope s]  create (s = local | agent | room:<id>)
    get_goals                      list every lane (disambiguate scopes)
    add_goal_todos                 batch a bounded plan (3-9 top-level, subtodos for breadth)
    resolve_goal_todo              work the tree (complete/skip/block)
    link lane → child returns claim → validate_goal_todo_claim → accept_goal_todo_claim
    propose_goal_completion        when completionReady=true, no_ship=false
    record_goal_oracle             PASS/no_ship=false binds the decision
    update_goal status=complete    finish; /goal clear [--scope s] archives the view
    /goal pause|resume <reason> [--scope s]  hold or continue (loop off/on)

## Statuses

Goal: `active → ready_for_oracle → complete` (plus `oracle_failed`,
`paused`, `blocked`, `budget_limited`; all resume with a reason).
TODO: `planned → ready → in_progress → delegated → claim_returned → done`
(sides: `needs_review`, `needs_oracle`, `needs_user`, `blocked`, `skipped`).
