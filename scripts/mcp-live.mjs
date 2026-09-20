#!/usr/bin/env node
// Launches the published entra-scim-mcp stdio server against a LIVE tenant with
// credentials read from <repo>/.env, so .mcp.json never has to hold a secret.
// Wired up as the "entra-scim-live" entry in .mcp.json.
//
// This launcher is for real tenants only. It refuses to start when the mock
// static token or the dry-run flag is present, so a live session can never be
// silently downgraded to the mock (and vice versa): use the entra-scim-mock /
// entra-scim-rehearsal entries in .mcp.json for those.
//
// Everything this file prints goes to stderr: stdout is the MCP framing channel.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDotEnv } from "./lib/dotenv.mjs";

const DEFAULT_BASE_URL = "https://graph.microsoft.com/rp/scim";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const envFile = resolve(scriptDir, "..", ".env");

function fail(message) {
  process.stderr.write(`mcp-live: ${message}\n`);
  process.exit(1);
}

function isSet(name) {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0;
}

// Values already in the environment (a shell export, or an MCP client "env"
// block) always win over the file; blank lines in the file count as unset.
const applied = loadDotEnv(envFile);
process.stderr.write(
  applied.length
    ? `mcp-live: loaded ${applied.length} var(s) from ${envFile} (${applied.join(", ")})\n`
    : `mcp-live: no vars loaded from ${envFile} (missing, or all already set in the environment)\n`,
);

if (isSet("ENTRA_SCIM_STATIC_TOKEN")) {
  fail(
    "ENTRA_SCIM_STATIC_TOKEN is set. This launcher runs against a live tenant only; " +
      "use the entra-scim-mock / entra-scim-rehearsal entries in .mcp.json for the mock and dry-run modes.",
  );
}
if (process.env.ENTRA_SCIM_DRY_RUN === "1") {
  fail(
    "ENTRA_SCIM_DRY_RUN=1 is set. This launcher runs against a live tenant only; " +
      "use the entra-scim-mock / entra-scim-rehearsal entries in .mcp.json for the mock and dry-run modes.",
  );
}

const missing = ["ENTRA_TENANT_ID", "ENTRA_CLIENT_ID"].filter((name) => !isSet(name));
if (missing.length > 0) {
  fail(`missing required variable(s): ${missing.join(", ")}. Copy .env.example to .env and fill them in.`);
}

const hasSecret = isSet("ENTRA_CLIENT_SECRET");
const hasCert = isSet("ENTRA_CLIENT_CERT_PATH");
if (hasSecret && hasCert) {
  fail("both ENTRA_CLIENT_SECRET and ENTRA_CLIENT_CERT_PATH are set. Set exactly one.");
}
if (!hasSecret && !hasCert) {
  fail("no credential configured. Set exactly one of ENTRA_CLIENT_SECRET or ENTRA_CLIENT_CERT_PATH.");
}

const tenantId = process.env.ENTRA_TENANT_ID.trim();
const baseUrl = process.env.ENTRA_SCIM_BASE_URL?.trim() || DEFAULT_BASE_URL;
const mode = hasSecret ? "secret" : "certificate";
process.stderr.write(`mcp-live: tenant=${tenantId} baseUrl=${baseUrl} mode=${mode}\n`);

// The package's main entry (dist/index.js) self-starts on import and installs
// its own fatal handler, so there is nothing to call after this.
try {
  await import("entra-scim-mcp");
} catch (err) {
  if (err && err.code === "ERR_MODULE_NOT_FOUND") {
    fail(`entra-scim-mcp is not installed (${err.message}); run npm install first.`);
  }
  throw err;
}
