// Syncs the mistlib JS wrapper (wrappers/web) into src/vendor/mistlib.
//
// The engine itself is no longer built here: it's an ordinary npm dependency
// (@tik-choco/mistlib, wasm binary included), so running this app needs no Rust
// toolchain and no wasm-pack. All that's left to vendor is the wrapper — four
// small text files that are maintained in their own repo and are not published
// to npm. They're committed, so this script is an updater, not a prerequisite.
//
// To develop against a local engine build, set MISTLIB_LOCAL in .env instead;
// vite.config.ts aliases the package to it. See .env.example.
import { existsSync, mkdirSync, rmSync, renameSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const envPath = path.join(rootDir, ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);

const repo = process.env.MISTLIB_EXAMPLES_REPO;
const ref = process.env.MISTLIB_EXAMPLES_REF || "main";

const cacheDir = path.join(rootDir, ".mistlib-examples-src");
const vendorDir = path.join(rootDir, "src", "vendor", "mistlib");
const wrapperDir = path.join(vendorDir, "wrappers", "web");
// Records the commit the vendored wrapper came from. Lives in the gitignored
// cache dir so it never shows up as a spurious tracked-file change.
const revMarkerPath = path.join(cacheDir, ".vendored-rev");

const WRAPPER_FILES = ["index.js", "index.d.ts", "options.js", "package.json"];

if (!repo) {
  console.log("fetch-mistlib: MISTLIB_EXAMPLES_REPO not set — using the committed wrapper. Copy .env.example to .env to enable updates.");
  process.exit(0);
}

function run(cmd, args, cwd) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd, stdio: "inherit" });
}

function gitOutput(args, cwd) {
  return execFileSync("git", args, { cwd }).toString().trim();
}

if (!existsSync(path.join(cacheDir, ".git"))) {
  rmSync(cacheDir, { recursive: true, force: true });
  run("git", ["clone", repo, cacheDir]);
  // `config --get`, not `remote get-url`: the latter applies any
  // url.<base>.insteadOf rewrites (a git@github.com: for https:// rule is a
  // common global setting), so it would never compare equal to the configured
  // URL and we'd "repoint" on every single run.
} else if (gitOutput(["config", "--get", "remote.origin.url"], cacheDir) !== repo) {
  console.log(`origin changed — repointing ${path.basename(cacheDir)} at ${repo}`);
  run("git", ["remote", "set-url", "origin", repo], cacheDir);
}

run("git", ["fetch", "origin", ref], cacheDir);
const resolvedSha = gitOutput(["rev-parse", "FETCH_HEAD"], cacheDir);

const previousSha = existsSync(revMarkerPath) ? readFileSync(revMarkerPath, "utf8").trim() : null;
if (previousSha === resolvedSha && existsSync(wrapperDir)) {
  console.log(`mistlib wrapper (${ref} @ ${resolvedSha.slice(0, 7)}) already up to date`);
  process.exit(0);
}

run("git", ["checkout", "FETCH_HEAD"], cacheDir);

const sourceDir = path.join(cacheDir, "wrappers", "web");
if (!existsSync(sourceDir)) {
  console.error(`wrappers/web not found in ${sourceDir} — check MISTLIB_EXAMPLES_REPO/MISTLIB_EXAMPLES_REF in .env.`);
  process.exit(1);
}

// Stage the new wrapper and only swap it in once it's complete: writing
// straight into vendorDir would leave the committed tree half-replaced if
// anything below failed.
const stageDir = `${wrapperDir}.new`;
rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });
for (const name of WRAPPER_FILES) {
  const from = path.join(sourceDir, name);
  if (!existsSync(from)) {
    console.error(`wrapper file ${name} is missing from ${sourceDir} — the upstream layout changed.`);
    process.exit(1);
  }
  writeFileSync(path.join(stageDir, name), readFileSync(from));
}

// The wrapper imports the engine by package name, so there is nothing to
// rewrite — it resolves from node_modules exactly as it does from the import
// map the upstream examples use.
const importLine = readFileSync(path.join(stageDir, "index.js"), "utf8")
  .split("\n")
  .find((line) => line.startsWith("import init"));
if (!importLine?.includes("@tik-choco/mistlib")) {
  console.error(`Wrapper no longer imports @tik-choco/mistlib (got: ${importLine ?? "no import init line"}) — the packaging assumption changed.`);
  process.exit(1);
}

rmSync(wrapperDir, { recursive: true, force: true });
mkdirSync(path.dirname(wrapperDir), { recursive: true });
renameSync(stageDir, wrapperDir);

writeFileSync(revMarkerPath, resolvedSha + "\n");
console.log(`mistlib wrapper (${ref} @ ${resolvedSha.slice(0, 7)}) vendored into src/vendor/mistlib/wrappers/web`);
