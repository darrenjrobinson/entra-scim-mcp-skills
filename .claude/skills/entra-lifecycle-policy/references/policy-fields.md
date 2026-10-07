# Policy field glossary

Single source of truth for every dotted path, operator, enum and cross-reference in `policy/lifecycle-policy.json`. Skills cite paths exactly as written here, in backticks, never paraphrased. When a path is renamed here, bump `policyVersion` (major) and update every SKILL.md "Policy fields read by this skill" table.

## Operators

All condition arrays are AND (`evaluation.conditionCombination = "all"`). Strings compare case-insensitively (`evaluation.stringComparison`) **except** subjects starting with `csa.` which compare exactly (`evaluation.exactMatchSubjectPrefixes`). CSA string values in Entra are case-sensitive.

| op | true when | example |
|---|---|---|
| `equals` | subject == value | `source.leaver.mode equals "delete"` |
| `notEquals` | subject != value | |
| `in` | subject is one of value[] | `source.worker.department in ["Finance", ...]` |
| `notIn` | subject is none of value[] | |
| `startsWith` | subject begins with value (keep a trailing delimiter in value) | `Employment.CostCenter startsWith "FIN-"`: `FIN-100` true, `ENG-210` false, `FINANCE` false |
| `endsWith` | subject ends with value | |
| `matches` | whole subject matches the ECMAScript regex in value (anchored) | `employeeNumber matches "^[0-9]{6}$"`: `100482` true, `E1001` false |
| `exists` | subject present and not null/empty (no `value`) | `source.worker.givenName exists` |
| `notExists` | subject absent, null or empty (no `value`) | |

Absent subject with any operator other than `exists`/`notExists` = condition **false** (never a pass by omission).

## Computed subjects

| subject | meaning |
|---|---|
| `source.*` | the input record (see `references/source-record.md`) |
| `csa.requested.<Set>.<Attr>` | CSA value in the input record |
| `csa.current.<Set>.<Attr>` | CSA value read from the tenant with `get_user_custom_security_attributes` (never from `get_user`) |
| `csa.effective.<Set>.<Attr>` | `csa.requested` if present, else `csa.current` |
| `user.*` | current `get_user` result, flattened (`user.active`, `user.department`, `user.manager`) |
| `group.*` | the `groupCatalog` entry under evaluation (`group.riskLevel`, `group.isPrivileged`) |
| `leaver.mode` | result of `offboardingOrder.modeSelection` (first match wins) |
| `event` | `joiner` \| `mover` \| `leaver` \| `entitlement-evaluation` |

## Top-level sections

| path | type | read by | meaning |
|---|---|---|---|
| `policyId`, `policyVersion` | string | all | Quoted in every decision record; major version must be 1 |
| `tenant.primaryDomain` | string | joiner | Domain for `namingStandards.userName.template`; swap for a live tenant |
| `evaluation.decisionPrecedence` | Decision[] | all | Worst-wins order: deny > require_manual_review > allow_with_approval > allow |
| `evaluation.riskOrder` | RiskLevel[] | all | low < medium < high; run risk = max |
| `customSecurityAttributes.attributeSets` | string[] | all | The only place set names are listed; every `set` elsewhere must appear here |
| `customSecurityAttributes.pathPrefix` | string | joiner, mover | Write path = `<pathPrefix>:<Set>.<Attr>` |
| `customSecurityAttributes.trustOnlyDedicatedRead` | true | all | Ignore CSA objects in `get_user`/`list_users` output |
| `authoritativeSources[]` | object[] | joiner, mover, leaver | `id`, `recordIdPattern`, permitted `events`, `allowedContractTypes` |
| `requiredJoinerAttributes.core[]` | Condition+id | joiner | REQ-01..REQ-08 against `source.*` |
| `requiredJoinerAttributes.customSecurityAttributes[]` | object[] | joiner | REQ-CSA-nn: `set`, `attribute`, `type`, `required`, `allowedValues` xor `pattern`, optional `default` |
| `requiredJoinerAttributes.onMissing` | Decision | joiner | Run decision when a required attribute is absent |
| `requiredJoinerAttributes.managerMustResolve` / `managerMustBeActive` | bool / warn\|deny\|ignore | joiner | Manager lookup rules |
| `approvedBaselineProfiles.keyedBy` | {set, attribute} | joiner | CSA that selects the profile |
| `approvedBaselineProfiles.profiles.<Key>` | object | joiner, mover | `baseGroups`, `departmentGroups.<Dept>`, `maxGroupRiskLevelAtJoiner` |
| `approvedBaselineProfiles.onNoProfile` | Decision | joiner | |
| `groupCatalog[]` | object[] | guardrail, all | `displayName`, `classification`, `riskLevel`, `approvalRequired`, `allowedAtJoiner`, `requiresCsa[]` (CsaCondition), `owner` |
| `privilegedGroups.displayNames` | string[] | guardrail | Plus any catalog entry with `classification = privileged` |
| `privilegedGroups.rules.breakglassOnlyGroups` | string[] | guardrail | Always deny outside break-glass (v2) |
| `sodRules[]` | object[] | guardrail | `id`, `conflictingGroups` (explicit pairs), `enforcement`, `approvalScope` |
| `sodEvaluation` | object | guardrail | Resulting set = (current − removals) + adds; fires when ≥2 conflicting groups are in it; `bothRequestedRule` says which requested member is denied when both are requested (`denyHigherRiskThenLaterInRequest`) |
| `riskModel.signals[]` | object[] | all | Sixteen signals RS-01..RS-16 → riskLevel; `fromCatalog` = the group's own level. RS-13 fires when the leaver target's `csa.current.Compliance.DataClassification` is `Restricted`; RS-14..RS-16 are the intake signals (override attempt, urgency without authority, low confidence) |
| `approvalThresholds.approvalRef` | object | all | `pattern`, `requiredFields`, `sourceRecordIdMustMatch`, must be supplied by operator or record |
| `approvalThresholds.decisionByRiskLevel` | map | all | Decision implied by run risk |
| `approvalThresholds.operatorConfirmRequired` | map | orchestrators | Whether to end the turn after the preview and wait for `approve <correlationId>` |
| `approvalThresholds.groupDenyHandling` | enum | joiner, mover | `skip_group_and_continue`: a denied group is skipped, the run continues |
| `approvalThresholds.escalations.<key>` | Decision | all | Decision for each escalation (see reason-code map below) |
| `joinerRules.sequence` | step[] | joiner | provisionUser → setCustomSecurityAttributes → addGroups → verify → activate |
| `joinerRules.createInactiveUntilVerified` | bool | joiner | `provision_user` with `active:false`, activate last |
| `joinerRules.existingUser` | Decision | joiner | What to do when `externalId` or `userName` already exists |
| `moverRules.sequence` | step[] | mover | attributes → customSecurityAttributes → groupRemoves → groupAdds |
| `moverRules.removeOldDepartmentGroups` | bool | mover | Old department's `departmentGroups` go to removals |
| `moverRules.reevaluateHeldGroupCsaGates` | bool | mover | Held groups whose `requiresCsa` fails against `csa.effective` go to removals (warn) |
| `offboardingOrder.modeSelection[]` | {mode, when[]} | leaver | First match wins; last entry has `when: []` |
| `offboardingOrder.steps.<mode>` | StepName[] | leaver | Ordered steps per mode |
| `offboardingOrder.stepTools.<step>` | tool | leaver | One tool per step |
| `offboardingOrder.removalOrder` | class[] | leaver | privileged → business → baseline → uncatalogued |
| `offboardingOrder.deleteBlockedWhen[]` | Condition[] | leaver | e.g. `csa.current.Compliance.LegalHold equals true` |
| `offboardingOrder.neverAfterDeprovision` | tool[] | leaver | Delete cascades memberships; these calls would 404 |
| `retainedAccessRules[]` | object[] | leaver | `groups[]` kept when `retainWhen[]` all hold (empty = always) |
| `namingStandards.userName` | object | joiner | `template`, `normalization`, `pattern`, `collision` (numericSuffix) |
| `namingStandards.mailNickname` / `displayName` / `primaryEmail` | object | joiner | Derivation rules |
| `namingStandards.password` | object | joiner | Generate ≥16 chars, four classes, never shown anywhere |
| `costThresholds.maxToolCallsPerRun.<skill>` | int | all | Budget; every call counts, reads included |
| `costThresholds.warnAtPercent` / `onExceed` | int / enum | all | Warn at 80%, stop at budget |
| `costThresholds.groupResolution` | object | all | One `list_groups` listing when catalog ≤ `listAllMaxCatalogSize`, else per-group `displayName eq` |
| `costThresholds.projection.*` | string[] | all | `attributes` to pass to `list_users` / `list_groups` |
| `intake.enabled` / `structuredRecordBypass` | bool | intake | Front door on; a record with a valid `eventType` never goes to the model |
| `intake.server` / `intake.tool` | string | intake | `entra-lifecycle-intake` / `system_one`: the MCP server and tool that answer the questions |
| `intake.backends` | string[] | intake | `stub`, `jev`, `laya`; selected on the server with `LIFECYCLE_INTAKE_BACKEND` |
| `intake.questions.<name>` | IntakeQuestion | intake | `{type: choice\|score\|noul, instructions, criteria}`, passed to the model verbatim; `eventType`, `overrideAttempt` and `urgencyWithoutAuthority` are required |
| `intake.routing.<option>` | skill name or `refuse` | intake | Where each `eventType` option goes; options must equal the routing keys |
| `intake.thresholds.*` | probability | intake | `minConfidenceToRoute`, `overrideAttemptMax`, `urgencyWithoutAuthorityMax` |
| `intake.on*` | Decision | intake | `onOverrideAttempt` (deny), `onUrgencyWithoutAuthority` and `onLowConfidence` (require_manual_review), `onRefuse` (deny) |
| `intake.recordRequired` | true | intake | Routing never runs an orchestrator on prose; the authoritative record is requested first |
| `intake.evaluationOrder` | string[] | intake | override → urgency → low confidence → refuse → route; low confidence precedes refuse so a tie never denies |
| `auditRequirements.correlationId` | object | all | `elg-{sourceRecordId}-{random6}`, generated by the skill, labelled as such |
| `auditRequirements.timestamps` | object | auditor | Only `meta.created` / `meta.lastModified` from tool results; else null with `clockSource: none` |
| `auditRequirements.requiredSections` | string[] | auditor | Sections that must be present (empty arrays allowed) |
| `auditRequirements.policyCheckTableInTranscript` | true | all | The markdown check table is printed before any write |

## Enums

**Decision**: `allow`, `allow_with_approval`, `deny`, `require_manual_review`
**Outcome**: `completed`, `blocked`, `awaiting_approval`, `partial_failure`, `not_executed`, `rehearsal`
**CheckResult**: `pass`, `fail`, `warn`, `needs_approval`, `manual_review`, `skipped`
**RiskLevel**: `low`, `medium`, `high`
**LeaverMode**: `scheduled`, `immediate`, `delete`

**ReasonCode** (decision-record schema `$defs.ReasonCode`):
`policy_unavailable`, `unknown_source`, `missing_required_attribute`, `csa_missing`, `csa_condition_failed`, `group_not_in_catalog`, `group_not_found_in_tenant`, `duplicate_group_display_name`, `not_allowed_at_joiner`, `privileged_not_allowed_at_joiner`, `breakglass_only`, `exceeds_profile_risk`, `sod_conflict`, `approval_required`, `approval_missing`, `approval_invalid`, `approval_scope_mismatch`, `operator_confirmation_missing`, `ambiguous_identity`, `already_provisioned`, `unresolved_manager`, `source_conflict`, `cost_budget_exceeded`, `partial_failure`, `verification_failed`, `dry_run_active`, `delete_blocked_legal_hold`, `intake_low_confidence`, `intake_not_lifecycle`, `intake_override_attempt`, `intake_record_required`, `intake_backend_unavailable`

### Escalation key → reasonCode

| `approvalThresholds.escalations.*` | reasonCode |
|---|---|
| policyUnavailable | policy_unavailable |
| unknownSource | unknown_source |
| missingRequiredAttribute | missing_required_attribute (CSA: `csa_missing` when the set/attribute is absent from the record) |
| ambiguousIdentity | ambiguous_identity |
| alreadyProvisioned | already_provisioned |
| unresolvedManager | unresolved_manager |
| groupNotInCatalog | group_not_in_catalog |
| groupNotFoundInTenant | group_not_found_in_tenant |
| duplicateGroupDisplayName | duplicate_group_display_name |
| sourceConflict | source_conflict |
| costBudgetExceeded | cost_budget_exceeded |

## Group cross-reference (the ten catalog names)

`All Employees`, `SG-Contractors`, `SG-Finance-Users`, `SG-Finance-AP-Requestors`, `SG-Finance-AP-Approvers`, `SG-Finance-Treasury-Payments`, `SG-Engineering-Users`, `SG-Engineering-ProdDeploy`, `SG-Entra-TenantAdmins`, `SG-Legal-Hold`

Every name in `sodRules`, `privilegedGroups`, `approvedBaselineProfiles`, `retainedAccessRules`, the demo seed and the demo source records must be one of these, spelled exactly. Pass the catalog `displayName` verbatim to `list_groups`; match results case-insensitively; an unknown name is `group_not_in_catalog`, never "closest match".

## CSA catalogue

| set.attribute | type | values | used by |
|---|---|---|---|
| `Employment.ContractType` | string | Employee, Contractor, Vendor | profile selection, SG-Contractors and SG-Engineering-ProdDeploy gates, source `allowedContractTypes` |
| `Employment.CostCenter` | string | `^(FIN\|ENG\|OPS\|HR)-[0-9]{3}$` | SG-Finance-Treasury-Payments gate (`startsWith "FIN-"`) |
| `Compliance.DataClassification` | string | Public, Internal, Confidential, Restricted | mandatory joiner attribute (REQ-CSA-03); `Restricted` lifts a leaver to high risk (RS-13) |
| `Compliance.LegalHold` | boolean | true/false, default false | blocks leaver `delete` mode |

A live tenant must define both sets and all four attributes with exactly these names and values before any run (see `docs/live-tenant-setup.md` in the repo).

## Referential-integrity checklist

Run `npm run validate` in the repo, which checks all of these:

1. The ```` ```json policy ```` block in `SKILL.md` equals `policy/lifecycle-policy.json`.
2. Every group name in `sodRules[].conflictingGroups`, `privilegedGroups.displayNames`, `privilegedGroups.rules.breakglassOnlyGroups`, `approvedBaselineProfiles.profiles.*.baseGroups`, `.departmentGroups.*`, `retainedAccessRules[].groups` exists in `groupCatalog[].displayName`.
3. Every `set` in `requiredJoinerAttributes.customSecurityAttributes[]` and `groupCatalog[].requiresCsa[]` is in `customSecurityAttributes.attributeSets`.
4. `costThresholds.maxToolCallsPerRun` keys are exactly the six non-policy skill names.
5. `intake.routing` targets are skills in this pack or `refuse`; `intake.questions.eventType.criteria` options equal the routing keys; thresholds are in [0, 1].
6. The demo seed's groups and membership keys are all catalog names; its userNames are all seeded users.

## Skill catalog budget

MCPJam inlines every discovered skill's `name` + `description` into the system prompt, capped at about 2% of the selected model's context window at roughly 4 characters per token (16,000 characters for a 200k-token model); 8,000 characters is the fallback when the model's context length is unknown. Each line also costs an origin label and about 12 characters of punctuation, and on overflow MCPJam shortens descriptions first and omits whole skills last. Personal skills under `~/.claude/skills`, `~/.mcpjam/skills` and `~/.agents/skills` share the budget. Keep each description of the six skills under 400 characters; `npm run validate:skills` prints the total against the 8,000 fallback floor.
