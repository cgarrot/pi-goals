// src/runtime/engine.ts — Phase 4 GoalRuntimeEngine: composes core (2a–2d),
// oracle (3a), and the store (3b) into the mutation API the future
// extension/CLI (Phase 5/6) calls.
//
// Distilled (read-only) from zob-harness:
//   - .pi/extensions/zob-harness/src/runtime/goal-runtime/tools.ts
//     (create_goal / resume_goal / propose_goal_completion /
//      record_goal_oracle / update_goal flows and their gates)
//   - .pi/extensions/zob-harness/src/runtime/goal-runtime/commands.ts
//     (assertGoalOracleRecordable / recordOracleVerdict gates)
//   - .pi/extensions/zob-harness/src/runtime/goal-runtime/state.ts
//     (oracle binding + resume turn-window semantics)
//
// Rework decisions ("en mieux", deliberate deviations documented for review):
//   D-E1 stateless engine: every mutation restores the store from disk
//      inside the GoalsFileLock, applies pure core operations, appends
//      revisioned events through the 3b append APIs, and only then appends
//      the CAS receipt (the receipt is the commit marker; a crash between
//      the ledger append and the receipt degrades to at-least-once with a
//      fail-loud duplicate, never silent divergence).
//   D-E2 the extended runtime state (gate, usage, loop, oracleDecision,
//      completionProposal, and the todo→attempt delegation bindings) lives
//      in an engine-owned overlay goals/<goalId>/runtime-goal.json written
//      atomically after the ledger append. The 3b goal stream stays the
//      canonical 6-key GoalRecord lineage. A lost/stale overlay degrades
//      FAIL-CLOSED: usage resets and completion must be re-proposed.
//   D-E3 CAS is required for every mutation (no zob legacy path): the
//      engine rejects a missing guard slot with an exact cas_invalid code,
//      evaluates replay BEFORE any gate (exact replay = no-op success with
//      the recorded receipt; same mutationId + different hash = conflict),
//      then applies the 2d optimistic revision guard.
//   D-E4 addTodos persists ONE todos_snapshot event per batch (single
//      fsync'd line = atomic batch on disk); single-node updates append
//      todo_updated events. Verified no-op metadata patches record the
//      receipt without touching the stream.
//   D-E5 CAS tool-name mapping over the frozen 16-name inventory:
//      complete → update_goal, clear → update_goal (zob cleared via
//      command, so no dedicated tool name exists), link/return delegation →
//      recover_goal_todo_delegation, resolveTodo maps per action
//      (complete_goal_todo / block_goal_todo / accept_goal_todo_claim /
//      reject_goal_todo_claim / resolve_goal_todo).
//   D-E6 recordOracleDecision binds decision.goalRevision = revision + 1
//      (the post-event revision, zob parity); completeGoal applies
//      revision = decision.goalRevision + 1 exactly (the complete+1 rule
//      from 3a D-O4) after evaluateOracleFreshness passes.
//   D-E7 pauseGoal (Phase 6) is an explicit engine mutation: gated to
//      active|ready_for_oracle|oracle_failed|budget_limited (wider than
//      zob's active-only /goal pause — documented deviation), loop off,
//      goal_set revision +1, CAS receipt, LoopHooks notify. The CAS tool
//      name is update_goal (the complete/clear family, D-E5).
//
// Purity/layering: node:fs is touched ONLY inside the injected stateDir
// (streams, overlay) — the lock lives in the injected runtimeDir. No Pi SDK
// imports anywhere (R7: the loop is the LoopHooks port).

import { randomBytes as nodeRandomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { applyMutationGuard, buildMutationGuard, buildMutationReceipt, evaluateMutationReplay, hashGoalMutationRequest } from "../core/cas.js";
import type { GoalMutationGuard, GoalMutationGuardInput, GoalMutationReceipt, GoalMutationToolName } from "../core/cas.js";
import { addGoalTodoNodes, normalizeTreePolicy, summarizeGoalTodos, updateGoalTodoNodeMetadata } from "../core/tree.js";
import type { AddGoalTodoNodeItem, GoalTodoNodeMetadataPatch, GoalTodoSummary, TreePolicy } from "../core/tree.js";
import type { GoalTodoNode } from "../core/types.js";
import { applyGoalTodoTransition } from "../core/transition.js";
import type { GoalTodoAction, GoalTodoClaimBinding, GoalTodoTransitionEffects, GoalTodoTransitionInput } from "../core/transition.js";
import { evaluateGoalTodoCompletion, formatGoalTodoBlockers } from "../core/completion.js";
import type { GoalTodoCompletionBlocker, GoalTodoCompletionDiagnostics } from "../core/completion.js";
import { isCanonicalGoalTodoId, resolveCanonicalGoalTodoReference } from "../core/ids.js";
import type { GoalTodoRandomBytes } from "../core/ids.js";
import type { GoalTodoCanonicalReferenceInput } from "../core/types.js";
import { buildGoalCompletionProposal, validateGoalCompletionProposal } from "../core/proposal.js";
import type { GoalCompletionProposal } from "../core/proposal.js";
import {
  composeOracleClaimAutoAccept,
  buildOracleDecision,
  evaluateOracleFreshness,
  evaluateProposalFreshness,
} from "./oracle.js";
import type { OracleClaimAutoAcceptComposition, OracleDecision, OracleVerdict } from "./oracle.js";
import {
  isStrictPassAutoAccept,
  launchDelegationAttempt,
  recordClaimValidation as recordClaimValidationCore,
  returnGoalTodoClaim,
  settleAcceptClaim,
  settleRejectClaim,
} from "../core/claims.js";
import type {
  GoalTodoAutoAcceptDecision,
  GoalTodoDelegationAttemptStatus,
  GoalTodoClaimSettlementRecord,
  GoalTodoClaimValidationPolicy,
  GoalTodoClaimValidationRecord,
  GoalTodoDelegationAttemptRecord,
  GoalTodoReturnedClaim,
} from "../core/claims.js";
import type { LoopHooks } from "./ports.js";
import {
  DEFAULT_GOAL_MAX_TURNS,
  MAX_RUNTIME_GOAL_OBJECTIVE_CHARS,
  RESUMABLE_GOAL_STATUSES,
  createRuntimeGoal,
  normalizeRuntimeGoal,
  resumeRuntimeGoal,
  runtimeGoalFromRecord,
  runtimeGoalToRecord,
} from "./goal.js";
import type { RuntimeGoal, RuntimeGoalGate, RuntimeGoalStatus } from "./goal.js";
import { appendClaimEvent, appendGoalEvent, appendReceipt, appendTodoGraphEvent, goalStorePaths, withGoalsLock, writeFileAtomic } from "../store/log.js";
import type { GoalsFileLock, StreamReadOptions, StoreWriteOptions } from "../store/log.js";
import { restoreAllGoals } from "../store/restore.js";
import type { GoalClaimsSideTable, RestoredGoalStore, RestoreAllGoalsIndex, RestoreDiagnostic } from "../store/restore.js";
import { CLAIMS_STREAM_SCHEMA, GOAL_STREAM_SCHEMA, RECEIPT_STREAM_SCHEMA, TODOS_STREAM_SCHEMA } from "../store/events.js";
import type { GoalSetEvent, TodoUpdatedEvent, TodosSnapshotEvent, TodoTreePolicyRecord } from "../store/events.js";
import { lockPath } from "../shared/paths.js";
import { LOCAL_GOAL_SCOPE, isCanonicalGoalScope } from "../shared/scope.js";

// ---------------------------------------------------------------------------
// Options, inputs, results
// ---------------------------------------------------------------------------

export interface GoalRuntimeEngineOptions {
  /** Store root (goals/, cas-receipts.jsonl, quarantine/). Required. */
  readonly stateDir: string;
  /** Runtime dir holding the goals.lock. Required (shared/paths default is available to callers). */
  readonly runtimeDir: string;
  /** Injected epoch-ms clock (default: Date.now). */
  readonly clock?: () => number;
  /** Injected randomness source for goal/todo/attempt ids (default: node:crypto). */
  readonly randomBytes?: GoalTodoRandomBytes;
  /** Lock staleness threshold in ms (default: 60s). */
  readonly lockStaleAfterMs?: number;
  /** Continuation-loop hooks (R7); never required for store correctness. */
  readonly loopHooks?: LoopHooks;
  /** TODO tree policy overrides (defaults: zob caps 6/8/80). */
  readonly treePolicy?: Partial<TreePolicy>;
  /** Stream read byte cap (default: 32 MiB). */
  readonly maxStreamBytes?: number;
}

export interface CreateGoalOptions {
  readonly maxTurns?: number;
  readonly gate?: RuntimeGoalGate;
  /** Canonical scope (shared/scope.ts): local | agent:<id> | room:<id>. Default local. */
  readonly scope?: string;
  /** Display-only scope label (e.g. mesh alias). */
  readonly scopeLabel?: string;
}

export interface ProposeCompletionInput {
  readonly completionSummary: string;
  readonly requirementsChecked: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly validationCommands: readonly string[];
  readonly knownRisks: readonly string[];
  readonly noShip: boolean;
}

export interface OracleReviewSubmission {
  readonly verdict: OracleVerdict;
  readonly noShip: boolean;
  readonly evidenceSummary: string;
  readonly evidenceRefs?: readonly string[];
}

export interface LinkDelegationInput {
  readonly attemptId?: string;
  readonly runId?: string;
  readonly agent?: string;
  readonly validationPolicy?: GoalTodoClaimValidationPolicy;
  /** Parent-owned delegation depth metadata (integer >= 1, default 1, zob parity). */
  readonly delegationDepth?: number;
}

export interface ReturnClaimInput {
  readonly claimText?: string;
  readonly claimHash?: string;
  readonly evidenceRefs?: readonly string[];
  readonly validationCommands?: readonly string[];
  readonly noShip?: boolean;
}

export interface ClaimValidationInput {
  readonly verdict: "PASS" | "WARN" | "FAIL";
  readonly runId?: string;
  readonly recommendedAction: "accept_claim" | "needs_review" | "reject_claim" | "block";
  readonly noShip: boolean;
  readonly confidence: "LOW" | "MEDIUM" | "HIGH";
  readonly blockingIssues?: readonly string[];
  readonly outputHash: string;
  readonly evidenceRefs?: readonly string[];
  readonly validationCommands?: readonly string[];
  readonly agent?: string;
}

export interface CompleteGoalEchoes {
  readonly expectedProposalHash?: string;
  readonly expectedOracleDecisionHash?: string;
}

export interface GoalRuntimeView {
  readonly goal: RuntimeGoal;
  readonly revisions: { readonly goal: number; readonly todos: number };
  readonly nodes: readonly GoalTodoNode[];
  readonly claims: GoalClaimsSideTable;
  readonly summary: GoalTodoSummary;
  readonly completion: GoalTodoCompletionDiagnostics;
}

export interface CreateGoalResult {
  readonly goalId: string;
  readonly goal?: RuntimeGoal;
}

export interface AddTodosResult {
  readonly created: readonly GoalTodoNode[];
  readonly todosRevision: number;
  readonly summary: GoalTodoSummary;
}

export interface UpdateTodoMetadataResult {
  readonly node: GoalTodoNode;
  readonly changed: boolean;
  readonly todosRevision: number;
}

export interface ResolveTodoResult {
  readonly node: GoalTodoNode;
  readonly effects: GoalTodoTransitionEffects;
  readonly todosRevision: number;
  readonly settlement?: GoalTodoClaimSettlementRecord;
  readonly claimComposition?: OracleClaimAutoAcceptComposition;
}

export interface LinkDelegationResult {
  readonly attempt: GoalTodoDelegationAttemptRecord;
  readonly node: GoalTodoNode;
}

export interface ReturnClaimResult {
  readonly claim: GoalTodoReturnedClaim;
  readonly node?: GoalTodoNode;
}

export interface RecordClaimValidationResult {
  readonly validation: GoalTodoClaimValidationRecord;
  readonly claimRule: GoalTodoAutoAcceptDecision;
  readonly oracleComposition: OracleClaimAutoAcceptComposition;
}

export interface ProposeCompletionResult {
  readonly goal: RuntimeGoal;
  readonly proposal?: GoalCompletionProposal;
}

export interface RecordOracleDecisionResult {
  readonly goal: RuntimeGoal;
  readonly decision: OracleDecision;
}

export interface CompleteGoalResult {
  readonly goal: RuntimeGoal;
}

export interface PauseGoalResult {
  readonly goal: RuntimeGoal;
  readonly previousStatus: RuntimeGoalStatus;
}

export interface ResumeGoalResult {
  readonly goal: RuntimeGoal;
  readonly previousStatus: RuntimeGoalStatus;
  readonly additionalTurns?: number;
}

export interface ClearGoalResult {
  readonly clearedGoalId: string;
}

/** Which goal a mutation targets: an explicit goal id (cross-scope) OR a
 * canonical scope. Neither → legacy fallback: the single active goal
 * store-wide (scope_ambiguous when several lanes are active). */
export interface GoalSelector {
  readonly goalId?: string;
  readonly scope?: string;
}
/** One line of the store overview (getGoalsOverview / get_goals tool). */
export interface GoalOverviewEntry {
  readonly goalId: string;
  readonly scope: string;
  readonly scopeLabel?: string;
  readonly status: string;
  readonly objective: string;
  readonly revision: number;
  readonly todos: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}
export interface GetGoalsOverviewResult {
  readonly overview?: readonly GoalOverviewEntry[];
  readonly diagnostics?: readonly RestoreDiagnostic[];
}

export interface GoalRuntimeEngine {
  createGoal(objective: string, cas?: GoalMutationGuardInput, options?: CreateGoalOptions): GoalEngineOutcome<CreateGoalResult>;
  getGoal(goalId?: string, scope?: string): { goal?: GoalRuntimeView; diagnostics?: readonly RestoreDiagnostic[] };
  getGoalsOverview(): GetGoalsOverviewResult;
  addTodos(items: readonly AddGoalTodoNodeItem[], cas?: GoalMutationGuardInput, selector?: GoalSelector): GoalEngineOutcome<AddTodosResult>;
  updateTodoMetadata(
    ref: GoalTodoCanonicalReferenceInput,
    patch: GoalTodoNodeMetadataPatch,
    cas?: GoalMutationGuardInput,
    selector?: GoalSelector,
  ): GoalEngineOutcome<UpdateTodoMetadataResult>;
  resolveTodo(
    ref: GoalTodoCanonicalReferenceInput,
    action: GoalTodoAction,
    input: GoalTodoTransitionInput,
    cas?: GoalMutationGuardInput,
    selector?: GoalSelector,
  ): GoalEngineOutcome<ResolveTodoResult>;
  linkDelegation(ref: GoalTodoCanonicalReferenceInput, input: LinkDelegationInput, cas?: GoalMutationGuardInput, selector?: GoalSelector): GoalEngineOutcome<LinkDelegationResult>;
  returnClaim(attemptId: string, input: ReturnClaimInput, cas?: GoalMutationGuardInput, selector?: GoalSelector): GoalEngineOutcome<ReturnClaimResult>;
  recordClaimValidation(attemptId: string, input: ClaimValidationInput, cas?: GoalMutationGuardInput, selector?: GoalSelector): GoalEngineOutcome<RecordClaimValidationResult>;
  proposeCompletion(input: ProposeCompletionInput, cas?: GoalMutationGuardInput, selector?: GoalSelector): GoalEngineOutcome<ProposeCompletionResult>;
  recordOracleDecision(review: OracleReviewSubmission, cas?: GoalMutationGuardInput, selector?: GoalSelector): GoalEngineOutcome<RecordOracleDecisionResult>;
  completeGoal(cas?: GoalMutationGuardInput, echoes?: CompleteGoalEchoes, selector?: GoalSelector): GoalEngineOutcome<CompleteGoalResult>;
  pauseGoal(reason: string, cas?: GoalMutationGuardInput, selector?: GoalSelector): GoalEngineOutcome<PauseGoalResult>;
  resumeGoal(reason: string, cas?: GoalMutationGuardInput, extraTurns?: number, selector?: GoalSelector): GoalEngineOutcome<ResumeGoalResult>;
  clearGoal(cas?: GoalMutationGuardInput, selector?: GoalSelector): GoalEngineOutcome<ClearGoalResult>;
}

// ---------------------------------------------------------------------------
// Errors and outcomes
// ---------------------------------------------------------------------------

export type GoalEngineRetryPolicy = "fix_input" | "after_context_change" | "never";

export type GoalEngineErrorCode =
  | "invalid_input"
  | "cas_invalid"
  | "cas_stale"
  | "cas_conflict"
  | "lock_error"
  | "restore_blocked"
  | "store_write_failed"
  | "goal_missing"
  | "goal_already_active"
  | "scope_ambiguous"
  | "multiple_active_goals"
  | "goal_status_invalid"
  | "reason_required"
  | "evidence_required"
  | "completion_not_ready"
  | "proposal_not_fresh"
  | "oracle_already_bound"
  | "oracle_not_fresh"
  | "tree_error"
  | "transition_rejected"
  | "claim_error"
  | "reference_error"
  | "node_status_invalid";

export interface GoalEngineError {
  readonly ok: false;
  readonly code: GoalEngineErrorCode;
  readonly message: string;
  readonly retryPolicy?: GoalEngineRetryPolicy;
  readonly blockers?: readonly GoalTodoCompletionBlocker[];
  readonly staleCodes?: readonly string[];
  readonly freshnessCode?: string;
  readonly transitionCode?: string;
  readonly treeCode?: string;
  readonly claimCode?: string;
  readonly referenceCode?: string;
  readonly diagnostics?: readonly RestoreDiagnostic[];
}

export type GoalEngineOutcome<T> =
  | { readonly ok: true; readonly status: "applied"; readonly result: T; readonly receipt: GoalMutationReceipt }
  | { readonly ok: true; readonly status: "replayed"; readonly result: T; readonly receipt: GoalMutationReceipt }
  | GoalEngineError;

interface ErrorExtra {
  blockers?: readonly GoalTodoCompletionBlocker[];
  staleCodes?: readonly string[];
  freshnessCode?: string;
  transitionCode?: string;
  treeCode?: string;
  claimCode?: string;
  referenceCode?: string;
  diagnostics?: readonly RestoreDiagnostic[];
}

function engineErr(code: GoalEngineErrorCode, message: string, retryPolicy?: GoalEngineRetryPolicy, extra?: ErrorExtra): GoalEngineError {
  return {
    ok: false,
    code,
    message,
    ...(retryPolicy ? { retryPolicy } : {}),
    ...(extra?.blockers ? { blockers: extra.blockers } : {}),
    ...(extra?.staleCodes ? { staleCodes: extra.staleCodes } : {}),
    ...(extra?.freshnessCode ? { freshnessCode: extra.freshnessCode } : {}),
    ...(extra?.transitionCode ? { transitionCode: extra.transitionCode } : {}),
    ...(extra?.treeCode ? { treeCode: extra.treeCode } : {}),
    ...(extra?.claimCode ? { claimCode: extra.claimCode } : {}),
    ...(extra?.referenceCode ? { referenceCode: extra.referenceCode } : {}),
    ...(extra?.diagnostics ? { diagnostics: extra.diagnostics } : {}),
  };
}

function replayedOk<T>(result: T, receipt: GoalMutationReceipt): GoalEngineOutcome<T> {
  return { ok: true, status: "replayed", result, receipt };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function compactRecord(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = entry;
  }
  return out;
}

/** Selector keys folded into every mutation payload so the CAS request
 * hash binds the intended target goal (replay stays deterministic). */
function selectorKeys(selector: GoalSelector | undefined): Record<string, unknown> {
  return compactRecord({ goal_id: selector?.goalId, scope: selector?.scope });
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function lookupRecord<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  if (!record || !Object.prototype.hasOwnProperty.call(record, key)) return undefined;
  return record[key];
}

function copyCoreRetry(retry: string | undefined): GoalEngineRetryPolicy {
  return retry === "fix_input" || retry === "never" ? retry : "after_context_change";
}

// ---------------------------------------------------------------------------
// Runtime overlay (D-E2)
// ---------------------------------------------------------------------------

const RUNTIME_OVERLAY_SCHEMA = "pi-goals.runtime-goal.v1";
const RUNTIME_OVERLAY_FILE = "runtime-goal.json";
const SAFE_ATTEMPT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const OVERLAY_DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_OVERLAY_DELEGATIONS = 10_000;

interface RuntimeOverlay {
  readonly goal?: RuntimeGoal;
  readonly delegations: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Engine factory
// ---------------------------------------------------------------------------

export function createRuntimeGoalEngine(options: GoalRuntimeEngineOptions): GoalRuntimeEngine {
  if (!options || typeof options.stateDir !== "string" || options.stateDir.trim().length === 0) {
    throw new TypeError("createRuntimeGoalEngine: stateDir is required");
  }
  if (typeof options.runtimeDir !== "string" || options.runtimeDir.trim().length === 0) {
    throw new TypeError("createRuntimeGoalEngine: runtimeDir is required");
  }
  const stateDir = options.stateDir;
  const clock: () => number = options.clock ?? ((): number => Date.now());
  const randomBytes: GoalTodoRandomBytes = options.randomBytes ?? ((count: number) => nodeRandomBytes(count));
  const treePolicy = normalizeTreePolicy(options.treePolicy);
  const treePolicyRecord: TodoTreePolicyRecord = { maxDepth: treePolicy.maxDepth, maxFanout: treePolicy.maxFanout, maxBatch: treePolicy.maxBatch };
  const hooks: LoopHooks = options.loopHooks ?? {};
  const lockFile = lockPath(options.runtimeDir);
  const lockOptions = options.lockStaleAfterMs !== undefined ? { staleAfterMs: options.lockStaleAfterMs } : undefined;
  const readOptions: StreamReadOptions = options.maxStreamBytes !== undefined ? { maxStreamBytes: options.maxStreamBytes } : {};
  const writeOptions: StoreWriteOptions = { ...readOptions };

  function randomHex(count: number): string {
    const bytes = randomBytes(count);
    if (!(bytes instanceof Uint8Array) || bytes.length < count) throw new Error("randomBytes source returned too few bytes");
    let hex = "";
    for (let index = 0; index < count; index += 1) hex += bytes[index]!.toString(16).padStart(2, "0");
    return hex;
  }

  function generateGoalId(): string {
    return `goal_${randomHex(6)}`;
  }

  function generateAttemptId(): string {
    return `att_${randomHex(6)}`;
  }

  // --- overlay -------------------------------------------------------------

  function overlayPath(goalId: string): string {
    return path.join(goalStorePaths(stateDir, goalId).dir, RUNTIME_OVERLAY_FILE);
  }

  function readRuntimeOverlay(goalId: string): RuntimeOverlay {
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(overlayPath(goalId), "utf8"));
    } catch {
      return { delegations: {} };
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) return { delegations: {} };
    const record = value as Record<string, unknown>;
    if (record.schema !== RUNTIME_OVERLAY_SCHEMA) return { delegations: {} };
    if (record.goalId !== goalId) return { delegations: {} };
    const delegations: Record<string, string> = {};
    if (record.delegations !== undefined) {
      if (typeof record.delegations !== "object" || record.delegations === null || Array.isArray(record.delegations)) return { delegations: {} };
      const entries = Object.entries(record.delegations as Record<string, unknown>);
      if (entries.length > MAX_OVERLAY_DELEGATIONS) return { delegations: {} };
      for (const [todoId, attemptId] of entries) {
        if (!isCanonicalGoalTodoId(todoId)) return { delegations: {} };
        if (typeof attemptId !== "string" || !SAFE_ATTEMPT_ID_PATTERN.test(attemptId) || OVERLAY_DANGEROUS_KEYS.has(attemptId)) {
          return { delegations: {} };
        }
        delegations[todoId] = attemptId;
      }
    }
    const goal = normalizeRuntimeGoal(record.goal);
    return { ...(goal ? { goal } : {}), delegations };
  }

  function writeRuntimeOverlay(goalId: string, goal: RuntimeGoal, delegations: Readonly<Record<string, string>>): void {
    writeFileAtomic(
      overlayPath(goalId),
      JSON.stringify({ schema: RUNTIME_OVERLAY_SCHEMA, goalId, goal, delegations }) + "\n",
    );
  }

  // --- snapshot ------------------------------------------------------------

  interface GoalSnapshot {
    readonly goalId: string;
    readonly runtime: RuntimeGoal;
    readonly delegations: Readonly<Record<string, string>>;
    readonly nodes: readonly GoalTodoNode[];
    readonly claims: GoalClaimsSideTable;
    readonly revisions: { readonly goal: number; readonly todos: number };
    readonly summary: GoalTodoSummary;
    readonly completion: GoalTodoCompletionDiagnostics;
  }

  function buildSnapshot(restored: RestoredGoalStore): GoalSnapshot {
    const record = restored.goal;
    const overlay = readRuntimeOverlay(restored.goalId);
    let runtime = runtimeGoalFromRecord(record!);
    const overlayGoal = overlay.goal;
    if (
      overlayGoal
      && overlayGoal.goalId === record!.goalId
      && overlayGoal.revision === record!.revision
      && overlayGoal.status === record!.status
      && overlayGoal.objective === record!.objective
    ) {
      runtime = overlayGoal;
    }
    const nodes = restored.todoGraph.nodes;
    return {
      goalId: restored.goalId,
      runtime,
      delegations: overlay.delegations,
      nodes,
      claims: restored.claims,
      revisions: { goal: restored.revisions.goal, todos: restored.revisions.todos },
      summary: summarizeGoalTodos(nodes),
      completion: evaluateGoalTodoCompletion(nodes, { policy: treePolicy }),
    };
  }

  function viewOf(snap: GoalSnapshot): GoalRuntimeView {
    return {
      goal: snap.runtime,
      revisions: snap.revisions,
      nodes: snap.nodes,
      claims: snap.claims,
      summary: snap.summary,
      completion: snap.completion,
    };
  }

  function collectBlocked(index: RestoreAllGoalsIndex): RestoreDiagnostic[] {
    const blocked = [...index.receipts.diagnostics];
    for (const result of Object.values(index.goals)) {
      if (result.status === "blocked") blocked.push(...result.diagnostics);
    }
    return blocked;
  }

  function scopeOfRecord(record: { readonly scope?: string }): string {
    return record.scope ?? LOCAL_GOAL_SCOPE;
  }

  function snapshotForGoalId(index: RestoreAllGoalsIndex, goalId: string): { snapshot?: GoalSnapshot; error?: GoalEngineError } {
    const result = index.goals[goalId];
    if (!result || result.status !== "ok" || !result.goal) {
      return { error: engineErr("restore_blocked", `goal ${goalId} could not be restored`, "after_context_change") };
    }
    return { snapshot: buildSnapshot(result) };
  }

  function activeGoalEntries(index: RestoreAllGoalsIndex): readonly { readonly goalId: string; readonly scope: string }[] {
    const entries: { goalId: string; scope: string }[] = [];
    for (const [goalId, result] of Object.entries(index.goals)) {
      if (result.status === "ok" && result.goal && result.goal.status !== "complete") {
        entries.push({ goalId, scope: scopeOfRecord(result.goal) });
      }
    }
    return entries.sort((a, b) => (a.goalId < b.goalId ? -1 : 1));
  }

  /** zob-parity invariant, scoped (D-E8): at most ONE non-complete goal
   * per scope. multiple_active_goals fires only within one scope (corrupt
   * or hand-written store); different scopes never block each other. */
  function findActiveGoalInScope(index: RestoreAllGoalsIndex, scope: string): { snapshot?: GoalSnapshot; error?: GoalEngineError } {
    const active = activeGoalEntries(index).filter((entry) => entry.scope === scope);
    if (active.length > 1) {
      return { error: engineErr("multiple_active_goals", `multiple non-complete goals exist in scope ${scope}: ${active.map((entry) => entry.goalId).join(", ")}`, "fix_input") };
    }
    const goalId = active[0]?.goalId;
    if (goalId === undefined) {
      return { error: engineErr("goal_missing", `no active (non-complete) goal exists in scope ${scope}`, "fix_input") };
    }
    return snapshotForGoalId(index, goalId);
  }

  /**
   * Target-goal resolution (D-E8):
   *   1. selector.goalId → that exact goal (cross-scope addressing);
   *   2. selector.scope  → the single active goal of that scope;
   *   3. no selector    → legacy solo fallback: exactly one active goal
   *      store-wide; zero → goal_missing; several → scope_ambiguous naming
   *      every active scope so the caller can retry with scope/goal_id.
   */
  function resolveTargetGoal(index: RestoreAllGoalsIndex, selector?: GoalSelector): { snapshot?: GoalSnapshot; error?: GoalEngineError } {
    if (selector?.goalId !== undefined) {
      if (!Object.prototype.hasOwnProperty.call(index.goals, selector.goalId)) {
        return { error: engineErr("goal_missing", `no goal ${selector.goalId} exists in the store`, "fix_input") };
      }
      return snapshotForGoalId(index, selector.goalId);
    }
    if (selector?.scope !== undefined) return findActiveGoalInScope(index, selector.scope);
    const active = activeGoalEntries(index);
    if (active.length === 0) return { error: engineErr("goal_missing", "no active (non-complete) goal exists", "fix_input") };
    if (active.length > 1) {
      const scopes = [...new Set(active.map((entry) => entry.scope))].sort();
      return {
        error: engineErr(
          "scope_ambiguous",
          `${active.length} active goals across scopes (${scopes.join(", ")}) — pass a scope (local | agent:<id> | room:<id>) or goal_id`,
          "fix_input",
        ),
      };
    }
    return snapshotForGoalId(index, active[0]!.goalId);
  }

  /** Attempt-keyed resolution for cross-scope claim flows: the child
   * returning/validating a claim may not share the parent's default scope,
   * so the attempt binding pinpoints the owning goal directly. */
  function resolveGoalByAttempt(index: RestoreAllGoalsIndex, attemptId: string, selector?: GoalSelector): { snapshot?: GoalSnapshot; error?: GoalEngineError } {
    const candidates: string[] = [];
    for (const [goalId, result] of Object.entries(index.goals)) {
      if (result.status === "ok" && Object.prototype.hasOwnProperty.call(result.claims.attempts, attemptId)) candidates.push(goalId);
    }
    if (candidates.length === 1) return snapshotForGoalId(index, candidates[0]!);
    if (candidates.length > 1) {
      return { error: engineErr("claim_error", `attempt ${attemptId} is bound in multiple goals (${candidates.sort().join(", ")})`, "after_context_change", { claimCode: "attempt_ambiguous" }) };
    }
    return resolveTargetGoal(index, selector);
  }

  /** clear-semantics current goal within the resolved lane: the active
   * goal, else the most recently updated goal of the same lane. */
  function findCurrentGoal(index: RestoreAllGoalsIndex, selector?: GoalSelector): { snapshot?: GoalSnapshot; error?: GoalEngineError } {
    if (selector?.goalId !== undefined) {
      if (!Object.prototype.hasOwnProperty.call(index.goals, selector.goalId)) {
        return { error: engineErr("goal_missing", `no goal ${selector.goalId} exists in the store`, "fix_input") };
      }
      return snapshotForGoalId(index, selector.goalId);
    }
    const scope = selector?.scope;
    const active = scope !== undefined ? activeGoalEntries(index).filter((entry) => entry.scope === scope) : activeGoalEntries(index);
    if (active.length === 1) return snapshotForGoalId(index, active[0]!.goalId);
    if (active.length > 1) {
      return { error: engineErr("multiple_active_goals", `multiple non-complete goals exist${scope !== undefined ? ` in scope ${scope}` : ""}: ${active.map((entry) => entry.goalId).join(", ")}`, "fix_input") };
    }
    // no active goal in the lane: fall back to the most recent goal of the same lane (clear semantics)
    let best: GoalSnapshot | undefined;
    for (const result of Object.values(index.goals)) {
      if (result.status !== "ok" || !result.goal) continue;
      if (scope !== undefined && scopeOfRecord(result.goal) !== scope) continue;
      const snap = buildSnapshot(result);
      if (
        !best
        || snap.runtime.updatedAt > best.runtime.updatedAt
        || (snap.runtime.updatedAt === best.runtime.updatedAt && snap.revisions.goal > best.revisions.goal)
      ) {
        best = snap;
      }
    }
    if (!best) return { error: engineErr("goal_missing", "no goal exists", "fix_input") };
    return { snapshot: best };
  }

  // --- mutation skeleton (D-E1/D-E3) ----------------------------------------

  interface RunContext {
    readonly lock: GoalsFileLock;
    readonly now: number;
    readonly isoNow: string;
    readonly guard: GoalMutationGuard;
    readonly requestHash: string;
    readonly replayed: boolean;
    readonly replayReceipt?: GoalMutationReceipt;
    readonly index: RestoreAllGoalsIndex;
  }

  function run<T>(
    toolName: GoalMutationToolName,
    payload: Record<string, unknown>,
    cas: GoalMutationGuardInput | undefined,
    body: (ctx: RunContext) => GoalEngineOutcome<T>,
  ): GoalEngineOutcome<T> {
    // SCHEMA-1 fix (zob parity): cas is OPTIONAL on every mutation. Without
    // a guard the engine auto-generates a fresh mutation id — the mutation
    // still receipts, but is intentionally NOT replay-idempotent (callers
    // wanting idempotence pass cas.mutation_id; absent revision slots are
    // simply unchecked).
    const built = buildMutationGuard(toolName, cas ?? { mutationId: `auto_${randomHex(12)}` });
    if (!built.ok) return engineErr("cas_invalid", built.message, "fix_input");
    const guard = built.guard;
    let requestHash: string;
    try {
      requestHash = hashGoalMutationRequest(toolName, payload);
    } catch (error) {
      return engineErr("invalid_input", `payload is not canonical JSON: ${errorText(error)}`, "fix_input");
    }
    const acquired = withGoalsLock(
      lockFile,
      (lock) => {
        const index = restoreAllGoals(stateDir, readOptions);
        const blocked = collectBlocked(index);
        if (blocked.length > 0) {
          return engineErr("restore_blocked", "the goals store is restore-blocked; inspect diagnostics before mutating", "after_context_change", {
            diagnostics: blocked,
          });
        }
        const replay = evaluateMutationReplay(index.receipts.state, { mutationId: guard.mutationId, requestHash });
        if (!replay.ok) {
          if (replay.status === "conflict") {
            return engineErr("cas_conflict", `mutationId ${guard.mutationId} is already bound to a different request hash`, "never");
          }
          return engineErr("cas_invalid", `invalid ${replay.code} for mutationId ${guard.mutationId}`, "fix_input");
        }
        const now = clock();
        const ctx: RunContext = {
          lock,
          now,
          isoNow: new Date(now).toISOString(),
          guard,
          requestHash,
          replayed: replay.status === "replayed",
          ...(replay.status === "replayed" ? { replayReceipt: replay.receipt } : {}),
          index,
        };
        try {
          return body(ctx);
        } catch (error) {
          return engineErr("store_write_failed", `goals store write failed: ${errorText(error)}`, "after_context_change");
        }
      },
      lockOptions,
    );
    if (!acquired.ok) {
      return engineErr("lock_error", `goals lock acquisition failed (${acquired.code}): ${acquired.message}`, "after_context_change");
    }
    return acquired.result;
  }

  function checkCas(ctx: RunContext, current: { goalRevision?: number; graphRevision?: number; todoRevision?: number }): GoalEngineError | undefined {
    const applied = applyMutationGuard(current, ctx.guard);
    if (applied.ok) return undefined;
    if (applied.status === "invalid") return engineErr("cas_invalid", "current stream revisions are malformed", "after_context_change");
    // friendly hint only when a PROVIDED slot mismatches (SCHEMA-1 fix)
    const hints: string[] = [];
    if (current.goalRevision !== undefined) hints.push(`current goal revision ${current.goalRevision}`);
    const todosRevision = current.todoRevision ?? current.graphRevision;
    if (todosRevision !== undefined) hints.push(`current todos revision ${todosRevision}`);
    return engineErr(
      "cas_stale",
      `CAS revision guard rejected: ${applied.codes.join(", ")}${hints.length > 0 ? ` (${hints.join(", ")})` : ""}`,
      "after_context_change",
      { staleCodes: applied.codes },
    );
  }

  /** SCHEMA-1 fix (zob parity): an absent revision slot is UNCHECKED — only
   * provided slots are compared, so mutation_id-only guards are plain
   * idempotent mutations and fully cas-less calls just apply. */
  function requireRootCas(ctx: RunContext, snap: GoalSnapshot): GoalEngineError | undefined {
    return checkCas(ctx, { goalRevision: snap.revisions.goal, graphRevision: snap.revisions.todos, todoRevision: snap.revisions.todos });
  }

  function requireGraphCas(ctx: RunContext, snap: GoalSnapshot): GoalEngineError | undefined {
    return checkCas(ctx, { goalRevision: snap.revisions.goal, graphRevision: snap.revisions.todos, todoRevision: snap.revisions.todos });
  }

  // --- append helpers --------------------------------------------------------

  function appendGoalSetEvent(ctx: RunContext, goalId: string, runtime: RuntimeGoal, headRevision: number): number {
    const revision = headRevision + 1;
    const event: GoalSetEvent = {
      schema: GOAL_STREAM_SCHEMA,
      kind: "goal_set",
      revision,
      at: ctx.now,
      data: { goal: runtimeGoalToRecord({ ...runtime, revision }) },
    };
    appendGoalEvent(ctx.lock, stateDir, goalId, event, { ...writeOptions, expectedRevision: headRevision });
    return revision;
  }

  function appendGoalClearEvent(ctx: RunContext, goalId: string, headRevision: number): number {
    const revision = headRevision + 1;
    appendGoalEvent(
      ctx.lock,
      stateDir,
      goalId,
      { schema: GOAL_STREAM_SCHEMA, kind: "goal_clear", revision, at: ctx.now, data: { goalId } },
      { ...writeOptions, expectedRevision: headRevision },
    );
    return revision;
  }

  function appendTodosSnapshotEvent(ctx: RunContext, goalId: string, nodes: readonly GoalTodoNode[], headRevision: number): number {
    const revision = headRevision + 1;
    const event: TodosSnapshotEvent = {
      schema: TODOS_STREAM_SCHEMA,
      kind: "todos_snapshot",
      revision,
      at: ctx.now,
      data: { goalId, nodes: nodes.map((node) => deepClone(node)), policy: treePolicyRecord },
    };
    appendTodoGraphEvent(ctx.lock, stateDir, goalId, event, { ...writeOptions, expectedRevision: headRevision });
    return revision;
  }

  function appendTodoUpdatedEvent(ctx: RunContext, goalId: string, node: GoalTodoNode, headRevision: number): number {
    const revision = headRevision + 1;
    const event: TodoUpdatedEvent = {
      schema: TODOS_STREAM_SCHEMA,
      kind: "todo_updated",
      revision,
      at: ctx.now,
      data: { goalId, node: deepClone(node) },
    };
    appendTodoGraphEvent(ctx.lock, stateDir, goalId, event, { ...writeOptions, expectedRevision: headRevision });
    return revision;
  }

  function commitReceipt(ctx: RunContext): GoalMutationReceipt {
    const built = buildMutationReceipt(ctx.guard, ctx.requestHash, ctx.now);
    if (!built.ok) throw new Error(`cannot build mutation receipt: ${built.message}`);
    appendReceipt(
      ctx.lock,
      stateDir,
      { schema: RECEIPT_STREAM_SCHEMA, kind: "mutation_receipt", at: ctx.now, data: { receipt: built.receipt } },
      writeOptions,
    );
    return built.receipt;
  }

  function notifyStatusChanged(goalId: string, from: RuntimeGoalStatus, to: RuntimeGoalStatus | undefined, revision: number, at: number): void {
    hooks.onGoalStatusChanged?.({ goalId, fromStatus: from, toStatus: to, revision, at });
  }

  // --- todo reference resolution ---------------------------------------------

  function resolveTodoRef(snap: GoalSnapshot, ref: GoalTodoCanonicalReferenceInput): { node?: GoalTodoNode; error?: GoalEngineError } {
    const resolution = resolveCanonicalGoalTodoReference(
      { goalId: snap.goalId, entries: snap.nodes.map((node) => ({ id: node.id, path: node.path })) },
      ref ?? {},
    );
    if (resolution.code !== "resolved" || !resolution.canonicalId) {
      const first = resolution.errors[0];
      return {
        error: engineErr(
          "reference_error",
          first ? `${first.code}: ${first.message}` : "todo reference failed to resolve",
          resolution.retryPolicy === "fix_input" ? "fix_input" : "after_context_change",
          { referenceCode: resolution.code },
        ),
      };
    }
    const node = snap.nodes.find((candidate) => candidate.id === resolution.canonicalId);
    if (!node) {
      return { error: engineErr("reference_error", `resolved todo ${resolution.canonicalId} is missing from the graph`, "after_context_change", { referenceCode: "todo_id_not_found" }) };
    }
    return { node };
  }

  function claimBindingFor(snap: GoalSnapshot, node: GoalTodoNode): GoalTodoClaimBinding | undefined {
    const attemptId = lookupRecord(snap.delegations, node.id);
    if (!attemptId) return undefined;
    const claim = lookupRecord(snap.claims.claims, attemptId);
    if (!claim) return undefined;
    return { claimHash: claim.claimHash, attemptId, validationPolicy: claim.validationPolicy };
  }

  /**
   * Derived 2d lifecycle read-model: the append-only claims stream records
   * launch/return/validation/settlement EVENTS, so the raw attempt record
   * keeps its launch status. The effective attempt status is derived from
   * the side tables (settlement → accepted/rejected, claim →
   * claim_returned, else the recorded status) exactly like zob's node-bound
   * delegation state would read.
   */
  function lifecycleOf(snap: GoalSnapshot): { attempts: Readonly<Record<string, GoalTodoDelegationAttemptRecord>>; claims: Readonly<Record<string, GoalTodoReturnedClaim>>; validations: Readonly<Record<string, GoalTodoClaimValidationRecord>> } {
    const attempts: Record<string, GoalTodoDelegationAttemptRecord> = {};
    for (const [attemptId, attempt] of Object.entries(snap.claims.attempts)) {
      const settlement = lookupRecord(snap.claims.settlements, attemptId);
      const claim = lookupRecord(snap.claims.claims, attemptId);
      const derived: GoalTodoDelegationAttemptStatus = settlement ? settlement.settlement : claim ? "claim_returned" : attempt.status;
      attempts[attemptId] = derived === attempt.status ? attempt : { ...attempt, status: derived };
    }
    return { attempts, claims: snap.claims.claims, validations: snap.claims.validations };
  }

  function oracleSnapshotOf(snap: GoalSnapshot): { goalId: string; revision: number; status: RuntimeGoalStatus; completionProposal?: GoalCompletionProposal } {
    return {
      goalId: snap.goalId,
      revision: snap.revisions.goal,
      status: snap.runtime.status,
      ...(snap.runtime.completionProposal ? { completionProposal: snap.runtime.completionProposal } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  function createGoal(objective: string, cas: GoalMutationGuardInput | undefined, createOptions?: CreateGoalOptions): GoalEngineOutcome<CreateGoalResult> {
    const trimmed = typeof objective === "string" ? objective.trim() : "";
    if (trimmed.length === 0 || trimmed.length > MAX_RUNTIME_GOAL_OBJECTIVE_CHARS) {
      return engineErr("invalid_input", `objective must be a non-empty string of at most ${MAX_RUNTIME_GOAL_OBJECTIVE_CHARS} characters`, "fix_input");
    }
    if (createOptions?.maxTurns !== undefined && !(Number.isSafeInteger(createOptions.maxTurns) && createOptions.maxTurns >= 1)) {
      return engineErr("invalid_input", "maxTurns must be a safe integer >= 1", "fix_input");
    }
    if (createOptions?.scope !== undefined && !isCanonicalGoalScope(createOptions.scope)) {
      return engineErr("invalid_input", `scope must be canonical (local | agent:<id> | room:<id>), got: ${createOptions.scope}`, "fix_input");
    }
    // M1 (review follow-up): scope_label is DISPLAY-ONLY and deliberately
    // EXCLUDED from the CAS request hash — an alias rename between a crash
    // and its retry must replay, not cas_conflict. The canonical scope
    // itself stays hash-bound.
    const payload = compactRecord({
      objective: trimmed,
      max_turns: createOptions?.maxTurns,
      scope: createOptions?.scope,
    });
    return run("create_goal", payload, cas, (ctx) => {
      const scope = createOptions?.scope ?? LOCAL_GOAL_SCOPE;
      const active = findActiveGoalInScope(ctx.index, scope);
      if (ctx.replayed) {
        return replayedOk(
          {
            goalId: active.snapshot?.goalId ?? "",
            ...(active.snapshot ? { goal: active.snapshot.runtime } : {}),
          },
          ctx.replayReceipt!,
        );
      }
      if (active.error && active.error.code !== "goal_missing") return active.error;
      if (active.snapshot) {
        return engineErr("goal_already_active", `a non-complete goal ${active.snapshot.goalId} already exists in scope ${scope}; complete or clear it first (or create in another scope)`, "fix_input");
      }
      const casError = checkCas(ctx, { goalRevision: 0 });
      if (casError) return casError;
      const goalId = generateGoalId();
      const goal = createRuntimeGoal(trimmed, {
        goalId,
        now: ctx.now,
        ...(createOptions?.maxTurns !== undefined ? { maxTurns: createOptions.maxTurns } : {}),
        ...(createOptions?.gate !== undefined ? { gate: createOptions.gate } : {}),
        ...(createOptions?.scope !== undefined ? { scope: createOptions.scope } : {}),
        ...(createOptions?.scopeLabel !== undefined ? { scopeLabel: createOptions.scopeLabel } : {}),
      });
      appendGoalSetEvent(ctx, goalId, goal, 0);
      writeRuntimeOverlay(goalId, goal, {});
      const receipt = commitReceipt(ctx);
      return { ok: true, status: "applied", receipt, result: { goalId, goal } };
    });
  }

  function getGoal(goalId?: string, scope?: string): { goal?: GoalRuntimeView; diagnostics?: readonly RestoreDiagnostic[] } {
    const index = restoreAllGoals(stateDir, readOptions);
    const blocked = collectBlocked(index);
    if (blocked.length > 0) return { diagnostics: blocked };
    if (goalId !== undefined) {
      const result = index.goals[goalId];
      if (!result || result.status !== "ok" || !result.goal) return {};
      return { goal: viewOf(buildSnapshot(result)) };
    }
    // scope-aware read: an explicit scope narrows the lane; the legacy bare
    // read resolves the single active goal store-wide and stays undefined
    // when several lanes are active (the get_goals overview disambiguates).
    const resolved = scope !== undefined ? findActiveGoalInScope(index, scope) : resolveTargetGoal(index);
    if (!resolved.snapshot) return {};
    return { goal: viewOf(resolved.snapshot) };
  }

  function getGoalsOverview(): GetGoalsOverviewResult {
    const index = restoreAllGoals(stateDir, readOptions);
    const blocked = collectBlocked(index);
    if (blocked.length > 0) return { diagnostics: blocked };
    const entries: GoalOverviewEntry[] = [];
    for (const result of Object.values(index.goals)) {
      if (result.status !== "ok" || !result.goal) continue;
      entries.push({
        goalId: result.goalId,
        scope: scopeOfRecord(result.goal),
        ...(result.goal.scopeLabel !== undefined ? { scopeLabel: result.goal.scopeLabel } : {}),
        status: result.goal.status,
        objective: result.goal.objective,
        revision: result.revisions.goal,
        todos: result.todoGraph.nodes.length,
        createdAt: result.goal.createdAt,
        updatedAt: result.goal.updatedAt,
      });
    }
    entries.sort((a, b) => a.updatedAt - b.updatedAt || (a.goalId < b.goalId ? -1 : 1));
    return { overview: entries };
  }

  function addTodos(items: readonly AddGoalTodoNodeItem[], cas: GoalMutationGuardInput | undefined, selector?: GoalSelector): GoalEngineOutcome<AddTodosResult> {
    const payload = {
      ...selectorKeys(selector),
      items: (items ?? []).map((item) =>
        compactRecord({
          parent_id: item?.parentId,
          title: item?.input?.title,
          status: item?.input?.status,
          owner: item?.input?.owner,
          required: item?.input?.required,
          priority: item?.input?.priority,
          acceptance_criteria: item?.input?.acceptanceCriteria?.slice(),
          evidence_refs: item?.input?.evidenceRefs?.slice(),
          validation_commands: item?.input?.validationCommands?.slice(),
        }),
      ),
    };
    return run("add_goal_todos", payload, cas, (ctx): GoalEngineOutcome<AddTodosResult> => {
      const target = resolveTargetGoal(ctx.index, selector);
      if (target.error) return target.error;
      const snap = target.snapshot!;
      if (ctx.replayed) {
        return replayedOk({ created: [], todosRevision: snap.revisions.todos, summary: snap.summary }, ctx.replayReceipt!);
      }
      const casError = requireGraphCas(ctx, snap);
      if (casError) return casError;
      const added = addGoalTodoNodes(snap.nodes, { items: items ?? [], policy: treePolicy, randomBytes, now: ctx.now });
      if (!added.ok) return engineErr("tree_error", `${added.error.code}: ${added.error.message}`, "fix_input", { treeCode: added.error.code });
      const todosRevision = appendTodosSnapshotEvent(ctx, snap.goalId, added.value.nodes, snap.revisions.todos);
      const receipt = commitReceipt(ctx);
      return {
        ok: true,
        status: "applied",
        receipt,
        result: { created: added.value.created ?? [], todosRevision, summary: summarizeGoalTodos(added.value.nodes) },
      };
    });
  }

  function updateTodoMetadata(
    ref: GoalTodoCanonicalReferenceInput,
    patch: GoalTodoNodeMetadataPatch,
    cas: GoalMutationGuardInput | undefined,
    selector?: GoalSelector,
  ): GoalEngineOutcome<UpdateTodoMetadataResult> {
    const rawPatch = (patch ?? {}) as Record<string, unknown>;
    const payload = compactRecord({
      ...selectorKeys(selector),
      todo_id: ref?.todoId,
      todo_path: ref?.todoPath,
      patch: compactRecord({
        title: rawPatch.title,
        priority: rawPatch.priority,
        owner: rawPatch.owner,
        required: rawPatch.required,
        acceptance_criteria: Array.isArray(rawPatch.acceptanceCriteria) ? rawPatch.acceptanceCriteria.slice() : undefined,
        evidence_refs: Array.isArray(rawPatch.evidenceRefs) ? rawPatch.evidenceRefs.slice() : undefined,
        validation_commands: Array.isArray(rawPatch.validationCommands) ? rawPatch.validationCommands.slice() : undefined,
        status: rawPatch.status,
      }),
    });
    return run("update_goal_todo", payload, cas, (ctx): GoalEngineOutcome<UpdateTodoMetadataResult> => {
      const target = resolveTargetGoal(ctx.index, selector);
      if (target.error) return target.error;
      const snap = target.snapshot!;
      const resolution = resolveTodoRef(snap, ref);
      if (resolution.error) return resolution.error;
      const node = resolution.node!;
      if (ctx.replayed) {
        return replayedOk({ node, changed: false, todosRevision: snap.revisions.todos }, ctx.replayReceipt!);
      }
      const casError = requireGraphCas(ctx, snap);
      if (casError) return casError;
      const updated = updateGoalTodoNodeMetadata(snap.nodes, node.id, patch ?? {}, { now: ctx.now });
      if (!updated.ok) return engineErr("tree_error", `${updated.error.code}: ${updated.error.message}`, "fix_input", { treeCode: updated.error.code });
      let todosRevision = snap.revisions.todos;
      if (updated.value.changed) {
        todosRevision = appendTodoUpdatedEvent(ctx, snap.goalId, updated.value.updated!, snap.revisions.todos);
      }
      const receipt = commitReceipt(ctx);
      return {
        ok: true,
        status: "applied",
        receipt,
        result: { node: updated.value.updated ?? node, changed: updated.value.changed, todosRevision },
      };
    });
  }

  function resolveTodo(
    ref: GoalTodoCanonicalReferenceInput,
    action: GoalTodoAction,
    input: GoalTodoTransitionInput,
    cas: GoalMutationGuardInput | undefined,
    selector?: GoalSelector,
  ): GoalEngineOutcome<ResolveTodoResult> {
    const toolName: GoalMutationToolName =
      action === "complete"
        ? "complete_goal_todo"
        : action === "block"
          ? "block_goal_todo"
          : action === "accept_claim"
            ? "accept_goal_todo_claim"
            : action === "reject_claim"
              ? "reject_goal_todo_claim"
              : "resolve_goal_todo";
    const payload = compactRecord({
      ...selectorKeys(selector),
      todo_id: ref?.todoId,
      todo_path: ref?.todoPath,
      action,
      reason: input?.reason,
      user_resolved: input?.userResolved,
      claim_hash: input?.claimHash,
      attempt_id: input?.attemptId,
      validation_policy: input?.validationPolicy,
    });
    return run(toolName, payload, cas, (ctx) => {
      const target = resolveTargetGoal(ctx.index, selector);
      if (target.error) return target.error;
      const snap = target.snapshot!;
      const resolution = resolveTodoRef(snap, ref);
      if (resolution.error) return resolution.error;
      const node = resolution.node!;
      if (ctx.replayed) {
        return replayedOk({ node, effects: {}, todosRevision: snap.revisions.todos }, ctx.replayReceipt!);
      }
      const casError = requireGraphCas(ctx, snap);
      if (casError) return casError;
      const binding = claimBindingFor(snap, node);
      const applied = applyGoalTodoTransition(
        { status: node.status, required: node.required, ...(binding ? { claim: binding } : {}) },
        action,
        input ?? {},
      );
      if (!applied.ok) {
        return engineErr("transition_rejected", `${applied.code}: ${applied.message}`, copyCoreRetry(applied.retryPolicy), {
          transitionCode: applied.code,
        });
      }
      // claim settlements authorize BEFORE any stream append: a rejected
      // settlement (e.g. the BUG-2 oracle_required PASS gate) must leave the
      // node, the todos stream, and the claims stream untouched.
      let settlement: GoalTodoClaimSettlementRecord | undefined;
      let claimComposition: OracleClaimAutoAcceptComposition | undefined;
      if (action === "accept_claim" || action === "reject_claim") {
        const settleInput = {
          claimHash: input.claimHash as string,
          attemptId: input.attemptId as string,
          validationPolicy: input.validationPolicy as GoalTodoClaimValidationPolicy,
        };
        const settled = action === "accept_claim"
          ? settleAcceptClaim(lifecycleOf(snap), settleInput)
          : settleRejectClaim(lifecycleOf(snap), { ...settleInput, reason: input.reason as string });
        if (!settled.ok) {
          return engineErr("claim_error", `${settled.code}: ${settled.message}`, copyCoreRetry(settled.retryPolicy), { claimCode: settled.code });
        }
        settlement = settled.record;
        const validation = lookupRecord(snap.claims.validations, settled.record.attemptId);
        if (validation) {
          claimComposition = composeOracleClaimAutoAccept(snap.runtime.oracleDecision, validation);
        }
      }
      const nextNode: GoalTodoNode = { ...node, status: applied.nextStatus, updatedAt: ctx.now };
      const todosRevision = appendTodoUpdatedEvent(ctx, snap.goalId, nextNode, snap.revisions.todos);
      if (settlement !== undefined) {
        appendClaimEvent(
          ctx.lock,
          stateDir,
          snap.goalId,
          {
            schema: CLAIMS_STREAM_SCHEMA,
            kind: settlement.settlement === "accepted" ? "claim_accepted" : "claim_rejected",
            at: ctx.now,
            data: { goalId: snap.goalId, settlement },
          },
          writeOptions,
        );
      }
      const receipt = commitReceipt(ctx);
      return {
        ok: true,
        status: "applied",
        receipt,
        result: {
          node: nextNode,
          effects: applied.effects,
          todosRevision,
          ...(settlement ? { settlement } : {}),
          ...(claimComposition ? { claimComposition } : {}),
        },
      };
    });
  }

  function linkDelegation(ref: GoalTodoCanonicalReferenceInput, input: LinkDelegationInput, cas: GoalMutationGuardInput | undefined, selector?: GoalSelector): GoalEngineOutcome<LinkDelegationResult> {
    if (input?.delegationDepth !== undefined && !(Number.isSafeInteger(input.delegationDepth) && input.delegationDepth >= 1)) {
      return engineErr("invalid_input", "delegationDepth must be a safe integer >= 1", "fix_input");
    }
    const payload = compactRecord({
      ...selectorKeys(selector),
      todo_id: ref?.todoId,
      todo_path: ref?.todoPath,
      attempt_id: input?.attemptId,
      run_id: input?.runId,
      agent: input?.agent,
      validation_policy: input?.validationPolicy,
      delegation_depth: input?.delegationDepth,
    });
    return run("recover_goal_todo_delegation", payload, cas, (ctx) => {
      const target = resolveTargetGoal(ctx.index, selector);
      if (target.error) return target.error;
      const snap = target.snapshot!;
      const resolution = resolveTodoRef(snap, ref);
      if (resolution.error) return resolution.error;
      const node = resolution.node!;
      const boundAttemptId = lookupRecord(snap.delegations, node.id);
      if (ctx.replayed) {
        const attempt = boundAttemptId ? lookupRecord(snap.claims.attempts, boundAttemptId) : undefined;
        if (!attempt) return engineErr("claim_error", `no delegation attempt recorded for todo ${node.id}`, "after_context_change");
        return replayedOk({ attempt, node }, ctx.replayReceipt!);
      }
      const casError = requireGraphCas(ctx, snap);
      if (casError) return casError;
      if (node.status !== "planned" && node.status !== "ready" && node.status !== "in_progress" && node.status !== "delegated") {
        return engineErr("node_status_invalid", `delegation links require a planned/ready/in_progress/delegated node; ${node.id} is ${node.status}`, "after_context_change");
      }
      const attemptId = input?.attemptId ?? generateAttemptId();
      const launched = launchDelegationAttempt(lifecycleOf(snap), {
        attemptId,
        ...(input?.runId !== undefined ? { runId: input.runId } : {}),
        ...(input?.agent !== undefined ? { agent: input.agent } : {}),
        ...(input?.validationPolicy !== undefined ? { validationPolicy: input.validationPolicy } : {}),
        ...(input?.delegationDepth !== undefined ? { delegationDepth: input.delegationDepth } : {}),
        now: ctx.now,
      });
      if (!launched.ok) {
        return engineErr("claim_error", `${launched.code}: ${launched.message}`, copyCoreRetry(launched.retryPolicy), { claimCode: launched.code });
      }
      appendClaimEvent(
        ctx.lock,
        stateDir,
        snap.goalId,
        { schema: CLAIMS_STREAM_SCHEMA, kind: "delegation_attempt_launched", at: ctx.now, data: { goalId: snap.goalId, attempt: launched.record } },
        writeOptions,
      );
      const nextNode: GoalTodoNode = { ...node, status: "delegated", updatedAt: ctx.now };
      const todosRevision = appendTodoUpdatedEvent(ctx, snap.goalId, nextNode, snap.revisions.todos);
      writeRuntimeOverlay(snap.goalId, snap.runtime, { ...snap.delegations, [node.id]: attemptId });
      const receipt = commitReceipt(ctx);
      return { ok: true, status: "applied", receipt, result: { attempt: launched.record, node: nextNode } };
    });
  }

  function returnClaim(attemptId: string, input: ReturnClaimInput, cas: GoalMutationGuardInput | undefined, selector?: GoalSelector): GoalEngineOutcome<ReturnClaimResult> {
    const payload = compactRecord({
      ...selectorKeys(selector),
      attempt_id: attemptId,
      claim_text: input?.claimText,
      claim_hash: input?.claimHash,
      evidence_refs: input?.evidenceRefs?.slice(),
      validation_commands: input?.validationCommands?.slice(),
      no_ship: input?.noShip,
    });
    return run("recover_goal_todo_delegation", payload, cas, (ctx) => {
      const target = resolveGoalByAttempt(ctx.index, attemptId, selector);
      if (target.error) return target.error;
      const snap = target.snapshot!;
      if (ctx.replayed) {
        const claim = lookupRecord(snap.claims.claims, attemptId);
        if (!claim) return engineErr("claim_error", `no claim returned for attempt ${attemptId}`, "after_context_change");
        return replayedOk({ claim }, ctx.replayReceipt!);
      }
      const casError = requireGraphCas(ctx, snap);
      if (casError) return casError;
      const todoId = Object.keys(snap.delegations).find((key) => snap.delegations[key] === attemptId);
      if (!todoId) {
        return engineErr("claim_error", `no delegation binding maps attempt ${attemptId} to a TODO in goal ${snap.goalId}`, "after_context_change", {
          claimCode: "attempt_not_found",
        });
      }
      const node = snap.nodes.find((candidate) => candidate.id === todoId);
      if (!node) {
        return engineErr("claim_error", `delegated TODO ${todoId} no longer exists in the graph`, "after_context_change");
      }
      if (node.status !== "delegated" && node.status !== "claim_returned") {
        return engineErr("node_status_invalid", `claims return onto delegated nodes; ${node.id} is ${node.status}`, "after_context_change");
      }
      const returned = returnGoalTodoClaim(lifecycleOf(snap), {
        attemptId,
        ...(input?.claimHash !== undefined ? { claimHash: input.claimHash } : {}),
        ...(input?.claimText !== undefined ? { claimText: input.claimText } : {}),
        evidenceRefs: input?.evidenceRefs,
        validationCommands: input?.validationCommands,
        ...(input?.noShip !== undefined ? { noShip: input.noShip } : {}),
        now: ctx.now,
      });
      if (!returned.ok) {
        return engineErr("claim_error", `${returned.code}: ${returned.message}`, copyCoreRetry(returned.retryPolicy), { claimCode: returned.code });
      }
      appendClaimEvent(
        ctx.lock,
        stateDir,
        snap.goalId,
        { schema: CLAIMS_STREAM_SCHEMA, kind: "claim_returned", at: ctx.now, data: { goalId: snap.goalId, claim: returned.record } },
        writeOptions,
      );
      const nextNode: GoalTodoNode = { ...node, status: "claim_returned", updatedAt: ctx.now };
      const todosRevision = appendTodoUpdatedEvent(ctx, snap.goalId, nextNode, snap.revisions.todos);
      const receipt = commitReceipt(ctx);
      return { ok: true, status: "applied", receipt, result: { claim: returned.record, node: nextNode } };
    });
  }

  function recordClaimValidation(attemptId: string, input: ClaimValidationInput, cas: GoalMutationGuardInput | undefined, selector?: GoalSelector): GoalEngineOutcome<RecordClaimValidationResult> {
    const payload = compactRecord({
      ...selectorKeys(selector),
      attempt_id: attemptId,
      run_id: input?.runId,
      verdict: input?.verdict,
      recommended_action: input?.recommendedAction,
      no_ship: input?.noShip,
      confidence: input?.confidence,
      blocking_issues: input?.blockingIssues?.slice(),
      output_hash: input?.outputHash,
      evidence_refs: input?.evidenceRefs?.slice(),
      validation_commands: input?.validationCommands?.slice(),
      agent: input?.agent,
    });
    return run("validate_goal_todo_claim", payload, cas, (ctx) => {
      const target = resolveGoalByAttempt(ctx.index, attemptId, selector);
      if (target.error) return target.error;
      const snap = target.snapshot!;
      if (ctx.replayed) {
        const validation = lookupRecord(snap.claims.validations, attemptId);
        if (!validation) return engineErr("claim_error", `no validation recorded for attempt ${attemptId}`, "after_context_change");
        return replayedOk(
          {
            validation,
            claimRule: isStrictPassAutoAccept(validation),
            oracleComposition: composeOracleClaimAutoAccept(snap.runtime.oracleDecision, validation),
          },
          ctx.replayReceipt!,
        );
      }
      const casError = requireGraphCas(ctx, snap);
      if (casError) return casError;
      const recorded = recordClaimValidationCore(lifecycleOf(snap), {
        attemptId,
        ...(input?.runId !== undefined ? { runId: input.runId } : {}),
        verdict: input?.verdict,
        recommendedAction: input?.recommendedAction,
        noShip: input?.noShip,
        confidence: input?.confidence,
        blockingIssues: input?.blockingIssues,
        outputHash: input?.outputHash,
        evidenceRefs: input?.evidenceRefs,
        validationCommands: input?.validationCommands,
        ...(input?.agent !== undefined ? { agent: input.agent } : {}),
        now: ctx.now,
      });
      if (!recorded.ok) {
        return engineErr("claim_error", `${recorded.code}: ${recorded.message}`, copyCoreRetry(recorded.retryPolicy), { claimCode: recorded.code });
      }
      appendClaimEvent(
        ctx.lock,
        stateDir,
        snap.goalId,
        { schema: CLAIMS_STREAM_SCHEMA, kind: "claim_validated", at: ctx.now, data: { goalId: snap.goalId, validation: recorded.record } },
        writeOptions,
      );
      const receipt = commitReceipt(ctx);
      return {
        ok: true,
        status: "applied",
        receipt,
        result: {
          validation: recorded.record,
          claimRule: isStrictPassAutoAccept(recorded.record),
          oracleComposition: composeOracleClaimAutoAccept(snap.runtime.oracleDecision, recorded.record),
        },
      };
    });
  }

  function proposeCompletion(input: ProposeCompletionInput, cas: GoalMutationGuardInput | undefined, selector?: GoalSelector): GoalEngineOutcome<ProposeCompletionResult> {
    if (typeof input?.completionSummary !== "string") {
      return engineErr("invalid_input", "completionSummary must be a string", "fix_input");
    }
    for (const field of ["requirementsChecked", "evidenceRefs", "validationCommands", "knownRisks"] as const) {
      if (input[field] !== undefined && !Array.isArray(input[field])) {
        return engineErr("invalid_input", `${field} must be an array of strings`, "fix_input");
      }
    }
    const payload = compactRecord({
      ...selectorKeys(selector),
      completion_summary: input.completionSummary,
      requirements_checked: input.requirementsChecked?.slice(),
      evidence_refs: input.evidenceRefs?.slice(),
      validation_commands: input.validationCommands?.slice(),
      known_risks: input.knownRisks?.slice(),
      no_ship: input?.noShip,
    });
    return run("propose_goal_completion", payload, cas, (ctx) => {
      const target = resolveTargetGoal(ctx.index, selector);
      if (target.error) return target.error;
      const snap = target.snapshot!;
      if (ctx.replayed) {
        return replayedOk({ goal: snap.runtime, ...(snap.runtime.completionProposal ? { proposal: snap.runtime.completionProposal } : {}) }, ctx.replayReceipt!);
      }
      const casError = requireRootCas(ctx, snap) ?? requireGraphCas(ctx, snap);
      if (casError) return casError;
      if (snap.runtime.status !== "active" && snap.runtime.status !== "ready_for_oracle") {
        return engineErr("goal_status_invalid", `completion can be proposed only from active (or ready_for_oracle reproposal); current status is ${snap.runtime.status}`, "after_context_change");
      }
      if (snap.runtime.status === "ready_for_oracle") {
        const freshness = evaluateProposalFreshness(oracleSnapshotOf(snap), snap.revisions.todos, snap.completion);
        if (freshness.status === "fresh") {
          return engineErr("goal_status_invalid", "the goal already holds a fresh proposal awaiting oracle review; record the oracle decision or complete instead", "fix_input");
        }
      }
      if (input.noShip === true || snap.completion.effectiveNoShip) {
        const blockers = [...snap.completion.blockers];
        const reason = input.noShip === true ? "proposal submitted with no_ship=true; " : "";
        return engineErr(
          "completion_not_ready",
          `${reason}cannot propose goal completion: completionReady=${snap.completion.completionReady} effectiveNoShip=${snap.completion.effectiveNoShip}${blockers.length > 0 ? `\n- ${formatGoalTodoBlockers(snap.completion).join("\n- ")}` : ""}`,
          "fix_input",
          { blockers },
        );
      }
      const proposal = buildGoalCompletionProposal({
        goalId: snap.goalId,
        goalRevision: snap.revisions.goal + 1,
        todoGraphRevision: snap.revisions.todos,
        completionSummary: input.completionSummary,
        requirementsChecked: input.requirementsChecked ?? [],
        evidenceRefs: input.evidenceRefs ?? [],
        validationCommands: input.validationCommands ?? [],
        knownRisks: input.knownRisks ?? [],
        noShip: false,
        proposedAt: ctx.isoNow,
      });
      const { oracleDecision: _cleared, ...runtimeBase } = snap.runtime;
      const nextRuntime: RuntimeGoal = {
        ...runtimeBase,
        status: "ready_for_oracle",
        loop: { ...snap.runtime.loop, enabled: false },
        completionProposal: proposal,
        revision: snap.revisions.goal + 1,
        updatedAt: ctx.now,
      };
      const revision = appendGoalSetEvent(ctx, snap.goalId, nextRuntime, snap.revisions.goal);
      writeRuntimeOverlay(snap.goalId, nextRuntime, snap.delegations);
      const receipt = commitReceipt(ctx);
      notifyStatusChanged(snap.goalId, snap.runtime.status, "ready_for_oracle", revision, ctx.now);
      return { ok: true, status: "applied", receipt, result: { goal: nextRuntime, proposal } };
    });
  }

  function recordOracleDecision(review: OracleReviewSubmission, cas: GoalMutationGuardInput | undefined, selector?: GoalSelector): GoalEngineOutcome<RecordOracleDecisionResult> {
    const payload = compactRecord({
      ...selectorKeys(selector),
      verdict: review?.verdict,
      no_ship: review?.noShip,
      evidence_summary: review?.evidenceSummary,
      evidence_refs: review?.evidenceRefs?.slice(),
    });
    return run("record_goal_oracle", payload, cas, (ctx) => {
      const target = resolveTargetGoal(ctx.index, selector);
      if (target.error) return target.error;
      const snap = target.snapshot!;
      if (ctx.replayed) {
        if (!snap.runtime.oracleDecision) {
          return engineErr("oracle_not_fresh", "no oracle decision bound to the current goal state", "after_context_change", {
            freshnessCode: "oracle_binding_missing",
          });
        }
        return replayedOk({ goal: snap.runtime, decision: snap.runtime.oracleDecision }, ctx.replayReceipt!);
      }
      const casError = requireRootCas(ctx, snap) ?? requireGraphCas(ctx, snap);
      if (casError) return casError;
      const summary = typeof review?.evidenceSummary === "string" ? review.evidenceSummary.trim() : "";
      if (summary.length === 0) {
        return engineErr("evidence_required", "a non-empty evidenceSummary is required to record an oracle decision", "fix_input");
      }
      if (snap.runtime.status !== "ready_for_oracle") {
        return engineErr("goal_status_invalid", `oracle decisions are recorded only on ready_for_oracle goals; current status is ${snap.runtime.status}`, "after_context_change");
      }
      if (snap.runtime.oracleDecision) {
        return engineErr("oracle_already_bound", "an immutable oracle decision is already bound to this proposal lineage; repropose completion to clear it", "after_context_change");
      }
      const freshness = evaluateProposalFreshness(oracleSnapshotOf(snap), snap.revisions.todos, snap.completion);
      if (freshness.status !== "fresh") {
        return engineErr("proposal_not_fresh", `the completion proposal is not fresh (freshness=${freshness.code}); safe next action: ${freshness.safeReproposeAction}`, "after_context_change", {
          freshnessCode: freshness.code,
        });
      }
      const validated = validateGoalCompletionProposal(snap.runtime.completionProposal);
      if (!validated.valid) {
        return engineErr("proposal_not_fresh", `the completion proposal failed strict validation: ${validated.code}`, "after_context_change", {
          freshnessCode: "malformed_snapshot",
        });
      }
      const decision = buildOracleDecision(validated.proposal, {
        goalRevision: snap.revisions.goal + 1,
        verdict: review.verdict,
        noShip: review.noShip,
        evidenceSummary: summary,
        evidenceRefs: review.evidenceRefs ?? [],
        reviewedAt: ctx.isoNow,
      });
      const failed = !(review.verdict === "PASS" && review.noShip === false);
      const nextStatus: RuntimeGoalStatus = failed ? "oracle_failed" : "ready_for_oracle";
      const nextRuntime: RuntimeGoal = {
        ...snap.runtime,
        oracleDecision: decision,
        status: nextStatus,
        loop: { ...snap.runtime.loop, enabled: false },
        revision: snap.revisions.goal + 1,
        updatedAt: ctx.now,
      };
      const revision = appendGoalSetEvent(ctx, snap.goalId, nextRuntime, snap.revisions.goal);
      writeRuntimeOverlay(snap.goalId, nextRuntime, snap.delegations);
      const receipt = commitReceipt(ctx);
      notifyStatusChanged(snap.goalId, snap.runtime.status, nextStatus, revision, ctx.now);
      return { ok: true, status: "applied", receipt, result: { goal: nextRuntime, decision } };
    });
  }

  function completeGoal(cas: GoalMutationGuardInput | undefined, echoes?: CompleteGoalEchoes, selector?: GoalSelector): GoalEngineOutcome<CompleteGoalResult> {
    const payload = compactRecord({
      ...selectorKeys(selector),
      expected_proposal_hash: echoes?.expectedProposalHash,
      expected_oracle_decision_hash: echoes?.expectedOracleDecisionHash,
    });
    return run("update_goal", payload, cas, (ctx) => {
      const target = resolveTargetGoal(ctx.index, selector);
      if (target.error) return target.error;
      const snap = target.snapshot!;
      if (ctx.replayed) {
        return replayedOk({ goal: snap.runtime }, ctx.replayReceipt!);
      }
      const casError = requireRootCas(ctx, snap) ?? requireGraphCas(ctx, snap);
      if (casError) return casError;
      if (echoes?.expectedProposalHash !== undefined && echoes.expectedProposalHash !== snap.runtime.completionProposal?.proposalHash) {
        return engineErr("invalid_input", "expected_proposal_hash does not match the stored completion proposal", "fix_input");
      }
      if (echoes?.expectedOracleDecisionHash !== undefined && echoes.expectedOracleDecisionHash !== snap.runtime.oracleDecision?.oracleDecisionHash) {
        return engineErr("invalid_input", "expected_oracle_decision_hash does not match the bound oracle decision", "fix_input");
      }
      const freshness = evaluateOracleFreshness(oracleSnapshotOf(snap), snap.runtime.oracleDecision, snap.revisions.todos, snap.completion);
      if (freshness.status !== "fresh") {
        return engineErr("oracle_not_fresh", `the oracle decision is not fresh (freshness=${freshness.code}); safe next action: ${freshness.safeNextAction}`, "after_context_change", {
          freshnessCode: freshness.code,
        });
      }
      const decision = snap.runtime.oracleDecision!;
      const revision = decision.goalRevision + 1;
      if (revision !== snap.revisions.goal + 1) {
        return engineErr("oracle_not_fresh", "the oracle root revision binding does not line up with the current goal revision", "after_context_change", {
          freshnessCode: "root_revision_mismatch",
        });
      }
      const nextRuntime: RuntimeGoal = {
        ...snap.runtime,
        status: "complete",
        loop: { ...snap.runtime.loop, enabled: false },
        revision,
        updatedAt: ctx.now,
      };
      const applied = appendGoalSetEvent(ctx, snap.goalId, nextRuntime, snap.revisions.goal);
      writeRuntimeOverlay(snap.goalId, nextRuntime, snap.delegations);
      const receipt = commitReceipt(ctx);
      notifyStatusChanged(snap.goalId, snap.runtime.status, "complete", applied, ctx.now);
      return { ok: true, status: "applied", receipt, result: { goal: nextRuntime } };
    });
  }

  function pauseGoal(reason: string, cas: GoalMutationGuardInput | undefined, selector?: GoalSelector): GoalEngineOutcome<PauseGoalResult> {
    const payload = compactRecord({ ...selectorKeys(selector), pause_reason: reason });
    return run("update_goal", payload, cas, (ctx) => {
      const target = resolveTargetGoal(ctx.index, selector);
      if (target.error) return target.error;
      const snap = target.snapshot!;
      if (ctx.replayed) {
        return replayedOk({ goal: snap.runtime, previousStatus: snap.runtime.status }, ctx.replayReceipt!);
      }
      const casError = requireRootCas(ctx, snap);
      if (casError) return casError;
      const trimmedReason = typeof reason === "string" ? reason.trim() : "";
      if (trimmedReason.length === 0) {
        return engineErr("reason_required", "a non-empty pause reason is required", "fix_input");
      }
      // Phase 6 pause gate (D-E7): the zob /goal pause gate (active only) is
      // widened to every working status — active, ready_for_oracle,
      // oracle_failed, budget_limited. paused/blocked/complete never pause.
      if (
        snap.runtime.status !== "active"
        && snap.runtime.status !== "ready_for_oracle"
        && snap.runtime.status !== "oracle_failed"
        && snap.runtime.status !== "budget_limited"
      ) {
        return engineErr(
          "goal_status_invalid",
          `only active, ready_for_oracle, oracle_failed, or budget_limited goals can pause; current status is ${snap.runtime.status}`,
          "after_context_change",
        );
      }
      const previousStatus = snap.runtime.status;
      const nextRuntime: RuntimeGoal = {
        ...snap.runtime,
        status: "paused",
        loop: { ...snap.runtime.loop, enabled: false },
        revision: snap.revisions.goal + 1,
        updatedAt: ctx.now,
      };
      const revision = appendGoalSetEvent(ctx, snap.goalId, nextRuntime, snap.revisions.goal);
      writeRuntimeOverlay(snap.goalId, nextRuntime, snap.delegations);
      const receipt = commitReceipt(ctx);
      notifyStatusChanged(snap.goalId, previousStatus, "paused", revision, ctx.now);
      return { ok: true, status: "applied", receipt, result: { goal: nextRuntime, previousStatus } };
    });
  }

  function resumeGoal(reason: string, cas: GoalMutationGuardInput | undefined, extraTurns?: number, selector?: GoalSelector): GoalEngineOutcome<ResumeGoalResult> {
    const payload = compactRecord({ ...selectorKeys(selector), resume_reason: reason, additional_turns: extraTurns });
    return run("resume_goal", payload, cas, (ctx) => {
      const target = resolveTargetGoal(ctx.index, selector);
      if (target.error) return target.error;
      const snap = target.snapshot!;
      if (ctx.replayed) {
        return replayedOk({ goal: snap.runtime, previousStatus: snap.runtime.status }, ctx.replayReceipt!);
      }
      const casError = requireRootCas(ctx, snap);
      if (casError) return casError;
      if (!RESUMABLE_GOAL_STATUSES.has(snap.runtime.status)) {
        return engineErr("goal_status_invalid", `only paused, blocked, oracle_failed, or budget_limited goals can resume; current status is ${snap.runtime.status}`, "after_context_change");
      }
      const trimmedReason = typeof reason === "string" ? reason.trim() : "";
      if (trimmedReason.length === 0) {
        return engineErr("reason_required", "a non-empty resume reason is required", "fix_input");
      }
      const resumed = resumeRuntimeGoal(snap.runtime, trimmedReason, { now: ctx.now, ...(extraTurns !== undefined ? { extraTurns } : {}) });
      if (!resumed) {
        return engineErr("goal_status_invalid", "the goal cannot resume from its current status", "after_context_change");
      }
      const nextRuntime: RuntimeGoal = { ...resumed.goal, revision: snap.revisions.goal + 1 };
      const revision = appendGoalSetEvent(ctx, snap.goalId, nextRuntime, snap.revisions.goal);
      writeRuntimeOverlay(snap.goalId, nextRuntime, snap.delegations);
      const receipt = commitReceipt(ctx);
      notifyStatusChanged(snap.goalId, snap.runtime.status, "active", revision, ctx.now);
      hooks.queueContinuation?.({ goalId: snap.goalId, revision, objective: nextRuntime.objective, at: ctx.now });
      return {
        ok: true,
        status: "applied",
        receipt,
        result: {
          goal: nextRuntime,
          previousStatus: resumed.previousStatus,
          ...(resumed.additionalTurns !== undefined ? { additionalTurns: resumed.additionalTurns } : {}),
        },
      };
    });
  }

  function clearGoal(cas: GoalMutationGuardInput | undefined, selector?: GoalSelector): GoalEngineOutcome<ClearGoalResult> {
    return run("update_goal", { clear: true, ...selectorKeys(selector) }, cas, (ctx) => {
      const current = findCurrentGoal(ctx.index, selector);
      if (ctx.replayed) {
        return replayedOk({ clearedGoalId: current.snapshot?.goalId ?? "" }, ctx.replayReceipt!);
      }
      if (current.error) return current.error;
      const snap = current.snapshot!;
      const casError = requireRootCas(ctx, snap);
      if (casError) return casError;
      const revision = appendGoalClearEvent(ctx, snap.goalId, snap.revisions.goal);
      rmSync(overlayPath(snap.goalId), { force: true });
      const receipt = commitReceipt(ctx);
      notifyStatusChanged(snap.goalId, snap.runtime.status, undefined, revision, ctx.now);
      return { ok: true, status: "applied", receipt, result: { clearedGoalId: snap.goalId } };
    });
  }

  return {
    createGoal,
    getGoal,
    getGoalsOverview,
    addTodos,
    updateTodoMetadata,
    resolveTodo,
    linkDelegation,
    returnClaim,
    recordClaimValidation,
    proposeCompletion,
    recordOracleDecision,
    completeGoal,
    pauseGoal,
    resumeGoal,
    clearGoal,
  };
}
