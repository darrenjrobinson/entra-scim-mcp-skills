# S2 — Joiner corrected: preview, approve, provision, verify

**Skill:** `joiner-orchestrator`
**Record:** `demo/source-records/S2-priya-natarajan-corrected.json`
**Expected:** decision `allow_with_approval`, outcome `completed`, about **15 tool calls of 20**, account created inactive and activated last.
**Precondition:** a fresh mock (`priya.natarajan@contoso.local` must not exist). Restart the mock and re-run `npm run seed:links` if S2 has already run.

## Why this scenario

Same hire as S1 with the source record corrected (`DataClassification: Confidential`) and the group request trimmed to what policy allows. The interesting parts are the order of operations the policy imposes:

1. Validation and the guardrail run with no tool calls.
2. Four reads resolve ids (all groups in one listing, the manager, the `externalId` duplicate check, the `userName` collision check).
3. A preview lists every call before any write; risk is `medium` because SG-Finance-Treasury-Payments is medium, so the skill stops and asks for `approve <correlationId>`.
4. `provision_user` with `active: false`, then CSAs (three `replace` ops in one call), then four `add_group_members` calls.
5. Three verification reads. Only then `update_user active=true` and a final `get_user`.

## Turn 1 (after picking `/joiner-orchestrator`)

```
Onboard this new hire. The source record has been corrected since the last attempt.

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
    "Compliance": { "DataClassification": "Confidential" }
  },
  "requestedGroups": [
    "SG-Finance-AP-Requestors",
    "SG-Finance-Treasury-Payments"
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

Expected end of turn 1: the check table (all pass, Treasury row `needs_approval` satisfied by CHG-40012), then an execution preview with about 15 numbered rows, then the gate line `operator confirmation required: reply exactly approve elg-WD-000123-xxxxxx`. Exactly four tool calls so far (`list_groups`, `list_users` ×3).

## Turn 2

Copy the correlation id from the gate line:

```
approve elg-WD-000123-xxxxxx
```

Expected: calls 5–15 in the order of the preview, then the summary, `Tool calls: 15 of 20 (8 reads, 7 writes)` (counts may differ by one if the model batches differently; the order must not), then the decision record with `outcome: completed`, `supersedes` set to the S1 correlation id if S1 ran in the same conversation, four `verificationFindings.proved` entries, and `approvals[0].used: true`.

## Trace view checklist

- Exactly one `provision_user`; its arguments show `active: false` and `externalId: WD-000123`. The password is visible in the Trace arguments (that is why the demo uses a throwaway mock); it must not appear in the chat summary or the record.
- `update_user_custom_security_attributes` comes **before** any `add_group_members`.
- Four `add_group_members`, each with one member id.
- `get_user`, `get_user_custom_security_attributes` and `list_groups members.value` appear after the adds and before `update_user active=true`.
- The last two calls are `update_user` (activate) and `get_user` (`attributes: ["active"]`).
- No `create_group`, no discovery tools, no unfiltered `list_users`.

## Idempotence beat (optional)

Send turn 1 again without restarting the mock. Expected: `list_users externalId eq WD-000123` returns Priya, the skill stops with `require_manual_review` / `already_provisioned`, and no write is attempted. Restart the mock to reset.
