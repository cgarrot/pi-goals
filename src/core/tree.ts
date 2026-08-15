// src/core/tree.ts — Phase 2c pure goal-TODO tree operations.
//
// Distilled (read-only) from zob-harness:
//   - .pi/extensions/zob-harness/src/domains/goal/goal-todos/operations.ts
//     (addGoalTodo path/depth/fanout logic, add_goal_todos batch
//     pre-validation, splitGoalTodo child inheritance, renumber/validate
//     graph checks — persistence shell stripped)
//   - .pi/extensions/zob-harness/src/runtime/goal-runtime/tools.ts
//     (add_goal_todos atomic batch semantics)
//   - .pi/extensions/zob-harness/src/domains/goal/goal-todos/formatting.ts
//     (summarizeGoalTodos counting + next-agent/next-user selection)
//   - .pi/extensions/zob-harness/src/domains/goal/goal-todos/constants.ts
//     (OPEN_REQUIRED_STATUSES / ACTIVE_STATUSES / ACTIONABLE_STATUSES)
//   - .pi/extensions/zob-harness/src/domains/goal/goal-todos/normalize.ts
//     (defaultGoalTodoPolicy caps: maxTodoDepth 6, maxChildrenPerTodo 8,
//     maxOpenTodos 80)
//
// Rework decisions ("en mieux", deliberate deviations documented for review):
//   D-T1 batch adds apply sequentially against the evolving working tree,
//      then fail atomically (zob pre-validated against the pre-batch state
//      and appended per item; identical observable outcome, and a failing
//      item can never leak partial adds because the working array is
//      discarded on error).
//   D-T2 maxFanout applies uniformly at every level INCLUDING root siblings
//      (zob left root-level breadth uncapped, relying on maxOpenTodos;
//      pi-goals keeps breadth bounded by construction).
//   D-T3 status is NOT a metadata-patchable field: updateGoalTodoNodeMetadata
//      hard-rejects it and reopenGoalTodoNode is the only status-changing op
//      in this module, delegating to the Phase 2b transition engine.
//   D-T4 split does not re-authorize the parent's status (zob additionally
//      authorized a "start" transition); split is a graph-shape operation
//      here and status authorization belongs to the transition surface.
//   D-T5 node depth is derived from the parent chain (GoalTodoNode carries
//      no stored depth field — Phase 2a stripped zob's denormalized depth),
//      and visible paths derive from 1-based sibling insertion positions.
//   D-T6 id generation retries a few times on collision with an existing id
//      before failing (ids come from the injected random source; a frozen
//      deterministic source that keeps colliding fails with id_collision).
//
// Purity contract: no filesystem, OS, environment, clock, or crypto access.
// Policies arrive as an injected TreePolicy with safe zob-derived defaults
// (src/shared/config.ts is intentionally NOT imported — it reads files);
// randomness arrives as an injected GoalTodoRandomBytes source; time arrives
// as an injected `now`. Every operation returns NEW immutable structures and
// never mutates its inputs: Result<TreeOpError, { nodes, changed }>.

import { generateGoalTodoId, parseGoalTodoPath } from "./ids.js";
import type { GoalTodoRandomBytes } from "./ids.js";
import { GOAL_TODO_STATUSES } from "./types.js";
import type { GoalTodoNode, GoalTodoOwner, GoalTodoPriority, GoalTodoStatus, Result } from "./types.js";
import { applyGoalTodoTransition } from "./transition.js";
import type { GoalTodoRejectionCode, GoalTodoRetryPolicy } from "./transition.js";

// ---------------------------------------------------------------------------
// Status vocabulary (zob goal-todos/constants.ts mirror)
// ---------------------------------------------------------------------------

/** Statuses that keep a required TODO from counting as closed (zob mirror). */
export const OPEN_REQUIRED_STATUSES: ReadonlySet<GoalTodoStatus> = new Set([
  "planned",
  "ready",
  "in_progress",
  "delegated",
  "claim_returned",
  "needs_review",
  "needs_oracle",
  "needs_user",
  "blocked",
]);

/** Statuses counted as active work (zob mirror). */
export const ACTIVE_STATUSES: ReadonlySet<GoalTodoStatus> = new Set([
  "ready",
  "in_progress",
  "delegated",
  "claim_returned",
  "needs_review",
]);

/** Statuses a user/agent can still act on (zob mirror). */
export const ACTIONABLE_STATUSES: ReadonlySet<GoalTodoStatus> = new Set([
  "planned",
  "ready",
  "in_progress",
  "needs_review",
  "needs_user",
  "needs_oracle",
  "blocked",
]);

// ---------------------------------------------------------------------------
// Tree policy
// ---------------------------------------------------------------------------

/** Bounds for tree shape; mirrors zob maxTodoDepth/maxChildrenPerTodo/maxOpenTodos. */
export interface TreePolicy {
  /** Maximum root-to-leaf chain length (root nodes are depth 1). */
  maxDepth: number;
  /** Maximum children per parent — applied uniformly, root level included (D-T2). */
  maxFanout: number;
  /** Maximum items accepted by one batch add. */
  maxBatch: number;
}

/** zob defaultGoalTodoPolicy caps: 6 / 8 / 80. */
export const DEFAULT_TREE_POLICY: Readonly<TreePolicy> = Object.freeze({ maxDepth: 6, maxFanout: 8, maxBatch: 80 });

function safePositiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** Fill a partial policy with safe zob-derived defaults; invalid values fall back. */
export function normalizeTreePolicy(policy?: Partial<TreePolicy>): TreePolicy {
  const source = policy ?? {};
  return {
    maxDepth: safePositiveInt(source.maxDepth, DEFAULT_TREE_POLICY.maxDepth),
    maxFanout: safePositiveInt(source.maxFanout, DEFAULT_TREE_POLICY.maxFanout),
    maxBatch: safePositiveInt(source.maxBatch, DEFAULT_TREE_POLICY.maxBatch),
  };
}

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export type TreeOpErrorCode =
  | "invalid_title"
  | "empty_batch"
  | "batch_too_large"
  | "parent_not_found"
  | "todo_not_found"
  | "depth_exceeded"
  | "fanout_exceeded"
  | "split_titles_required"
  | "status_change_forbidden"
  | "field_not_patchable"
  | "id_collision"
  | "transition_rejected";

export interface TreeOpError {
  readonly code: TreeOpErrorCode;
  readonly message: string;
  /** Phase 2b rejection detail when code is transition_rejected. */
  readonly transition?: { readonly code: GoalTodoRejectionCode; readonly retryPolicy: GoalTodoRetryPolicy };
}

export interface TreeOpSuccess {
  /** The full NEW node array; unchanged no-ops return the input reference. */
  readonly nodes: readonly GoalTodoNode[];
  /** False only for verified no-op metadata patches. */
  readonly changed: boolean;
  /** Nodes created by add/split ops, in creation order. */
  readonly created?: readonly GoalTodoNode[];
  /** The single node updated by update/reopen ops. */
  readonly updated?: GoalTodoNode;
}

export type TreeOpResult = Result<TreeOpSuccess, TreeOpError>;

function fail(code: TreeOpErrorCode, message: string, extra?: { todoId?: string; transition?: TreeOpError["transition"] }): { ok: false; error: TreeOpError } {
  return { ok: false, error: { code, message, ...(extra?.todoId ? { todoId: extra.todoId } : {}), ...(extra?.transition ? { transition: extra.transition } : {}) } };
}

// ---------------------------------------------------------------------------
// Internal graph helpers
// ---------------------------------------------------------------------------

function byIdMap(nodes: readonly GoalTodoNode[]): Map<string, GoalTodoNode> {
  const map = new Map<string, GoalTodoNode>();
  for (const node of nodes) {
    if (!map.has(node.id)) map.set(node.id, node);
  }
  return map;
}

function childrenOf(nodes: readonly GoalTodoNode[], parentId: string | undefined): GoalTodoNode[] {
  return nodes.filter((node) => (node.parentId ?? undefined) === parentId);
}

/** Depth via the parent chain (root = 1); cycle- and orphan-safe. */
function chainDepth(node: GoalTodoNode, byId: Map<string, GoalTodoNode>): number {
  let depth = 1;
  let cursor: GoalTodoNode | undefined = node;
  const seen = new Set<string>([node.id]);
  while (cursor?.parentId && !seen.has(cursor.parentId)) {
    const parent: GoalTodoNode | undefined = byId.get(cursor.parentId);
    if (!parent) break;
    seen.add(parent.id);
    depth += 1;
    cursor = parent;
  }
  return depth;
}

function freshId(randomBytes: GoalTodoRandomBytes, taken: ReadonlySet<string>): string | undefined {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = generateGoalTodoId(randomBytes);
    if (!taken.has(id)) return id;
  }
  return undefined;
}

function copyStrings(values: readonly string[] | undefined): string[] {
  return values === undefined ? [] : [...values];
}

// ---------------------------------------------------------------------------
// add — single
// ---------------------------------------------------------------------------

export interface AddGoalTodoNodeInput {
  title: string;
  status?: GoalTodoStatus;
  owner?: GoalTodoOwner;
  /** zob semantics: required !== false → true. */
  required?: boolean;
  priority?: GoalTodoPriority;
  acceptanceCriteria?: string[];
  evidenceRefs?: string[];
  validationCommands?: string[];
}

export interface AddGoalTodoNodeOptions {
  parentId?: string;
  input: AddGoalTodoNodeInput;
  policy?: TreePolicy;
  randomBytes: GoalTodoRandomBytes;
  now: number;
}

function buildAddedNode(
  nodes: readonly GoalTodoNode[],
  parentId: string | undefined,
  input: AddGoalTodoNodeInput,
  policy: TreePolicy,
  randomBytes: GoalTodoRandomBytes,
  now: number,
): TreeOpResult {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (title.length === 0) {
    return fail("invalid_title", "Goal TODO title is required and must be non-empty after trimming");
  }

  const byId = byIdMap(nodes);
  const parent = parentId !== undefined ? byId.get(parentId) : undefined;
  if (parentId !== undefined && !parent) {
    return fail("parent_not_found", `Parent TODO not found: ${parentId}`, { todoId: parentId });
  }

  const depth = parent ? chainDepth(parent, byId) + 1 : 1;
  if (depth > policy.maxDepth) {
    return fail("depth_exceeded", `Goal TODO depth exceeds maxDepth=${policy.maxDepth}`);
  }

  const siblingCount = childrenOf(nodes, parentId).length;
  if (siblingCount + 1 > policy.maxFanout) {
    return fail(
      "fanout_exceeded",
      `Goal TODO fanout exceeds maxFanout=${policy.maxFanout} under parent ${parentId ?? "<root>"}`,
      ...(parentId ? [{ todoId: parentId }] : []),
    );
  }

  const id = freshId(randomBytes, new Set(byId.keys()));
  if (id === undefined) {
    return fail("id_collision", "Goal TODO id generation collided with existing ids; provide a varying random source");
  }

  // visible path = 1-based position among siblings in stable insertion order
  const path = parent ? `${parent.path}.${siblingCount + 1}` : String(siblingCount + 1);
  const node: GoalTodoNode = Object.freeze({
    id,
    parentId,
    path,
    title,
    status: input.status ?? "planned",
    owner: input.owner ?? "agent",
    required: input.required !== false,
    priority: input.priority ?? "normal",
    acceptanceCriteria: copyStrings(input.acceptanceCriteria),
    evidenceRefs: copyStrings(input.evidenceRefs),
    validationCommands: copyStrings(input.validationCommands),
    createdAt: now,
    updatedAt: now,
  });
  return { ok: true, value: { nodes: [...nodes, node], changed: true, created: [node] } };
}

/**
 * Add one TODO node. Enforces depth <= policy.maxDepth and sibling count
 * <= policy.maxFanout (root level included, D-T2); ids come from the
 * injected random source, timestamps from the injected clock.
 */
export function addGoalTodoNode(nodes: readonly GoalTodoNode[], options: AddGoalTodoNodeOptions): TreeOpResult {
  return buildAddedNode(nodes, options.parentId, options.input, normalizeTreePolicy(options.policy), options.randomBytes, options.now);
}

// ---------------------------------------------------------------------------
// add — atomic batch (zob add_goal_todos semantics)
// ---------------------------------------------------------------------------

export interface AddGoalTodoNodeItem {
  parentId?: string;
  input: AddGoalTodoNodeInput;
}

export interface AddGoalTodoNodesOptions {
  items: readonly AddGoalTodoNodeItem[];
  policy?: TreePolicy;
  randomBytes: GoalTodoRandomBytes;
  now: number;
}

/**
 * Add multiple TODO nodes in one atomic operation: items apply sequentially
 * (so paths continue each parent's numbering in input order) and ANY failure
 * fails the whole batch, leaving the caller's nodes untouched (D-T1).
 */
export function addGoalTodoNodes(nodes: readonly GoalTodoNode[], options: AddGoalTodoNodesOptions): TreeOpResult {
  const policy = normalizeTreePolicy(options.policy);
  if (options.items.length === 0) {
    return fail("empty_batch", "Goal TODO batch must contain at least one item");
  }
  if (options.items.length > policy.maxBatch) {
    return fail("batch_too_large", `Goal TODO batch exceeds maxBatch=${policy.maxBatch}`);
  }

  let working: readonly GoalTodoNode[] = nodes;
  const created: GoalTodoNode[] = [];
  for (const item of options.items) {
    const step = buildAddedNode(working, item.parentId, item.input, policy, options.randomBytes, options.now);
    if (!step.ok) return step;
    working = step.value.nodes;
    created.push(...step.value.created!);
  }
  return { ok: true, value: { nodes: working, changed: true, created } };
}

// ---------------------------------------------------------------------------
// update — metadata only, status forbidden (D-T3)
// ---------------------------------------------------------------------------

export interface GoalTodoNodeMetadataPatch {
  title?: string;
  priority?: GoalTodoPriority;
  owner?: GoalTodoOwner;
  required?: boolean;
  acceptanceCriteria?: string[];
  evidenceRefs?: string[];
  validationCommands?: string[];
}

const IDENTITY_FIELDS: readonly string[] = ["id", "path", "parentId", "createdAt", "updatedAt"];

function arraysEqual(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  const a = left ?? [];
  const b = right ?? [];
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Patch title/priority/owner/required/acceptanceCriteria/evidenceRefs/
 * validationCommands. NEVER status — that belongs to the Phase 2b transition
 * engine (reopenGoalTodoNode is this module's only status-changing op).
 * Verified no-op patches return changed=false with the input array reference.
 */
export function updateGoalTodoNodeMetadata(
  nodes: readonly GoalTodoNode[],
  id: string,
  patch: GoalTodoNodeMetadataPatch,
  options: { now: number },
): TreeOpResult {
  const index = nodes.findIndex((node) => node.id === id);
  if (index === -1) {
    return fail("todo_not_found", `Goal TODO not found: ${id}`, { todoId: id });
  }

  const requested = patch as Record<string, unknown>;
  if ("status" in requested && requested.status !== undefined) {
    return fail(
      "status_change_forbidden",
      "status is owned by the Phase 2b transition engine; use reopen/resolve transitions instead of a metadata patch",
      { todoId: id },
    );
  }
  for (const field of IDENTITY_FIELDS) {
    if (field in requested && requested[field] !== undefined) {
      return fail("field_not_patchable", `Goal TODO field ${field} is identity and cannot be patched`, { todoId: id });
    }
  }

  const existing = nodes[index]!;
  const nextTitle = patch.title !== undefined ? patch.title.trim() : existing.title;
  if (nextTitle.length === 0) {
    return fail("invalid_title", "Goal TODO title is required and must be non-empty after trimming", { todoId: id });
  }

  const nextPriority = patch.priority ?? existing.priority;
  const nextOwner = patch.owner ?? existing.owner;
  const nextRequired = patch.required ?? existing.required;
  const nextAcceptance = patch.acceptanceCriteria ?? existing.acceptanceCriteria;
  const nextEvidence = patch.evidenceRefs ?? existing.evidenceRefs;
  const nextCommands = patch.validationCommands ?? existing.validationCommands;

  const changed = nextTitle !== existing.title
    || nextPriority !== existing.priority
    || nextOwner !== existing.owner
    || nextRequired !== existing.required
    || !arraysEqual(nextAcceptance, existing.acceptanceCriteria)
    || !arraysEqual(nextEvidence, existing.evidenceRefs)
    || !arraysEqual(nextCommands, existing.validationCommands);
  if (!changed) {
    return { ok: true, value: { nodes, changed: false } };
  }

  const updated: GoalTodoNode = Object.freeze({
    ...existing,
    title: nextTitle,
    priority: nextPriority,
    owner: nextOwner,
    required: nextRequired,
    acceptanceCriteria: copyStrings(nextAcceptance),
    evidenceRefs: copyStrings(nextEvidence),
    validationCommands: copyStrings(nextCommands),
    updatedAt: options.now,
  });
  const next = [...nodes];
  next[index] = updated;
  return { ok: true, value: { nodes: next, changed: true, updated } };
}

// ---------------------------------------------------------------------------
// split — subtodos appended after existing siblings
// ---------------------------------------------------------------------------

export interface SplitGoalTodoNodeOptions {
  policy?: TreePolicy;
  randomBytes: GoalTodoRandomBytes;
  now: number;
}

/**
 * Split one TODO into subtodos: titles are trimmed, blanks dropped, and the
 * children are APPENDED after any existing siblings (paths continue the
 * parent's numbering). Children inherit zob split defaults: required=true,
 * priority from the parent, owner=agent, status=planned. Bounded by
 * maxFanout (existing + new) and maxDepth (parent depth + 1). D-T4: the
 * parent's status is not re-authorized here.
 */
export function splitGoalTodoNode(
  nodes: readonly GoalTodoNode[],
  id: string,
  titles: readonly string[],
  options: SplitGoalTodoNodeOptions,
): TreeOpResult {
  const policy = normalizeTreePolicy(options.policy);
  const parent = nodes.find((node) => node.id === id);
  if (!parent) {
    return fail("todo_not_found", `Parent TODO not found: ${id}`, { todoId: id });
  }

  const cleanTitles = titles
    .map((title) => (typeof title === "string" ? title.trim() : ""))
    .filter((title) => title.length > 0);
  if (cleanTitles.length === 0) {
    return fail("split_titles_required", "split requires at least one non-blank child title", { todoId: id });
  }

  const existingChildren = childrenOf(nodes, id).length;
  if (existingChildren + cleanTitles.length > policy.maxFanout) {
    return fail("fanout_exceeded", `split would exceed maxFanout=${policy.maxFanout} for parent ${id}`, { todoId: id });
  }

  const byId = byIdMap(nodes);
  const childDepth = chainDepth(parent, byId) + 1;
  if (childDepth > policy.maxDepth) {
    return fail("depth_exceeded", `split children would exceed maxDepth=${policy.maxDepth}`, { todoId: id });
  }

  let working: readonly GoalTodoNode[] = nodes;
  const created: GoalTodoNode[] = [];
  for (const title of cleanTitles) {
    const step = buildAddedNode(working, id, { title, required: true, priority: parent.priority, owner: "agent" }, policy, options.randomBytes, options.now);
    if (!step.ok) return step;
    working = step.value.nodes;
    created.push(...step.value.created!);
  }
  return { ok: true, value: { nodes: working, changed: true, created } };
}

// ---------------------------------------------------------------------------
// reopen — Phase 2b transition engine integration, stable paths
// ---------------------------------------------------------------------------

export interface ReopenGoalTodoNodeOptions {
  reason: string;
  now: number;
}

/**
 * Integration hook: authorize+apply the reopen through the Phase 2b
 * transition engine, then swap only status/updatedAt. Paths and every other
 * field stay stable. Rejections surface as transition_rejected with the
 * engine's code and retry policy.
 */
export function reopenGoalTodoNode(
  nodes: readonly GoalTodoNode[],
  id: string,
  options: ReopenGoalTodoNodeOptions,
): TreeOpResult {
  const index = nodes.findIndex((node) => node.id === id);
  if (index === -1) {
    return fail("todo_not_found", `Goal TODO not found: ${id}`, { todoId: id });
  }
  const existing = nodes[index]!;
  const applied = applyGoalTodoTransition({ status: existing.status, required: existing.required }, "reopen", { reason: options.reason });
  if (!applied.ok) {
    return fail("transition_rejected", applied.message, {
      todoId: id,
      transition: { code: applied.code, retryPolicy: applied.retryPolicy },
    });
  }
  const updated: GoalTodoNode = Object.freeze({
    ...existing,
    status: applied.nextStatus,
    updatedAt: options.now,
  });
  const next = [...nodes];
  next[index] = updated;
  return { ok: true, value: { nodes: next, changed: true, updated } };
}

// ---------------------------------------------------------------------------
// summary — zob-compatible counts
// ---------------------------------------------------------------------------

export interface GoalTodoSummaryNodeRef {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly status: GoalTodoStatus;
  readonly owner: GoalTodoOwner;
  readonly priority: GoalTodoPriority;
  readonly required: boolean;
}

export interface GoalTodoSummary {
  readonly total: number;
  readonly required: number;
  readonly done: number;
  readonly skipped: number;
  /** Open = status in OPEN_REQUIRED_STATUSES (zob counts by status, not required flag). */
  readonly open: number;
  readonly perStatus: Readonly<Record<GoalTodoStatus, number>>;
  readonly active: number;
  readonly inProgress: number;
  readonly delegated: number;
  readonly claimReturned: number;
  readonly blocked: readonly GoalTodoSummaryNodeRef[];
  readonly nextActionableTodo?: GoalTodoSummaryNodeRef;
  readonly maxDepth: number;
  /** Closed fraction: (done + skipped) / total; 0 for an empty tree. */
  readonly progress: number;
}

function nodeRef(node: GoalTodoNode): GoalTodoSummaryNodeRef {
  return {
    id: node.id,
    path: node.path,
    title: node.title,
    status: node.status,
    owner: node.owner,
    priority: node.priority,
    required: node.required,
  };
}

/**
 * zob-compatible progress summary: total/required/done/skipped/open counts,
 * per-status counts, active/in_progress/delegated/claim counters, the blocked
 * list, the next actionable TODO (zob nextAgent rule with nextUser fallback),
 * max depth, and the closed fraction.
 */
export function summarizeGoalTodos(nodes: readonly GoalTodoNode[]): GoalTodoSummary {
  const perStatus = Object.fromEntries(GOAL_TODO_STATUSES.map((status) => [status, 0])) as Record<GoalTodoStatus, number>;
  for (const node of nodes) {
    if (node.status in perStatus) perStatus[node.status]! += 1;
  }

  const done = perStatus.done!;
  const skipped = perStatus.skipped!;
  const total = nodes.length;
  const hasOpenChildren = (node: GoalTodoNode): boolean =>
    nodes.some((candidate) => (candidate.parentId ?? undefined) === node.id && OPEN_REQUIRED_STATUSES.has(candidate.status));

  const agentCandidates = nodes.filter(
    (node) => node.owner === "agent" && (node.status === "ready" || node.status === "planned" || node.status === "in_progress"),
  );
  const nextAgent = agentCandidates.find((node) => !hasOpenChildren(node)) ?? agentCandidates[0];
  const userCandidates = nodes.filter(
    (node) => ACTIONABLE_STATUSES.has(node.status) && (node.owner === "user" || node.status === "needs_user"),
  );
  const nextUser = userCandidates.find((node) => !hasOpenChildren(node)) ?? userCandidates[0];
  const nextActionableTodo = nextAgent ?? nextUser;

  let maxDepth = 0;
  for (const node of nodes) {
    const segments = parseGoalTodoPath(node.path)?.length ?? 0;
    if (segments > maxDepth) maxDepth = segments;
  }

  return {
    total,
    required: nodes.filter((node) => node.required).length,
    done,
    skipped,
    open: nodes.filter((node) => OPEN_REQUIRED_STATUSES.has(node.status)).length,
    perStatus,
    active: nodes.filter((node) => ACTIVE_STATUSES.has(node.status)).length,
    inProgress: perStatus.in_progress!,
    delegated: perStatus.delegated!,
    claimReturned: perStatus.claim_returned!,
    blocked: nodes.filter((node) => node.status === "blocked").map(nodeRef),
    ...(nextActionableTodo ? { nextActionableTodo: nodeRef(nextActionableTodo) } : {}),
    maxDepth,
    progress: total === 0 ? 0 : (done + skipped) / total,
  };
}

// ---------------------------------------------------------------------------
// graph validation
// ---------------------------------------------------------------------------

export type GoalTodoGraphIssueCode = "duplicate_id" | "missing_parent" | "parent_cycle" | "depth_exceeded" | "fanout_exceeded";

export interface GoalTodoGraphIssue {
  readonly todoId: string;
  readonly path: string;
  readonly code: GoalTodoGraphIssueCode;
  readonly message: string;
}

/**
 * Pure structural validation over the node array (zob validateGoalTodoGraph,
// adapted to the depth-free node shape): duplicate ids, missing parents,
 * parent-chain cycles, path depth beyond maxDepth, and per-todo fanout
 * beyond maxFanout (root-level breadth is not a per-todo issue, mirroring
 * zob; mutation-time guards still cap it via D-T2).
 */
export function validateGoalTodoGraph(nodes: readonly GoalTodoNode[], policy?: TreePolicy): readonly GoalTodoGraphIssue[] {
  const normalized = normalizeTreePolicy(policy);
  const issues: GoalTodoGraphIssue[] = [];
  const byId = byIdMap(nodes);
  const seen = new Set<string>();

  for (const node of nodes) {
    if (seen.has(node.id)) {
      issues.push({ todoId: node.id, path: node.path, code: "duplicate_id", message: `duplicate todo id: ${node.id}` });
    }
    seen.add(node.id);

    if (node.parentId !== undefined && !byId.has(node.parentId)) {
      issues.push({
        todoId: node.id,
        path: node.path,
        code: "missing_parent",
        message: `todo ${node.id} references missing parent ${node.parentId}`,
      });
    }

    const visited = new Set<string>();
    let cursor: GoalTodoNode | undefined = node;
    while (cursor?.parentId) {
      if (visited.has(cursor.id)) {
        issues.push({ todoId: node.id, path: node.path, code: "parent_cycle", message: `todo cycle detected at ${cursor.id}` });
        break;
      }
      visited.add(cursor.id);
      cursor = byId.get(cursor.parentId);
    }

    const depth = parseGoalTodoPath(node.path)?.length ?? 0;
    if (depth > normalized.maxDepth) {
      issues.push({
        todoId: node.id,
        path: node.path,
        code: "depth_exceeded",
        message: `todo ${node.path} exceeds maxDepth=${normalized.maxDepth}`,
      });
    }
  }

  const childCounts = new Map<string, number>();
  for (const node of nodes) {
    if (node.parentId === undefined) continue;
    childCounts.set(node.parentId, (childCounts.get(node.parentId) ?? 0) + 1);
  }
  for (const [parentId, count] of childCounts) {
    if (count > normalized.maxFanout) {
      const parent = byId.get(parentId)!;
      issues.push({
        todoId: parentId,
        path: parent.path,
        code: "fanout_exceeded",
        message: `todo ${parent.path} exceeds maxFanout=${normalized.maxFanout}`,
      });
    }
  }

  return issues;
}
