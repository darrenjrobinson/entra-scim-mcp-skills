# joiner-orchestrator: tool sequences

Exact argument shapes for every call the joiner makes, in order, plus the errors each can return. Tool names and schemas are those of `entra-scim-mcp` 0.3.0. Ids are placeholders; resolve them every run.

## Name derivation (`namingStandards`)

1. `userName` template `{givenName}.{familyName}@{primaryDomain}` → lowercase → strip diacritics (`é`→`e`, `ø`→`o`) → drop any char not in `a-z0-9.-` → must match `namingStandards.userName.pattern`, local part ≤ `maxLocalPartLength`.
   - `Priya` + `Natarajan` → `priya.natarajan@contoso.local`
   - `Zoë` + `O'Brien` → `zoe.obrien@contoso.local`
   - `Jean-Luc` + `Picard` → `jean-luc.picard@contoso.local`
2. `mailNickname` = local part (`priya.natarajan`), must match `namingStandards.mailNickname.pattern`.
3. `displayName` = `{givenName} {familyName}` (`Priya Natarajan`).
4. Collision (`collision.strategy = numericSuffix`, `startAt = 2`, `maxAttempts = 3`): `priya.natarajan2@contoso.local`, `priya.natarajan3@…`; each probe is a counted `list_users` call. mailNickname follows the chosen local part.
5. Password: generate ≥ `minLength` (16) with upper, lower, digit and symbol. Use once. Never print.

## Resolve phase

```json
// call 1: every catalog group in one listing (follow nextCursor if present)
{ "tool": "list_groups", "arguments": { "attributes": ["id", "displayName"] } }
// → { "resources": [ { "id": "…", "displayName": "All Employees" }, … ], "nextCursor"?: "…" }

// call 2: already provisioned? (externalId must be the only filter clause)
{ "tool": "list_users", "arguments": { "filter": [ { "attr": "externalId", "op": "eq", "value": "WD-000123" } ], "attributes": ["id", "userName"] } }
// → { "resources": [] } is the only acceptable answer

// call 3: manager
{ "tool": "list_users", "arguments": { "filter": [ { "attr": "userName", "op": "eq", "value": "patti.fernandez@contoso.local" } ], "attributes": ["id", "userName", "displayName", "active"] } }
// → exactly one resource; keep id as managerId; active=false → warn row

// call 4: userName free?
{ "tool": "list_users", "arguments": { "filter": [ { "attr": "userName", "op": "eq", "value": "priya.natarajan@contoso.local" } ], "attributes": ["id", "userName"] } }
// → { "resources": [] } means free
```

Never resolve a person by `displayName` (not a permitted filter). `userName` and `mailNickname` filters are case-insensitive on both mock and live.

## Execute phase

```json
// call 5: create, inactive
{ "tool": "provision_user", "arguments": {
  "userName": "priya.natarajan@contoso.local",
  "password": "<generated, not shown>",
  "displayName": "Priya Natarajan",
  "givenName": "Priya",
  "familyName": "Natarajan",
  "mailNickname": "priya.natarajan",
  "active": false,
  "externalId": "WD-000123",
  "userType": "Member",
  "emails": [ { "value": "priya.natarajan@contoso.local", "type": "work", "primary": true } ],
  "department": "Finance",
  "employeeNumber": "100482",
  "managerId": "<managerId from call 3>"
} }
// → the created resource: { "id": "<userId>", "userName": …, "active": false, "meta": { "created": "…" }, … } — password is never echoed

// call 6: CSAs (one replace op per attribute; typed values)
{ "tool": "update_user_custom_security_attributes", "arguments": {
  "id": "<userId>",
  "operations": [
    { "op": "replace", "path": "urn:ietf:params:scim:schemas:extension:Microsoft:Entra:2.0:CustomSecurityAttributes:Employment.ContractType", "value": "Employee" },
    { "op": "replace", "path": "urn:ietf:params:scim:schemas:extension:Microsoft:Entra:2.0:CustomSecurityAttributes:Employment.CostCenter", "value": "FIN-100" },
    { "op": "replace", "path": "urn:ietf:params:scim:schemas:extension:Microsoft:Entra:2.0:CustomSecurityAttributes:Compliance.DataClassification", "value": "Confidential" }
  ]
} }
// → { "ok": true, "id": "<userId>" }

// calls 7–10: one add per planned group, catalog order
{ "tool": "add_group_members", "arguments": { "id": "<groupId All Employees>", "memberIds": ["<userId>"] } }
// → { "ok": true, "id": "<groupId>", "memberIds": ["<userId>"], "patchCalls": 1 }
```

## Verify phase

```json
// call 11
{ "tool": "get_user", "arguments": { "id": "<userId>" } }
// check: userName, active === false, externalId, urn:…:enterprise:2.0:User.department, .employeeNumber, .manager.value === managerId
// ignore any CustomSecurityAttributes object here (mock-only artefact)

// call 12
{ "tool": "get_user_custom_security_attributes", "arguments": { "id": "<userId>", "attributeSets": ["Employment", "Compliance"] } }
// → { "urn:…:CustomSecurityAttributes": { "Employment": { "ContractType": "Employee", "CostCenter": "FIN-100" }, "Compliance": { "DataClassification": "Confidential" } } }

// call 13
{ "tool": "list_groups", "arguments": { "filter": [ { "attr": "members.value", "op": "eq", "value": "<userId>" } ], "attributes": ["id", "displayName"] } }
// → resources must equal the planned set exactly (compare names case-insensitively)
```

## Activate phase

```json
// call 14
{ "tool": "update_user", "arguments": { "id": "<userId>", "operations": [ { "op": "replace", "path": "active", "value": true } ] } }
// → { "ok": true, "id": "<userId>" }

// call 15
{ "tool": "get_user", "arguments": { "id": "<userId>", "attributes": ["active"] } }
// → { "active": true, … }
```

## Errors you will see and what they mean

| tool | result | meaning | action |
|---|---|---|---|
| any | `isError` + `{ "error": "FilterValidationError", "detail" }` | your filter used a disallowed attribute/operator or combined `externalId` with another clause | fix the call; it was never sent |
| any | `isError` + `{ "error": "PatchValidationError", "detail" }` | op shape wrong (e.g. CSA path without the URN prefix, `mailNickname` removal) | fix the call; it was never sent |
| `provision_user` | `{ "error": "ScimError", "status": 409, "scimType": "uniqueness" }` | userName already exists (case-insensitive) | STOP `already_provisioned`; re-resolve, never retry the create |
| `provision_user` | `{ "error": "ScimError", "status": 400 }` | missing required field or invalid value (live: password policy, unverified domain) | STOP; report `detail` |
| `update_user_custom_security_attributes` | `ScimError 400` | on live: attribute set/attribute not defined, or wrong type | STOP; account stays inactive; residual risk |
| `add_group_members` | `isError` + `{ "error": "AddGroupMembersPartialFailure", "addedMemberIds", "failedMemberIds", "notAttemptedMemberIds", "cause" }` | some members landed; this is an error even though `addedMemberIds` is present | record all three lists; STOP (single-member adds mean nothing landed for this group) |
| `add_group_members` | `ScimError 404` | group id not found (stale id) | STOP; ids must be re-resolved |
| any write | `{ "dryRun": true, "request": {…} }` | server is in `ENTRA_SCIM_DRY_RUN=1`; nothing applied | outcome `rehearsal` |
| any | `ScimError 429 / 503` | retried by the server up to 3 times already | STOP `partial_failure`; adds are idempotent and safe to re-run |

## Worked example: S1 → S2

**S1** (record missing `Compliance.DataClassification`): Step 1 rows CHK-01..CHK-07 with CHK-06 `fail`; Step 2 group rows: AP-Requestors allow, AP-Approvers deny SOD-FIN-001 (`bothRequestedRule`), Treasury-Payments allow_with_approval satisfied by CHG-40012, TenantAdmins deny breakglass_only; aggregate deny/high; no preview needed; audit with `toolCalls.count = 0`. See `entra-lifecycle-policy/policy/decision-record.example.json`.

**S2** (corrected record, `requestedGroups: ["SG-Finance-AP-Requestors", "SG-Finance-Treasury-Payments"]`): Step 1 all pass; Step 2 both groups allowed (Treasury via CHG-40012); Step 3 calls 1–4; preview with 15 rows, risk medium (Treasury is medium), gate = operator confirmation; operator replies `approve elg-WD-000123-<random>`; calls 5–15 as above; outcome `completed`; `supersedes` = the S1 correlationId.
