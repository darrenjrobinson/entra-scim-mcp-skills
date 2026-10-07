#!/usr/bin/env node
// Ask the intake server the policy's intake questions about a piece of text and show what
// the lifecycle-intake skill would decide. No LLM, no mock, no tenant.
//
//   npm run intake:probe -- "Lidia Holloway is transferring from Finance to Engineering from Monday"
//   npm run intake:probe -- --backend jev "..."       (needs TYPESAFE_API_KEY)
//   npm run intake:probe -- --backend laya "..."      (needs npm install @receptron/laya)
import { readFileSync } from "node:fs";
import { decide, structuredRecord } from "./decide.mjs";
import { formatAnswers, loadPolicy, withIntakeClient } from "./client.mjs";

const argv = process.argv.slice(2);
let backend;
let file;
const parts = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--backend") backend = argv[++i];
  else if (argv[i].startsWith("--backend=")) backend = argv[i].slice(10);
  else if (argv[i] === "--file") file = argv[++i];
  else if (argv[i].startsWith("--file=")) file = argv[i].slice(7);
  else parts.push(argv[i]);
}
const text = (file ? readFileSync(file, "utf8") : parts.join(" ")).trim();
if (!text) {
  process.stderr.write('usage: node demo/intake/probe.mjs [--backend stub|jev|laya] "<request text>" | --file <path>\n');
  process.exit(2);
}

const policy = loadPolicy();
const intake = policy.intake;
const structured = structuredRecord(text, policy);
if (structured) {
  process.stdout.write(`structured record: ${structured.sourceSystem} ${structured.sourceRecordId} ${structured.eventType} -> route ${structured.route}; no model call (intake.structuredRecordBypass)\n`);
  process.exit(0);
}

await withIntakeClient(backend, async ({ systemOne }) => {
  const result = await systemOne(text, intake.questions);
  process.stdout.write(`backend ${result.backend} (${result.model}), ${result.latencyMs} ms${result.usage ? `, ${result.usage.input_tokens} input tokens` : ""}\n`);
  process.stdout.write(`${formatAnswers(result.answers)}\n`);
  const d = decide(intake, result.answers);
  process.stdout.write(`decision ${d.decision} / ${d.outcome}${d.reasonCode ? ` / ${d.reasonCode}` : ""}; risk ${d.riskLevel}${d.signals.length ? ` (${d.signals.join(", ")})` : ""}${d.route ? `; route ${d.route}` : ""}\n`);
});
