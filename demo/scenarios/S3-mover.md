# S3 — Mover: an SoD deny, then a transfer where a CSA strips an entitlement

**Skill:** `mover-orchestrator`
**Records:** `demo/source-records/S3a-adele-vance-sod.json`, `demo/source-records/S3b-lidia-holloway-transfer.json`
**Precondition:** seeded mock with links applied (`npm run mock`, `npm run seed:links`).

## S3a — Adele requests SG-Finance-AP-Approvers

**Expected:** decision `deny`, outcome `blocked`, 5 read calls, no writes, even though a valid approval reference is supplied.

Adele already holds `SG-Finance-AP-Requestors`. SOD-FIN-001 pairs it with `SG-Finance-AP-Approvers` with `enforcement: deny`. The guardrail evaluates the *resulting* membership set, not the request in isolation, and a `deny` cannot be overridden by an approval.

Prompt (after `/mover-orchestrator`):

```
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

What you should see: `list_users` (Adele), `get_user`, `get_user_custom_security_attributes`, `list_groups members.value` (three groups incl. AP-Requestors), `list_groups` (catalog); a check row `sodRules[SOD-FIN-001]` → `fail` → `deny (sod_conflict)` citing the membership call; no preview gate; summary "Nothing changed"; `Tool calls: 5 of 20 (5 reads, 0 writes)`; record with `approvals[0].valid: true, used: false` and one `skippedActions` entry.

Trace checklist: no `update_user`, no `add_group_members`, no `remove_group_member`.

## S3b — Lidia transfers from Finance to Engineering

**Expected:** decision `allow_with_approval`, outcome `completed`, 15 tool calls, three removals and one addition, one of the removals driven purely by a CSA gate.

Lidia holds `SG-Finance-Treasury-Payments`, whose catalog entry requires `Employment.CostCenter startsWith "FIN-"`. The record changes her cost centre to `ENG-210`. With `moverRules.reevaluateHeldGroupCsaGates: true`, the skill notices the gate no longer holds and schedules the removal itself; nobody had to request it. The old department group `SG-Finance-Users` is removed by `removeOldDepartmentGroups`; `SG-Finance-AP-Requestors` is removed because the record asks; `SG-Engineering-Users` is added as the new department group. `All Employees` is baseline and untouched.

Turn 1 (after `/mover-orchestrator`):

```
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

Expected end of turn 1: six reads (`list_users` ×2, `get_user`, `get_user_custom_security_attributes`, `list_groups` ×2); a check table including a `warn` row for `groupCatalog[SG-Finance-Treasury-Payments].requiresCsa` with `csa_condition_failed` (ENG-210 does not start with FIN-); a before → after line; a preview with `update_user` (department + manager + title in one call), the CSA write, three `remove_group_member` rows, one `add_group_members` row, three verification rows; risk `medium` (RS-05, RS-06, RS-07); gate `approve elg-WD-000104-xxxxxx`.

Turn 2:

```
approve elg-WD-000104-xxxxxx
```

Expected: writes in the preview order (attributes → CSA → removals → addition), then `get_user`, `get_user_custom_security_attributes`, `list_groups members.value` showing exactly `All Employees` and `SG-Engineering-Users`; summary; `Tool calls: 15 of 20`; record with `details.before` / `details.after` and `approvals[0].used: true`.

Trace checklist:
- One `update_user` with two or three `replace` operations, and it precedes every membership change.
- `remove_group_member` ×3 before `add_group_members` ×1.
- No call touches `SG-Legal-Hold` or any group Lidia does not hold.
- `mailNickname` and `userName` are never in a PATCH.
