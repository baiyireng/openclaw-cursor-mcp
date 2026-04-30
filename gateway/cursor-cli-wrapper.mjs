import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);

const sessionId = process.argv[2];
const message = process.argv[3];

if (!sessionId || !message) {
  process.stderr.write("Usage: node gateway/cursor-cli-wrapper.mjs <sessionId> <message>\n");
  process.exit(2);
}

const mode = process.env.CURSOR_BRIDGE_MODE ?? "cursor-agent-json"; // mock | cursor-agent-json | command

if (mode === "mock") {
  process.stdout.write(`Wrapper(mock): session=${sessionId}, message=${message}\n`);
  process.exit(0);
}

if (mode === "cursor-agent-json") {
  await runCursorAgentJsonMode(sessionId, message);
  process.exit(0);
}

if (mode !== "command") {
  process.stderr.write(`Unsupported CURSOR_BRIDGE_MODE=${mode}\n`);
  process.exit(2);
}

const realCmd = process.env.CURSOR_REAL_CLI_CMD;
if (!realCmd) {
  process.stderr.write("CURSOR_REAL_CLI_CMD is required in command mode\n");
  process.exit(2);
}

const timeout = Number.parseInt(process.env.CURSOR_REAL_CLI_TIMEOUT_MS ?? "120000", 10);
const argTemplate = parseArgTemplate(process.env.CURSOR_REAL_CLI_ARGS_JSON);
const args = argTemplate.map((item) => item.replaceAll("{{sessionId}}", sessionId).replaceAll("{{message}}", message));

try {
  const { stdout } = await runCommand(realCmd, args, timeout);
  const output = stdout.trim();
  if (!output) {
    throw new Error("real CLI output is empty");
  }
  const maybeJson = parseJson(output);
  if (maybeJson && typeof maybeJson.reply === "string") {
    process.stdout.write(`${maybeJson.reply}\n`);
  } else {
    process.stdout.write(`${output}\n`);
  }
} catch (error) {
  process.stderr.write(`CLI bridge failed: ${String(error)}\n`);
  process.exit(1);
}

async function runCursorAgentJsonMode(sessionId, message) {
  const defaultCmd = process.platform === "win32" ? "cursor.cmd" : "cursor";
  const cursorCmd = process.env.CURSOR_AGENT_CMD ?? defaultCmd;
  const model = process.env.CURSOR_AGENT_MODEL;
  const timeout = Number.parseInt(process.env.CURSOR_REAL_CLI_TIMEOUT_MS ?? "120000", 10);
  const promptPrefix =
    process.env.CURSOR_AGENT_PROMPT_PREFIX ??
    "You are receiving a proxied request from OpenClaw MCP bridge. Reply with plain text only.";
  const prompt = `[session:${sessionId}]\n${promptPrefix}\n\nUser message:\n${message}`;

  const args = ["agent", "-p", prompt, "--output-format", "json"];
  if (model) {
    args.push("--model", model);
  }

  const { stdout } = await runCommand(cursorCmd, args, timeout);
  const output = stdout.trim();
  if (!output) {
    throw new Error("cursor agent returned empty stdout");
  }

  const parsed = parseJson(output);
  const reply = extractAgentReply(parsed) ?? output;
  process.stdout.write(`${reply}\n`);
}

function parseArgTemplate(text) {
  if (!text) {
    return ["{{sessionId}}", "{{message}}"];
  }
  try {
    const value = JSON.parse(text);
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
      throw new Error("CURSOR_REAL_CLI_ARGS_JSON must be a JSON string array");
    }
    return value;
  } catch (error) {
    throw new Error(`Invalid CURSOR_REAL_CLI_ARGS_JSON: ${String(error)}`);
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractAgentReply(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  if (typeof payload.text === "string" && payload.text.trim()) {
    return payload.text.trim();
  }
  if (typeof payload.output === "string" && payload.output.trim()) {
    return payload.output.trim();
  }
  if (typeof payload.reply === "string" && payload.reply.trim()) {
    return payload.reply.trim();
  }
  return null;
}

async function runCommand(command, args, timeout) {
  if (process.platform === "win32") {
    const cmdline = [quoteCmd(command), ...args.map(quoteCmd)].join(" ");
    return execFileAsync("cmd.exe", ["/d", "/s", "/c", cmdline], {
      windowsHide: true,
      timeout
    });
  }

  return execFileAsync(command, args, {
    windowsHide: true,
    timeout
  });
}

function quoteCmd(text) {
  const value = String(text);
  if (!value.includes(" ") && !value.includes("\"")) {
    return value;
  }
  return `"${value.replaceAll("\"", "\\\"")}"`;
}
