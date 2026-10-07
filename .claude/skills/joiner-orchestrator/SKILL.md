---
name: joiner-orchestrator
description: "Safely onboard a new Entra ID user from an authoritative HR record via entra-scim-mcp: validate required attributes and mandatory Custom Security Attributes, apply naming standards, resolve the manager, run the entitlement guardrail, preview the exact tool calls, gate on approval, then provision_user, set CSAs, add baseline groups, verify and emit an audit record. Use for new hire, onboarding, create user, joiner."
license: MIT
compatibility: "Requires entra-scim-mcp >= 0.3.0 (stdio) connected, plus the entra-lifecycle-policy, entitlement-guardrail and identity-change-auditor skills. Runs in MCPJam Inspector playground and Claude Code."
metadata:
  version: "0.2.0"
  author: darrenjrobinson
  product: entra-lifecycle-guardrails
  homepage: https://github.com/darrenjrobinson/entra-scim-mcp-skills
  requires-skill: entra-lifecycle-policy
  policy-version: "1.x"
  mcp-tools: "list_groups list_users provision_user update_user_custom_security_attributes add_group_members get_user get_user_custom_security_attributes update_user"
---

# joiner-orchestrator

Creates a new identity from an authoritative source record and applies baseline access, in the order the policy dictates, with a preview and an approval gate before any write and a verification read before any claim of success. Budget: `costThresholds.maxToolCallsPerRun.joiner-orchestrator` (20). A record that fails validation is blocked with **zero** tool calls.

Never: create groups, assign privileged groups, invent an approval reference, show a password, or report "done" without the verification reads.

## Inputs

A joiner record per `entra-lifecycle-policy/references/source-record.md` (`sourceSystem`, `sourceRecordId`, `eventType: joiner`, `effectiveDate`, `worker{...}`, `customSecurityAttributes{...}`, `requestedGroups[]`, `approvals[]`), pasted by the operator or supplied as a file. Approvals may also arrive in a later operator message. Generate `correlationId` = `elg-<sourceRecordId>-<6 random lowercase alphanumerics>` at the start and use it everywhere.

## Step 0 — Load the shared policy

The tenant policy lives in the `entra-lifecycle-policy` skill.

1. If a fenced ```` ```json policy ```` block from that skill is already in this conversation, use it.
2. Otherwise activate that skill: MCPJam Inspector → `loadSkill {"name": "entra-lifecycle-policy"}`; Claude Code → invoke the skill or Read `.claude/skills/entra-lifecycle-policy/SKILL.md`.
3. If you still need the raw file: MCPJam → `readSkillFile {"name": "entra-lifecycle-policy", "path": "policy/lifecycle-policy.json"}`; Claude Code → Read `.claude/skills/entra-lifecycle-policy/policy/lifecycle-policy.json`.
4. Confirm `policyId` and `policyVersion` parsed and the major version is 1; otherwise STOP with decision `require_manual_review`, reasonCode `policy_unavailable`. Never proceed on a remembered or summarised policy.
5. Quote `policyId` and `policyVersion` in check row CHK-01.

## Step 1 — Validate the source record (no tool calls)

1. `authoritativeSources[]`: `sourceSystem` matches an `id`; `sourceRecordId` matches its `recordIdPattern`; `joiner` is in its `events`; `customSecurityAttributes.<keyedBy>` (Employment.ContractType) is in its `allowedContractTypes`. Fail → `deny` / `unknown_source`.
2. `requiredJoinerAttributes.core[]`: evaluate REQ-01..REQ-08 against `source.*`. Any fail → `deny` / `missing_required_attribute`.
3. `requiredJoinerAttributes.customSecurityAttributes[]`: for each REQ-CSA with `required: true`, the value must exist under `customSecurityAttributes.<set>.<attribute>`, have the declared `type`, and satisfy `allowedValues` or `pattern`. Missing → `deny` / `csa_missing` (reported as `missing_required_attribute` at run level). Optional ones with a `default` are written with the default when absent.
4. Select the profile: `approvedBaselineProfiles.profiles[<value of keyedBy CSA>]`; none → `require_manual_review` / `onNoProfile`.
5. Target group set = profile `baseGroups` + profile `departmentGroups[worker.department]` + `requestedGroups`.
6. Derive names per `namingStandards`: `userName` from the template, normalised (lowercase, diacritics stripped, only `a-z0-9.-`), must match `pattern`; `mailNickname` = local part; `displayName` from its template; primary email = userName. Detail in `references/tool-sequences.md`.

Print the check table so far. If any row is `deny`, go straight to Step 8 with `toolCalls.count = 0`.

## Step 2 — Policy-only guardrail (no tool calls)

Activate `entitlement-guardrail` (MCPJam `loadSkill {"name": "entitlement-guardrail"}`; Claude Code invoke or Read) in embedded mode with `event: joiner`, `currentMemberships: []`, `csa.requested` from the record, `approvals` from the record and chat, and **no** `resolvedGroups` yet. Take its per-group results:

- `allow` → in the plan.
- `allow_with_approval` with a valid approval → in the plan, approval `used`.
- `allow_with_approval` without one → the group stays out of the plan and the run outcome will be `awaiting_approval` unless the operator supplies the ref before execution.
- `deny` → skipped (`approvalThresholds.groupDenyHandling = skip_group_and_continue`), recorded with its reasonCode.

Run-level deny only when Step 1 failed or when the whole target group set is denied.

## Step 3 — Resolve (reads; count each)

1. `list_groups {attributes: ["id","displayName"]}`; follow `nextCursor`. Build `displayName → [ids]` for every group in the target set. 0 ids → `require_manual_review` / `group_not_found_in_tenant`; 2+ → `duplicate_group_display_name`. (Per-group `displayName eq` only if the catalog exceeds `costThresholds.groupResolution.listAllMaxCatalogSize`.)
2. `list_users {filter: [{attr: "externalId", op: "eq", value: "<sourceRecordId>"}], attributes: ["id","userName"]}` (`externalId` must be the only clause). Any result → STOP `joinerRules.existingUser` / `already_provisioned`.
3. `list_users {filter: [{attr: "userName", op: "eq", value: "<worker.managerUserName>"}], attributes: ["id","userName","displayName","active"]}`. Exactly one → `managerId`; `active: false` → `warn` (per `managerMustBeActive`); 0 or 2+ → `require_manual_review` / `unresolved_manager`.
4. `list_users {filter: [{attr: "userName", op: "eq", value: "<derived userName>"}], attributes: ["id","userName"]}`. 0 → free. 1+ → apply `namingStandards.userName.collision` (numeric suffix from `startAt`, at most `maxAttempts` further lookups, each counted); still taken → `require_manual_review` / `already_provisioned`.

Re-run the guardrail's check 2 with the resolved ids (no calls).

## Step 4 — Preview and gate (no tool calls)

Risk = max of `RS-01` (each planned group's `riskLevel`), `RS-02`, `RS-03`, `RS-04`. Decision per `approvalThresholds.decisionByRiskLevel` and the group results. Print the full check table, then:

```
## Execution preview — joiner — <correlationId>
Policy <policyId> v<policyVersion> | Decision: <decision> | Risk: <riskLevel> | Est. tool calls: <n> of 20
| # | Tool | Key arguments (ids resolved this run) | Purpose | Policy basis |
| 1 | provision_user | userName=…, mailNickname=…, active=false, externalId=<sourceRecordId>, managerId=<id>, password=<generated, not shown> | create inactive | joinerRules.createInactiveUntilVerified |
| 2 | update_user_custom_security_attributes | id=<new>, replace Employment.ContractType, Employment.CostCenter, Compliance.DataClassification | mandatory CSAs | requiredJoinerAttributes.customSecurityAttributes |
| 3.. | add_group_members | id=<groupId>, memberIds=[<new>] | <baseline|department|requested (+approval ref)> | approvedBaselineProfiles / groupCatalog |
| n-3..n-1 | get_user / get_user_custom_security_attributes / list_groups | verify | auditRequirements.verificationRequiredBeforeCompleted |
| n | update_user | id=<new>, replace active=true | activate | joinerRules.sequence |
| — | (skipped) <group> | | <reasonCode> <ruleId> | <policy path> |
Approvals: <ref> scope <scope> → valid | missing for: <scopes>
Gate: <"low risk, proceeding" | "operator confirmation required: reply exactly `approve <correlationId>`" | "blocked: <reasonCode>">
```

The preview makes **zero** tool calls. If `approvalThresholds.operatorConfirmRequired[riskLevel]` is true, end your turn here. Continue only when a later operator message contains `approve <correlationId>` exactly; "yes" or "go ahead" does not count. If a needed approval ref is missing, say which scope and end the turn (`awaiting_approval`).

## Step 5 — Execute (order = `joinerRules.sequence`; stop on the first `isError`)

1. `provision_user` with `active: false`, `externalId: <sourceRecordId>`, `emails: [{value: <userName>, type: "work", primary: true}]`, `department`, `employeeNumber`, `userType`, `managerId`, and a freshly generated password meeting `namingStandards.password` (16+ chars, four classes). Capture the returned `id` and `meta.created`. A 409 → STOP `already_provisioned`.
2. `update_user_custom_security_attributes` with one `replace` op per required (and present optional) CSA, path `<customSecurityAttributes.pathPrefix>:<Set>.<Attribute>`, typed values (booleans as booleans).
3. One `add_group_members {id: <groupId>, memberIds: [<userId>]}` per planned group, in catalog order. On `AddGroupMembersPartialFailure` or any error → STOP; the account stays inactive (`joinerRules.onStepFailure = stop_leave_inactive`); report exactly what landed.

Full argument JSON and error table: `references/tool-sequences.md`.

## Step 6 — Verify (three reads)

1. `get_user {id}`: `userName`, `active = false`, `externalId`, `department`, `employeeNumber`, enterprise `manager.value = managerId`.
2. `get_user_custom_security_attributes {id, attributeSets: <customSecurityAttributes.attributeSets>}`: every written value present and equal.
3. `list_groups {filter: [{attr: "members.value", op: "eq", value: "<id>"}], attributes: ["id","displayName"]}`: exactly the planned set. Extra or missing → `verification_failed`; do not activate.

## Step 7 — Activate

Only when every verification finding is `pass` and `joinerRules.createInactiveUntilVerified` is true: `update_user {id, operations: [{op: "replace", path: "active", value: true}]}`, then `get_user {id, attributes: ["active"]}` → `true`.

## Step 8 — Audit

Activate `identity-change-auditor` (MCPJam `loadSkill {"name": "identity-change-auditor"}`; Claude Code invoke or Read) and hand it everything: the check table rows, approvals, the preview rows, every numbered tool call with its result, skipped groups, verification observations and the tally. A re-run after a blocked request sets `supersedes` to the earlier correlationId and resolves every id again.

Expected demo count (S2): 4 resolve + 1 create + 1 CSA + 4 adds + 3 verify + 2 activate = 15 of 20.

## Hard rules

1. Load the policy first, every run. Never act on a remembered, summarised or previously pasted policy.
2. Resolve every id in this run with `list_users` / `list_groups`. Never reuse an id from an example, an earlier turn or a prior run; the mock regenerates ids on every boot.
3. Read before write. Preview before execute. Verify before "done". No verification read, no "completed".
4. Never invent, infer, reformat or reuse an approval ref. An approval exists only if the operator or the record supplied it and it passes `approvalThresholds.approvalRef`.
5. Never call the discovery tools; never call `list_users` without a filter; always pass `attributes` from `costThresholds.projection`.
6. CSAs: trust only `get_user_custom_security_attributes`. Ignore any CustomSecurityAttributes object in `get_user` or `list_users` output.
7. Number every tool call sequentially and cite it by number in evidence. At `costThresholds.warnAtPercent` say so; at the budget STOP with `cost_budget_exceeded`.
8. The password appears nowhere: not in the preview, the record or chat. Render it as `<generated, not shown>` and use it exactly once, in the `provision_user` call.
9. A result containing `dryRun: true` means nothing was applied. Outcome `rehearsal`; skip verification; say so plainly.
10. Stop and report (do not improvise) on: any Step 1 deny, 0 or >1 manager match, `already_provisioned`, group resolution 0 or 2+, approval required but absent or invalid, operator confirmation missing, any `isError` mid-sequence, verification mismatch, budget exceeded, policy unreadable.
11. Partial success is first-class: list what landed, what failed, what was not attempted, and the state left behind (an inactive account is the compensating control).
12. Never call `create_group`, `update_group`, `delete_group` or `deprovision_user` in this skill.
13. Every run ends with a decision record, including blocked and rehearsal runs.
14. `provision_user` cannot set CSAs or memberships; they are always separate calls after the create.

## STOP table

| condition | decision | outcome | reasonCode |
|---|---|---|---|
| policy unreadable / wrong major version | require_manual_review | not_executed | policy_unavailable |
| source not in `authoritativeSources` / pattern or event mismatch | deny | blocked | unknown_source |
| required core or CSA attribute missing or invalid | deny | blocked | missing_required_attribute |
| no matching baseline profile | require_manual_review | not_executed | source_conflict |
| manager resolves to 0 or 2+ | require_manual_review | not_executed | unresolved_manager |
| `externalId` or derived `userName` already present | require_manual_review | not_executed | already_provisioned |
| catalog group resolves to 0 / 2+ | require_manual_review | not_executed | group_not_found_in_tenant / duplicate_group_display_name |
| approval needed, missing or invalid | allow_with_approval | awaiting_approval | approval_missing / approval_invalid / approval_scope_mismatch |
| operator confirmation missing | (unchanged) | awaiting_approval | operator_confirmation_missing |
| `isError` on a write | (unchanged) | partial_failure | partial_failure |
| verification mismatch | (unchanged) | partial_failure | verification_failed |
| budget exceeded | require_manual_review | partial_failure or not_executed | cost_budget_exceeded |
| any `dryRun: true` result | (unchanged) | rehearsal | dry_run_active |

## Output

Plain summary (what changed, why, which policy rows, what did not change, what remains), then `Tool calls: n of 20 (r reads, w writes)`, then the fenced ```` ```json ```` decision record from the auditor.

## Policy fields read by this skill

`policyId`, `policyVersion`, `tenant.primaryDomain`, `customSecurityAttributes.*`, `authoritativeSources[]`, `requiredJoinerAttributes.*`, `approvedBaselineProfiles.*`, `groupCatalog[]`, `privilegedGroups.*`, `sodRules[]`, `sodEvaluation`, `riskModel.signals[RS-01..RS-04]`, `approvalThresholds.*`, `joinerRules.*`, `namingStandards.*`, `costThresholds.maxToolCallsPerRun.joiner-orchestrator`, `costThresholds.warnAtPercent`, `costThresholds.groupResolution`, `costThresholds.projection`, `auditRequirements.correlationId`, `auditRequirements.policyCheckTableInTranscript`.
