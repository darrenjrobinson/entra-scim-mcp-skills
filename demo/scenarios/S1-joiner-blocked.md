# S1 — Joiner blocked: mandatory CSA missing

**Skill:** `joiner-orchestrator`
**Record:** `demo/source-records/S1-priya-natarajan-incomplete.json`
**Expected:** decision `deny`, outcome `blocked`, **0 tool calls**, four different guardrail outcomes in one request.

## Why this scenario

The record is technically fine for `provision_user`. Every required SCIM field is derivable. What is missing is `Compliance.DataClassification`, a Custom Security Attribute the tenant policy makes mandatory (`requiredJoinerAttributes.customSecurityAttributes[REQ-CSA-03]`). The MCP server would happily create the user; the skill refuses without touching the tenant.

The requested groups are chosen so the guardrail shows all four outcomes at once:

| group | outcome | rule |
|---|---|---|
| SG-Finance-AP-Requestors | allow | in catalog, low risk, no gate |
| SG-Finance-AP-Approvers | deny `sod_conflict` | SOD-FIN-001 with AP-Requestors; `sodEvaluation.bothRequestedRule` denies the higher-risk member |
| SG-Finance-Treasury-Payments | allow_with_approval, satisfied | CostCenter FIN-100 passes `startsWith "FIN-"`; CHG-40012 valid for scope `group:SG-Finance-Treasury-Payments` |
| SG-Entra-TenantAdmins | deny `breakglass_only` | `privilegedGroups.rules.breakglassOnlyGroups` |

## Prompt (paste into the playground after picking `/joiner-orchestrator`)

```
Onboard this new hire. Source record follows.

{
  "sourceSystem": "workday",
  "sourceRecordId": "WD-000123",
  "eventType": "joiner",
  "effectiveDate": "2026-09-21",
  "worker": {
    "givenName": "Priya",
    "familyName": "Natarajan",
    "employeeNumber": "100482",
    "department": "Finance",
    "jobTitle": "Accounts Payable Analyst",
    "userType": "Member",
    "managerUserName": "patti.fernandez@contoso.local"
  },
  "customSecurityAttributes": {
    "Employment": { "ContractType": "Employee", "CostCenter": "FIN-100" },
    "Compliance": { }
  },
  "requestedGroups": [
    "SG-Finance-AP-Requestors",
    "SG-Finance-AP-Approvers",
    "SG-Finance-Treasury-Payments",
    "SG-Entra-TenantAdmins"
  ],
  "approvals": [
    {
      "ref": "CHG-40012",
      "scope": "group:SG-Finance-Treasury-Payments",
      "approver": "treasury.lead@contoso.local",
      "sourceRecordId": "WD-000123",
      "grantedAt": "2026-09-19T03:10:00Z"
    }
  ]
}
```

## What you should see

1. The skill loads `entra-lifecycle-policy` (MCPJam: a `loadSkill` call, or nothing if you also picked the policy skill with `/`).
2. A policy check table with `CHK-01` quoting `contoso-lifecycle-policy v1.1.0`, a `fail` row for `REQ-CSA-03`, and one row per requested group with the outcomes above.
3. No preview, no `approve` gate: the run is blocked before the resolve phase.
4. A plain summary stating that nothing was created and why, then `Tool calls: 0 of 20`, then a fenced JSON decision record with `decision: deny`, `outcome: blocked`, `toolCalls.count: 0`, empty `executedActions`, and `skippedActions` entries for the two denied groups plus every planned write that was never attempted.

## Trace view checklist

- Zero MCP tool calls. `loadSkill` / `readSkillFile` calls are fine; `list_users`, `list_groups`, `provision_user` and every other `entra-scim-mcp` tool must be absent.
- The record's `policyChecks` ids match the printed table.
- The approval `CHG-40012` appears with `valid: true`, `used: false`.

## Reference record

`.claude/skills/entra-lifecycle-policy/policy/decision-record.example.json` is this scenario's expected record. Correlation ids differ per run.
