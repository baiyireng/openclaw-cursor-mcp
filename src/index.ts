import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
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
  async sendMessage(sessionId: string, text: string): Promise<string> {
    const mode = process.env.CURSOR_ADAPTER_MODE ?? "mock";
    if (mode === "http") {
      return this.sendByHttp(sessionId, text);
    }
    if (mode === "cli") {
      return this.sendByCli(sessionId, text);
    }
    return this.sendByMock(sessionId, text);
  }

  private async sendByMock(sessionId: string, text: string): Promise<string> {
    const baseUrl = process.env.CURSOR_API_BASEURL;
    if (!baseUrl) {
      return `Cursor(模拟响应): 已收到会话 ${sessionId} 的消息 -> ${text}`;
    }
    return `Cursor(占位): 已配置 CURSOR_API_BASEURL=${baseUrl}，请接入真实发送逻辑。`;
  }

  private async sendByHttp(sessionId: string, text: string): Promise<string> {
    const baseUrl = process.env.CURSOR_API_BASEURL;
    if (!baseUrl) {
      throw new Error("CURSOR_API_BASEURL is required when CURSOR_ADAPTER_MODE=http");
    }
    const endpoint = process.env.CURSOR_API_ENDPOINT ?? "/chat";
    const url = `${baseUrl.replace(/\/$/, "")}${endpoint}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, message: text })
    });
    if (!resp.ok) {
      throw new Error(`Cursor HTTP adapter failed: ${resp.status} ${resp.statusText}`);
    }
    const data = (await resp.json()) as { reply?: string };
    return data.reply ?? JSON.stringify(data);
  }

  private async sendByCli(sessionId: string, text: string): Promise<string> {
    const cmd = process.env.CURSOR_CLI_CMD;
    if (!cmd) {
      throw new Error("CURSOR_CLI_CMD is required when CURSOR_ADAPTER_MODE=cli");
    }
    const args = [sessionId, text];
    const { stdout } = await execFileAsync(cmd, args, { windowsHide: true });
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
  idempotencyKey: z.string().min(8).max(120).optional()
});

const getSessionInput = z.object({
  sessionId: z.string().min(1)
});

const requestApprovalInput = z.object({
  sessionId: z.string().min(1),
  requestedAction: z.enum(["chat_send", "filesystem_write", "shell_exec", "network_access"]),
  reason: z.string().min(1).max(500)
});

const updateApprovalInput = z.object({
  approvalId: z.string().min(1),
  adminToken: z.string().min(1)
});

const listAuditInput = z.object({
  limit: z.number().int().min(1).max(500).default(100)
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
          idempotencyKey: { type: "string", description: "Optional deduplication key for retries" }
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
          reason: { type: "string" }
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
    if (input.idempotencyKey) {
      const cached = await getIdempotencyResult(input.idempotencyKey);
      if (cached) {
        return { content: [{ type: "text", text: cached }] };
      }
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
        { reason: "chat_send permission not granted" },
        now,
        input.sessionId
      );
      throw new Error(`Permission denied: session ${input.sessionId} has no granted chat_send approval`);
    }

    const startedAt = new Date().toISOString();
    await setSessionStatus(input.sessionId, "running", startedAt);
    await addMessage(input.sessionId, "user", input.content, startedAt);
    await addAuditLog("session.message.user", { content: input.content }, startedAt, input.sessionId);

    try {
      const reply = await cursorAdapter.sendMessage(input.sessionId, input.content);
      const finishedAt = new Date().toISOString();
      await addMessage(input.sessionId, "assistant", reply, finishedAt);
      await setSessionStatus(input.sessionId, "idle", finishedAt);
      await addAuditLog("session.message.assistant", { reply }, finishedAt, input.sessionId);
      const responsePayload = { ok: true, sessionId: input.sessionId, reply };
      if (input.idempotencyKey) {
        await setIdempotencyResult(input.idempotencyKey, JSON.stringify(responsePayload, null, 2));
      }
      return toText(responsePayload);
    } catch (error) {
      const failedAt = new Date().toISOString();
      await setSessionStatus(input.sessionId, "error", failedAt);
      await addAuditLog("session.send_message.error", { message: String(error) }, failedAt, input.sessionId);
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
    await createApproval(id, input.sessionId, input.requestedAction, input.reason, now);
    await addAuditLog(
      "permission.request",
      { requestedAction: input.requestedAction, reason: input.reason },
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
    updatedAt: approval.updated_at
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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
