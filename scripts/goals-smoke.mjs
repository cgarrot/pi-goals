#!/usr/bin/env node
// scripts/goals-smoke.mjs — Phase 6 headless end-to-end smoke (no Pi).
//
// Against a TEMP stateDir, through the REAL compiled engine (dist/):
//   1. create goal -> add 3 todos (1 required with a subtree) -> complete one
//   2. delegate + claim flow: link -> return claim -> strict-PASS oracle
//      validation -> accept_claim settlement
//   3. completion WITHOUT oracle -> exact blocker (fail-closed proof)
//   4. propose -> oracle PASS -> complete; verify revision lineage + .goals layout
//   5. SECOND goal: truncated-tail crash simulation -> quarantine + RestoreBlocked
// Exit 0 only when every step passes.
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { createRuntimeGoalEngine } = await import(pathToFileURL(path.join(ROOT, "dist", "src", "runtime", "engine.js")).href);
const { goalStorePaths, casReceiptsPath } = await import(pathToFileURL(path.join(ROOT, "dist", "src", "store", "log.js")).href);

const tmp = mkdtempSync(path.join(os.tmpdir(), "goals-smoke-"));
const stateDir = path.join(tmp, "state");
const runtimeDir = path.join(tmp, "run");
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

const results = [];
function report(step, ok, detail = "") {
  results.push({ step, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${step}${detail ? ` — ${detail}` : ""}`);
}

let seq = 0;
const engine = createRuntimeGoalEngine({ stateDir, runtimeDir });
const view = () => engine.getGoal().goal ?? (() => { throw new Error("no active goal view"); })();
const cas = (viewSnapshot) => ({ mutationId: `smoke-${(++seq).toString(36)}-${Date.now().toString(36)}`, expectedGoalRevision: viewSnapshot.revisions.goal, expectedGraphRevision: viewSnapshot.revisions.todos });
  const casG = () => cas(view()); // fresh graph+root revisions before every mutation

try {
  // ---- Step 1: create -> 3 todos (1 required with subtree) -> complete one ----
  let step = "step1 create + todos + complete";
  try {
    const created = engine.createGoal("Ship pi-goals v0.1.0 end to end", { mutationId: "smoke-create", expectedGoalRevision: 0 });
    if (!created.ok) throw new Error(`create: ${created.code} ${created.message}`);
    const goalId = created.result.goalId;

    const batch1 = engine.addTodos(
      [
        { input: { title: "Scaffold the core engine", required: true, priority: "high" } },
        { input: { title: "Delegate the integration lane", required: true, owner: "subagent" } },
        { input: { title: "Optional docs polish", required: false } },
      ],
      { mutationId: "smoke-add-batch1", expectedGraphRevision: 0 },
    );
    if (!batch1.ok) throw new Error(`addTodos: ${batch1.code} ${batch1.message}`);
    const integrationId = batch1.result.created.find((node) => node.title.startsWith("Delegate")).id;

    const batch2 = engine.addTodos(
      [
        { parentId: integrationId, input: { title: "Wire the adapter", required: true } },
        { parentId: integrationId, input: { title: "Validate the adapter", required: true } },
      ],
      { mutationId: "smoke-add-batch2", expectedGraphRevision: 1 },
    );
    if (!batch2.ok) throw new Error(`addSubtree: ${batch2.code} ${batch2.message}`);

    for (const [todoPath, action, input] of [
      ["3", "skip", { reason: "out of scope for the demo" }],
      ["1", "complete", { reason: "core shipped" }],
      ["2.1", "complete", { reason: "adapter wired" }],
      ["2.2", "complete", { reason: "adapter validated" }],
    ]) {
      const resolved = engine.resolveTodo({ todoPath }, action, input, casG());
      if (!resolved.ok) throw new Error(`${action} ${todoPath}: ${resolved.code} ${resolved.message}`);
    }
    report(step, true, `goal ${goalId} · 5 nodes (3 top-level + 2 subtodos) · 1 done · 1 skipped`);
  } catch (error) {
    report(step, false, String(error.message ?? error));
  }

  // ---- Step 2: delegate -> return claim -> strict-PASS validation -> accept ----
  step = "step2 delegation claim flow";
  try {
    const linked = engine.linkDelegation({ todoPath: "2" }, { agent: "child-worker", validationPolicy: "oracle_required" }, casG());
    if (!linked.ok) throw new Error(`link: ${linked.code} ${linked.message}`);
    const attemptId = linked.result.attempt.attemptId;

    const claimText = [
      "TODO_CHILD_RESULT.v2",
      "status_claim: done",
      "evidence_refs: dist/src/cli/goals.js",
      "validation_commands: npm test",
      "no_ship: false",
      "FINAL_MARKER: TODO_CHILD_RESULT_V2_END",
    ].join("\n");
    const returned = engine.returnClaim(attemptId, { claimText, evidenceRefs: ["dist/src/cli/goals.js"], validationCommands: ["npm test"], noShip: false }, casG());
    if (!returned.ok) throw new Error(`return: ${returned.code} ${returned.message}`);

    const validated = engine.recordClaimValidation(
      attemptId,
      {
        verdict: "PASS",
        recommendedAction: "accept_claim",
        noShip: false,
        confidence: "HIGH",
        outputHash: sha256(claimText),
        evidenceRefs: ["dist/src/cli/goals.js"],
        validationCommands: ["npm test"],
      },
      casG(),
    );
    if (!validated.ok) throw new Error(`validate: ${validated.code} ${validated.message}`);
    if (validated.result.claimRule.autoAccept !== true) throw new Error(`strict-PASS auto-accept did not compose: ${JSON.stringify(validated.result.claimRule)}`);

    const accepted = engine.resolveTodo(
      { todoPath: "2" },
      "accept_claim",
      { claimHash: returned.result.claim.claimHash, attemptId, validationPolicy: "oracle_required" },
      casG(),
    );
    if (!accepted.ok) throw new Error(`accept: ${accepted.code} ${accepted.message}`);
    if (accepted.result.node.status !== "done") throw new Error(`node status ${accepted.result.node.status}`);
    report(step, true, `${attemptId} settled accepted (strict-PASS composition autoAccept=true)`);
  } catch (error) {
    report(step, false, String(error.message ?? error));
  }

  // ---- Step 3: completion WITHOUT oracle fails with the exact blocker ----
  step = "step3 complete-without-oracle rejected";
  try {
    const blocked = engine.completeGoal(cas(view()));
    if (blocked.ok) throw new Error("completeGoal unexpectedly succeeded without an oracle decision");
    if (blocked.code !== "oracle_not_fresh" || blocked.freshnessCode !== "oracle_binding_missing") {
      throw new Error(`wrong blocker: ${blocked.code}/${blocked.freshnessCode}`);
    }
    report(step, true, `code=${blocked.code} freshness=${blocked.freshnessCode}`);
  } catch (error) {
    report(step, false, String(error.message ?? error));
  }

  // ---- Step 4: propose -> oracle PASS -> complete; lineage + layout ----
  step = "step4 propose -> oracle PASS -> complete + lineage/layout";
  try {
    const current = view();
    const proposed = engine.proposeCompletion(
      {
        completionSummary: "All required todos closed; delegated lane parent-accepted after strict-PASS oracle validation",
        requirementsChecked: ["engine flows verified", "claim settlement verified"],
        evidenceRefs: ["scripts/goals-smoke.mjs"],
        validationCommands: ["npm run build", "npm test", "npm run smoke"],
        knownRisks: [],
        noShip: false,
      },
      cas(current),
    );
    if (!proposed.ok) throw new Error(`propose: ${proposed.code} ${proposed.message}`);
    const decision = engine.recordOracleDecision({ verdict: "PASS", noShip: false, evidenceSummary: "smoke oracle: evidence verified", evidenceRefs: ["scripts/goals-smoke.mjs"] }, cas(view()));
    if (!decision.ok) throw new Error(`oracle: ${decision.code} ${decision.message}`);
    const completed = engine.completeGoal(cas(view()));
    if (!completed.ok) throw new Error(`complete: ${completed.code} ${completed.message}`);
    const goalId = completed.result.goal.goalId;
    if (completed.result.goal.status !== "complete") throw new Error(`status ${completed.result.goal.status}`);

    const goalLines = readFileSync(goalStorePaths(stateDir, goalId).goalLog, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
    const revisions = goalLines.map((line) => line.revision);
    if (JSON.stringify(revisions) !== JSON.stringify(revisions.map((_, index) => index + 1))) throw new Error(`non-contiguous lineage: ${revisions.join(",")}`);

    const paths = goalStorePaths(stateDir, goalId);
    for (const file of [paths.goalLog, paths.todosLog, paths.claimsLog, path.join(paths.dir, "runtime-goal.json")]) {
      if (!existsSync(file)) throw new Error(`missing store file: ${file}`);
    }
    if (!existsSync(casReceiptsPath(stateDir))) throw new Error("missing cas-receipts.jsonl");
    report(step, true, `goal ${goalId} complete · goal stream revisions 1..${revisions.length} contiguous · .goals layout verified`);
  } catch (error) {
    report(step, false, String(error.message ?? error));
  }

  // ---- Step 5: truncated-tail crash on a SECOND goal -> quarantine + blocked ----
  step = "step5 truncated-tail crash -> quarantine + RestoreBlocked";
  try {
    const second = engine.createGoal("Second goal for the crash drill", { mutationId: "smoke-create-2", expectedGoalRevision: 0 });
    if (!second.ok) throw new Error(`create2: ${second.code} ${second.message}`);
    const goalId2 = second.result.goalId;

    // crash simulation: a torn write leaves a trailing partial line (no newline)
    appendFileSync(goalStorePaths(stateDir, goalId2).goalLog, '{"schema":"pi-goals.goal.v1","kind":"goal_set","rev');

    // the FIRST restore after the crash fails closed and quarantines the torn stream
    const mutation = engine.addTodos([{ input: { title: "should fail closed" } }], { mutationId: "smoke-after-crash", expectedGraphRevision: 0 });
    if (mutation.ok || mutation.code !== "restore_blocked") throw new Error(`mutation after crash: ${JSON.stringify(mutation.ok ? "applied" : mutation.code)}`);
    const diagnostic = mutation.diagnostics?.find((entry) => entry.code === "truncated_tail");
    if (!diagnostic) throw new Error(`no truncated_tail diagnostic: ${JSON.stringify(mutation.diagnostics ?? [])}`);

    const quarantineDir = path.join(stateDir, "quarantine", goalId2);
    const quarantined = readdirSync(quarantineDir).filter((name) => name.includes("goal.log.jsonl"));
    if (quarantined.length === 0) throw new Error("goal stream was not quarantined");

    // after quarantine the store is clean-but-empty for that goal: fail-closed,
    // never a partial replay (the torn revision never enters the lineage)
    const after = engine.getGoal();
    if (after.diagnostics !== undefined && after.diagnostics.length > 0) throw new Error(`still blocked after quarantine: ${JSON.stringify(after.diagnostics[0])}`);
    report(step, true, `goal ${goalId2} mutation restore_blocked (${diagnostic.code}) · stream quarantined to quarantine/${goalId2}/ · post-quarantine restore clean`);
  } catch (error) {
    report(step, false, String(error.message ?? error));
  }
} finally {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // best-effort temp cleanup
  }
}

const failed = results.filter((entry) => !entry.ok);
console.log(failed.length === 0 ? `PASS pi-goals smoke: ${results.length}/${results.length} steps (lifecycle + crash quarantine)` : `FAIL ${failed.length} step(s)`);
process.exit(failed.length === 0 ? 0 : 1);
