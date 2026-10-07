// Shared helpers for the intake probe and verifier: spawn the intake server as an MCP
// client, load the policy's intake section, and read the S0 prompts from the scenario file.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const POLICY_FILE = join(repoRoot, ".claude", "skills", "entra-lifecycle-policy", "policy", "lifecycle-policy.json");
export const SERVER_FILE = join(repoRoot, "demo", "intake", "server.mjs");
export const SCENARIO_FILE = join(repoRoot, "demo", "scenarios", "S0-intake.md");

export function loadPolicy() {
  return JSON.parse(readFileSync(POLICY_FILE, "utf8"));
}

/** Prompts live once, in the scenario file, in fences tagged ```text S0a etc. */
export function scenarioPrompts(file = SCENARIO_FILE) {
  const md = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const prompts = {};
  const re = /```text (S0[a-z])\n([\s\S]*?)\n```/g;
  let m;
  while ((m = re.exec(md)) !== null) prompts[m[1]] = m[2].trim();
  return prompts;
}

/** Run fn with a connected MCP client to the intake server; always closes it. */
export async function withIntakeClient(backend, fn) {
  const client = new Client({ name: "entra-lifecycle-intake-client", version: "0.2.0" });
  const env = { ...getDefaultEnvironment() };
  for (const k of ["TYPESAFE_API_KEY", "JEV_MODEL", "JEV_ENDPOINT", "LAYA_CACHE", "LAYA_MODEL_DIR", "LAYA_SUBFOLDER"]) if (process.env[k]) env[k] = process.env[k];
  if (backend) env.LIFECYCLE_INTAKE_BACKEND = backend;
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER_FILE], env, stderr: "pipe" });
  transport.stderr?.on("data", (c) => process.stderr.write(c));
  await client.connect(transport);
  try {
    return await fn({
      client,
      async systemOne(state, questions) {
        const result = await client.callTool({ name: "system_one", arguments: { state, questions } });
        const payload = result.structuredContent ?? (() => { try { return JSON.parse(result.content?.[0]?.text ?? "{}"); } catch { return {}; } })();
        if (result.isError) throw new Error(`system_one failed: ${payload.detail ?? JSON.stringify(payload)}`);
        return payload;
      },
    });
  } finally {
    await client.close().catch(() => {});
  }
}

export function formatAnswers(answers) {
  const lines = [];
  for (const [name, a] of Object.entries(answers ?? {})) {
    if (a.type === "choice") {
      const ranked = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v.toFixed(3)}`).join(", ");
      lines.push(`  ${name}: ${a.choice} (confidence ${a.confidence.toFixed(3)}) [${ranked}]`);
    } else if (a.type === "score") lines.push(`  ${name}: ${a.score.toFixed(3)} on 0..${Object.keys(a.legend).length - 1} (confidence ${a.confidence.toFixed(3)})`);
    else if (a.type === "noul") lines.push(`  ${name}: ${a.noul.toFixed(3)}`);
  }
  return lines.join("\n");
}
