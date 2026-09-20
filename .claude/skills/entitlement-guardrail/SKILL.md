---
name: entitlement-guardrail
description: "Evaluate requested Entra ID group assignments against the shared lifecycle policy before any write: catalog membership, privileged-group rules, Custom Security Attribute gates, separation-of-duties conflicts, approval refs and estimated tool-call cost. Returns allow, allow_with_approval, deny or require_manual_review per group plus a decision record. Use for access requests, 'can this user have group X', SoD or privilege checks, and inside joiner/mover runs."
license: MIT
compatibility: "Requires entra-scim-mcp >= 0.2.1 (stdio) when run standalone; makes no tool calls when embedded by an orchestrator. Requires the entra-lifecycle-policy and identity-change-auditor skills. Works in MCPJam Inspector and Claude Code."
metadata:
  version: "0.1.0"
  author: darrenjrobinson
  product: entra-lifecycle-guardrails
  homepage: https://github.com/darrenjrobinson/entra-scim-mcp-skills
  requires-skill: entra-lifecycle-policy
  policy-version: "1.x"
  mcp-tools: "list_users list_groups get_user_custom_security_attributes"
---

# entitlement-guardrail

Decides, per requested group, whether an assignment may proceed and under what condition. It is the policy engine the joiner and mover call before they write anything, and it can be asked directly ("can Adele have SG-Finance-AP-Approvers?"). It never writes.

Two modes:

- **Embedded** (called by an orchestrator): the caller passes the resolved group ids, the target's current memberships and CSAs, and the approvals. Zero tool calls.
- **Standalone** (asked directly): up to four reads, budget `costThresholds.maxToolCallsPerRun.entitlement-guardrail` (6).

## Step 0 — Load the shared policy

The tenant policy lives in the `entra-lifecycle-policy` skill.

1. If a fenced ```` ```json policy ```` block from that skill is already in this conversation, use it.
2. Otherwise activate that skill: MCPJam Inspector → `loadSkill {"name": "entra-lifecycle-policy"}`; Claude Code → invoke the skill or Read `.claude/skills/entra-lifecycle-policy/SKILL.md`.
3. If you still need the raw file: MCPJam → `readSkillFile {"name": "entra-lifecycle-policy", "path": "policy/lifecycle-policy.json"}`; Claude Code → Read `.claude/skills/entra-lifecycle-policy/policy/lifecycle-policy.json`.
4. Confirm `policyId` and `policyVersion` parsed and the major version is 1; otherwise STOP with decision `require_manual_review`, reasonCode `policy_unavailable`. Never proceed on a remembered or summarised policy.
5. Quote `policyId` and `policyVersion` in check row CHK-01.

## Inputs

```json
{
  "event": "joiner | mover | entitlement-evaluation",
  "subject": { "userName": "adele.vance@contoso.local" }   // or {"externalId": "..."} or {"newHire": true}
  "requestedGroups": { "add": ["SG-Finance-AP-Approvers"], "remove": [] },
  "csa": { "requested": { "Employment": { "ContractType": "Employee" } }, "current": {} },
  "currentMemberships": ["All Employees", "SG-Finance-Users", "SG-Finance-AP-Requestors"],
  "approvals": [ { "ref": "REQ-50017", "scope": "group:SG-Finance-AP-Approvers", "approver": "...", "sourceRecordId": "WD-000103" } ],
  "resolvedGroups": { "SG-Finance-AP-Approvers": ["<id>"] },
  "sourceRecordId": "WD-000103",
  "correlationId": "elg-WD-000103-a7q1zt"
}
```

Embedded callers supply everything. Standalone: `subject`, `requestedGroups` and any approvals come from the operator; the rest is read.

## Standalone reads (in this order, each counted)

1. `list_users {filter: [{attr: "userName", op: "eq", value: "<userName>"}], attributes: ["id","userName","displayName","active"]}` (or `externalId` alone). Exactly one result, else STOP `ambiguous_identity`.
2. `list_groups {filter: [{attr: "members.value", op: "eq", value: "<id>"}], attributes: ["id","displayName"]}` → `currentMemberships` (the only membership read that exists).
3. `get_user_custom_security_attributes {id: "<id>", attributeSets: <customSecurityAttributes.attributeSets>}` → `csa.current`. This is the only trusted CSA source.
4. `list_groups {attributes: ["id","displayName"]}` (follow `nextCursor`) → `resolvedGroups` for every requested name. Per-group `displayName eq` filter only when the catalog exceeds `costThresholds.groupResolution.listAllMaxCatalogSize`.

For `{"newHire": true}`, skip reads 1–3: `currentMemberships = []`, `csa.current = {}`.

## Per-group evaluation (exact order; first deny wins for that group)

Compute `csa.effective` = requested value if present else current. Normalise group names case-insensitively; catalog names are authoritative.

| # | check | policy ref | outcome if it fails |
|---|---|---|---|
| 1 | name is in `groupCatalog[].displayName` | `groupCatalog` | deny `group_not_in_catalog` |
| 2 | resolves to exactly one id (when `resolvedGroups` supplied) | `costThresholds.groupResolution` | require_manual_review `group_not_found_in_tenant` (0) / `duplicate_group_display_name` (2+) |
| 3 | privileged? (`privilegedGroups.displayNames` or `classification = privileged`): in `rules.breakglassOnlyGroups` → deny `breakglass_only`; event joiner → deny `privileged_not_allowed_at_joiner`; else needs approval scope `group:<name>` and `rules.minimumRiskLevel` | `privilegedGroups` | as stated |
| 4 | event joiner and `allowedAtJoiner = false` | `groupCatalog[].allowedAtJoiner` | deny `not_allowed_at_joiner` |
| 5 | event joiner and `riskLevel` > profile `maxGroupRiskLevelAtJoiner` | `approvedBaselineProfiles.profiles.<key>.maxGroupRiskLevelAtJoiner` | deny `exceeds_profile_risk` |
| 6 | every `requiresCsa[]` condition holds against `csa.effective` | `groupCatalog[].requiresCsa` | deny `csa_missing` (subject absent) / `csa_condition_failed` (false) |
| 7 | SoD: resulting set = (currentMemberships − remove) + add; a rule fires when ≥2 of its `conflictingGroups` are in it | `sodRules`, `sodEvaluation` | the requested member gets the rule's `enforcement` (`deny` → `sod_conflict`; `allow_with_approval` → needs scope `sod:<ruleId>`); when both members are requested, `sodEvaluation.bothRequestedRule` picks the one denied (higher catalog `riskLevel`, tie → later in the request); conflict only among pre-existing groups → `warn` + residual risk |
| 8 | `approvalRequired = true`, or `decisionByRiskLevel[riskLevel] = allow_with_approval` | `groupCatalog[].approvalRequired`, `approvalThresholds.decisionByRiskLevel` | allow_with_approval, needs scope `group:<name>` (or `run`) |
| 9 | an approval exists for every needed scope and is valid (pattern, `requiredFields`, `sourceRecordId` match, scope match) | `approvalThresholds.approvalRef` | needed but absent → `approval_missing`; present but bad → `approval_invalid` / `approval_scope_mismatch`; valid → the group is allowed and the approval is marked `used` |
| 10 | otherwise | | allow |

Denied groups do not stop the run (`approvalThresholds.groupDenyHandling = skip_group_and_continue`); the caller skips them. Truth tables and worked examples: `references/evaluation-algorithm.md`.

## Run decision and risk

- Run decision = worst per-group result per `evaluation.decisionPrecedence` (`deny` > `require_manual_review` > `allow_with_approval` > `allow`). For the caller's purposes a group `deny` is a *group* outcome; the run is denied only when the caller says a denied group is fatal (the joiner and mover treat run-level deny as: required attribute missing, unknown source, or every requested group denied with nothing left to do).
- Run risk = max over fired signals `RS-01` (each group's catalog `riskLevel`), `RS-02` (any privileged group), `RS-03` (any SoD rule fired), plus `RS-04` when the caller reports a missing required attribute.

## Cost estimate

Adds × 1 + removes × 1 + 3 verification reads (+ 2 for a joiner activate step). Compare with the caller's `costThresholds.maxToolCallsPerRun.<caller>` and report it.

## Mandatory check table

Print this before returning (and the caller re-prints it before any write). Every row becomes a `policyChecks[]` item with the same id.

```
### Policy checks — <policyId> v<policyVersion> — <correlationId>
| # | Check | Policy ref | Input (normalised) | Evidence | Result |
| CHK-01 | Policy loaded | policyVersion | 1.0.0 | skill file | pass |
| CHK-02 | Group in catalog: sg-finance-ap-approvers | groupCatalog | SG-Finance-AP-Approvers | policy | pass |
| CHK-03 | SOD-FIN-001: AP-Requestors + AP-Approvers in resulting set | sodRules[SOD-FIN-001] | current: AP-Requestors; add: AP-Approvers | call #2 | fail → deny (sod_conflict) |
| — | Aggregate | evaluation.decisionPrecedence | max risk = high | rows above | decision = deny |
```

Result column values: `pass` | `fail` | `warn` | `needs_approval` | `manual_review` | `skipped`, followed by `→ <decision> (<reasonCode>)` when not pass.

## Output

Return to the caller (or print, when standalone):

1. The check table.
2. `groupResults[]`: `{displayName, id|null, result (Decision), reasonCodes[], ruleIds[], approvalScopeNeeded|null}` for every requested group, in request order.
3. Run `decision`, `riskLevel`, cost estimate.
4. Standalone only: hand everything to `identity-change-auditor` (MCPJam `loadSkill {"name": "identity-change-auditor"}`; Claude Code invoke or Read) with `event: "entitlement-evaluation"` and `groupResults` under `details`.

## Hard rules

1. Load the policy first, every run. Never act on a remembered, summarised or previously pasted policy.
2. Resolve every id in this run with `list_users` / `list_groups`. Never reuse an id from an example, an earlier turn or a prior run; the mock regenerates ids on every boot.
3. Read before write; preview before execute; verify before "done". (This skill never writes.)
4. Never invent, infer, reformat or reuse an approval ref. An approval exists only if the operator or the record supplied it and it passes `approvalThresholds.approvalRef`.
5. Never call the discovery tools; never call `list_users` without a filter; always pass `attributes` from `costThresholds.projection`.
6. CSAs: trust only `get_user_custom_security_attributes`. Ignore any CustomSecurityAttributes object that appears in `get_user` or `list_users` output (the mock returns them there; the live API never does).
7. Number every tool call sequentially and cite it by number in evidence. At `costThresholds.warnAtPercent` say so; at the budget STOP with `cost_budget_exceeded`.
8. A group name that is not in the catalog is `group_not_in_catalog`. Never pick the closest match.
9. SoD is evaluated on the *resulting* set, never on the requested list alone.
10. A `deny` cannot be overridden by an approval. Only `allow_with_approval` can.
11. Stop and report on: 0 or more than 1 identity match, policy unreadable, budget exceeded, any `isError` result.
12. Every standalone run ends with a decision record.

## STOP table

| condition | decision | outcome | reasonCode |
|---|---|---|---|
| policy unreadable / wrong major version | require_manual_review | not_executed | policy_unavailable |
| subject resolves to 0 or >1 users | require_manual_review | not_executed | ambiguous_identity |
| budget exceeded | require_manual_review | not_executed | cost_budget_exceeded |
| `isError` on a read | require_manual_review | not_executed | partial_failure |
| any `dryRun: true` result | (unchanged) | rehearsal | dry_run_active |

## Policy fields read by this skill

`policyId`, `policyVersion`, `evaluation.*`, `customSecurityAttributes.attributeSets`, `customSecurityAttributes.trustOnlyDedicatedRead`, `approvedBaselineProfiles.profiles.<key>.maxGroupRiskLevelAtJoiner`, `groupCatalog[]` (all fields), `privilegedGroups.*`, `sodRules[]`, `sodEvaluation`, `riskModel.aggregate`, `riskModel.signals[RS-01..RS-04]`, `approvalThresholds.approvalRef`, `approvalThresholds.approvalScopes`, `approvalThresholds.decisionByRiskLevel`, `approvalThresholds.groupDenyHandling`, `approvalThresholds.escalations.*`, `costThresholds.maxToolCallsPerRun.entitlement-guardrail`, `costThresholds.warnAtPercent`, `costThresholds.groupResolution`, `costThresholds.projection`.
