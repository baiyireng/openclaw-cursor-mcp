#!/usr/bin/env node
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);

const defaultCmd = process.platform === "win32" ? "cursor.cmd" : "cursor";
const cursorCmd = process.env.CURSOR_STATUS_CMD ?? defaultCmd;
const timeout = Number.parseInt(process.env.CURSOR_STATUS_TIMEOUT_MS ?? "15000", 10);

async function main() {
  const { stdout } = await runCommand(cursorCmd, ["-s"], timeout);
  const targets = parseTargets(stdout);
  process.stdout.write(`${JSON.stringify(targets)}\n`);
}

function parseTargets(text) {
  const lines = String(text).split(/\r?\n/);
  const windows = lines
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|  Window (") && line.endsWith(")"))
    .map((line, index) => {
      const label = line.slice("|  Window (".length, -1).trim();
      return {
        targetCursor: `window-${index + 1}`,
        windowLabel: label,
        workspacePath: null,
        active: index === windowsActiveIndex(lines)
      };
    });

  if (windows.length > 0) {
    return windows;
  }

  return [{ targetCursor: "window-1", windowLabel: "Cursor Default Window", workspacePath: null, active: true }];
}

function windowsActiveIndex(lines) {
  const raw = lines.find((line) => line.includes("window [") && line.toLowerCase().includes("openclaw-cursor-mcp"));
  if (!raw) {
    return 0;
  }
  return 0;
}

async function runCommand(command, args, waitMs) {
  if (process.platform === "win32") {
    const cmdline = [quoteCmd(command), ...args.map(quoteCmd)].join(" ");
    return execFileAsync("cmd.exe", ["/d", "/s", "/c", cmdline], { windowsHide: true, timeout: waitMs });
  }
  return execFileAsync(command, args, { windowsHide: true, timeout: waitMs });
}

function quoteCmd(text) {
  const value = String(text);
  if (!value.includes(" ") && !value.includes("\"")) {
    return value;
  }
  return `"${value.replaceAll("\"", "\\\"")}"`;
}

main().catch((error) => {
  process.stderr.write(`cursor status discovery failed: ${String(error)}\n`);
  process.exit(1);
});
