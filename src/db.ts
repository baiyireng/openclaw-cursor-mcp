import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type Role = "user" | "assistant" | "system";
export type PermissionAction = "chat_send" | "filesystem_write" | "shell_exec" | "network_access";
export type SessionStatus = "idle" | "running" | "error";
export type ApprovalStatus = "pending" | "granted" | "revoked";

export interface SessionSummary {
  id: string;
  title: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

interface SessionRecord {
  id: string;
  title: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
}

interface MessageRecord {
  id: number;
  sessionId: string;
  role: Role;
  content: string;
  createdAt: string;
}

interface ApprovalRecord {
  id: string;
  sessionId: string;
  requestedAction: PermissionAction;
  reason: string;
  status: ApprovalStatus;
  requestedAt: string;
  updatedAt: string;
  expiresAt?: string;
}

interface AuditRecord {
  id: number;
  eventType: string;
  sessionId?: string;
  approvalId?: string;
  detailJson: string;
  createdAt: string;
}

interface LocalCursorBindingRecord {
  sessionId: string;
  targetCursor: string;
  workspacePath?: string;
  windowLabel?: string;
  updatedAt: string;
}

interface DbState {
  sessions: SessionRecord[];
  messages: MessageRecord[];
  approvals: ApprovalRecord[];
  auditLogs: AuditRecord[];
  counters: {
    messageId: number;
    auditId: number;
  };
  idempotency: Record<string, string>;
  localCursorBindings: LocalCursorBindingRecord[];
}

const dbPath = process.env.OPENCLAW_CURSOR_DB_PATH ?? "./data/openclaw-cursor-db.json";
let loadedState: DbState | null = null;

async function loadState(): Promise<DbState> {
  if (loadedState) {
    return loadedState;
  }
  await mkdir(dirname(dbPath), { recursive: true });
  try {
    const text = await readFile(dbPath, "utf8");
    loadedState = JSON.parse(text) as DbState;
  } catch {
    loadedState = {
      sessions: [],
      messages: [],
      approvals: [],
      auditLogs: [],
      counters: { messageId: 0, auditId: 0 },
      idempotency: {},
      localCursorBindings: []
    };
    await persistState();
  }
  if (!loadedState.idempotency) {
    loadedState.idempotency = {};
  }
  if (!loadedState.localCursorBindings) {
    loadedState.localCursorBindings = [];
  }
  return loadedState;
}

async function persistState(): Promise<void> {
  if (!loadedState) {
    return;
  }
  await writeFile(dbPath, JSON.stringify(loadedState, null, 2), "utf8");
}

async function mutateState(mutator: (state: DbState) => void): Promise<void> {
  const state = await loadState();
  mutator(state);
  await persistState();
}

export async function createSession(id: string, title: string, now: string): Promise<void> {
  await mutateState((state) => {
    state.sessions.push({ id, title, status: "idle", createdAt: now, updatedAt: now });
  });
}

export async function setSessionStatus(sessionId: string, status: SessionStatus, updatedAt: string): Promise<void> {
  await mutateState((state) => {
    const target = state.sessions.find((item) => item.id === sessionId);
    if (target) {
      target.status = status;
      target.updatedAt = updatedAt;
    }
  });
}

export async function addMessage(sessionId: string, role: Role, content: string, createdAt: string): Promise<void> {
  await mutateState((state) => {
    state.counters.messageId += 1;
    state.messages.push({
      id: state.counters.messageId,
      sessionId,
      role,
      content,
      createdAt
    });
  });
}

export async function getSessionById(sessionId: string) {
  const state = await loadState();
  const session = state.sessions.find((item) => item.id === sessionId);

  if (!session) {
    return null;
  }

  const messages = state.messages
    .filter((item) => item.sessionId === sessionId)
    .sort((a, b) => a.id - b.id);

  return {
    id: session.id,
    title: session.title,
    status: session.status as SessionStatus,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messages: messages.map((m) => ({
      role: m.role,
      content: m.content,
      createdAt: m.createdAt
    }))
  };
}

export async function listSessionSummaries(): Promise<SessionSummary[]> {
  const state = await loadState();
  return state.sessions
    .map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      messageCount: state.messages.filter((m) => m.sessionId === row.id).length
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function createApproval(
  id: string,
  sessionId: string,
  requestedAction: PermissionAction,
  reason: string,
  now: string,
  expiresAt?: string
): Promise<void> {
  await mutateState((state) => {
    state.approvals.push({
      id,
      sessionId,
      requestedAction,
      reason,
      status: "pending",
      requestedAt: now,
      updatedAt: now,
      expiresAt
    });
  });
}

export async function updateApprovalStatus(
  approvalId: string,
  status: ApprovalStatus,
  now: string
): Promise<boolean> {
  let changed = false;
  await mutateState((state) => {
    const target = state.approvals.find((item) => item.id === approvalId);
    if (target) {
      target.status = status;
      target.updatedAt = now;
      changed = true;
    }
  });
  return changed;
}

export async function getApprovalById(approvalId: string) {
  const state = await loadState();
  const approval = state.approvals.find((item) => item.id === approvalId);
  if (!approval) {
    return undefined;
  }
  return {
    id: approval.id,
    session_id: approval.sessionId,
    requested_action: approval.requestedAction,
    reason: approval.reason,
    status: approval.status,
    requested_at: approval.requestedAt,
    updated_at: approval.updatedAt,
    expires_at: approval.expiresAt ?? null
  };
}

export async function listApprovals() {
  const state = await loadState();
  return state.approvals
    .slice()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((r) => ({
    id: r.id,
    sessionId: r.sessionId,
    requestedAction: r.requestedAction,
    reason: r.reason,
    status: r.status,
    requestedAt: r.requestedAt,
    updatedAt: r.updatedAt,
    expiresAt: r.expiresAt ?? null
  }));
}

export async function hasGrantedPermission(sessionId: string, requestedAction: PermissionAction): Promise<boolean> {
  const state = await loadState();
  const rows = state.approvals
    .filter((item) => item.sessionId === sessionId && item.requestedAction === requestedAction)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const latest = rows[0];
  if (!latest || latest.status !== "granted") {
    return false;
  }
  if (!latest.expiresAt) {
    return true;
  }
  return Date.now() < Date.parse(latest.expiresAt);
}

export async function addAuditLog(
  eventType: string,
  detail: unknown,
  createdAt: string,
  sessionId?: string,
  approvalId?: string
): Promise<void> {
  await mutateState((state) => {
    state.counters.auditId += 1;
    state.auditLogs.push({
      id: state.counters.auditId,
      eventType,
      sessionId,
      approvalId,
      detailJson: JSON.stringify(detail),
      createdAt
    });
  });
}

export async function listAuditLogs(limit = 100) {
  const state = await loadState();
  return state.auditLogs
    .slice()
    .sort((a, b) => b.id - a.id)
    .slice(0, limit)
    .map((item) => ({
      id: item.id,
      event_type: item.eventType,
      session_id: item.sessionId ?? null,
      approval_id: item.approvalId ?? null,
      detail_json: item.detailJson,
      created_at: item.createdAt
    }));
}

export async function getIdempotencyResult(key: string): Promise<string | undefined> {
  const state = await loadState();
  return state.idempotency[key];
}

export async function setIdempotencyResult(key: string, responseText: string): Promise<void> {
  await mutateState((state) => {
    state.idempotency[key] = responseText;
  });
}

export async function upsertLocalCursorBinding(
  sessionId: string,
  targetCursor: string,
  updatedAt: string,
  workspacePath?: string,
  windowLabel?: string
): Promise<void> {
  await mutateState((state) => {
    const existing = state.localCursorBindings.find((item) => item.sessionId === sessionId);
    if (existing) {
      existing.targetCursor = targetCursor;
      existing.workspacePath = workspacePath;
      existing.windowLabel = windowLabel;
      existing.updatedAt = updatedAt;
      return;
    }
    state.localCursorBindings.push({
      sessionId,
      targetCursor,
      workspacePath,
      windowLabel,
      updatedAt
    });
  });
}

export async function getLocalCursorBinding(sessionId: string) {
  const state = await loadState();
  const binding = state.localCursorBindings.find((item) => item.sessionId === sessionId);
  if (!binding) {
    return null;
  }
  return {
    sessionId: binding.sessionId,
    targetCursor: binding.targetCursor,
    workspacePath: binding.workspacePath ?? null,
    windowLabel: binding.windowLabel ?? null,
    updatedAt: binding.updatedAt
  };
}

export async function deleteLocalCursorBinding(sessionId: string): Promise<boolean> {
  let removed = false;
  await mutateState((state) => {
    const before = state.localCursorBindings.length;
    state.localCursorBindings = state.localCursorBindings.filter((item) => item.sessionId !== sessionId);
    removed = state.localCursorBindings.length !== before;
  });
  return removed;
}

export async function listLocalCursorBindings() {
  const state = await loadState();
  return state.localCursorBindings
    .slice()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((item) => ({
      sessionId: item.sessionId,
      targetCursor: item.targetCursor,
      workspacePath: item.workspacePath ?? null,
      windowLabel: item.windowLabel ?? null,
      updatedAt: item.updatedAt
    }));
}
