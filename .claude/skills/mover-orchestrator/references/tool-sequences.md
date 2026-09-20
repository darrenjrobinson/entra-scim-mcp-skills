# mover-orchestrator: tool sequences

Exact argument shapes for every call, in order, plus the errors each can return. Tool names and schemas are those of `entra-scim-mcp` 0.2.1. Ids are placeholders; resolve them every run.

## Resolve and read

```json
// call 1: target
{ "tool": "list_users", "arguments": { "filter": [ { "attr": "userName", "op": "eq", "value": "lidia.holloway@contoso.local" } ], "attributes": ["id", "userName", "displayName", "active"] } }
// → exactly one resource → userId

// call 2 (only when changes.worker.managerUserName is present): new manager
{ "tool": "list_users", "arguments": { "filter": [ { "attr": "userName", "op": "eq", "value": "megan.bowen@contoso.local" } ], "attributes": ["id", "userName", "displayName", "active"] } }

// call 3: current attributes
{ "tool": "get_user", "arguments": { "id": "<userId>" } }
// read: urn:ietf:params:scim:schemas:extension:enterprise:2.0:User { department, employeeNumber, manager: { value } }, title, active
// ignore: any urn:…:CustomSecurityAttributes object (mock-only artefact)

// call 4: current CSAs (the only trusted CSA source)
{ "tool": "get_user_custom_security_attributes", "arguments": { "id": "<userId>", "attributeSets": ["Employment", "Compliance"] } }
// → { "urn:…:CustomSecurityAttributes": { "Employment": { "ContractType": "Employee", "CostCenter": "FIN-110" }, "Compliance": { "DataClassification": "Confidential", "LegalHold": false } } }

// call 5: current memberships (ids included, so no per-group lookup is needed for removals)
{ "tool": "list_groups", "arguments": { "filter": [ { "attr": "members.value", "op": "eq", "value": "<userId>" } ], "attributes": ["id", "displayName"] } }

// call 6: catalog ids for additions
{ "tool": "list_groups", "arguments": { "attributes": ["id", "displayName"] } }
```

## Execute

```json
// call 7: attributes in ONE patch (atomic)
{ "tool": "update_user", "arguments": {
  "id": "<userId>",
  "operations": [
    { "op": "replace", "path": "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department", "value": "Engineering" },
    { "op": "replace", "path": "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:manager", "value": { "value": "<newManagerId>" } },
    { "op": "replace", "path": "title", "value": "Platform Analyst" }
  ]
} }
// → { "ok": true, "id": "<userId>" }

// call 8: CSAs
{ "tool": "update_user_custom_security_attributes", "arguments": {
  "id": "<userId>",
  "operations": [
    { "op": "replace", "path": "urn:ietf:params:scim:schemas:extension:Microsoft:Entra:2.0:CustomSecurityAttributes:Employment.CostCenter", "value": "ENG-210" }
  ]
} }

// calls 9–11: removals, one per group, ids from call 5
{ "tool": "remove_group_member", "arguments": { "id": "<groupId SG-Finance-Users>", "memberId": "<userId>" } }
{ "tool": "remove_group_member", "arguments": { "id": "<groupId SG-Finance-AP-Requestors>", "memberId": "<userId>" } }
{ "tool": "remove_group_member", "arguments": { "id": "<groupId SG-Finance-Treasury-Payments>", "memberId": "<userId>" } }
// → { "ok": true, "id": "<groupId>", "memberId": "<userId>" }

// call 12: additions, ids from call 6
{ "tool": "add_group_members", "arguments": { "id": "<groupId SG-Engineering-Users>", "memberIds": ["<userId>"] } }
// → { "ok": true, "id": "<groupId>", "memberIds": ["<userId>"], "patchCalls": 1 }
```

## Verify

```json
// call 13
{ "tool": "get_user", "arguments": { "id": "<userId>" } }
// check: enterprise department === "Engineering", manager.value === newManagerId, title, active unchanged

// call 14
{ "tool": "get_user_custom_security_attributes", "arguments": { "id": "<userId>", "attributeSets": ["Employment", "Compliance"] } }
// check: Employment.CostCenter === "ENG-210"

// call 15
{ "tool": "list_groups", "arguments": { "filter": [ { "attr": "members.value", "op": "eq", "value": "<userId>" } ], "attributes": ["id", "displayName"] } }
// check: equals (current − removals) + additions, e.g. [All Employees, SG-Engineering-Users]
```

## Errors

| tool | result | meaning | action |
|---|---|---|---|
| any | `FilterValidationError` / `PatchValidationError` (isError) | call shape rejected before sending (e.g. `mailNickname` removal, address filter not `[type eq "work"]`, CSA path without URN) | fix the call |
| `update_user` | `ScimError 400` | invalid value (live: unknown manager id, bad department) | STOP; nothing else was written |
| `update_user` | `ScimError 404` | stale user id | STOP; ids must be re-resolved |
| `update_user_custom_security_attributes` | `ScimError 400` | live: attribute not defined or wrong type | STOP after attributes landed → `partial_failure` |
| `remove_group_member` | `ScimError 404` naming the **group** | the user is not a member (or the group id is stale) | `warn`; confirm with the `members.value` listing at verification; continue |
| `add_group_members` | `AddGroupMembersPartialFailure` (isError) | single-member add: nothing landed for that group | STOP `partial_failure` |
| any write | `{ "dryRun": true, "request": {…} }` | dry-run server | outcome `rehearsal` |

## Worked examples

### S3a — SoD deny, zero writes

Record: target `adele.vance@contoso.local`, `changes: {}`, `requestedGroups.add: ["SG-Finance-AP-Approvers"]`, approval `REQ-50017` scope `group:SG-Finance-AP-Approvers`.
Calls 1, 3, 4, 5, 6 (no manager change → no call 2). Current memberships: All Employees, SG-Finance-Users, SG-Finance-AP-Requestors. Guardrail check 7: resulting set holds both SOD-FIN-001 groups, requested member AP-Approvers → `deny` / `sod_conflict`. Nothing left to write → outcome `blocked`, 5 calls, record with `details.before == details.after`.

### S3b — transfer with a CSA-driven removal

Record: target `lidia.holloway@contoso.local`; changes department Engineering, manager megan.bowen, jobTitle Platform Analyst, `Employment.CostCenter` ENG-210; `previous.worker.department` Finance; `requestedGroups.remove: ["SG-Finance-AP-Requestors"]`; approval `REQ-50018` scope `run`.
Diff: department Finance → Engineering (RS-05), manager (RS-06), CostCenter FIN-110 → ENG-210 (RS-07) → risk medium → approval `run` valid + operator confirmation.
Removals: SG-Finance-AP-Requestors (requested) + SG-Finance-Users (old department group, `removeOldDepartmentGroups`) + SG-Finance-Treasury-Payments (held; `requiresCsa` CostCenter startsWith FIN- fails against ENG-210; `reevaluateHeldGroupCsaGates`, row `warn` / `csa_condition_failed`).
Additions: SG-Engineering-Users (new department group).
Guardrail on resulting set {All Employees, SG-Engineering-Users}: no SoD, no privileged. Calls 1–15 as above; verify memberships == [All Employees, SG-Engineering-Users]; outcome `completed`; 15 calls.
