#!/usr/bin/env node
// One command for the demo tenant: starts entra-scim-mock-server with the demo
// seed, waits until it answers, applies the manager links and memberships with
// seed-links.mjs, then stays attached to the mock (Ctrl+C stops it).
//
//   npm run demo:up                   start, seed, link, stay attached
//   npm run demo:up -- --detach       start, seed, link, leave the mock running and exit 0 (CI)
//   npm run demo:up -- --port 8991    another port (point ENTRA_SCIM_BASE_URL at it)
//   npm run demo:up -- --help         all options
//
// Zero dependencies (Node 22+). Loopback only: the mock binds 127.0.0.1 and this
// script never talks to anything else. Requires `npm install` (the mock binary
// ships inside the entra-scim-mcp package).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, openSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULTS = { port: 8990, token: "dev-token", seed: "demo/seed/contoso-demo-seed.json" };
const READY_TIMEOUT_MS = 15_000;
const READY_INTERVAL_MS = 250;
const MOCK_CLI = join(repoRoot, "node_modules", "entra-scim-mcp", "dist", "mock", "cli.js");
const SEED_LINKS = join(repoRoot, "demo", "scripts", "seed-links.mjs");

const USAGE = `Usage: node demo/scripts/demo-up.mjs [--detach] [--port ${DEFAULTS.port}] [--token ${DEFAULTS.token}] [--seed ${DEFAULTS.seed}] [--capture <file.jsonl>]
  --detach   Leave the mock running in the background and exit 0 once the links are applied (CI).
  --port     Port on 127.0.0.1. Default ${DEFAULTS.port}; change ENTRA_SCIM_BASE_URL to match if you change it.
  --token    Bearer token the mock expects. Default ${DEFAULTS.token}.
  --seed     Seed file. Default ${DEFAULTS.seed}.
  --capture  Also log every SCIM request and response to this .jsonl file.`;

function parseArgs(argv) {
  const opts = { ...DEFAULTS, detach: false, capture: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    }
    const take = (name) => {
      const eq = arg.indexOf("=");
      if (eq !== -1) return arg.slice(eq + 1);
      const next = argv[++i];
      if (next === undefined) throw new Error(`${name} requires a value`);
      return next;
    };
    if (arg === "--detach") opts.detach = true;
    else if (arg === "--port" || arg.startsWith("--port=")) opts.port = Number(take("--port"));
    else if (arg === "--token" || arg.startsWith("--token=")) opts.token = take("--token");
    else if (arg === "--seed" || arg.startsWith("--seed=")) opts.seed = take("--seed");
    else if (arg === "--capture" || arg.startsWith("--capture=")) opts.capture = take("--capture");
    else throw new Error(`unknown option ${arg}\n${USAGE}`);
  }
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) throw new Error(`--port must be 1-65535, got ${opts.port}`);
  return opts;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Resolves true when something already accepts connections on 127.0.0.1:port. */
function portInUse(port) {
  return new Promise((resolvePort) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolvePort(true); });
    socket.once("error", () => resolvePort(false));
  });
}

async function waitUntilReady(baseUrl, token, child) {
  const started = Date.now();
  let exited = false;
  child.once("exit", () => { exited = true; });
  while (Date.now() - started < READY_TIMEOUT_MS) {
    if (exited) throw new Error("the mock exited before it was ready (see its output above)");
    try {
      const res = await fetch(`${baseUrl}/Users?attributes=id&count=1`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await sleep(READY_INTERVAL_MS);
  }
  throw new Error(`the mock did not answer on ${baseUrl} within ${READY_TIMEOUT_MS / 1000}s`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const baseUrl = `http://127.0.0.1:${opts.port}`;
  const seedPath = resolve(repoRoot, opts.seed);

  if (!existsSync(MOCK_CLI)) throw new Error(`mock binary not found at ${MOCK_CLI}. Run: npm install`);
  if (!existsSync(seedPath)) throw new Error(`seed file not found: ${seedPath}`);
  if (await portInUse(opts.port)) {
    throw new Error(`port ${opts.port} is already in use. Stop the mock running in your other terminal (Ctrl+C), or pass --port <n> and point ENTRA_SCIM_BASE_URL at it.`);
  }

  const mockArgs = [MOCK_CLI, "--seed", seedPath, "--port", String(opts.port), "--token", opts.token];
  if (opts.capture) mockArgs.push("--capture", resolve(repoRoot, opts.capture));

  let logPath;
  let stdio;
  if (opts.detach) {
    logPath = join(tmpdir(), `entra-scim-mock-${opts.port}.log`);
    const fd = openSync(logPath, "w");
    stdio = ["ignore", fd, fd];
  } else {
    stdio = ["ignore", "pipe", "pipe"];
  }
  const child = spawn(process.execPath, mockArgs, { cwd: repoRoot, stdio, detached: opts.detach, windowsHide: true });
  if (!opts.detach) {
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
  }

  const stopMock = () => { if (child.exitCode === null) child.kill(); };
  if (!opts.detach) {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.on(signal, () => { process.stdout.write("\ndemo-up: stopping the mock\n"); stopMock(); });
    }
  }

  try {
    await waitUntilReady(baseUrl, opts.token, child);
    const links = spawnSync(process.execPath, [SEED_LINKS, seedPath, "--base-url", baseUrl, "--token", opts.token], {
      cwd: repoRoot,
      stdio: "inherit",
    });
    if (links.status !== 0) throw new Error(`seed-links exited with ${links.status}; the mock is up but the links were not applied`);
  } catch (err) {
    stopMock();
    throw err;
  }

  if (opts.detach) {
    child.unref();
    process.stdout.write(`demo-up: tenant ready on ${baseUrl}; the mock keeps running in the background (pid ${child.pid}, log ${logPath}).\n`);
    process.stdout.write(`demo-up: stop it with ${process.platform === "win32" ? `taskkill /PID ${child.pid} /F` : `kill ${child.pid}`}\n`);
    process.exit(0);
  }

  process.stdout.write(`\ndemo-up: tenant ready on ${baseUrl}. Ctrl+C stops the mock; run npm run demo:up again for fresh ids.\n`);
  child.on("exit", (code) => process.exit(code ?? 0));
}

main().catch((err) => {
  process.stderr.write(`demo-up: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
