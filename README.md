# entra-lifecycle-guardrails

Joiner, mover and leaver governance for Entra ID, delivered as six markdown-only Agent Skills that sit above the `entra-scim-mcp` MCP server.

## What this is

An MCP server gives an agent tools; it does not tell the agent when a call is a bad idea. [entra-scim-mcp](https://github.com/darrenjrobinson/entra-scim-mcp) exposes the Entra SCIM Provisioning API as 18 validated stdio tools and will create a user, add a member or soft-delete an account whenever it is asked. This repo adds the layer above it: a **governance plane** of six [Agent Skills](https://agentskills.io) that decide what should happen, in what order and with what evidence, before the **execution plane** (the MCP server) is touched. The split is deliberate. The skills know the policy and never speak HTTP; the server knows SCIM and never reads the policy.

The skills read one tenant policy file, validate the HR record, evaluate every requested group against a catalog, separation-of-duties rules, privileged-group rules and Custom Security Attribute (CSA) gates, render a preview of the exact tool calls, stop for an approval reference plus an operator confirmation, execute in policy order, verify with reads, and end with a structured decision record. A record that fails validation is blocked with zero tool calls. Entra CSAs are the policy signal throughout: a missing `Compliance.DataClassification` blocks a joiner, a `CostCenter` change strips a treasury entitlement, and `LegalHold = true` prevents a delete.

The MCP server is unchanged and is not re-explained here. Its tools, the API behaviours it enforces, its local mock and live-tenant testing are documented in the [entra-scim-mcp README](https://github.com/darrenjrobinson/entra-scim-mcp). The npm package is `entra-scim-mcp` (0.2.1, stdio only); the earlier working name `@darrenjrobinson/entra-scim-mcp` does not exist. The demo runs entirely against the package's local mock. How the planes fit together, with diagrams, is in [docs/architecture.md](docs/architecture.md).

## The six skills

Skills live at `.claude/skills/<name>/SKILL.md` and follow the [Agent Skills](https://agentskills.io) spec: YAML frontmatter, a markdown body, optional `references/` and `policy/` files. No scripts.

| Skill | What it does | Tool calls it makes |
|---|---|---|
| `entra-lifecycle-policy` | Data only. Holds the tenant policy (`policy/lifecycle-policy.json`, also embedded in its SKILL.md), the policy schema, the decision-record schema and example, and the field glossary. Loaded first by every other skill. | none |
| `entitlement-guardrail` | Evaluates each requested group: catalog, privileged rules, CSA gates, SoD on the resulting membership set, approval refs, cost estimate. Returns `allow`, `allow_with_approval`, `deny` or `require_manual_review` per group. | none when embedded by an orchestrator; up to 4 reads standalone (`list_users`, `list_groups`, `get_user_custom_security_attributes`), budget 6 |
| `identity-change-auditor` | Turns the transcript into one decision record (JSON) plus a plain summary. Classifies the outcome and refuses `completed` without verification evidence. | none |
| `joiner-orchestrator` | Validate the record and mandatory CSAs, apply naming standards, resolve manager and groups, guardrail, preview, gate, `provision_user` inactive, set CSAs, add groups, verify, activate, audit. | `list_groups`, `list_users`, `provision_user`, `update_user_custom_security_attributes`, `add_group_members`, `get_user`, `get_user_custom_security_attributes`, `update_user`; budget 20 |
| `mover-orchestrator` | Read current state, diff against the record, re-evaluate held groups' CSA gates, guardrail, preview, gate, `update_user`, CSA write, removes then adds, verify, before/after audit. | `list_users`, `get_user`, `get_user_custom_security_attributes`, `list_groups`, `update_user`, `update_user_custom_security_attributes`, `remove_group_member`, `add_group_members`; budget 20 |
| `leaver-orchestrator` | Take the mode from the record (`scheduled`, `immediate`, `delete`), disable, set `employeeLeaveDateTime`, remove non-retained groups one call each in policy order, verify residual access, deprovision only with approval and no legal hold, audit. | `list_users`, `get_user`, `list_groups`, `get_user_custom_security_attributes`, `update_user`, `update_user_lifecycle`, `remove_group_member`, `deprovision_user`; budget 25 |

A seventh skill, `breakglass-approval`, is planned for v2 and is not included.

## How a run looks

Every orchestrator follows the same eight steps. The first two make no tool calls, so a bad record never reaches the tenant.

| # | Step | Tool calls | What happens |
|---|---|---|---|
| 1 | Validate | 0 | Load the policy and quote `policyId` and `policyVersion` in check row CHK-01. Check the source system, record id pattern, required attributes and mandatory CSAs. |
| 2 | Guardrail | 0 | Per requested group: catalog, privileged rules, CSA gates, SoD on the resulting set, approvals. Denied groups are skipped; a missing required attribute denies the run. |
| 3 | Resolve | reads | `list_groups` once for the catalog, filtered `list_users` for the target, the manager and duplicates. Ids are resolved every run and never stored. |
| 4 | Preview | 0 | A numbered table of every call that would be made, with the ids resolved in this run and the policy path that justifies each row. Passwords render as `<generated, not shown>`. |
| 5 | Gate | 0 | Medium or high risk needs an approval ref (`^(CHG\|REQ\|INC)-[0-9]{5,}$`, scoped, matching the record) and the operator must reply exactly `approve <correlationId>`. The turn ends here. |
| 6 | Execute | writes | In policy order, stopping on the first error. Joiners are created `active: false`. One `remove_group_member` per membership. |
| 7 | Verify | reads | `get_user`, `get_user_custom_security_attributes`, `list_groups` filtered on `members.value`. No verification read, no `completed`. |
| 8 | Audit | 0 | `identity-change-auditor` emits a summary, a `Tool calls: n of budget` line and one fenced JSON decision record. Blocked and rehearsal runs get a record too. |

Scenario S1 stops after step 2 with `Tool calls: 0 of 20` and a complete decision record.

## Prerequisites

- Node.js 20 or later (`package.json` sets `engines.node >= 20`; CI runs 22) and npm.
- An agent host: [MCPJam Inspector](https://www.npmjs.com/package/@mcpjam/inspector), launched locally with `npx`, or [Claude Code](https://claude.com/claude-code).
- No Entra tenant. The demo runs against the mock that ships inside `entra-scim-mcp`.

`npm install` pins `entra-scim-mcp@0.2.1` (the MCP server and the `entra-scim-mock-server` binary), `@modelcontextprotocol/sdk`, `ajv-cli` and `ajv-formats`. It is needed for `npm run mock`, `npm run validate:policy`, `npm run verify:sequences` and the live launcher. `npm run seed:links` and `npm run validate:skills` have no dependencies.

## Start the demo tenant

The demo tenant is `contoso.local`: 8 users, 10 groups, two CSA sets (`Employment`, `Compliance`). Use two terminals from the repo root.

Terminal 1 starts the mock with the seed file:

```bash
npm install
npm run mock
```

Look for these lines:

```text
entra-scim-mock-server listening on http://127.0.0.1:8990
mode: strict Entra
seeded: 8 user(s), 10 group(s)
```

Without `npm install`, the same mock starts with:

```bash
npx -y --package entra-scim-mcp@0.2.1 entra-scim-mock-server --seed demo/seed/contoso-demo-seed.json
```

Terminal 2 wires the manager links and group memberships, which the mock cannot take from a seed file (see [Design notes](#design-notes)):

```bash
npm run seed:links
```

Expected:

```text
seed-links: applied 6 manager link(s) and 24 membership(s) in 9 PATCH call(s)
```

followed by a table of the 10 groups with their member userNames and the 6 manager links, read back from the mock. The script is idempotent, waits up to 10 seconds for the mock to come up, and refuses any non-loopback URL.

To reset the tenant (after S2 or S4, or whenever you want fresh ids): `Ctrl+C` in terminal 1, `npm run mock` again, then `npm run seed:links` again. Every boot assigns new ids, so start a new chat in your agent host after a reset.

`npm run mock:capture` is the same mock with `--capture captures/demo-session.jsonl`, which logs every request and response (the folder is gitignored).

## Run it in MCPJam Inspector

MCPJam Inspector scans `./.claude/skills/` from the directory it is launched in (and `~/.claude/skills`, so personal skills appear too). Use the local inspector; stdio servers are not reachable from the hosted web app. The full click path and a pre-flight checklist are in [docs/mcpjam-walkthrough.md](docs/mcpjam-walkthrough.md).

1. With the mock and links up, launch from the repo root (`npm run inspector` is the same command):

   ```bash
   npx @mcpjam/inspector@latest
   ```

2. **Servers** tab, add a server, transport **STDIO**, command `npx`, args `-y entra-scim-mcp@0.2.1`. Under **Environment Variables** use **Add Variable** twice: `ENTRA_SCIM_BASE_URL` = `http://127.0.0.1:8990` and `ENTRA_SCIM_STATIC_TOKEN` = `dev-token`. Connect and confirm **18 tools**.
3. **Playground**. In the model picker, the **Free models** tab needs no API key. Pick a Claude Sonnet- or Opus-class model at temperature 0. Small models do not follow the skills reliably.
4. Press `+` on the chat input to enable the server (the same control shows the system prompt).
5. Type `/` and pick `joiner-orchestrator` from the **SKILLS** section. Picking a skill injects only its SKILL.md; the model can also call `loadSkill`, `listSkillFiles` and `readSkillFile` itself. Optionally also pick `entra-lifecycle-policy`: its SKILL.md embeds the policy, which saves the model a `loadSkill` call.
6. Paste the prompt from a scenario file and send. When the gate line appears, reply with `approve <correlationId>` copied from it.
7. Switch between **Chat**, **Trace** (a timestamped timeline of tool calls with latency and tokens) and **Raw** (the exact model payload, including the system prompt and tool definitions).

MCPJam caps the skill catalog at roughly 8,000 characters of names plus descriptions. This pack uses about 2,650; `npm run validate:skills` prints the current total.

## Run it in Claude Code

Start Claude Code from the repo root:

```bash
claude
```

`.mcp.json` defines three servers with identical tool names, so keep only one enabled at a time (use `/mcp` to switch):

| Server | Target | Enabled by default |
|---|---|---|
| `entra-scim-mock` | the local mock (`ENTRA_SCIM_BASE_URL` and `ENTRA_SCIM_STATIC_TOKEN` inline) | yes, pre-approved by `.claude/settings.json` `enabledMcpjsonServers` |
| `entra-scim-rehearsal` | nothing: `ENTRA_SCIM_DRY_RUN=1`, no tenant contact | no |
| `entra-scim-live` | a real tenant through `scripts/mcp-live.mjs` and `.env` | no |

Skills under `.claude/skills/` are picked up as project skills. Invoke one by name and paste the record from a scenario file:

```text
/joiner-orchestrator
Onboard this new hire. Source record follows.
{ ...the S2 record from demo/scenarios/S2-joiner-corrected.md... }
```

Reply `approve <correlationId>` when the preview asks. `/mover-orchestrator` and `/leaver-orchestrator` work the same way.

If Claude Code cannot spawn `npx` on Windows, change the mock and rehearsal entries in `.mcp.json` to:

```json
{ "command": "cmd", "args": ["/c", "npx", "-y", "entra-scim-mcp@0.2.1"] }
```

## The four scenarios

Each scenario file holds the verbatim prompt, the approval turn where there is one, the expected check rows, the expected calls and a Trace-view checklist. Source records are in `demo/source-records/`. Restart the mock before re-running any scenario that writes.

| Scenario | Skill | Record | Expected outcome | Tool calls |
|---|---|---|---|---|
| [S1 joiner blocked](demo/scenarios/S1-joiner-blocked.md) | `joiner-orchestrator` | `S1-priya-natarajan-incomplete.json` | `deny` / `blocked`. `Compliance.DataClassification` is missing (REQ-CSA-03). The four requested groups show all four guardrail outcomes: AP-Requestors allow, AP-Approvers deny (SOD-FIN-001), Treasury-Payments allow_with_approval satisfied by CHG-40012, TenantAdmins deny (breakglass-only). | 0 of 20 |
| [S2 joiner corrected](demo/scenarios/S2-joiner-corrected.md) | `joiner-orchestrator` | `S2-priya-natarajan-corrected.json` | Preview, operator replies `approve <correlationId>`, create inactive, CSAs, four adds, three verification reads, activate. `allow_with_approval` / `completed`. | 15 of 20 |
| [S3a mover denied](demo/scenarios/S3-mover.md) | `mover-orchestrator` | `S3a-adele-vance-sod.json` | Adele already holds AP-Requestors; adding AP-Approvers is denied by SOD-FIN-001 even though the approval REQ-50017 is valid. `deny` / `blocked`, reads only. | 5 of 20 |
| [S3b mover transfer](demo/scenarios/S3-mover.md) | `mover-orchestrator` | `S3b-lidia-holloway-transfer.json` | Lidia moves Finance to Engineering, manager to Megan, CostCenter FIN-110 to ENG-210. Treasury-Payments is removed because its CSA gate (`startsWith "FIN-"`) no longer holds; the old department group and the requested removal go too; Engineering-Users is added. `completed`. | 15 of 20 |
| [S4 leaver](demo/scenarios/S4-leaver.md) | `leaver-orchestrator` | `S4-nestor-wilke-leaver.json` | Immediate mode. Disable, set leave date, remove ProdDeploy first (privileged), then Engineering-Users, then All Employees. `SG-Legal-Hold` is retained by RET-001. `LegalHold = true` would block a `delete`. No `deprovision_user`. `completed`. | about 11 of 25 |

## Rehearsal mode

`entra-scim-rehearsal` starts the same server with `ENTRA_SCIM_DRY_RUN=1` and no credentials. Every tool runs its client-side validation and then returns `{ "dryRun": true, "request": { ... } }` instead of sending anything. That applies to reads as well as writes, so a rehearsal cannot resolve ids or complete a scenario; what it shows is the exact request each call would produce. The skills treat any `dryRun: true` result as outcome `rehearsal` and skip verification.

Use it before pointing at a real tenant, or to show request shapes without a mock. Enable it with `/mcp` in Claude Code and disable `entra-scim-mock` while it is on.

## Live tenant

Everything above is free and offline. Against a real tenant every SCIM call is billed, `deprovision_user` is a real 30-day soft delete, and the CSA sets and groups the policy names must exist first. Read [docs/live-tenant-setup.md](docs/live-tenant-setup.md), then:

```bash
npm install
cp .env.example .env
```

Fill in the tenant id, client id and either a client secret or a certificate path. Enable `entra-scim-live` in `/mcp` and disable the other two. The launcher `scripts/mcp-live.mjs` loads `.env`, refuses to start when `ENTRA_SCIM_STATIC_TOKEN` or `ENTRA_SCIM_DRY_RUN=1` is set, and requires exactly one of `ENTRA_CLIENT_SECRET` or `ENTRA_CLIENT_CERT_PATH`. Rehearse first.

## Validate and verify

```bash
npm run validate            # validate:skills, then validate:policy
npm run validate:skills     # zero-dep: frontmatter, embedded-policy drift, cross-references, seed
npm run validate:policy     # ajv draft2020 + ajv-formats: policy vs schema, decision records vs schema
```

`validate:skills` checks each SKILL.md (name equals its directory and matches `^[a-z0-9]+(-[a-z0-9]+)*$`, description 1 to 1024 characters, non-empty body), that the ```` ```json policy ```` block in `entra-lifecycle-policy/SKILL.md` is identical to `policy/lifecycle-policy.json`, that every group named in `sodRules`, `privilegedGroups`, `approvedBaselineProfiles` and `retainedAccessRules` exists in `groupCatalog`, that every CSA `set` is declared in `customSecurityAttributes.attributeSets`, that `costThresholds.maxToolCallsPerRun` keys are exactly the five consuming skills, and that the demo seed uses only catalog groups and seeded users. `validate:policy` validates `policy/lifecycle-policy.json` against `lifecycle-policy.schema.json`, and `policy/decision-record.example.json` plus `demo/expected/*.decision-record.json` against `decision-record.schema.json`. CI (`.github/workflows/validate.yml`) runs both on every push and pull request.

To prove that the call sequences the skills prescribe are accepted end to end, with no LLM in the loop, run the verifier against a fresh mock with links applied:

```bash
npm run verify:sequences
```

It spawns `npx -y entra-scim-mcp@0.2.1` as an MCP client, asserts the tool count, and runs S2, the S3a precondition, S3b and S4 with the argument shapes from the skills' `references/tool-sequences.md`:

```text
tools: 18 (expected 18)
S2 joiner OK in 15 calls
S3a mover precondition OK in 2 calls
S3b mover OK in 15 calls
S4 leaver OK in 12 calls
verify-tool-sequences: all scenarios OK
```

Each `OK` line is followed by a per-tool breakdown. S4 is one call over the skill's 11 because the verifier also proves that a repeated removal returns 404. The verifier writes to whatever it is pointed at, so it refuses non-loopback URLs. Re-running it on a dirty mock fails with `priya.natarajan@contoso.local already exists: restart the mock`; restart the mock and re-run `npm run seed:links` between runs.

## Repo layout

```text
entra-scim-mcp-skills/
├── .claude/
│   ├── settings.json                 pre-approves entra-scim-mock (enabledMcpjsonServers)
│   └── skills/
│       ├── entra-lifecycle-policy/   SKILL.md (embeds the policy) · policy/{lifecycle-policy.json, lifecycle-policy.schema.json,
│       │                             decision-record.schema.json, decision-record.example.json} · references/{policy-fields.md, source-record.md}
│       ├── entitlement-guardrail/    SKILL.md · references/evaluation-algorithm.md
│       ├── identity-change-auditor/  SKILL.md · references/{record-template.md, examples.md}
│       ├── joiner-orchestrator/      SKILL.md · references/tool-sequences.md
│       ├── mover-orchestrator/       SKILL.md · references/tool-sequences.md
│       └── leaver-orchestrator/      SKILL.md · references/tool-sequences.md
├── .github/workflows/validate.yml    npm ci, validate:skills, validate:policy on push and pull request
├── .mcp.json                         Claude Code servers: entra-scim-mock, entra-scim-rehearsal, entra-scim-live
├── .env.example                      variable names for the live launcher, no values
├── demo/
│   ├── seed/contoso-demo-seed.json   8 users and 10 groups for --seed; x-managers and x-memberships for seed-links
│   ├── scripts/seed-links.mjs        zero-dep: resolves names to this boot's ids, PATCHes managers and members, prints the table
│   ├── source-records/               S1, S2, S3a, S3b and S4 input records
│   ├── scenarios/                    S1-joiner-blocked.md, S2-joiner-corrected.md, S3-mover.md, S4-leaver.md
│   └── expected/                     decision records captured from end-to-end runs, validated by validate:policy
├── docs/
│   ├── architecture.md               governance vs execution plane, the S2 sequence, the audit contract
│   ├── mcpjam-walkthrough.md         click path, pre-flight checklist, what to look for in Trace view
│   └── live-tenant-setup.md          permissions, CSA definitions, groups, domain swap, cost, cleanup
├── scripts/
│   ├── mcp-live.mjs                  .env-driven launcher for a real tenant; refuses static token and dry-run
│   ├── lib/dotenv.mjs                minimal .env loader used by mcp-live.mjs
│   ├── validate-skills.mjs           zero-dep validator
│   └── verify-tool-sequences.mjs     MCP-client run of the scenario call sequences against the mock
├── package.json                      private; scripts and pinned devDependencies
└── LICENSE                           MIT
```

## Design notes

**Markdown only.** The skills contain no code. Everything the model needs is text it can read in either host: MCPJam's playground exposes `loadSkill`, `listSkillFiles` and `readSkillFile`; Claude Code has the Skill tool and Read. A skill that shells out would work in one host and not the other, and would hide logic that the reader of a decision record should be able to trace back to a policy path.

**The policy is a skill.** `entra-lifecycle-policy` is a data-only skill so that the policy is loaded exactly the way the other skills are, in both hosts, and versions with the pack. Its SKILL.md embeds the policy JSON in a ```` ```json policy ```` fence, so picking the skill with `/` in MCPJam puts the whole policy in context without a file read. `validate:skills` fails if the embedded copy drifts from `policy/lifecycle-policy.json`. Every other skill starts with the same Step 0 and stops with `policy_unavailable` if `policyVersion` is not major version 1.

**Ids are never stored.** The policy, seed, source records and skill examples use display names and userNames only. The mock assigns fresh ids on every boot, and a live tenant's ids differ from any example. Every run resolves ids with `list_groups` and filtered `list_users`, cites the call number as evidence, and never reuses an id from an earlier turn.

**Dry-run cannot be per call.** `entra-scim-mcp` reads `ENTRA_SCIM_DRY_RUN` at startup; there is no per-call flag, and no `correlationId`, `changeReason` or `approvalRef` input on any tool. So the preview is a rendered plan with zero calls, the correlation id lives only in the decision record (while `externalId` on `provision_user` carries the HR record id), and rehearsal is a separate server entry rather than a mode a skill can switch on.

**Memberships are wired by a script.** The mock's seed loader discards seed-supplied ids, and a `members[]` array on a seeded group aborts the boot, so managers and memberships cannot be expressed in `contoso-demo-seed.json`. They sit in `x-managers` and `x-memberships`, which the mock ignores and `demo/scripts/seed-links.mjs` applies after boot by resolving names to that boot's ids. The upstream improvement would let the mock's `store.seed()` resolve `members[].value` and enterprise `manager.value` by userName so that `--seed` alone wires them; that would remove the script.

**CSAs are read only through the dedicated tool.** The mock returns a CustomSecurityAttributes object in plain `get_user`; the live API never does. The skills trust only `get_user_custom_security_attributes` (`customSecurityAttributes.trustOnlyDedicatedRead`), so a run that passes on the mock behaves the same on a tenant.

## Not in v1

The `breakglass-approval` skill (v2), helper tools inside the MCP server, HTTP transport, MCPJam eval suites, YAML policy, nested groups, automated rollback, a resume mode for partially provisioned joiners, userName renames, and Graph-based restore of soft-deleted users.

## License

MIT. Copyright (c) 2026 Darren J Robinson. See [LICENSE](LICENSE).
