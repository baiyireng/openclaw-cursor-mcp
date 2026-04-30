import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  addAuditLog,
  addMessage,
  createApproval,
  createSession,
  getApprovalById,
  getSessionById,
  getIdempotencyResult,
  hasGrantedPermission,
  listApprovals,
  listAuditLogs,
  listSessionSummaries,
  setSessionStatus,
  setIdempotencyResult,
  updateApprovalStatus,
  type PermissionAction
} from "./db.js";

const execFileAsync = promisify(execFile);

class CursorAdapter {
  async sendMessage(sessionId: string, text: string, traceId: string): Promise<string> {
    const mode = process.env.CURSOR_ADAPTER_MODE ?? "mock";
    if (mode === "http") {
      return this.sendByHttp(sessionId, text, traceId);
    }
    if (mode === "cli") {
      return this.sendByCli(sessionId, text, traceId);
    }
    return this.sendByMock(sessionId, text, traceId);
  }

  private async sendByMock(sessionId: string, text: string, traceId: string): Promise<string> {
    const baseUrl = process.env.CURSOR_API_BASEURL;
    if (!baseUrl) {
      return `Cursor(模拟响应): 已收到会话 ${sessionId} 的消息 -> ${text} [traceId=${traceId}]`;
    }
    return `Cursor(占位): 已配置 CURSOR_API_BASEURL=${baseUrl}，请接入真实发送逻辑。`;
  }

  private async sendByHttp(sessionId: string, text: string, traceId: string): Promise<string> {
    const baseUrl = process.env.CURSOR_API_BASEURL;
    if (!baseUrl) {
      throw new Error("CURSOR_API_BASEURL is required when CURSOR_ADAPTER_MODE=http");
    }
    const endpoint = process.env.CURSOR_API_ENDPOINT ?? "/chat";
    const url = `${baseUrl.replace(/\/$/, "")}${endpoint}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-trace-id": traceId
      },
      body: JSON.stringify({ sessionId, message: text, traceId })
    });
    if (!resp.ok) {
      throw new Error(`Cursor HTTP adapter failed: ${resp.status} ${resp.statusText}`);
    }
    const data = (await resp.json()) as { reply?: string };
    return data.reply ?? JSON.stringify(data);
  }

  private async sendByCli(sessionId: string, text: string, traceId: string): Promise<string> {
    const cmd = process.env.CURSOR_CLI_CMD;
    if (!cmd) {
      throw new Error("CURSOR_CLI_CMD is required when CURSOR_ADAPTER_MODE=cli");
    }
    const args = [sessionId, text];
    const { stdout } = await execFileAsync(cmd, args, {
      windowsHide: true,
      env: { ...process.env, OPENCLAW_TRACE_ID: traceId }
    });
    return stdout.trim();
  }
}

const cursorAdapter = new CursorAdapter();

const createSessionInput = z.object({
  title: z.string().min(1).max(120).default("OpenClaw Session")
});

const sendMessageInput = z.object({
  sessionId: z.string().min(1),
  content: z.string().min(1),
  idempotencyKey: z.string().min(8).max(120).optional(),
  callerId: z.string().min(1).max(120).optional()
});

const getSessionInput = z.object({
  sessionId: z.string().min(1)
});

const requestApprovalInput = z.object({
  sessionId: z.string().min(1),
  requestedAction: z.enum(["chat_send", "filesystem_write", "shell_exec", "network_access"]),
  reason: z.string().min(1).max(500),
  expiresInMs: z.number().int().min(60_000).max(30 * 24 * 60 * 60 * 1000).optional()
});

const updateApprovalInput = z.object({
  approvalId: z.string().min(1),
  adminToken: z.string().min(1)
});

const listAuditInput = z.object({
  limit: z.number().int().min(1).max(500).default(100)
});

const metricsInput = z.object({
  lookbackHours: z.number().int().min(1).max(168).default(24),
  limit: z.number().int().min(50).max(5000).default(1000)
});

const gatewayConfigGetInput = z.object({
  adminToken: z.string().min(1)
});

const gatewayConfigUpdateInput = z.object({
  adminToken: z.string().min(1),
  patch: z.record(z.unknown())
});

const gatewayProcessInput = z.object({
  adminToken: z.string().min(1)
});

const gatewayLogsInput = z.object({
  adminToken: z.string().min(1),
  lines: z.number().int().min(1).max(2000).default(200)
});

const server = new Server(
  { name: "openclaw-cursor-mcp", version: "0.2.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "cursor_session_create",
      description: "Create a Cursor conversation session",
      inputSchema: { type: "object", properties: { title: { type: "string" } }, required: [] }
    },
    {
      name: "cursor_session_send_message",
      description: "Send a message to a Cursor session (requires granted chat_send permission)",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          content: { type: "string" },
          idempotencyKey: { type: "string", description: "Optional deduplication key for retries" },
          callerId: {
            type: "string",
            description: "Optional caller identity used by default idempotency key generation"
          }
        },
        required: ["sessionId", "content"]
      }
    },
    {
      name: "cursor_session_get",
      description: "Get full session data by id",
      inputSchema: {
        type: "object",
        properties: { sessionId: { type: "string" } },
        required: ["sessionId"]
      }
    },
    {
      name: "cursor_session_list",
      description: "List existing session summaries",
      inputSchema: { type: "object", properties: {}, required: [] }
    },
    {
      name: "cursor_permission_request",
      description: "Request an approval for a privileged action",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          requestedAction: { type: "string", enum: ["chat_send", "filesystem_write", "shell_exec", "network_access"] },
          reason: { type: "string" },
          expiresInMs: {
            type: "number",
            description: "Optional approval validity in milliseconds (default from OPENCLAW_PERMISSION_TTL_MS)"
          }
        },
        required: ["sessionId", "requestedAction", "reason"]
      }
    },
    {
      name: "cursor_permission_grant",
      description: "Grant a pending approval request",
      inputSchema: {
        type: "object",
        properties: { approvalId: { type: "string" }, adminToken: { type: "string" } },
        required: ["approvalId", "adminToken"]
      }
    },
    {
      name: "cursor_permission_revoke",
      description: "Revoke an existing approval request",
      inputSchema: {
        type: "object",
        properties: { approvalId: { type: "string" }, adminToken: { type: "string" } },
        required: ["approvalId", "adminToken"]
      }
    },
    {
      name: "cursor_permission_list",
      description: "List all approval records",
      inputSchema: { type: "object", properties: {}, required: [] }
    },
    {
      name: "cursor_audit_list",
      description: "List audit logs",
      inputSchema: { type: "object", properties: { limit: { type: "number" } }, required: [] }
    },
    {
      name: "cursor_metrics_get",
      description: "Get lightweight reliability metrics aggregated from audit logs",
      inputSchema: {
        type: "object",
        properties: {
          lookbackHours: { type: "number", description: "Lookback window in hours (default 24)" },
          limit: { type: "number", description: "Max audit rows scanned (default 1000)" }
        },
        required: []
      }
    },
    {
      name: "cursor_gateway_config_get",
      description: "Read gateway config JSON (admin token required)",
      inputSchema: {
        type: "object",
        properties: {
          adminToken: { type: "string" }
        },
        required: ["adminToken"]
      }
    },
    {
      name: "cursor_gateway_config_update",
      description: "Update gateway config JSON with deep-merge patch (admin token required)",
      inputSchema: {
        type: "object",
        properties: {
          adminToken: { type: "string" },
          patch: { type: "object", additionalProperties: true }
        },
        required: ["adminToken", "patch"]
      }
    },
    {
      name: "cursor_gateway_process_status",
      description: "Get gateway process status (admin token required)",
      inputSchema: {
        type: "object",
        properties: {
          adminToken: { type: "string" }
        },
        required: ["adminToken"]
      }
    },
    {
      name: "cursor_gateway_process_start",
      description: "Start gateway process via manager (admin token required)",
      inputSchema: {
        type: "object",
        properties: {
          adminToken: { type: "string" }
        },
        required: ["adminToken"]
      }
    },
    {
      name: "cursor_gateway_process_stop",
      description: "Stop gateway process via manager (admin token required)",
      inputSchema: {
        type: "object",
        properties: {
          adminToken: { type: "string" }
        },
        required: ["adminToken"]
      }
    },
    {
      name: "cursor_gateway_process_restart",
      description: "Restart gateway process via manager (admin token required)",
      inputSchema: {
        type: "object",
        properties: {
          adminToken: { type: "string" }
        },
        required: ["adminToken"]
      }
    },
    {
      name: "cursor_gateway_process_logs",
      description: "Read recent gateway logs via manager (admin token required)",
      inputSchema: {
        type: "object",
        properties: {
          adminToken: { type: "string" },
          lines: { type: "number", description: "Max lines from log tail (default 200)" }
        },
        required: ["adminToken"]
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "cursor_session_create") {
    const input = createSessionInput.parse(args ?? {});
    const id = randomUUID();
    const now = new Date().toISOString();
    await createSession(id, input.title, now);
    await addAuditLog("session.create", { title: input.title }, now, id);
    const session = await getSessionById(id);
    return toText({ ok: true, session });
  }

  if (name === "cursor_session_send_message") {
    const input = sendMessageInput.parse(args ?? {});
    const traceId = randomUUID();
    const effectiveIdempotencyKey = input.idempotencyKey ?? createDefaultIdempotencyKey(input);
    const cached = await getIdempotencyResult(effectiveIdempotencyKey);
    if (cached) {
      return { content: [{ type: "text", text: cached }] };
    }
    const session = await getSessionById(input.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${input.sessionId}`);
    }

    const allowed = await hasGrantedPermission(input.sessionId, "chat_send");
    if (!allowed) {
      const now = new Date().toISOString();
      await addAuditLog(
        "session.send_message.blocked",
        { reason: "chat_send permission not granted", traceId },
        now,
        input.sessionId
      );
      throw new Error(`Permission denied: session ${input.sessionId} has no granted chat_send approval`);
    }

    const startedAt = new Date().toISOString();
    await setSessionStatus(input.sessionId, "running", startedAt);
    await addMessage(input.sessionId, "user", input.content, startedAt);
    await addAuditLog(
      "session.message.user",
      { content: input.content, traceId, idempotencyKey: effectiveIdempotencyKey },
      startedAt,
      input.sessionId
    );

    try {
      const reply = await cursorAdapter.sendMessage(input.sessionId, input.content, traceId);
      const finishedAt = new Date().toISOString();
      await addMessage(input.sessionId, "assistant", reply, finishedAt);
      await setSessionStatus(input.sessionId, "idle", finishedAt);
      await addAuditLog("session.message.assistant", { reply, traceId }, finishedAt, input.sessionId);
      const responsePayload = {
        ok: true,
        sessionId: input.sessionId,
        reply,
        traceId,
        idempotencyKey: effectiveIdempotencyKey
      };
      await setIdempotencyResult(effectiveIdempotencyKey, JSON.stringify(responsePayload, null, 2));
      return toText(responsePayload);
    } catch (error) {
      const failedAt = new Date().toISOString();
      await setSessionStatus(input.sessionId, "error", failedAt);
      await addAuditLog("session.send_message.error", { message: String(error), traceId }, failedAt, input.sessionId);
      throw error;
    }
  }

  if (name === "cursor_session_get") {
    const input = getSessionInput.parse(args ?? {});
    const session = await getSessionById(input.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${input.sessionId}`);
    }
    return toText({ ok: true, session });
  }

  if (name === "cursor_session_list") {
    return toText({ ok: true, sessions: await listSessionSummaries() });
  }

  if (name === "cursor_permission_request") {
    const input = requestApprovalInput.parse(args ?? {});
    const session = await getSessionById(input.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${input.sessionId}`);
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const expiresAt = resolveApprovalExpiresAt(now, input.expiresInMs);
    await createApproval(id, input.sessionId, input.requestedAction, input.reason, now, expiresAt);
    await addAuditLog(
      "permission.request",
      { requestedAction: input.requestedAction, reason: input.reason, expiresAt },
      now,
      input.sessionId,
      id
    );
    const approval = await getApprovalById(id);
    return toText({ ok: true, approval: normalizeApproval(approval) });
  }

  if (name === "cursor_permission_grant") {
    const input = updateApprovalInput.parse(args ?? {});
    assertAdminToken(input.adminToken);
    const now = new Date().toISOString();
    const updated = await updateApprovalStatus(input.approvalId, "granted", now);
    if (!updated) {
      throw new Error(`Approval not found: ${input.approvalId}`);
    }
    const approval = await getApprovalById(input.approvalId);
    await addAuditLog("permission.grant", {}, now, approval?.session_id, input.approvalId);
    return toText({ ok: true, approval: normalizeApproval(approval) });
  }

  if (name === "cursor_permission_revoke") {
    const input = updateApprovalInput.parse(args ?? {});
    assertAdminToken(input.adminToken);
    const now = new Date().toISOString();
    const updated = await updateApprovalStatus(input.approvalId, "revoked", now);
    if (!updated) {
      throw new Error(`Approval not found: ${input.approvalId}`);
    }
    const approval = await getApprovalById(input.approvalId);
    await addAuditLog("permission.revoke", {}, now, approval?.session_id, input.approvalId);
    return toText({ ok: true, approval: normalizeApproval(approval) });
  }

  if (name === "cursor_permission_list") {
    return toText({ ok: true, approvals: await listApprovals() });
  }

  if (name === "cursor_audit_list") {
    const input = listAuditInput.parse(args ?? {});
    const logs = await listAuditLogs(input.limit);
    return toText({
      ok: true,
      logs: logs.map((row) => ({
        id: row.id,
        eventType: row.event_type,
        sessionId: row.session_id,
        approvalId: row.approval_id,
        detail: safeParseJson(row.detail_json),
        createdAt: row.created_at
      }))
    });
  }

  if (name === "cursor_metrics_get") {
    const input = metricsInput.parse(args ?? {});
    const logs = await listAuditLogs(input.limit);
    const metrics = computeMetrics(logs, input.lookbackHours);
    return toText({ ok: true, metrics });
  }

  if (name === "cursor_gateway_config_get") {
    const input = gatewayConfigGetInput.parse(args ?? {});
    assertAdminToken(input.adminToken);
    const config = await readGatewayConfig();
    await addAuditLog("gateway.config.get", { keys: Object.keys(config) }, new Date().toISOString());
    return toText({ ok: true, configPath: getGatewayConfigPath(), config });
  }

  if (name === "cursor_gateway_config_update") {
    const input = gatewayConfigUpdateInput.parse(args ?? {});
    assertAdminToken(input.adminToken);
    const current = await readGatewayConfig();
    const merged = deepMergeJson(current, input.patch);
    await writeGatewayConfig(merged);
    await addAuditLog(
      "gateway.config.update",
      { updatedTopLevelKeys: Object.keys(input.patch) },
      new Date().toISOString()
    );
    return toText({ ok: true, configPath: getGatewayConfigPath(), config: merged });
  }

  if (name === "cursor_gateway_process_status") {
    const input = gatewayProcessInput.parse(args ?? {});
    assertAdminToken(input.adminToken);
    const output = await runGatewayManager("status");
    await addAuditLog("gateway.process.status", { invokedBy: "mcp" }, new Date().toISOString());
    return toText({ ok: true, output });
  }

  if (name === "cursor_gateway_process_start") {
    const input = gatewayProcessInput.parse(args ?? {});
    assertAdminToken(input.adminToken);
    const output = await runGatewayManager("start");
    await addAuditLog("gateway.process.start", { invokedBy: "mcp" }, new Date().toISOString());
    return toText({ ok: true, output });
  }

  if (name === "cursor_gateway_process_stop") {
    const input = gatewayProcessInput.parse(args ?? {});
    assertAdminToken(input.adminToken);
    const output = await runGatewayManager("stop");
    await addAuditLog("gateway.process.stop", { invokedBy: "mcp" }, new Date().toISOString());
    return toText({ ok: true, output });
  }

  if (name === "cursor_gateway_process_restart") {
    const input = gatewayProcessInput.parse(args ?? {});
    assertAdminToken(input.adminToken);
    const output = await runGatewayManager("restart");
    await addAuditLog("gateway.process.restart", { invokedBy: "mcp" }, new Date().toISOString());
    return toText({ ok: true, output });
  }

  if (name === "cursor_gateway_process_logs") {
    const input = gatewayLogsInput.parse(args ?? {});
    assertAdminToken(input.adminToken);
    const output = await runGatewayManager("logs");
    const lines = output.split(/\r?\n/).filter(Boolean);
    const tail = lines.slice(-input.lines).join("\n");
    await addAuditLog("gateway.process.logs", { invokedBy: "mcp", lines: input.lines }, new Date().toISOString());
    return toText({ ok: true, lines: input.lines, output: tail });
  }

  throw new Error(`Unknown tool: ${name}`);
});

function normalizeApproval(
  approval:
    | {
        id: string;
        session_id: string;
        requested_action: PermissionAction;
        reason: string;
        status: "pending" | "granted" | "revoked";
        requested_at: string;
        updated_at: string;
        expires_at: string | null;
      }
    | undefined
) {
  if (!approval) {
    return null;
  }
  return {
    id: approval.id,
    sessionId: approval.session_id,
    requestedAction: approval.requested_action,
    reason: approval.reason,
    status: approval.status,
    requestedAt: approval.requested_at,
    updatedAt: approval.updated_at,
    expiresAt: approval.expires_at
  };
}

function safeParseJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function toText(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function assertAdminToken(inputToken: string) {
  const expected = process.env.OPENCLAW_ADMIN_TOKEN;
  if (!expected) {
    throw new Error("OPENCLAW_ADMIN_TOKEN is not configured");
  }
  if (inputToken !== expected) {
    throw new Error("Invalid adminToken");
  }
}

function createDefaultIdempotencyKey(input: z.infer<typeof sendMessageInput>) {
  const normalized = input.content.trim().replace(/\s+/g, " ");
  const caller = input.callerId ?? "anonymous";
  return createHash("sha256")
    .update(`${input.sessionId}|${caller}|${normalized}`)
    .digest("hex")
    .slice(0, 48);
}

function resolveApprovalExpiresAt(nowIso: string, expiresInMs?: number) {
  const defaultTtlMs = toPositiveInt(process.env.OPENCLAW_PERMISSION_TTL_MS, 24 * 60 * 60 * 1000);
  const ttlMs = expiresInMs ?? defaultTtlMs;
  return new Date(Date.parse(nowIso) + ttlMs).toISOString();
}

function toPositiveInt(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function computeMetrics(
  logs: Array<{
    id: number;
    event_type: string;
    session_id: string | null;
    approval_id: string | null;
    detail_json: string;
    created_at: string;
  }>,
  lookbackHours: number
) {
  const now = Date.now();
  const sinceMs = now - lookbackHours * 60 * 60 * 1000;
  const inWindow = logs.filter((row) => Date.parse(row.created_at) >= sinceMs);
  const totals = {
    totalRequests: 0,
    successfulReplies: 0,
    failedReplies: 0,
    blockedByPermission: 0,
    timeoutErrors: 0
  };
  const startByTraceId = new Map<string, number>();
  const latenciesMs: number[] = [];

  for (const row of inWindow) {
    const detail = safeParseJson(row.detail_json);
    const traceId = typeof detail?.traceId === "string" ? detail.traceId : "";
    if (row.event_type === "session.message.user") {
      totals.totalRequests += 1;
      if (traceId) {
        startByTraceId.set(traceId, Date.parse(row.created_at));
      }
      continue;
    }
    if (row.event_type === "session.message.assistant") {
      totals.successfulReplies += 1;
      if (traceId) {
        const startAt = startByTraceId.get(traceId);
        const endAt = Date.parse(row.created_at);
        if (startAt !== undefined && Number.isFinite(startAt) && Number.isFinite(endAt) && endAt >= startAt) {
          latenciesMs.push(endAt - startAt);
        }
      }
      continue;
    }
    if (row.event_type === "session.send_message.blocked") {
      totals.blockedByPermission += 1;
      continue;
    }
    if (row.event_type === "session.send_message.error") {
      totals.failedReplies += 1;
      const message = String(detail?.message ?? "").toLowerCase();
      if (message.includes("timeout") || message.includes("timed out")) {
        totals.timeoutErrors += 1;
      }
    }
  }

  const avgLatencyMs = latenciesMs.length > 0 ? Math.round(latenciesMs.reduce((a, b) => a + b, 0) / latenciesMs.length) : null;
  const successRate = totals.totalRequests > 0 ? round4(totals.successfulReplies / totals.totalRequests) : null;
  const timeoutRate = totals.totalRequests > 0 ? round4(totals.timeoutErrors / totals.totalRequests) : null;
  const permissionBlockedRate = totals.totalRequests > 0 ? round4(totals.blockedByPermission / totals.totalRequests) : null;

  return {
    window: {
      lookbackHours,
      since: new Date(sinceMs).toISOString(),
      until: new Date(now).toISOString(),
      scannedRows: inWindow.length
    },
    totals,
    rates: {
      successRate,
      timeoutRate,
      permissionBlockedRate
    },
    latency: {
      avgMs: avgLatencyMs,
      samples: latenciesMs.length
    }
  };
}

function round4(n: number) {
  return Math.round(n * 10000) / 10000;
}

function getGatewayConfigPath() {
  const configured = process.env.CURSOR_GATEWAY_CONFIG_PATH;
  if (configured) {
    return isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
  }
  return resolve(process.cwd(), "gateway/config/gateway.config.json");
}

async function readGatewayConfig() {
  const configPath = getGatewayConfigPath();
  try {
    const text = await readFile(configPath, "utf8");
    const parsed = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeGatewayConfig(config: Record<string, unknown>) {
  const configPath = getGatewayConfigPath();
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
}

function deepMergeJson(target: Record<string, unknown>, patch: Record<string, unknown>) {
  const output: Record<string, unknown> = { ...target };
  for (const [key, patchValue] of Object.entries(patch)) {
    const currentValue = output[key];
    if (isPlainObject(currentValue) && isPlainObject(patchValue)) {
      output[key] = deepMergeJson(currentValue, patchValue);
      continue;
    }
    output[key] = patchValue;
  }
  return output;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function runGatewayManager(
  action: "start" | "stop" | "restart" | "status" | "logs"
) {
  const managerPath = resolve(process.cwd(), "gateway/manage.mjs");
  const { stdout, stderr } = await execFileAsync(process.execPath, [managerPath, action], {
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024
  });
  const text = [stdout, stderr].filter(Boolean).join("").trim();
  return text || "(no output)";
}

async function main() {
  await loadRuntimeEnvFile();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function loadRuntimeEnvFile() {
  const configured = process.env.OPENCLAW_ENV_FILE ?? ".env.local";
  const envFilePath = isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
  try {
    const text = await readFile(envFilePath, "utf8");
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) {
        continue;
      }
      const sep = line.indexOf("=");
      if (sep <= 0) {
        continue;
      }
      const key = line.slice(0, sep).trim();
      const value = line.slice(sep + 1).trim().replace(/^"(.*)"$/, "$1");
      if (process.env[key] === undefined || process.env[key] === "") {
        process.env[key] = value;
      }
    }
  } catch {
    // optional env file; ignore when missing
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
