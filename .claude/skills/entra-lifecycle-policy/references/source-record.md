# Source record contracts

The input every orchestrator consumes. One shape per event. All fields are strings unless noted. Anything the policy needs must be in the record or supplied by the operator in chat; the skills never invent values.

Common envelope:

| field | required | meaning |
|---|---|---|
| `sourceSystem` | yes | must match an `authoritativeSources[].id` (e.g. `workday`) |
| `sourceRecordId` | yes | must match that source's `recordIdPattern`; becomes `externalId` on joiner and the correlationId stem |
| `eventType` | yes | `joiner` \| `mover` \| `leaver`; must be in the source's `events` |
| `effectiveDate` | joiner | `YYYY-MM-DD` |
| `approvals[]` | when needed | `{ref, scope, approver, sourceRecordId, grantedAt}`; `ref` must match `approvalThresholds.approvalRef.pattern`; `scope` is `run`, `group:<displayName>`, `sod:<ruleId>` or `leaver:delete` |

## Joiner

```json
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

This is the **S1 (incomplete)** record: `Compliance.DataClassification` is absent, so REQ-CSA-03 fails and the run is blocked with zero tool calls. The guardrail still reports every requested group: AP-Requestors allow; AP-Approvers deny (SOD-FIN-001); Treasury-Payments allow_with_approval (CostCenter gate passes, CHG-40012 valid); TenantAdmins deny (breakglass-only).

The **S2 (corrected)** record is identical except `"Compliance": { "DataClassification": "Confidential" }` and `requestedGroups` reduced to `["SG-Finance-AP-Requestors", "SG-Finance-Treasury-Payments"]`. It provisions with baseline `All Employees` + `SG-Finance-Users` plus the two requested groups.

Derived by the joiner (never supplied): `userName` (`priya.natarajan@contoso.local`), `mailNickname` (`priya.natarajan`), `displayName` (`Priya Natarajan`), primary email (= userName), password (generated, never shown), `externalId` (= sourceRecordId).

## Mover

```json
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

This is **S3b**. `target` may use `userName` or `externalId` (never displayName). `previous.worker.*`, when present, is compared with the tenant; a mismatch is `source_conflict`. Only the keys under `changes` are written. The mover derives: removals = `requestedGroups.remove` + old department groups (`SG-Finance-Users`) + held groups whose `requiresCsa` now fails (`SG-Finance-Treasury-Payments`, because `csa.effective.Employment.CostCenter` = `ENG-210`); adds = `requestedGroups.add` + new department groups (`SG-Engineering-Users`).

**S3a** is a mover record for `adele.vance@contoso.local` (`WD-000103`) with `changes: {}`, `requestedGroups.add: ["SG-Finance-AP-Approvers"]`, approval `REQ-50017` scope `group:SG-Finance-AP-Approvers`. Adele holds `SG-Finance-AP-Requestors`, so SOD-FIN-001 fires: decision deny, zero writes.

## Leaver

```json
{
  "sourceSystem": "workday",
  "sourceRecordId": "WD-000107",
  "eventType": "leaver",
  "target": { "userName": "nestor.wilke@contoso.local" },
  "leaver": {
    "mode": "immediate",
    "effectiveDateTime": "2026-09-20T09:00:00Z",
    "reason": "Resignation, final day worked"
  },
  "approvals": [
    {
      "ref": "REQ-50021",
      "scope": "run",
      "approver": "megan.bowen@contoso.local",
      "sourceRecordId": "WD-000107",
      "grantedAt": "2026-09-19T22:30:00Z"
    }
  ]
}
```

This is **S4**. `leaver.mode` is declared, never inferred from dates: `scheduled` (set the leave date only, keep access until then), `immediate` (disable now, set leave date, remove non-retained memberships) or `delete` (immediate plus `deprovision_user`, which needs an approval with scope `leaver:delete` and is blocked while `csa.current.Compliance.LegalHold` is true). `effectiveDateTime` is written verbatim to `employeeLeaveDateTime` (ISO-8601 UTC, no milliseconds).

## What is never in a record

- Object ids (resolved every run).
- Passwords (generated by the joiner, never echoed).
- Approval refs invented by the agent. A ref counts only when it appears in the record or in an operator message.
