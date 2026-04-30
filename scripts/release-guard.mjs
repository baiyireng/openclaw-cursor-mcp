#!/usr/bin/env node
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);

async function main() {
  const { stdout } = await runNpmPackDryRun();
  const payload = JSON.parse(stdout);
  const first = Array.isArray(payload) ? payload[0] : null;
  const files = Array.isArray(first?.files) ? first.files : [];
  const mockFiles = files
    .map((item) => String(item.path ?? ""))
    .filter((path) => /mock/i.test(path));

  if (mockFiles.length > 0) {
    throw new Error(`Release package contains mock files: ${mockFiles.join(", ")}`);
  }

  process.stdout.write("Release guard passed: no mock files in npm package.\n");
}

async function runNpmPackDryRun() {
  if (process.platform === "win32") {
    return execFileAsync("cmd.exe", ["/d", "/s", "/c", "npm pack --dry-run --json"], { windowsHide: true });
  }
  return execFileAsync("npm", ["pack", "--dry-run", "--json"], { windowsHide: true });
}

main().catch((error) => {
  process.stderr.write(`Release guard failed: ${String(error)}\n`);
  process.exit(1);
});
