// src/core/proposal.ts — Phase 3a strict single-schema goal completion proposal.
//
// Distilled (read-only) from zob-harness:
//   - .pi/extensions/zob-harness/src/runtime/goal-runtime/state.ts
//     (hashRuntimeGoalCompletionProposalArray / canonicalProposalHashFields /
//      hashRuntimeGoalCompletionProposal / buildRuntimeGoalCompletionProposal /
//      isRuntimeGoalCompletionProposalV2 — with every legacyUnbound /
//      malformed-snapshot / v1-raw-array / compatibility-array branch
//      stripped).
//
// Rework decisions ("en mieux", deliberate deviations documented for review):
//   D-P1 single strict v1 schema: zob's proposalVersion 2 becomes 1 here and
//      the whole legacy layer is gone. Validation is a discriminated result
//      {valid:true, proposal} | {valid:false, code, message}; there is no
//      normalize/mutate compatibility path and bodyStored is frozen false.
//   D-P2 purity over defaults: proposedAt is a REQUIRED injected ISO
//      timestamp (zob defaulted to the wall clock, which this module never
//      reads).
//   D-P3 ordered-array hashing is zob parity exactly: caller order and
//      duplicates are preserved (evidence is ordered); dedup happens at the
//      2d claim boundary, never here.
//   D-P4 the strict validator requires the EXACT 17-key set (zob only
//      rejected unknown keys; a strict schema also rejects missing keys).
//   D-P5 hash tampering surfaces as its own exact code: zob folded a
//      proposalHash tamper into malformed_snapshot via its isV2 gate (the
//      explicit proposal_hash_mismatch branch was unreachable there); this
//      validator recomputes last and reports proposal_hash_mismatch
//      precisely so freshness can emit the zob code inventory verbatim.
//
// Purity contract: node:crypto createHash is the ONLY node import; no
// fs/os/env/clock/random — proposedAt arrives as an injected parameter and
// every function returns new frozen data without mutating its input.

import { createHash } from "node:crypto";

export const PROPOSAL_VERSION = 1;

const SHA256_HEX = /^[a-f0-9]{64}$/;

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Exact full 64-character lowercase hex sha256 (no uppercase tolerance). */
export function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX.test(value);
}

export function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSafeIntegerAtLeast(value: unknown, minimum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

export function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

export interface GoalCompletionProposalInput {
  readonly goalId: string;
  readonly goalRevision: number;
  readonly todoGraphRevision: number;
  readonly requirementsChecked: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly validationCommands: readonly string[];
  readonly knownRisks: readonly string[];
  readonly completionSummary: string;
  readonly noShip: boolean;
  /** Injected ISO timestamp (D-P2): the builder never reads the clock. */
  readonly proposedAt: string;
}

export interface GoalCompletionProposal {
  readonly proposalVersion: 1;
  readonly proposalHash: string;
  readonly goalId: string;
  readonly goalRevision: number;
  readonly todoGraphRevision: number;
  readonly requirementsHash: string;
  readonly requirementsCount: number;
  readonly evidenceHash: string;
  readonly evidenceCount: number;
  readonly validationHash: string;
  readonly validationCount: number;
  readonly risksHash: string;
  readonly risksCount: number;
  readonly summaryHash: string;
  readonly noShip: boolean;
  readonly proposedAt: string;
  readonly bodyStored: false;
}

declare const validatedProposalBrand: unique symbol;

/**
 * A proposal that passed validateGoalCompletionProposal. Obtainable only
 * from the validator (type-level brand); builders that need an exact,
 * recompute-verified proposal (the oracle decision) require this type and
 * re-verify at runtime against JS callers.
 */
export type ValidatedGoalCompletionProposal = GoalCompletionProposal & {
  readonly [validatedProposalBrand]: true;
};

/** Ordered-array hashing: caller order and duplicates are preserved (D-P3). */
export function hashProposalArray(values: readonly string[]): string {
  return sha256Hex(JSON.stringify([...values]));
}

/** Body-free proposal shape the canonical hash runs over. */
export type ProposalHashBody = Omit<GoalCompletionProposal, "proposalHash" | "proposedAt">;

/**
 * Canonical proposalHash preimage: EXACTLY the 15 body-free fields —
 * proposalVersion, goalId, goalRevision, todoGraphRevision, requirementsHash,
 * requirementsCount, evidenceHash, evidenceCount, validationHash,
 * validationCount, risksHash, risksCount, summaryHash, noShip, bodyStored —
 * serialized as a fixed-order JSON literal (the input object's key order can
 * never change the hash). proposedAt is intentionally NOT hashed.
 */
function canonicalProposalHashFields(proposal: ProposalHashBody): Record<string, unknown> {
  return {
    proposalVersion: PROPOSAL_VERSION,
    goalId: proposal.goalId,
    goalRevision: proposal.goalRevision,
    todoGraphRevision: proposal.todoGraphRevision,
    requirementsHash: proposal.requirementsHash,
    requirementsCount: proposal.requirementsCount,
    evidenceHash: proposal.evidenceHash,
    evidenceCount: proposal.evidenceCount,
    validationHash: proposal.validationHash,
    validationCount: proposal.validationCount,
    risksHash: proposal.risksHash,
    risksCount: proposal.risksCount,
    summaryHash: proposal.summaryHash,
    noShip: proposal.noShip,
    bodyStored: false as const,
  };
}

export function goalCompletionProposalHash(proposal: ProposalHashBody): string {
  return sha256Hex(JSON.stringify(canonicalProposalHashFields(proposal)));
}

const PROPOSAL_KEYS: readonly string[] = Object.freeze([
  "proposalVersion",
  "proposalHash",
  "goalId",
  "goalRevision",
  "todoGraphRevision",
  "requirementsHash",
  "requirementsCount",
  "evidenceHash",
  "evidenceCount",
  "validationHash",
  "validationCount",
  "risksHash",
  "risksCount",
  "summaryHash",
  "noShip",
  "proposedAt",
  "bodyStored",
]);
const PROPOSAL_KEY_SET = new Set<string>(PROPOSAL_KEYS);
const PROPOSAL_HASH_FIELDS: readonly string[] = Object.freeze([
  "proposalHash",
  "requirementsHash",
  "evidenceHash",
  "validationHash",
  "risksHash",
  "summaryHash",
]);
const PROPOSAL_COUNT_FIELDS: readonly string[] = Object.freeze([
  "requirementsCount",
  "evidenceCount",
  "validationCount",
  "risksCount",
]);

export type GoalCompletionProposalValidationCode =
  | "not_a_record"
  | "missing_fields"
  | "unexpected_fields"
  | "invalid_proposal_version"
  | "invalid_goal_id"
  | "invalid_goal_revision"
  | "invalid_todo_graph_revision"
  | "invalid_hash"
  | "invalid_count"
  | "invalid_no_ship"
  | "invalid_proposed_at"
  | "invalid_body_stored"
  | "proposal_hash_mismatch";

export type GoalCompletionProposalValidation =
  | { readonly valid: true; readonly proposal: ValidatedGoalCompletionProposal }
  | { readonly valid: false; readonly code: GoalCompletionProposalValidationCode; readonly message: string };

function proposalInvalid(code: GoalCompletionProposalValidationCode, message: string): GoalCompletionProposalValidation {
  return { valid: false, code, message };
}

/**
 * Strict single-schema validator: exact 17-key record, proposalVersion 1,
 * bodyStored false, exact full sha256 fields, safe-integer revisions
 * (goalRevision >= 1, todoGraphRevision >= 0, counts >= 0), boolean noShip,
 * parseable ISO proposedAt, and a proposalHash recompute as the final gate
 * (D-P5). Returns a frozen canonical clone on success.
 */
export function validateGoalCompletionProposal(value: unknown): GoalCompletionProposalValidation {
  if (!isRecordValue(value)) return proposalInvalid("not_a_record", "completion proposal must be a plain object");
  const missing = PROPOSAL_KEYS.filter((key) => !(key in value));
  if (missing.length > 0) return proposalInvalid("missing_fields", `missing fields: ${missing.join(", ")}`);
  const unexpected = Object.keys(value).filter((key) => !PROPOSAL_KEY_SET.has(key));
  if (unexpected.length > 0) return proposalInvalid("unexpected_fields", `unexpected fields: ${unexpected.join(", ")}`);
  if (value.proposalVersion !== PROPOSAL_VERSION) return proposalInvalid("invalid_proposal_version", "proposalVersion must be exactly 1");
  if (typeof value.goalId !== "string" || value.goalId.trim().length === 0) return proposalInvalid("invalid_goal_id", "goalId must be a non-empty string");
  if (!isSafeIntegerAtLeast(value.goalRevision, 1)) return proposalInvalid("invalid_goal_revision", "goalRevision must be a safe integer >= 1");
  if (!isSafeIntegerAtLeast(value.todoGraphRevision, 0)) return proposalInvalid("invalid_todo_graph_revision", "todoGraphRevision must be a safe integer >= 0");
  for (const key of PROPOSAL_HASH_FIELDS) {
    if (!isSha256Hex(value[key])) return proposalInvalid("invalid_hash", `${key} must be an exact full 64-character lowercase hex sha256`);
  }
  for (const key of PROPOSAL_COUNT_FIELDS) {
    if (!isSafeIntegerAtLeast(value[key], 0)) return proposalInvalid("invalid_count", `${key} must be a safe integer >= 0`);
  }
  if (typeof value.noShip !== "boolean") return proposalInvalid("invalid_no_ship", "noShip must be a boolean");
  if (!isIsoTimestamp(value.proposedAt)) return proposalInvalid("invalid_proposed_at", "proposedAt must be a parseable ISO timestamp");
  if (value.bodyStored !== false) return proposalInvalid("invalid_body_stored", "bodyStored must be exactly false");
  const canonical: ProposalHashBody = {
    proposalVersion: PROPOSAL_VERSION,
    goalId: value.goalId,
    goalRevision: value.goalRevision,
    todoGraphRevision: value.todoGraphRevision,
    requirementsHash: value.requirementsHash as string,
    requirementsCount: value.requirementsCount as number,
    evidenceHash: value.evidenceHash as string,
    evidenceCount: value.evidenceCount as number,
    validationHash: value.validationHash as string,
    validationCount: value.validationCount as number,
    risksHash: value.risksHash as string,
    risksCount: value.risksCount as number,
    summaryHash: value.summaryHash as string,
    noShip: value.noShip,
    bodyStored: false,
  };
  const expected = goalCompletionProposalHash(canonical);
  if (value.proposalHash !== expected) {
    return proposalInvalid("proposal_hash_mismatch", "proposalHash does not match the canonical recompute over the 15 body-free fields");
  }
  const proposal = Object.freeze({ ...canonical, proposalHash: expected, proposedAt: value.proposedAt }) as ValidatedGoalCompletionProposal;
  return { valid: true, proposal };
}

/**
 * Build a strict single-schema proposal. Gates (zob parity): non-empty
 * goalId, safe-integer revisions (goalRevision >= 1, todoGraphRevision >= 0),
 * and an injected parseable ISO proposedAt (D-P2 — no clock default).
 */
export function buildGoalCompletionProposal(input: GoalCompletionProposalInput): GoalCompletionProposal {
  if (typeof input.goalId !== "string" || input.goalId.trim().length === 0) {
    throw new TypeError("completion proposal goalId is required");
  }
  if (!isSafeIntegerAtLeast(input.goalRevision, 1)) {
    throw new TypeError("completion proposal goalRevision must be a safe integer >= 1");
  }
  if (!isSafeIntegerAtLeast(input.todoGraphRevision, 0)) {
    throw new TypeError("completion proposal todoGraphRevision must be a safe integer >= 0");
  }
  if (!isIsoTimestamp(input.proposedAt)) {
    throw new TypeError("completion proposal proposedAt must be an injected ISO timestamp");
  }
  const bodyFree: ProposalHashBody = {
    proposalVersion: PROPOSAL_VERSION,
    goalId: input.goalId,
    goalRevision: input.goalRevision,
    todoGraphRevision: input.todoGraphRevision,
    requirementsHash: hashProposalArray(input.requirementsChecked),
    requirementsCount: input.requirementsChecked.length,
    evidenceHash: hashProposalArray(input.evidenceRefs),
    evidenceCount: input.evidenceRefs.length,
    validationHash: hashProposalArray(input.validationCommands),
    validationCount: input.validationCommands.length,
    risksHash: hashProposalArray(input.knownRisks),
    risksCount: input.knownRisks.length,
    summaryHash: sha256Hex(input.completionSummary),
    noShip: input.noShip,
    bodyStored: false,
  };
  return Object.freeze({ ...bodyFree, proposalHash: goalCompletionProposalHash(bodyFree), proposedAt: input.proposedAt });
}
