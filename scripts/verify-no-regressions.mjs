import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const repo = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "9router-regression-"));
const currentResult = path.join(tempRoot, "current.json");
const cleanResult = path.join(tempRoot, "clean.json");
const worktree = path.join(tempRoot, "clean-tree");
const testArgs = ["vitest", "run", "--reporter=json"];

function run(cwd, result) {
  try {
    execFileSync("npx", [...testArgs, `--outputFile=${result}`], {
      cwd: path.join(cwd, "tests"), stdio: "inherit", env: { ...process.env, CI: "true" },
    });
  } catch (error) {
    if (!fs.existsSync(result)) throw error;
  }
}

function failures(file) {
  const result = JSON.parse(fs.readFileSync(file, "utf8"));
  const out = new Set();
  for (const suite of result.testResults || []) for (const assertion of suite.assertionResults || []) {
    if (assertion.status === "failed") {
      const suiteName = String(suite.name).replace(/^.*[\\/]tests[\\/]/, "tests/");
      out.add(`${suiteName} :: ${assertion.fullName}`);
    }
  }
  return out;
}

try {
  run(repo, currentResult);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  execFileSync("git", ["worktree", "add", "--detach", worktree, head], { cwd: repo, stdio: "inherit" });
  for (const relative of ["node_modules", path.join("tests", "node_modules")]) {
    const source = path.join(repo, relative);
    const target = path.join(worktree, relative);
    if (fs.existsSync(source) && !fs.existsSync(target)) fs.symlinkSync(source, target, "junction");
  }
  run(worktree, cleanResult);
  const current = failures(currentResult);
  const clean = failures(cleanResult);
  const added = [...current].filter((failure) => !clean.has(failure));
  console.log(`NEW failures: ${added.length} (current vs clean-tree, full suite, same runner)`);
  for (const failure of added) console.log(`NEW: ${failure}`);
  if (added.length) process.exitCode = 1;
} finally {
  if (fs.existsSync(worktree)) {
    try { execFileSync("git", ["worktree", "remove", "--force", worktree], { cwd: repo, stdio: "inherit" }); } catch {}
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
