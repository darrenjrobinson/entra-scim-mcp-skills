# Abridged decision records

Full blocked-joiner example: `entra-lifecycle-policy/policy/decision-record.example.json`. The records below are abridged (`...` marks omitted rows) to show the shape of each outcome. Ids are illustrative; a real record carries the ids returned by the tools in that run.

## Completed joiner (S2)

```json
{
  "recordVersion": "1.0",
  "correlationId": "elg-WD-000123-p8m2xd",
  "supersedes": "elg-WD-000123-k3v9qa",
  "skill": "joiner-orchestrator",
  "skillVersion": "0.1.0",
  "policyId": "contoso-lifecycle-policy",
  "policyVersion": "1.1.0",
  "event": "joiner",
  "host": "mcpjam",
  "dryRun": false,
  "startedAt": "2026-09-20T09:14:02Z",
  "completedAt": "2026-09-20T09:14:09Z",
  "clockSource": "resourceMeta",
  "source": { "system": "workday", "recordId": "WD-000123" },
  "target": { "userName": "priya.natarajan@contoso.local", "id": "3c1f6a2e-8d4b-4a1e-9f0c-2b7d5e8a1c33", "displayName": "Priya Natarajan" },
  "decision": "allow_with_approval",
  "outcome": "completed",
  "riskLevel": "medium",
  "policyChecks": [
    { "id": "CHK-01", "rule": "policyVersion", "input": "1.1.0", "evidence": "entra-lifecycle-policy skill", "result": "pass" },
    { "id": "CHK-06", "rule": "requiredJoinerAttributes.customSecurityAttributes[REQ-CSA-03]", "subject": "csa.requested.Compliance.DataClassification", "input": "Confidential", "evidence": "source record; in allowedValues", "result": "pass" },
    { "id": "CHK-11", "rule": "groupCatalog[SG-Finance-Treasury-Payments].approvalRequired", "subject": "SG-Finance-Treasury-Payments", "input": "CHG-40012 scope group:SG-Finance-Treasury-Payments", "evidence": "source record approvals[0]; valid; used by call #10", "result": "needs_approval", "reasonCode": "approval_required" },
    { "id": "CHK-15", "rule": "namingStandards.userName", "input": "priya.natarajan@contoso.local", "evidence": "call #4: list_users userName eq -> 0 results", "result": "pass" },
    { "id": "CHK-16", "rule": "approvalThresholds.operatorConfirmRequired.medium", "input": "approve elg-WD-000123-p8m2xd", "evidence": "operator message after preview", "result": "pass" },
    { "id": "CHK-17", "rule": "evaluation.decisionPrecedence", "input": "allow_with_approval (CHK-11)", "evidence": "worst row; risk max = medium (RS-01 Treasury medium)", "result": "pass" }
  ],
  "approvals": [
    { "ref": "CHG-40012", "scope": "group:SG-Finance-Treasury-Payments", "approver": "treasury.lead@contoso.local", "sourceRecordId": "WD-000123", "grantedAt": "2026-09-19T03:10:00Z", "valid": true, "used": true }
  ],
  "plannedActions": [
    { "seq": 1, "tool": "provision_user", "target": "priya.natarajan@contoso.local", "argsSummary": "active=false, externalId=WD-000123, managerId=6f1c..., password=<generated, not shown>", "purpose": "create identity inactive", "policyBasis": ["joinerRules.createInactiveUntilVerified"], "status": "executed" },
    { "seq": 2, "tool": "update_user_custom_security_attributes", "target": "3c1f6a2e-...", "argsSummary": "replace Employment.ContractType, Employment.CostCenter, Compliance.DataClassification", "purpose": "mandatory CSAs", "policyBasis": ["requiredJoinerAttributes.customSecurityAttributes"], "status": "executed" },
    { "seq": 3, "tool": "add_group_members", "target": "All Employees", "argsSummary": "memberIds=[3c1f6a2e-...]", "purpose": "baseline", "policyBasis": ["approvedBaselineProfiles.profiles.Employee.baseGroups"], "status": "executed" },
    { "seq": 10, "tool": "update_user", "target": "3c1f6a2e-...", "argsSummary": "replace active=true", "purpose": "activate after verification", "policyBasis": ["joinerRules.sequence"], "status": "executed" }
  ],
  "executedActions": [
    { "call": 1, "seq": 0, "phase": "resolve", "tool": "list_groups", "status": "ok", "at": null, "resultSummary": "10 groups; all catalog names resolved once" },
    { "call": 5, "seq": 1, "phase": "execute", "tool": "provision_user", "status": "ok", "at": "2026-09-20T09:14:02Z", "resultSummary": "created id 3c1f6a2e-..., active=false" },
    { "call": 6, "seq": 2, "phase": "execute", "tool": "update_user_custom_security_attributes", "status": "ok", "at": null, "resultSummary": "ok" },
    { "call": 7, "seq": 3, "phase": "execute", "tool": "add_group_members", "status": "ok", "at": null, "resultSummary": "All Employees; patchCalls=1" },
    { "call": 11, "seq": 0, "phase": "verify", "tool": "get_user", "status": "ok", "at": "2026-09-20T09:14:07Z", "resultSummary": "active=false, externalId=WD-000123, department=Finance, manager=6f1c..." },
    { "call": 12, "seq": 0, "phase": "verify", "tool": "get_user_custom_security_attributes", "status": "ok", "at": null, "resultSummary": "Employment{ContractType=Employee, CostCenter=FIN-100}; Compliance{DataClassification=Confidential}" },
    { "call": 13, "seq": 0, "phase": "verify", "tool": "list_groups", "status": "ok", "at": null, "resultSummary": "members.value eq 3c1f6a2e-... -> [All Employees, SG-Finance-Users, SG-Finance-AP-Requestors, SG-Finance-Treasury-Payments]" },
    { "call": 14, "seq": 10, "phase": "execute", "tool": "update_user", "status": "ok", "at": null, "resultSummary": "active=true" },
    { "call": 15, "seq": 0, "phase": "verify", "tool": "get_user", "status": "ok", "at": "2026-09-20T09:14:09Z", "resultSummary": "active=true" }
  ],
  "skippedActions": [],
  "verificationFindings": {
    "proved": [
      { "check": "user attributes", "tool": "get_user", "expected": "userName, externalId WD-000123, department Finance, manager 6f1c...", "observed": "all present", "result": "pass" },
      { "check": "custom security attributes", "tool": "get_user_custom_security_attributes", "expected": "3 values", "observed": "3 values equal", "result": "pass" },
      { "check": "memberships equal planned set", "tool": "list_groups", "expected": "4 groups", "observed": "4 groups, same names", "result": "pass" },
      { "check": "account active", "tool": "get_user", "expected": "true", "observed": "true", "result": "pass" }
    ],
    "notVerifiable": ["licence assignment", "mailbox provisioning", "nested or transitive group access"]
  },
  "residualRisk": [
    { "id": "RR-01", "description": "SG-Finance-Treasury-Payments granted under CHG-40012; review at next access certification.", "severity": "low", "owner": "treasury", "dueBy": null }
  ],
  "toolCalls": { "count": 15, "budget": 20, "byTool": { "list_groups": 2, "list_users": 3, "provision_user": 1, "update_user_custom_security_attributes": 1, "add_group_members": 4, "get_user": 2, "get_user_custom_security_attributes": 1, "update_user": 1 } },
  "nextSteps": ["Hand the initial password to the new hire through the HR credential channel; it was not recorded here."],
  "summary": "Created priya.natarajan@contoso.local (id 3c1f6a2e-...) from Workday record WD-000123 with three Custom Security Attributes and four group memberships, then activated the account after verification. ..."
}
```

## Denied mover (S3a)

```json
{
  "correlationId": "elg-WD-000103-a7q1zt",
  "skill": "mover-orchestrator",
  "event": "mover",
  "target": { "userName": "adele.vance@contoso.local", "id": "9b0e...", "displayName": "Adele Vance" },
  "decision": "deny",
  "outcome": "blocked",
  "riskLevel": "high",
  "policyChecks": [
    { "id": "CHK-05", "rule": "sodRules[SOD-FIN-001]", "subject": "SG-Finance-AP-Approvers", "input": "resulting set = {All Employees, SG-Finance-Users, SG-Finance-AP-Requestors, SG-Finance-AP-Approvers}", "evidence": "call #3: list_groups members.value eq 9b0e... -> holds SG-Finance-AP-Requestors; requested add conflicts; enforcement=deny", "result": "fail", "reasonCode": "sod_conflict" }
  ],
  "approvals": [
    { "ref": "REQ-50017", "scope": "group:SG-Finance-AP-Approvers", "approver": "patti.fernandez@contoso.local", "sourceRecordId": "WD-000103", "grantedAt": null, "valid": true, "used": false }
  ],
  "plannedActions": [
    { "seq": 1, "tool": "add_group_members", "target": "SG-Finance-AP-Approvers", "argsSummary": "memberIds=[9b0e...]", "purpose": "requested add", "policyBasis": ["groupCatalog[SG-Finance-AP-Approvers]"], "status": "skipped" }
  ],
  "executedActions": [
    { "call": 1, "seq": 0, "phase": "resolve", "tool": "list_users", "status": "ok", "at": null, "resultSummary": "userName eq adele.vance@contoso.local -> 1 result" },
    { "call": 2, "seq": 0, "phase": "read", "tool": "get_user", "status": "ok", "at": null, "resultSummary": "department Finance" },
    { "call": 3, "seq": 0, "phase": "read", "tool": "list_groups", "status": "ok", "at": null, "resultSummary": "members.value -> 3 groups" },
    { "call": 4, "seq": 0, "phase": "read", "tool": "get_user_custom_security_attributes", "status": "ok", "at": null, "resultSummary": "Employment, Compliance read" },
    { "call": 5, "seq": 0, "phase": "resolve", "tool": "list_groups", "status": "ok", "at": null, "resultSummary": "10 groups" }
  ],
  "skippedActions": [
    { "seq": 1, "tool": "add_group_members", "group": "SG-Finance-AP-Approvers", "reason": "SOD-FIN-001: conflicts with held SG-Finance-AP-Requestors; enforcement deny; approval REQ-50017 cannot override a deny", "reasonCode": "sod_conflict" }
  ],
  "verificationFindings": { "proved": [], "notVerifiable": [] },
  "residualRisk": [],
  "toolCalls": { "count": 5, "budget": 20, "byTool": { "list_users": 1, "get_user": 1, "list_groups": 2, "get_user_custom_security_attributes": 1 } },
  "summary": "Nothing changed. ... denied by SOD-FIN-001 ... Five read-only calls of twenty."
}
```

## Leaver partial failure (removal 2 of 3 errored)

```json
{
  "skill": "leaver-orchestrator",
  "event": "leaver",
  "decision": "allow_with_approval",
  "outcome": "partial_failure",
  "riskLevel": "high",
  "executedActions": [
    { "call": 5, "seq": 1, "phase": "execute", "tool": "update_user", "status": "ok", "at": null, "resultSummary": "active=false" },
    { "call": 6, "seq": 2, "phase": "execute", "tool": "update_user_lifecycle", "status": "ok", "at": null, "resultSummary": "employeeLeaveDateTime set" },
    { "call": 7, "seq": 3, "phase": "execute", "tool": "remove_group_member", "status": "ok", "at": null, "resultSummary": "SG-Engineering-ProdDeploy removed" },
    { "call": 8, "seq": 4, "phase": "execute", "tool": "remove_group_member", "status": "error", "at": null, "resultSummary": "SG-Engineering-Users: ScimError 503", "error": { "error": "ScimError", "status": 503, "detail": "Service unavailable" } }
  ],
  "skippedActions": [
    { "seq": 5, "tool": "remove_group_member", "group": "All Employees", "reason": "not attempted after error at seq 4 (offboardingOrder.onStepFailure=stop)", "reasonCode": "partial_failure" }
  ],
  "verificationFindings": {
    "proved": [
      { "check": "residual memberships", "tool": "list_groups", "expected": "[SG-Legal-Hold]", "observed": "[SG-Legal-Hold, SG-Engineering-Users, All Employees]", "result": "fail" }
    ],
    "notVerifiable": ["sign-in sessions and tokens"]
  },
  "residualRisk": [
    { "id": "RR-01", "description": "Account is disabled but still holds SG-Engineering-Users and All Employees. Re-run leaver-orchestrator in immediate mode; removals are safe to retry.", "severity": "medium", "owner": "identity-ops", "dueBy": null }
  ],
  "summary": "Partially done. The account is disabled and the leave date set, and the privileged group was removed, but the second removal failed with a 503 and the third was not attempted. ..."
}
```

## Rehearsal (ENTRA_SCIM_DRY_RUN=1)

```json
{
  "dryRun": true,
  "outcome": "rehearsal",
  "executedActions": [
    { "call": 1, "seq": 0, "phase": "resolve", "tool": "list_users", "status": "dryRun", "at": null, "resultSummary": "dryRun: GET /users?filter=userName eq ... would have been sent" }
  ],
  "verificationFindings": { "proved": [], "notVerifiable": ["everything: no request reached the tenant"] },
  "summary": "Nothing was applied. The server is in dry-run mode, so every call returned the request it would have sent. The run stopped at the first resolve step because dry-run results carry no ids. ..."
}
```
