# MCPJam Inspector walkthrough

Click by click, from an empty terminal to a completed scenario in MCPJam Inspector's playground, against the local mock. Labels are the ones the inspector shows. The short version is in the README; the scenario prompts are in `demo/scenarios/`.

## Before you start

MCPJam Inspector is launched locally with `npx`. It scans `~/.claude/skills/`, `~/.mcpjam/skills/` and `~/.agents/skills/` for skills, plus `.claude/skills/`, `.mcpjam/skills/` and `.agents/skills/` under its server's working directory. In 3.13.0 that working directory is the installed inspector package, not the folder you launched from, so the seven skills in this repo are **not** found by a plain `npx @mcpjam/inspector` run from the repo root. `npm run inspector` works around it: it copies the seven skill folders into `~/.mcpjam/skills/` (real folders only; MCPJam skips symlinks and junctions), writes a copy of `.mcp.json` with absolute paths, and starts the inspector with `--config` so both demo servers connect on their own. `npm run inspector -- --clean` removes the copies again. Skills served by a connected MCP server (Skills over MCP) are listed in the same catalog under **From MCP servers**. Personal skills appear in the picker next to the seven from this repo and count toward the same catalog budget. Stdio servers are not reachable from the hosted web app, so always use the local inspector.

This walkthrough was verified on Inspector **3.13.0** (2026-10-07; the recordings in `demo/recordings/video/` were made the same way). `npm run inspector` pins that version; `@latest` works too, but menu labels may differ, and a later version may fix the discovery quirk above.

One boot of the mock supports one pass through S1, S2, S3a, S3b, S3c and S4. Restart the demo tenant (`npm run demo:up`) before re-running any scenario that writes, and start a new chat afterwards because the ids change.

## Pre-flight checklist

| # | Check | How |
|---|---|---|
| 1 | Mock is up with the seed | Repo root: `npm run demo:up` (or `npm run mock` in one terminal and `npm run seed:links` in another; `npm run mock:capture` also logs every request to `captures/demo-session.jsonl`). Look for `entra-scim-mock-server listening on http://127.0.0.1:8990`, `mode: strict Entra`, `seeded: 8 user(s), 10 group(s)`. |
| 2 | Links applied | Further down the same output (or from `npm run seed:links`): `seed-links: applied 6 manager link(s) and 24 membership(s) in 9 PATCH call(s)` and the membership table below it. |
| 3 | Servers connected, 18 + 1 tools | Servers tab shows `entra-scim-mock` connected with 18 tools and `entra-lifecycle-intake` connected with one tool, `system_one`. |
| 4 | Seven skills discovered | Type `/` in the chat input: the **SKILLS** section lists `entitlement-guardrail`, `entra-lifecycle-policy`, `identity-change-auditor`, `joiner-orchestrator`, `leaver-orchestrator`, `lifecycle-intake` and `mover-orchestrator` (badge **Local**). If they are missing you launched with a bare `npx` instead of `npm run inspector`; see above. The Raw view shows the same names and descriptions in the system prompt. The catalog is about 3,150 characters of names and descriptions (`npm run validate:skills` prints the current total) against a budget of 2% of the model's context window, roughly 16,000 characters for a 200k-token model; 8,000 is the fallback when the context length is unknown. |
| 5 | Policy readable | Send the smoke prompt `Load entra-lifecycle-policy and quote policyId and policyVersion`. Expect `contoso-lifecycle-policy` and `1.2.0`. |
| 6 | Fresh ids | If the mock was restarted after the chat began, start a new chat. Ids regenerate on every boot; the skills refuse to reuse ids from earlier turns, but a stale transcript still costs the model context and tool calls. |
| 7 | Signed in | The model picker offers a Claude Sonnet- or Opus-class model as selectable rather than greyed out with "Sign in to use this model". |

## Step 1: start the demo tenant

From the repo root:

```bash
npm install
npm run demo:up
```

This starts the mock with the seed, waits for it, applies the manager links and memberships, and prints what the mock now holds:

```text
entra-scim-mock-server listening on http://127.0.0.1:8990
  mode:    strict Entra
  seeded:  8 user(s), 10 group(s)
...
seed-links: applied 6 manager link(s) and 24 membership(s) in 9 PATCH call(s)

Group memberships as read back from the mock (10 groups; userNames shown as local parts):
  All Employees                 patti.fernandez, megan.bowen, adele.vance, lidia.holloway, diego.siciliani, alex.wilber, nestor.wilke
  ...
```

Leave the terminal open. The same thing in two terminals is `npm run mock` and then `npm run seed:links` (the second waits up to 10 seconds for the mock).

## Step 2: launch the inspector

From the repo root:

```bash
npm run inspector
```

The script prints the seven skills it copied to `~/.mcpjam/skills/`, the path of the generated config, and then runs `npx @mcpjam/inspector@3.13.0 --config <that file>`. The inspector opens in your browser with `entra-scim-mock` (18 tools) and `entra-lifecycle-intake` (1 tool) already connecting. Extra arguments pass through, for example `npm run inspector -- --port 6275`.

Launching with a bare `npx @mcpjam/inspector@3.13.0` also works, but the picker then shows only your personal skills (see "Before you start") and you add the two servers by hand as in Step 3.

## Step 3: add the mock server

Skip this step if you used `npm run inspector`: both servers are already in the list. To add them by hand:

1. Open the **Servers** tab.
2. Add a server and choose transport **STDIO**.
3. Name it `entra-scim-mock`.
4. Command: `npx`. Args: `-y entra-scim-mcp@0.3.0`.
5. Under **Environment Variables**, click **Add Variable** and enter `ENTRA_SCIM_BASE_URL` with value `http://127.0.0.1:8990`. Click **Add Variable** again and enter `ENTRA_SCIM_STATIC_TOKEN` with value `dev-token`.
6. Connect. The server should show **18 tools**.
7. Add only this `entra-scim-*` server to the chat. If two enabled servers expose the same tool names (the mock and a rehearsal server, say), MCPJam merges them into one tool with a `link_id` argument or renames them `<tool>__<server>`, and the skills' documented call sequences no longer match.
8. Add a second STDIO server for the front door: name `entra-lifecycle-intake`, command `node`, args `demo/intake/server.mjs`, one variable `LIFECYCLE_INTAKE_BACKEND` = `stub`. Connect; it shows one tool, `system_one`. Its name collides with nothing, so it can be enabled alongside the mock.

If the count is not 18, or the connection fails, check that the mock is listening (terminal 1) and that the two variables are spelled exactly as above. The static-token mode requires `ENTRA_SCIM_BASE_URL` and refuses any Microsoft host, so a typo in the URL fails the connection rather than reaching the internet.

## Step 4: set up the playground

1. Open **Playground**.
2. Sign in to a free MCPJam account if you have not already. Since 2026-09-26 the frontier models in the **Free models** tab are greyed out for guests ("Sign in to use this model"); signed-in users get ten times a guest's daily allowance, and the tab is relabelled **MCPJam models** once the shared free allowance is used up. **Your providers** takes your own API key instead.
3. In the model picker choose a Claude Sonnet- or Opus-class model. Do not use small models; they skip steps, invent ids or answer `approve` themselves. Leave the reasoning-effort chip at its default.
4. Press `+` on the chat input. The menu has **Servers**, **Attach files**, **System Prompt & Temperature** and **Tool Approval**. Under **Servers** enable `entra-scim-mock` and nothing else. Under **System Prompt & Temperature** set the temperature slider to 0 (the system prompt is also visible here). Leave **Tool Approval** off: it pauses the model before every tool call for a click (each approval is valid for 15 minutes), the skills already carry their own approval gate, and with both on the Trace timeline no longer shows the skill's gate cleanly.
5. Switch to the **Raw** view and confirm the system prompt lists the seven skills. Switch back to **Chat**.
6. Send the smoke prompt:

   ```text
   Load entra-lifecycle-policy and quote policyId and policyVersion
   ```

   Expect `contoso-lifecycle-policy` and `1.2.0`. In the **Trace** view you should see one `loadSkill` call.

## Step 5: pick a skill and run a scenario

1. Type `/` in the chat input. A picker opens with a **SKILLS** section listing the discovered skills (badges **Local** and **Library**) and a **From MCP servers** section for skills served by connected servers (none here).
2. Pick the skill for the scenario: `lifecycle-intake` for S0a, S0b and S0c, `joiner-orchestrator` for S1 and S2, `mover-orchestrator` for S3a, S3b and S3c, `leaver-orchestrator` for S4. Picking a skill front-loads only its SKILL.md into the conversation; expanding the skill's card lets you tick supporting files to include as well, which you should not do here. The model has `loadSkill`, `listSkillFiles` and `readSkillFile` tools and uses them to load `entra-lifecycle-policy`, `entitlement-guardrail` and `identity-change-auditor` and to read their references as the orchestrator instructs.
3. Optionally also pick `entra-lifecycle-policy`. Its SKILL.md embeds the whole policy, which saves the model one `loadSkill` call. Do not pick the guardrail or auditor by hand; the orchestrator loads them when it needs them.
4. Paste the prompt block from the scenario file and send.
5. For S2, S3b and S4 the first turn ends with a gate line (S3c prints `Gate: low risk, proceeding` instead and runs to completion in the same turn). Copy the correlation id from it and send exactly:

   ```text
   approve elg-WD-000123-xxxxxx
   ```

   with the real id. Anything else (`yes`, `go ahead`, `approve` with a different id) must not continue the run.

## Step 6: read the three views

- **Chat**: the check table, the preview, the gate line, the summary, the `Tool calls: n of budget` line and the fenced JSON decision record. This is what the skill is contractually required to print.
- **Trace**: a timestamped timeline of every tool call with latency and tokens. This is where you prove the order of operations and count the calls. The arguments of each call are visible here, which is also why the demo uses a throwaway mock: the `provision_user` call shows the generated password in its arguments even though the chat and the record never do.
- **Raw**: the exact payload sent to the model, including the system prompt with the skill catalog and every tool definition. Useful for showing what the model was actually told.

A Playground turn allows 30 model steps (tool calls and intermediate replies). Every scenario turn here fits with room to spare; S2 turn 2 is the longest at 11 tool calls plus skill reads. If a chat ends with "I reached my step limit for this message. Send a message to continue.", treat the run as failed and restart it on a fresh mock rather than continuing: the skill's single-turn execution contract has been broken.

## What to look for in Trace view

### S0 intake (a, b, c)

- Exactly one call, `system_one` on the `entra-lifecycle-intake` server, with the policy's three questions as arguments and the sentence as `state`. Nothing from `entra-scim-mock`.
- Chat: a check table with the `eventType` choice and its probabilities, the two `noul` probabilities against their thresholds, and the aggregate row. S0a ends by naming `mover-orchestrator` and asking for the Workday record; S0b ends asking which kind of event it is; S0c ends `Gate: blocked: intake_override_attempt`. `Tool calls: 1 of 2 (1 reads, 0 writes)` in all three, and `details.intake.backend: stub` in the record.
- Absent: any `list_users`, `get_user`, `list_groups` or write; any record field "extracted" from the sentence.

### S1 joiner blocked

- No call to any `entra-scim-mcp` tool. `loadSkill` and `readSkillFile` calls are fine; `list_users`, `list_groups`, `provision_user` and the rest must be absent.
- In Chat: a check table with CHK-01 quoting `contoso-lifecycle-policy v1.2.0`, a `fail` row for REQ-CSA-03, and one row per requested group with the four outcomes (AP-Requestors allow, AP-Approvers deny SOD-FIN-001, Treasury-Payments allow_with_approval satisfied by CHG-40012, TenantAdmins deny breakglass-only). No preview, no gate. `Tool calls: 0 of 20`. Record with `decision: deny`, `outcome: blocked`, `toolCalls.count: 0`, empty `executedActions`.

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

### S3c mover title change

- One turn only: `list_users` (Alex), `get_user`, `get_user_custom_security_attributes`, `list_groups` filtered on `members.value`, then the check table, the before → after line, the preview ending `Gate: low risk, proceeding`, then `update_user` with a single `replace` on `title`, then `get_user`, then the summary and the record. No `approve` turn.
- Absent: `list_groups` without a filter (nothing is added), `update_user_custom_security_attributes`, `remove_group_member`, `add_group_members`.
- Chat: RS-08 as the only risk signal, aggregate `decision = allow`, `risk = low`; `Tool calls: 6 of 20 (5 reads, 1 write)`; record with `decision: allow`, `outcome: completed`, `riskLevel: low`, `approvals: []`.

### S4 leaver

- Turn 1: four reads (`list_users`, `get_user`, `list_groups` filtered on `members.value`, `get_user_custom_security_attributes` with `attributeSets: ["Compliance"]`), then the preview with a `(retained) SG-Legal-Hold` row and the gate.
- Turn 2: `update_user` (disable) first, `update_user_lifecycle` second with `employeeLeaveDateTime: "2026-09-20T09:00:00Z"`, then `remove_group_member` three times with `SG-Engineering-ProdDeploy` first, each with one `memberId`. Then `list_groups` returning exactly `SG-Legal-Hold` and `get_user` with `active: false`.
- Absent: any call for `SG-Legal-Hold`; `deprovision_user`; extra per-group lookups (the ids come from the earlier membership read).
- Chat: check rows for `RS-12` (privileged holder) and `RS-13` (`DataClassification = Restricted`), both `high`; `Tool calls: 11 of 25 (6 reads, 5 writes)`; `details.retained: ["SG-Legal-Hold"]`, `details.residual: []`.

## Screenshot suggestions for the blog

1. **Servers** tab with `entra-scim-mock` connected and the 18-tool list expanded.
2. The `/` picker open on the **SKILLS** section showing the seven skills.
3. **Raw** view scrolled to the skill catalog in the system prompt, to show what "markdown-only skills" means in practice.
4. S1 in **Chat**: the check table with the REQ-CSA-03 `fail` row and the four group rows, followed by `Tool calls: 0 of 20`.
5. S1 in **Trace**: only `loadSkill` calls, no MCP tools. The picture that makes the "zero calls" claim.
6. S2 turn 1 in **Chat**: the execution preview and the gate line asking for `approve elg-WD-000123-...`.
7. S2 turn 2 in **Trace**: the full 15-call timeline. Crop or blur the `provision_user` arguments; they contain the password.
8. S3b in **Chat**: the `warn` row that removes Treasury-Payments on a CSA change nobody requested, and the before/after line.
9. S3b in **Trace**: `update_user` first, three removals before the addition.
10. S4 in **Trace**: `SG-Engineering-ProdDeploy` removed first, no call for `SG-Legal-Hold`, no `deprovision_user`.
11. The decision record JSON in **Chat** for S4, showing `details.retained` and a residual-risk entry for the legal hold.
12. S3c in **Chat**: the preview ending in `Gate: low risk, proceeding` with the execution following in the same turn, the counterpart to S2's gate.
13. S0c in **Trace**: a single `system_one` call with the three typed questions visible in its arguments and the probabilities in its result, followed by the refusal. The picture for "a decision model at the door".

If you ran the mock with `npm run mock:capture`, `captures/demo-session.jsonl` holds every raw SCIM request and response for the session, which is useful for a "what actually went over the wire" figure.
