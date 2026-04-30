#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = resolve(root, ".env.local");
const gatewayConfigPath = resolve(root, "gateway/config/gateway.config.json");
const generatedOpenClawConfigPath = resolve(root, "examples/openclaw-mcp-config.generated.json");
const gatewayManagePath = resolve(root, "gateway/manage.mjs");
const gatewayHealthUrl = "http://127.0.0.1:8791/health";

const command = process.argv[2] ?? "help";

async function main() {
  if (command === "init") {
    await doInit();
    return;
  }
  if (command === "up") {
    await doUp();
    return;
  }
  if (command === "down") {
    await doDown();
    return;
  }
  if (command === "status") {
    await doStatus();
    return;
  }
  if (command === "logs") {
    await doLogs();
    return;
  }
  if (command === "doctor") {
    await doDoctor();
    return;
  }
  printHelp();
}

async function doInit() {
  await mkdir(dirname(envPath), { recursive: true });
  const currentEnv = await loadEnvFile(envPath);
  const nextEnv = {
    OPENCLAW_ADMIN_TOKEN: currentEnv.OPENCLAW_ADMIN_TOKEN || randomUUID(),
    CURSOR_CLOUD_API_KEY: currentEnv.CURSOR_CLOUD_API_KEY || "",
    OPENCLAW_ENV_FILE: ".env.local"
  };
  await writeEnvFile(envPath, { ...currentEnv, ...nextEnv });

  const currentGatewayConfig = await loadJson(gatewayConfigPath, {});
  const mergedGatewayConfig = deepMerge(currentGatewayConfig, {
    gateway: {
      host: "127.0.0.1",
      port: 8791,
      mode: "plugin"
    },
    plugin: {
      module: "./providers/custom-provider.mjs"
    },
    cloud: {
      CURSOR_CLOUD_API_KEY: "",
      CURSOR_CLOUD_API_BASE_URL: "https://api.cursor.com",
      CURSOR_CLOUD_WORKSPACE_PATH: "."
    }
  });
  await writeJson(gatewayConfigPath, mergedGatewayConfig);

  const openClawConfig = {
    mcpServers: {
      "openclaw-cursor-mcp": {
        command: "node",
        args: [resolve(root, "dist/index.js").replaceAll("\\", "/")],
        env: {
          OPENCLAW_ENV_FILE: resolve(root, ".env.local").replaceAll("\\", "/"),
          OPENCLAW_CURSOR_DB_PATH: resolve(root, "data/openclaw-cursor-db.json").replaceAll("\\", "/"),
          CURSOR_ADAPTER_MODE: "http",
          CURSOR_API_BASEURL: "http://127.0.0.1:8791",
          CURSOR_API_ENDPOINT: "/chat"
        }
      }
    }
  };
  await writeJson(generatedOpenClawConfigPath, openClawConfig);

  process.stdout.write("Initialization complete.\n");
  process.stdout.write(`- Env file: ${envPath}\n`);
  process.stdout.write(`- Gateway config: ${gatewayConfigPath}\n`);
  process.stdout.write(`- OpenClaw MCP template: ${generatedOpenClawConfigPath}\n`);
  process.stdout.write("Next steps:\n");
  process.stdout.write("1) Fill CURSOR_CLOUD_API_KEY in .env.local\n");
  process.stdout.write("2) Run: openclaw-cursor-mcp up\n");
}

async function doUp() {
  const env = await loadEnvFile(envPath);
  if (!env.CURSOR_CLOUD_API_KEY) {
    process.stderr.write("CURSOR_CLOUD_API_KEY is empty. Please set it in .env.local first.\n");
    process.exit(1);
  }
  await ensureBuild();
  await runNodeScript(gatewayManagePath, ["start"], env);
  const healthy = await waitForHealth(gatewayHealthUrl, 10, 1000);
  if (!healthy) {
    process.stderr.write("Gateway health check failed after startup.\n");
    process.exit(1);
  }
  process.stdout.write("System is up.\n");
  process.stdout.write(`Gateway healthy: ${gatewayHealthUrl}\n`);
  process.stdout.write(`OpenClaw MCP template: ${generatedOpenClawConfigPath}\n`);
}

async function doDown() {
  const env = await loadEnvFile(envPath);
  const output = await runNodeScript(gatewayManagePath, ["stop"], env);
  process.stdout.write(`${output}\n`);
}

async function doStatus() {
  const env = await loadEnvFile(envPath);
  const gatewayStatus = await runNodeScript(gatewayManagePath, ["status"], env);
  const distExists = await exists(resolve(root, "dist/index.js"));
  const health = await probeHealth(gatewayHealthUrl);
  process.stdout.write(`${gatewayStatus}\n`);
  process.stdout.write(`MCP build: ${distExists ? "ready" : "missing"}\n`);
  process.stdout.write(`Gateway health: ${health.ok ? "ok" : `failed (${health.reason})`}\n`);
}

async function doLogs() {
  const env = await loadEnvFile(envPath);
  const output = await runNodeScript(gatewayManagePath, ["logs"], env);
  process.stdout.write(`${output}\n`);
}

async function doDoctor() {
  const env = await loadEnvFile(envPath);
  const checks = [];
  checks.push({ name: ".env.local exists", ok: await exists(envPath) });
  checks.push({ name: "CURSOR_CLOUD_API_KEY configured", ok: Boolean(env.CURSOR_CLOUD_API_KEY) });
  checks.push({ name: "gateway config exists", ok: await exists(gatewayConfigPath) });
  checks.push({ name: "MCP dist build exists", ok: await exists(resolve(root, "dist/index.js")) });
  const health = await probeHealth(gatewayHealthUrl);
  checks.push({ name: "gateway health", ok: health.ok, detail: health.reason });

  for (const check of checks) {
    process.stdout.write(`- ${check.ok ? "PASS" : "FAIL"}: ${check.name}${check.detail ? ` (${check.detail})` : ""}\n`);
  }
  const failed = checks.some((x) => !x.ok);
  if (failed) {
    process.exitCode = 1;
  }
}

function printHelp() {
  process.stdout.write("openclaw-cursor-mcp commands:\n");
  process.stdout.write("  init    Initialize env/config/template files\n");
  process.stdout.write("  up      Build and start gateway, then health check\n");
  process.stdout.write("  down    Stop gateway\n");
  process.stdout.write("  status  Show gateway + build + health status\n");
  process.stdout.write("  logs    Show gateway logs\n");
  process.stdout.write("  doctor  Run environment diagnostics\n");
}

async function ensureBuild() {
  const distFile = resolve(root, "dist/index.js");
  if (await exists(distFile)) {
    return;
  }
  process.stdout.write("dist not found, building...\n");
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  await runCommand(npmCmd, ["run", "build"], root, process.env);
}

async function runNodeScript(scriptPath, args, envPatch) {
  const mergedEnv = { ...process.env, ...envPatch, OPENCLAW_ENV_FILE: envPath };
  const result = await runCommand(process.execPath, [scriptPath, ...args], root, mergedEnv);
  return [result.stdout, result.stderr].filter(Boolean).join("").trim();
}

async function runCommand(command, args, cwd, env) {
  return new Promise((resolveDone, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolveDone({ stdout, stderr });
      } else {
        reject(new Error(`${command} ${args.join(" ")} failed (${code})\n${stderr || stdout}`));
      }
    });
  });
}

async function waitForHealth(url, retries, intervalMs) {
  for (let i = 0; i < retries; i += 1) {
    const result = await probeHealth(url);
    if (result.ok) {
      return true;
    }
    await sleep(intervalMs);
  }
  return false;
}

async function probeHealth(url) {
  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      return { ok: false, reason: `${resp.status} ${resp.statusText}` };
    }
    return { ok: true, reason: "ok" };
  } catch (error) {
    return { ok: false, reason: String(error) };
  }
}

async function loadEnvFile(path) {
  try {
    const text = await readFile(path, "utf8");
    return parseEnv(text);
  } catch {
    return {};
  }
}

function parseEnv(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const idx = line.indexOf("=");
    if (idx <= 0) {
      continue;
    }
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^"(.*)"$/, "$1");
    out[key] = value;
  }
  return out;
}

async function writeEnvFile(path, envObj) {
  const lines = Object.entries(envObj).map(([k, v]) => `${k}=${v ?? ""}`);
  await writeFile(path, `${lines.join("\n")}\n`, "utf8");
}

async function loadJson(path, fallback) {
  try {
    const text = await readFile(path, "utf8");
    const data = JSON.parse(text);
    return isPlainObject(data) ? data : fallback;
  } catch {
    return fallback;
  }
}

async function writeJson(path, obj) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(obj, null, 2), "utf8");
}

function deepMerge(target, patch) {
  const out = { ...target };
  for (const [k, v] of Object.entries(patch)) {
    if (isPlainObject(out[k]) && isPlainObject(v)) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function exists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolveDone) => setTimeout(resolveDone, ms));
}

main().catch((error) => {
  process.stderr.write(`openclaw-cursor-mcp failed: ${String(error)}\n`);
  process.exit(1);
});
