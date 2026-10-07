#!/usr/bin/env node
// Proves, with no model in the loop, that the stub backend routes the three S0 prompts the
// way the lifecycle-intake skill will: it reads the prompts from demo/scenarios/S0-intake.md,
// sends them to the intake server with the policy's intake questions, applies the policy's
// thresholds (demo/intake/decide.mjs) and asserts decision, reason and route.
//
//   npm run verify:intake            (stub; runs in CI)
//   npm run verify:intake -- --backend jev|laya   (informational: real models may differ)
import { decide } from "../demo/intake/decide.mjs";
import { formatAnswers, loadPolicy, scenarioPrompts, withIntakeClient } from "../demo/intake/client.mjs";

const EXPECT = {
  S0a: { decision: "allow", reasonCode: "intake_record_required", route: "mover-orchestrator", choice: "mover" },
  S0b: { decision: "require_manual_review", reasonCode: "intake_low_confidence", route: null },
  S0c: { decision: "deny", reasonCode: "intake_override_attempt", route: null, choice: "breakglass" },
};

const argv = process.argv.slice(2);
const backend = argv.includes("--backend") ? argv[argv.indexOf("--backend") + 1] : (argv.find((a) => a.startsWith("--backend="))?.slice(10) ?? "stub");
const strict = backend === "stub";

const policy = loadPolicy();
const intake = policy.intake;
if (!intake?.enabled) {
  process.stderr.write("verify-intake: policy.intake is missing or disabled\n");
  process.exit(1);
}
const prompts = scenarioPrompts();
for (const id of Object.keys(EXPECT)) if (!prompts[id]) { process.stderr.write(`verify-intake: prompt ${id} not found in demo/scenarios/S0-intake.md\n`); process.exit(1); }

let failed = 0;
await withIntakeClient(backend, async ({ client, systemOne }) => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  if (!(names.length === 1 && names[0] === "system_one")) { process.stdout.write(`tools: expected [system_one], got [${names.join(", ")}]\n`); failed++; }
  else process.stdout.write("tools: system_one (expected 1)\n");
  for (const [id, want] of Object.entries(EXPECT)) {
    const result = await systemOne(prompts[id], intake.questions);
    const d = decide(intake, result.answers);
    const problems = [];
    if (d.decision !== want.decision) problems.push(`decision ${d.decision} != ${want.decision}`);
    if (d.reasonCode !== want.reasonCode) problems.push(`reason ${d.reasonCode} != ${want.reasonCode}`);
    if (d.route !== want.route) problems.push(`route ${d.route} != ${want.route}`);
    if (want.choice && d.choice !== want.choice) problems.push(`choice ${d.choice} != ${want.choice}`);
    const ok = problems.length === 0;
    if (!ok && strict) failed++;
    process.stdout.write(`${id} ${ok ? "OK" : strict ? "FAILED" : "differs"}: ${d.decision}${d.reasonCode ? ` / ${d.reasonCode}` : ""}${d.route ? ` -> ${d.route}` : ""}; risk ${d.riskLevel}; ${result.backend} (${result.model}) ${result.latencyMs} ms${ok ? "" : ` — ${problems.join("; ")}`}\n`);
    process.stdout.write(`${formatAnswers(result.answers)}\n`);
  }
});
process.stdout.write(failed ? `verify-intake: FAILED (${failed})\n` : `verify-intake: all S0 prompts route as the scenario file says (${backend})\n`);
process.exit(failed ? 1 : 0);
