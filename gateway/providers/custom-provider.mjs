import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const sessionAgentMap = new Map();
let cacheLoaded = false;

export async function generateReply(sessionId, message, context) {
  const env = context?.env ?? process.env;
  const config = context?.config ?? {};
  const traceId = context?.traceId ?? `plugin-${Date.now()}`;
  const baseUrl = String(readConfig(config, env, "CURSOR_CLOUD_API_BASE_URL", "https://api.cursor.com")).replace(/\/$/, "");
  const apiKey = readConfig(config, env, "CURSOR_CLOUD_API_KEY", "");
  const required = toBool(readConfig(config, env, "CURSOR_CLOUD_REQUIRED", false), false);

  if (!apiKey) {
    if (required) {
      throw new Error("CURSOR_CLOUD_API_KEY is required when CURSOR_CLOUD_REQUIRED=true");
    }
    return `Plugin(fallback): missing CURSOR_CLOUD_API_KEY, session=${sessionId}, message=${message}`;
  }

  const workspacePath = String(readConfig(config, env, "CURSOR_CLOUD_WORKSPACE_PATH", "."));
  const repoUrl = String(readConfig(config, env, "CURSOR_CLOUD_REPO_URL", "")).trim();
  const startingRef = String(readConfig(config, env, "CURSOR_CLOUD_REPO_REF", "main")).trim();
  const model = readConfig(config, env, "CURSOR_CLOUD_MODEL", "");
  const pollIntervalMs = toInt(readConfig(config, env, "CURSOR_CLOUD_POLL_INTERVAL_MS", 1500), 1500);
  const timeoutMs = toInt(readConfig(config, env, "CURSOR_CLOUD_TIMEOUT_MS", 120000), 120000);
  const cachePath = String(
    readConfig(config, env, "CURSOR_SESSION_AGENT_CACHE_PATH", "./data/session-agent-map.json")
  );
  const agentTtlMs = toInt(readConfig(config, env, "CURSOR_SESSION_AGENT_TTL_MS", 86400000), 86400000);
  const pollMaxIntervalMs = toInt(readConfig(config, env, "CURSOR_CLOUD_POLL_MAX_INTERVAL_MS", 5000), 5000);
  const pollBackoffMultiplier = toFloat(readConfig(config, env, "CURSOR_CLOUD_POLL_BACKOFF_MULTIPLIER", 1.5), 1.5);

  if (!repoUrl) {
    throw new Error("CURSOR_CLOUD_REPO_URL is required for Cloud Agents API v1");
  }

  const agentId = await ensureAgent(sessionId, {
    baseUrl,
    apiKey,
    model,
    workspacePath,
    repoUrl,
    startingRef,
    cachePath,
    traceId,
    agentTtlMs
  });

  const runInfo = await createRunWithRecovery({
    sessionId,
    baseUrl,
    apiKey,
    agentId,
    message,
    traceId,
    cachePath,
    model,
    workspacePath,
    agentTtlMs,
    timeoutMs,
    pollIntervalMs
  });
  const activeAgentId = runInfo.agentId;
  const run = runInfo.run;

  const runId = pick(run, ["id", "run_id", "runId", "run.id"]);
  if (!runId) {
    throw new Error(`create run succeeded but run id missing: ${JSON.stringify(run)}`);
  }

  const finalState = await waitForRunDone({
    baseUrl,
    apiKey,
    agentId: activeAgentId,
    runId,
    pollIntervalMs,
    pollMaxIntervalMs,
    pollBackoffMultiplier,
    timeoutMs,
    traceId
  });

  const reply = extractReply(finalState);
  if (!reply) {
    return buildReplyFallback({
      traceId,
      reason: "run_completed_without_extractable_reply",
      payload: finalState
    });
  }
  return reply;
}

async function ensureAgent(sessionId, opts) {
  await loadSessionAgentCache(opts.cachePath);
  const cached = getValidCachedAgent(sessionId);
  if (cached?.agentId) {
    return cached.agentId;
  }

  return createAndCacheAgent(sessionId, opts);
}

async function createAndCacheAgent(sessionId, opts) {
  const payload = {
    prompt: {
      text: `Initialize agent context for OpenClaw session ${sessionId}.`
    },
    repos: [
      {
        url: opts.repoUrl,
        startingRef: opts.startingRef || "main"
      }
    ]
  };
  if (opts.model) {
    payload.model = { id: String(opts.model) };
  }

  const created = await postJson(`${opts.baseUrl}/v1/agents`, payload, opts.apiKey, opts.traceId);
  const agentId = pick(created, ["id", "agent_id", "agentId", "agent.id"]);
  if (!agentId) {
    throw new Error(`create agent response missing id: ${JSON.stringify(created)}`);
  }
  const now = Date.now();
  sessionAgentMap.set(sessionId, {
    agentId,
    createdAt: now,
    expiresAt: now + Math.max(1000, opts.agentTtlMs)
  });
  await persistSessionAgentCache(opts.cachePath);
  return agentId;
}

async function createRun({ baseUrl, apiKey, agentId, message, traceId }) {
  return postJson(
    `${baseUrl}/v1/agents/${encodeURIComponent(agentId)}/runs`,
    {
      prompt: {
        text: message
      }
    },
    apiKey,
    traceId
  );
}

async function createRunWithRecovery(opts) {
  try {
    const run = await createRunWithBusyRetry(opts);
    return { run, agentId: opts.agentId };
  } catch (error) {
    if (!isAgentMissingError(error)) {
      throw error;
    }

    sessionAgentMap.delete(opts.sessionId);
    await persistSessionAgentCache(opts.cachePath);
    const refreshedAgentId = await createAndCacheAgent(opts.sessionId, opts);
    const run = await createRunWithBusyRetry({
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      agentId: refreshedAgentId,
      message: opts.message,
      traceId: opts.traceId,
      timeoutMs: opts.timeoutMs ?? 120000,
      pollIntervalMs: opts.pollIntervalMs ?? 1500
    });
    return { run, agentId: refreshedAgentId };
  }
}

async function createRunWithBusyRetry({ baseUrl, apiKey, agentId, message, traceId, timeoutMs = 120000, pollIntervalMs = 1500 }) {
  try {
    return await createRun({ baseUrl, apiKey, agentId, message, traceId });
  } catch (error) {
    if (!isAgentBusyError(error)) {
      throw error;
    }
    await waitUntilAgentIdle({ baseUrl, apiKey, agentId, traceId, timeoutMs, pollIntervalMs });
    return createRun({ baseUrl, apiKey, agentId, message, traceId });
  }
}

async function waitUntilAgentIdle({ baseUrl, apiKey, agentId, traceId, timeoutMs, pollIntervalMs }) {
  const deadline = Date.now() + Math.max(5000, timeoutMs);
  let cancelAttempted = false;
  while (Date.now() < deadline) {
    const list = await getJson(
      `${baseUrl}/v1/agents/${encodeURIComponent(agentId)}/runs?limit=5`,
      apiKey,
      traceId
    );
    const runs = Array.isArray(list?.items) ? list.items : [];
    const active = runs.find((run) => {
      const status = String(pick(run, ["status", "state"]) ?? "").toLowerCase();
      return status === "creating" || status === "running";
    });
    if (!active) {
      return;
    }
    if (!cancelAttempted) {
      const activeRunId = pick(active, ["id", "runId", "run_id"]);
      if (activeRunId) {
        await tryCancelRun({ baseUrl, apiKey, agentId, runId: String(activeRunId), traceId });
        cancelAttempted = true;
      }
    }
    await sleep(Math.min(3000, Math.max(500, pollIntervalMs)));
  }
  throw new Error(`agent_busy wait timeout for agent=${agentId}`);
}

async function tryCancelRun({ baseUrl, apiKey, agentId, runId, traceId }) {
  try {
    await postJson(
      `${baseUrl}/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/cancel`,
      {},
      apiKey,
      traceId
    );
  } catch {
    // best effort
  }
}

async function waitForRunDone({
  baseUrl,
  apiKey,
  agentId,
  runId,
  pollIntervalMs,
  pollMaxIntervalMs,
  pollBackoffMultiplier,
  timeoutMs,
  traceId
}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let attempts = 0;
  let currentIntervalMs = Math.max(100, pollIntervalMs);
  while (Date.now() < deadline) {
    attempts += 1;
    last = await getJson(
      `${baseUrl}/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`,
      apiKey,
      traceId
    );
    const status = String(pick(last, ["status", "state"]) ?? "").toLowerCase();
    if (status === "completed" || status === "succeeded" || status === "finished") {
      return last;
    }
    if (status === "failed" || status === "cancelled" || status === "canceled") {
      throw new Error(`run ended with status=${status}: ${JSON.stringify(last)}`);
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }
    await sleep(Math.min(currentIntervalMs, remainingMs));
    currentIntervalMs = Math.min(
      pollMaxIntervalMs,
      Math.ceil(currentIntervalMs * Math.max(1.01, pollBackoffMultiplier))
    );
  }
  throw new Error(`run timeout after ${timeoutMs}ms, attempts=${attempts}, last=${JSON.stringify(last)}`);
}

async function postJson(url, body, apiKey, traceId) {
  const resp = await fetch(url, {
    method: "POST",
    headers: buildHeaders(apiKey, traceId),
    body: JSON.stringify(body)
  });
  return handleResponse(resp, "POST", url, traceId);
}

async function getJson(url, apiKey, traceId) {
  const resp = await fetch(url, {
    method: "GET",
    headers: buildHeaders(apiKey, traceId)
  });
  return handleResponse(resp, "GET", url, traceId);
}

function buildHeaders(apiKey, traceId) {
  const basic = Buffer.from(`${apiKey}:`).toString("base64");
  return {
    "content-type": "application/json",
    authorization: `Basic ${basic}`,
    "x-trace-id": traceId
  };
}

async function handleResponse(resp, method, url, traceId) {
  const text = await resp.text();
  const data = tryParseJson(text) ?? { raw: text };
  if (!resp.ok) {
    throw new Error(
      `${method} ${url} failed: ${resp.status} ${resp.statusText} traceId=${traceId} body=${JSON.stringify(data)}`
    );
  }
  return data;
}

function extractReply(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const direct = pick(payload, ["reply", "output", "text", "final_output", "finalOutput", "result"]);
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }
  if (Array.isArray(direct)) {
    const joined = direct
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (item && typeof item === "object") {
          return asText(pick(item, ["text", "content", "value"]));
        }
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
    if (joined) {
      return joined;
    }
  }

  const choiceText = asText(payload?.choices?.[0]?.message?.content ?? payload?.choices?.[0]?.text);
  if (choiceText) {
    return choiceText;
  }

  const dataText = asText(payload?.data?.reply ?? payload?.data?.output ?? payload?.result?.text);
  if (dataText) {
    return dataText;
  }

  if (Array.isArray(payload.messages)) {
    const assistantMessages = payload.messages.filter((m) => m?.role === "assistant");
    const last = assistantMessages.at(-1);
    const c = last?.content;
    if (typeof c === "string" && c.trim()) {
      return c.trim();
    }
    if (Array.isArray(c)) {
      const parts = c
        .map((part) => {
          if (typeof part === "string") {
            return part;
          }
          if (part && typeof part === "object") {
            return asText(part.text ?? part.content ?? part.value);
          }
          return "";
        })
        .filter(Boolean)
        .join("\n")
        .trim();
      if (parts) {
        return parts;
      }
    }
  }

  return null;
}

function pick(obj, keys) {
  if (!obj || typeof obj !== "object") {
    return undefined;
  }
  for (const k of keys) {
    if (k.includes(".")) {
      const value = k.split(".").reduce((acc, key) => (acc && typeof acc === "object" ? acc[key] : undefined), obj);
      if (value !== undefined && value !== null) {
        return value;
      }
    } else if (obj[k] !== undefined && obj[k] !== null) {
      return obj[k];
    }
  }
  return undefined;
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asText(value) {
  if (typeof value === "string") {
    const text = value.trim();
    return text || null;
  }
  return null;
}

function toInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

function toFloat(value, fallback) {
  const n = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(n) ? n : fallback;
}

function toBool(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const x = String(value).toLowerCase();
  return x === "1" || x === "true" || x === "yes" || x === "on";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadSessionAgentCache(cachePath) {
  if (cacheLoaded) {
    return;
  }
  await mkdir(dirname(cachePath), { recursive: true });
  try {
    const text = await readFile(cachePath, "utf8");
    const data = tryParseJson(text);
    if (data && typeof data === "object") {
      for (const [k, v] of Object.entries(data)) {
        if (typeof v === "string") {
          sessionAgentMap.set(k, {
            agentId: v,
            createdAt: Date.now(),
            expiresAt: Number.MAX_SAFE_INTEGER
          });
          continue;
        }
        const agentId = v?.agentId;
        if (typeof agentId === "string" && agentId) {
          const createdAt = toInt(v?.createdAt, Date.now());
          const expiresAt = toInt(v?.expiresAt, Number.MAX_SAFE_INTEGER);
          sessionAgentMap.set(k, { agentId, createdAt, expiresAt });
        }
      }
    }
  } catch {
    await writeFile(cachePath, "{}", "utf8");
  }
  cacheLoaded = true;
}

async function persistSessionAgentCache(cachePath) {
  const obj = Object.fromEntries(
    Array.from(sessionAgentMap.entries()).map(([sessionId, value]) => [
      sessionId,
      {
        agentId: value.agentId,
        createdAt: value.createdAt,
        expiresAt: value.expiresAt
      }
    ])
  );
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, JSON.stringify(obj, null, 2), "utf8");
}

function getValidCachedAgent(sessionId) {
  const cached = sessionAgentMap.get(sessionId);
  if (!cached?.agentId) {
    return null;
  }
  if (Number.isFinite(cached.expiresAt) && cached.expiresAt <= Date.now()) {
    sessionAgentMap.delete(sessionId);
    return null;
  }
  return cached;
}

function isAgentMissingError(error) {
  const text = String(error ?? "").toLowerCase();
  return text.includes("/v1/agents/") && (text.includes("404") || text.includes("not found"));
}

function isAgentBusyError(error) {
  const text = String(error ?? "").toLowerCase();
  return text.includes("agent_busy") || (text.includes("409") && text.includes("active run"));
}

function buildReplyFallback({ traceId, reason, payload }) {
  const compactPayload = tryStringifyPayload(payload, 1600);
  return `Plugin(fallback): ${reason}. traceId=${traceId}. payload=${compactPayload}`;
}

function tryStringifyPayload(payload, maxLen) {
  try {
    const text = JSON.stringify(payload);
    if (!text) {
      return "{}";
    }
    if (text.length <= maxLen) {
      return text;
    }
    return `${text.slice(0, maxLen)}...(truncated)`;
  } catch {
    return String(payload ?? "null");
  }
}

function readConfig(config, env, key, fallback) {
  if (config?.cloud && config.cloud[key] !== undefined && config.cloud[key] !== null && config.cloud[key] !== "") {
    return config.cloud[key];
  }
  if (config && config[key] !== undefined && config[key] !== null && config[key] !== "") {
    return config[key];
  }
  if (env && env[key] !== undefined && env[key] !== null && env[key] !== "") {
    return env[key];
  }
  return fallback;
}
