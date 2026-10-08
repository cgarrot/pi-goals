# pi-goals

Standalone **Pi extension** for **parent-owned goal/TODO work graphs**:
**one active runtime goal per scope** (solo `local`, private `agent:<sessionId>`,
shared `room:<id>`), a sub-TODO tree under it, delegated lanes that
return claims, CAS-guarded mutations with replay receipts, and oracle-gated
completion. Extracted from zob-harness following the pi-mesh pattern — one
concern, one package, **zero runtime dependencies**, usable à la carte in
any Pi install. The full goal lifecycle lives here without assuming the
rest of the harness: no delegation runtime, no coms, no factory — just the
goal engine, its store, and a thin Pi adapter.

```
              ┌──────────────────────────────────────────────────┐
              │  GoalRuntimeEngine (src/runtime)                 │
              │  create/pause/resume · todos · delegation/claims │
              │  propose → oracle → complete (gates)             │
              └───────────────▲──────────────────────────────────┘
                              │ same engine calls (no separate logic)
     ┌────────────────────────┴───────────────┐   ┌────────────────┐
     │ Pi extension (src/extension)           │   │ CLI (src/cli)  │
     │ 20 tools + /goal /todo + HUD           │   │ status/tree/   │
     │ session mirror (body-free)             │   │ list/stats/    │
     └────────────────────────▲───────────────┘   │ export         │
                              │                   └───────▲────────┘
   model loop (tools, CAS params)                           │ read-only
              ┌───────────────▼─────────────────────────────┴────────┐
              │  store (src/store): <cwd>/.goals                    │
              │  goals/<id>/{goal,todos,claims}.log.jsonl (streams) │
              │  goals/<id>/runtime-goal.json (overlay)             │
              │  cas-receipts.jsonl · snapshot+marker · quarantine/ │
              └─────────────────────────────────────────────────────┘
```

## Install / use

**As a Pi package** (auto-loads the extension, tools, commands, and skill):

```bash
pi install npm:pi-goals-extension
# or pinned to a release tag
pi install git:github.com/cgarrot/pi-goals@v0.1.0
```

**From source:**

```bash
git clone git@github.com:cgarrot/pi-goals.git
cd pi-goals && npm install
npm run build        # tsc → dist/ (needed for CLI + tests + smoke)
```

State lives under `<cwd>/.goals` (override with `GOALS_STATE_DIR`, or pass
`--state-dir` to the CLI). Try the headless end-to-end demo:

```bash
npm run smoke        # lifecycle + delegation claim + crash quarantine, exit 0
npm run cli -- status --state-dir /tmp/some-store
```

## Tools (20)

| tool | purpose |
|---|---|
| `create_goal` | create the active goal of a scope (`scope`: `local` default · `agent` private lane · `room:<id>` shared lane) |
| `resume_goal` | resume paused/blocked/oracle_failed/budget_limited with a reason |
| `get_goal` | status block: objective, TODO summary, usage, oracle, next action (pass `goal_id`/`scope` when several lanes are active) |
| `get_goals` | multi-agent overview: one line per goal with its scope, active lanes flagged |
| `get_goal_todos` | TODO tree with icons ○ ● ✓ ⊘ ⤫ and progress (bare call = full tree; optional todo_id/todo_path ref narrows) |
| `add_goal_todo` | add ONE todo |
| `add_goal_todos` | atomic batch (single persisted snapshot) |
| `update_goal_todo` | patch metadata only — a `status` param is explicitly rejected (use `resolve_goal_todo`) |
| `resolve_goal_todo` | primary transition API: auto/complete/accept_claim/reject_claim/block/skip/reopen |
| `complete_goal_todo` | complete (or skip with reason) |
| `block_goal_todo` | mark blocked with a reason — available from EVERY non-terminal status (claim-returning states included when no claim is bound) |
| `split_goal_todo` | split into required child subtodos (one atomic batch) |
| `link_goal_todo_delegation` | launch a delegation attempt (policy frozen at launch, node → delegated) |
| `return_goal_todo_claim` | child returns a claim (`claim_text` or exact `claim_hash`; stored hash-only) |
| `validate_goal_todo_claim` | record oracle validation of a returned claim (strict-PASS composition; optional `agent`/`run_id` provenance persisted; blocking issues stored hash-only) |
| `accept_goal_todo_claim` | parent accepts a returned claim (exact binding echo; `oracle_required` claims additionally require a recorded strict-PASS validation) |
| `reject_goal_todo_claim` | parent rejects a returned claim with a reason |
| `propose_goal_completion` | goal → ready_for_oracle (blocked while required todos are open; an empty tree lists an explicit "todo tree is empty" blocker) |
| `record_goal_oracle` | bind the immutable oracle decision (PASS/no_ship=false to ship) |
| `update_goal` | complete the goal — only after a bound strict-PASS decision |

`cas` is OPTIONAL on every mutation (zob parity): absent revision slots are
simply unchecked, and a call without `cas` applies under a fresh
auto-generated mutation id. Pass `cas.mutation_id` (revisions optional) for
idempotent mutations: exact replay is a no-op `replayed` result, a stale
PROVIDED revision fails `cas_stale` with the current-revision hint, and
every applied mutation lands a hash-chained receipt in `cas-receipts.jsonl`.

## Commands

```
/goal                    status (objective/usage/oracle/next)
/goal <objective> [--scope s]   create (s = local | agent | room:<id>)
/goal scopes             list every goal per scope (multi-agent overview)
/goal pause <reason> [--scope s]     pause a lane's goal (loop off)
/goal resume <reason> [--scope s]    resume a paused/blocked/oracle_failed goal
/goal clear [--scope s]  clear that lane's goal view (streams stay append-only)
/goal mode [manual|validation|auto]
/todo                    render the TODO tree
/todo add <title> [--scope s]  add one TODO to that lane's goal
```

## Scopes (multi-agent swarms)

All agents sharing one repo cwd share ONE `.goals` store — historically
that meant ONE active goal for everyone (the first agent's goal blocked
every other agent with `goal_already_active`). v0.2 scopes fix this:

- **`local`** — the solo default. Pre-scope stores keep working unchanged;
  a bare `create_goal` still targets it, and bare mutations keep resolving
  the single active goal (zob contract).
- **`agent:<sessionId>`** — a private per-session lane (shorthand
  `scope: "agent"`). Session ids are stable across `/reload`; the mesh
  alias rides along as a display-only `scopeLabel`.
- **`room:<roomId>`** — a shared lane for every mesh agent of that room
  (shorthand `scope: "room"` works when the session joined exactly one
  room; otherwise pass `room:<id>` explicitly).

Rules:

- single active goal **per scope** — different lanes never block each
  other; `multiple_active_goals` only fires within one scope;
- when several lanes are active, bare calls answer `scope_ambiguous`
  naming every lane — retry with `goal_id` or `scope` (`get_goals`
  disambiguates);
- CAS revisions stay per-goal: lane A mutations never stale lane B guards
  (the global `cas-receipts.jsonl` only keys mutation ids);
- `$GOALS_SCOPE` (e.g. `agent`) opts a whole session into a default lane
  WITHOUT changing the tool contracts — absent it, the default stays
  `local` and a detected mesh session only adds a hint to `create_goal`;
- shared `room:*` lifecycle events drop best-effort files under
  `.goals/outbox/` for a mesh relay to poll (pi-goals itself never calls
  the mesh — it stays standalone); private `agent:*` lanes never broadcast.

Concurrent agents already serialize safely: the file lock
(`$TMPDIR/goals-<uid>/goals.lock`) is machine-global, and every engine
mutation restores the full store inside the lock before appending.

Read-only CLI (built outputs, no Pi needed). The package exposes a `goals`
bin (shebang entry, `npx`/global-install friendly):

```
npm exec -- goals [--state-dir <dir>] status|tree|list|stats|export [goalId]
# or directly:
node dist/src/cli/goals.js [--state-dir <dir>] status|tree|list|stats|export [goalId]
```

A corrupt store answers honestly: restore-blocked diagnostics on stderr and
exit 1 (fail-closed, never a partial view).

`export` dumps deterministic JSON (goal + todos + claims + receipts);
a restore-blocked store prints diagnostics and exits 1 — fail-closed.

Uniform CLI exit codes (batch-#2 fix):

| code | meaning |
|---|---|
| 0 | ok — `list`/`stats`/`export` still print a stderr warning (`warning: N quarantined stream(s) — goals may be incomplete`) when `quarantine/` is non-empty |
| 1 | store blocked or unavailable — restore-blocked diagnostics, missing store/goal |
| 2 | usage error — unknown command/flag or bad arguments, usage hint on stderr |

## Store layout

```
.goals/
  cas-receipts.jsonl            global CAS receipts (replay + audit)
  outbox/                       room-scope lifecycle events (mesh relay, best effort)
  goals/<goalId>/
    goal.log.jsonl              goal lineage: goal_set / goal_clear events (revision 1..N)
    todos.log.jsonl             todos_snapshot / todo_updated events
    claims.log.jsonl            delegation attempts, claims, validations, settlements
    runtime-goal.json           engine overlay (usage, loop, proposal, oracle decision)
    snapshot.json + marker      compaction baseline (optional)
  quarantine/<goalId>/          torn/corrupt streams moved here with a diagnostic json
```

Restore is fail-closed: revision gaps/conflicts, malformed lines, unknown
schemas, and truncated tails (crash simulation) quarantine the offending
stream and block mutations — never a partial replay.

## Parity with zob-harness

Semantics are distilled from the zob-harness goal/TODO runtime with
deliberate reworks ("en mieux"). The invariant-by-invariant mapping and the
full deviations table live in [docs/PARITY.md](docs/PARITY.md). Summary of
deviations: tightened reopen gate, empty-tree-not-shippable, strict-PASS
auto-accept, precise tamper codes, 16-tool CAS core (import/handoff out of
core), complete/clear/pause under `update_goal`, at-least-once receipt
window, the explicit `pauseGoal` engine mutation, and **scoped goals**
(single active goal per scope instead of per store).

## Development

```bash
npm run build     # tsc → dist/
npm test          # build + node:test over dist/test (330 tests)
npm run smoke     # headless E2E demo against a temp store
npm run cli -- list
```

Layering: `src/core` is pure (no fs/env/clock); `src/store` owns `.goals`
I/O (append-only streams, lock, receipts); `src/runtime` composes them into
the engine (stateless per mutation); `src/extension` is a thin Pi adapter;
`src/cli` is a read-only view. Node ≥ 22, MIT.

## Releases & publishing

- Versioning follows semver from `package.json` (`v0.1.0` = tag + npm version).
- The `Release` GitHub Action publishes to npm automatically on `v*` tags
  (requires the `NPM_TOKEN` repository secret):
  `npm version patch|minor|major && git push && git push --tags`.
- `prepublishOnly` runs the full build + test suite before every publish.
- The package is published as `pi-goals-extension` on npmjs.org
  (`publishConfig.access` is public; the plain `pi-goals` name is taken on
  npm by another project) and is a Pi package (`pi` manifest +
  `pi-package` keyword), so `pi install npm:pi-goals-extension` works on any
  machine and the package appears in the pi.dev gallery automatically.

## Status

v0.2.0 — adds **scoped goals** for multi-agent swarms (local/agent/room
lanes, `scope` tool param, `get_goals`, `--scope` commands, `$GOALS_SCOPE`
session default, room outbox) on top of v0.1.0 Phase 1–6 (scaffold, core
(tree/transition/completion/claims/proposal/CAS), store
(streams/restore/snapshot), runtime engine (+ pause), Pi extension
(20 tools + commands + HUD), CLI, smoke, skill, parity matrix). No
commit/tag/publish until the tree review approves.
