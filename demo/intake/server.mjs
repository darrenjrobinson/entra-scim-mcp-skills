#!/usr/bin/env node
// entra-lifecycle-intake: an MCP server with one tool, `system_one`, that exposes a System One
// decision model (TypeSafe Jev, Laya, or the deterministic stub) to the lifecycle-intake skill.
//
// The server reads no policy. The skill composes the typed questions from the policy's
// `intake` section and applies the thresholds; this server only answers them. That is the
// same split as entra-scim-mcp: the governance plane decides, the tool executes.
//
//   LIFECYCLE_INTAKE_BACKEND = stub (default) | jev | laya
//   TYPESAFE_API_KEY, JEV_MODEL           for jev
//   LAYA_CACHE, LAYA_MODEL_DIR            for laya (npm install @receptron/laya first)
//
// Stdio transport. Logs go to stderr; stdout is the MCP channel.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as stub from "./backends/stub.mjs";
import * as jev from "./backends/jev.mjs";
import * as laya from "./backends/laya.mjs";

export const SERVER_NAME = "entra-lifecycle-intake";
export const SERVER_VERSION = "0.2.0";
const BACKENDS = { stub, jev, laya };

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write(`Usage: node demo/intake/server.mjs            (stdio MCP server)
  LIFECYCLE_INTAKE_BACKEND=stub|jev|laya   default stub
  TYPESAFE_API_KEY, JEV_MODEL              jev backend (https://docs.typesafe.ai)
  LAYA_CACHE, LAYA_MODEL_DIR               laya backend (npm install @receptron/laya)
`);
  process.exit(0);
}

const defaultBackend = (process.env.LIFECYCLE_INTAKE_BACKEND || "stub").toLowerCase();
if (!BACKENDS[defaultBackend]) {
  process.stderr.write(`[${SERVER_NAME}] unknown LIFECYCLE_INTAKE_BACKEND "${defaultBackend}"; expected stub, jev or laya\n`);
  process.exit(1);
}

const questionSchema = z.object({
  type: z.enum(["choice", "score", "noul"]).describe("choice: pick one option from criteria (a map); score: a position on an ordered scale (criteria is an array of levels); noul: a yes/no probability"),
  instructions: z.string().min(1).describe("The question, in natural language"),
  criteria: z.union([z.record(z.string(), z.string()), z.array(z.string())]).optional().describe("choice: {option: description}; score: ordered level descriptions; noul: omit"),
});

const server = new McpServer(
  { name: SERVER_NAME, version: SERVER_VERSION },
  {
    instructions: [
      `System One decision model for identity lifecycle intake. Backend: ${defaultBackend}${defaultBackend === "stub" ? " (deterministic keyword stand-in; not a real classifier)" : ""}.`,
      "system_one takes a block of state and a map of typed questions and returns one typed answer per question with probabilities. It writes nothing, reads nothing from any directory, and never generates text.",
      "Use the questions, routing and thresholds from the lifecycle policy's `intake` section; do not invent questions. One call per request is enough: every question is answered in the same call.",
      "Answers are advisory evidence. The policy decides what to do with them; a probability never sets a risk class, authors a record field or bypasses an orchestrator.",
    ].join("\n"),
  },
);

server.registerTool(
  "system_one",
  {
    title: "System One decision",
    description:
      "Ask a decision model typed questions about a block of state. Returns, per question: choice -> {choice, probabilities, confidence}; score -> {score, legend, probabilities, confidence}; noul -> {noul} (probability of yes). No text is generated. Backend is stub (deterministic), jev (TypeSafe, hosted) or laya (open weights, local); the result names which one answered and how long it took.",
    inputSchema: {
      state: z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())]).describe("The request as received: a string, an object or an array of strings. Passed verbatim; never summarise it first."),
      questions: z.record(z.string(), questionSchema).describe("Named typed questions, normally copied from policy.intake.questions"),
      backend: z.enum(["stub", "jev", "laya"]).optional().describe("Override the server's default backend for this call"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: defaultBackend !== "stub" },
  },
  async ({ state, questions, backend }) => {
    const name = backend ?? defaultBackend;
    const impl = BACKENDS[name];
    const started = performance.now();
    try {
      const r = await impl.systemOne(state, questions);
      const result = { backend: name, model: r.model, answers: r.answers, usage: r.usage ?? null, latencyMs: Math.round(performance.now() - started) };
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    } catch (err) {
      const payload = { error: "IntakeBackendError", backend: name, kind: err?.kind ?? "unknown", detail: err instanceof Error ? err.message : String(err) };
      process.stderr.write(`[${SERVER_NAME}] ${name}: ${payload.detail}\n`);
      return { isError: true, content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`[${SERVER_NAME}] ${SERVER_VERSION} ready on stdio; backend ${defaultBackend}\n`);
