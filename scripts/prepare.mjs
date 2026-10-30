// Builds dist/ for `npm i -g github:...`. npm prepares a git dependency with
// the global flags inherited (npm_config_global / npm_config_prefix), so the
// clone gets no devDependencies and `tsc` is missing. Install them locally first.
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^npm_config_(global|prefix|location|omit|production)$/i.test(key)) delete env[key];
}
const run = (cmd) => execSync(cmd, { cwd: root, env, stdio: "inherit" });

if (!existsSync(join(root, "node_modules", "typescript", "bin", "tsc"))) {
  run("npm install --no-save --ignore-scripts --no-audit --no-fund --include=dev");
}
run("node node_modules/typescript/bin/tsc -p tsconfig.json");
