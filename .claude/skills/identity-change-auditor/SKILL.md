---
name: identity-change-auditor
description: "Produce the structured decision record (JSON plus a plain-language summary) after any Entra ID lifecycle action or blocked request: policy checks, approvals used, planned, executed and skipped actions, verification findings, residual risk, correlationId and tool-call count against budget. Use when asked for an audit record, change evidence, closure summary, or 'what did the agent do and why'. Makes no tool calls."
license: MIT
compatibility: "No MCP calls. Requires the entra-lifecycle-policy skill for policy/decision-record.schema.json and the example record. Called by every other entra-lifecycle-guardrails skill as its final step. Works in MCPJam Inspector and Claude Code."
metadata:
  version: "0.2.0"
  author: darrenjrobinson
  product: entra-lifecycle-guardrails
  homepage: https://github.com/darrenjrobinson/entra-scim-mcp-skills
  requires-skill: entra-lifecycle-policy
  policy-version: "1.x"
  mcp-tools: "none"
---

# identity-change-auditor

Turns the evidence already in the conversation (policy checks, tool calls and their results, approvals, verification reads) into one decision record and one plain-language summary. It never calls a tool (budget `costThresholds.maxToolCallsPerRun.identity-change-auditor` = 0) and never adds facts that are not in the transcript. Every orchestrator and guardrail run ends here, including blocked, awaiting-approval and rehearsal runs.

## Step 0 — Load the shared policy

The tenant policy lives in the `entra-lifecycle-policy` skill.

1. If a fenced ```` ```json policy ```` block from that skill is already in this conversation, use it.
2. Otherwise activate that skill: MCPJam Inspector → `loadSkill {"name": "entra-lifecycle-policy"}`; Claude Code → invoke the skill or Read `.claude/skills/entra-lifecycle-policy/SKILL.md`.
3. If you still need the raw file: MCPJam → `readSkillFile {"name": "entra-lifecycle-policy", "path": "policy/lifecycle-policy.json"}`; Claude Code → Read `.claude/skills/entra-lifecycle-policy/policy/lifecycle-policy.json`.
4. Confirm `policyId` and `policyVersion` parsed and the major version is 1; otherwise STOP with decision `require_manual_review`, reasonCode `policy_unavailable`.
5. This skill also needs the record shape. Copy it from `policy/decision-record.example.json` in the same skill (`readSkillFile` / Read the same way). The schema `policy/decision-record.schema.json` is the contract; the example is what you copy.

## Inputs the caller hands you

The calling skill supplies, in the conversation: `correlationId` (and `supersedes` if a re-run), `skill` + `skillVersion`, `event`, `host` (`mcpjam` | `claude-code` | `other`), whether any result carried `dryRun: true`, `source {system, recordId}`, `target {userName, id|null, displayName}`, every policy check row (same ids and order as the check table it printed), the approvals it validated, the planned action list from its preview, every tool call in order with its result (or error), the skipped list, the verification observations, and its tool-call tally. If any of these is missing, say which and record it as a residual risk; do not fill the gap from memory.

## Fill procedure

Work through the record top to bottom. Detail per field is in `references/record-template.md`.

1. **Header**: `recordVersion` = `auditRequirements.recordVersion`; `policyId`/`policyVersion` from Step 0; `dryRun` true if any tool result contained `dryRun: true`.
2. **Timestamps**: `startedAt` = the earliest `meta.created` / `meta.lastModified` seen in a tool result this run, `completedAt` = the latest; `clockSource` = `resourceMeta`. No tool results → both `null`, `clockSource` = `none`. Never invent a time.
3. **decision / riskLevel**: copy from the check table's aggregate row. Do not re-evaluate policy here.
4. **policyChecks[]**: one item per check-table row, same `id`, `rule` as a dotted policy path, `evidence` citing `call #n`, `source record` or `policy`, `result` from the CheckResult enum, `reasonCode` when the result is `fail`, `needs_approval` or `manual_review`.
5. **approvals[]**: every ref seen, with `valid` (passed pattern, requiredFields, sourceRecordId, scope) and `used` (an executed write relied on it).
6. **plannedActions[]**: the preview rows, `seq` numbered from 1, `argsSummary` redacted (`password=<generated, not shown>`), `status` = `executed` | `skipped` | `not_attempted`.
7. **executedActions[]**: every tool call in order, `call` = its sequential number, `seq` = the planned row it fulfilled (0 for reads), `phase`, `status` (`ok` | `error` | `dryRun`), `at` from the result's `meta` or `null`, `resultSummary` (ids, counts, `patchCalls`), `error` = the structured error object verbatim when `isError`.
8. **skippedActions[]**: denied groups, steps not reached after a stop, steps skipped by policy (`neverAfterDeprovision`), each with a `reasonCode`.
9. **verificationFindings**: `proved[]` = each verification read as `{check, tool, expected, observed, result}`; `notVerifiable[]` = what the SCIM read surface cannot show (sign-in sessions, licences, mailbox, nested or transitive access, app roles, PIM, whether a Lifecycle Workflow fired).
10. **residualRisk[]**: anything left for a human: pre-existing SoD conflicts, retained memberships, `notVerifiable` items that matter, an inactive account left behind after a stop.
11. **toolCalls**: `count` = number of executedActions, `budget` = the calling skill's `costThresholds.maxToolCallsPerRun`, `byTool` per tool name. `count` must equal the sum of `byTool`.
12. **nextSteps[]**, then **summary** (template below).

## Outcome classification

| outcome | when |
|---|---|
| `completed` | every planned write executed `ok` AND every `verificationFindings.proved[]` item is `pass` AND nothing was `dryRun` |
| `partial_failure` | at least one write executed and then a write errored, or a verification finding is `fail` |
| `awaiting_approval` | preview rendered, approval or operator confirmation missing, no writes |
| `blocked` | decision `deny` and no writes |
| `not_executed` | decision `require_manual_review`, or stopped before any write for another reason |
| `rehearsal` | any result carried `dryRun: true` |

`completed` is impossible without at least one `proved` verification finding (`auditRequirements.verificationRequiredBeforeCompleted`).

## Pre-emit checklist

Before printing the record, confirm every line; fix the record, not the checklist.

- All eight `auditRequirements.requiredSections` present (empty arrays are fine).
- `policyChecks` has at least one row and includes the aggregate row.
- Every `plannedActions.seq` appears in `executedActions` (with `status ok/error/dryRun`), in `skippedActions`, or has `status: not_attempted`.
- `executedActions[].seq` values are 0 or a real planned seq.
- `toolCalls.count == sum(toolCalls.byTool)`; both equal the number of executedActions.
- No key named `password` anywhere; no password value in any string.
- `target.id` is set whenever an object was created or resolved this run.
- `outcome = completed` only with non-empty `verificationFindings.proved` and all `pass`.
- Timestamps are copied from tool results or `null`; `clockSource` matches.
- Enum values are spelled exactly as in `references/record-template.md`.
- `summary` is under `auditRequirements.summaryMaxWords` words.

## Summary template (five sentences)

1. **What changed** (or "Nothing changed"), naming the object and ids.
2. **Why** it changed, naming the source record and event.
3. **Which policy** rows allowed or blocked it (rule ids).
4. **What did not change** and why (skipped groups, retained access).
5. **What remains for a human**, with owners.

Then one line: `Tool calls: <count> of <budget> (<reads> reads, <writes> writes)`.

## Output format

Print, in this order and nothing in between:

1. The plain-language summary.
2. The tool-call line.
3. One fenced ```` ```json ```` block containing the complete decision record.

Never truncate the JSON. Never emit two records for one run. If asked to "shorten", shorten the summary, not the record.

## Blocked-request mode

A run that never reached a write still gets a full record: `executedActions` may be empty, `plannedActions` still lists what would have happened with `status: not_attempted`, `skippedActions` names every denied group, `verificationFindings.proved` is empty, `toolCalls.count` may be 0, and `outcome` is `blocked`, `not_executed` or `awaiting_approval`.

## Hard rules

1. Zero tool calls. If evidence is missing, say so; do not fetch it.
2. Never invent ids, timestamps, approval refs, error text or counts. Copy them from the transcript.
3. Never restate a `dryRun` result as a change. If any result had `dryRun: true`, outcome is `rehearsal` and the summary says nothing was applied.
4. Never say "completed" when verification did not run or did not pass.
5. The record is data for other people. Keep reasoning out of it; put reasoning in `evidence` strings only as short citations.

## Policy fields read by this skill

`policyId`, `policyVersion`, `auditRequirements.recordVersion`, `auditRequirements.correlationId`, `auditRequirements.timestamps`, `auditRequirements.requiredSections`, `auditRequirements.redactFields`, `auditRequirements.verificationRequiredBeforeCompleted`, `auditRequirements.outputs`, `auditRequirements.summaryMaxWords`, `costThresholds.maxToolCallsPerRun.<calling skill>`.
