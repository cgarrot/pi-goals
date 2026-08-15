// test/core-proposal.test.ts — Phase 3a strict single-schema goal completion
// proposal (TDD, red first).
//
// Under test: src/core/proposal.ts — GoalCompletionProposal: canonical
// proposalHash over EXACTLY the 15 canonical body-free fields, ordered-array
// hashing with duplicates preserved (zob parity), key-order independence of
// the canonical JSON preimage, the strict validator (every field mutation
// must invalidate), and the builder input gates (goalId non-empty, safe
// integers with goalRevision>=1 / todoGraphRevision>=0, injected ISO
// proposedAt). Purity: the builder never reads the clock.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  buildGoalCompletionProposal,
  goalCompletionProposalHash,
  hashProposalArray,
  validateGoalCompletionProposal,
} from "../src/core/proposal.js";
import type { GoalCompletionProposal, GoalCompletionProposalInput } from "../src/core/proposal.js";

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const OTHER_HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const INPUT: GoalCompletionProposalInput = {
  goalId: "goal-1",
  goalRevision: 5,
  todoGraphRevision: 7,
  requirementsChecked: ["req-a"],
  evidenceRefs: ["evidence-1", "evidence-2"],
  validationCommands: [],
  knownRisks: ["risk one", "risk two"],
  completionSummary: "all done",
  noShip: false,
  proposedAt: "2024-01-02T03:04:05.000Z",
};

const PROPOSAL = buildGoalCompletionProposal(INPUT);

test("builder: counts mirror the input arrays and hashes are exact", () => {
  assert.equal(PROPOSAL.proposalVersion, 1);
  assert.equal(PROPOSAL.requirementsCount, 1);
  assert.equal(PROPOSAL.evidenceCount, 2);
  assert.equal(PROPOSAL.validationCount, 0);
  assert.equal(PROPOSAL.risksCount, 2);
  assert.equal(PROPOSAL.requirementsHash, sha256(JSON.stringify(["req-a"])));
  assert.equal(PROPOSAL.evidenceHash, sha256(JSON.stringify(["evidence-1", "evidence-2"])));
  assert.equal(PROPOSAL.validationHash, sha256(JSON.stringify([])));
  assert.equal(PROPOSAL.risksHash, sha256(JSON.stringify(["risk one", "risk two"])));
  assert.equal(PROPOSAL.summaryHash, sha256("all done"));
  assert.equal(PROPOSAL.bodyStored, false);
  assert.equal(PROPOSAL.proposedAt, INPUT.proposedAt);
  assert.ok(/[a-f0-9]{64}/.test(PROPOSAL.proposalHash));
});

test("proposalHash preimage: exactly the 15 canonical fields in canonical order", () => {
  const preimage = JSON.stringify({
    proposalVersion: 1,
    goalId: "goal-1",
    goalRevision: 5,
    todoGraphRevision: 7,
    requirementsHash: sha256(JSON.stringify(["req-a"])),
    requirementsCount: 1,
    evidenceHash: sha256(JSON.stringify(["evidence-1", "evidence-2"])),
    evidenceCount: 2,
    validationHash: sha256(JSON.stringify([])),
    validationCount: 0,
    risksHash: sha256(JSON.stringify(["risk one", "risk two"])),
    risksCount: 2,
    summaryHash: sha256("all done"),
    noShip: false,
    bodyStored: false,
  });
  assert.equal(PROPOSAL.proposalHash, sha256(preimage));
});

test("hash stability: identical inputs produce identical, deterministic hashes", () => {
  const again = buildGoalCompletionProposal(INPUT);
  assert.deepEqual(again, PROPOSAL);
  assert.equal(again.proposalHash, PROPOSAL.proposalHash);
});

test("proposedAt is injected and is NOT part of the canonical hash", () => {
  const later = buildGoalCompletionProposal({ ...INPUT, proposedAt: "2030-06-07T08:09:10.000Z" });
  assert.notEqual(later.proposedAt, PROPOSAL.proposedAt);
  assert.equal(later.proposalHash, PROPOSAL.proposalHash);
});

test("ordered-array hashing preserves caller order and duplicates (zob parity)", () => {
  assert.notEqual(hashProposalArray(["a", "b"]), hashProposalArray(["b", "a"]));
  assert.notEqual(hashProposalArray(["a", "a"]), hashProposalArray(["a"]));
  assert.equal(hashProposalArray(["a", "a"]), hashProposalArray(["a", "a"]));
  assert.equal(hashProposalArray([]), sha256(JSON.stringify([])));
  const reordered = buildGoalCompletionProposal({ ...INPUT, evidenceRefs: ["evidence-2", "evidence-1"] });
  assert.notEqual(reordered.proposalHash, PROPOSAL.proposalHash);
  const duplicated = buildGoalCompletionProposal({ ...INPUT, evidenceRefs: ["evidence-1", "evidence-1"] });
  const single = buildGoalCompletionProposal({ ...INPUT, evidenceRefs: ["evidence-1"] });
  assert.notEqual(duplicated.proposalHash, single.proposalHash);
  assert.notEqual(duplicated.evidenceCount, single.evidenceCount);
});

test("key-order independence: a reversed-key object still validates and rehashes identically", () => {
  const reversed: Record<string, unknown> = {};
  for (const key of Object.keys(PROPOSAL).reverse()) {
    reversed[key] = (PROPOSAL as unknown as Record<string, unknown>)[key];
  }
  const result = validateGoalCompletionProposal(reversed);
  assert.equal(result.valid, true);
  if (result.valid) assert.equal(result.proposal.proposalHash, PROPOSAL.proposalHash);
});

test("validator: round-trips a built proposal as a frozen canonical clone", () => {
  const result = validateGoalCompletionProposal(PROPOSAL);
  assert.equal(result.valid, true);
  if (result.valid) {
    assert.deepEqual(result.proposal, PROPOSAL);
    assert.ok(Object.isFrozen(result.proposal));
  }
  assert.ok(Object.isFrozen(PROPOSAL));
});

const TAMPER: Record<string, (p: GoalCompletionProposal) => Record<string, unknown>> = {
  proposalVersion: (p) => ({ ...p, proposalVersion: 2 }),
  proposalHash: (p) => ({ ...p, proposalHash: OTHER_HASH }),
  goalId: (p) => ({ ...p, goalId: "goal-other" }),
  goalRevision: (p) => ({ ...p, goalRevision: p.goalRevision + 1 }),
  todoGraphRevision: (p) => ({ ...p, todoGraphRevision: p.todoGraphRevision + 1 }),
  requirementsHash: (p) => ({ ...p, requirementsHash: OTHER_HASH }),
  requirementsCount: (p) => ({ ...p, requirementsCount: p.requirementsCount + 1 }),
  evidenceHash: (p) => ({ ...p, evidenceHash: OTHER_HASH }),
  evidenceCount: (p) => ({ ...p, evidenceCount: p.evidenceCount + 1 }),
  validationHash: (p) => ({ ...p, validationHash: OTHER_HASH }),
  validationCount: (p) => ({ ...p, validationCount: p.validationCount + 1 }),
  risksHash: (p) => ({ ...p, risksHash: OTHER_HASH }),
  risksCount: (p) => ({ ...p, risksCount: p.risksCount + 1 }),
  summaryHash: (p) => ({ ...p, summaryHash: OTHER_HASH }),
  noShip: (p) => ({ ...p, noShip: !p.noShip }),
  proposedAt: (p) => ({ ...p, proposedAt: "not-a-timestamp" }),
  bodyStored: (p) => ({ ...p, bodyStored: true }),
};

test("tamper matrix: every field mutation without rehash invalidates", () => {
  for (const [field, mutate] of Object.entries(TAMPER)) {
    const result = validateGoalCompletionProposal(mutate(PROPOSAL));
    assert.equal(result.valid, false, `field ${field} must invalidate`);
    if (!result.valid) assert.ok(result.message.length > 0, `field ${field} must carry a message`);
  }
});

test("tamper matrix: hash drift is reported as proposal_hash_mismatch, structural junk as its own codes", () => {
  const hashDrift = validateGoalCompletionProposal(TAMPER.evidenceCount!(PROPOSAL));
  assert.equal(hashDrift.valid, false);
  if (!hashDrift.valid) assert.equal(hashDrift.code, "proposal_hash_mismatch");
  const structural = validateGoalCompletionProposal({ ...PROPOSAL, goalRevision: 1.5 });
  assert.equal(structural.valid, false);
  if (!structural.valid) assert.equal(structural.code, "invalid_goal_revision");
  const badTimestamp = validateGoalCompletionProposal(TAMPER.proposedAt!(PROPOSAL));
  assert.equal(badTimestamp.valid, false);
  if (!badTimestamp.valid) assert.equal(badTimestamp.code, "invalid_proposed_at");
});

test("validator: strict schema rejects non-records, missing fields, and unknown fields", () => {
  for (const junk of [null, undefined, 42, "proposal", [], true]) {
    const result = validateGoalCompletionProposal(junk);
    assert.equal(result.valid, false, `junk ${String(junk)} must be invalid`);
    if (!result.valid) assert.equal(result.code, "not_a_record");
  }
  const { goalId: _goalId, ...missingOne } = PROPOSAL;
  const missing = validateGoalCompletionProposal(missingOne);
  assert.equal(missing.valid, false);
  if (!missing.valid) assert.equal(missing.code, "missing_fields");
  const extra = validateGoalCompletionProposal({ ...PROPOSAL, extraField: 1 });
  assert.equal(extra.valid, false);
  if (!extra.valid) assert.equal(extra.code, "unexpected_fields");
});

test("a tampered-and-rehashed object is a different valid proposal, not the original", () => {
  const { proposalHash: _hash, proposedAt: _at, ...bodyFree } = { ...PROPOSAL, goalId: "goal-forged" };
  const forged = { ...PROPOSAL, goalId: "goal-forged", proposalHash: goalCompletionProposalHash(bodyFree) };
  const result = validateGoalCompletionProposal(forged);
  assert.equal(result.valid, true);
  if (result.valid) assert.notEqual(result.proposal.proposalHash, PROPOSAL.proposalHash);
});

test("builder validation rejections: goalId, revisions, and injected ISO proposedAt", () => {
  assert.throws(() => buildGoalCompletionProposal({ ...INPUT, goalId: "" }), TypeError);
  assert.throws(() => buildGoalCompletionProposal({ ...INPUT, goalId: "   " }), TypeError);
  assert.throws(() => buildGoalCompletionProposal({ ...INPUT, goalRevision: 0 }), TypeError);
  assert.throws(() => buildGoalCompletionProposal({ ...INPUT, goalRevision: -1 }), TypeError);
  assert.throws(() => buildGoalCompletionProposal({ ...INPUT, goalRevision: 1.5 }), TypeError);
  assert.throws(() => buildGoalCompletionProposal({ ...INPUT, goalRevision: Number.NaN }), TypeError);
  assert.throws(() => buildGoalCompletionProposal({ ...INPUT, goalRevision: 2 ** 53 }), TypeError);
  assert.throws(() => buildGoalCompletionProposal({ ...INPUT, todoGraphRevision: -1 }), TypeError);
  assert.throws(() => buildGoalCompletionProposal({ ...INPUT, todoGraphRevision: 0.5 }), TypeError);
  assert.throws(() => buildGoalCompletionProposal({ ...INPUT, proposedAt: undefined as unknown as string }), TypeError);
  assert.throws(() => buildGoalCompletionProposal({ ...INPUT, proposedAt: "yesterday" }), TypeError);
  // boundary values are accepted
  const minimal = buildGoalCompletionProposal({ ...INPUT, goalId: "g", goalRevision: 1, todoGraphRevision: 0 });
  assert.equal(minimal.goalRevision, 1);
  assert.equal(minimal.todoGraphRevision, 0);
});
