import { spawn } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const runtimeDir = resolve(here, "..", "data", "runtime");
const pidPath = resolve(runtimeDir, "gateway.pid");
const logPath = resolve(runtimeDir, "gateway.log");
const command = process.argv[2] ?? "status";
const force = process.argv.includes("--force");

async function main() {
  await mkdir(runtimeDir, { recursive: true });

  if (command === "start") {
    await startGateway();
    return;
  }
  if (command === "stop") {
    await stopGateway(force);
    return;
  }
  if (command === "restart") {
    await stopGateway(true);
    await startGateway();
    return;
  }
  if (command === "status") {
    await printStatus();
    return;
  }
  if (command === "logs") {
    await printLogs();
    return;
  }

  process.stderr.write("Usage: node gateway/manage.mjs <start|stop|restart|status|logs> [--force]\n");
  process.exit(2);
}

async function startGateway() {
  const existing = await readPidInfo();
  if (existing && (await isProcessAlive(existing.pid))) {
    process.stdout.write(`Gateway already running (pid=${existing.pid}).\n`);
    return;
  }

  const out = await openLogStream();
  const err = await openLogStream();
  const child = spawn(process.execPath, [resolve(here, "server.mjs")], {
    detached: true,
    stdio: ["ignore", out, err],
    env: process.env,
    windowsHide: true
  });
  child.unref();

  const payload = {
    pid: child.pid,
    startedAt: new Date().toISOString(),
    logPath
  };
  await writeFile(pidPath, JSON.stringify(payload, null, 2), "utf8");
  process.stdout.write(`Gateway started (pid=${child.pid}).\n`);
  process.stdout.write(`Log file: ${logPath}\n`);
}

async function stopGateway(forceStop) {
  const info = await readPidInfo();
  if (!info) {
    process.stdout.write("Gateway is not running (no pid file).\n");
    return;
  }
  if (!(await isProcessAlive(info.pid))) {
    await cleanupPidFile();
    process.stdout.write("Gateway process already exited. pid file cleaned.\n");
    return;
  }

  if (process.platform === "win32") {
    await stopWindowsProcess(info.pid, forceStop);
  } else {
    try {
      process.kill(info.pid, forceStop ? "SIGKILL" : "SIGTERM");
    } catch {
      // ignore
    }
  }

  const ok = await waitForExit(info.pid, 5000);
  if (!ok && !forceStop) {
    process.stdout.write("Graceful stop timed out, force killing...\n");
    if (process.platform === "win32") {
      await stopWindowsProcess(info.pid, true);
    } else {
      try {
        process.kill(info.pid, "SIGKILL");
      } catch {
        // ignore
      }
    }
  }

  await cleanupPidFile();
  process.stdout.write("Gateway stopped.\n");
}

async function printStatus() {
  const info = await readPidInfo();
  if (!info) {
    process.stdout.write("Gateway status: stopped\n");
    return;
  }
  const alive = await isProcessAlive(info.pid);
  process.stdout.write(`Gateway status: ${alive ? "running" : "stopped"}\n`);
  process.stdout.write(`pid: ${info.pid}\n`);
  process.stdout.write(`startedAt: ${info.startedAt ?? "unknown"}\n`);
  process.stdout.write(`logPath: ${info.logPath ?? logPath}\n`);
  if (!alive) {
    await cleanupPidFile();
  }
}

async function printLogs() {
  try {
    const text = await readFile(logPath, "utf8");
    process.stdout.write(text);
  } catch {
    process.stdout.write(`No logs found at ${logPath}\n`);
  }
}

async function readPidInfo() {
  try {
    const text = await readFile(pidPath, "utf8");
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed.pid !== "number") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function cleanupPidFile() {
  await rm(pidPath, { force: true });
}

async function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isProcessAlive(pid))) {
      return true;
    }
    await sleep(200);
  }
  return !(await isProcessAlive(pid));
}

async function killWindows(pid, forceKill) {
  const args = ["/PID", String(pid), "/T"];
  if (forceKill) {
    args.push("/F");
  }
  const child = spawn("taskkill", args, { windowsHide: true });
  await new Promise((resolveDone) => child.on("exit", () => resolveDone(null)));
}

async function stopWindowsProcess(pid, forceKill) {
  if (!forceKill) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // ignore and fallback to taskkill
    }
    const exited = await waitForExit(pid, 1500);
    if (exited) {
      return;
    }
  }
  await killWindows(pid, true);
}

async function openLogStream() {
  await ensureFile(logPath);
  const fs = await import("node:fs");
  return fs.openSync(logPath, "a");
}

async function ensureFile(path) {
  try {
    await access(path, fsConstants.F_OK);
  } catch {
    await writeFile(path, "", "utf8");
  }
}

function sleep(ms) {
  return new Promise((resolveDone) => setTimeout(resolveDone, ms));
}

main().catch((error) => {
  process.stderr.write(`gateway-manage failed: ${String(error)}\n`);
  process.exit(1);
});
