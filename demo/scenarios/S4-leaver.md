# S4 — Leaver: ordered offboarding with a legal hold

**Skill:** `leaver-orchestrator`
**Record:** `demo/source-records/S4-nestor-wilke-leaver.json`
**Expected:** decision `allow_with_approval`, outcome `completed`, about **11 tool calls of 25**, privileged group removed first, `SG-Legal-Hold` retained, no `deprovision_user`.
**Precondition:** seeded mock with links applied. Nestor must still be active (run `npm run demo:up` again if S4 has already run).

## Why this scenario

Nestor holds four groups: `All Employees` (baseline), `SG-Engineering-Users` (business), `SG-Engineering-ProdDeploy` (privileged) and `SG-Legal-Hold`. His CSAs are `Compliance.DataClassification = Restricted` and `Compliance.LegalHold = true`. The policy turns those into four behaviours:

- `offboardingOrder.removalOrder` removes the privileged group first, then business, then baseline.
- `retainedAccessRules[RET-001]` keeps `SG-Legal-Hold` no matter what, and the record says so rather than silently skipping it.
- `offboardingOrder.deleteBlockedWhen` would block a `delete` request outright while `LegalHold` is true. This run is `immediate`, so the rule is recorded but not triggered.
- `riskModel.signals[RS-13]` lifts the run to high risk because the identity is classified `Restricted`. The privileged group he holds (RS-12) does the same; either alone is enough. A sensitive identity is flagged by a protected attribute, not inferred from a group name.

The mode is declared in the record (`leaver.mode`); the skill never infers it from dates.

## Turn 1 (after `/leaver-orchestrator`)

```
Offboard this leaver.

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

Expected end of turn 1: four reads (`list_users`, `get_user`, `list_groups members.value`, `get_user_custom_security_attributes` with `attributeSets: ["Compliance"]`); a check table showing mode `immediate`, `RS-12` (privileged holder) and `RS-13` (`DataClassification = Restricted`) → risk `high`, `RET-001` retaining `SG-Legal-Hold`, `LegalHold = true` noted; a preview with `update_user active=false`, `update_user_lifecycle`, three `remove_group_member` rows in the order ProdDeploy → Engineering-Users → All Employees, two verification rows, and a `(retained) SG-Legal-Hold` row; gate `approve elg-WD-000107-xxxxxx`.

## Turn 2

```
approve elg-WD-000107-xxxxxx
```

Expected: the five writes in preview order, then `list_groups members.value` returning exactly `SG-Legal-Hold`, then `get_user` with `active: false`; summary naming the retained group and its rule; `Tool calls: 11 of 25 (6 reads, 5 writes)`; record with `details.mode: immediate`, `details.retained: ["SG-Legal-Hold"]`, `details.residual: []`, and a residual-risk entry for the legal hold.

## Trace view checklist

- `update_user` (disable) is the first write; `update_user_lifecycle` is the second and carries `employeeLeaveDateTime: "2026-09-20T09:00:00Z"`.
- `remove_group_member` ×3 with `SG-Engineering-ProdDeploy` first. Each call has one `memberId`.
- No call for `SG-Legal-Hold`. No `deprovision_user`.
- Group ids in the removals come from the earlier `list_groups members.value` result; no extra per-group lookups.
- The final `list_groups` is a verification read, not a plan input.

## Variations (optional beats)

- **Scheduled**: change `"mode": "scheduled"` and the date to the future. Expected: only `update_user_lifecycle` is written; `All Employees` is also retained (RET-002); the record carries a residual risk "memberships retained until <date>".
- **Delete with legal hold**: change `"mode": "delete"` and add an approval with `"scope": "leaver:delete"`. Expected: `deny` / `delete_blocked_legal_hold` with zero writes, citing `offboardingOrder.deleteBlockedWhen` and the CSA read.
