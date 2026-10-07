# Live tenant setup

Everything in the README runs against the local mock and costs nothing. This page is for running the same skills against a real Entra ID tenant through the `entra-scim-live` server entry. Read all of it first: every call is billed, `deprovision_user` is a real soft delete, and the policy names objects that must exist before a run can pass.

The MCP server's own prerequisites, mock and smoke test are documented in the [entra-scim-mcp README](https://github.com/darrenjrobinson/entra-scim-mcp). This page covers only what the skills add on top.

## 1. Licence and API

1. The tenant needs Entra ID P1 (or any SKU that contains it) and an Azure subscription to bill against.
2. Enable the **SCIM Provisioning API** under **ID Governance** and link a billing resource group. Microsoft's steps are at <https://learn.microsoft.com/entra/identity/app-provisioning/enable-scim-api>.

## 2. App registration

Register an application and grant these Microsoft Graph **application** permissions, then grant admin consent:

| Permission | Used by |
|---|---|
| `User.ReadWrite.All` | `provision_user`, `get_user`, `list_users`, `update_user` |
| `Group.ReadWrite.All` | `list_groups`, `add_group_members`, `remove_group_member` |
| `CustomSecAttributeAssignment.ReadWrite.All` | `get_user_custom_security_attributes`, `update_user_custom_security_attributes` |
| `CustomSecAttributeDefinition.Read.All` | reading the attribute definitions the assignments refer to |
| `User-LifeCycleInfo.ReadWrite.All` | `update_user_lifecycle` (`employeeLeaveDateTime`) |
| `User.EnableDisableAccount.All` | the `active` flag written by the joiner's activate step and the leaver's disable step |

`entra-scim-mcp` 0.3.0 documents narrower alternatives for deployments that split duties: `User.Create` (create only), `User.ReadUpdate.All` (read and update, no create or delete), `Group.Create` and `GroupMember.ReadWrite.All` (add and remove members only). The joiner creates, reads and updates, so the table above is the smallest set that runs every scenario; the server README has the per-tool mapping.

Create either a client secret or a client certificate (PEM) for the app.

## 3. Credentials in `.env`

Copy the example file and fill it in. `.env` is gitignored and is read only by `scripts/mcp-live.mjs`; the published server reads `process.env` only, so a stray `.env` in another directory never leaks into another session.

```bash
cp .env.example .env
```

| Variable | Value |
|---|---|
| `ENTRA_TENANT_ID` | directory (tenant) id |
| `ENTRA_CLIENT_ID` | application (client) id |
| `ENTRA_CLIENT_SECRET` | the secret value (shown once), or leave empty and use the certificate |
| `ENTRA_CLIENT_CERT_PATH` | path to the certificate file, or leave empty and use the secret |
| `ENTRA_CLIENT_CERT_PASSWORD` | only if the certificate file is password protected |
| `ENTRA_SCIM_BASE_URL` | leave unset; the default is `https://graph.microsoft.com/rp/scim` |

Set exactly one of `ENTRA_CLIENT_SECRET` and `ENTRA_CLIENT_CERT_PATH`. The launcher exits with a message if both or neither are set, if `ENTRA_TENANT_ID` or `ENTRA_CLIENT_ID` is missing, or if `ENTRA_SCIM_STATIC_TOKEN` or `ENTRA_SCIM_DRY_RUN=1` is present anywhere in the environment. Those two belong to the mock and rehearsal entries, never to a live session.

## 4. Custom security attribute definitions

The policy reads and writes two attribute sets. They must exist with exactly these names, types and predefined values before any run; the live API rejects a write to an undefined attribute, and the joiner would then stop with the account left inactive.

| Set | Attribute | Type | Predefined values | Used by |
|---|---|---|---|---|
| `Employment` | `ContractType` | String | `Employee`, `Contractor`, `Vendor` | profile selection (`approvedBaselineProfiles.keyedBy`), the `SG-Contractors` and `SG-Engineering-ProdDeploy` gates, `authoritativeSources[].allowedContractTypes` |
| `Employment` | `CostCenter` | String | free text matching `^(FIN\|ENG\|OPS\|HR)-[0-9]{3}$` | the `SG-Finance-Treasury-Payments` gate (`startsWith "FIN-"`) |
| `Compliance` | `DataClassification` | String | `Public`, `Internal`, `Confidential`, `Restricted` | mandatory joiner attribute REQ-CSA-03; `Restricted` lifts a leaver to high risk (RS-13) |
| `Compliance` | `LegalHold` | Boolean | `true` / `false`, default `false` | `offboardingOrder.deleteBlockedWhen` |

Create them in the Entra portal under **Protection** > **Custom security attributes**. Two things catch people out:

- The account doing this must hold the **Attribute Definition Administrator** role. Global Administrator is not enough on its own.
- Attribute sets can be deactivated but never deleted. Name them carefully; `Employment` and `Compliance` will be in the tenant permanently.

CSA string values are case-sensitive in Entra and the policy compares them exactly, so `employee` is not `Employee`.

## 5. Groups

Create the ten catalog groups as security groups with exactly these display names. Display names must be unique in the tenant: the skills resolve groups by `displayName` and stop with `duplicate_group_display_name` if a name matches more than one group.

| displayName | Classification | Risk | Approval required | Allowed at joiner | CSA gate |
|---|---|---|---|---|---|
| `All Employees` | baseline | low | no | yes | none |
| `SG-Contractors` | baseline | low | no | yes | `Employment.ContractType in [Contractor, Vendor]` |
| `SG-Finance-Users` | business | low | no | yes | none |
| `SG-Finance-AP-Requestors` | business | low | no | yes | none |
| `SG-Finance-AP-Approvers` | business | medium | no | yes | none |
| `SG-Finance-Treasury-Payments` | business | medium | yes | yes | `Employment.CostCenter startsWith "FIN-"` |
| `SG-Engineering-Users` | business | low | no | yes | none |
| `SG-Engineering-ProdDeploy` | privileged | high | yes | no | `Employment.ContractType equals Employee` |
| `SG-Entra-TenantAdmins` | privileged | high | yes | no | none (breakglass-only) |
| `SG-Legal-Hold` | business | medium | yes | no | none (retained on leavers, RET-001) |

The skills never create, update or delete groups. A catalog group that does not resolve in the tenant stops the run with `group_not_found_in_tenant`.

## 6. Edit the policy for your domain

The demo policy is written for `contoso.local`. Three fields in `.claude/skills/entra-lifecycle-policy/policy/lifecycle-policy.json` pin that domain; change all three to a verified domain of your tenant, escaping the dots in the two regexes:

```json
"tenant": { "displayName": "Contoso (mock)", "primaryDomain": "contoso.local", "mcpServer": "entra-scim-mcp" }
```

```json
{ "id": "REQ-07", "subject": "source.worker.managerUserName", "op": "matches", "value": "^[^@\\s]+@contoso\\.local$" }
```

```json
"userName": { "template": "{givenName}.{familyName}@{primaryDomain}", "pattern": "^[a-z0-9]+(?:[.-][a-z0-9]+)*@contoso\\.local$", ... }
```

The same policy is embedded in `.claude/skills/entra-lifecycle-policy/SKILL.md` inside the ```` ```json policy ```` fence. Make the identical change there, bump `policyVersion` (keep the major version at 1), then confirm nothing drifted:

```bash
npm run validate
```

The demo source records and the seed name users at `contoso.local` (managers `patti.fernandez` and `megan.bowen`; targets `adele.vance`, `lidia.holloway`, `nestor.wilke`). Either create those users in your domain with the memberships and CSA values from `demo/seed/contoso-demo-seed.json`, or edit the records to name users you already have. `npm run seed:links` cannot help here: it refuses any non-loopback URL by design.

| Scenario | Users it needs in the tenant | State they must be in |
|---|---|---|
| S1 | none | The run makes no calls. |
| S2 | the manager named in `worker.managerUserName` | Active. `priya.natarajan@<domain>` and `externalId` `WD-000123` must not exist. |
| S3a | the target | Holds `SG-Finance-AP-Requestors`, does not hold `SG-Finance-AP-Approvers`. |
| S3b | the target and the new manager | Target in department `Finance` with `Employment.CostCenter` `FIN-110`, holding `All Employees`, `SG-Finance-Users`, `SG-Finance-AP-Requestors`, `SG-Finance-Treasury-Payments`. |
| S3c | the target | Holds `All Employees` and `SG-Engineering-Users`; `title` is `Software Engineer` (the record's `previous.worker.jobTitle`). |
| S4 | the target | Active, `Compliance.DataClassification` `Restricted`, `Compliance.LegalHold` `true`, holding `All Employees`, `SG-Engineering-Users`, `SG-Engineering-ProdDeploy`, `SG-Legal-Hold`. |

## 7. Tenant behaviours that differ from the mock

- **Password policy.** The joiner generates a random password of at least 16 characters with upper, lower, digit and symbol classes and uses it once. If your tenant's password policy or banned-password list rejects it, `provision_user` returns a 400 and the run stops before anything else is written.
- **Lifecycle Workflows.** `update_user_lifecycle` writes `employeeLeaveDateTime`. If Lifecycle Workflows are configured on that attribute, a leaver run can trigger them. Check before running S4 against a tenant that has workflows.
- **`deprovision_user` is a real soft delete.** The user goes to the recycle bin for 30 days, memberships are cascaded, and the UPN stays reserved until the object is purged. The skills only call it in `delete` mode, only after verification, only with an approval scoped `leaver:delete`, and never while `Compliance.LegalHold` is `true`. S4 as shipped is `immediate` mode and never calls it.
- **Verified domain.** `provision_user` fails with a 400 if the `userName` domain is not verified in the tenant. That is why step 6 matters.
- **CSAs in `get_user`.** The live API never returns them there. The skills already ignore that field on the mock, so nothing changes, but do not expect it in a live `get_user` result.

## 8. Cost

Every SCIM Provisioning API call is billed, reads included, and the server does not batch beyond what the API requires. The skills count every call against a budget and print `Tool calls: n of budget` at the end of each run. Expected counts for one pass:

| Scenario | Calls | Of which writes |
|---|---|---|
| S1 joiner blocked | 0 | 0 |
| S2 joiner corrected | 15 | 7 |
| S3a mover denied | 5 | 0 |
| S3b mover transfer | 15 | 6 |
| S3c mover title change | 6 | 1 |
| S4 leaver (immediate) | about 11 | 5 |
| Full pass | about 53 | 19 |

A model that takes a wrong turn and stops early costs fewer calls, not more: every orchestrator stops on the first error and the budget caps the worst case at 20 (joiner, mover) or 25 (leaver) per run.

## 9. Rehearse first

Before enabling the live entry, run each scenario once through `entra-scim-rehearsal`. It starts the server with `ENTRA_SCIM_DRY_RUN=1` and no credentials, and every tool, reads included, returns `{ "dryRun": true, "request": { ... } }` showing the exact request that would go to `https://graph.microsoft.com/rp/scim`. The skills classify such a run as `rehearsal` and skip verification. It cannot resolve ids or complete a scenario; what it proves is that the request shapes, paths and URNs are what you expect before a single billed call.

In Claude Code, start the rehearsal profile on its own from the repo root: `claude --mcp-config demo/mcp/rehearsal.mcp.json --strict-mcp-config`. In MCPJam, add a second STDIO server with command `npx`, args `-y entra-scim-mcp@0.3.0` and one variable, `ENTRA_SCIM_DRY_RUN` = `1`, and enable only that one for the rehearsal chat.

`npm run verify:sequences` is not a live tool. It refuses non-loopback URLs because it writes to whatever it is pointed at.

## 10. Run live

```bash
npm install
```

In Claude Code, from the repo root, start the live profile and nothing else:

```bash
claude --mcp-config demo/mcp/live.mcp.json --strict-mcp-config
```

`demo/mcp/live.mcp.json` runs `node scripts/mcp-live.mjs` by relative path, so the working directory must be the repo root. If `.env` is missing the launcher exits naming the missing variables and Claude Code reports the server as failed to connect. Otherwise the launcher prints to stderr which variables it loaded, the tenant id, the base URL and whether it is using a secret or a certificate, then starts the published server. Invoke the skills exactly as against the mock. Confirm `Tool calls` in each summary against the table above.

## 11. Clean up

1. **S2 created a user.** Disable it, then delete it. The deletion is a 30-day soft delete; the UPN stays reserved until the object is permanently deleted from **Deleted users** in the portal or purged automatically after 30 days.
2. **S3b changed a user.** Reset department, manager, title and `Employment.CostCenter`, and restore the memberships from the S3b row in step 6, or delete the user if it was a throwaway.
3. **S4 disabled a user.** The account is disabled with an `employeeLeaveDateTime` set and still holds `SG-Legal-Hold`. Re-enable it and clear the leave date, or delete it.
4. **Groups** can be deleted or kept. Nothing in the skills depends on their ids.
5. **CSA sets** cannot be deleted. Deactivate the attributes and sets if you do not want them, or leave them; inactive attributes cannot be assigned.
6. **Secrets.** Delete `.env` when finished, and rotate or delete the client secret in the app registration if the run was a one-off. Remove the app registration if nothing else uses it.
