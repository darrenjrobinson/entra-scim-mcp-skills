#!/usr/bin/env node
// Wires the links the mock cannot take from a seed file into a RUNNING
// entra-scim-mock-server: manager references (x-managers) and group
// memberships (x-memberships). The mock assigns fresh ids on every boot and
// discards seed-supplied ones, so names are resolved to ids here, after boot.
//
//   node demo/scripts/seed-links.mjs <seed.json> [--base-url http://127.0.0.1:8990] [--token dev-token]
//
// Zero dependencies (Node 20+ fetch). Loopback only. Idempotent: the mock's
// member add is a no-op for existing members and the manager PATCH is a
// replace, so re-running after a partial failure is safe. Retries the first
// request for ~10 s so it can be started before the mock is listening.
import { readFile } from "node:fs/promises";

const DEFAULT_BASE_URL = "http://127.0.0.1:8990";
const DEFAULT_TOKEN = "dev-token";
const MEMBER_ADD_CHUNK = 20; // Entra SCIM API cap, enforced by the mock
const PAGE_SIZE = 1000; // the mock's MAX_PAGE_SIZE; larger values are clamped
const READY_TIMEOUT_MS = 10_000;
const READY_INTERVAL_MS = 500;

const SCHEMA_PATCH_OP = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const SCHEMA_ENTERPRISE_USER = "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";

const USAGE = `Usage: node demo/scripts/seed-links.mjs <seed.json> [--base-url ${DEFAULT_BASE_URL}] [--token ${DEFAULT_TOKEN}]
  --base-url  Mock base URL (loopback only). Default ${DEFAULT_BASE_URL}.
  --token     Bearer token. Default from ENTRA_SCIM_MOCK_TOKEN, else "${DEFAULT_TOKEN}".`;

function parseArgs(argv) {
  const opts = { seedPath: undefined, baseUrl: DEFAULT_BASE_URL, token: undefined };
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
    if (arg === "--base-url" || arg.startsWith("--base-url=")) opts.baseUrl = take("--base-url");
    else if (arg === "--token" || arg.startsWith("--token=")) opts.token = take("--token");
    else if (arg.startsWith("-")) throw new Error(`unknown option ${arg}\n${USAGE}`);
    else if (opts.seedPath === undefined) opts.seedPath = arg;
    else throw new Error(`unexpected argument ${arg}\n${USAGE}`);
  }
  if (!opts.seedPath) throw new Error(`seed file is required\n${USAGE}`);
  opts.token = opts.token ?? process.env.ENTRA_SCIM_MOCK_TOKEN ?? DEFAULT_TOKEN;
  opts.baseUrl = normalizeBaseUrl(opts.baseUrl);
  return opts;
}

/** Only ever talk to a local mock: this script writes without confirmation. */
function normalizeBaseUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`--base-url is not a valid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`--base-url must be http(s): ${raw}`);
  }
  const host = url.hostname.toLowerCase();
  const loopback =
    host === "localhost" || host === "[::1]" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  if (!loopback) {
    throw new Error(`refusing non-loopback base URL ${raw}: this script only targets the local mock.`);
  }
  return url.toString().replace(/\/+$/, "");
}

/** Query strings are built by hand: no whitespace may surround "=" (Entra SCIM rule). */
function qs(params) {
  const parts = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class HttpError extends Error {
  constructor(method, path, status, body) {
    super(`HTTP ${status} on ${method} ${path}\n${body}`);
    this.status = status;
  }
}

function makeClient(baseUrl, token) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };

  async function send(method, path, body, { retryUntilReady = false } = {}) {
    const init = { method, headers: { ...headers } };
    if (body !== undefined) {
      init.headers["Content-Type"] = "application/scim+json";
      init.body = JSON.stringify(body);
    }
    const url = `${baseUrl}${path}`;
    const started = Date.now();
    let response;
    for (;;) {
      try {
        response = await fetch(url, init);
        break;
      } catch (err) {
        const cause = err?.cause?.message ?? err?.message ?? String(err);
        if (!retryUntilReady || Date.now() - started >= READY_TIMEOUT_MS) {
          throw new Error(`mock not reachable at ${baseUrl} (${cause}). Start it with: npm run mock`);
        }
        await sleep(READY_INTERVAL_MS);
      }
    }
    const text = await response.text();
    if (!response.ok) throw new HttpError(method, path, response.status, text);
    return text.length ? JSON.parse(text) : undefined;
  }

  /** Follow the mock's cursor pagination until every resource is in hand. */
  async function listAll(path, params, opts) {
    const all = [];
    let cursor;
    let first = true;
    do {
      const page = await send(
        "GET",
        `${path}${qs({ ...params, count: PAGE_SIZE, cursor })}`,
        undefined,
        first ? opts : {},
      );
      first = false;
      all.push(...(page?.resources ?? page?.Resources ?? []));
      cursor = page?.nextCursor;
    } while (cursor);
    return all;
  }

  return { send, listAll };
}

/** Case-insensitive name -> id index that refuses ambiguity. */
function indexBy(resources, key, kind) {
  const index = new Map();
  for (const resource of resources) {
    const name = resource[key];
    if (typeof name !== "string" || !name) continue;
    const lower = name.toLowerCase();
    if (index.has(lower)) {
      throw new Error(
        `duplicate ${kind} ${key} "${name}" in the mock; the demo needs unique names. Restart the mock.`,
      );
    }
    index.set(lower, resource.id);
  }
  return index;
}

function lookup(index, name, kind) {
  const id = index.get(name.toLowerCase());
  if (!id) {
    throw new Error(
      `${kind} "${name}" is not in the mock. Is the mock running with --seed pointing at this file? (npm run mock)`,
    );
  }
  return id;
}

function localPart(userName) {
  return userName.includes("@") ? userName.slice(0, userName.indexOf("@")) : userName;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const seed = JSON.parse(await readFile(opts.seedPath, "utf8"));
  const managers = seed["x-managers"] ?? {};
  const memberships = seed["x-memberships"] ?? {};
  const client = makeClient(opts.baseUrl, opts.token);

  process.stdout.write(`seed-links: ${opts.baseUrl} <- ${opts.seedPath}\n`);

  // Resolve names to this boot's ids. The first request waits for the mock.
  const users = await client.listAll("/Users", { attributes: "id,userName" }, { retryUntilReady: true });
  const groups = await client.listAll("/Groups", { attributes: "id,displayName" });
  const userIds = indexBy(users, "userName", "user");
  const groupIds = indexBy(groups, "displayName", "group");
  process.stdout.write(`seed-links: resolved ${userIds.size} user(s), ${groupIds.size} group(s)\n`);

  // Managers: one PATCH per user, replacing the enterprise manager reference.
  let managerPatches = 0;
  for (const [userName, managerName] of Object.entries(managers)) {
    const userId = lookup(userIds, userName, "user");
    const managerId = lookup(userIds, managerName, "manager");
    await client.send("PATCH", `/Users/${encodeURIComponent(userId)}`, {
      schemas: [SCHEMA_PATCH_OP],
      Operations: [
        {
          op: "replace",
          path: `${SCHEMA_ENTERPRISE_USER}:manager`,
          value: { value: managerId },
        },
      ],
    });
    managerPatches++;
  }

  // Memberships: a membership op must be the only op in its PATCH, and an add
  // carries at most 20 members, so chunk and send one op per call.
  let memberPatches = 0;
  let memberLinks = 0;
  for (const [groupName, userNames] of Object.entries(memberships)) {
    const groupId = lookup(groupIds, groupName, "group");
    const memberIds = [...new Set(userNames.map((name) => lookup(userIds, name, "user")))];
    for (let i = 0; i < memberIds.length; i += MEMBER_ADD_CHUNK) {
      const chunk = memberIds.slice(i, i + MEMBER_ADD_CHUNK);
      await client.send("PATCH", `/Groups/${encodeURIComponent(groupId)}`, {
        schemas: [SCHEMA_PATCH_OP],
        Operations: [{ op: "add", path: "members", value: chunk.map((id) => ({ value: id })) }],
      });
      memberPatches++;
      memberLinks += chunk.length;
    }
  }
  process.stdout.write(
    `seed-links: applied ${managerPatches} manager link(s) and ${memberLinks} membership(s) in ${memberPatches} PATCH call(s)\n`,
  );

  // Report what the mock now holds, not what was sent: membership is readable
  // only through list_groups filtered on members.value, one user at a time.
  const nameOfUser = new Map(users.map((u) => [u.id, u.userName]));
  const membersOfGroup = new Map(groups.map((g) => [g.id, []]));
  for (const [id, userName] of nameOfUser) {
    const held = await client.listAll("/Groups", {
      filter: `members.value eq "${id}"`,
      attributes: "id,displayName",
    });
    for (const group of held) membersOfGroup.get(group.id)?.push(localPart(userName));
  }
  const withManager = await client.listAll("/Users", {
    attributes: `id,userName,${SCHEMA_ENTERPRISE_USER}:manager`,
  });

  const groupWidth = Math.max(...groups.map((g) => g.displayName.length), 5);
  process.stdout.write(
    `\nGroup memberships as read back from the mock (${groups.length} groups; userNames shown as local parts):\n`,
  );
  for (const group of groups) {
    const members = membersOfGroup.get(group.id) ?? [];
    process.stdout.write(
      `  ${group.displayName.padEnd(groupWidth)}  ${members.length ? members.join(", ") : "(no members)"}\n`,
    );
  }
  const managerRows = withManager
    .map((u) => ({ user: u.userName, managerId: u[SCHEMA_ENTERPRISE_USER]?.manager?.value }))
    .filter((row) => row.managerId);
  const userWidth = Math.max(...managerRows.map((r) => localPart(r.user).length), 4);
  process.stdout.write(`\nManager links as read back from the mock (${managerRows.length}):\n`);
  for (const row of managerRows) {
    const manager = nameOfUser.get(row.managerId) ?? row.managerId;
    process.stdout.write(`  ${localPart(row.user).padEnd(userWidth)}  ->  ${localPart(manager)}\n`);
  }
  process.stdout.write("\nseed-links: done. Re-running is safe; restart the mock to reset the tenant.\n");
}

main().catch((err) => {
  process.stderr.write(`seed-links: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
