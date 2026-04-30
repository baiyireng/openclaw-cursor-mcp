#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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

  await runLocalCursorAcceptance(env);

  process.stdout.write("Acceptance check passed.\n");
  process.stdout.write(`- Gateway: ${gatewayUrl}\n`);
  process.stdout.write(`- TraceId: ${chatJson.traceId ?? "n/a"}\n`);
  process.stdout.write(`- Reply preview: ${String(chatJson.reply).slice(0, 80)}\n`);
}

async function runLocalCursorAcceptance(env) {
  const adminToken = env.OPENCLAW_ADMIN_TOKEN;
  if (!adminToken) {
    throw new Error("OPENCLAW_ADMIN_TOKEN is empty in .env.local");
  }
  const localMockPath = resolve(root, "scripts/local-cursor-mock.mjs");
  const localTargetsMockPath = resolve(root, "scripts/local-targets-mock.mjs");
  const localTargetsPath = resolve(root, "data/runtime/local-targets.acceptance.json");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(root, "dist/index.js")],
    env: {
      ...process.env,
      OPENCLAW_ENV_FILE: ".env.local",
      CURSOR_ADAPTER_MODE: "local_cursor",
      CURSOR_LOCAL_CMD: process.execPath,
      CURSOR_LOCAL_ARGS_JSON: JSON.stringify([localMockPath, "{{sessionId}}", "{{message}}", "{{targetCursor}}"]),
      CURSOR_LOCAL_TARGET_DISCOVERY_CMD: process.execPath,
      CURSOR_LOCAL_TARGET_DISCOVERY_ARGS_JSON: JSON.stringify([localTargetsMockPath]),
      CURSOR_LOCAL_TARGETS_PATH: localTargetsPath
    }
  });
  const client = new Client({ name: "acceptance-local-cursor", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  try {
    const created = await callJsonTool(client, "cursor_session_create", { title: "acceptance-local-cursor" });
    const sessionId = created?.session?.id;
    if (!sessionId) {
      throw new Error(`Local acceptance failed: invalid create response ${JSON.stringify(created)}`);
    }
    await callJsonTool(client, "cursor_permission_request", {
      sessionId,
      requestedAction: "chat_send",
      reason: "acceptance-local-cursor"
    });
    const approvals = await callJsonTool(client, "cursor_permission_list", {});
    const latest = Array.isArray(approvals?.approvals)
      ? approvals.approvals.find((item) => item.sessionId === sessionId && item.requestedAction === "chat_send")
      : null;
    if (!latest?.id) {
      throw new Error(`Local acceptance failed: approval not found for session ${sessionId}`);
    }
    await callJsonTool(client, "cursor_permission_grant", { approvalId: latest.id, adminToken });
    const refreshed = await callJsonTool(client, "cursor_local_target_refresh", { adminToken });
    if (!refreshed?.ok || !Array.isArray(refreshed.targets) || refreshed.targets.length < 1) {
      throw new Error(`Local acceptance failed: invalid target refresh response ${JSON.stringify(refreshed)}`);
    }
    const listed = await callJsonTool(client, "cursor_local_target_list", {});
    if (!listed?.ok || !Array.isArray(listed.targets) || listed.targets.length < 1) {
      throw new Error(`Local acceptance failed: invalid target list response ${JSON.stringify(listed)}`);
    }
    const activeTarget = listed.targets.find((item) => item?.active === true) ?? listed.targets[0];
    if (!activeTarget?.targetCursor) {
      throw new Error(`Local acceptance failed: no valid targetCursor in list ${JSON.stringify(listed.targets)}`);
    }
    await callJsonTool(client, "cursor_local_session_bind", {
      sessionId,
      targetCursor: activeTarget.targetCursor,
      workspacePath: root,
      windowLabel: "Acceptance Window",
      adminToken
    });
    const sent = await callJsonTool(client, "cursor_session_send_message", {
      sessionId,
      content: "请回显 local_cursor 验收",
      sourceChannel: "openclaw",
      sourceUserId: "acceptance-script"
    });
    const reply = String(sent?.reply ?? "");
    if (!reply.includes("LocalCursorMock:") || !reply.includes(activeTarget.targetCursor)) {
      throw new Error(`Local acceptance failed: unexpected reply ${reply}`);
    }
    await callJsonTool(client, "cursor_local_session_unbind", { sessionId, adminToken });
  } finally {
    await client.close();
  }
}

async function callJsonTool(client, name, args) {
  const resp = await client.callTool({ name, arguments: args });
  const text = resp.content?.[0]?.text ?? "";
  return JSON.parse(text);
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
