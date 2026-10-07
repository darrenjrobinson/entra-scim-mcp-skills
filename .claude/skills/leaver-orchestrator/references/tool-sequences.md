# leaver-orchestrator: tool sequences

Exact argument shapes for every call, in order, plus the errors each can return. Tool names and schemas are those of `entra-scim-mcp` 0.3.0. Ids are placeholders; resolve them every run.

## Resolve and read

```json
// call 1: target
{ "tool": "list_users", "arguments": { "filter": [ { "attr": "userName", "op": "eq", "value": "nestor.wilke@contoso.local" } ], "attributes": ["id", "userName", "displayName", "active"] } }
// → exactly one resource → userId; note active

// call 2: current attributes
{ "tool": "get_user", "arguments": { "id": "<userId>" } }
// read: enterprise department / manager.value, Entra extension employeeLeaveDateTime (if set), active
// ignore: any urn:…:CustomSecurityAttributes object (mock-only artefact)

// call 3: memberships WITH ids (used directly for removals; no per-group lookups)
{ "tool": "list_groups", "arguments": { "filter": [ { "attr": "members.value", "op": "eq", "value": "<userId>" } ], "attributes": ["id", "displayName"] } }
// → e.g. [All Employees, SG-Engineering-Users, SG-Engineering-ProdDeploy, SG-Legal-Hold]

// call 4: legal-hold signal (the set named in offboardingOrder.deleteBlockedWhen)
{ "tool": "get_user_custom_security_attributes", "arguments": { "id": "<userId>", "attributeSets": ["Compliance"] } }
// → { "urn:…:CustomSecurityAttributes": { "Compliance": { "DataClassification": "Restricted", "LegalHold": true } } }
```

## Execute (immediate mode)

```json
// call 5: disable
{ "tool": "update_user", "arguments": { "id": "<userId>", "operations": [ { "op": "replace", "path": "active", "value": false } ] } }
// → { "ok": true, "id": "<userId>" }

// call 6: leave date (ISO-8601 UTC, no milliseconds)
{ "tool": "update_user_lifecycle", "arguments": { "id": "<userId>", "employeeLeaveDateTime": "2026-09-20T09:00:00Z" } }
// → { "ok": true, "id": "<userId>" }        // { "ok": true, "noChanges": true } means you omitted the argument: failed step

// calls 7–9: removals in removalOrder (privileged → business → baseline), ids from call 3
{ "tool": "remove_group_member", "arguments": { "id": "<groupId SG-Engineering-ProdDeploy>", "memberId": "<userId>" } }
{ "tool": "remove_group_member", "arguments": { "id": "<groupId SG-Engineering-Users>", "memberId": "<userId>" } }
{ "tool": "remove_group_member", "arguments": { "id": "<groupId All Employees>", "memberId": "<userId>" } }
// → { "ok": true, "id": "<groupId>", "memberId": "<userId>" }
// SG-Legal-Hold is retained (RET-001): no call
```

Scheduled mode runs only call 6. Delete mode runs calls 5–9, then verification, then:

```json
// delete mode only, after verification passed and a valid approval with scope leaver:delete exists,
// and only if csa.current.Compliance.LegalHold is not true
{ "tool": "deprovision_user", "arguments": { "id": "<userId>" } }
// → { "ok": true, "id": "<userId>" }
// After this: no update_user, update_user_lifecycle, update_user_custom_security_attributes or remove_group_member on this id.
```

## Verify

```json
// call 10: residual access
{ "tool": "list_groups", "arguments": { "filter": [ { "attr": "members.value", "op": "eq", "value": "<userId>" } ], "attributes": ["id", "displayName"] } }
// pass: returned − retained is empty (here: exactly [SG-Legal-Hold])

// call 11: disabled
{ "tool": "get_user", "arguments": { "id": "<userId>", "attributes": ["active"] } }
// pass: active === false

// scheduled mode instead: get_user full → Entra extension employeeLeaveDateTime equals the value written
// delete mode, after deprovision_user:
{ "tool": "get_user", "arguments": { "id": "<userId>" } }
// pass: isError with { "error": "ScimError", "status": 404 }
```

## Errors

| tool | result | meaning | action |
|---|---|---|---|
| `update_user` | `ScimError 404` | stale user id | STOP; re-resolve |
| `update_user_lifecycle` | `{ "ok": true, "noChanges": true }` | you did not pass `employeeLeaveDateTime` | failed step; STOP |
| `update_user_lifecycle` | `ScimError 403` (live) | app lacks `User-LifeCycleInfo.ReadWrite.All` | STOP `partial_failure` (account already disabled); residual risk |
| `remove_group_member` | `ScimError 404` naming the **group** | not a member (or stale id) | `warn`; confirm at verification; continue |
| `remove_group_member` | `ScimError 429 / 503` | already retried by the server | STOP `partial_failure`; removals are safe to re-run |
| `deprovision_user` | `ScimError 404` | already deleted, or stale id | STOP; report; do not retry |
| any | `{ "dryRun": true }` | dry-run server | outcome `rehearsal` |

## Worked examples

### S4 — immediate, legal hold retained

Record: target `nestor.wilke@contoso.local`, mode `immediate`, `effectiveDateTime 2026-09-20T09:00:00Z`, approval `REQ-50021` scope `run`.
Calls 1–4. Held: All Employees (baseline), SG-Engineering-Users (business), SG-Engineering-ProdDeploy (privileged), SG-Legal-Hold (business). Retained: SG-Legal-Hold (RET-001, always). Removal order: SG-Engineering-ProdDeploy → SG-Engineering-Users → All Employees. Signals: RS-10 medium, RS-12 high (privileged holder), RS-13 high (DataClassification Restricted) → risk high → approval `run` valid + operator confirmation. CSA: DataClassification Restricted (drives RS-13), LegalHold true (recorded; irrelevant to immediate mode, would block delete). Calls 5–11. Verify residual == [SG-Legal-Hold], active false. Outcome `completed`, 11 calls. Residual risk: "SG-Legal-Hold retained under RET-001; release by Legal."

### Scheduled

Same target, mode `scheduled`, effectiveDateTime in the future. Steps: setLeaveDate, verifyResidualAccess. Retained: SG-Legal-Hold (RET-001) and All Employees (RET-002, `leaver.mode equals scheduled`). No removals in this run. Verify: `get_user` shows the leave date. Residual risk: "all memberships retained until <date>; run immediate mode then."

### Delete with legal hold

Mode `delete`, approval scope `leaver:delete` present. Step 3: `deleteBlockedWhen` → `csa.current.Compliance.LegalHold equals true` → `deny` / `delete_blocked_legal_hold`. No writes; the record says why; next step: Legal releases the hold or the request is downgraded to `immediate`.

### Partial failure

Removal 2 of 3 returns 503 → stop; verify anyway (`list_groups`) and report residual [SG-Engineering-Users, All Employees, SG-Legal-Hold] with SG-Legal-Hold marked retained; outcome `partial_failure`; next step: re-run immediate mode (idempotent).
