# S3c — Mover title change: low risk, straight through

| | |
|---|---|
| Skill | `mover-orchestrator` |
| Record | `demo/source-records/S3c-alex-wilber-title.json` |
| Model | claude-fable-5-1 (effort xhigh) |
| Claude Code | 2.1.268 |
| entra-scim-mcp | 0.3.0 (mock, boot 2) |
| Policy | contoso-lifecycle-policy v1.2.0 |
| Recorded | 2026-10-06T07:05:35Z |
| Session | `6c8488c4-c324-4d83-a11e-461ccde51fb4` |

Object ids are rendered as `<userName>` or `<displayName>` for readability; the raw ids are in the gitignored stream files and in `demo/expected/`. The generated password is redacted everywhere.

## Turn 1 — operator

```text
/mover-orchestrator
Apply this title change.

{
  "sourceSystem": "workday",
  "sourceRecordId": "WD-000108",
  "eventType": "mover",
  "effectiveDate": "2026-09-22",
  "target": { "userName": "alex.wilber@contoso.local" },
  "changes": {
    "worker": { "jobTitle": "Senior Software Engineer" }
  },
  "previous": {
    "worker": { "jobTitle": "Software Engineer" }
  },
  "requestedGroups": { "add": [], "remove": [] },
  "approvals": []
}
```

## Turn 1 — assistant

Running the mover orchestrator for Alex Wilber's title change. Step 0 is loading the shared policy from disk.

> (Read .claude/skills/entra-lifecycle-policy/policy/lifecycle-policy.json)

> (ToolSearch )

> (Read .claude/skills/mover-orchestrator/references/tool-sequences.md)

> (Read .claude/skills/entitlement-guardrail/SKILL.md)

> (Read .claude/skills/identity-change-auditor/SKILL.md)

> (Read .claude/skills/identity-change-auditor/references/record-template.md)

Correlation id for this run: `elg-WD-000108-k7m2qa`. Starting the reads with call #1 (resolve the target) and fetching the record shape and skill version in parallel.

> #1 list_users {filter: [{attr: "userName",op: "eq",value: "alex.wilber@contoso.local"}],attributes: ["id","userName","displayName","active"]} → ok, totalResults 1

> (Read .claude/skills/entra-lifecycle-policy/policy/decision-record.example.json)

> (Read .claude/skills/mover-orchestrator/SKILL.md)

Call #1 resolved exactly one active user. Reading current attributes, CSAs and memberships now (calls #2, #3, #4). No manager change, so no manager lookup, and no additions, so no catalog listing.

> #2 get_user {id: "<alex.wilber>"} → ok, id <alex.wilber>, active true

> #3 get_user_custom_security_attributes {id: "<alex.wilber>",attributeSets: ["Employment","Compliance"]} → ok, id <alex.wilber>

> #4 list_groups {filter: [{attr: "members.value",op: "eq",value: "<alex.wilber>"}],attributes: ["id","displayName"]} → ok, totalResults 2

Diff complete: only `title` changes (Software Engineer → Senior Software Engineer), and the record's `previous` value matches the tenant, so no source conflict. No CSA, department, manager or group change. Both held groups are in the catalog with no CSA gate, so nothing to remove. Guardrail (embedded, zero calls): no requested groups, resulting set {All Employees, SG-Engineering-Users}, no SoD rule fires, no privileged group. Only RS-08 fires → risk low → decision allow, no operator gate.

### Policy checks — contoso-lifecycle-policy v1.2.0 — elg-WD-000108-k7m2qa
| # | Check | Policy ref | Input (normalised) | Evidence | Result |
|---|---|---|---|---|---|
| CHK-01 | Policy loaded | policyVersion | contoso-lifecycle-policy 1.2.0 (major 1) | policy/lifecycle-policy.json | pass |
| CHK-02 | Authoritative source | authoritativeSources[id=workday] | workday; WD-000108 matches ^WD-[0-9]{6}$; mover in events | source record | pass |
| CHK-03 | Target identifier | target.userName | alex.wilber@contoso.local | source record | pass |
| CHK-04 | changes.worker keys known | requiredJoinerAttributes.core | jobTitle only (free text) | source record | pass |
| CHK-05 | Target resolves to exactly one | approvalThresholds.escalations.ambiguousIdentity | 1 match | call #1: id <alex.wilber>, active=true | pass |
| CHK-06 | previous.worker agrees with tenant | moverRules.compareToPreviousWhenPresent | jobTitle previous=Software Engineer; tenant title=Software Engineer | call #2 | pass |
| CHK-07 | Attribute diff | moverRules.sequence[attributes] | title: Software Engineer → Senior Software Engineer | call #2 vs source record | pass |
| CHK-08 | CSA diff | moverRules.sequence[customSecurityAttributes] | none requested; current Employment{Employee, ENG-200} Compliance{Internal, LegalHold=false} | call #3 | pass |
| CHK-09 | Held-group CSA gates still hold | moverRules.reevaluateHeldGroupCsaGates | All Employees, SG-Engineering-Users: requiresCsa=[] | call #4; policy groupCatalog | pass |
| CHK-10 | Department groups | moverRules.removeOldDepartmentGroups | department unchanged (Engineering) | call #2 | pass (no removals) |
| CHK-11 | Held groups in catalog | moverRules.leaveUncataloguedGroupsUntouched | 2 held, 2 in catalog, 0 uncatalogued | call #4 | pass |
| CHK-12 | SoD on resulting set | sodRules, sodEvaluation | {All Employees, SG-Engineering-Users} | call #4; policy | pass (no rule fires) |
| CHK-13 | Privileged groups | privilegedGroups | none requested or held | call #4; policy | pass |
| CHK-14 | Approval requirement | approvalThresholds.decisionByRiskLevel.low | allow; operatorConfirmRequired.low=false | policy | pass (none needed) |
| CHK-15 | Budget | costThresholds.maxToolCallsPerRun.mover-orchestrator | est. 6 of 20 (30%) | plan | pass |
| — | Aggregate | evaluation.decisionPrecedence | RS-08 only → risk low | rows above | decision = allow |

## Execution preview — mover — elg-WD-000108-k7m2qa
Policy contoso-lifecycle-policy v1.2.0 | Decision: allow | Risk: low | Est. tool calls: 6 of 20
Before → after: title Software Engineer → Senior Software Engineer
| # | Tool | Key arguments (ids resolved this run) | Purpose | Policy basis |
|---|---|---|---|---|
| 1 | update_user | id=<alex.wilber>, replace title=Senior Software Engineer | attributes | moverRules.sequence[attributes] |
| 2 | get_user | id=<alex.wilber> | verify title, active unchanged | auditRequirements.verificationRequiredBeforeCompleted |
Approvals: none supplied; none required at risk low
Gate: low risk, proceeding

Executing call #5 (the single attribute write).

> #5 update_user {id: "<alex.wilber>",operations: [{op: "replace",path: "title",value: "Senior Software Engineer"}]} → ok, id <alex.wilber>

Write landed (no `dryRun`, no `isError`). Verifying with call #6.

> #6 get_user {id: "<alex.wilber>"} → ok, id <alex.wilber>, active true

Verification passed: title now reads Senior Software Engineer, `active` is still true, and department, manager and employee number are unchanged. Run complete at 6 of 20 calls. Handing off to the auditor (zero tool calls).

### Policy checks — contoso-lifecycle-policy v1.2.0 — elg-WD-000108-k7m2qa
| # | Check | Policy ref | Input (normalised) | Evidence | Result |
|---|---|---|---|---|---|
| CHK-01 | Policy loaded | policyVersion | contoso-lifecycle-policy 1.2.0 (major 1) | policy/lifecycle-policy.json | pass |
| CHK-02 | Authoritative source | authoritativeSources[id=workday] | workday; WD-000108 matches ^WD-[0-9]{6}$; mover in events | source record | pass |
| CHK-03 | Target identifier | target.userName | alex.wilber@contoso.local | source record | pass |
| CHK-04 | changes.worker keys known | requiredJoinerAttributes.core | jobTitle only (free text) | source record | pass |
| CHK-05 | Target resolves to exactly one | approvalThresholds.escalations.ambiguousIdentity | 1 match | call #1: id <alex.wilber>, active=true | pass |
| CHK-06 | previous.worker agrees with tenant | moverRules.compareToPreviousWhenPresent | previous jobTitle=Software Engineer; tenant title=Software Engineer | call #2 | pass |
| CHK-07 | Attribute diff | moverRules.sequence[attributes] | title: Software Engineer → Senior Software Engineer | call #2 vs source record | pass |
| CHK-08 | CSA diff | moverRules.sequence[customSecurityAttributes] | none requested; current Employment{Employee, ENG-200} Compliance{Internal, LegalHold=false} | call #3 | pass |
| CHK-09 | Held-group CSA gates still hold | moverRules.reevaluateHeldGroupCsaGates | All Employees, SG-Engineering-Users: requiresCsa=[] | call #4; policy | pass |
| CHK-10 | Old department groups | moverRules.removeOldDepartmentGroups | department unchanged (Engineering) | call #2 | pass |
| CHK-11 | Held groups in catalog | moverRules.leaveUncataloguedGroupsUntouched | 2 held, 2 in catalog, 0 uncatalogued | call #4 | pass |
| CHK-12 | SoD on resulting set | sodRules, sodEvaluation | {All Employees, SG-Engineering-Users} | call #4; policy | pass |
| CHK-13 | Privileged groups | privilegedGroups | none requested or held | call #4; policy | pass |
| CHK-14 | Approval requirement | approvalThresholds.decisionByRiskLevel.low | allow; operatorConfirmRequired.low=false | policy | pass |
| CHK-15 | Budget | costThresholds.maxToolCallsPerRun.mover-orchestrator | 6 of 20 (30%) | calls #1–#6 | pass |
| CHK-16 | Aggregate | evaluation.decisionPrecedence | RS-08 only → risk low | rows above | pass → decision = allow |

Alex Wilber's job title changed from Software Engineer to Senior Software Engineer on user <alex.wilber>, and nothing else about the account changed. The change came from Workday mover record WD-000108, effective 2026-09-22, which supplied the previous title and it matched the tenant exactly. Policy rows CHK-01 to CHK-16 all passed: only risk signal RS-08 (non-sensitive attribute only) fired, so the run was low risk, decision allow, and no approval or operator confirmation was required. Department (Engineering), manager, employee number, all four Custom Security Attributes and both group memberships (All Employees, SG-Engineering-Users) were read and left untouched because the record did not change them and no held-group CSA gate or SoD rule was affected. Nothing remains for a human; the verification read confirmed the new title with the account still active.

Tool calls: 6 of 20 (5 reads, 1 write)

```json
{
  "recordVersion": "1.0",
  "correlationId": "elg-WD-000108-k7m2qa",
  "supersedes": null,
  "skill": "mover-orchestrator",
  "skillVersion": "0.2.0",
  "policyId": "contoso-lifecycle-policy",
  "policyVersion": "1.2.0",
  "event": "mover",
  "host": "claude-code",
  "dryRun": false,
  "startedAt": "2026-10-06T06:55:46.437Z",
  "completedAt": "2026-10-06T07:07:09.422Z",
  "clockSource": "resourceMeta",
  "source": { "system": "workday", "recordId": "WD-000108" },
  "target": { "userName": "alex.wilber@contoso.local", "id": "<alex.wilber>", "displayName": "Alex Wilber" },
  "decision": "allow",
  "outcome": "completed",
  "riskLevel": "low",
  "policyChecks": [
    { "id": "CHK-01", "rule": "policyVersion", "input": "contoso-lifecycle-policy 1.2.0", "evidence": "entra-lifecycle-policy skill, policy/lifecycle-policy.json; major version 1", "result": "pass" },
    { "id": "CHK-02", "rule": "authoritativeSources[id=workday]", "input": "sourceSystem=workday; sourceRecordId=WD-000108; eventType=mover", "evidence": "source record: id matches ^WD-[0-9]{6}$; mover in events", "result": "pass" },
    { "id": "CHK-03", "rule": "target.userName", "input": "alex.wilber@contoso.local", "evidence": "source record: target.userName present", "result": "pass" },
    { "id": "CHK-04", "rule": "requiredJoinerAttributes.core", "subject": "changes.worker", "input": "jobTitle", "evidence": "source record: only jobTitle present; free text, no pattern", "result": "pass" },
    { "id": "CHK-05", "rule": "approvalThresholds.escalations.ambiguousIdentity", "subject": "alex.wilber@contoso.local", "input": "1 match", "evidence": "call #1: list_users userName eq alex.wilber@contoso.local -> 1 result, active=true, id <alex.wilber>", "result": "pass" },
    { "id": "CHK-06", "rule": "moverRules.compareToPreviousWhenPresent", "subject": "title", "input": "previous=Software Engineer; tenant=Software Engineer", "evidence": "call #2: get_user title=Software Engineer equals previous.worker.jobTitle", "result": "pass" },
    { "id": "CHK-07", "rule": "moverRules.sequence[attributes]", "subject": "title", "input": "Software Engineer -> Senior Software Engineer", "evidence": "call #2 vs source record changes.worker.jobTitle; one changed attribute", "result": "pass" },
    { "id": "CHK-08", "rule": "moverRules.sequence[customSecurityAttributes]", "subject": "csa", "input": "(none requested)", "evidence": "call #3: get_user_custom_security_attributes Employment{ContractType=Employee, CostCenter=ENG-200} Compliance{DataClassification=Internal, LegalHold=false}; no change planned", "result": "pass" },
    { "id": "CHK-09", "rule": "moverRules.reevaluateHeldGroupCsaGates", "subject": "All Employees, SG-Engineering-Users", "input": "requiresCsa=[] for both", "evidence": "call #4: 2 held groups; policy groupCatalog: no CSA conditions on either", "result": "pass" },
    { "id": "CHK-10", "rule": "moverRules.removeOldDepartmentGroups", "subject": "department", "input": "Engineering (unchanged)", "evidence": "call #2: department=Engineering; record does not change department", "result": "pass" },
    { "id": "CHK-11", "rule": "moverRules.leaveUncataloguedGroupsUntouched", "input": "2 held, 2 in catalog", "evidence": "call #4: All Employees <All Employees>, SG-Engineering-Users <SG-Engineering-Users>; both in groupCatalog", "result": "pass" },
    { "id": "CHK-12", "rule": "sodRules", "input": "resulting set = {All Employees, SG-Engineering-Users}", "evidence": "call #4; policy: no sodRules conflictingGroups pair present", "result": "pass" },
    { "id": "CHK-13", "rule": "privilegedGroups", "input": "(none requested or held)", "evidence": "call #4; policy privilegedGroups.displayNames not in held set", "result": "pass" },
    { "id": "CHK-14", "rule": "approvalThresholds.decisionByRiskLevel", "input": "low -> allow; operatorConfirmRequired.low=false", "evidence": "policy; approvals[] empty and none required", "result": "pass" },
    { "id": "CHK-15", "rule": "costThresholds.maxToolCallsPerRun.mover-orchestrator", "input": "6 of 20", "evidence": "calls #1-#6; 30% of budget, below warnAtPercent 80", "result": "pass" },
    { "id": "CHK-16", "rule": "evaluation.decisionPrecedence", "input": "allow; riskModel.aggregate=max(RS-08)=low", "evidence": "rows above; only RS-08 mover.attributeOnlyNonSensitive fired", "result": "pass" }
  ],
  "approvals": [],
  "plannedActions": [
    { "seq": 1, "tool": "update_user", "target": "alex.wilber@contoso.local", "argsSummary": "id=<alex.wilber>; operations=[replace title=Senior Software Engineer]", "purpose": "attributes", "policyBasis": ["moverRules.sequence[attributes]"], "status": "executed" },
    { "seq": 2, "tool": "get_user", "target": "alex.wilber@contoso.local", "argsSummary": "id=<alex.wilber>", "purpose": "verify title and active unchanged", "policyBasis": ["auditRequirements.verificationRequiredBeforeCompleted"], "status": "executed" }
  ],
  "executedActions": [
    { "call": 1, "seq": 0, "phase": "resolve", "tool": "list_users", "status": "ok", "at": "2026-10-06T06:55:46.668Z", "resultSummary": "filter userName eq alex.wilber@contoso.local; totalResults=1; id <alex.wilber>; active=true" },
    { "call": 2, "seq": 0, "phase": "read", "tool": "get_user", "status": "ok", "at": "2026-10-06T06:55:46.668Z", "resultSummary": "title=Software Engineer; department=Engineering; employeeNumber=100006; manager=358a2825-710a-439c-9d87-709d22fdc92f; active=true" },
    { "call": 3, "seq": 0, "phase": "read", "tool": "get_user_custom_security_attributes", "status": "ok", "at": "2026-10-06T06:55:46.668Z", "resultSummary": "attributeSets=[Employment, Compliance]; Employment{ContractType=Employee, CostCenter=ENG-200}; Compliance{DataClassification=Internal, LegalHold=false}" },
    { "call": 4, "seq": 0, "phase": "read", "tool": "list_groups", "status": "ok", "at": "2026-10-06T07:02:42.115Z", "resultSummary": "filter members.value eq <alex.wilber>; totalResults=2; All Employees <All Employees>; SG-Engineering-Users <SG-Engineering-Users>" },
    { "call": 5, "seq": 1, "phase": "execute", "tool": "update_user", "status": "ok", "at": null, "resultSummary": "ok=true; id <alex.wilber>; 1 replace op on title" },
    { "call": 6, "seq": 2, "phase": "verify", "tool": "get_user", "status": "ok", "at": "2026-10-06T07:07:09.422Z", "resultSummary": "title=Senior Software Engineer; active=true; department, manager, employeeNumber unchanged" }
  ],
  "skippedActions": [],
  "verificationFindings": {
    "proved": [
      { "check": "title equals planned after-value", "tool": "get_user", "expected": "Senior Software Engineer", "observed": "Senior Software Engineer", "result": "pass" },
      { "check": "active unchanged", "tool": "get_user", "expected": "true", "observed": "true", "result": "pass" },
      { "check": "untouched attributes unchanged", "tool": "get_user", "expected": "department=Engineering; manager=358a2825-710a-439c-9d87-709d22fdc92f; employeeNumber=100006", "observed": "department=Engineering; manager=358a2825-710a-439c-9d87-709d22fdc92f; employeeNumber=100006", "result": "pass" }
    ],
    "notVerifiable": [
      "sign-in sessions and tokens",
      "licence assignment",
      "application role assignments",
      "nested or transitive group access"
    ]
  },
  "residualRisk": [],
  "toolCalls": {
    "count": 6,
    "budget": 20,
    "byTool": { "list_users": 1, "get_user": 2, "get_user_custom_security_attributes": 1, "list_groups": 1, "update_user": 1 }
  },
  "nextSteps": [
    "No action required. Workday record WD-000108 is reflected in the tenant for alex.wilber@contoso.local."
  ],
  "summary": "Alex Wilber's job title changed from Software Engineer to Senior Software Engineer on user <alex.wilber>, and nothing else about the account changed. The change came from Workday mover record WD-000108, effective 2026-09-22, whose previous title matched the tenant exactly. Policy rows CHK-01 to CHK-16 all passed: only risk signal RS-08 fired, so the run was low risk, decision allow, with no approval or operator confirmation required. Department, manager, employee number, all four Custom Security Attributes and both group memberships (All Employees, SG-Engineering-Users) were read and left untouched because the record did not change them and no CSA gate or SoD rule was affected. Nothing remains for a human; the verification read confirmed the new title with the account still active.",
  "details": {
    "before": {
      "attributes": { "title": "Software Engineer", "department": "Engineering", "employeeNumber": "100006", "manager": "358a2825-710a-439c-9d87-709d22fdc92f", "active": true },
      "customSecurityAttributes": { "Employment": { "ContractType": "Employee", "CostCenter": "ENG-200" }, "Compliance": { "DataClassification": "Internal", "LegalHold": false } },
      "memberships": ["All Employees", "SG-Engineering-Users"]
    },
    "after": {
      "attributes": { "title": "Senior Software Engineer", "department": "Engineering", "employeeNumber": "100006", "manager": "358a2825-710a-439c-9d87-709d22fdc92f", "active": true },
      "customSecurityAttributes": { "Employment": { "ContractType": "Employee", "CostCenter": "ENG-200" }, "Compliance": { "DataClassification": "Internal", "LegalHold": false } },
      "memberships": ["All Employees", "SG-Engineering-Users"]
    }
  }
}
```

_Turn 1: 15 model turns, 169 s, cost US$1.85, 6 MCP call(s)._

## Mock state

- Before: as expected
- After: as expected

## Assertions

| Check | Result | Detail |
|---|---|---|
| record present | pass |  |
| decision = allow | pass | allow |
| outcome = completed | pass | completed |
| riskLevel = low | pass | low |
| skill = mover-orchestrator | pass | mover-orchestrator |
| host = claude-code | pass | claude-code |
| dryRun = false | pass | false |
| correlationId format | pass | elg-WD-000108-k7m2qa |
| toolCalls.count within 6±1 | pass | 6 |
| toolCalls.budget = 20 | pass | 20 |
| sum(byTool) = count | pass | 6 vs 6 |
| executedActions.length = count | pass | 6 vs 6 |
| no password key in record | pass |  |
| verificationFindings.proved non-empty, all pass | pass |  |
| approvals empty | pass | [] |
| schema valid | pass |  |
| observed MCP calls = record count | pass | 6 observed vs 6 |
| Tool calls line matches record | pass | 6 of 20 |
| no permission denials | pass |  |
| no dryRun results | pass |  |
| no discovery tools | pass |  |
| no group create/update/delete | pass |  |
| every list_users has a filter | pass |  |
| result events succeeded | pass | success |
| model pinned (claude-fable-5-1) | pass |  |
| exactly one write: update_user replace title | pass | update_user:[{"op":"replace","path":"title","value":"Senior Software Engineer"}] |
| no unfiltered list_groups (nothing added) | pass |  |
| single turn (no gate) | pass | 1 |
