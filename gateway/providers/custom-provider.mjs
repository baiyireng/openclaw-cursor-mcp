import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const sessionAgentMap = new Map();
let cacheLoaded = false;

export async function generateReply(sessionId, message, context) {
  const env = context?.env ?? process.env;
  const config = context?.config ?? {};
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
  const model = readConfig(config, env, "CURSOR_CLOUD_MODEL", "");
  const pollIntervalMs = toInt(readConfig(config, env, "CURSOR_CLOUD_POLL_INTERVAL_MS", 1500), 1500);
  const timeoutMs = toInt(readConfig(config, env, "CURSOR_CLOUD_TIMEOUT_MS", 120000), 120000);
  const cachePath = String(
    readConfig(config, env, "CURSOR_SESSION_AGENT_CACHE_PATH", "./data/session-agent-map.json")
  );

  const agentId = await ensureAgent(sessionId, {
    baseUrl,
    apiKey,
    model,
    workspacePath,
    cachePath
  });

  const run = await createRun({
    baseUrl,
    apiKey,
    agentId,
    message
  });

  const runId = pick(run, ["id", "run_id", "runId"]);
  if (!runId) {
    throw new Error(`create run succeeded but run id missing: ${JSON.stringify(run)}`);
  }

  const finalState = await waitForRunDone({
    baseUrl,
    apiKey,
    agentId,
    runId,
    pollIntervalMs,
    timeoutMs
  });

  const reply = extractReply(finalState);
  if (!reply) {
    throw new Error(`run completed but reply not found: ${JSON.stringify(finalState)}`);
  }
  return reply;
}

async function ensureAgent(sessionId, opts) {
  await loadSessionAgentCache(opts.cachePath);
  const cached = sessionAgentMap.get(sessionId);
  if (cached) {
    return cached;
  }

  const payload = {
    name: `openclaw-${sessionId}`,
    workspace: { path: opts.workspacePath }
  };
  if (opts.model) {
    payload.model = opts.model;
  }

  const created = await postJson(`${opts.baseUrl}/v1/agents`, payload, opts.apiKey);
  const agentId = pick(created, ["id", "agent_id", "agentId"]);
  if (!agentId) {
    throw new Error(`create agent response missing id: ${JSON.stringify(created)}`);
  }
  sessionAgentMap.set(sessionId, agentId);
  await persistSessionAgentCache(opts.cachePath);
  return agentId;
}

async function createRun({ baseUrl, apiKey, agentId, message }) {
  return postJson(`${baseUrl}/v1/agents/${encodeURIComponent(agentId)}/runs`, { message }, apiKey);
}

async function waitForRunDone({ baseUrl, apiKey, agentId, runId, pollIntervalMs, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await getJson(
      `${baseUrl}/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`,
      apiKey
    );
    const status = pick(last, ["status", "state"]);
    if (status === "completed" || status === "succeeded") {
      return last;
    }
    if (status === "failed" || status === "cancelled" || status === "canceled") {
      throw new Error(`run ended with status=${status}: ${JSON.stringify(last)}`);
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(`run timeout after ${timeoutMs}ms, last=${JSON.stringify(last)}`);
}

async function postJson(url, body, apiKey) {
  const resp = await fetch(url, {
    method: "POST",
    headers: buildHeaders(apiKey),
    body: JSON.stringify(body)
  });
  return handleResponse(resp, "POST", url);
}

async function getJson(url, apiKey) {
  const resp = await fetch(url, {
    method: "GET",
    headers: buildHeaders(apiKey)
  });
  return handleResponse(resp, "GET", url);
}

function buildHeaders(apiKey) {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`
  };
}

async function handleResponse(resp, method, url) {
  const text = await resp.text();
  const data = tryParseJson(text) ?? { raw: text };
  if (!resp.ok) {
    throw new Error(`${method} ${url} failed: ${resp.status} ${resp.statusText} body=${JSON.stringify(data)}`);
  }
  return data;
}

function extractReply(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const direct = pick(payload, ["reply", "output", "text", "final_output", "finalOutput"]);
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }

  if (Array.isArray(payload.messages)) {
    const assistantMessages = payload.messages.filter((m) => m?.role === "assistant");
    const last = assistantMessages.at(-1);
    const c = last?.content;
    if (typeof c === "string" && c.trim()) {
      return c.trim();
    }
  }

  return null;
}

function pick(obj, keys) {
  if (!obj || typeof obj !== "object") {
    return undefined;
  }
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) {
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

function toInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
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
          sessionAgentMap.set(k, v);
        }
      }
    }
  } catch {
    await writeFile(cachePath, "{}", "utf8");
  }
  cacheLoaded = true;
}

async function persistSessionAgentCache(cachePath) {
  const obj = Object.fromEntries(sessionAgentMap.entries());
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, JSON.stringify(obj, null, 2), "utf8");
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
