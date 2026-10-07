#!/usr/bin/env node
// Drives Claude Code headlessly through every demo scenario, with the skills
// doing the work, and writes the evidence into the repo:
//
//   demo/recordings/<S>.transcript.md      assistant text + one line per tool call (password redacted)
//   demo/recordings/<S>.turn<n>.stream.jsonl   raw stream-json (gitignored)
//   demo/recordings/run-summary.{json,md}  model, CLI version, counts, durations, cost per scenario
//   demo/expected/<S>.decision-record.json the fenced record from the final turn, once every assertion passed
//
//   npm run record:scenarios -- --dry-run     print the claude invocations and prompts, start nothing
//   npm run record:scenarios                  six scenarios, 30 to 40 minutes, spends model usage
//   npm run record:scenarios -- --only S1,S3c
//   npm run record:check                      offline: re-assert demo/expected against the scenario expectations
//
// Zero npm dependencies at runtime except, for schema validation, the ajv that
// `npm install` already pulls in for validate:policy. Node 22+. Loopback only.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const rel = (p) => relative(repoRoot, p).replace(/\\/g, "/");

const MOCK_CLI = join(repoRoot, "node_modules", "entra-scim-mcp", "dist", "mock", "cli.js");
const MCP_SERVER = join(repoRoot, "node_modules", "entra-scim-mcp", "dist", "index.js");
const INTAKE_SERVER_FILE = join(repoRoot, "demo", "intake", "server.mjs");
const SEED_LINKS = join(repoRoot, "demo", "scripts", "seed-links.mjs");
const SEED_FILE = join(repoRoot, "demo", "seed", "contoso-demo-seed.json");
const POLICY_FILE = join(repoRoot, ".claude", "skills", "entra-lifecycle-policy", "policy", "lifecycle-policy.json");
const RECORD_SCHEMA = join(repoRoot, ".claude", "skills", "entra-lifecycle-policy", "policy", "decision-record.schema.json");
const EXPECTED_DIR = join(repoRoot, "demo", "expected");
const SERVER_NAME = "entra-scim-mock"; // must match the committed records' tool names
const TOOL_PREFIX = `mcp__${SERVER_NAME}__`;
const INTAKE_SERVER = "entra-lifecycle-intake"; // the decision-model front door (tool system_one)
const INTAKE_PREFIX = `mcp__${INTAKE_SERVER}__`;
const PREFIXES = [TOOL_PREFIX, INTAKE_PREFIX];
const CSA_URN = "urn:ietf:params:scim:schemas:extension:Microsoft:Entra:2.0:CustomSecurityAttributes";
const ENTERPRISE_URN = "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";
const ENTRA_USER_URN = "urn:ietf:params:scim:schemas:extension:Microsoft:Entra:2.0:User";
const DISCOVERY_TOOLS = ["get_service_provider_config", "list_resource_types", "list_schemas"];
const GROUP_ADMIN_TOOLS = ["create_group", "update_group", "delete_group"];
const WRITE_TOOLS = ["provision_user", "update_user", "deprovision_user", "update_user_lifecycle", "update_user_custom_security_attributes", "add_group_members", "remove_group_member", ...GROUP_ADMIN_TOOLS];
const GATE_RE = /operator confirmation required:\s*reply exactly\s*`?approve\s+(elg-[A-Za-z0-9-]{4,40}-[a-z0-9]{6})`?/i;
const APPROVE_RE = /\bapprove\s+(elg-[A-Za-z0-9-]{4,40}-[a-z0-9]{6})\b/g;
const CORRELATION_RE = /^elg-[A-Za-z0-9-]{4,40}-[a-z0-9]{6}$/;
const GUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

// ---------------------------------------------------------------------------
// Scenarios: what to run and what the scenario files promise
// ---------------------------------------------------------------------------

const SCENARIOS = [
  {
    id: "S0a", title: "Intake: a free-text transfer, routed, record requested", skill: "lifecycle-intake", doc: "demo/scenarios/S0-intake.md", promptFence: "text S0a",
    record: null, gate: false, writes: false,
    expect: { decision: "allow", outcome: "not_executed", riskLevel: "low", reasonCode: "intake_record_required", count: 1, tolerance: 0, budget: 2, turn1Calls: 1 },
  },
  {
    id: "S0b", title: "Intake: too vague to route", skill: "lifecycle-intake", doc: "demo/scenarios/S0-intake.md", promptFence: "text S0b",
    record: null, gate: false, writes: false,
    expect: { decision: "require_manual_review", outcome: "not_executed", riskLevel: "medium", reasonCode: "intake_low_confidence", count: 1, tolerance: 0, budget: 2, turn1Calls: 1 },
  },
  {
    id: "S0c", title: "Intake: urgency pretending to be governance", skill: "lifecycle-intake", doc: "demo/scenarios/S0-intake.md", promptFence: "text S0c",
    record: null, gate: false, writes: false,
    expect: { decision: "deny", outcome: "blocked", riskLevel: "high", reasonCode: "intake_override_attempt", count: 1, tolerance: 0, budget: 2, turn1Calls: 1 },
  },
  {
    id: "S1", title: "Joiner blocked: mandatory CSA missing", skill: "joiner-orchestrator", doc: "demo/scenarios/S1-joiner-blocked.md", block: 0,
    record: "S1-priya-natarajan-incomplete.json", gate: false, writes: false,
    expect: { decision: "deny", outcome: "blocked", riskLevel: "high", count: 0, tolerance: 0, budget: 20, turn1Calls: 0 },
  },
  {
    id: "S2", title: "Joiner corrected: create inactive, CSAs, groups, verify, activate", skill: "joiner-orchestrator", doc: "demo/scenarios/S2-joiner-corrected.md", block: 0,
    record: "S2-priya-natarajan-corrected.json", gate: true, writes: true,
    expect: { decision: "allow_with_approval", outcome: "completed", riskLevel: "medium", count: 15, tolerance: 1, budget: 20, turn1Calls: 4 },
  },
  {
    id: "S3a", title: "Mover denied: separation of duties beats a valid approval", skill: "mover-orchestrator", doc: "demo/scenarios/S3-mover.md", block: 0,
    record: "S3a-adele-vance-sod.json", gate: false, writes: false,
    expect: { decision: "deny", outcome: "blocked", riskLevel: "high", count: 5, tolerance: 1, budget: 20, turn1Calls: 5 },
  },
  {
    id: "S3b", title: "Mover transfer: a CSA change strips an entitlement", skill: "mover-orchestrator", doc: "demo/scenarios/S3-mover.md", block: 1,
    record: "S3b-lidia-holloway-transfer.json", gate: true, writes: true,
    expect: { decision: "allow_with_approval", outcome: "completed", riskLevel: "medium", count: 15, tolerance: 1, budget: 20, turn1Calls: 6 },
  },
  {
    id: "S3c", title: "Mover title change: low risk, straight through", skill: "mover-orchestrator", doc: "demo/scenarios/S3-mover.md", block: 2,
    record: "S3c-alex-wilber-title.json", gate: false, writes: true,
    expect: { decision: "allow", outcome: "completed", riskLevel: "low", count: 6, tolerance: 1, budget: 20, turn1Calls: null },
  },
  {
    id: "S4", title: "Leaver: ordered offboarding with a legal hold", skill: "leaver-orchestrator", doc: "demo/scenarios/S4-leaver.md", block: 0,
    record: "S4-nestor-wilke-leaver.json", gate: true, writes: true,
    expect: { decision: "allow_with_approval", outcome: "completed", riskLevel: "high", count: 11, tolerance: 1, budget: 25, turn1Calls: 4 },
  },
];
const BOOT_GROUPS = [["S0a", "S0b", "S0c", "S1", "S2"], ["S3a", "S3b", "S3c"], ["S4"]];

const upn = (local) => `${local}@contoso.local`;
const G = {
  allEmployees: "All Employees", financeUsers: "SG-Finance-Users", apRequestors: "SG-Finance-AP-Requestors", apApprovers: "SG-Finance-AP-Approvers",
  treasury: "SG-Finance-Treasury-Payments", engUsers: "SG-Engineering-Users", prodDeploy: "SG-Engineering-ProdDeploy", legalHold: "SG-Legal-Hold",
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const DEFAULTS = {
  model: "claude-fable-5-1", effort: "xhigh", port: 8990, token: "dev-token", maxTurns: 60, budgetUsd: 6, invoke: "slash",
  out: join(repoRoot, "demo", "recordings"), timeoutMs: 15 * 60_000,
};
const USAGE = `Usage: node demo/scripts/record-scenarios.mjs [options]
  --only S1,S3c        run a subset (default: all six)
  --dry-run            print the claude invocations and prompt files; start nothing
  --check              offline: re-assert demo/expected/*.decision-record.json (and run-summary.json if present); no mock, no model
  --rerender [S2,S4]   offline: rebuild transcripts from the saved stream files (after a renderer change); no mock, no model
  --write-expected     with --rerender: when a scenario's saved stream passes every check, write its record into demo/expected and mark the summary row ok (use after fixing a schema or assertion bug that failed an otherwise good run)
  --external-mock      use the mock already listening on --port instead of starting one (no resets between scenarios)
  --no-expected        do not write into demo/expected (recordings are still written)
  --keep-going         continue with the next scenario after a failure
  --invoke slash|prompt  how the skill is invoked: "/skill" on the first prompt line (default) or a wrapper sentence
  --model <id>         default ${DEFAULTS.model}
  --effort <level>     default ${DEFAULTS.effort}; "none" omits the flag
  --port <n>           mock port (default ${DEFAULTS.port}); --token <t> (default ${DEFAULTS.token})
  --out <dir>          recordings directory (default demo/recordings)
  --capture            also have the mock log every SCIM request to <out>/.run/mock-boot-<n>.jsonl (contains the generated password)
  CLAUDE_BIN           environment override for the claude executable`;

function parseArgs(argv) {
  const o = { ...DEFAULTS, only: null, dryRun: false, check: false, rerender: null, externalMock: false, noExpected: false, keepGoing: false, capture: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const take = () => { const eq = a.indexOf("="); if (eq !== -1) return a.slice(eq + 1); const n = argv[++i]; if (n === undefined) throw new Error(`${a} needs a value`); return n; };
    const is = (name) => a === name || a.startsWith(`${name}=`);
    if (a === "--help" || a === "-h") { process.stdout.write(`${USAGE}\n`); process.exit(0); }
    else if (is("--only")) o.only = take().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--check") o.check = true;
    else if (a === "--rerender") { const next = argv[i + 1]; o.rerender = next && !next.startsWith("-") ? argv[++i].split(",").map((s) => s.trim()).filter(Boolean) : []; }
    else if (a.startsWith("--rerender=")) o.rerender = a.slice(11).split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--write-expected") o.writeExpected = true;
    else if (a === "--external-mock") o.externalMock = true;
    else if (a === "--no-expected") o.noExpected = true;
    else if (a === "--keep-going") o.keepGoing = true;
    else if (a === "--capture") o.capture = true;
    else if (is("--invoke")) o.invoke = take();
    else if (is("--model")) o.model = take();
    else if (is("--effort")) o.effort = take();
    else if (is("--port")) o.port = Number(take());
    else if (is("--token")) o.token = take();
    else if (is("--out")) o.out = resolve(repoRoot, take());
    else throw new Error(`unknown option ${a}\n${USAGE}`);
  }
  if (!["slash", "prompt"].includes(o.invoke)) throw new Error(`--invoke must be slash or prompt`);
  return o;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sorted = (xs) => [...xs].sort();
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 16);
const out = (s) => process.stdout.write(`${s}\n`);
const ensureDir = (d) => mkdirSync(d, { recursive: true });

function fencedBlocks(markdown) {
  const blocks = [];
  const re = /```[^\n]*\n([\s\S]*?)\n```/g;
  let m;
  while ((m = re.exec(markdown)) !== null) blocks.push(m[1]);
  return blocks;
}

/** The verbatim prompt block for a scenario, checked against its source record. */
function scenarioPrompt(scenario) {
  const md = readFileSync(join(repoRoot, scenario.doc), "utf8").replace(/\r\n/g, "\n");
  if (scenario.promptFence) {
    // Free-text prompts live in fences tagged with the scenario id, e.g. ```text S0a
    const tag = scenario.promptFence.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = md.match(new RegExp("```" + tag + "\\n([\\s\\S]*?)\\n```"));
    if (!m) throw new Error(`${scenario.id}: fence \`\`\`${scenario.promptFence} not found in ${scenario.doc}`);
    return m[1].trimEnd();
  }
  const blocks = fencedBlocks(md).filter((b) => b.includes('"sourceRecordId"'));
  const body = blocks[scenario.block];
  if (!body) throw new Error(`${scenario.id}: prompt block ${scenario.block} not found in ${scenario.doc}`);
  const json = body.slice(body.indexOf("{"), body.lastIndexOf("}") + 1);
  const inDoc = JSON.parse(json);
  const inFile = readJson(join(repoRoot, "demo", "source-records", scenario.record));
  if (!deepEqual(inDoc, inFile)) throw new Error(`${scenario.id}: the record inside ${scenario.doc} differs from demo/source-records/${scenario.record}`);
  return body.trimEnd();
}

function buildPrompt(scenario, invoke) {
  const body = scenarioPrompt(scenario);
  if (invoke === "slash") return `/${scenario.skill}\n${body}\n`;
  return `Use the ${scenario.skill} skill (invoke it with the Skill tool first) and follow it exactly, step by step, including the policy load, the check table, the preview and the decision record.\n\n${body}\n`;
}

function resolveClaude() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  if (process.platform === "win32") {
    const r = spawnSync("where.exe", ["claude"], { encoding: "utf8" });
    const lines = (r.stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    return lines.find((l) => /\.exe$/i.test(l)) ?? lines[0] ?? "claude";
  }
  return "claude";
}

/** Flags supported by the installed CLI, from its --help, so older or newer builds degrade gracefully. */
function claudeCapabilities(bin) {
  const r = runSyncClaude(bin, ["--help"]);
  const help = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const v = runSyncClaude(bin, ["--version"]);
  const version = `${v.stdout ?? ""}`.trim().split(/\s+/)[0] || "unknown";
  return { version, supports: (flag) => help.includes(flag) };
}

function spawnSpec(bin, args) {
  if (/\.(cmd|bat)$/i.test(bin)) {
    const q = (s) => (/[\s"&|<>^*]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
    return { command: `"${bin}" ${args.map(q).join(" ")}`, args: undefined, shell: true };
  }
  return { command: bin, args, shell: false };
}

function runSyncClaude(bin, args) {
  const spec = spawnSpec(bin, args);
  return spawnSync(spec.command, spec.args, { shell: spec.shell, encoding: "utf8", windowsHide: true });
}

function childEnv() {
  const env = { ...process.env, MCP_TIMEOUT: "60000" };
  for (const k of Object.keys(env)) {
    if (k.startsWith("ENTRA_SCIM_") || k === "CLAUDECODE" || k === "CLAUDE_CODE_ENTRYPOINT") delete env[k];
  }
  return env;
}

// ---------------------------------------------------------------------------
// Mock lifecycle and SCIM probes (loopback only)
// ---------------------------------------------------------------------------

function portInUse(port) {
  return new Promise((r) => {
    const s = createConnection({ host: "127.0.0.1", port });
    s.once("connect", () => { s.destroy(); r(true); });
    s.once("error", () => r(false));
  });
}

function makeScim(baseUrl, token) {
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  const qs = (params) => Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");
  async function get(path, params = {}) {
    const q = qs(params);
    const res = await fetch(`${baseUrl}${path}${q ? `?${q}` : ""}`, { headers });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} on GET ${path}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : undefined;
  }
  const resources = (page) => page?.resources ?? page?.Resources ?? [];
  return {
    get,
    async users(params = {}) { return resources(await get("/Users", { count: 999, ...params })); },
    async groups(params = {}) { return resources(await get("/Groups", { count: 999, ...params })); },
    async userByName(userName) { const r = await this.users({ filter: `userName eq "${userName}"`, attributes: "id,userName,displayName,active,title" }); return r[0]; },
    async membershipNames(userId) { return sorted((await this.groups({ filter: `members.value eq "${userId}"`, attributes: "id,displayName" })).map((g) => g.displayName)); },
    async userFull(userId) { return get(`/Users/${encodeURIComponent(userId)}`); },
    async csa(userId, sets) { return (await get(`/Users/${encodeURIComponent(userId)}`, { attributes: sets.map((s) => `${CSA_URN}:${s}`).join(",") }))[CSA_URN] ?? {}; },
  };
}

class Mock {
  constructor(opts, runDir) { this.opts = opts; this.runDir = runDir; this.child = null; this.boot = 0; this.baseUrl = `http://127.0.0.1:${opts.port}`; this.scim = makeScim(this.baseUrl, opts.token); }
  async start() {
    this.boot++;
    if (this.opts.externalMock) {
      if (!(await portInUse(this.opts.port))) throw new Error(`--external-mock: nothing is listening on ${this.baseUrl}`);
      out(`mock: using the external mock on ${this.baseUrl} (no reset)`);
      return;
    }
    if (await portInUse(this.opts.port)) throw new Error(`port ${this.opts.port} is already in use; stop that mock (Ctrl+C or taskkill) or pass --external-mock`);
    if (!existsSync(MOCK_CLI)) throw new Error(`mock binary not found at ${MOCK_CLI}; run npm install`);
    ensureDir(this.runDir);
    const logPath = join(this.runDir, `mock-boot-${this.boot}.log`);
    const fd = openSync(logPath, "w");
    const args = [MOCK_CLI, "--seed", SEED_FILE, "--port", String(this.opts.port), "--token", this.opts.token];
    if (this.opts.capture) args.push("--capture", join(this.runDir, `mock-boot-${this.boot}.jsonl`));
    this.child = spawn(process.execPath, args, { cwd: repoRoot, stdio: ["ignore", fd, fd], windowsHide: true });
    closeSync(fd);
    const started = Date.now();
    let ready = false;
    while (Date.now() - started < 15_000) {
      if (this.child.exitCode !== null) throw new Error(`the mock exited early; see ${rel(logPath)}`);
      try { await this.scim.get("/Users", { attributes: "id", count: 1 }); ready = true; break; } catch { await sleep(250); }
    }
    if (!ready) throw new Error("the mock did not come up within 15 s");
    const links = spawnSync(process.execPath, [SEED_LINKS, SEED_FILE, "--base-url", this.baseUrl, "--token", this.opts.token], { cwd: repoRoot, encoding: "utf8" });
    if (links.status !== 0) throw new Error(`seed-links failed:\n${links.stdout}\n${links.stderr}`);
    const applied = links.stdout.match(/seed-links: applied .*$/m)?.[0] ?? "(no summary line)";
    out(`mock: boot ${this.boot} ready on ${this.baseUrl}; ${applied}`);
  }
  async nameMap() {
    const map = new Map();
    for (const u of await this.scim.users({ attributes: "id,userName" })) map.set(u.id, u.userName.replace(/@contoso\.local$/, ""));
    for (const g of await this.scim.groups({ attributes: "id,displayName" })) map.set(g.id, g.displayName);
    return map;
  }
  /** Kill the mock and wait until it has exited and the port is free, so the next boot does not race it. */
  async stop() {
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) {
      const exited = new Promise((r) => child.once("exit", r));
      child.kill();
      await Promise.race([exited, sleep(5000)]);
      if (child.exitCode === null && process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    }
    if (this.opts.externalMock) return;
    const started = Date.now();
    while ((await portInUse(this.opts.port)) && Date.now() - started < 10_000) await sleep(250);
  }
}

/** Pre and post conditions, in the same vocabulary as scripts/verify-tool-sequences.mjs. */
const PROBES = {
  S2: {
    async pre(s) { const u = await s.userByName(upn("priya.natarajan")); return u ? "priya.natarajan already exists (restart the mock)" : null; },
    async post(s) {
      const u = await s.userByName(upn("priya.natarajan"));
      if (!u) return "priya.natarajan was not created";
      if (u.active !== true) return `priya.natarajan active=${u.active}, expected true`;
      const held = await s.membershipNames(u.id);
      const want = sorted([G.allEmployees, G.financeUsers, G.apRequestors, G.treasury]);
      return deepEqual(held, want) ? null : `memberships ${JSON.stringify(held)} != ${JSON.stringify(want)}`;
    },
  },
  S3a: {
    async pre(s) { const u = await s.userByName(upn("adele.vance")); const held = await s.membershipNames(u.id); return held.includes(G.apRequestors) && !held.includes(G.apApprovers) ? null : `adele holds ${JSON.stringify(held)}`; },
    async post(s) { const u = await s.userByName(upn("adele.vance")); const held = await s.membershipNames(u.id); return held.includes(G.apApprovers) ? "adele was given SG-Finance-AP-Approvers" : null; },
  },
  S3b: {
    async pre(s) { const u = await s.userByName(upn("lidia.holloway")); const full = await s.userFull(u.id); return full[ENTERPRISE_URN]?.department === "Finance" ? null : `lidia department=${full[ENTERPRISE_URN]?.department}`; },
    async post(s) {
      const u = await s.userByName(upn("lidia.holloway"));
      const full = await s.userFull(u.id);
      if (full[ENTERPRISE_URN]?.department !== "Engineering") return `lidia department=${full[ENTERPRISE_URN]?.department}, expected Engineering`;
      const held = await s.membershipNames(u.id);
      const want = sorted([G.allEmployees, G.engUsers]);
      if (!deepEqual(held, want)) return `memberships ${JSON.stringify(held)} != ${JSON.stringify(want)}`;
      const csa = await s.csa(u.id, ["Employment"]);
      return csa.Employment?.CostCenter === "ENG-210" ? null : `CostCenter=${csa.Employment?.CostCenter}, expected ENG-210`;
    },
  },
  S3c: {
    async pre(s) { const u = await s.userByName(upn("alex.wilber")); return u?.title === "Software Engineer" ? null : `alex title=${u?.title}`; },
    async post(s) { const u = await s.userByName(upn("alex.wilber")); if (u?.title !== "Senior Software Engineer") return `alex title=${u?.title}, expected Senior Software Engineer`; return u.active === true ? null : "alex is no longer active"; },
  },
  S4: {
    async pre(s) { const u = await s.userByName(upn("nestor.wilke")); return u?.active === true ? null : `nestor active=${u?.active}`; },
    async post(s) {
      const u = await s.userByName(upn("nestor.wilke"));
      if (u.active !== false) return `nestor active=${u.active}, expected false`;
      const held = await s.membershipNames(u.id);
      if (!deepEqual(held, [G.legalHold])) return `residual memberships ${JSON.stringify(held)} != ["SG-Legal-Hold"]`;
      const full = await s.userFull(u.id);
      const leave = full[ENTRA_USER_URN]?.employeeLeaveDateTime;
      return leave === "2026-09-20T09:00:00Z" ? null : `employeeLeaveDateTime=${leave}`;
    },
  },
};

// ---------------------------------------------------------------------------
// Running one Claude turn and reading its stream
// ---------------------------------------------------------------------------

function claudeArgs(o, caps, { sessionId, resume, mcpConfig }) {
  const a = ["-p", "--output-format", "stream-json", "--verbose"];
  if (resume) a.push("--resume", resume);
  else a.push("--session-id", sessionId);
  a.push("--model", o.model);
  if (o.effort !== "none" && caps.supports("--effort")) a.push("--effort", o.effort);
  a.push("--permission-mode", "dontAsk");
  if (caps.supports("--permission-prompts")) a.push("--permission-prompts", "none");
  a.push("--allowedTools", `${TOOL_PREFIX}*`, `${INTAKE_PREFIX}*`, "Skill", "Read", "Glob", "Grep");
  a.push("--disallowedTools", "Bash", "PowerShell", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Agent", "Task");
  a.push("--strict-mcp-config", "--mcp-config", mcpConfig);
  if (caps.supports("--setting-sources")) a.push("--setting-sources", "project");
  if (caps.supports("--max-turns")) a.push("--max-turns", String(o.maxTurns));
  if (caps.supports("--max-budget-usd")) a.push("--max-budget-usd", String(o.budgetUsd));
  return a;
}

/** Replace the generated password everywhere in an event before it touches disk; remember it for the leak scan. */
function redact(event, secrets) {
  if (event?.type !== "assistant") return event;
  for (const block of event.message?.content ?? []) {
    if (block.type === "tool_use" && block.input && typeof block.input === "object" && "password" in block.input) {
      if (typeof block.input.password === "string" && block.input.password.length > 0) secrets.add(block.input.password);
      block.input = { ...block.input, password: "<redacted>" };
    }
  }
  return event;
}

/** Replace every known secret in a string. */
function scrub(text, secrets) {
  let s = text;
  for (const secret of secrets) if (s.includes(secret)) s = s.split(secret).join("<redacted>");
  return s;
}

function runClaudeTurn(bin, args, prompt, { rawPath, timeoutMs, secrets, leakSites }) {
  return new Promise((resolveTurn, reject) => {
    const spec = spawnSpec(bin, args);
    const child = spawn(spec.command, spec.args, { shell: spec.shell, cwd: repoRoot, env: childEnv(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const events = [];
    const rawLines = [];
    let buffer = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`claude did not finish within ${timeoutMs / 60_000} min`)); }, timeoutMs);
    const handleLine = (line) => {
      if (!line.trim()) return;
      let ev;
      try { ev = JSON.parse(line); } catch { rawLines.push(scrub(JSON.stringify({ type: "non-json", line }), secrets)); return; }
      redact(ev, secrets); // learns the password from provision_user's input and blanks that field
      // The password can also surface elsewhere in the stream (a mirrored tool_use, a hook payload):
      // scrub the serialised event as a whole and note where, so the transcript can say so.
      let serialised = JSON.stringify(ev);
      for (const secret of secrets) {
        if (serialised.includes(secret)) {
          leakSites.add(`${ev.type}${ev.subtype ? `/${ev.subtype}` : ""}`);
          serialised = serialised.split(secret).join("<redacted>");
        }
      }
      events.push(JSON.parse(serialised));
      rawLines.push(serialised);
    };
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) { handleLine(buffer.slice(0, nl)); buffer = buffer.slice(nl + 1); }
    });
    child.stderr.on("data", (c) => { stderr += c.toString(); });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (buffer.trim()) handleLine(buffer);
      writeFileSync(rawPath, rawLines.join("\n") + "\n");
      resolveTurn({ events, stderr, code });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
  });
}

/** Pull the facts out of one turn's stream. */
function digestTurn(events) {
  const init = events.find((e) => e.type === "system" && e.subtype === "init");
  const result = events.find((e) => e.type === "result");
  const texts = [];
  const calls = [];
  const pending = new Map();
  const denied = events.filter((e) => e.type === "system" && /permission/i.test(e.subtype ?? ""));
  let other = 0;
  for (const ev of events) {
    if (ev.type === "assistant") {
      for (const block of ev.message?.content ?? []) {
        if (block.type === "text" && block.text) texts.push(block.text);
        else if (block.type === "tool_use") {
          const prefix = PREFIXES.find((p) => block.name?.startsWith(p));
          if (prefix) {
            const call = { id: block.id, server: prefix === TOOL_PREFIX ? SERVER_NAME : INTAKE_SERVER, name: block.name.slice(prefix.length), input: block.input ?? {}, result: null, isError: false };
            calls.push(call);
            pending.set(block.id, call);
          } else {
            other++;
            texts.push(`> (${block.name} ${summarizeOther(block)})`);
          }
        }
      }
    } else if (ev.type === "user") {
      for (const block of ev.message?.content ?? []) {
        if (block.type === "tool_result" && pending.has(block.tool_use_id)) {
          const call = pending.get(block.tool_use_id);
          call.result = typeof block.content === "string" ? block.content : (block.content ?? []).map((c) => c.text ?? "").join("\n");
          call.isError = Boolean(block.is_error);
        }
      }
    }
  }
  const finalText = result?.result ?? "";
  if (finalText && !texts.includes(finalText)) texts.push(finalText);
  return { events, init, result, texts, calls, otherToolUses: other, deniedEvents: denied };
}

function summarizeOther(block) {
  const i = block.input ?? {};
  if (block.name === "Skill") return i.skill ?? i.name ?? "";
  if (block.name === "Read") return i.file_path ? rel(String(i.file_path)) : "";
  return "";
}

function extractGate(texts) {
  const joined = texts.join("\n");
  const m = joined.match(GATE_RE);
  if (m) return m[1];
  const ids = new Set();
  let a;
  while ((a = APPROVE_RE.exec(joined)) !== null) ids.add(a[1]);
  APPROVE_RE.lastIndex = 0;
  return ids.size === 1 ? [...ids][0] : null;
}

function extractRecord(texts) {
  const joined = texts.join("\n");
  const re = /```json\s*\n([\s\S]*?)\n```/g;
  let m;
  let found = null;
  while ((m = re.exec(joined)) !== null) {
    try {
      const obj = JSON.parse(m[1]);
      if (obj && typeof obj === "object" && "recordVersion" in obj && "correlationId" in obj) found = obj;
    } catch { /* not the record */ }
  }
  return found;
}

function extractToolCallsLine(texts) {
  const m = texts.join("\n").match(/^Tool calls:\s*(\d+)\s+of\s+(\d+)/m);
  return m ? { count: Number(m[1]), budget: Number(m[2]) } : null;
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

function check(list, name, pass, detail = "") { list.push({ check: name, pass: Boolean(pass), detail: String(detail ?? "") }); return pass; }

/** Record-level checks; shared by the live run and --check. */
function recordChecks(scenario, record, list) {
  const e = scenario.expect;
  check(list, "record present", Boolean(record), record ? "" : "no fenced decision record found");
  if (!record) return;
  check(list, `decision = ${e.decision}`, record.decision === e.decision, record.decision);
  check(list, `outcome = ${e.outcome}`, record.outcome === e.outcome, record.outcome);
  check(list, `riskLevel = ${e.riskLevel}`, record.riskLevel === e.riskLevel, record.riskLevel);
  if (e.reasonCode) check(list, `reasonCode ${e.reasonCode} recorded`, JSON.stringify(record).includes(`"${e.reasonCode}"`), "");
  check(list, `skill = ${scenario.skill}`, record.skill === scenario.skill, record.skill);
  check(list, "host = claude-code", record.host === "claude-code", record.host);
  check(list, "dryRun = false", record.dryRun === false, String(record.dryRun));
  check(list, "correlationId format", CORRELATION_RE.test(record.correlationId ?? ""), record.correlationId);
  const count = record.toolCalls?.count;
  check(list, `toolCalls.count within ${e.count}±${e.tolerance}`, Number.isInteger(count) && Math.abs(count - e.count) <= e.tolerance, String(count));
  check(list, `toolCalls.budget = ${e.budget}`, record.toolCalls?.budget === e.budget, String(record.toolCalls?.budget));
  const byToolSum = Object.values(record.toolCalls?.byTool ?? {}).reduce((s, n) => s + n, 0);
  check(list, "sum(byTool) = count", byToolSum === count, `${byToolSum} vs ${count}`);
  check(list, "executedActions.length = count", (record.executedActions ?? []).length === count, `${(record.executedActions ?? []).length} vs ${count}`);
  check(list, "no password key in record", !JSON.stringify(record).includes('"password"'));
  if (e.outcome === "completed") check(list, "verificationFindings.proved non-empty, all pass", (record.verificationFindings?.proved ?? []).length > 0 && record.verificationFindings.proved.every((p) => p.result === "pass"));
  if (scenario.id === "S3c") check(list, "approvals empty", Array.isArray(record.approvals) && record.approvals.length === 0, JSON.stringify(record.approvals));
  if (scenario.id === "S4") {
    const retained = (record.details?.retained ?? []).map((r) => (typeof r === "string" ? r : r?.displayName)).sort();
    check(list, 'details.retained names = ["SG-Legal-Hold"]', deepEqual(retained, [G.legalHold]), JSON.stringify(retained));
  }
}

/** Trace-level checks over the MCP tool calls actually observed in the stream. */
function traceChecks(scenario, turns, record, nameMap, list) {
  const calls = turns.flatMap((t) => t.calls);
  const names = calls.map((c) => c.name);
  const idx = (pred) => names.findIndex(pred);
  const groupIdByName = new Map([...nameMap].filter(([, n]) => n.startsWith("SG-") || n === G.allEmployees).map(([id, n]) => [n, id]));
  check(list, "observed MCP calls = record count", record && calls.length === record.toolCalls?.count, `${calls.length} observed vs ${record?.toolCalls?.count}`);
  const tcl = extractToolCallsLine(turns.at(-1).texts);
  check(list, "Tool calls line matches record", tcl && record && tcl.count === record.toolCalls?.count && tcl.budget === record.toolCalls?.budget, tcl ? `${tcl.count} of ${tcl.budget}` : "line not found");
  check(list, "no permission denials", turns.every((t) => (t.result?.permission_denials ?? []).length === 0 && t.deniedEvents.length === 0), turns.map((t) => (t.result?.permission_denials ?? []).map((d) => d.tool_name ?? JSON.stringify(d)).join(",")).filter(Boolean).join(" | "));
  check(list, "no dryRun results", calls.every((c) => !/"dryRun"\s*:\s*true/.test(c.result ?? "")));
  check(list, "no discovery tools", !names.some((n) => DISCOVERY_TOOLS.includes(n)));
  check(list, "no group create/update/delete", !names.some((n) => GROUP_ADMIN_TOOLS.includes(n)));
  check(list, "every list_users has a filter", calls.filter((c) => c.name === "list_users").every((c) => Array.isArray(c.input.filter) && c.input.filter.length > 0));
  check(list, "result events succeeded", turns.every((t) => t.result?.subtype === "success" && !t.result?.is_error), turns.map((t) => t.result?.subtype).join(","));
  check(list, `model pinned (${turns[0].init?.model ?? "?"})`, turns.every((t) => Object.keys(t.result?.modelUsage ?? { [t.init?.model]: 1 }).every((m) => m === turns[0].init?.model)));
  if (scenario.expect.turn1Calls !== null) {
    const n = turns[0].calls.length;
    check(list, `turn 1 calls = ${scenario.expect.turn1Calls} (soft)`, true, n === scenario.expect.turn1Calls ? String(n) : `observed ${n} (informational)`);
  }
  const writes = calls.filter((c) => WRITE_TOOLS.includes(c.name));
  switch (scenario.id) {
    case "S0a":
    case "S0b":
    case "S0c": {
      check(list, "exactly one system_one call", calls.length === 1 && calls[0].name === "system_one" && calls[0].server === INTAKE_SERVER, names.join(","));
      check(list, "no entra-scim-mock calls", calls.every((c) => c.server !== SERVER_NAME));
      check(list, "single turn (no gate)", turns.length === 1, String(turns.length));
      check(list, "details.intake.backend = stub", record?.details?.intake?.backend === "stub", String(record?.details?.intake?.backend));
      if (scenario.id === "S0a") check(list, "details.intake.route = mover-orchestrator", record?.details?.intake?.route === "mover-orchestrator", String(record?.details?.intake?.route));
      break;
    }
    case "S1":
      check(list, "zero MCP calls", calls.length === 0, String(calls.length));
      break;
    case "S2": {
      const prov = calls.filter((c) => c.name === "provision_user");
      check(list, "exactly one provision_user, inactive, externalId WD-000123", prov.length === 1 && prov[0].input.active === false && prov[0].input.externalId === "WD-000123", JSON.stringify(prov.map((p) => ({ active: p.input.active, externalId: p.input.externalId }))));
      const csaIdx = idx((n) => n === "update_user_custom_security_attributes");
      const firstAdd = idx((n) => n === "add_group_members");
      check(list, "CSA write before the first add", csaIdx !== -1 && firstAdd !== -1 && csaIdx < firstAdd, `${csaIdx} < ${firstAdd}`);
      const adds = calls.filter((c) => c.name === "add_group_members");
      check(list, "four single-member adds", adds.length === 4 && adds.every((a) => Array.isArray(a.input.memberIds) && a.input.memberIds.length === 1), String(adds.length));
      check(list, "last two calls: update_user (activate) then get_user", names.at(-2) === "update_user" && names.at(-1) === "get_user", names.slice(-2).join(" -> "));
      break;
    }
    case "S3a":
      check(list, "no writes", writes.length === 0, writes.map((w) => w.name).join(","));
      break;
    case "S3b": {
      const upd = calls.filter((c) => c.name === "update_user");
      const firstMembership = idx((n) => n === "remove_group_member" || n === "add_group_members");
      const updIdx = idx((n) => n === "update_user");
      check(list, "one update_user before any membership change", upd.length === 1 && updIdx !== -1 && (firstMembership === -1 || updIdx < firstMembership), `${upd.length} update_user; index ${updIdx} vs ${firstMembership}`);
      check(list, "no userName/mailNickname in PATCH ops", upd.every((u) => (u.input.operations ?? []).every((op) => !/userName|mailNickname/i.test(String(op.path ?? "")))));
      const removes = names.filter((n) => n === "remove_group_member").length;
      const adds = names.filter((n) => n === "add_group_members").length;
      const lastRemove = names.lastIndexOf("remove_group_member");
      const firstAdd = idx((n) => n === "add_group_members");
      check(list, "three removes before one add", removes === 3 && adds === 1 && lastRemove < firstAdd, `${removes} removes, ${adds} adds`);
      const legal = groupIdByName.get(G.legalHold);
      check(list, "SG-Legal-Hold never touched", !calls.some((c) => c.input.id === legal));
      break;
    }
    case "S3c": {
      check(list, "exactly one write: update_user replace title", writes.length === 1 && writes[0].name === "update_user" && (writes[0].input.operations ?? []).length === 1 && writes[0].input.operations[0].path === "title", writes.map((w) => `${w.name}:${JSON.stringify(w.input.operations ?? "")}`).join(" | "));
      check(list, "no unfiltered list_groups (nothing added)", calls.filter((c) => c.name === "list_groups").every((c) => Array.isArray(c.input.filter) && c.input.filter.length > 0));
      check(list, "single turn (no gate)", turns.length === 1, String(turns.length));
      break;
    }
    case "S4": {
      check(list, "first write disables (update_user active=false)", writes[0]?.name === "update_user" && (writes[0].input.operations ?? []).some((op) => op.path === "active" && op.value === false), writes[0]?.name);
      check(list, "second write sets employeeLeaveDateTime 2026-09-20T09:00:00Z", writes[1]?.name === "update_user_lifecycle" && writes[1].input.employeeLeaveDateTime === "2026-09-20T09:00:00Z", `${writes[1]?.name} ${writes[1]?.input?.employeeLeaveDateTime}`);
      const removes = calls.filter((c) => c.name === "remove_group_member");
      check(list, "three removes, ProdDeploy first", removes.length === 3 && removes[0].input.id === groupIdByName.get(G.prodDeploy), removes.map((r) => nameMap.get(r.input.id) ?? r.input.id).join(" -> "));
      check(list, "no deprovision_user", !names.includes("deprovision_user"));
      check(list, "SG-Legal-Hold never removed", !removes.some((r) => r.input.id === groupIdByName.get(G.legalHold)));
      break;
    }
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Schema validation (the same ajv that validate:policy uses)
// ---------------------------------------------------------------------------

let ajvValidate = null;
async function validateRecord(record) {
  if (!ajvValidate) {
    try {
      const { default: Ajv2020 } = await import("ajv/dist/2020.js");
      const { default: addFormats } = await import("ajv-formats");
      const ajv = new Ajv2020({ allErrors: true, strict: false });
      addFormats(ajv);
      ajvValidate = ajv.compile(readJson(RECORD_SCHEMA));
    } catch (err) {
      throw new Error(`ajv is not installed (run npm install): ${err.message}`);
    }
  }
  const ok = ajvValidate(record);
  return ok ? null : (ajvValidate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`).slice(0, 8).join("; ");
}

// ---------------------------------------------------------------------------
// Transcript and summary rendering
// ---------------------------------------------------------------------------

/** Learn id -> name pairs from what the tools returned (seeded objects, and the user a joiner created). */
function namesFromCalls(calls, nameMap) {
  const local = (u) => String(u).replace(/@contoso\.local$/, "");
  for (const call of calls) {
    if (!call.result || call.isError) continue;
    let r;
    try { r = JSON.parse(call.result); } catch { continue; }
    for (const res of Array.isArray(r?.resources) ? r.resources : []) {
      if (res?.id && res.userName) nameMap.set(res.id, local(res.userName));
      else if (res?.id && res.displayName) nameMap.set(res.id, res.displayName);
    }
    if (r?.id && call.name === "provision_user" && call.input?.userName) nameMap.set(r.id, local(call.input.userName));
    if (r?.id && call.name === "get_user" && r.userName) nameMap.set(r.id, local(r.userName));
  }
  return nameMap;
}

function nameIds(text, nameMap) {
  return text.replace(GUID_RE, (g) => { const n = nameMap.get(g) ?? nameMap.get(g.toLowerCase()); return n ? `<${n}>` : g; });
}

function argsSummary(call, nameMap) {
  const i = { ...call.input };
  if ("password" in i) i.password = "<redacted>";
  let s = JSON.stringify(i);
  s = nameIds(s, nameMap).replace(/"([A-Za-z_][A-Za-z0-9_]*)":/g, "$1: ");
  return s.length > 260 ? `${s.slice(0, 257)}...` : s;
}

function resultSummary(call, nameMap) {
  if (call.result === null) return "(no result)";
  if (call.isError) return `error ${nameIds(call.result.replace(/\s+/g, " ").slice(0, 160), nameMap)}`;
  try {
    const r = JSON.parse(call.result);
    if (r.dryRun) return "dryRun";
    const bits = [];
    if ("totalResults" in r) bits.push(`totalResults ${r.totalResults}`);
    else if (Array.isArray(r.resources)) bits.push(`${r.resources.length} resource(s)`);
    if (r.id && !("totalResults" in r)) bits.push(`id ${nameIds(String(r.id), nameMap)}`);
    if ("active" in r) bits.push(`active ${r.active}`);
    if ("patchCalls" in r) bits.push(`patchCalls ${r.patchCalls}`);
    if (r.answers && typeof r.answers === "object") bits.push(`${r.backend ?? "?"} ${r.model ?? ""}: ${Object.entries(r.answers).map(([k, a]) => `${k}=${a.choice ?? (a.noul !== undefined ? a.noul : a.score)}`).join(", ")}`);
    if ("noChanges" in r) bits.push(`noChanges ${r.noChanges}`);
    return bits.length ? `ok, ${bits.join(", ")}` : "ok";
  } catch {
    return "ok";
  }
}

function renderTranscript(scenario, ctx) {
  const { turns, prompts, nameMap, meta, checks, probes } = ctx;
  const lines = [];
  lines.push(`# ${scenario.id} — ${scenario.title}`, "");
  lines.push("| | |", "|---|---|");
  lines.push(`| Skill | \`${scenario.skill}\` |`);
  lines.push(`| Record | ${scenario.record ? `\`demo/source-records/${scenario.record}\`` : `free text in \`${scenario.doc}\``} |`);
  lines.push(`| Model | ${meta.model}${meta.effort !== "none" ? ` (effort ${meta.effort})` : ""} |`);
  lines.push(`| Claude Code | ${meta.claudeCodeVersion} |`);
  lines.push(`| entra-scim-mcp | ${meta.entraScimMcpVersion} (mock, boot ${meta.boot}) |`);
  lines.push(`| Policy | ${meta.policyId} v${meta.policyVersion} |`);
  lines.push(`| Recorded | ${meta.recordedAt} |`);
  lines.push(`| Session | \`${meta.sessionId}\` |`);
  lines.push("", "Object ids are rendered as `<userName>` or `<displayName>` for readability; the raw ids are in the gitignored stream files and in `demo/expected/`. The generated password is redacted everywhere.", "");
  let n = 0;
  turns.forEach((turn, ti) => {
    lines.push(`## Turn ${ti + 1} — operator`, "", "```text", prompts[ti].trimEnd(), "```", "");
    lines.push(`## Turn ${ti + 1} — assistant`, "");
    // interleave: text blocks in order, with tool calls where they happened
    for (const ev of turn.events) {
      if (ev.type !== "assistant") continue;
      for (const block of ev.message?.content ?? []) {
        if (block.type === "text" && block.text) lines.push(nameIds(block.text, nameMap), "");
        else if (block.type === "tool_use") {
          if (PREFIXES.some((p) => block.name?.startsWith(p))) {
            n++;
            const call = turn.calls.find((c) => c.id === block.id);
            lines.push(`> #${n} ${call.name} ${argsSummary(call, nameMap)} → ${resultSummary(call, nameMap)}`, "");
          } else {
            lines.push(`> (${block.name} ${summarizeOther(block)})`, "");
          }
        }
      }
    }
    const r = turn.result ?? {};
    lines.push(`_Turn ${ti + 1}: ${r.num_turns ?? "?"} model turns, ${((r.duration_ms ?? 0) / 1000).toFixed(0)} s, cost ${r.total_cost_usd !== undefined ? `US$${Number(r.total_cost_usd).toFixed(2)}` : "n/a"}, ${turn.calls.length} MCP call(s)._`, "");
  });
  if (ctx.leakSites?.size) lines.push(`_Redaction: the generated password also appeared in ${ctx.leakSites.size} raw stream event type(s) (${[...ctx.leakSites].join(", ")}) and was replaced there before anything was written._`, "");
  lines.push("## Mock state", "");
  lines.push(`- Before: ${probes.pre === undefined ? "not probed" : probes.pre === null ? "as expected" : `UNEXPECTED: ${probes.pre}`}`);
  lines.push(`- After: ${probes.post === undefined ? "not probed" : probes.post === null ? "as expected" : `UNEXPECTED: ${probes.post}`}`, "");
  lines.push("## Assertions", "", "| Check | Result | Detail |", "|---|---|---|");
  for (const c of checks) lines.push(`| ${c.check} | ${c.pass ? "pass" : "FAIL"} | ${nameIds(c.detail, nameMap).replace(/\|/g, "\\|")} |`);
  lines.push("");
  return lines.join("\n");
}

function renderSummaryMd(summary) {
  const lines = [`# Recording run ${summary.recordedAt}`, ""];
  lines.push(`Model ${summary.model}${summary.effort !== "none" ? ` (effort ${summary.effort})` : ""} · Claude Code ${summary.claudeCodeVersion} · entra-scim-mcp ${summary.entraScimMcpVersion} · policy ${summary.policyId} v${summary.policyVersion} · seed ${summary.seedSha256}`, "");
  lines.push("| Scenario | Skill | Decision | Outcome | Risk | Tool calls | Observed | Turns | Duration | Cost | Assertions | Status |", "|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const s of summary.scenarios) {
    const dur = s.turns.reduce((a, t) => a + (t.durationMs ?? 0), 0);
    const cost = s.turns.reduce((a, t) => a + (t.costUsd ?? 0), 0);
    lines.push(`| ${s.id} | \`${s.skill}\` | ${s.decision ?? ""} | ${s.outcome ?? ""} | ${s.riskLevel ?? ""} | ${s.toolCalls ? `${s.toolCalls.count} of ${s.toolCalls.budget}` : ""} | ${s.observedMcpCalls ?? ""} | ${s.turns.length} | ${(dur / 1000).toFixed(0)} s | ${s.turns.length ? `US$${cost.toFixed(2)}` : ""} | ${s.assertions.passed}/${s.assertions.passed + s.assertions.failed} | ${s.status} |`);
  }
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

function selectScenarios(only) {
  if (!only) return SCENARIOS;
  const unknown = only.filter((id) => !SCENARIOS.some((s) => s.id === id));
  if (unknown.length) throw new Error(`unknown scenario id(s): ${unknown.join(", ")}`);
  return SCENARIOS.filter((s) => only.includes(s.id));
}

async function checkMode(o) {
  const scenarios = selectScenarios(o.only);
  let summary = null;
  const summaryPath = join(o.out, "run-summary.json");
  if (existsSync(summaryPath)) summary = readJson(summaryPath);
  let failed = 0;
  out(`record-check: ${scenarios.length} scenario(s), ${summary ? `run-summary from ${summary.recordedAt}` : "no run-summary.json"}`);
  for (const scenario of scenarios) {
    const checks = [];
    scenarioPrompt(scenario); // throws if the scenario doc and the source record disagree
    const file = join(EXPECTED_DIR, `${scenario.id}.decision-record.json`);
    if (!existsSync(file)) {
      failed++;
      out(`${scenario.id}: FAIL no ${rel(file)}; run npm run record:scenarios`);
      continue;
    }
    const record = readJson(file);
    recordChecks(scenario, record, checks);
    const schemaErr = await validateRecord(record);
    check(checks, "schema valid", !schemaErr, schemaErr ?? "");
    const row = summary?.scenarios?.find((s) => s.id === scenario.id);
    if (row) check(checks, "run-summary observed calls = record count", row.observedMcpCalls === record.toolCalls?.count, `${row.observedMcpCalls} vs ${record.toolCalls?.count}`);
    const bad = checks.filter((c) => !c.pass);
    failed += bad.length ? 1 : 0;
    out(`${scenario.id}: ${bad.length ? "FAIL" : "OK"} ${checks.filter((c) => c.pass).length}/${checks.length} checks${bad.length ? ` — ${bad.map((c) => `${c.check} (${c.detail})`).join("; ")}` : ""}`);
  }
  out(failed ? `record-check: FAILED (${failed} scenario(s))` : "record-check: all scenarios OK");
  process.exit(failed ? 1 : 0);
}

/** Rebuild transcripts from saved streams: same digest, checks and renderer, no mock and no model. */
async function rerenderMode(o) {
  const scenarios = selectScenarios(o.rerender.length ? o.rerender : null);
  const summaryPath = join(o.out, "run-summary.json");
  const summary = existsSync(summaryPath) ? readJson(summaryPath) : {};
  for (const scenario of scenarios) {
    const files = [1, 2].map((n) => join(o.out, `${scenario.id}.turn${n}.stream.jsonl`)).filter((f) => existsSync(f));
    if (!files.length) { out(`${scenario.id}: no stream files in ${rel(o.out)}; nothing to re-render`); continue; }
    const turns = files.map((f) => digestTurn(readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { type: "non-json", line: l }; } })));
    const nameMap = namesFromCalls(turns.flatMap((t) => t.calls), new Map());
    const gateId = extractGate(turns[0].texts);
    const prompts = [buildPrompt(scenario, o.invoke), ...(turns.length > 1 ? [`approve ${gateId ?? "<correlationId>"}\n`] : [])];
    const recordFile = join(EXPECTED_DIR, `${scenario.id}.decision-record.json`);
    const fromStream = extractRecord(turns.at(-1).texts);
    const record = existsSync(recordFile) && !o.writeExpected ? readJson(recordFile) : (fromStream ?? (existsSync(recordFile) ? readJson(recordFile) : null));
    const checks = [];
    recordChecks(scenario, record, checks);
    if (record) { const err = await validateRecord(record); check(checks, "schema valid", !err, err ?? ""); }
    traceChecks(scenario, turns, record, nameMap, checks);
    const row = summary.scenarios?.find((s) => s.id === scenario.id);
    const allPass = checks.every((c) => c.pass);
    if (o.writeExpected && record && allPass) {
      ensureDir(EXPECTED_DIR);
      writeFileSync(recordFile, `${JSON.stringify(record, null, 2)}\n`);
      if (row) Object.assign(row, { status: "ok", expectedWritten: true, decision: record.decision, outcome: record.outcome, riskLevel: record.riskLevel, correlationId: record.correlationId, toolCalls: { count: record.toolCalls?.count, budget: record.toolCalls?.budget } });
      out(`${scenario.id}: record written to ${rel(recordFile)} from the saved stream (all ${checks.length} checks pass)`);
    } else if (o.writeExpected && record && !allPass) {
      out(`${scenario.id}: not written; failing checks: ${checks.filter((c) => !c.pass).map((c) => c.check).join("; ")}`);
    }
    if (row) row.assertions = { passed: checks.filter((c) => c.pass).length, failed: checks.length - checks.filter((c) => c.pass).length };
    const transcriptPath = join(o.out, `${scenario.id}.transcript.md`);
    // Carry over what only the live run could know: the mock probes and the redaction note.
    const previous = existsSync(transcriptPath) ? readFileSync(transcriptPath, "utf8") : "";
    const probes = row?.probes ?? {
      pre: /^- Before: as expected/m.test(previous) ? null : /^- Before: UNEXPECTED: (.*)$/m.exec(previous)?.[1],
      post: /^- After: as expected/m.test(previous) ? null : /^- After: UNEXPECTED: (.*)$/m.exec(previous)?.[1],
    };
    const leakSites = new Set(row?.leakSites ?? (/\(([^)]+)\) and was replaced/.exec(previous)?.[1]?.split(", ") ?? []));
    const meta = {
      model: summary.model ?? o.model, effort: summary.effort ?? o.effort, claudeCodeVersion: summary.claudeCodeVersion ?? turns[0].init?.claude_code_version ?? "unknown",
      entraScimMcpVersion: summary.entraScimMcpVersion ?? "unknown", policyId: summary.policyId ?? record?.policyId, policyVersion: summary.policyVersion ?? record?.policyVersion,
      boot: row?.boot ?? BOOT_GROUPS.findIndex((g) => g.includes(scenario.id)) + 1, sessionId: turns[0].init?.session_id ?? "unknown", recordedAt: row?.recordedAt ?? summary.recordedAt ?? nowIso(),
    };
    writeFileSync(transcriptPath, renderTranscript(scenario, { turns, prompts, nameMap, checks, probes, leakSites, meta }));
    out(`${scenario.id}: re-rendered from ${files.length} stream file(s); ${checks.filter((c) => c.pass).length}/${checks.length} checks pass`);
  }
  if (summary.scenarios) {
    writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    writeFileSync(join(o.out, "run-summary.md"), renderSummaryMd(summary));
  }
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.check) return checkMode(o);
  if (o.rerender) return rerenderMode(o);

  const scenarios = selectScenarios(o.only);
  const runDir = join(o.out, ".run");
  ensureDir(runDir);
  const mcpConfigPath = join(runDir, "mcp-mock.json");
  const baseUrl = `http://127.0.0.1:${o.port}`;
  writeFileSync(mcpConfigPath, `${JSON.stringify({ mcpServers: {
    [SERVER_NAME]: { command: "node", args: [MCP_SERVER], env: { ENTRA_SCIM_BASE_URL: baseUrl, ENTRA_SCIM_STATIC_TOKEN: o.token } },
    [INTAKE_SERVER]: { command: "node", args: [INTAKE_SERVER_FILE], env: { LIFECYCLE_INTAKE_BACKEND: "stub" } },
  } }, null, 2)}\n`);

  const bin = resolveClaude();
  const caps = o.dryRun && !existsSync(bin) && bin === "claude" ? { version: "unknown", supports: () => true } : claudeCapabilities(bin);
  const policy = readJson(POLICY_FILE);
  const entraScimMcpVersion = existsSync(join(repoRoot, "node_modules", "entra-scim-mcp", "package.json")) ? readJson(join(repoRoot, "node_modules", "entra-scim-mcp", "package.json")).version : "not installed";

  if (o.dryRun) {
    out(`record-scenarios --dry-run (claude ${caps.version} at ${bin}; entra-scim-mcp ${entraScimMcpVersion}; policy ${policy.policyId} v${policy.policyVersion})`);
    out(`mcp-config: ${rel(mcpConfigPath)}`);
    for (const scenario of scenarios) {
      const prompt = buildPrompt(scenario, o.invoke);
      const sessionId = randomUUID();
      out(`\n=== ${scenario.id} (${scenario.skill}; gate ${scenario.gate ? "yes" : "no"}; writes ${scenario.writes ? "yes" : "no"})`);
      out(`turn 1: claude ${claudeArgs(o, caps, { sessionId, mcpConfig: rel(mcpConfigPath) }).join(" ")}`);
      out(`stdin:\n${prompt.split("\n").map((l) => `  ${l}`).join("\n")}`);
      if (scenario.gate) out(`turn 2: claude ${claudeArgs(o, caps, { resume: sessionId, mcpConfig: rel(mcpConfigPath) }).join(" ")}\nstdin:\n  approve <correlationId from turn 1>`);
    }
    return;
  }

  if (process.env.ENTRA_SCIM_DRY_RUN) throw new Error("ENTRA_SCIM_DRY_RUN is set in this shell; recordings would come back as rehearsals");
  if (!existsSync(MCP_SERVER)) throw new Error(`entra-scim-mcp is not installed at ${MCP_SERVER}; run npm install`);
  ensureDir(o.out);
  const mock = new Mock(o, runDir);
  const summary = {
    recordedAt: nowIso(), model: o.model, effort: o.effort, claudeCodeVersion: caps.version, entraScimMcpVersion,
    policyId: policy.policyId, policyVersion: policy.policyVersion, seedSha256: sha256(SEED_FILE), scenarios: [],
  };
  out(`record-scenarios: ${scenarios.length} scenario(s); claude ${caps.version}; model ${o.model}; entra-scim-mcp ${entraScimMcpVersion}; policy v${policy.policyVersion}`);

  let anyFailed = false;
  const groups = BOOT_GROUPS.map((g) => g.filter((id) => scenarios.some((s) => s.id === id))).filter((g) => g.length);
  try {
    for (const group of groups) {
      await mock.start();
      const nameMap = await mock.nameMap();
      for (const id of group) {
        const scenario = scenarios.find((s) => s.id === id);
        const row = { id: scenario.id, skill: scenario.skill, recordedAt: nowIso(), turns: [], assertions: { passed: 0, failed: 0 }, status: "not run" };
        summary.scenarios.push(row);
        const started = Date.now();
        try {
          const result = await recordScenario(scenario, { o, caps, bin, mock, nameMap, mcpConfigPath, meta: { ...summary, boot: mock.boot } });
          Object.assign(row, result.row, { boot: mock.boot });
          row.status = result.ok ? "ok" : "failed";
          if (!result.ok) anyFailed = true;
          out(`${scenario.id}: ${row.status.toUpperCase()} in ${((Date.now() - started) / 60_000).toFixed(1)} min; ${row.assertions.passed}/${row.assertions.passed + row.assertions.failed} assertions${result.ok ? "" : ` — ${result.failures.join("; ")}`}`);
        } catch (err) {
          anyFailed = true;
          row.status = "error";
          row.error = err instanceof Error ? err.message : String(err);
          out(`${scenario.id}: ERROR ${row.error}`);
        }
        if (anyFailed && !o.keepGoing) break;
      }
      await mock.stop();
      if (anyFailed && !o.keepGoing) break;
    }
  } finally {
    await mock.stop();
    // A partial run (--only) keeps the other scenarios' rows from the previous summary.
    const summaryPath = join(o.out, "run-summary.json");
    if (existsSync(summaryPath)) {
      try {
        for (const row of readJson(summaryPath).scenarios ?? []) if (!summary.scenarios.some((s) => s.id === row.id)) summary.scenarios.push(row);
      } catch { /* unreadable previous summary: start fresh */ }
    }
    summary.scenarios.sort((a, b) => SCENARIOS.findIndex((s) => s.id === a.id) - SCENARIOS.findIndex((s) => s.id === b.id));
    writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    writeFileSync(join(o.out, "run-summary.md"), renderSummaryMd(summary));
    out(`run-summary: ${rel(join(o.out, "run-summary.json"))}`);
  }
  out(anyFailed ? "record-scenarios: FAILED" : "record-scenarios: all scenarios recorded");
  process.exit(anyFailed ? 1 : 0);
}

async function recordScenario(scenario, ctx) {
  const { o, caps, bin, mock, nameMap, mcpConfigPath, meta } = ctx;
  const secrets = new Set();
  const leakSites = new Set();
  const checks = [];
  const probes = {};
  const probe = PROBES[scenario.id];
  if (probe?.pre) {
    probes.pre = await probe.pre(mock.scim);
    if (probes.pre) throw new Error(`precondition failed: ${probes.pre}`);
  }

  const sessionId = randomUUID();
  const prompts = [buildPrompt(scenario, o.invoke)];
  const turns = [];
  out(`${scenario.id}: turn 1 (${scenario.skill}) session ${sessionId}`);
  const t1 = await runClaudeTurn(bin, claudeArgs(o, caps, { sessionId, mcpConfig: mcpConfigPath }), prompts[0], { rawPath: join(o.out, `${scenario.id}.turn1.stream.jsonl`), timeoutMs: o.timeoutMs, secrets, leakSites });
  const d1 = digestTurn(t1.events);
  if (!d1.result) throw new Error(`turn 1 produced no result event (exit ${t1.code}); stderr: ${t1.stderr.slice(0, 400)}`);
  turns.push(d1);
  const init = d1.init;
  check(checks, "init: mcp server connected", (init?.mcp_servers ?? []).some((s) => s.name === SERVER_NAME && s.status === "connected"), JSON.stringify(init?.mcp_servers ?? []));
  check(checks, "init: 18 mock tools", (init?.tools ?? []).filter((t) => String(t).startsWith(TOOL_PREFIX)).length === 18, String((init?.tools ?? []).filter((t) => String(t).startsWith(TOOL_PREFIX)).length));
  check(checks, "init: intake server connected with system_one", (init?.mcp_servers ?? []).some((s) => s.name === INTAKE_SERVER && s.status === "connected") && (init?.tools ?? []).includes(`${INTAKE_PREFIX}system_one`), JSON.stringify((init?.tools ?? []).filter((t) => String(t).startsWith(INTAKE_PREFIX))));
  const effectiveSession = init?.session_id ?? sessionId;
  check(checks, "init: session id as requested", effectiveSession === sessionId, effectiveSession);

  const gateId = extractGate(d1.texts);
  check(checks, `gate ${scenario.gate ? "present" : "absent"} in turn 1`, Boolean(gateId) === scenario.gate, gateId ?? "none");
  if (scenario.gate && gateId) {
    prompts.push(`approve ${gateId}\n`);
    out(`${scenario.id}: turn 2 approve ${gateId}`);
    const t2 = await runClaudeTurn(bin, claudeArgs(o, caps, { resume: effectiveSession, mcpConfig: mcpConfigPath }), prompts[1], { rawPath: join(o.out, `${scenario.id}.turn2.stream.jsonl`), timeoutMs: o.timeoutMs, secrets, leakSites });
    const d2 = digestTurn(t2.events);
    if (!d2.result) throw new Error(`turn 2 produced no result event (exit ${t2.code}); stderr: ${t2.stderr.slice(0, 400)}`);
    turns.push(d2);
  }

  namesFromCalls(turns.flatMap((t) => t.calls), nameMap);
  const record = extractRecord(turns.at(-1).texts) ?? (turns.length > 1 ? null : extractRecord(d1.texts));
  recordChecks(scenario, record, checks);
  if (record && scenario.gate && gateId) check(checks, "record correlationId = gate id", record.correlationId === gateId, record.correlationId);
  if (record) {
    const schemaErr = await validateRecord(record);
    check(checks, "schema valid", !schemaErr, schemaErr ?? "");
  }
  traceChecks(scenario, turns, record, nameMap, checks);
  if (probe?.post) {
    probes.post = await probe.post(mock.scim);
    check(checks, "mock post-state as expected", probes.post === null, probes.post ?? "");
  }

  // Artefacts
  const transcriptPath = join(o.out, `${scenario.id}.transcript.md`);
  const transcript = scrub(renderTranscript(scenario, { turns, prompts, nameMap, checks, probes, leakSites, meta: { ...meta, sessionId: effectiveSession, recordedAt: nowIso() } }), secrets);
  writeFileSync(transcriptPath, transcript);
  const artefacts = [transcriptPath, ...turns.map((_, i) => join(o.out, `${scenario.id}.turn${i + 1}.stream.jsonl`))];
  let recordPath = null;
  if (record) {
    recordPath = join(o.out, ".run", `${scenario.id}.decision-record.json`);
    writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    artefacts.push(recordPath);
  }
  for (const secret of secrets) {
    for (const file of artefacts) {
      if (readFileSync(file, "utf8").includes(secret)) {
        writeFileSync(file, "");
        check(checks, `leak scan ${rel(file)}`, false, "generated password found; file emptied");
      }
    }
  }
  const failures = checks.filter((c) => !c.pass).map((c) => `${c.check}${c.detail ? ` (${c.detail})` : ""}`);
  const ok = failures.length === 0;
  if (ok && record && !o.noExpected) {
    ensureDir(EXPECTED_DIR);
    renameSync(recordPath, join(EXPECTED_DIR, `${scenario.id}.decision-record.json`));
  } else if (record && recordPath) {
    renameSync(recordPath, join(o.out, ".run", `${scenario.id}.decision-record.${ok ? "unwritten" : "rejected"}.json`));
  }
  const row = {
    decision: record?.decision, outcome: record?.outcome, riskLevel: record?.riskLevel, correlationId: record?.correlationId,
    toolCalls: record ? { count: record.toolCalls?.count, budget: record.toolCalls?.budget } : null,
    observedMcpCalls: turns.reduce((a, t) => a + t.calls.length, 0),
    turns: turns.map((t) => ({ sessionId: t.init?.session_id, model: t.init?.model, numTurns: t.result?.num_turns, durationMs: t.result?.duration_ms, costUsd: t.result?.total_cost_usd })),
    assertions: { passed: checks.filter((c) => c.pass).length, failed: failures.length },
    probes,
    leakSites: [...leakSites],
    transcript: rel(transcriptPath),
    expectedWritten: ok && Boolean(record) && !o.noExpected,
  };
  return { ok, failures, row };
}

main().catch((err) => {
  process.stderr.write(`record-scenarios: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
});
