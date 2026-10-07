# S3b — Mover transfer: a CSA change strips an entitlement

| | |
|---|---|
| Skill | `mover-orchestrator` |
| Record | `demo/source-records/S3b-lidia-holloway-transfer.json` |
| Model | claude-fable-5-1 (effort xhigh) |
| Claude Code | 2.1.268 |
| entra-scim-mcp | 0.3.0 (mock, boot 2) |
| Policy | contoso-lifecycle-policy v1.2.0 |
| Recorded | 2026-10-06T06:59:26Z |
| Session | `3f6d6b10-e3dd-483e-aae1-b020c7b88626` |

Object ids are rendered as `<userName>` or `<displayName>` for readability; the raw ids are in the gitignored stream files and in `demo/expected/`. The generated password is redacted everywhere.

## Turn 1 — operator

```text
/mover-orchestrator
Process this transfer.

{
  "sourceSystem": "workday",
  "sourceRecordId": "WD-000104",
  "eventType": "mover",
  "effectiveDate": "2026-09-22",
  "target": { "userName": "lidia.holloway@contoso.local" },
  "changes": {
    "worker": {
      "department": "Engineering",
      "managerUserName": "megan.bowen@contoso.local",
      "jobTitle": "Platform Analyst"
    },
    "customSecurityAttributes": {
      "Employment": { "CostCenter": "ENG-210" }
    }
  },
  "previous": {
    "worker": { "department": "Finance" }
  },
  "requestedGroups": {
    "add": [],
    "remove": ["SG-Finance-AP-Requestors"]
  },
  "approvals": [
    {
      "ref": "REQ-50018",
      "scope": "run",
      "approver": "megan.bowen@contoso.local",
      "sourceRecordId": "WD-000104",
      "grantedAt": "2026-09-20T01:00:00Z"
    }
  ]
}
```

## Turn 1 — assistant

Processing the WD-000104 mover for lidia.holloway. Loading the shared policy first, then the mover tool-sequence reference and the SCIM tool schemas.

> (Read .claude/skills/entra-lifecycle-policy/policy/lifecycle-policy.json)

> (Read .claude/skills/mover-orchestrator/references/tool-sequences.md)

> (ToolSearch )

> #1 list_users {filter: [{attr: "userName",op: "eq",value: "lidia.holloway@contoso.local"}],attributes: ["id","userName","displayName","active"]} → ok, totalResults 1

> #2 list_users {filter: [{attr: "userName",op: "eq",value: "megan.bowen@contoso.local"}],attributes: ["id","userName","displayName","active"]} → ok, totalResults 1

Both resolved uniquely (calls 1 and 2). Reading current attributes, CSAs, memberships and the group catalog in one batch (calls 3 to 6).

> #3 get_user {id: "<lidia.holloway>"} → ok, id <lidia.holloway>, active true

> #4 get_user_custom_security_attributes {id: "<lidia.holloway>",attributeSets: ["Employment","Compliance"]} → ok, id <lidia.holloway>

> #5 list_groups {filter: [{attr: "members.value",op: "eq",value: "<lidia.holloway>"}],attributes: ["id","displayName"]} → ok, totalResults 4

> #6 list_groups {attributes: ["id","displayName"]} → ok, totalResults 10

> (Read .claude/skills/entitlement-guardrail/SKILL.md)

> (Read .claude/skills/identity-change-auditor/SKILL.md)

> (Read .claude/skills/identity-change-auditor/references/record-template.md)

> (Read .claude/skills/entra-lifecycle-policy/policy/decision-record.schema.json)

The preview is ready. No writes have been made. The run is medium risk, so it needs your explicit confirmation before anything is applied.

### Policy checks — contoso-lifecycle-policy v1.2.0 — elg-WD-000104-k7m2qx

| # | Check | Policy ref | Input (normalised) | Evidence | Result |
|---|---|---|---|---|---|
| CHK-01 | Policy loaded | policyVersion | contoso-lifecycle-policy 1.2.0 (major 1) | skill file | pass |
| CHK-02 | Authoritative source, record id, event | authoritativeSources[workday] | workday / WD-000104 / mover | source record | pass |
| CHK-03 | Target resolves to exactly one user | approvalThresholds.escalations.ambiguousIdentity | lidia.holloway@contoso.local | call #1: 1 result, active=true, id <lidia.holloway> | pass |
| CHK-04 | New manager resolves to exactly one user | requiredJoinerAttributes.core[REQ-07], managerMustResolve | megan.bowen@contoso.local | call #2: 1 result, active=true, id <megan.bowen> | pass |
| CHK-05 | Department in allowed list | requiredJoinerAttributes.core[REQ-05] | Engineering | source record | pass |
| CHK-06 | CSA Employment.CostCenter pattern and set | requiredJoinerAttributes.customSecurityAttributes[REQ-CSA-02], customSecurityAttributes.attributeSets | ENG-210 | source record | pass |
| CHK-07 | previous.worker agrees with tenant | moverRules.compareToPreviousWhenPresent | previous.department=Finance; tenant=Finance | call #3 | pass |
| CHK-08 | Requested removal in catalog and held | groupCatalog[SG-Finance-AP-Requestors], requestedGroups.remove | SG-Finance-AP-Requestors | policy; call #5 held, id <SG-Finance-AP-Requestors> | pass |
| CHK-09 | Old department group removal | moverRules.removeOldDepartmentGroups, approvedBaselineProfiles.profiles.Employee.departmentGroups[Finance] | SG-Finance-Users | call #4 ContractType=Employee; call #5 held, id <SG-Finance-Users> | pass |
| CHK-10 | Held group CSA gate re-evaluated | groupCatalog[SG-Finance-Treasury-Payments].requiresCsa, moverRules.reevaluateHeldGroupCsaGates | CostCenter startsWith FIN- vs effective ENG-210 | call #4 current FIN-110; source record ENG-210; call #5 held, id <SG-Finance-Treasury-Payments> | warn → remove (csa_condition_failed) |
| CHK-11 | New department group in catalog, resolves to one id, not already held | approvedBaselineProfiles.profiles.Employee.departmentGroups[Engineering], costThresholds.groupResolution | SG-Engineering-Users | call #6: 10 groups, 1 match id <SG-Engineering-Users>; call #5 not held | pass |
| CHK-12 | Privileged group in plan | privilegedGroups | add: SG-Engineering-Users (business) | policy | pass |
| CHK-13 | SoD on resulting set | sodRules[SOD-FIN-001, SOD-FIN-002, SOD-ADM-001], sodEvaluation | resulting set {All Employees, SG-Engineering-Users} | call #5 − 3 removals + 1 add | pass |
| CHK-14 | Uncatalogued held groups left untouched | moverRules.leaveUncataloguedGroupsUntouched | none held | call #5 | pass |
| CHK-15 | Risk signals | riskModel.signals[RS-05, RS-06, RS-07, RS-01] | department changed; manager changed; CSA changed; add riskLevel low | calls #3, #4 vs source record | medium |
| CHK-16 | Approval ref valid for scope | approvalThresholds.approvalRef, decisionByRiskLevel[medium] | REQ-50018 scope run, approver megan.bowen@contoso.local, WD-000104 | source record | pass |
| CHK-17 | Operator confirmation | approvalThresholds.operatorConfirmRequired[medium] | required, not yet given | this turn | needs_approval → allow_with_approval (operator_confirmation_missing) |
| CHK-18 | Cost estimate within budget | costThresholds.maxToolCallsPerRun.mover-orchestrator, warnAtPercent | 15 of 20 (75%) | plan | pass |
| — | Aggregate | evaluation.decisionPrecedence | max risk = medium | rows above | decision = allow_with_approval |

## Execution preview — mover — elg-WD-000104-k7m2qx

Policy contoso-lifecycle-policy v1.2.0 | Decision: allow_with_approval | Risk: medium | Est. tool calls: 15 of 20 (6 reads made, 9 to go)

Before → after:
- department Finance → Engineering
- manager e8d221da-8c63-45e2-a108-1e0a3f494998 → <megan.bowen> (Megan Bowen)
- title Treasury Analyst → Platform Analyst
- Employment.CostCenter FIN-110 → ENG-210
- memberships [All Employees, SG-Finance-Users, SG-Finance-AP-Requestors, SG-Finance-Treasury-Payments] → [All Employees, SG-Engineering-Users]

| # | Tool | Key arguments (ids resolved this run) | Purpose | Policy basis |
|---|---|---|---|---|
| 1 | update_user | id=<lidia.holloway>; replace enterprise department=Engineering; replace enterprise manager {value: <megan.bowen>}; replace title=Platform Analyst (one atomic PATCH) | attributes | moverRules.sequence[attributes] |
| 2 | update_user_custom_security_attributes | id=<lidia.holloway>; replace Employment.CostCenter=ENG-210 | CSA | moverRules.sequence[customSecurityAttributes] |
| 3 | remove_group_member | id=<SG-Finance-AP-Requestors> (SG-Finance-AP-Requestors), memberId=<lidia.holloway> | requested removal | requestedGroups.remove |
| 4 | remove_group_member | id=<SG-Finance-Users> (SG-Finance-Users), memberId=<lidia.holloway> | old department group | moverRules.removeOldDepartmentGroups |
| 5 | remove_group_member | id=<SG-Finance-Treasury-Payments> (SG-Finance-Treasury-Payments), memberId=<lidia.holloway> | CSA gate no longer holds (CostCenter must start with FIN-) | moverRules.reevaluateHeldGroupCsaGates |
| 6 | add_group_members | id=<SG-Engineering-Users> (SG-Engineering-Users), memberIds=[<lidia.holloway>] | new department group | approvedBaselineProfiles.profiles.Employee.departmentGroups[Engineering] |
| 7 | get_user | id=<lidia.holloway> | verify attributes, active unchanged | auditRequirements.verificationRequiredBeforeCompleted |
| 8 | get_user_custom_security_attributes | id=<lidia.holloway>; attributeSets=[Employment, Compliance] | verify CSA | auditRequirements.verificationRequiredBeforeCompleted |
| 9 | list_groups | members.value eq <lidia.holloway> | verify memberships equal [All Employees, SG-Engineering-Users] | auditRequirements.verificationRequiredBeforeCompleted |

Not touched: All Employees (baseline, never removed or re-added by a mover), userName, mailNickname, active.

Approvals: REQ-50018 scope run → valid

Gate: operator confirmation required: reply exactly `approve elg-WD-000104-k7m2qx`

Nothing has been written. Tool calls so far: 6 of 20 (6 reads, 0 writes). On confirmation I will run steps 1 to 9 in that order, stop on the first error, and then hand the evidence to the auditor for the decision record.

_Turn 1: 14 model turns, 158 s, cost US$1.92, 6 MCP call(s)._

## Turn 2 — operator

```text
approve elg-WD-000104-k7m2qx
```

## Turn 2 — assistant

Confirmation received and matches the correlation ID exactly. Executing in policy order, starting with the atomic attribute PATCH (call 7).

> #7 update_user {id: "<lidia.holloway>",operations: [{op: "replace",path: "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department",value: "Engineering"},{op: "replace",path: "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:manager",value: {value: ... → ok, id <lidia.holloway>

Call 7 landed. Now the CSA write (call 8).

> #8 update_user_custom_security_attributes {id: "<lidia.holloway>",operations: [{op: "replace",path: "urn:ietf:params:scim:schemas:extension:Microsoft:Entra:2.0:CustomSecurityAttributes:Employment.CostCenter",value: "ENG-210"}]} → ok, id <lidia.holloway>

Call 8 landed. The three removals are independent of each other, so issuing calls 9, 10 and 11 together, one group per call.

> #9 remove_group_member {id: "<SG-Finance-AP-Requestors>",memberId: "<lidia.holloway>"} → ok, id <SG-Finance-AP-Requestors>

> #10 remove_group_member {id: "<SG-Finance-Users>",memberId: "<lidia.holloway>"} → ok, id <SG-Finance-Users>

> #11 remove_group_member {id: "<SG-Finance-Treasury-Payments>",memberId: "<lidia.holloway>"} → ok, id <SG-Finance-Treasury-Payments>

All three removals landed. Now the addition (call 12).

> #12 add_group_members {id: "<SG-Engineering-Users>",memberIds: ["<lidia.holloway>"]} → ok, id <SG-Engineering-Users>, patchCalls 1

All six writes succeeded with no dry-run markers. Verifying all three changed dimensions in one batch (calls 13 to 15).

> #13 get_user {id: "<lidia.holloway>"} → ok, id <lidia.holloway>, active true

> #14 get_user_custom_security_attributes {id: "<lidia.holloway>",attributeSets: ["Employment","Compliance"]} → ok, id <lidia.holloway>

> #15 list_groups {filter: [{attr: "members.value",op: "eq",value: "<lidia.holloway>"}],attributes: ["id","displayName"]} → ok, totalResults 2

> (Grep )

> (Read .claude/skills/entra-lifecycle-policy/policy/decision-record.example.json)

Lidia Holloway's transfer is complete and verified. Every planned write landed, all three verification reads match the plan, and the run finished at 15 of 20 tool calls.

**What changed.** User <lidia.holloway> moved from Finance to Engineering: department, manager (now Megan Bowen, <megan.bowen>), title Platform Analyst and Employment.CostCenter ENG-210 were written, three Finance groups were removed and SG-Engineering-Users was added.

**Why.** The change came from Workday mover record WD-000104, effective 2026-09-22.

**Which policy rows.** Signals RS-05, RS-06 and RS-07 made the run medium risk, so approval REQ-50018 (scope run) plus your confirmation were required and both were valid. SG-Finance-Users was removed under moverRules.removeOldDepartmentGroups, SG-Finance-AP-Requestors at the record's request, and SG-Finance-Treasury-Payments because its CostCenter gate (must start with FIN-) no longer holds against ENG-210 (CHK-10, csa_condition_failed). No SoD rule fired on the resulting set and no privileged group was involved.

**What did not change.** All Employees (baseline), userName, mailNickname, active, ContractType and both Compliance attributes were left untouched. Nothing was skipped or denied.

**What remains for a human.** Treasury should confirm the automatic removal from SG-Finance-Treasury-Payments and reassign any open payment-release duties. Existing sign-in sessions may carry the old Finance group claims until they expire; the SCIM surface cannot revoke or observe them.

Tool calls: 15 of 20 (9 reads, 6 writes)

```json
{
  "recordVersion": "1.0",
  "correlationId": "elg-WD-000104-k7m2qx",
  "supersedes": null,
  "skill": "mover-orchestrator",
  "skillVersion": "0.2.0",
  "policyId": "contoso-lifecycle-policy",
  "policyVersion": "1.2.0",
  "event": "mover",
  "host": "claude-code",
  "dryRun": false,
  "startedAt": "2026-10-06T06:55:46.437Z",
  "completedAt": "2026-10-06T07:02:42.115Z",
  "clockSource": "resourceMeta",
  "source": { "system": "workday", "recordId": "WD-000104" },
  "target": { "userName": "lidia.holloway@contoso.local", "id": "<lidia.holloway>", "displayName": "Lidia Holloway" },
  "decision": "allow_with_approval",
  "outcome": "completed",
  "riskLevel": "medium",
  "policyChecks": [
    { "id": "CHK-01", "rule": "policyVersion", "input": "contoso-lifecycle-policy 1.2.0 (major 1)", "evidence": "entra-lifecycle-policy skill, policy/lifecycle-policy.json", "result": "pass" },
    { "id": "CHK-02", "rule": "authoritativeSources[id=workday]", "input": "sourceSystem=workday; sourceRecordId=WD-000104; eventType=mover", "evidence": "source record: id matches ^WD-[0-9]{6}$; mover in events", "result": "pass" },
    { "id": "CHK-03", "rule": "approvalThresholds.escalations.ambiguousIdentity", "subject": "target.userName", "input": "lidia.holloway@contoso.local", "evidence": "call #1: list_users userName eq lidia.holloway@contoso.local -> totalResults=1, active=true, id <lidia.holloway>", "result": "pass" },
    { "id": "CHK-04", "rule": "requiredJoinerAttributes.core[REQ-07]", "subject": "changes.worker.managerUserName", "input": "megan.bowen@contoso.local", "evidence": "source record: matches ^[^@\\s]+@contoso\\.local$; call #2: list_users -> totalResults=1, active=true, id <megan.bowen>", "result": "pass" },
    { "id": "CHK-05", "rule": "requiredJoinerAttributes.core[REQ-05]", "subject": "changes.worker.department", "input": "Engineering", "evidence": "source record: in [Finance, Engineering, Operations, Human Resources]", "result": "pass" },
    { "id": "CHK-06", "rule": "requiredJoinerAttributes.customSecurityAttributes[REQ-CSA-02]", "subject": "csa.requested.Employment.CostCenter", "input": "ENG-210", "evidence": "source record: matches ^(FIN|ENG|OPS|HR)-[0-9]{3}$; set Employment in customSecurityAttributes.attributeSets", "result": "pass" },
    { "id": "CHK-07", "rule": "moverRules.compareToPreviousWhenPresent", "subject": "previous.worker.department", "input": "Finance", "evidence": "call #3: get_user enterprise department=Finance; equals previous", "result": "pass" },
    { "id": "CHK-08", "rule": "groupCatalog[SG-Finance-AP-Requestors]", "subject": "SG-Finance-AP-Requestors", "input": "requestedGroups.remove", "evidence": "policy: in catalog (business/low); call #5: held, id <SG-Finance-AP-Requestors>", "result": "pass" },
    { "id": "CHK-09", "rule": "moverRules.removeOldDepartmentGroups", "subject": "SG-Finance-Users", "input": "approvedBaselineProfiles.profiles.Employee.departmentGroups.Finance", "evidence": "call #4: Employment.ContractType=Employee; call #5: held, id <SG-Finance-Users>", "result": "pass" },
    { "id": "CHK-10", "rule": "groupCatalog[SG-Finance-Treasury-Payments].requiresCsa", "subject": "csa.effective.Employment.CostCenter", "input": "ENG-210", "evidence": "call #4: current FIN-110; source record requested ENG-210; startsWith FIN- is false; call #5: held, id <SG-Finance-Treasury-Payments>; moverRules.reevaluateHeldGroupCsaGates=true -> removed", "result": "warn", "reasonCode": "csa_condition_failed" },
    { "id": "CHK-11", "rule": "approvedBaselineProfiles.profiles.Employee.departmentGroups.Engineering", "subject": "SG-Engineering-Users", "input": "add", "evidence": "policy: in catalog (business/low, no requiresCsa, approvalRequired=false); call #6: list_groups unfiltered -> 10 groups, 1 match id <SG-Engineering-Users>; call #5: not currently held", "result": "pass" },
    { "id": "CHK-12", "rule": "privilegedGroups", "input": "add: SG-Engineering-Users (classification business)", "evidence": "policy: not in privilegedGroups.displayNames, not classification privileged", "result": "pass" },
    { "id": "CHK-13", "rule": "sodRules", "input": "resulting set = {All Employees, SG-Engineering-Users}", "evidence": "call #5 minus 3 removals plus 1 add; SOD-FIN-001, SOD-FIN-002, SOD-ADM-001 each have 0 members in resulting set", "result": "pass" },
    { "id": "CHK-14", "rule": "moverRules.leaveUncataloguedGroupsUntouched", "input": "(none held)", "evidence": "call #5: all 4 held groups are in groupCatalog", "result": "pass" },
    { "id": "CHK-15", "rule": "riskModel.signals[RS-05,RS-06,RS-07,RS-01]", "input": "department changed; manager changed; CSA changed; add riskLevel low", "evidence": "call #3 and call #4 vs source record; riskModel.aggregate=max -> medium; approvalThresholds.decisionByRiskLevel.medium=allow_with_approval", "result": "needs_approval", "reasonCode": "approval_required" },
    { "id": "CHK-16", "rule": "approvalThresholds.approvalRef", "subject": "REQ-50018", "input": "scope run; approver megan.bowen@contoso.local; sourceRecordId WD-000104", "evidence": "source record approvals[0]: matches ^(CHG|REQ|INC)-[0-9]{5,}$, all requiredFields present, sourceRecordId matches, scope run in approvalScopes", "result": "pass" },
    { "id": "CHK-17", "rule": "approvalThresholds.operatorConfirmRequired.medium", "input": "approve elg-WD-000104-k7m2qx", "evidence": "operator message after preview matched operatorConfirmPhrase exactly", "result": "pass" },
    { "id": "CHK-18", "rule": "costThresholds.maxToolCallsPerRun.mover-orchestrator", "input": "15 of 20 (75%)", "evidence": "calls #1-#15; below warnAtPercent 80", "result": "pass" },
    { "id": "CHK-19", "rule": "evaluation.decisionPrecedence", "input": "allow_with_approval (CHK-15); max risk = medium", "evidence": "worst result across rows above; approval and confirmation satisfied in CHK-16 and CHK-17", "result": "needs_approval", "reasonCode": "approval_required" }
  ],
  "approvals": [
    { "ref": "REQ-50018", "scope": "run", "approver": "megan.bowen@contoso.local", "sourceRecordId": "WD-000104", "grantedAt": "2026-09-20T01:00:00Z", "valid": true, "used": true }
  ],
  "plannedActions": [
    { "seq": 1, "tool": "update_user", "target": "lidia.holloway@contoso.local", "argsSummary": "id=<lidia.holloway>; replace enterprise department=Engineering; replace enterprise manager {value: <megan.bowen>}; replace title=Platform Analyst (one PATCH)", "purpose": "attributes", "policyBasis": ["moverRules.sequence[attributes]"], "status": "executed" },
    { "seq": 2, "tool": "update_user_custom_security_attributes", "target": "lidia.holloway@contoso.local", "argsSummary": "id=<lidia.holloway>; replace Employment.CostCenter=ENG-210", "purpose": "CSA", "policyBasis": ["moverRules.sequence[customSecurityAttributes]", "requiredJoinerAttributes.customSecurityAttributes[REQ-CSA-02]"], "status": "executed" },
    { "seq": 3, "tool": "remove_group_member", "target": "SG-Finance-AP-Requestors", "argsSummary": "id=<SG-Finance-AP-Requestors>; memberId=<lidia.holloway>", "purpose": "requested removal", "policyBasis": ["requestedGroups.remove", "moverRules.sequence[groupRemoves]"], "status": "executed" },
    { "seq": 4, "tool": "remove_group_member", "target": "SG-Finance-Users", "argsSummary": "id=<SG-Finance-Users>; memberId=<lidia.holloway>", "purpose": "old department group", "policyBasis": ["moverRules.removeOldDepartmentGroups", "approvedBaselineProfiles.profiles.Employee.departmentGroups.Finance"], "status": "executed" },
    { "seq": 5, "tool": "remove_group_member", "target": "SG-Finance-Treasury-Payments", "argsSummary": "id=<SG-Finance-Treasury-Payments>; memberId=<lidia.holloway>", "purpose": "CSA gate no longer holds", "policyBasis": ["moverRules.reevaluateHeldGroupCsaGates", "groupCatalog[SG-Finance-Treasury-Payments].requiresCsa"], "status": "executed" },
    { "seq": 6, "tool": "add_group_members", "target": "SG-Engineering-Users", "argsSummary": "id=<SG-Engineering-Users>; memberIds=[<lidia.holloway>]", "purpose": "new department group", "policyBasis": ["approvedBaselineProfiles.profiles.Employee.departmentGroups.Engineering", "moverRules.sequence[groupAdds]"], "status": "executed" },
    { "seq": 7, "tool": "get_user", "target": "lidia.holloway@contoso.local", "argsSummary": "id=<lidia.holloway>", "purpose": "verify attributes, active unchanged", "policyBasis": ["auditRequirements.verificationRequiredBeforeCompleted"], "status": "executed" },
    { "seq": 8, "tool": "get_user_custom_security_attributes", "target": "lidia.holloway@contoso.local", "argsSummary": "id=<lidia.holloway>; attributeSets=[Employment, Compliance]", "purpose": "verify CSA", "policyBasis": ["auditRequirements.verificationRequiredBeforeCompleted"], "status": "executed" },
    { "seq": 9, "tool": "list_groups", "target": "lidia.holloway@contoso.local", "argsSummary": "filter members.value eq <lidia.holloway>; attributes id,displayName", "purpose": "verify memberships", "policyBasis": ["auditRequirements.verificationRequiredBeforeCompleted"], "status": "executed" }
  ],
  "executedActions": [
    { "call": 1, "seq": 0, "phase": "resolve", "tool": "list_users", "status": "ok", "at": "2026-10-06T06:55:46.661Z", "resultSummary": "userName eq lidia.holloway@contoso.local -> totalResults=1; id <lidia.holloway>; active=true" },
    { "call": 2, "seq": 0, "phase": "resolve", "tool": "list_users", "status": "ok", "at": "2026-10-06T06:55:46.437Z", "resultSummary": "userName eq megan.bowen@contoso.local -> totalResults=1; id <megan.bowen>; active=true" },
    { "call": 3, "seq": 0, "phase": "read", "tool": "get_user", "status": "ok", "at": "2026-10-06T06:55:46.661Z", "resultSummary": "department=Finance; employeeNumber=100004; manager=e8d221da-8c63-45e2-a108-1e0a3f494998; title=Treasury Analyst; active=true; CSA object in payload ignored" },
    { "call": 4, "seq": 0, "phase": "read", "tool": "get_user_custom_security_attributes", "status": "ok", "at": "2026-10-06T06:55:46.661Z", "resultSummary": "Employment{ContractType=Employee, CostCenter=FIN-110}; Compliance{DataClassification=Confidential, LegalHold=false}" },
    { "call": 5, "seq": 0, "phase": "read", "tool": "list_groups", "status": "ok", "at": "2026-10-06T06:55:46.694Z", "resultSummary": "members.value eq <lidia.holloway> -> totalResults=4: All Employees <All Employees>, SG-Finance-Users <SG-Finance-Users>, SG-Finance-AP-Requestors <SG-Finance-AP-Requestors>, SG-Finance-Treasury-Payments <SG-Finance-Treasury-Payments>" },
    { "call": 6, "seq": 0, "phase": "read", "tool": "list_groups", "status": "ok", "at": "2026-10-06T06:55:46.701Z", "resultSummary": "unfiltered catalog -> totalResults=10, no nextCursor; SG-Engineering-Users -> 1 match <SG-Engineering-Users>" },
    { "call": 7, "seq": 1, "phase": "execute", "tool": "update_user", "status": "ok", "at": null, "resultSummary": "ok=true; id <lidia.holloway>; 3 replace ops (department, manager, title) in one PATCH" },
    { "call": 8, "seq": 2, "phase": "execute", "tool": "update_user_custom_security_attributes", "status": "ok", "at": null, "resultSummary": "ok=true; id <lidia.holloway>; 1 replace op Employment.CostCenter=ENG-210" },
    { "call": 9, "seq": 3, "phase": "execute", "tool": "remove_group_member", "status": "ok", "at": null, "resultSummary": "ok=true; group <SG-Finance-AP-Requestors> (SG-Finance-AP-Requestors); memberId <lidia.holloway>" },
    { "call": 10, "seq": 4, "phase": "execute", "tool": "remove_group_member", "status": "ok", "at": null, "resultSummary": "ok=true; group <SG-Finance-Users> (SG-Finance-Users); memberId <lidia.holloway>" },
    { "call": 11, "seq": 5, "phase": "execute", "tool": "remove_group_member", "status": "ok", "at": null, "resultSummary": "ok=true; group <SG-Finance-Treasury-Payments> (SG-Finance-Treasury-Payments); memberId <lidia.holloway>" },
    { "call": 12, "seq": 6, "phase": "execute", "tool": "add_group_members", "status": "ok", "at": null, "resultSummary": "ok=true; group <SG-Engineering-Users> (SG-Engineering-Users); memberIds=[<lidia.holloway>]; patchCalls=1" },
    { "call": 13, "seq": 7, "phase": "verify", "tool": "get_user", "status": "ok", "at": "2026-10-06T07:02:32.191Z", "resultSummary": "department=Engineering; manager=<megan.bowen>; title=Platform Analyst; active=true; employeeNumber=100004; userName and mailNickname unchanged" },
    { "call": 14, "seq": 8, "phase": "verify", "tool": "get_user_custom_security_attributes", "status": "ok", "at": "2026-10-06T07:02:32.191Z", "resultSummary": "Employment{ContractType=Employee, CostCenter=ENG-210}; Compliance{DataClassification=Confidential, LegalHold=false}" },
    { "call": 15, "seq": 9, "phase": "verify", "tool": "list_groups", "status": "ok", "at": "2026-10-06T07:02:42.115Z", "resultSummary": "members.value eq <lidia.holloway> -> totalResults=2: All Employees <All Employees>, SG-Engineering-Users <SG-Engineering-Users>" }
  ],
  "skippedActions": [],
  "verificationFindings": {
    "proved": [
      { "check": "attributes equal planned after-values and active unchanged", "tool": "get_user", "expected": "department=Engineering; manager=<megan.bowen>; title=Platform Analyst; active=true", "observed": "department=Engineering; manager=<megan.bowen>; title=Platform Analyst; active=true (call #13)", "result": "pass" },
      { "check": "Employment.CostCenter equals planned value; other CSAs unchanged", "tool": "get_user_custom_security_attributes", "expected": "Employment.CostCenter=ENG-210; ContractType=Employee; Compliance unchanged", "observed": "Employment{ContractType=Employee, CostCenter=ENG-210}; Compliance{DataClassification=Confidential, LegalHold=false} (call #14)", "result": "pass" },
      { "check": "memberships equal (current - removals) + additions", "tool": "list_groups", "expected": "[All Employees, SG-Engineering-Users]", "observed": "[All Employees, SG-Engineering-Users] (call #15)", "result": "pass" }
    ],
    "notVerifiable": [
      "sign-in sessions and tokens",
      "nested or transitive group access",
      "application role assignments",
      "PIM eligibility",
      "licence assignment"
    ]
  },
  "residualRisk": [
    { "id": "RR-01", "description": "SG-Finance-Treasury-Payments was removed automatically because the CostCenter gate no longer holds. Treasury should confirm no open payment-release duties remain assigned to Lidia Holloway.", "severity": "low", "owner": "treasury", "dueBy": null },
    { "id": "RR-02", "description": "Existing sign-in sessions and tokens may carry the removed Finance group claims until they expire; the SCIM surface cannot revoke or observe them.", "severity": "low", "owner": "identity-ops", "dueBy": null }
  ],
  "toolCalls": {
    "count": 15,
    "budget": 20,
    "byTool": { "list_users": 2, "get_user": 2, "get_user_custom_security_attributes": 2, "list_groups": 3, "update_user": 1, "update_user_custom_security_attributes": 1, "remove_group_member": 3, "add_group_members": 1 }
  },
  "nextSteps": [
    "Treasury (owner of SG-Finance-Treasury-Payments): confirm the removal is expected and reassign any open payment-release duties.",
    "Identity-ops: revoke Lidia Holloway's sessions only if Finance access must end before current tokens expire; otherwise no action.",
    "No corrective Workday record is needed; WD-000104 is fully applied."
  ],
  "summary": "Lidia Holloway (<lidia.holloway>) moved from Finance to Engineering: department, manager (Megan Bowen, <megan.bowen>), title Platform Analyst and Employment.CostCenter ENG-210 were written, SG-Finance-AP-Requestors, SG-Finance-Users and SG-Finance-Treasury-Payments were removed, and SG-Engineering-Users was added. The change came from Workday mover record WD-000104, effective 2026-09-22. Signals RS-05, RS-06 and RS-07 made the run medium risk, so approval REQ-50018 (scope run) and operator confirmation were required and given; SG-Finance-Users was removed under moverRules.removeOldDepartmentGroups, SG-Finance-AP-Requestors at the record's request, and SG-Finance-Treasury-Payments because its CostCenter gate (startsWith FIN-) failed against ENG-210 (CHK-10). All Employees, userName, mailNickname, active, ContractType and the Compliance attributes were left untouched, and no SoD rule fired on the resulting set. Treasury should confirm the automatic removal and reassign any open payment duties; sessions carrying Finance claims expire on their own schedule.",
  "details": {
    "before": {
      "attributes": { "department": "Finance", "title": "Treasury Analyst", "manager": "e8d221da-8c63-45e2-a108-1e0a3f494998", "employeeNumber": "100004", "active": true },
      "customSecurityAttributes": { "Employment": { "ContractType": "Employee", "CostCenter": "FIN-110" }, "Compliance": { "DataClassification": "Confidential", "LegalHold": false } },
      "memberships": ["All Employees", "SG-Finance-Users", "SG-Finance-AP-Requestors", "SG-Finance-Treasury-Payments"]
    },
    "after": {
      "attributes": { "department": "Engineering", "title": "Platform Analyst", "manager": "<megan.bowen>", "employeeNumber": "100004", "active": true },
      "customSecurityAttributes": { "Employment": { "ContractType": "Employee", "CostCenter": "ENG-210" }, "Compliance": { "DataClassification": "Confidential", "LegalHold": false } },
      "memberships": ["All Employees", "SG-Engineering-Users"]
    },
    "groupResults": [
      { "displayName": "SG-Engineering-Users", "id": "<SG-Engineering-Users>", "result": "allow", "reasonCodes": [], "ruleIds": ["RS-01"], "approvalScopeNeeded": null },
      { "displayName": "SG-Finance-AP-Requestors", "id": "<SG-Finance-AP-Requestors>", "result": "allow", "reasonCodes": [], "ruleIds": [], "approvalScopeNeeded": null },
      { "displayName": "SG-Finance-Users", "id": "<SG-Finance-Users>", "result": "allow", "reasonCodes": [], "ruleIds": ["moverRules.removeOldDepartmentGroups"], "approvalScopeNeeded": null },
      { "displayName": "SG-Finance-Treasury-Payments", "id": "<SG-Finance-Treasury-Payments>", "result": "allow", "reasonCodes": ["csa_condition_failed"], "ruleIds": ["groupCatalog[SG-Finance-Treasury-Payments].requiresCsa", "moverRules.reevaluateHeldGroupCsaGates"], "approvalScopeNeeded": null }
    ]
  }
}
```

_Turn 2: 12 model turns, 198 s, cost US$1.43, 9 MCP call(s)._

## Mock state

- Before: as expected
- After: as expected

## Assertions

| Check | Result | Detail |
|---|---|---|
| record present | pass |  |
| decision = allow_with_approval | pass | allow_with_approval |
| outcome = completed | pass | completed |
| riskLevel = medium | pass | medium |
| skill = mover-orchestrator | pass | mover-orchestrator |
| host = claude-code | pass | claude-code |
| dryRun = false | pass | false |
| correlationId format | pass | elg-WD-000104-k7m2qx |
| toolCalls.count within 15±1 | pass | 15 |
| toolCalls.budget = 20 | pass | 20 |
| sum(byTool) = count | pass | 15 vs 15 |
| executedActions.length = count | pass | 15 vs 15 |
| no password key in record | pass |  |
| verificationFindings.proved non-empty, all pass | pass |  |
| schema valid | pass |  |
| observed MCP calls = record count | pass | 15 observed vs 15 |
| Tool calls line matches record | pass | 15 of 20 |
| no permission denials | pass |  |
| no dryRun results | pass |  |
| no discovery tools | pass |  |
| no group create/update/delete | pass |  |
| every list_users has a filter | pass |  |
| result events succeeded | pass | success,success |
| model pinned (claude-fable-5-1) | pass |  |
| turn 1 calls = 6 (soft) | pass | 6 |
| one update_user before any membership change | pass | 1 update_user; index 6 vs 8 |
| no userName/mailNickname in PATCH ops | pass |  |
| three removes before one add | pass | 3 removes, 1 adds |
| SG-Legal-Hold never touched | pass |  |
