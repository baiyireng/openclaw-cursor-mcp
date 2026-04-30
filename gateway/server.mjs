import { createServer } from "node:http";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const configState = await loadGatewayConfig();
const config = configState.data;
const configPath = configState.path;

const port = toInt(resolveSetting("CURSOR_GATEWAY_PORT", "gateway.port", "8787"), 8787);
const host = String(resolveSetting("CURSOR_GATEWAY_HOST", "gateway.host", "127.0.0.1"));
const mode = String(resolveSetting("CURSOR_GATEWAY_MODE", "gateway.mode", "mock")); // mock | cli | plugin

const server = createServer(async (req, res) => {
  const traceId = readTraceId(req);
  try {
    if (!req.url) {
      return sendError(res, traceId, new AppError("INVALID_URL", "Invalid URL", 400, false));
    }

    if (req.method === "GET" && req.url === "/health") {
      return sendJson(res, 200, {
        ok: true,
        mode,
        configPath: String(configPath),
        traceId
      });
    }

    if (req.method === "GET" && req.url === "/config") {
      return sendHtml(res, 200, renderConfigPage(config, configPath));
    }

    if (req.method === "POST" && req.url === "/config") {
      const payload = await readJsonBody(req);
      if (!payload || typeof payload !== "object") {
        return sendError(res, traceId, new AppError("INVALID_PAYLOAD", "Invalid JSON payload", 400, false));
      }
      await saveGatewayConfig(configPath, payload);
      return sendJson(res, 200, { ok: true, message: "Config saved. Please restart gateway to apply.", traceId });
    }

    if (req.method === "POST" && req.url === "/config/test-cloud") {
      const payload = await readJsonBody(req);
      const testResult = await testCloudConnection(payload, config, traceId);
      return sendJson(res, testResult.ok ? 200 : 400, testResult);
    }

    if (req.method === "POST" && req.url === "/chat") {
      const payload = await readJsonBody(req);
      const sessionId = asString(payload.sessionId);
      const message = asString(payload.message);
      const incomingTraceId = asString(payload.traceId);
      const requestTraceId = incomingTraceId || traceId;

      if (!sessionId || !message) {
        return sendError(
          res,
          requestTraceId,
          new AppError("INVALID_PAYLOAD", "Invalid payload", 400, false, {
            expected: { sessionId: "string", message: "string" }
          })
        );
      }

      const reply = await resolveReply(sessionId, message, requestTraceId);
      return sendJson(res, 200, { ok: true, reply, traceId: requestTraceId });
    }

    return sendError(res, traceId, new AppError("NOT_FOUND", "Not found", 404, false));
  } catch (error) {
    return sendError(res, traceId, error);
  }
});

server.listen(port, host, () => {
  process.stdout.write(`Cursor HTTP gateway listening on http://${host}:${port} (mode=${mode})\n`);
});

process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});

process.on("SIGINT", () => {
  shutdown("SIGINT");
});

let isShuttingDown = false;
function shutdown(signal) {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;
  process.stdout.write(`Gateway received ${signal}, shutting down...\n`);
  server.close(() => {
    process.stdout.write("Gateway shutdown complete.\n");
    process.exit(0);
  });
  setTimeout(() => {
    process.stderr.write("Gateway shutdown timeout, forcing exit.\n");
    process.exit(1);
  }, 5000).unref();
}

async function resolveReply(sessionId, message, traceId) {
  if (mode === "cli") {
    return runCliBackend(sessionId, message, traceId);
  }
  if (mode === "plugin") {
    return runPluginBackend(sessionId, message, traceId);
  }
  return `Gateway(mock): session=${sessionId}, message=${message}, traceId=${traceId}`;
}

async function runCliBackend(sessionId, message, traceId) {
  const cmd = resolveSetting("CURSOR_GATEWAY_CLI_CMD", "cli.command", "");
  if (!cmd) {
    throw new AppError("CLI_CONFIG_MISSING", "CURSOR_GATEWAY_CLI_CMD is required in cli mode", 500, false);
  }
  const argsTemplate = parseArgTemplate(resolveSetting("CURSOR_GATEWAY_CLI_ARGS_JSON", "cli.argsJson", ""));
  const args = argsTemplate.map((item) => item.replaceAll("{{sessionId}}", sessionId).replaceAll("{{message}}", message));

  const timeoutMs = toInt(resolveSetting("CURSOR_GATEWAY_CLI_TIMEOUT_MS", "cli.timeoutMs", "60000"), 60000);
  let stdout = "";
  try {
    const result = await execFileAsync(cmd, args, {
      windowsHide: true,
      timeout: timeoutMs,
      env: { ...process.env, OPENCLAW_TRACE_ID: traceId }
    });
    stdout = result.stdout;
  } catch (error) {
    if (String(error?.message ?? "").includes("timed out")) {
      throw new AppError("CLI_TIMEOUT", `CLI backend timed out after ${timeoutMs}ms`, 408, true);
    }
    throw new AppError("CLI_EXEC_FAILED", `CLI backend failed: ${String(error)}`, 502, true);
  }

  const text = stdout.trim();
  if (!text) {
    throw new AppError("CLI_EMPTY_OUTPUT", "CLI backend returned empty stdout", 502, true);
  }
  return text;
}

async function runPluginBackend(sessionId, message, traceId) {
  const specifier = String(resolveSetting("CURSOR_GATEWAY_PLUGIN", "plugin.module", "./providers/custom-provider.mjs"));
  const moduleUrl = toModuleUrl(specifier);
  const mod = await import(moduleUrl);
  if (typeof mod.generateReply !== "function") {
    throw new AppError(
      "PLUGIN_INVALID",
      `Plugin ${specifier} must export async function generateReply(sessionId, message)`,
      500,
      false
    );
  }
  const reply = await mod.generateReply(sessionId, message, {
    env: process.env,
    config,
    now: new Date().toISOString(),
    traceId
  });
  if (typeof reply !== "string" || !reply.trim()) {
    throw new AppError("PLUGIN_INVALID_REPLY", `Plugin ${specifier} returned invalid reply`, 502, true);
  }
  return reply.trim();
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8") || "{}";
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error(`Invalid JSON body: ${String(error)}`));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, data) {
  const text = JSON.stringify(data);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text)
  });
  res.end(text);
}

function asString(value) {
  return typeof value === "string" ? value : "";
}

function readTraceId(req) {
  const headerTrace = req.headers?.["x-trace-id"];
  if (typeof headerTrace === "string" && headerTrace.trim()) {
    return headerTrace.trim();
  }
  if (Array.isArray(headerTrace) && headerTrace.length > 0 && String(headerTrace[0]).trim()) {
    return String(headerTrace[0]).trim();
  }
  return `gw-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function parseArgTemplate(text) {
  if (!text) {
    return ["{{sessionId}}", "{{message}}"];
  }
  const value = JSON.parse(text);
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error("CURSOR_GATEWAY_CLI_ARGS_JSON must be a JSON string array");
  }
  return value;
}

function toModuleUrl(specifier) {
  if (specifier.startsWith("file://")) {
    return specifier;
  }
  return new URL(specifier, import.meta.url).href;
}

async function loadGatewayConfig() {
  const defaultPath = new URL("./config/gateway.config.json", import.meta.url);
  const configured = process.env.CURSOR_GATEWAY_CONFIG_PATH;
  const url = configured ? new URL(configured, import.meta.url) : defaultPath;
  try {
    const text = await readFile(url, "utf8");
    const parsed = JSON.parse(text);
    return { path: url, data: parsed };
  } catch {
    return { path: url, data: {} };
  }
}

function resolveSetting(envKey, configPath, fallback) {
  const envValue = process.env[envKey];
  if (envValue !== undefined && envValue !== null && envValue !== "") {
    return envValue;
  }
  const cfgValue = getByPath(config, configPath);
  if (cfgValue !== undefined && cfgValue !== null && cfgValue !== "") {
    return cfgValue;
  }
  return fallback;
}

function getByPath(obj, path) {
  if (!obj || !path) {
    return undefined;
  }
  return path.split(".").reduce((acc, key) => {
    if (acc && typeof acc === "object" && key in acc) {
      return acc[key];
    }
    return undefined;
  }, obj);
}

function toInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

async function saveGatewayConfig(pathUrl, data) {
  const filepath = fileURLToPath(pathUrl);
  await mkdir(dirname(filepath), { recursive: true });
  await writeFile(filepath, JSON.stringify(data, null, 2), "utf8");
}

function sendHtml(res, statusCode, html) {
  res.writeHead(statusCode, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html)
  });
  res.end(html);
}

function renderConfigPage(data, pathUrl) {
  const text = JSON.stringify(data, null, 2);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>Gateway Config</title>
  <style>
    body { font-family: sans-serif; margin: 20px; }
    textarea { width: 100%; height: 70vh; font-family: Consolas, monospace; font-size: 13px; }
    button { padding: 8px 14px; }
    #msg { margin-left: 10px; color: #155724; }
    .row { margin-top: 10px; display: flex; gap: 8px; align-items: center; }
    input[type="password"], input[type="text"] { width: 420px; padding: 6px 8px; }
  </style>
</head>
<body>
  <h3>Gateway 可视化配置</h3>
  <p>配置文件：<code>${pathUrl.pathname}</code></p>
  <div class="row">
    <label>Cloud API Key:</label>
    <input id="apiKey" type="password" placeholder="可选：覆盖配置中的 CURSOR_CLOUD_API_KEY" />
    <button id="toggle">显示/隐藏</button>
    <button id="testCloud">测试 Cloud 连通性</button>
  </div>
  <textarea id="cfg">${escapeHtml(text)}</textarea>
  <div style="margin-top:10px;">
    <button id="save">保存</button><span id="msg"></span>
  </div>
  <script>
    const btn = document.getElementById("save");
    const testBtn = document.getElementById("testCloud");
    const toggleBtn = document.getElementById("toggle");
    const msg = document.getElementById("msg");
    const area = document.getElementById("cfg");
    const apiKey = document.getElementById("apiKey");

    toggleBtn.onclick = () => {
      apiKey.type = apiKey.type === "password" ? "text" : "password";
    };

    btn.onclick = async () => {
      msg.textContent = "保存中...";
      try {
        const obj = JSON.parse(area.value);
        const resp = await fetch("/config", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(obj)
        });
        const data = await resp.json();
        msg.textContent = data.message || "已保存";
      } catch (e) {
        msg.textContent = "保存失败: " + e;
      }
    };

    testBtn.onclick = async () => {
      msg.textContent = "测试中...";
      try {
        const obj = JSON.parse(area.value);
        const resp = await fetch("/config/test-cloud", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            config: obj,
            apiKeyOverride: apiKey.value || undefined
          })
        });
        const data = await resp.json();
        msg.textContent = data.message || (data.ok ? "Cloud 连接成功" : "Cloud 连接失败");
      } catch (e) {
        msg.textContent = "测试失败: " + e;
      }
    };
  </script>
</body>
</html>`;
}

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function testCloudConnection(payload, currentConfig, traceId) {
  try {
    const cfg = (payload?.config && typeof payload.config === "object") ? payload.config : currentConfig;
    const cloud = cfg?.cloud ?? {};
    const baseUrl = String(cloud.CURSOR_CLOUD_API_BASE_URL ?? "https://api.cursor.com").replace(/\/$/, "");
    const apiKey = payload?.apiKeyOverride || cloud.CURSOR_CLOUD_API_KEY;
    if (!apiKey) {
      return { ok: false, code: "MISSING_API_KEY", message: "缺少 CURSOR_CLOUD_API_KEY，无法测试", traceId };
    }

    const resp = await fetch(`${baseUrl}/v1/agents`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        name: "openclaw-config-test",
        workspace: { path: String(cloud.CURSOR_CLOUD_WORKSPACE_PATH ?? ".") }
      })
    });

    const text = await resp.text();
    if (!resp.ok) {
      return {
        ok: false,
        code: "CLOUD_REQUEST_FAILED",
        message: `Cloud 请求失败: ${resp.status} ${resp.statusText}`,
        detail: text,
        traceId
      };
    }

    return { ok: true, message: "Cloud 连接成功（已验证 create agent 权限）", traceId };
  } catch (error) {
    return { ok: false, code: "CLOUD_TEST_ERROR", message: `Cloud 测试异常: ${String(error)}`, traceId };
  }
}

function sendError(res, traceId, error) {
  const appErr = toAppError(error);
  return sendJson(res, appErr.status, {
    ok: false,
    code: appErr.code,
    message: appErr.message,
    traceId,
    retryable: appErr.retryable,
    detail: appErr.detail
  });
}

function toAppError(error) {
  if (error instanceof AppError) {
    return error;
  }
  return new AppError("INTERNAL_ERROR", String(error), 500, false);
}

class AppError extends Error {
  constructor(code, message, status, retryable, detail = undefined) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.detail = detail;
  }
}
