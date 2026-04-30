#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const envPath = resolve(root, ".env.local");
const gatewayUrl = process.env.GATEWAY_URL ?? "http://127.0.0.1:8791";

async function main() {
  const env = await parseEnvFile(envPath);
  if (!env.CURSOR_CLOUD_API_KEY) {
    throw new Error("CURSOR_CLOUD_API_KEY is empty in .env.local");
  }
  if (!env.CURSOR_CLOUD_REPO_URL) {
    throw new Error("CURSOR_CLOUD_REPO_URL is empty in .env.local");
  }

  await run("npm", ["run", "build"]);
  await run("npm", ["run", "cli", "--", "doctor", "--fix"]);
  await run("npm", ["run", "gateway:restart"]);

  const health = await waitForHealthy(`${gatewayUrl}/health`, 15, 1000);
  if (!health.ok) {
    throw new Error(`Gateway health failed: ${JSON.stringify(health)}`);
  }

  const payload = {
    sessionId: `acceptance-${Date.now()}`,
    message: "请回复：验收脚本通过"
  };
  const chatResp = await fetch(`${gatewayUrl}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const chatJson = await safeJson(chatResp);
  if (!chatResp.ok || !chatJson?.ok || !chatJson?.reply) {
    throw new Error(`Chat check failed: status=${chatResp.status}, body=${JSON.stringify(chatJson)}`);
  }

  process.stdout.write("Acceptance check passed.\n");
  process.stdout.write(`- Gateway: ${gatewayUrl}\n`);
  process.stdout.write(`- TraceId: ${chatJson.traceId ?? "n/a"}\n`);
  process.stdout.write(`- Reply preview: ${String(chatJson.reply).slice(0, 80)}\n`);
}

async function parseEnvFile(path) {
  const text = await readFile(path, "utf8");
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
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

async function run(command, args) {
  const cmd = process.platform === "win32" && command === "npm" ? "npm" : command;
  await new Promise((resolveDone, reject) => {
    const child = spawn(cmd, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolveDone(null);
      } else {
        reject(new Error(`${command} ${args.join(" ")} failed with code ${code}`));
      }
    });
  });
}

async function fetchJson(url) {
  const resp = await fetch(url);
  const data = await safeJson(resp);
  if (!resp.ok) {
    throw new Error(`Request failed: ${url}, status=${resp.status}, body=${JSON.stringify(data)}`);
  }
  return data;
}

async function waitForHealthy(url, retries, intervalMs) {
  let lastError = null;
  for (let i = 0; i < retries; i += 1) {
    try {
      return await fetchJson(url);
    } catch (error) {
      lastError = error;
      await sleep(intervalMs);
    }
  }
  throw lastError ?? new Error("Gateway health check failed");
}

async function safeJson(resp) {
  try {
    return await resp.json();
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolveDone) => setTimeout(resolveDone, ms));
}

main().catch((error) => {
  process.stderr.write(`Acceptance check failed: ${String(error)}\n`);
  process.exit(1);
});
