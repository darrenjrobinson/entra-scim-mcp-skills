# S3a — Mover denied: separation of duties beats a valid approval

| | |
|---|---|
| Skill | `mover-orchestrator` |
| Record | `demo/source-records/S3a-adele-vance-sod.json` |
| Model | claude-fable-5-1 (effort xhigh) |
| Claude Code | 2.1.268 |
| entra-scim-mcp | 0.3.0 (mock, boot 2) |
| Policy | contoso-lifecycle-policy v1.2.0 |
| Recorded | 2026-10-06T06:55:46Z |
| Session | `2f1f5797-9f28-42cd-8815-c8dcdc2c1352` |

Object ids are rendered as `<userName>` or `<displayName>` for readability; the raw ids are in the gitignored stream files and in `demo/expected/`. The generated password is redacted everywhere.

## Turn 1 — operator

```text
/mover-orchestrator
Process this access change.

{
  "sourceSystem": "workday",
  "sourceRecordId": "WD-000103",
  "eventType": "mover",
  "effectiveDate": "2026-09-22",
  "target": { "userName": "adele.vance@contoso.local" },
  "changes": { },
  "requestedGroups": {
    "add": ["SG-Finance-AP-Approvers"],
    "remove": []
  },
  "approvals": [
    {
      "ref": "REQ-50017",
      "scope": "group:SG-Finance-AP-Approvers",
      "approver": "patti.fernandez@contoso.local",
      "sourceRecordId": "WD-000103",
      "grantedAt": "2026-09-19T23:15:00Z"
    }
  ]
}
```

## Turn 1 — assistant

I'm running the mover-orchestrator for WD-000103 (Adele Vance, add SG-Finance-AP-Approvers). Step 0: loading the shared policy and the supporting skill files.

> (Read .claude/skills/entra-lifecycle-policy/policy/lifecycle-policy.json)

> (Read .claude/skills/entitlement-guardrail/SKILL.md)

> (Read .claude/skills/mover-orchestrator/references/tool-sequences.md)

> (ToolSearch )

> (Read .claude/skills/identity-change-auditor/SKILL.md)

> (Read .claude/skills/identity-change-auditor/references/record-template.md)

> (Read .claude/skills/entra-lifecycle-policy/policy/decision-record.schema.json)

> #1 list_users {filter: [{attr: "userName",op: "eq",value: "adele.vance@contoso.local"}],attributes: ["id","userName","displayName","active"]} → ok, totalResults 1

> #2 list_groups {attributes: ["id","displayName"]} → ok, totalResults 10

> #3 get_user {id: "<adele.vance>"} → ok, id <adele.vance>, active true

> #4 get_user_custom_security_attributes {id: "<adele.vance>",attributeSets: ["Employment","Compliance"]} → ok, id <adele.vance>

> #5 list_groups {filter: [{attr: "members.value",op: "eq",value: "<adele.vance>"}],attributes: ["id","displayName"]} → ok, totalResults 3

> (Read .claude/skills/mover-orchestrator/SKILL.md)

> (Read .claude/skills/entra-lifecycle-policy/policy/decision-record.example.json)

The run is blocked at the guardrail. Adele Vance already holds SG-Finance-AP-Requestors, so adding SG-Finance-AP-Approvers would put both halves of separation-of-duties rule SOD-FIN-001 in her resulting membership set. The rule's enforcement is `deny`, and a deny cannot be overridden by an approval, so REQ-50017 is valid but unused. Nothing was written. Five reads were made against a budget of twenty.

### Policy checks — contoso-lifecycle-policy v1.2.0 — elg-WD-000103-k3m9xq

| # | Check | Policy ref | Input (normalised) | Evidence | Result |
|---|---|---|---|---|---|
| CHK-01 | Policy loaded | policyVersion | contoso-lifecycle-policy 1.2.0 | skill file policy/lifecycle-policy.json | pass |
| CHK-02 | Authoritative source | authoritativeSources[id=workday] | workday; WD-000103; eventType=mover | source record: matches ^WD-[0-9]{6}$; mover in events | pass |
| CHK-03 | Target resolves to exactly one | approvalThresholds.escalations.ambiguousIdentity | adele.vance@contoso.local | call #1: 1 result, active=true, id <adele.vance> | pass |
| CHK-04 | Attribute diff | moverRules.compareToPreviousWhenPresent | changes.worker (absent); previous (absent) | call #3: department Finance, title Accounts Payable Analyst, manager e8d221da-… ; nothing to change | pass |
| CHK-05 | CSA diff | customSecurityAttributes.trustOnlyDedicatedRead | csa.requested (absent) | call #4: Employment.ContractType=Employee, CostCenter=FIN-100, Compliance.DataClassification=Confidential, LegalHold=false; csa.effective = current | pass |
| CHK-06 | Held-group CSA gates | moverRules.reevaluateHeldGroupCsaGates | held: All Employees, SG-Finance-Users, SG-Finance-AP-Requestors | call #5: 3 memberships, all in catalog, all requiresCsa=[]; no uncatalogued groups | pass |
| CHK-07 | Group in catalog: sg-finance-ap-approvers | groupCatalog | SG-Finance-AP-Approvers | policy: business/medium, approvalRequired=false, requiresCsa=[] | pass |
| CHK-08 | Group resolves to exactly one id | costThresholds.groupResolution | SG-Finance-AP-Approvers | call #2: catalog listing 10 groups, 1 match id <SG-Finance-AP-Approvers> | pass |
| CHK-09 | Privileged group | privilegedGroups | SG-Finance-AP-Approvers | policy: not in displayNames, classification=business | pass |
| CHK-10 | requiresCsa | groupCatalog[SG-Finance-AP-Approvers].requiresCsa | [] | policy: no conditions | pass |
| CHK-11 | SOD-FIN-001: AP-Requestors + AP-Approvers in resulting set | sodRules[SOD-FIN-001] | resulting set = {All Employees, SG-Finance-Users, SG-Finance-AP-Requestors} + {SG-Finance-AP-Approvers} | call #5: SG-Finance-AP-Requestors held; enforcement=deny; requested member denied | fail → deny (sod_conflict) |
| CHK-12 | Other SoD rules | sodRules[SOD-FIN-002, SOD-ADM-001] | resulting set as above | policy: SG-Engineering-ProdDeploy, SG-Finance-Treasury-Payments, SG-Entra-TenantAdmins not in set | pass |
| CHK-13 | Approval REQ-50017 | approvalThresholds.approvalRef | REQ-50017 scope group:SG-Finance-AP-Approvers; sourceRecordId WD-000103 | source record approvals[0]: matches pattern, requiredFields present, sourceRecordId matches, scope matches; not used, a deny is never overridden by an approval | pass |
| CHK-14 | Tool-call budget | costThresholds.maxToolCallsPerRun.mover-orchestrator | 5 of 20 (25%) | calls #1–#5, all reads | pass |
| — | Aggregate | evaluation.decisionPrecedence | deny (CHK-11); RS-01 medium + RS-03 high → max = high | rows above | decision = deny |

## Execution preview — mover — elg-WD-000103-k3m9xq
Policy contoso-lifecycle-policy v1.2.0 | Decision: deny | Risk: high | Est. tool calls: 5 of 20
Before → after: no attribute or CSA change requested; memberships unchanged

| # | Tool | Key arguments (ids resolved this run) | Purpose | Policy basis |
|---|---|---|---|---|
| — | (skipped) add_group_members SG-Finance-AP-Approvers | id=<SG-Finance-AP-Approvers>, memberIds=[<adele.vance>] | sod_conflict SOD-FIN-001 | sodRules[SOD-FIN-001] |

Approvals: REQ-50017 scope group:SG-Finance-AP-Approvers → valid (not used)
Gate: blocked: sod_conflict

Nothing changed for Adele Vance (id <adele.vance>): no attribute, Custom Security Attribute or group membership was written. Workday mover record WD-000103 asked only for the addition of SG-Finance-AP-Approvers, backed by approval REQ-50017. Separation-of-duties rule SOD-FIN-001 denied that addition because the resulting membership set would hold both SG-Finance-AP-Requestors, which she already holds per call #5, and SG-Finance-AP-Approvers, and a deny is never overridden by an approval, so REQ-50017 was valid but unused. Her existing memberships All Employees, SG-Finance-Users and SG-Finance-AP-Requestors, her department Finance, her manager and her cost centre FIN-100 are unchanged. finance-systems must decide whether this is a requestor-to-approver move and, if so, resubmit the record with SG-Finance-AP-Requestors in requestedGroups.remove.

Tool calls: 5 of 20 (5 reads, 0 writes)

```json
{
  "recordVersion": "1.0",
  "correlationId": "elg-WD-000103-k3m9xq",
  "supersedes": null,
  "skill": "mover-orchestrator",
  "skillVersion": "0.2.0",
  "policyId": "contoso-lifecycle-policy",
  "policyVersion": "1.2.0",
  "event": "mover",
  "host": "claude-code",
  "dryRun": false,
  "startedAt": "2026-10-06T06:55:46.437Z",
  "completedAt": "2026-10-06T06:55:46.701Z",
  "clockSource": "resourceMeta",
  "source": { "system": "workday", "recordId": "WD-000103" },
  "target": { "userName": "adele.vance@contoso.local", "id": "<adele.vance>", "displayName": "Adele Vance" },
  "decision": "deny",
  "outcome": "blocked",
  "riskLevel": "high",
  "policyChecks": [
    { "id": "CHK-01", "rule": "policyVersion", "input": "contoso-lifecycle-policy 1.2.0", "evidence": "entra-lifecycle-policy skill, policy/lifecycle-policy.json; major version 1", "result": "pass" },
    { "id": "CHK-02", "rule": "authoritativeSources[id=workday]", "input": "sourceSystem=workday; sourceRecordId=WD-000103; eventType=mover", "evidence": "source record: matches ^WD-[0-9]{6}$; mover in events", "result": "pass" },
    { "id": "CHK-03", "rule": "approvalThresholds.escalations.ambiguousIdentity", "subject": "adele.vance@contoso.local", "input": "userName eq adele.vance@contoso.local", "evidence": "call #1: list_users -> totalResults 1, active=true, id <adele.vance>", "result": "pass" },
    { "id": "CHK-04", "rule": "moverRules.compareToPreviousWhenPresent", "subject": "changes.worker", "input": "(absent); previous (absent)", "evidence": "call #3: get_user -> department Finance, employeeNumber 100003, manager e8d221da-8c63-45e2-a108-1e0a3f494998, title Accounts Payable Analyst, active=true; no attribute to change", "result": "pass" },
    { "id": "CHK-05", "rule": "customSecurityAttributes.trustOnlyDedicatedRead", "subject": "changes.customSecurityAttributes", "input": "(absent)", "evidence": "call #4: get_user_custom_security_attributes -> Employment.ContractType=Employee, Employment.CostCenter=FIN-100, Compliance.DataClassification=Confidential, Compliance.LegalHold=false; csa.effective = current", "result": "pass" },
    { "id": "CHK-06", "rule": "moverRules.reevaluateHeldGroupCsaGates", "subject": "currentMemberships", "input": "All Employees, SG-Finance-Users, SG-Finance-AP-Requestors", "evidence": "call #5: list_groups members.value eq <adele.vance> -> totalResults 3; all in catalog with requiresCsa=[]; no uncatalogued groups held", "result": "pass" },
    { "id": "CHK-07", "rule": "groupCatalog[SG-Finance-AP-Approvers]", "subject": "SG-Finance-AP-Approvers", "input": "requested add", "evidence": "policy: classification business, riskLevel medium, approvalRequired=false, requiresCsa=[]", "result": "pass" },
    { "id": "CHK-08", "rule": "costThresholds.groupResolution", "subject": "SG-Finance-AP-Approvers", "input": "listAll, catalog size 10 <= 25", "evidence": "call #2: list_groups -> totalResults 10, no nextCursor; SG-Finance-AP-Approvers -> 1 match id <SG-Finance-AP-Approvers>", "result": "pass" },
    { "id": "CHK-09", "rule": "privilegedGroups", "subject": "SG-Finance-AP-Approvers", "input": "classification=business", "evidence": "policy: not in privilegedGroups.displayNames and classification is not privileged", "result": "pass" },
    { "id": "CHK-10", "rule": "groupCatalog[SG-Finance-AP-Approvers].requiresCsa", "subject": "SG-Finance-AP-Approvers", "input": "[]", "evidence": "policy: no CSA conditions on this group", "result": "pass" },
    { "id": "CHK-11", "rule": "sodRules[SOD-FIN-001]", "subject": "SG-Finance-AP-Approvers", "input": "resulting set = {All Employees, SG-Finance-Users, SG-Finance-AP-Requestors, SG-Finance-AP-Approvers}", "evidence": "call #5: SG-Finance-AP-Requestors already held; policy: both conflictingGroups in resulting set, enforcement=deny; the requested member SG-Finance-AP-Approvers is denied", "result": "fail", "reasonCode": "sod_conflict" },
    { "id": "CHK-12", "rule": "sodRules[SOD-FIN-002, SOD-ADM-001]", "input": "resulting set as CHK-11", "evidence": "policy: SG-Engineering-ProdDeploy, SG-Finance-Treasury-Payments and SG-Entra-TenantAdmins are not in the resulting set; neither rule fires", "result": "pass" },
    { "id": "CHK-13", "rule": "approvalThresholds.approvalRef", "subject": "REQ-50017", "input": "scope group:SG-Finance-AP-Approvers; approver patti.fernandez@contoso.local; sourceRecordId WD-000103", "evidence": "source record approvals[0]: matches ^(CHG|REQ|INC)-[0-9]{5,}$, all requiredFields present, sourceRecordId matches, scope matches the requested group; not used because a deny is never overridden by an approval", "result": "pass" },
    { "id": "CHK-14", "rule": "costThresholds.maxToolCallsPerRun.mover-orchestrator", "input": "5 of 20 (25%)", "evidence": "calls #1-#5, all reads; below warnAtPercent 80", "result": "pass" },
    { "id": "CHK-15", "rule": "evaluation.decisionPrecedence", "input": "deny (CHK-11); signals RS-01 medium, RS-03 high", "evidence": "worst result across rows; riskModel.aggregate=max -> high; only requested add denied and nothing else to change", "result": "fail", "reasonCode": "sod_conflict" }
  ],
  "approvals": [
    { "ref": "REQ-50017", "scope": "group:SG-Finance-AP-Approvers", "approver": "patti.fernandez@contoso.local", "sourceRecordId": "WD-000103", "grantedAt": "2026-09-19T23:15:00Z", "valid": true, "used": false }
  ],
  "plannedActions": [],
  "executedActions": [
    { "call": 1, "seq": 0, "phase": "resolve", "tool": "list_users", "status": "ok", "at": "2026-10-06T06:55:46.657Z", "resultSummary": "userName eq adele.vance@contoso.local -> totalResults 1; id <adele.vance>, displayName Adele Vance, active=true" },
    { "call": 2, "seq": 0, "phase": "resolve", "tool": "list_groups", "status": "ok", "at": "2026-10-06T06:55:46.701Z", "resultSummary": "catalog listing, attributes id,displayName -> totalResults 10, no nextCursor; SG-Finance-AP-Approvers -> 1 match id <SG-Finance-AP-Approvers>" },
    { "call": 3, "seq": 0, "phase": "read", "tool": "get_user", "status": "ok", "at": "2026-10-06T06:55:46.657Z", "resultSummary": "department Finance, employeeNumber 100003, manager e8d221da-8c63-45e2-a108-1e0a3f494998, title Accounts Payable Analyst, active=true; CustomSecurityAttributes object in this result ignored" },
    { "call": 4, "seq": 0, "phase": "read", "tool": "get_user_custom_security_attributes", "status": "ok", "at": "2026-10-06T06:55:46.657Z", "resultSummary": "attributeSets Employment, Compliance -> ContractType=Employee, CostCenter=FIN-100, DataClassification=Confidential, LegalHold=false" },
    { "call": 5, "seq": 0, "phase": "read", "tool": "list_groups", "status": "ok", "at": "2026-10-06T06:55:46.688Z", "resultSummary": "members.value eq <adele.vance> -> totalResults 3: All Employees <All Employees>, SG-Finance-Users <SG-Finance-Users>, SG-Finance-AP-Requestors <SG-Finance-AP-Requestors>" }
  ],
  "skippedActions": [
    { "seq": null, "tool": "add_group_members", "target": "adele.vance@contoso.local", "group": "SG-Finance-AP-Approvers", "reason": "denied by SOD-FIN-001: the user already holds SG-Finance-AP-Requestors (call #5); a deny is never overridden by an approval, so REQ-50017 was not used", "reasonCode": "sod_conflict" }
  ],
  "verificationFindings": {
    "proved": [],
    "notVerifiable": [
      "nested or transitive group access (SoD was evaluated on direct memberships only)",
      "application role assignments"
    ]
  },
  "residualRisk": [
    { "id": "RR-01", "description": "SG-Finance-AP-Approvers was requested for a user who holds SG-Finance-AP-Requestors. If the intent is a requestor-to-approver move, the record must remove SG-Finance-AP-Requestors in the same run; otherwise the request should be withdrawn.", "severity": "low", "owner": "finance-systems", "dueBy": null },
    { "id": "RR-02", "description": "SOD-FIN-001 was evaluated on direct group memberships. Transitive membership and application role assignments are not visible on the SCIM read surface.", "severity": "low", "owner": "identity-ops", "dueBy": null }
  ],
  "toolCalls": { "count": 5, "budget": 20, "byTool": { "list_users": 1, "list_groups": 2, "get_user": 1, "get_user_custom_security_attributes": 1 } },
  "nextSteps": [
    "finance-systems: confirm whether Adele Vance is moving from AP requestor to AP approver. If yes, resubmit WD-000103 with requestedGroups.remove [SG-Finance-AP-Requestors] and requestedGroups.add [SG-Finance-AP-Approvers]; SOD-FIN-001 is evaluated on the resulting set, so the removal clears the conflict.",
    "Approval REQ-50017 (scope group:SG-Finance-AP-Approvers, sourceRecordId WD-000103) is valid and reusable on that re-run. SG-Finance-AP-Approvers is medium risk, so the re-run will also require operator confirmation with the new correlationId.",
    "Re-run mover-orchestrator; it resolves all ids afresh and sets supersedes=elg-WD-000103-k3m9xq."
  ],
  "summary": "Nothing changed for Adele Vance (id <adele.vance>): no attribute, Custom Security Attribute or group membership was written. Workday mover record WD-000103 asked only for the addition of SG-Finance-AP-Approvers, backed by approval REQ-50017. Separation-of-duties rule SOD-FIN-001 denied that addition because the resulting membership set would hold both SG-Finance-AP-Requestors, which she already holds per call #5, and SG-Finance-AP-Approvers, and a deny is never overridden by an approval, so REQ-50017 was valid but unused. Her existing memberships All Employees, SG-Finance-Users and SG-Finance-AP-Requestors, her department Finance, her manager and her cost centre FIN-100 are unchanged. finance-systems must decide whether this is a requestor-to-approver move and, if so, resubmit the record with SG-Finance-AP-Requestors in requestedGroups.remove.",
  "details": {
    "signalsFired": ["RS-01 (group.riskLevel medium)", "RS-03 (sod.ruleFired high)"],
    "groupResults": [
      { "displayName": "SG-Finance-AP-Approvers", "id": "<SG-Finance-AP-Approvers>", "result": "deny", "reasonCodes": ["sod_conflict"], "ruleIds": ["SOD-FIN-001"], "approvalScopeNeeded": null }
    ],
    "before": {
      "attributes": { "department": "Finance", "employeeNumber": "100003", "manager": "e8d221da-8c63-45e2-a108-1e0a3f494998", "title": "Accounts Payable Analyst", "active": true },
      "customSecurityAttributes": { "Employment": { "ContractType": "Employee", "CostCenter": "FIN-100" }, "Compliance": { "DataClassification": "Confidential", "LegalHold": false } },
      "memberships": ["All Employees", "SG-Finance-Users", "SG-Finance-AP-Requestors"]
    },
    "after": {
      "attributes": { "department": "Finance", "employeeNumber": "100003", "manager": "e8d221da-8c63-45e2-a108-1e0a3f494998", "title": "Accounts Payable Analyst", "active": true },
      "customSecurityAttributes": { "Employment": { "ContractType": "Employee", "CostCenter": "FIN-100" }, "Compliance": { "DataClassification": "Confidential", "LegalHold": false } },
      "memberships": ["All Employees", "SG-Finance-Users", "SG-Finance-AP-Requestors"]
    }
  }
}
```

_Turn 1: 15 model turns, 213 s, cost US$2.17, 5 MCP call(s)._

## Mock state

- Before: as expected
- After: as expected

## Assertions

| Check | Result | Detail |
|---|---|---|
| record present | pass |  |
| decision = deny | pass | deny |
| outcome = blocked | pass | blocked |
| riskLevel = high | pass | high |
| skill = mover-orchestrator | pass | mover-orchestrator |
| host = claude-code | pass | claude-code |
| dryRun = false | pass | false |
| correlationId format | pass | elg-WD-000103-k3m9xq |
| toolCalls.count within 5±1 | pass | 5 |
| toolCalls.budget = 20 | pass | 20 |
| sum(byTool) = count | pass | 5 vs 5 |
| executedActions.length = count | pass | 5 vs 5 |
| no password key in record | pass |  |
| schema valid | pass |  |
| observed MCP calls = record count | pass | 5 observed vs 5 |
| Tool calls line matches record | pass | 5 of 20 |
| no permission denials | pass |  |
| no dryRun results | pass |  |
| no discovery tools | pass |  |
| no group create/update/delete | pass |  |
| every list_users has a filter | pass |  |
| result events succeeded | pass | success |
| model pinned (claude-fable-5-1) | pass |  |
| turn 1 calls = 5 (soft) | pass | 5 |
| no writes | pass |  |
