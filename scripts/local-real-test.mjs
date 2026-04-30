#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = process.cwd();
const envPath = resolve(root, ".env.local");

async function main() {
  const env = await parseEnvFile(envPath);
  const adminToken = env.OPENCLAW_ADMIN_TOKEN;
  if (!adminToken) {
    throw new Error("OPENCLAW_ADMIN_TOKEN is empty in .env.local");
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(root, "dist/index.js")],
    env: {
      ...process.env,
      OPENCLAW_ENV_FILE: ".env.local",
      CURSOR_ADAPTER_MODE: "local_cursor",
      CURSOR_LOCAL_CMD: process.execPath,
      CURSOR_LOCAL_ARGS_JSON: JSON.stringify([
        resolve(root, "gateway/cursor-cli-wrapper.mjs"),
        "{{sessionId}}",
        "{{message}}",
        "{{targetCursor}}"
      ]),
      CURSOR_LOCAL_TARGET_DISCOVERY_CMD: process.execPath,
      CURSOR_LOCAL_TARGET_DISCOVERY_ARGS_JSON: JSON.stringify([resolve(root, "scripts/local-targets-cursor-status.mjs")]),
      CURSOR_LOCAL_TARGETS_PATH: resolve(root, "data/runtime/local-targets.real.json"),
      CURSOR_BRIDGE_MODE: "cursor-agent-json",
      CURSOR_AGENT_CMD: "d:\\cursor\\resources\\app\\bin\\cursor.cmd",
      CURSOR_REAL_CLI_TIMEOUT_MS: process.env.CURSOR_REAL_CLI_TIMEOUT_MS ?? "180000"
    }
  });

  const client = new Client({ name: "local-real-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  try {
    const refresh = await call(client, "cursor_local_target_refresh", { adminToken });
    const targets = refresh.targets ?? [];
    if (!Array.isArray(targets) || targets.length === 0) {
      throw new Error(`No local targets discovered: ${JSON.stringify(refresh)}`);
    }

    const create = await call(client, "cursor_session_create", { title: "local-real-test" });
    const sessionId = create?.session?.id;
    if (!sessionId) {
      throw new Error(`Invalid session create response: ${JSON.stringify(create)}`);
    }

    await call(client, "cursor_permission_request", {
      sessionId,
      requestedAction: "chat_send",
      reason: "local-real-test"
    });
    const approvals = await call(client, "cursor_permission_list", {});
    const latest = Array.isArray(approvals?.approvals)
      ? approvals.approvals.find((item) => item.sessionId === sessionId && item.requestedAction === "chat_send")
      : null;
    if (!latest?.id) {
      throw new Error("Cannot locate approval id for chat_send");
    }
    await call(client, "cursor_permission_grant", { approvalId: latest.id, adminToken });

    const target = targets.find((item) => item?.active === true) ?? targets[0];
    await call(client, "cursor_local_session_bind", {
      sessionId,
      targetCursor: target.targetCursor,
      windowLabel: target.windowLabel ?? "real-window",
      adminToken
    });

    const send = await call(client, "cursor_session_send_message", {
      sessionId,
      content: "请回复：real-local-test-ok",
      sourceChannel: "openclaw",
      sourceUserId: "real-test"
    });
    await call(client, "cursor_local_session_unbind", { sessionId, adminToken });

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          sessionId,
          targetCursor: send.targetCursor ?? target.targetCursor,
          replyPreview: String(send.reply ?? "").slice(0, 200)
        },
        null,
        2
      )}\n`
    );
  } finally {
    await client.close();
  }
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text ?? "{}";
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
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim().replace(/^"(.*)"$/, "$1");
  }
  return out;
}

main().catch((error) => {
  process.stderr.write(`Local real test failed: ${String(error)}\n`);
  process.exit(1);
});
