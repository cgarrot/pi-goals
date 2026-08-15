// test/scaffold.test.ts — Phase 1 scaffold checks (node:test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { VERSION } from "../src/shared/version.js";
import { STATE_DIR_NAME, stateDir } from "../src/shared/paths.js";
import { DEFAULT_CONFIG, loadConfig } from "../src/shared/config.js";

test("version export equals 0.1.0", () => {
  assert.equal(VERSION, "0.1.0");
});

test("stateDir() honors GOALS_STATE_DIR override under a temp cwd", () => {
  const orig = process.cwd();
  const tmp = mkdtempSync(path.join(tmpdir(), "pi-goals-cwd-"));
  process.chdir(tmp);
  try {
    const override = path.join(tmp, "override-state");
    const env: NodeJS.ProcessEnv = { ...process.env, GOALS_STATE_DIR: override };
    assert.equal(stateDir(env), override);
    assert.notEqual(stateDir(env), path.join(tmp, STATE_DIR_NAME));
  } finally {
    process.chdir(orig);
  }
});

test("stateDir() defaults to <cwd>/.goals when no override is set", () => {
  const orig = process.cwd();
  const tmp = mkdtempSync(path.join(tmpdir(), "pi-goals-cwd-"));
  process.chdir(tmp);
  try {
    assert.equal(stateDir({}), path.join(process.cwd(), STATE_DIR_NAME));
  } finally {
    process.chdir(orig);
  }
});

test("loadConfig returns defaults when config file is absent", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "pi-goals-cfg-"));
  assert.deepEqual(loadConfig(tmp, {}), DEFAULT_CONFIG);
});
