# MCPJam Inspector walkthrough

Click by click, from an empty terminal to a completed scenario in MCPJam Inspector's playground, against the local mock. Labels are the ones the inspector shows. The short version is in the README; the scenario prompts are in `demo/scenarios/`.

## Before you start

MCPJam Inspector is launched locally with `npx`. It scans `./.claude/skills/` from the directory it is launched in, and also `~/.claude/skills`, so personal skills you keep there appear in the picker next to the six from this repo and count toward the same catalog budget. Stdio servers are not reachable from the hosted web app, so always use the local inspector.

One boot of the mock supports one pass through S1, S2, S3a, S3b and S4. Restart the mock (and re-run `npm run seed:links`) before re-running any scenario that writes, and start a new chat afterwards because the ids change.

## Pre-flight checklist

| # | Check | How |
|---|---|---|
| 1 | Mock is up with the seed | Terminal 1, repo root: `npm run mock` (or `npm run mock:capture` to also log every request to `captures/demo-session.jsonl`). Look for `entra-scim-mock-server listening on http://127.0.0.1:8990`, `mode: strict Entra`, `seeded: 8 user(s), 10 group(s)`. |
| 2 | Links applied | Terminal 2, repo root: `npm run seed:links`. Look for `seed-links: applied 6 manager link(s) and 24 membership(s) in 9 PATCH call(s)` and the membership table below it. |
| 3 | Server connected, 18 tools | Servers tab shows the STDIO server connected and lists 18 tools. |
| 4 | Six skills discovered | Playground, Raw view: the system prompt lists the six skills by name and description. The skill catalog is roughly 2,650 characters against a cap of about 8,000. |
| 5 | Policy readable | Send the smoke prompt `Load entra-lifecycle-policy and quote policyId and policyVersion`. Expect `contoso-lifecycle-policy` and `1.0.0`. |
| 6 | Fresh ids | If the mock was restarted after the chat began, start a new chat. Ids regenerate on every boot; the skills refuse to reuse ids from earlier turns, but a stale transcript still costs the model context and tool calls. |

## Step 1: start the demo tenant

Two terminals, both from the repo root.

```bash
npm install
npm run mock
```

```bash
npm run seed:links
```

The second command waits up to 10 seconds for the mock, applies the links, and prints what the mock now holds:

```text
seed-links: applied 6 manager link(s) and 24 membership(s) in 9 PATCH call(s)

Group memberships as read back from the mock (10 groups; userNames shown as local parts):
  All Employees                 patti.fernandez, megan.bowen, adele.vance, lidia.holloway, diego.siciliani, alex.wilber, nestor.wilke
  ...
```

## Step 2: launch the inspector

From the repo root, so the skills are discovered:

```bash
npx @mcpjam/inspector@latest
```

`npm run inspector` runs the same command. The inspector opens in your browser.

## Step 3: add the mock server

1. Open the **Servers** tab.
2. Add a server and choose transport **STDIO**.
3. Name it `entra-scim-mock`.
4. Command: `npx`. Args: `-y entra-scim-mcp@0.2.1`.
5. Under **Environment Variables**, click **Add Variable** and enter `ENTRA_SCIM_BASE_URL` with value `http://127.0.0.1:8990`. Click **Add Variable** again and enter `ENTRA_SCIM_STATIC_TOKEN` with value `dev-token`.
6. Connect. The server should show **18 tools**.

If the count is not 18, or the connection fails, check that the mock is listening (terminal 1) and that the two variables are spelled exactly as above. The static-token mode requires `ENTRA_SCIM_BASE_URL` and refuses any Microsoft host, so a typo in the URL fails the connection rather than reaching the internet.

## Step 4: set up the playground

1. Open **Playground**.
2. In the model picker, open the **Free models** tab. No API key is needed. Choose a Claude Sonnet- or Opus-class model. Set temperature to 0. Do not use small models; they skip steps, invent ids or answer `approve` themselves.
3. Press `+` on the chat input. This toggles which servers are enabled for the chat and shows the system prompt. Enable `entra-scim-mock`.
4. Switch to the **Raw** view and confirm the system prompt lists the six skills. Switch back to **Chat**.
5. Send the smoke prompt:

   ```text
   Load entra-lifecycle-policy and quote policyId and policyVersion
   ```

   Expect `contoso-lifecycle-policy` and `1.0.0`. In the **Trace** view you should see one `loadSkill` call.

## Step 5: pick a skill and run a scenario

1. Type `/` in the chat input. A picker opens with a **SKILLS** section listing the discovered skills.
2. Pick the orchestrator for the scenario: `joiner-orchestrator` for S1 and S2, `mover-orchestrator` for S3a and S3b, `leaver-orchestrator` for S4. Picking a skill injects only its SKILL.md into the conversation. The model also has `loadSkill`, `listSkillFiles` and `readSkillFile` tools, which it uses to load `entra-lifecycle-policy`, `entitlement-guardrail` and `identity-change-auditor` as the orchestrator instructs.
3. Optionally also pick `entra-lifecycle-policy`. Its SKILL.md embeds the whole policy, which saves the model one `loadSkill` call. Do not pick the guardrail or auditor by hand; the orchestrator loads them when it needs them.
4. Paste the prompt block from the scenario file and send.
5. For S2, S3b and S4 the first turn ends with a gate line. Copy the correlation id from it and send exactly:

   ```text
   approve elg-WD-000123-xxxxxx
   ```

   with the real id. Anything else (`yes`, `go ahead`, `approve` with a different id) must not continue the run.

## Step 6: read the three views

- **Chat**: the check table, the preview, the gate line, the summary, the `Tool calls: n of budget` line and the fenced JSON decision record. This is what the skill is contractually required to print.
- **Trace**: a timestamped timeline of every tool call with latency and tokens. This is where you prove the order of operations and count the calls. The arguments of each call are visible here, which is also why the demo uses a throwaway mock: the `provision_user` call shows the generated password in its arguments even though the chat and the record never do.
- **Raw**: the exact payload sent to the model, including the system prompt with the skill catalog and every tool definition. Useful for showing what the model was actually told.

## What to look for in Trace view

### S1 joiner blocked

- No call to any `entra-scim-mcp` tool. `loadSkill` and `readSkillFile` calls are fine; `list_users`, `list_groups`, `provision_user` and the rest must be absent.
- In Chat: a check table with CHK-01 quoting `contoso-lifecycle-policy v1.0.0`, a `fail` row for REQ-CSA-03, and one row per requested group with the four outcomes (AP-Requestors allow, AP-Approvers deny SOD-FIN-001, Treasury-Payments allow_with_approval satisfied by CHG-40012, TenantAdmins deny breakglass-only). No preview, no gate. `Tool calls: 0 of 20`. Record with `decision: deny`, `outcome: blocked`, `toolCalls.count: 0`, empty `executedActions`.

### S2 joiner corrected

- Turn 1 ends after exactly four calls: `list_groups`, then `list_users` three times (externalId, manager, userName). Then the preview and the gate line.
- Turn 2: exactly one `provision_user` with `active: false` and `externalId: WD-000123`. Then `update_user_custom_security_attributes` before any `add_group_members`. Four `add_group_members`, each with one member id. Then `get_user`, `get_user_custom_security_attributes` and `list_groups` (filter `members.value`). The last two calls are `update_user` (activate) and `get_user` with `attributes: ["active"]`.
- Absent: `create_group`, discovery tools, unfiltered `list_users`.
- Chat: `Tool calls: 15 of 20 (8 reads, 7 writes)`, `outcome: completed`, four `verificationFindings.proved` entries, `approvals[0].used: true`.

### S3a mover denied

- Five reads and nothing else: `list_users` (Adele), `get_user`, `get_user_custom_security_attributes`, `list_groups` filtered on `members.value`, `list_groups` (catalog).
- Absent: `update_user`, `add_group_members`, `remove_group_member`.
- Chat: a `sodRules[SOD-FIN-001]` row with `fail` and `deny (sod_conflict)` citing the membership call; no gate; `Tool calls: 5 of 20 (5 reads, 0 writes)`; the approval shown `valid: true`, `used: false`.

### S3b mover transfer

- Turn 1: six reads (`list_users` twice, `get_user`, `get_user_custom_security_attributes`, `list_groups` twice), then the before/after line, the preview and the gate.
- Turn 2: one `update_user` carrying the department, manager and title replace operations, and it precedes every membership change. Then the CSA write. Then `remove_group_member` three times (`SG-Finance-Users`, `SG-Finance-AP-Requestors`, `SG-Finance-Treasury-Payments`) before one `add_group_members` (`SG-Engineering-Users`). Then the three verification reads; the final `list_groups` returns exactly `All Employees` and `SG-Engineering-Users`.
- Absent: any call touching `SG-Legal-Hold` or a group Lidia does not hold; `mailNickname` or `userName` in any PATCH.
- Chat: a `warn` row for `groupCatalog[SG-Finance-Treasury-Payments].requiresCsa` with `csa_condition_failed`; `Tool calls: 15 of 20`; record with `details.before` and `details.after`.

### S4 leaver

- Turn 1: four reads (`list_users`, `get_user`, `list_groups` filtered on `members.value`, `get_user_custom_security_attributes` with `attributeSets: ["Compliance"]`), then the preview with a `(retained) SG-Legal-Hold` row and the gate.
- Turn 2: `update_user` (disable) first, `update_user_lifecycle` second with `employeeLeaveDateTime: "2026-09-20T09:00:00Z"`, then `remove_group_member` three times with `SG-Engineering-ProdDeploy` first, each with one `memberId`. Then `list_groups` returning exactly `SG-Legal-Hold` and `get_user` with `active: false`.
- Absent: any call for `SG-Legal-Hold`; `deprovision_user`; extra per-group lookups (the ids come from the earlier membership read).
- Chat: `Tool calls: 11 of 25 (6 reads, 5 writes)`; `details.retained: ["SG-Legal-Hold"]`, `details.residual: []`.

## Screenshot suggestions for the blog

1. **Servers** tab with `entra-scim-mock` connected and the 18-tool list expanded.
2. The `/` picker open on the **SKILLS** section showing the six skills.
3. **Raw** view scrolled to the skill catalog in the system prompt, to show what "markdown-only skills" means in practice.
4. S1 in **Chat**: the check table with the REQ-CSA-03 `fail` row and the four group rows, followed by `Tool calls: 0 of 20`.
5. S1 in **Trace**: only `loadSkill` calls, no MCP tools. The picture that makes the "zero calls" claim.
6. S2 turn 1 in **Chat**: the execution preview and the gate line asking for `approve elg-WD-000123-...`.
7. S2 turn 2 in **Trace**: the full 15-call timeline. Crop or blur the `provision_user` arguments; they contain the password.
8. S3b in **Chat**: the `warn` row that removes Treasury-Payments on a CSA change nobody requested, and the before/after line.
9. S3b in **Trace**: `update_user` first, three removals before the addition.
10. S4 in **Trace**: `SG-Engineering-ProdDeploy` removed first, no call for `SG-Legal-Hold`, no `deprovision_user`.
11. The decision record JSON in **Chat** for S4, showing `details.retained` and a residual-risk entry for the legal hold.

If you ran the mock with `npm run mock:capture`, `captures/demo-session.jsonl` holds every raw SCIM request and response for the session, which is useful for a "what actually went over the wire" figure.
