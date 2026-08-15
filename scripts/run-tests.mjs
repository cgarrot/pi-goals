// scripts/run-tests.mjs — portable test runner.
//
// Why: `node --test <dir>` changed behavior in newer Node versions (Node 24
// treats a directory arg as a file → MODULE_NOT_FOUND), and glob args need
// Node ≥ 21 (the machine may run Node 20). Passing the compiled test files
// as EXPLICIT arguments works on every supported Node version and platform.
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "test",
);

let files;
try {
  files = readdirSync(dir)
    .filter((f) => f.endsWith(".test.js"))
    .sort()
    .map((f) => path.join(dir, f));
} catch {
  console.error(`no test directory at ${dir} — run "npm run build" first`);
  process.exit(1);
}

if (files.length === 0) {
  console.error(`no *.test.js files in ${dir} — run "npm run build" first`);
  process.exit(1);
}

const res = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(res.status ?? 1);
