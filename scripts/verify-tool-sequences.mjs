#!/usr/bin/env node
// Runs the S2 (joiner), S3a/S3b (mover) and S4 (leaver) tool sequences against
// the seeded mock through the real entra-scim-mcp server, as an MCP client and
// with no LLM in the loop. Proves the call shapes the skills prescribe are
// accepted end to end and counts calls per scenario against the skill budgets.
//
//   npm run mock          (terminal 1, fresh boot)
//   npm run seed:links    (terminal 2)
//   npm run verify:sequences
//
// Env: ENTRA_SCIM_BASE_URL (default http://127.0.0.1:8990, loopback only),
// ENTRA_SCIM_STATIC_TOKEN (default dev-token). Exit 1 on any assertion failure.
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

const BASE_URL = process.env.ENTRA_SCIM_BASE_URL?.trim() || "http://127.0.0.1:8990";
const TOKEN = process.env.ENTRA_SCIM_STATIC_TOKEN?.trim() || "dev-token";
const MCP_PACKAGE = "entra-scim-mcp@0.2.1";
const EXPECTED_TOOL_COUNT = 18;

const ENTERPRISE = "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";
const ENTRA_USER = "urn:ietf:params:scim:schemas:extension:Microsoft:Entra:2.0:User";
const CSA = "urn:ietf:params:scim:schemas:extension:Microsoft:Entra:2.0:CustomSecurityAttributes";

const DOMAIN = "contoso.local";
const upn = (local) => `${local}@${DOMAIN}`;
const G = {
  allEmployees: "All Employees",
  financeUsers: "SG-Finance-Users",
  apRequestors: "SG-Finance-AP-Requestors",
  apApprovers: "SG-Finance-AP-Approvers",
  treasury: "SG-Finance-Treasury-Payments",
  engUsers: "SG-Engineering-Users",
  prodDeploy: "SG-Engineering-ProdDeploy",
  legalHold: "SG-Legal-Hold",
};

function assertLoopback(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`ENTRA_SCIM_BASE_URL is not a valid URL: ${raw}`);
  }
  const host = url.hostname.toLowerCase();
  const loopback =
    host === "localhost" || host === "[::1]" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  if (!loopback) {
    throw new Error(`refusing non-loopback ENTRA_SCIM_BASE_URL ${raw}: this script writes to the tenant it is pointed at.`);
  }
}

class AssertionFailure extends Error {
  constructor(message, payload) {
    super(message);
    this.payload = payload;
  }
}

function assert(condition, message, payload) {
  if (!condition) throw new AssertionFailure(message, payload);
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

const sortedNames = (resources) => resources.map((r) => r.displayName).sort();
const isoNowNoMillis = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

// ---------------------------------------------------------------------------
// MCP client with per-scenario call accounting
// ---------------------------------------------------------------------------

const client = new Client({ name: "verify-tool-sequences", version: "0.1.0" });
let calls = 0;
let byTool = {};
const log = [];

function resetCounters() {
  calls = 0;
  byTool = {};
  log.length = 0;
}

async function call(name, args) {
  calls++;
  byTool[name] = (byTool[name] ?? 0) + 1;
  const result = await client.callTool({ name, arguments: args });
  const payload = result.structuredContent ?? result.content;
  log.push({ n: calls, tool: name, isError: Boolean(result.isError) });
  return { isError: Boolean(result.isError), payload };
}

/** Call a tool that must succeed; returns its structured payload. */
async function ok(name, args) {
  const { isError, payload } = await call(name, args);
  assert(!isError, `call #${calls} ${name} failed`, { args, payload });
  return payload ?? {};
}

/** Call a tool that must fail; returns its error payload. */
async function expectError(name, args) {
  const { isError, payload } = await call(name, args);
  assert(isError, `call #${calls} ${name} unexpectedly succeeded`, { args, payload });
  return payload ?? {};
}

async function resolveUser(userName, attributes = ["id", "userName", "displayName", "active"]) {
  const list = await ok("list_users", { filter: [{ attr: "userName", op: "eq", value: userName }], attributes });
  assert(list.resources?.length === 1, `expected exactly one user for ${userName}, got ${list.resources?.length ?? 0}`, list);
  return list.resources[0];
}

/** One projected list_groups call (following nextCursor if the tenant were larger). */
async function groupCatalog() {
  const byName = new Map();
  let cursor;
  do {
    const page = await ok("list_groups", { attributes: ["id", "displayName"], ...(cursor ? { cursor } : {}) });
    for (const group of page.resources ?? []) {
      byName.set(group.displayName, [...(byName.get(group.displayName) ?? []), group.id]);
    }
    cursor = page.nextCursor;
  } while (cursor);
  return (displayName) => {
    const ids = byName.get(displayName) ?? [];
    assert(ids.length === 1, `group "${displayName}" resolved to ${ids.length} id(s); expected exactly one`, { displayName, ids });
    return ids[0];
  };
}

async function membershipsOf(userId) {
  const list = await ok("list_groups", {
    filter: [{ attr: "members.value", op: "eq", value: userId }],
    attributes: ["id", "displayName"],
  });
  return list.resources ?? [];
}

async function csaOf(userId, attributeSets) {
  const result = await ok("get_user_custom_security_attributes", { id: userId, attributeSets });
  return result[CSA] ?? {};
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function s2Joiner() {
  const userName = upn("priya.natarajan");
  const externalId = "WD-000123";

  const dupByName = await ok("list_users", {
    filter: [{ attr: "userName", op: "eq", value: userName }],
    attributes: ["id", "userName"],
  });
  assert(dupByName.resources?.length === 0, `${userName} already exists: restart the mock (npm run mock) and re-run npm run seed:links`, dupByName);
  const dupByExternalId = await ok("list_users", {
    filter: [{ attr: "externalId", op: "eq", value: externalId }],
    attributes: ["id", "userName"],
  });
  assert(dupByExternalId.resources?.length === 0, `externalId ${externalId} already present: restart the mock`, dupByExternalId);

  const patti = await resolveUser(upn("patti.fernandez"));
  const groupId = await groupCatalog();
  const targetGroups = [G.allEmployees, G.financeUsers, G.apRequestors, G.treasury];
  const targetIds = targetGroups.map(groupId);

  const created = await ok("provision_user", {
    userName,
    password: `Tmp!${randomUUID()}`,
    displayName: "Priya Natarajan",
    givenName: "Priya",
    familyName: "Natarajan",
    mailNickname: "priya.natarajan",
    active: false,
    externalId,
    userType: "Member",
    emails: [{ value: userName, type: "work", primary: true }],
    department: "Finance",
    employeeNumber: "100482",
    managerId: patti.id,
  });
  assert(typeof created.id === "string" && created.id.length > 0, "provision_user returned no id", created);
  assert(!("password" in created), "provision_user echoed the password", Object.keys(created));
  const priyaId = created.id;

  await ok("update_user_custom_security_attributes", {
    id: priyaId,
    operations: [
      { op: "replace", path: `${CSA}:Employment.ContractType`, value: "Employee" },
      { op: "replace", path: `${CSA}:Employment.CostCenter`, value: "FIN-100" },
      { op: "replace", path: `${CSA}:Compliance.DataClassification`, value: "Confidential" },
    ],
  });
  const csa = await csaOf(priyaId, ["Employment", "Compliance"]);
  const expectedCsa = {
    Employment: { ContractType: "Employee", CostCenter: "FIN-100" },
    Compliance: { DataClassification: "Confidential" },
  };
  assert(deepEqual(csa, expectedCsa), "CSA round-trip mismatch", { expected: expectedCsa, observed: csa });

  for (const id of targetIds) {
    const added = await ok("add_group_members", { id, memberIds: [priyaId] });
    assert(added.ok === true && added.patchCalls === 1, "add_group_members did not report a single successful PATCH", added);
  }

  const held = sortedNames(await membershipsOf(priyaId));
  const expectedHeld = [...targetGroups].sort();
  assert(deepEqual(held, expectedHeld), "memberships after adds differ from the planned set", { expected: expectedHeld, observed: held });

  const user = await ok("get_user", { id: priyaId });
  assert(user.userName === userName, "userName mismatch", user);
  assert(user.active === false, "user should still be inactive before verification completes", user);
  assert(user.externalId === externalId, "externalId mismatch", user);
  assert(user[ENTERPRISE]?.department === "Finance", "department mismatch", user);
  assert(user[ENTERPRISE]?.manager?.value === patti.id, "manager.value should be patti's id", {
    expected: patti.id,
    observed: user[ENTERPRISE]?.manager,
  });

  await ok("update_user", { id: priyaId, operations: [{ op: "replace", path: "active", value: true }] });
  const activated = await ok("get_user", { id: priyaId, attributes: ["active"] });
  assert(activated.active === true, "user is not active after activation", activated);
}

async function s3aMoverPrecondition() {
  const adele = await resolveUser(upn("adele.vance"));
  const names = sortedNames(await membershipsOf(adele.id));
  assert(names.includes(G.apRequestors), `adele must hold ${G.apRequestors} (SOD-FIN-001 precondition)`, names);
  assert(!names.includes(G.apApprovers), `adele must not already hold ${G.apApprovers}`, names);
}

async function s3bMover() {
  const lidia = await resolveUser(upn("lidia.holloway"));
  const megan = await resolveUser(upn("megan.bowen"));

  const before = await ok("get_user", { id: lidia.id });
  assert(before[ENTERPRISE]?.department === "Finance", "lidia should start in Finance", before);
  const csaBefore = await csaOf(lidia.id, ["Employment"]);
  assert(csaBefore.Employment?.CostCenter === "FIN-110", "lidia should start with CostCenter FIN-110", csaBefore);
  const heldBefore = await membershipsOf(lidia.id);
  const expectedBefore = [G.allEmployees, G.financeUsers, G.apRequestors, G.treasury].sort();
  assert(deepEqual(sortedNames(heldBefore), expectedBefore), "lidia's starting memberships differ from the seed", {
    expected: expectedBefore,
    observed: sortedNames(heldBefore),
  });
  const heldId = (name) => heldBefore.find((g) => g.displayName === name).id;
  const groupId = await groupCatalog();

  await ok("update_user", {
    id: lidia.id,
    operations: [
      { op: "replace", path: `${ENTERPRISE}:department`, value: "Engineering" },
      { op: "replace", path: `${ENTERPRISE}:manager`, value: { value: megan.id } },
    ],
  });
  await ok("update_user_custom_security_attributes", {
    id: lidia.id,
    operations: [{ op: "replace", path: `${CSA}:Employment.CostCenter`, value: "ENG-210" }],
  });
  for (const name of [G.financeUsers, G.apRequestors, G.treasury]) {
    await ok("remove_group_member", { id: heldId(name), memberId: lidia.id });
  }
  await ok("add_group_members", { id: groupId(G.engUsers), memberIds: [lidia.id] });

  const heldAfter = sortedNames(await membershipsOf(lidia.id));
  const expectedAfter = [G.allEmployees, G.engUsers].sort();
  assert(deepEqual(heldAfter, expectedAfter), "lidia's memberships after the move are wrong", { expected: expectedAfter, observed: heldAfter });
  const after = await ok("get_user", { id: lidia.id });
  assert(after[ENTERPRISE]?.department === "Engineering", "department was not updated", after);
  assert(after[ENTERPRISE]?.manager?.value === megan.id, "manager was not updated to megan", {
    expected: megan.id,
    observed: after[ENTERPRISE]?.manager,
  });
  const csaAfter = await csaOf(lidia.id, ["Employment"]);
  assert(csaAfter.Employment?.CostCenter === "ENG-210", "CostCenter was not updated", csaAfter);
  assert(csaAfter.Employment?.ContractType === "Employee", "ContractType must be untouched by the move", csaAfter);
}

async function s4Leaver() {
  const nestor = await resolveUser(upn("nestor.wilke"));
  const before = await ok("get_user", { id: nestor.id });
  assert(before.active === true, "nestor should start active", before);
  const held = await membershipsOf(nestor.id);
  const expectedHeld = [G.allEmployees, G.engUsers, G.prodDeploy, G.legalHold].sort();
  assert(deepEqual(sortedNames(held), expectedHeld), "nestor's starting memberships differ from the seed", {
    expected: expectedHeld,
    observed: sortedNames(held),
  });
  const compliance = await csaOf(nestor.id, ["Compliance"]);
  assert(compliance.Compliance?.LegalHold === true, "nestor must be under legal hold (LegalHold true)", compliance);
  const heldId = (name) => held.find((g) => g.displayName === name).id;

  await ok("update_user", { id: nestor.id, operations: [{ op: "replace", path: "active", value: false }] });
  const leaveAt = isoNowNoMillis();
  const lifecycle = await ok("update_user_lifecycle", { id: nestor.id, employeeLeaveDateTime: leaveAt });
  assert(lifecycle.noChanges !== true, "update_user_lifecycle made no change", lifecycle);
  for (const name of [G.prodDeploy, G.engUsers, G.allEmployees]) {
    await ok("remove_group_member", { id: heldId(name), memberId: nestor.id });
  }

  const residual = sortedNames(await membershipsOf(nestor.id));
  assert(deepEqual(residual, [G.legalHold]), "residual memberships must be exactly [SG-Legal-Hold]", residual);
  const after = await ok("get_user", { id: nestor.id });
  assert(after.active === false, "nestor should be disabled", after);
  assert(after[ENTRA_USER]?.employeeLeaveDateTime === leaveAt, "employeeLeaveDateTime was not stored", {
    expected: leaveAt,
    observed: after[ENTRA_USER]?.employeeLeaveDateTime,
  });

  const repeat = await expectError("remove_group_member", { id: heldId(G.prodDeploy), memberId: nestor.id });
  assert(repeat.status === 404, "repeat removal should 404 (not a member)", repeat);
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function runScenario(label, fn) {
  resetCounters();
  try {
    await fn();
  } catch (err) {
    if (err instanceof AssertionFailure) {
      process.stdout.write(`${label} FAILED after ${calls} call(s): ${err.message}\n`);
      if (err.payload !== undefined) process.stdout.write(`${JSON.stringify(err.payload, null, 2)}\n`);
      process.stdout.write(`calls so far: ${log.map((e) => `#${e.n} ${e.tool}${e.isError ? " (error)" : ""}`).join(", ")}\n`);
      return false;
    }
    throw err;
  }
  const breakdown = Object.entries(byTool).map(([tool, n]) => `${tool} x${n}`).join(", ");
  process.stdout.write(`${label} OK in ${calls} calls (${breakdown})\n`);
  return true;
}

async function main() {
  assertLoopback(BASE_URL);
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["-y", MCP_PACKAGE],
    env: { ...getDefaultEnvironment(), ENTRA_SCIM_BASE_URL: BASE_URL, ENTRA_SCIM_STATIC_TOKEN: TOKEN },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => process.stderr.write(`[${MCP_PACKAGE}] ${chunk}`));
  await client.connect(transport);
  process.stdout.write(`verify-tool-sequences: connected to ${MCP_PACKAGE} -> ${BASE_URL}\n`);

  let allOk = true;
  try {
    const { tools } = await client.listTools();
    if (tools.length !== EXPECTED_TOOL_COUNT) {
      process.stdout.write(`expected ${EXPECTED_TOOL_COUNT} tools, got ${tools.length}: ${tools.map((t) => t.name).join(", ")}\n`);
      allOk = false;
    } else {
      process.stdout.write(`tools: ${tools.length} (expected ${EXPECTED_TOOL_COUNT})\n`);
    }
    if (allOk) {
      allOk = (await runScenario("S2 joiner", s2Joiner)) && allOk;
      allOk = (await runScenario("S3a mover precondition", s3aMoverPrecondition)) && allOk;
      allOk = (await runScenario("S3b mover", s3bMover)) && allOk;
      allOk = (await runScenario("S4 leaver", s4Leaver)) && allOk;
    }
  } finally {
    await client.close().catch(() => {});
  }
  process.stdout.write(allOk ? "verify-tool-sequences: all scenarios OK\n" : "verify-tool-sequences: FAILED\n");
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`verify-tool-sequences: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
