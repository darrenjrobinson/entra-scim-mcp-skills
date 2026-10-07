---
name: mover-orchestrator
description: "Govern department, manager, cost-centre or role changes for an existing Entra ID user via entra-scim-mcp: read current attributes, Custom Security Attributes and group memberships, diff against the authoritative record, check SoD and CSA gates, preview ordered update_user and group remove/add calls, gate on approval, execute, verify and emit a before/after audit record. Use for transfer, promotion, role change, department move, mover."
license: MIT
compatibility: "Requires entra-scim-mcp >= 0.3.0 (stdio) connected, plus the entra-lifecycle-policy, entitlement-guardrail and identity-change-auditor skills. Runs in MCPJam Inspector playground and Claude Code."
metadata:
  version: "0.2.0"
  author: darrenjrobinson
  product: entra-lifecycle-guardrails
  homepage: https://github.com/darrenjrobinson/entra-scim-mcp-skills
  requires-skill: entra-lifecycle-policy
  policy-version: "1.x"
  mcp-tools: "list_users get_user get_user_custom_security_attributes list_groups update_user update_user_custom_security_attributes remove_group_member add_group_members"
---

# mover-orchestrator

Applies an authoritative change to an existing identity: attributes first, then Custom Security Attributes, then group removals, then group additions, exactly as `moverRules.sequence` says. It reads the current state before deciding anything, treats CSAs as a policy signal (a cost-centre change can strip an entitlement), and never writes without a preview and, for medium or high risk, an approval reference plus operator confirmation. Budget: `costThresholds.maxToolCallsPerRun.mover-orchestrator` (20).

Never: rename `userName` or `mailNickname`, create or delete groups, touch groups that are not in the catalog, assign a privileged group without a valid approval, or override a `deny` with an approval.

## Inputs

A mover record per `entra-lifecycle-policy/references/source-record.md`: `sourceSystem`, `sourceRecordId`, `eventType: mover`, `target{userName|externalId}`, `changes{worker{department?, managerUserName?, jobTitle?}, customSecurityAttributes{<Set>{<Attr>}}}`, optional `previous{worker{...}}`, `requestedGroups{add[], remove[]}`, `approvals[]`. Generate `correlationId` = `elg-<sourceRecordId>-<6 random lowercase alphanumerics>`.

## Step 0 — Load the shared policy

The tenant policy lives in the `entra-lifecycle-policy` skill.

1. If a fenced ```` ```json policy ```` block from that skill is already in this conversation, use it.
2. Otherwise activate that skill: MCPJam Inspector → `loadSkill {"name": "entra-lifecycle-policy"}`; Claude Code → invoke the skill or Read `.claude/skills/entra-lifecycle-policy/SKILL.md`.
3. If you still need the raw file: MCPJam → `readSkillFile {"name": "entra-lifecycle-policy", "path": "policy/lifecycle-policy.json"}`; Claude Code → Read `.claude/skills/entra-lifecycle-policy/policy/lifecycle-policy.json`.
4. Confirm `policyId` and `policyVersion` parsed and the major version is 1; otherwise STOP with decision `require_manual_review`, reasonCode `policy_unavailable`. Never proceed on a remembered or summarised policy.
5. Quote `policyId` and `policyVersion` in check row CHK-01.

## Step 1 — Validate the record (no tool calls)

1. `authoritativeSources[]`: `sourceSystem` known, `sourceRecordId` matches `recordIdPattern`, `mover` in `events`. Fail → `deny` / `unknown_source`.
2. `target` has `userName` or `externalId` (never displayName).
3. Each key under `changes.worker` is one the joiner policy knows: `department` must satisfy REQ-05's list, `managerUserName` REQ-07's pattern, `jobTitle` free text. Any other key → `require_manual_review` / `source_conflict`.
4. Each `changes.customSecurityAttributes.<Set>.<Attr>` must be defined in `requiredJoinerAttributes.customSecurityAttributes[]` with the right `type` and pass its `allowedValues` or `pattern`; its `set` must be in `customSecurityAttributes.attributeSets`.
5. `requestedGroups.add[]` and `.remove[]` names must be in `groupCatalog`; otherwise `deny` / `group_not_in_catalog` for that name (the run continues).

## Step 2 — Resolve and read current state (reads; count each)

1. `list_users {filter: [{attr: "userName", op: "eq", value: "<target.userName>"}], attributes: ["id","userName","displayName","active"]}` (or `externalId` as the only clause). Exactly one → `userId`; else STOP `ambiguous_identity`. `active: false` → `warn` row.
2. If `changes.worker.managerUserName` is present: `list_users` by that `userName` → exactly one → `newManagerId`; else STOP `unresolved_manager`.
3. `get_user {id: "<userId>"}` → current `department`, `employeeNumber`, `manager.value`, `title`, `active`. Ignore any CSA object in this result.
4. `get_user_custom_security_attributes {id, attributeSets: <customSecurityAttributes.attributeSets>}` → `csa.current`.
5. `list_groups {filter: [{attr: "members.value", op: "eq", value: "<userId>"}], attributes: ["id","displayName"]}` → `currentMemberships` with their ids.
6. `list_groups {attributes: ["id","displayName"]}` (follow `nextCursor`) → ids for every catalog group the plan may add. Skip it when the plan has no additions (an attribute-only change such as S3c); removals use the ids from step 5.

## Step 3 — Diff and classify (no tool calls)

1. **Attributes**: for each `changes.worker` key, before (tenant) → after (record). Unchanged keys are dropped from the plan.
2. **Source conflict**: if `previous.worker.<k>` is present and differs from the tenant's current value → `require_manual_review` / `source_conflict` (the record was built from stale data).
3. **CSAs**: `csa.effective` = requested over current. Changed attributes go to the plan.
4. **Removals** = `requestedGroups.remove` + (when `department` changes and `moverRules.removeOldDepartmentGroups`) the old department's `approvedBaselineProfiles.profiles.<key>.departmentGroups[<old dept>]` that the user holds + (when `moverRules.reevaluateHeldGroupCsaGates`) every held catalog group whose `requiresCsa[]` no longer holds against `csa.effective` (row result `warn`, reasonCode `csa_condition_failed`, and it is removed). Held groups not in the catalog are left untouched (`leaveUncataloguedGroupsUntouched`).
5. **Additions** = `requestedGroups.add` + the new department's `departmentGroups` not already held. Baseline `baseGroups` are never re-added or removed by a mover.
6. **Signals**: `RS-05` department changed, `RS-06` manager changed, `RS-07` any CSA changed, `RS-08` only non-sensitive attributes (jobTitle) changed; plus the guardrail's RS-01..RS-03.

## Step 4 — Guardrail (no tool calls)

Activate `entitlement-guardrail` (MCPJam `loadSkill {"name": "entitlement-guardrail"}`; Claude Code invoke or Read) in embedded mode with `event: mover`, `currentMemberships`, `requestedGroups: {add: <additions>, remove: <removals>}`, `csa: {requested, current}`, `approvals`, `resolvedGroups`. SoD is evaluated on the resulting set (removals applied first). Denied adds are skipped; the run continues unless nothing is left to do.

## Step 5 — Preview and gate (no tool calls)

Risk = max of all fired signals. Decision per `approvalThresholds.decisionByRiskLevel` and the group results. A medium or high run needs an approval with scope `run` (or one per gated group) and operator confirmation. Print the full check table, then:

```
## Execution preview — mover — <correlationId>
Policy <policyId> v<policyVersion> | Decision: <decision> | Risk: <riskLevel> | Est. tool calls: <n> of 20
Before → after: department Finance → Engineering; manager <id> → <id>; Employment.CostCenter FIN-110 → ENG-210
| # | Tool | Key arguments (ids resolved this run) | Purpose | Policy basis |
| 1 | update_user | id=<userId>, replace enterprise department, replace enterprise manager {value:<newManagerId>} | attributes | moverRules.sequence[attributes] |
| 2 | update_user_custom_security_attributes | id=<userId>, replace Employment.CostCenter=ENG-210 | CSA | moverRules.sequence[customSecurityAttributes] |
| 3.. | remove_group_member | id=<groupId>, memberId=<userId> | <reason> | moverRules.removeOldDepartmentGroups / reevaluateHeldGroupCsaGates / requestedGroups.remove |
| .. | add_group_members | id=<groupId>, memberIds=[<userId>] | <reason> | approvedBaselineProfiles / requestedGroups.add |
| n-k..n | get_user (+ get_user_custom_security_attributes when a CSA changed, + list_groups when a membership changed) | verify | auditRequirements.verificationRequiredBeforeCompleted |
| — | (skipped) <group> | | <reasonCode> <ruleId> | <policy path> |
Approvals: <ref> scope <scope> → valid | missing for: <scopes>
Gate: <"low risk, proceeding" | "operator confirmation required: reply exactly `approve <correlationId>`" | "blocked: <reasonCode>">
```

The preview makes **zero** tool calls. If `approvalThresholds.operatorConfirmRequired[riskLevel]` is true, end the turn; continue only when a later operator message contains `approve <correlationId>` exactly. A missing or invalid approval → `awaiting_approval`, end the turn, name the scope. When the run risk is `low` (`decisionByRiskLevel.low = allow`, `operatorConfirmRequired.low = false`), print `Gate: low risk, proceeding` and continue straight to Step 6 in the same turn; no approval reference is needed and none should be asked for.

If there is nothing to write (S3a: the only requested add is denied), skip to Step 8 with the reads already made.

## Step 6 — Execute (order = `moverRules.sequence`; stop on the first `isError`)

1. `update_user {id, operations: [...]}` with one `replace` op per changed attribute, all in **one** call (the server applies the PATCH atomically): enterprise paths `urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department`, `...:manager` with value `{"value": "<newManagerId>"}`; core `title` for jobTitle. Never touch `mailNickname`, `userName` or `active`.
2. `update_user_custom_security_attributes {id, operations: [{op: "replace", path: "<pathPrefix>:<Set>.<Attr>", value}]}` for each changed CSA.
3. Removals first: one `remove_group_member {id: <groupId>, memberId: <userId>}` per group. A 404 means "not a member" → `warn`, confirmed at verification; any other error → STOP.
4. Additions: one `add_group_members {id: <groupId>, memberIds: [<userId>]}` per group.

Full argument JSON and error table: `references/tool-sequences.md`.

## Step 7 — Verify (one read per changed dimension, at most three)

1. `get_user {id}`: every changed attribute equals the planned after-value; `active` unchanged. Always.
2. `get_user_custom_security_attributes {id, attributeSets}`: changed CSAs equal the planned values. Only when a CSA was written.
3. `list_groups members.value eq <userId>`: equals (current − removals) + additions exactly. Only when a membership changed. Mismatch → `verification_failed`.

An attribute-only change (S3c) verifies with the single `get_user`; a transfer (S3b) needs all three.

## Step 8 — Audit

Activate `identity-change-auditor` and hand it everything, plus `details.before` / `details.after` objects (attributes, CSAs, memberships). Expected demo counts: S3a 5 reads, 0 writes, `blocked`; S3b 15 of 20 (6 reads, 2 attribute writes, 3 removals, 1 add, 3 verify), `completed`; S3c 6 of 20 (4 reads, 1 write, 1 verify), `completed`, risk low, no gate.

## Hard rules

1. Load the policy first, every run. Never act on a remembered, summarised or previously pasted policy.
2. Resolve every id in this run with `list_users` / `list_groups`. Never reuse an id from an example, an earlier turn or a prior run; the mock regenerates ids on every boot.
3. Read before write. Preview before execute. Verify before "done". No verification read, no "completed".
4. Never invent, infer, reformat or reuse an approval ref. An approval exists only if the operator or the record supplied it and it passes `approvalThresholds.approvalRef`. A `deny` is never overridden by an approval.
5. Never call the discovery tools; never call `list_users` without a filter; always pass `attributes` from `costThresholds.projection`.
6. CSAs: trust only `get_user_custom_security_attributes`. Ignore any CustomSecurityAttributes object in `get_user` or `list_users` output.
7. Number every tool call sequentially and cite it by number in evidence. At `costThresholds.warnAtPercent` say so; at the budget STOP with `cost_budget_exceeded`.
8. One `remove_group_member` call per membership, never batched. Removals before additions.
9. A result containing `dryRun: true` means nothing was applied. Outcome `rehearsal`; skip verification; say so plainly.
10. Stop and report on: identity 0 or >1, manager 0 or >1, `source_conflict`, approval required but absent or invalid, operator confirmation missing, any `isError` mid-sequence (except a 404 on remove), verification mismatch, budget exceeded, policy unreadable.
11. Partial success is first-class: list what landed, what failed, what was not attempted; removals and adds are idempotent and safe to re-run.
12. Never call `provision_user`, `deprovision_user`, `update_user_lifecycle`, `create_group`, `update_group` or `delete_group` in this skill.
13. Every run ends with a decision record, including blocked and rehearsal runs.
14. Groups the user holds that are not in the catalog are reported, never modified.

## STOP table

| condition | decision | outcome | reasonCode |
|---|---|---|---|
| policy unreadable / wrong major version | require_manual_review | not_executed | policy_unavailable |
| source unknown / pattern or event mismatch | deny | blocked | unknown_source |
| target resolves to 0 or 2+ | require_manual_review | not_executed | ambiguous_identity |
| new manager resolves to 0 or 2+ | require_manual_review | not_executed | unresolved_manager |
| `previous.*` disagrees with the tenant | require_manual_review | not_executed | source_conflict |
| every requested add denied and nothing else to change | deny | blocked | sod_conflict (or the group's reasonCode) |
| approval needed, missing or invalid | allow_with_approval | awaiting_approval | approval_missing / approval_invalid / approval_scope_mismatch |
| operator confirmation missing | (unchanged) | awaiting_approval | operator_confirmation_missing |
| `isError` on a write (other than remove 404) | (unchanged) | partial_failure | partial_failure |
| verification mismatch | (unchanged) | partial_failure | verification_failed |
| budget exceeded | require_manual_review | partial_failure or not_executed | cost_budget_exceeded |
| any `dryRun: true` result | (unchanged) | rehearsal | dry_run_active |

## Output

Plain summary (what changed, why, which policy rows, what did not change, what remains), then `Tool calls: n of 20 (r reads, w writes)`, then the fenced ```` ```json ```` decision record from the auditor.

## Policy fields read by this skill

`policyId`, `policyVersion`, `customSecurityAttributes.*`, `authoritativeSources[]`, `requiredJoinerAttributes.core[REQ-05, REQ-07]`, `requiredJoinerAttributes.customSecurityAttributes[]`, `approvedBaselineProfiles.profiles.<key>.departmentGroups`, `groupCatalog[]`, `privilegedGroups.*`, `sodRules[]`, `sodEvaluation`, `riskModel.signals[RS-01..RS-03, RS-05..RS-08]`, `approvalThresholds.*`, `moverRules.*`, `costThresholds.maxToolCallsPerRun.mover-orchestrator`, `costThresholds.warnAtPercent`, `costThresholds.groupResolution`, `costThresholds.projection`, `auditRequirements.correlationId`, `auditRequirements.policyCheckTableInTranscript`.
