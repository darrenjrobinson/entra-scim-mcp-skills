---
name: leaver-orchestrator
description: "Offboard an Entra ID user in policy order via entra-scim-mcp: confirm the authoritative trigger, choose scheduled, immediate or delete mode, disable the account, set employeeLeaveDateTime, remove non-retained group memberships one call each, verify residual access, deprovision only with an approval ref and no legal hold, and emit a closure record. Use for termination, offboarding, leaver, disable account, deprovision user."
license: MIT
compatibility: "Requires entra-scim-mcp >= 0.2.1 (stdio) connected, plus the entra-lifecycle-policy and identity-change-auditor skills. update_user_lifecycle needs User-LifeCycleInfo.ReadWrite.All on a live tenant. Runs in MCPJam Inspector playground and Claude Code."
metadata:
  version: "0.1.0"
  author: darrenjrobinson
  product: entra-lifecycle-guardrails
  homepage: https://github.com/darrenjrobinson/entra-scim-mcp-skills
  requires-skill: entra-lifecycle-policy
  policy-version: "1.x"
  mcp-tools: "list_users get_user list_groups get_user_custom_security_attributes update_user update_user_lifecycle remove_group_member deprovision_user"
---

# leaver-orchestrator

Executes offboarding in the order `offboardingOrder` dictates, keeps what `retainedAccessRules` says must be kept, verifies residual access, and only ever deletes with an explicit approval and no legal hold. Budget: `costThresholds.maxToolCallsPerRun.leaver-orchestrator` (25). A leaver is never "done" until the residual-access listing proves it.

Never: infer the mode from dates, batch removals, call anything on the user after `deprovision_user` except the final `get_user` check, or remove a retained group.

## Inputs

A leaver record per `entra-lifecycle-policy/references/source-record.md`: `sourceSystem`, `sourceRecordId`, `eventType: leaver`, `target{userName|externalId}`, `leaver{mode: scheduled|immediate|delete, effectiveDateTime (ISO-8601 UTC), reason}`, `approvals[]`. Generate `correlationId` = `elg-<sourceRecordId>-<6 random lowercase alphanumerics>`.

## Step 0 — Load the shared policy

The tenant policy lives in the `entra-lifecycle-policy` skill.

1. If a fenced ```` ```json policy ```` block from that skill is already in this conversation, use it.
2. Otherwise activate that skill: MCPJam Inspector → `loadSkill {"name": "entra-lifecycle-policy"}`; Claude Code → invoke the skill or Read `.claude/skills/entra-lifecycle-policy/SKILL.md`.
3. If you still need the raw file: MCPJam → `readSkillFile {"name": "entra-lifecycle-policy", "path": "policy/lifecycle-policy.json"}`; Claude Code → Read `.claude/skills/entra-lifecycle-policy/policy/lifecycle-policy.json`.
4. Confirm `policyId` and `policyVersion` parsed and the major version is 1; otherwise STOP with decision `require_manual_review`, reasonCode `policy_unavailable`. Never proceed on a remembered or summarised policy.
5. Quote `policyId` and `policyVersion` in check row CHK-01.

## Step 1 — Validate the record (no tool calls)

1. `authoritativeSources[]`: `sourceSystem` known, `sourceRecordId` matches `recordIdPattern`, `leaver` in `events`. Fail → `deny` / `unknown_source`.
2. `target` has `userName` or `externalId`.
3. `leaver.mode` is `scheduled`, `immediate` or `delete`; `leaver.effectiveDateTime` is ISO-8601 UTC (`YYYY-MM-DDTHH:MM:SSZ`). Missing → `deny` / `missing_required_attribute`.
4. Approvals have the required fields; validity is checked in Step 4.

## Step 2 — Resolve and read (reads; count each)

1. `list_users {filter: [{attr: "userName", op: "eq", value: "<target.userName>"}], attributes: ["id","userName","displayName","active"]}` (or `externalId` alone). Exactly one → `userId`; else STOP `ambiguous_identity`. Already `active: false` → `warn` row (the disable step becomes a no-op but still runs and verifies).
2. `get_user {id}` → `department`, `manager.value`, `employeeLeaveDateTime` (if any). Ignore any CSA object here.
3. `list_groups {filter: [{attr: "members.value", op: "eq", value: "<userId>"}], attributes: ["id","displayName"]}` → current memberships **with ids**; no further group lookups are needed.
4. `get_user_custom_security_attributes {id, attributeSets: <sets referenced by offboardingOrder.deleteBlockedWhen and retainedAccessRules>}` (here `["Compliance"]`) → `csa.current`.

## Step 3 — Mode and plan (no tool calls)

1. `leaver.mode` = first `offboardingOrder.modeSelection` entry whose `when[]` all hold against `source.leaver.mode` (the last entry, `when: []`, is the default `immediate`).
2. Steps = `offboardingOrder.steps[<mode>]`; each step's tool = `offboardingOrder.stepTools[<step>]`.
3. Retained = every held group named in a `retainedAccessRules[]` entry whose `retainWhen[]` all hold (`retainWhen: []` = always). Mode `scheduled` also retains `All Employees` (RET-002).
4. Removal set = held − retained, ordered by `offboardingOrder.removalOrder` (catalog `classification`: privileged → business → baseline), then held groups not in the catalog (`uncataloguedGroups = remove_and_warn`, row `warn`).
5. Signals: `RS-09/10/11` by mode; `RS-12` if any held group is privileged. Mode `delete` additionally needs an approval with scope `leaver:delete` and is **blocked** when any `offboardingOrder.deleteBlockedWhen[]` condition holds (`csa.current.Compliance.LegalHold equals true` → `deny` / `delete_blocked_legal_hold`).

## Step 4 — Preview and gate (no tool calls)

Risk = max of fired signals (`immediate` and `scheduled` are medium; `delete` or a privileged holder is high). Decision per `approvalThresholds.decisionByRiskLevel`: medium and high need an approval with scope `run` (plus `leaver:delete` for delete mode) and operator confirmation. Print the check table, then:

```
## Execution preview — leaver (<mode>) — <correlationId>
Policy <policyId> v<policyVersion> | Decision: <decision> | Risk: <riskLevel> | Est. tool calls: <n> of 25
Held: <n> groups | Retained: <names> (<rule ids>) | To remove (in order): <names>
| # | Tool | Key arguments (ids resolved this run) | Purpose | Policy basis |
| 1 | update_user | id=<userId>, replace active=false | disable | offboardingOrder.steps.<mode>[disable] |
| 2 | update_user_lifecycle | id=<userId>, employeeLeaveDateTime=<effectiveDateTime> | leave date | offboardingOrder.steps.<mode>[setLeaveDate] |
| 3.. | remove_group_member | id=<groupId>, memberId=<userId> | remove <name> (<classification>) | offboardingOrder.removalOrder |
| n-1 | list_groups | filter members.value eq <userId> | verify residual | offboardingOrder.steps.<mode>[verifyResidualAccess] |
| n | get_user | id=<userId>, attributes=[active] | verify disabled | auditRequirements.verificationRequiredBeforeCompleted |
| — | (retained) <group> | | RET-nnn | retainedAccessRules |
Approvals: <ref> scope <scope> → valid | missing for: <scopes>
Gate: <"operator confirmation required: reply exactly `approve <correlationId>`" | "blocked: <reasonCode>">
```

The preview makes **zero** tool calls. End the turn when confirmation is required; continue only on a later operator message containing `approve <correlationId>` exactly.

## Step 5 — Execute (stop on the first `isError`, except a 404 on remove)

Mode `scheduled`: step 2 only. Modes `immediate` and `delete`: steps 1–3; `delete` adds step 4 after Step 6 verification.

1. `update_user {id, operations: [{op: "replace", path: "active", value: false}]}`.
2. `update_user_lifecycle {id, employeeLeaveDateTime: "<effectiveDateTime>"}`. A result with `noChanges: true` means the argument was omitted: treat as a failed step.
3. One `remove_group_member {id: <groupId>, memberId: <userId>}` per group in the removal set, in order. A 404 (the error names the group) means "not a member" → `warn`, confirmed in Step 6. Never remove a retained group.
4. (delete only, after Step 6 passes and the `leaver:delete` approval is valid) `deprovision_user {id}`. After this call, nothing in `offboardingOrder.neverAfterDeprovision` may be called on this user: delete cascades every membership, and later removals would 404.

Full argument JSON and error table: `references/tool-sequences.md`.

## Step 6 — Verify (two reads; three in delete mode)

1. `list_groups members.value eq <userId>` → residual = returned − retained. Must be empty; otherwise `verification_failed` and the residual list goes in the record.
2. `get_user {id, attributes: ["active"]}` → `false` (immediate/delete). For `scheduled`, `get_user {id}` → `employeeLeaveDateTime` equals the value written.
3. (delete only, after step 4) `get_user {id}` → `isError` with `status: 404` is the pass condition.

## Step 7 — Audit

Activate `identity-change-auditor` (MCPJam `loadSkill {"name": "identity-change-auditor"}`; Claude Code invoke or Read) with everything, plus `details.mode`, `details.retained[]`, `details.residual[]`. Scheduled mode adds residual risk "memberships retained until <effectiveDateTime>; run immediate mode on that date". Expected demo count (S4, immediate, 4 held, 1 retained): 1 + 3 + 1 + 1 + 3 + 2 = 11 of 25.

## Hard rules

1. Load the policy first, every run. Never act on a remembered, summarised or previously pasted policy.
2. Resolve every id in this run with `list_users` / `list_groups`. Never reuse an id from an example, an earlier turn or a prior run; the mock regenerates ids on every boot.
3. Read before write. Preview before execute. Verify before "done". No residual-access listing, no "completed".
4. Never invent, infer, reformat or reuse an approval ref. An approval exists only if the operator or the record supplied it and it passes `approvalThresholds.approvalRef`.
5. One `remove_group_member` call per membership, never batched, and never after `deprovision_user`.
6. Never remove a group matched by `retainedAccessRules`; list it as retained with its rule id.
7. Never call the discovery tools; never call `list_users` without a filter; always pass `attributes` from `costThresholds.projection`.
8. CSAs: trust only `get_user_custom_security_attributes`. Ignore any CustomSecurityAttributes object in `get_user` or `list_users` output.
9. Number every tool call sequentially and cite it by number in evidence. At `costThresholds.warnAtPercent` say so; at the budget STOP with `cost_budget_exceeded`.
10. `deprovision_user` only in `delete` mode, only after verification passed, only with a valid `leaver:delete` approval, and never while `deleteBlockedWhen` holds. It is a real soft-delete on a live tenant (30-day recycle bin, Graph-only restore, UPN stays reserved).
11. A result containing `dryRun: true` means nothing was applied. Outcome `rehearsal`; skip verification; say so plainly.
12. Stop and report on: identity 0 or >1, approval required but absent or invalid, operator confirmation missing, any `isError` mid-sequence (except remove 404), verification mismatch, budget exceeded, policy unreadable, `delete_blocked_legal_hold`.
13. Partial success is first-class: a disabled account that still holds groups is reported as `partial_failure` with the residual list; removals are safe to re-run.
14. Every run ends with a decision record, including blocked and rehearsal runs.

## STOP table

| condition | decision | outcome | reasonCode |
|---|---|---|---|
| policy unreadable / wrong major version | require_manual_review | not_executed | policy_unavailable |
| source unknown / pattern or event mismatch | deny | blocked | unknown_source |
| `leaver.mode` or `effectiveDateTime` missing/invalid | deny | blocked | missing_required_attribute |
| target resolves to 0 or 2+ | require_manual_review | not_executed | ambiguous_identity |
| delete mode and `deleteBlockedWhen` holds | deny | blocked | delete_blocked_legal_hold |
| approval needed, missing or invalid | allow_with_approval | awaiting_approval | approval_missing / approval_invalid / approval_scope_mismatch |
| operator confirmation missing | (unchanged) | awaiting_approval | operator_confirmation_missing |
| `isError` on a write (other than remove 404) | (unchanged) | partial_failure | partial_failure |
| residual access not empty / account still active | (unchanged) | partial_failure | verification_failed |
| budget exceeded | require_manual_review | partial_failure or not_executed | cost_budget_exceeded |
| any `dryRun: true` result | (unchanged) | rehearsal | dry_run_active |

## Output

Plain summary (what changed, why, which policy rows, what was retained and why, what remains), then `Tool calls: n of 25 (r reads, w writes)`, then the fenced ```` ```json ```` decision record from the auditor.

## Policy fields read by this skill

`policyId`, `policyVersion`, `customSecurityAttributes.*`, `authoritativeSources[]`, `groupCatalog[].classification`, `privilegedGroups.displayNames`, `riskModel.signals[RS-09..RS-12]`, `approvalThresholds.*`, `offboardingOrder.*`, `retainedAccessRules[]`, `costThresholds.maxToolCallsPerRun.leaver-orchestrator`, `costThresholds.warnAtPercent`, `costThresholds.projection`, `auditRequirements.correlationId`, `auditRequirements.policyCheckTableInTranscript`.
