// src/core/completion.ts — Phase 2c pure completion diagnostics.
//
// Distilled (read-only) from zob-harness:
//   - .pi/extensions/zob-harness/src/domains/goal/goal-todos/formatting.ts
//     (goalTodoCompletionBlockers / goalTodoCompletionDiagnostics /
//      formatGoalTodoDiagnostics)
//   - .pi/extensions/zob-harness/src/domains/goal/goal-todos/normalize.ts
//     (requireEvidenceForCritical default true)
//
// Adapted to the pure pi-goals node shape: delegation/claim/validation side
// tables land in later phases, so zob's delegated-claim-acceptance and
// skip-reason rules are intentionally absent here (the claim rules return
// with the Phase 2d claims side table; skip reasons are recorded by the 2b
// transition effects and persisted by the store). reviewNoShip is not a node
// field: the caller injects the flagged node ids from its side state.
//
// Rework decisions ("en mieux", deliberate deviations documented for review):
//   D-E1 an EMPTY tree is not completion-ready: completionReady=false and
//      effectiveNoShip=true (zob returned vacuous readiness for goals with
//      zero TODOs). The invariant completionReady === !effectiveNoShip is
//      preserved; "nothing to ship" simply counts as not shippable — and
//      (GAP-4 fix) surfaces as an EXPLICIT synthetic blocker line
//      "todo tree is empty" so empty-tree rejections never list zero
//      blockers.
//   D-E2 blockers are a STRUCTURED inventory ({todoId, path, title, status,
//      reason}) instead of zob's flat string list; formatGoalTodoBlockers
//      renders the zob-style text lines for later tool output.
//   D-E3 graph validation issues surface as blockers with their validation
//      message as the reason, so structural corruption is no-ship evidence
//      exactly like an open required TODO.
//
// Purity contract: no filesystem, OS, environment, clock, or crypto access.
// Policies and review flags arrive as injected options.

import { OPEN_REQUIRED_STATUSES, validateGoalTodoGraph } from "./tree.js";
import type { TreePolicy } from "./tree.js";
import type { GoalTodoNode, GoalTodoStatus } from "./types.js";

export interface GoalTodoCompletionOptions {
  /** Graph validation bounds (depth/fanout); defaults to the zob caps. */
  policy?: TreePolicy;
  /**
   * Node ids flagged review_no_ship by the caller's side state (zob stored
   * the flag on the node; pi-goals keeps nodes clean and injects flags).
   */
  reviewNoShipIds?: readonly string[];
  /** Mirror of zob requireEvidenceForCritical; defaults to true. */
  requireEvidenceForCritical?: boolean;
}

/** One structured no-ship reason attached to a concrete TODO node. */
export interface GoalTodoCompletionBlocker {
  readonly todoId: string;
  readonly path: string;
  readonly title: string;
  readonly status: GoalTodoStatus;
  readonly reason: string;
}

export interface GoalTodoCompletionDiagnostics {
  readonly total: number;
  /** Required TODOs currently in an open status. */
  readonly requiredOpen: number;
  /**
   * True only when the tree has nodes, no blocker exists, and no review
   * no-ship flag is set (required-vs-optional semantics: open OPTIONAL
   * TODOs never block).
   */
  readonly completionReady: boolean;
  /** True when the blocker inventory is non-empty (e.g. blocked required). */
  readonly hardNoShip: boolean;
  /** True when an injected reviewNoShip id matches a node. */
  readonly reviewNoShip: boolean;
  /** hardNoShip || reviewNoShip || empty tree (D-E1). */
  readonly effectiveNoShip: boolean;
  readonly blockers: readonly GoalTodoCompletionBlocker[];
}

function blockerFor(node: GoalTodoNode, reason: string): GoalTodoCompletionBlocker {
  return { todoId: node.id, path: node.path, title: node.title, status: node.status, reason };
}

function hasEvidence(node: GoalTodoNode): boolean {
  return (node.evidenceRefs?.length ?? 0) > 0 || (node.validationCommands?.length ?? 0) > 0;
}

/** zob evidence rule: critical priority, factory, or orchestration owners. */
function evidenceRequired(node: GoalTodoNode, requireEvidenceForCritical: boolean): boolean {
  return requireEvidenceForCritical && (node.priority === "critical" || node.owner === "factory" || node.owner === "orchestration");
}

/**
 * Mirror of zob goalTodoCompletionDiagnostics over a pure node array:
 *
 *   - a REQUIRED TODO in any open status (planned, ready, in_progress,
 *     delegated, claim_returned, needs_review, needs_oracle, needs_user,
 *     blocked) blocks; optional TODOs may stay open
 *   - a done TODO with open REQUIRED children blocks (nested gating)
 *   - done-or-skipped critical/factory/orchestration nodes need evidence
 *     (evidenceRefs or validationCommands) when requireEvidenceForCritical
 *   - graph validation issues (duplicates, missing parents, cycles, depth,
 *     fanout) block with their validation message
 *
 * hardNoShip = blockers exist; reviewNoShip = injected flags; effectiveNoShip
 * = hard || review || empty tree; completionReady === !effectiveNoShip.
 */
export function evaluateGoalTodoCompletion(
  nodes: readonly GoalTodoNode[],
  options: GoalTodoCompletionOptions = {},
): GoalTodoCompletionDiagnostics {
  const requireEvidence = options.requireEvidenceForCritical !== false;
  const reviewIds = new Set(options.reviewNoShipIds ?? []);
  const byId = new Map<string, GoalTodoNode>();
  for (const node of nodes) {
    if (!byId.has(node.id)) byId.set(node.id, node);
  }

  const blockers: GoalTodoCompletionBlocker[] = [];
  let requiredOpen = 0;

  for (const node of nodes) {
    if (node.required && OPEN_REQUIRED_STATUSES.has(node.status)) {
      requiredOpen += 1;
      blockers.push(blockerFor(node, `is required and ${node.status}`));
    }
    if (node.status === "done") {
      const hasOpenRequiredChild = nodes.some(
        (candidate) => (candidate.parentId ?? undefined) === node.id && candidate.required && OPEN_REQUIRED_STATUSES.has(candidate.status),
      );
      if (hasOpenRequiredChild) {
        blockers.push(blockerFor(node, "is done but has open required child TODOs"));
      }
    }
    if ((node.status === "done" || node.status === "skipped") && evidenceRequired(node, requireEvidence) && !hasEvidence(node)) {
      blockers.push(blockerFor(node, `is ${node.status} without evidence`));
    }
  }

  for (const issue of validateGoalTodoGraph(nodes, options.policy)) {
    const node = byId.get(issue.todoId);
    blockers.push({
      todoId: issue.todoId,
      path: issue.path,
      title: node?.title ?? "",
      status: node?.status ?? "planned",
      reason: issue.message,
    });
  }

  const reviewNoShip = nodes.some((node) => reviewIds.has(node.id));
  const empty = nodes.length === 0;
  // GAP-4 fix: an empty tree is its own explicit, path-less blocker.
  if (empty) {
    blockers.push({ todoId: "", path: "", title: "", status: "planned", reason: "todo tree is empty" });
  }
  const hardNoShip = blockers.length > 0;
  const effectiveNoShip = hardNoShip || reviewNoShip;

  return {
    total: nodes.length,
    requiredOpen,
    completionReady: !effectiveNoShip,
    hardNoShip,
    reviewNoShip,
    effectiveNoShip,
    blockers,
  };
}

/**
 * Render the blocker inventory as zob-style text lines for later tool output:
 * `todo <path> '<title>' <reason>` per blocker; empty array when clean.
 * Path-less synthetic blockers (the empty tree, GAP-4) render as their bare
 * reason — no `todo '' ` empty-title prefix (batch-#2 cosmetic fix).
 */
export function formatGoalTodoBlockers(diagnostics: GoalTodoCompletionDiagnostics): string[] {
  return diagnostics.blockers.map((blocker) => (blocker.path === "" ? blocker.reason : `todo ${blocker.path} '${blocker.title}' ${blocker.reason}`));
}
