# PARITY — zob-harness goal/TODO semantics → pi-goals

This is the invariant-by-invariant parity matrix for the goal/TODO slice
distilled from zob-harness (`.pi/extensions/zob-harness/src/runtime/goal-runtime/`
and `.pi/skills/zob-goal-todo-tree/SKILL.md`) into the standalone
pi-goals package. Every parity row cites a REAL test name from `test/`
(all tests run via `npm test`); every deliberate rework is listed in the
deviations table with its rationale. If a row cites no test, it is either
listed as a deviation or does not exist — no invented parity.

## Invariant → test mapping

### Goal lifecycle

| zob invariant | pi-goals behavior | test evidence |
|---|---|---|
| One active runtime goal; creation fails while any non-complete goal exists | engine create gate over the restored store | `create gate: creation is rejected while any non-complete goal exists`; `createGoal: rejected while a non-complete goal is active; exact replay is idempotent; conflicting replay rejected` |
| Statuses: active, ready_for_oracle, oracle_failed, paused, blocked, budget_limited, complete | exact 7-status vocabulary | `defaults and vocabularies: 80 max turns, +12 resume extension, 7 statuses, 3 activation modes` |
| Resume only from paused/blocked/oracle_failed/budget_limited, with a non-empty reason | engine resume gate + zob turn-window rule | `resume gate matrix: only paused/blocked/oracle_failed/budget_limited resume, reason required`; `resume turn-window rule: +12 default when exhausted, explicit extension floored at maxTurns`; `resumeGoal: wrong status rejected; oracle_failed resumes active with the zob turn-window rule` |
| Pause moves an active goal to paused with the loop off | pure pause gate + engine mutation (see D-E7) | `pause gate: pause moves an active goal to paused with the loop off; other statuses are unchanged`; `pauseGoal: active goal pauses with loop off, revision+1, receipt, and LoopHooks notify` |
| Turn accounting: auto turns count, stop reasons pause/block, non-active goals untouched | pure usage accounting with injected clock | `accountRuntimeGoalTurn counts turns, accumulates usage, and applies stop gates purely`; `accountRuntimeGoalUsage adds clamped deltas with an injected now; non-active goals are untouched` |
| Activation modes manual/validation/auto with zob format strings | strict enum + exact strings | `activation modes format exactly like zob and validate strictly` |

### TODO tree (work graph)

| zob invariant | pi-goals behavior | test evidence |
|---|---|---|
| No floating TODOs — TODOs attach to the active goal | engine answers goal_missing without a goal | `no-active-goal paths: get_goal answers honestly, mutations surface goal_missing` |
| 11 TODO statuses, 6 owners, 4 priorities, zob action set | verbatim vocabularies | `GoalTodoStatus keeps all 11 zob statuses verbatim`; `GoalTodoOwner keeps all 6 zob owners verbatim`; `GoalTodoPriority keeps all 4 zob priorities verbatim`; `GOAL_TODO_ACTIONS exports exactly the 7 resolve_goal_todo actions` |
| zob caps: depth 6, fanout 8, batch 80 | default tree policy | `DEFAULT_TREE_POLICY mirrors zob goal policy caps: depth 6, fanout 8, batch 80`; `addGoalTodoNode enforces the depth boundary: exactly maxDepth allowed, maxDepth+1 rejected`; `addGoalTodoNode enforces the fanout boundary: maxFanout siblings allowed, one more rejected` |
| Canonical ids (todo_ + 12 hex), 1-based dotted paths, zob defaults (planned/agent/required/normal) | pure node builder | `addGoalTodoNode applies zob defaults: planned/agent/required/normal, now timestamps, canonical id`; `addGoalTodoNode computes nested dotted paths by 1-based sibling position`; `generateGoalTodoId emits todo_ + 12 lowercase hex and stays unique across 2000 draws` |
| Batch plans are atomic; one failing item fails the batch | atomic batch add | `addGoalTodoNodes is atomic: one failing item fails the batch and leaves the input untouched`; `addGoalTodoNodes assigns sequential 1-based paths per parent across a mixed batch` |
| split_goal_todo appends child subtodos under the resolved parent | engine batch API under parent | `splitGoalTodoNode appends subtodos after existing siblings with inherited zob defaults`; `split_goal_todo adds children under the resolved parent through the engine batch API` |
| update_goal_todo is metadata-only; status transitions are rejected | 2b transition engine owns status | `updateGoalTodoNodeMetadata rejects status changes: the 2b transition engine owns status`; `updateTodoMetadata: status patch rejected, unknown ref rejected, no-op patch receipts without events` |
| resolve_goal_todo is the primary transition API with the zob action set | exhaustive frozen transition matrix | `TRANSITIONS is a frozen 11 × 7 table keyed by status then action`; `exhaustive matrix: every (status × action) cell matches the expected outcome`; `auto completes planned, ready, and in_progress nodes`; `auto rejects delegated nodes, needs_user nodes, and terminal statuses` |
| Safe refs: prefer canonical todo_id; todo_path fallback; dual refs must agree; cross-goal fails closed | 2a reference resolution | `exact canonical todo_id resolves`; `exact visible todo_path resolves`; `dual id+path reference fails with reference_mismatch when they disagree`; `malformed todo_id values fail with invalid_todo_id`; `cross-goal todo_id fails closed with candidates` |

### Completion gate

| zob invariant | pi-goals behavior | test evidence |
|---|---|---|
| No root completion from TODO status alone; oracle gates completion | completeGoal requires a bound fresh strict-PASS decision | `completeGoal: without oracle rejected; drift after oracle rejected until reproposal with a new oracle`; `oracle freshness: oracle_binding_missing when no decision exists`; `oracle freshness: oracle_verdict_not_pass and oracle_no_ship` |
| Required TODOs must be done/skipped; every open required status blocks | structured blockers per open required node | `every open status on a REQUIRED todo blocks completion with a structured blocker`; `OPEN_REQUIRED_STATUSES mirrors zob: 9 statuses, done/skipped excluded`; `a done root with an open REQUIRED child is blocked by both root and child`; `open OPTIONAL todos never block completion (required-vs-optional semantics)` |
| Critical/delegated/factory work needs evidence refs or validation commands | evidence rule over owners | `critical done or skipped nodes without evidence block completion`; `factory and orchestration owners need evidence; normal agent work does not`; `evidenceRefs or validationCommands satisfy the critical evidence rule` |
| no_ship (hard/review) blocks proposal and completion | effectiveNoShip invariant | `blocked REQUIRED todo produces hardNoShip`; `injected reviewNoShip ids set reviewNoShip without hard blockers`; `effectiveNoShip combinations keep the invariant completionReady === !effectiveNoShip` |
| Completion proposal: canonical fields, exact hash preimage, tamper-evident | 3a proposal builder/validator | `proposalHash preimage: exactly the 15 canonical fields in canonical order`; `builder: counts mirror the input arrays and hashes are exact`; `tamper matrix: every field mutation without rehash invalidates` |
| Proposal freshness: graph drift or binding drift blocks the oracle | freshness evaluation | `recordOracleDecision rejects a stale proposal after todo graph drift`; `proposal freshness: todo_graph_revision_mismatch when the graph moved on`; `proposal freshness: goal_status_not_oracle_ready and safe repropose actions` |
| Oracle decision: immutable, hash-bound, complete+1 revision rule | 3a decision binding | `decision hash: exact canonical 10-field preimage with zob-parity evidence hashing`; `decision binding requires a valid proposal: exact hashes + recompute-verify`; `oracle freshness: root_revision_mismatch including the complete+1 rule`; `recordOracleDecision: FAIL verdict moves the goal to oracle_failed; a second binding is rejected` |
| Full lifecycle reaches complete with contiguous revision lineage | engine happy path | `full happy path: create → todos → resolve → propose → oracle PASS → complete with revision lineage, persisted streams, and snapshot round-trip`; `driveToComplete helper flow: minimal path reaches complete with decision lineage` |

### Delegation and claims

| zob invariant | pi-goals behavior | test evidence |
|---|---|---|
| Delegation attempts are parent-launched; policy frozen at launch | 2c launch records | `launchDelegationAttempt freezes the validation policy at launch`; `launchDelegationAttempt validates attempt id, ids, policy, status, and now` |
| Child returns a claim; claim hash is exact sha256 of the claim text | 2c return records | `returnGoalTodoClaim binds attempt + exact claim hash + frozen policy`; `buildGoalTodoClaimHash returns the exact full lowercase sha256 hex`; `returnGoalTodoClaim rejects malformed hashes and missing claim text` |
| Parent accepts/rejects with exact binding echo (claim_hash, attempt, policy) | 2c settlements | `claim flow: link → return → strict-PASS validation composition → accept_claim settlement`; `accept_claim requires attempt binding presence and exact attempt match`; `accept_claim rejects a claim hash that does not match the bound claim`; `settleAcceptClaim requires the claim to be present and the attempt unsettled` |
| Only parent-owned resolution settles claims; delegated nodes are not directly completable | transition gates | `complete from delegated is rejected: delegated nodes are not directly completable`; `auto and complete reject claim_returned and needs_oracle: explicit accept_claim required`; `reject_claim returns claim_returned to the recoverable delegated state` |
| Oracle claim validation: verdict/action/confidence/no_ship shape | validation records | `recordClaimValidation derives the validation status from the oracle verdict`; `recordClaimValidation enforces claim, policy, output hash, and settlement preconditions` |
| zob accept gate: an oracle_required claim settles only against a bound passed validation (`claimNextValidToolActions` routes non-passed to validate/reject/block) | ENFORCED in settlement (BUG-2 fix): `settleAcceptClaim` requires a recorded validation for that exact claim hash with verdict PASS and noShip false, else `claim_validation_not_pass` (after_context_change); parent_review keeps manual accept | `FIX-2 engine: oracle_required accept after a WARN validation is rejected; strict PASS on a fresh attempt accepts`; `FIX-2 core: parent_review claims keep manual accept (no oracle record required)` |
| Re-validation until settlement: zob's `recordGoalTodoClaimValidationResult` only requires the latest attempt to stay `claim_returned` — the oracle may re-validate (WARN → fix → re-validate PASS) and the LATEST validation is the effective record driving the accept gate; settlement (accept/reject) is the single final step (batch-#2 parity fix) | validations may be re-recorded while the attempt stays claim_returned: each call appends a SUPERSEDING `claim_validated` event (full history in the claims stream, latest wins in the restored view); `attempt_already_settled` fires only after accept/reject | `recordClaimValidation allows re-validation until settlement; the LATEST validation drives the accept gate`; `FIX-A engine: WARN → re-validate PASS on the SAME attempt → accept succeeds; claims stream keeps both events` |
| `validate_goal_todo_claim` is oracle-policy-only by design (zob parity): the oracle channel accepts only `oracle_required` claims; `parent_review` claims are reviewed directly by the parent and never enter it | `recordClaimValidation` rejects parent_review claims with `claim_validation_policy_mismatch` (fix_input) | `recordClaimValidation enforces claim, policy, output hash, and settlement preconditions`; `FIX-2 core: parent_review claims keep manual accept (no oracle record required)` |
| Delegation attempts launch / claims return through the tool surface | `link_goal_todo_delegation` + `return_goal_todo_claim` tools over engine linkDelegation/returnClaim (GAP-1 fix) | `FIX-6a tools: link_goal_todo_delegation and return_goal_todo_claim are registered and drive the full claim flow` |
| Claim validation provenance (agent, run id) is parent-visible metadata | optional canonical `agent`/`runId` on the claim_validated envelope (BUG-1 fix; length-capped, strict-validated; legacy lines without them keep parsing) | `FIX-3 engine: validate_goal_todo_claim with agent 'oracle' and run_id persists and round-trips`; `FIX-3 parser: legacy claim_validated lines without agent/run_id still parse` |
| Persisted claim/decision lineage stays hash-only (no raw bodies) | hashes over text; reasons hashed; blocking issues hash-only (BUG-4 fix: `blockingIssuesHash` = sha256 of the ordered JSON array + `blockingIssuesCount`; legacy cleartext v0.1.x lines still parse; tool responses echo caller values transiently) | `settleRejectClaim requires a reason and records its hash`; `FIX-4 engine: blocking issues persist as hash+count only — cleartext never reaches the store`; `FIX-4 parser: legacy cleartext blockingIssues lines still parse (v0.1.x back-compat)` |

### CAS and the store

| zob invariant | pi-goals behavior | test evidence |
|---|---|---|
| zob CAS parity: cas is OPTIONAL — absent revision slots are unchecked; mutation_id-only = plain idempotent mutation (SCHEMA-1 fix) | engine auto-generates a fresh id for cas-less calls (applies, not replay-idempotent); provided-but-wrong slots fail `cas_stale` with the friendly current-revision hint | `FIX-5 engine: every mutation succeeds with mutation_id only (no revision slots)`; `FIX-5 engine: cas entirely absent works (auto-generated non-replayed mutation ids)`; `FIX-5 engine: a PROVIDED wrong revision slot still rejects with the friendly current-revision hint`; `FIX-5 engine: mutation_id-only replay stays idempotent` |
| Every mutation is CAS-guarded with replay-idempotent mutation ids | 2d guard/replay over the receipts stream | `buildMutationGuard validates mutation ids and revisions`; `applyMutationGuard returns ok or exact stale revision codes`; `exact replay is idempotent success; conflicting replay is rejected`; `addTodos CAS: exact replay appends nothing; conflicting replay and stale revisions rejected` |
| Replay requires a byte-identical payload: the same mutation id bound to a different request hash is a conflict, never a re-apply | `cas_conflict` (retry never) on request-hash divergence; only the exact byte-identical payload replays as an idempotent no-op | `exact replay is idempotent success; conflicting replay is rejected`; `cas plumbing: mutation_id echoed, stale revision -> cas_stale with staleCodes, exact replay -> replayed, conflicting replay -> cas_conflict` |
| Canonical request hashing (sorted keys, cas stripped) | deterministic preimages | `canonicalGoalMutationJson sorts keys recursively and rejects non-canonical values`; `hashGoalMutationRequest strips the top-level cas field and hashes canonical tool+payload` |
| Append-only streams with write-side revision gating | 3b append APIs under the lock | `appendGoalEvent enforces revision = head + 1 write-side and rejects embedded conflicts`; `appendTodoGraphEvent enforces graph revision = head + 1 write-side`; `appendReceipt is idempotent for exact duplicates and rejects hash conflicts` |
| Restore is fail-closed: never a partial apply; corruption quarantines | 3b restore + quarantine matrix | `revision gap → RestoreBlocked with quarantine file + diagnostic json`; `revision conflict (embedded mismatch) → RestoreBlocked + quarantine`; `malformed JSON line → RestoreBlocked + quarantine`; `truncated tail (crash simulation, no trailing newline) → RestoreBlocked + quarantine`; `unknown schema line → RestoreBlocked + quarantine (R1)`; `a poisoned todos stream never partially applies the healthy goal stream` |
| Exact replay of goals/todos/claims/receipts with revisions | full replay | `happy path: replays goal, todos, claims, and receipts with exact revisions`; `missing streams restore to a clean empty state` |
| Compaction keeps lineage contiguous and restorable | 3b snapshot compaction | `compaction rewrites logs to a single baseline marker and resets the append counter`; `round-trip property: restore after compaction equals full replay before compaction`; `compaction refuses to run on a restore-blocked goal`; `completeGoal after compaction still verifies via the overlay decision` |
| Lock excludes concurrent mutation; stale locks are stolen | goals lock | `lock: a second acquirer is rejected with blocked_with_holder and holder info`; `lock: a stale lock held by a dead pid is stolen` |

### Extension surface

| zob invariant | pi-goals behavior | test evidence |
|---|---|---|
| The zob-named tool surface (goal/TODO family) is registered | 19 tools (incl. the delegation pair) + /goal + /todo | `registers exactly the 19 zob-named tools (incl. delegation pair) plus /goal and /todo commands; no import_* tools` |
| Commands delegate to the same engine calls (no separate logic) | command handlers over the engine | `/goal and /todo command parsing delegates to the same engine calls` |
| Tools echo CAS results honestly (stale/replay/conflict) | tool result details | `cas plumbing: mutation_id echoed, stale revision -> cas_stale with staleCodes, exact replay -> replayed, conflicting replay -> cas_conflict` |
| Tools answer blocked before session start and after shutdown | offline honesty | `tools answer blocked: session_not_started before session_start, and again after session_shutdown` |
| Session mirror stays body-free and never breaks tools | mirror adapter | `session-mirror: appendEntry success mirrors body-free entries; failures never break tools` |
| HUD shows compact progress, hides without a goal | HUD projection | `HUD renders the compact progress line with a goal and hides without one` |
| Store root is .goals/ with env override | shared paths | `stateDir() defaults to <cwd>/.goals when no override is set`; `stateDir() honors GOALS_STATE_DIR override under a temp cwd` |

### Layering

| zob invariant | pi-goals behavior | test evidence |
|---|---|---|
| Core stays pure (no fs/os/env/crypto beyond intrinsic hashing) | purity guard test | `src/core modules stay free of filesystem, OS, env, and crypto imports` |

## Deviations (deliberate reworks)

| code | deviation from zob | rationale | test evidence |
|---|---|---|---|
| D1 | reopen tightened: only `done`, `skipped`, `blocked` reopen (zob allowed a broader reopen set) | narrower terminal-set reopening keeps the graph honest; skipped nodes reopen instead of mutating history | `reopen works only from done, skipped, and blocked`; `reopenGoalTodoNode reopens done/skipped/blocked nodes to ready with stable paths` |
| D3 (BUG-3 fix) | block is the universal non-terminal escape (zob parity) EXCEPT `claim_returned` WITH a bound claim, which keeps `claim_resolution_required`; needs_review/needs_oracle/needs_user and synthetic claim_returned states block freely with just a reason | no claim-bearing creation state may deadlock: zob's own `claimNextValidToolActions` always offers `block_goal_todo` as an exit, and a bound returned claim must still be settled explicitly (accept/reject), never buried | `FIX-1 engine: needs_review created via add_goal_todo blocks, reopens, and completes (session deadlock escape)`; `FIX-1 engine: claim_returned WITHOUT a bound claim blocks freely; WITH a bound claim stays claim_resolution_required`; `FIX-1: needs_review/needs_oracle block without a bound claim (deadlock escape)` |
| D-E1 | an empty TODO tree is NOT shippable: completionReady=false, effectiveNoShip=true, and (GAP-4 fix) an EXPLICIT synthetic blocker line `todo tree is empty` | zob could complete a goal with no TODOs; pi-goals requires at least one closed node so "complete" always means verified work, and empty-tree rejections now list the blocker instead of zero blockers | `empty tree: nothing is shippable — completionReady=false, effectiveNoShip=true, explicit 'todo tree is empty' blocker`; `FIX-6d engine: empty-tree propose lists an explicit 'todo tree is empty' blocker` |
| D-C4 | strict-PASS auto-accept requires MEDIUM/HIGH confidence plus every other strict dimension | zob's oracle_then_auto_accept composition was looser; the frozen strict rule prevents weak-evidence auto-accepts | `isStrictPassAutoAccept: every weakening dimension flips accept to needs_review`; `strict-PASS composition with 2d isStrictPassAutoAccept`; `claim tools expose the strict-PASS composition (fixture built via the engine, surface via tools)` |
| D-O6 / D-P5 | tampering reports the PRECISE freshness code (proposal_hash_mismatch, oracle_decision_hash_mismatch, structural codes) instead of folding everything into malformed_snapshot | zob folded many tamper classes into one code; exact codes make oracle drift diagnosable and auditable | `tamper matrix: hash drift is reported as proposal_hash_mismatch, structural junk as its own codes`; `oracle freshness: oracle_decision_hash_mismatch for decision tamper without rehash` |
| D-M1 | the CAS tool inventory is the frozen 16-name core; zob's `import_*` tools and `handoff_goal_todo` are out of core scope | pi-goals is standalone: import adapters and live-peer handoff are extension concerns, not core mutations | `GOAL_MUTATION_TOOL_NAMES is the frozen 16-tool core mutation scope`; `registers exactly the 17 zob-named tools plus /goal and /todo commands; no import_* tools` |
| D-E5 | engine CAS tool-name mapping: complete and clear (and pause) map to `update_goal` — zob cleared via command so no dedicated tool name exists | keeps the frozen inventory intact while receipts stay tool-accurate for the mutation family | `pauseGoal: active goal pauses with loop off, revision+1, receipt, and LoopHooks notify` (asserts `receipt.toolName === "update_goal"`); `buildMutationGuard accepts every core tool and rejects unknown tools` |
| D-E1 (store) | at-least-once receipt window: the CAS receipt is appended AFTER the ledger events, so a crash between them degrades to a fail-loud duplicate on replay, never silent divergence | the receipt is the commit marker; zob mutated in-memory state first, pi-goals is stateless-per-mutation | `appendReceipt is idempotent for exact duplicates and rejects hash conflicts`; `CAS receipts: exact duplicate lines replay idempotently` |
| D-C7 (batch-#2) | skipped nodes render their own icon ⤫; blocked keeps ⊘ (zob shared ⊘ between blocked and skipped) | a skipped node is closed-by-decision, not blocked — the tree must distinguish them at a glance (both the CLI tree and the /todo renderer use the same icon map) | `FIX-C render: skipped gets a distinct icon (⤫) — blocked keeps ⊘ (CLI tree AND /todo renderer)` |
| D-E7 (pause fix) | `pauseGoal` is an explicit engine mutation gated to active/ready_for_oracle/oracle_failed/budget_limited — zob's `/goal pause` covered only the active status; Phase 4 shipped resume-only with an honest stub, Phase 6 closes the gap | explicit user pause should work from every working status, with loop off, CAS receipt, and LoopHooks notify; paused goals resume with a reason | `pauseGoal: active goal pauses with loop off, revision+1, receipt, and LoopHooks notify`; `pauseGoal: ready_for_oracle and oracle_failed goals pause too (wider gate)`; `pauseGoal: paused goals rejected with goal_status_invalid; complete goals have no active target`; `pauseGoal: empty reason rejected; CAS stale and replay semantics enforced`; `pauseGoal: restore replays the paused goal exactly (stream + overlay)` |

## Known limitations (v0.1.x)

- The continuation loop is a port (`LoopHooks`): the package ships no
  auto-continuation runner; hosts/CLIs inject it (by design, R7).
- `import_*` tools and `handoff_goal_todo` are out of core scope (D-M1);
  adapters can be added as separate packages.
- Fixed in this v0.1.x batch (previously listed): `agent` provenance on
  `claim_validated` now persists canonically (BUG-1); the oracle_required
  accept gate is enforced (BUG-2); needs_review/claim-bearing block escape
  (BUG-3); blockingIssues are hash-only (BUG-4); cas is fully optional
  (SCHEMA-1); delegation tools + `goals` bin CLI + explicit update_goal_todo
  status rejection + explicit empty-tree blocker (GAP-1/2/4) — regression
  evidence in `test/e2e-regressions.test.ts`.
