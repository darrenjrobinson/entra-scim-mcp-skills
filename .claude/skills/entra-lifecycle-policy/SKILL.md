---
name: entra-lifecycle-policy
description: "Shared tenant lifecycle policy and decision-record contract for the entra-lifecycle-guardrails pack. Load FIRST whenever a joiner, mover, leaver, entitlement, SoD, approval or audit task targets Entra ID through entra-scim-mcp. Holds the policy JSON (embedded and as policy/lifecycle-policy.json), its schema, the decision-record schema and example, and the field glossary."
license: MIT
compatibility: "Data-only skill; makes no tool calls. Consumed by entitlement-guardrail, joiner-orchestrator, mover-orchestrator, leaver-orchestrator and identity-change-auditor. Works in MCPJam Inspector (readSkillFile) and Claude Code (Read)."
metadata:
  version: "0.2.0"
  author: darrenjrobinson
  product: entra-lifecycle-guardrails
  homepage: https://github.com/darrenjrobinson/entra-scim-mcp-skills
  policy-id: contoso-lifecycle-policy
  policy-version: "1.1.0"
---

# entra-lifecycle-policy

This skill is a container. It holds the tenant's lifecycle policy and the audit contract that every other `entra-lifecycle-guardrails` skill evaluates. It never calls an MCP tool and never makes a decision on its own. Think of it as the Conditional Access policy for lifecycle events: the rules live here, the enforcement lives in the guardrail and orchestrator skills, and the execution lives in the `entra-scim-mcp` server.

## Files in this skill

| path | purpose | read by |
|---|---|---|
| `policy/lifecycle-policy.json` | the canonical tenant policy (also embedded below) | every skill, every run |
| `policy/lifecycle-policy.schema.json` | JSON Schema (draft 2020-12) for the policy | repo validation |
| `policy/decision-record.schema.json` | JSON Schema for the audit record every run emits | identity-change-auditor |
| `policy/decision-record.example.json` | a complete blocked-joiner record to copy the shape from | identity-change-auditor |
| `references/policy-fields.md` | glossary of every dotted path, operator, enum and cross-reference | any skill unsure of a field |
| `references/source-record.md` | the joiner / mover / leaver input contracts with examples | orchestrators |

## Step 0 — Load the shared policy (every run, before any MCP tool call)

The tenant policy lives in the `entra-lifecycle-policy` skill.

1. If a fenced ```` ```json policy ```` block from that skill is already in this conversation, use it.
2. Otherwise activate that skill.
   - MCPJam Inspector: call `loadSkill` with `{"name": "entra-lifecycle-policy"}`.
   - Claude Code: invoke the skill, or Read `.claude/skills/entra-lifecycle-policy/SKILL.md` (fall back to `~/.claude/skills/entra-lifecycle-policy/SKILL.md`).
3. If you still need the raw file:
   - MCPJam Inspector: call `readSkillFile` with `{"name": "entra-lifecycle-policy", "path": "policy/lifecycle-policy.json"}`.
   - Claude Code: Read `.claude/skills/entra-lifecycle-policy/policy/lifecycle-policy.json`.
4. Confirm the JSON parsed and that `policyId` and `policyVersion` are present and the major version is `1`. Otherwise STOP: decision `require_manual_review`, reasonCode `policy_unavailable`. Never proceed on a remembered, summarised or earlier-pasted policy.
5. If a field's meaning is unclear, read `references/policy-fields.md` from this skill the same way. Do not guess.
6. Quote `policyId` and `policyVersion` in check row `CHK-01` and in the decision record.

Other skills are activated the same two ways: `loadSkill {"name": "entitlement-guardrail"}` / `{"name": "identity-change-auditor"}` in MCPJam; invoke or Read in Claude Code. Never use `${CLAUDE_SKILL_DIR}` or `$ARGUMENTS`; they do not exist in every host.

## Evaluation semantics (one screen)

- **Condition** = `{subject, op, value?}`. Arrays of conditions are AND. Operators: `equals`, `notEquals`, `in`, `notIn`, `startsWith`, `endsWith`, `matches` (anchored regex), `exists`, `notExists`. An absent subject fails every operator except `exists`/`notExists`.
- **Case**: strings compare case-insensitively, except subjects under `csa.` which compare exactly.
- **Decision precedence** (worst wins): `deny` > `require_manual_review` > `allow_with_approval` > `allow`. The run decision is the worst of all check rows.
- **Risk**: `low` < `medium` < `high`; run risk = max over fired `riskModel.signals`; `fromCatalog` means the group's own `riskLevel`.
- **Computed subjects**: `csa.effective.<Set>.<Attr>` = requested value if present else current tenant value; `csa.current` comes only from `get_user_custom_security_attributes`; `leaver.mode` = first matching `offboardingOrder.modeSelection` entry; `event` = the run type.
- **SoD**: resulting set = (current memberships − planned removals) + planned adds. A rule fires when two or more of its `conflictingGroups` are in the resulting set. The *requested* member gets the rule's `enforcement`; a conflict that exists only among pre-existing memberships is `warn` plus a residual-risk entry.
- **Approval**: valid only if supplied by the operator or the record, `ref` matches `approvalThresholds.approvalRef.pattern`, all `requiredFields` present, `sourceRecordId` equals the record's, and `scope` matches what the check needs.
- **Group names**: pass the catalog `displayName` verbatim to `list_groups`; match results case-insensitively; a name not in `groupCatalog` is `deny` / `group_not_in_catalog`, never "closest match".
- **Ids**: never stored in policy; resolved every run.

## The policy (embedded copy)

The canonical file is `policy/lifecycle-policy.json`; this copy is kept identical by `npm run validate:skills`. If the two ever differ, the file wins and the drift is a bug.

```json policy
{
  "$schema": "./lifecycle-policy.schema.json",
  "policyId": "contoso-lifecycle-policy",
  "policyVersion": "1.2.0",
  "effectiveFrom": "2026-09-01",
  "notes": "Fictional tenant for entra-scim-mock-server. Group and user names must match demo/seed/contoso-demo-seed.json; object ids are never stored because they change on every mock boot.",
  "tenant": {
    "displayName": "Contoso (mock)",
    "primaryDomain": "contoso.local",
    "mcpServer": "entra-scim-mcp"
  },
  "evaluation": {
    "stringComparison": "caseInsensitive",
    "exactMatchSubjectPrefixes": ["csa."],
    "conditionCombination": "all",
    "operators": ["equals", "notEquals", "in", "notIn", "startsWith", "endsWith", "matches", "exists", "notExists"],
    "decisionPrecedence": ["deny", "require_manual_review", "allow_with_approval", "allow"],
    "riskOrder": ["low", "medium", "high"]
  },
  "customSecurityAttributes": {
    "attributeSets": ["Employment", "Compliance"],
    "pathPrefix": "urn:ietf:params:scim:schemas:extension:Microsoft:Entra:2.0:CustomSecurityAttributes",
    "readTool": "get_user_custom_security_attributes",
    "writeTool": "update_user_custom_security_attributes",
    "trustOnlyDedicatedRead": true
  },
  "authoritativeSources": [
    {
      "id": "workday",
      "displayName": "Workday HCM",
      "recordIdPattern": "^WD-[0-9]{6}$",
      "events": ["joiner", "mover", "leaver"],
      "allowedContractTypes": ["Employee"]
    },
    {
      "id": "contractor-portal",
      "displayName": "Contractor Portal",
      "recordIdPattern": "^CP-[0-9]{5}$",
      "events": ["joiner", "leaver"],
      "allowedContractTypes": ["Contractor", "Vendor"]
    }
  ],
  "requiredJoinerAttributes": {
    "core": [
      { "id": "REQ-01", "subject": "source.sourceRecordId", "op": "exists" },
      { "id": "REQ-02", "subject": "source.worker.givenName", "op": "exists" },
      { "id": "REQ-03", "subject": "source.worker.familyName", "op": "exists" },
      { "id": "REQ-04", "subject": "source.worker.employeeNumber", "op": "matches", "value": "^[0-9]{6}$" },
      { "id": "REQ-05", "subject": "source.worker.department", "op": "in", "value": ["Finance", "Engineering", "Operations", "Human Resources"] },
      { "id": "REQ-06", "subject": "source.worker.userType", "op": "in", "value": ["Member", "Guest"] },
      { "id": "REQ-07", "subject": "source.worker.managerUserName", "op": "matches", "value": "^[^@\\s]+@contoso\\.local$" },
      { "id": "REQ-08", "subject": "source.effectiveDate", "op": "matches", "value": "^\\d{4}-\\d{2}-\\d{2}$" }
    ],
    "customSecurityAttributes": [
      { "id": "REQ-CSA-01", "set": "Employment", "attribute": "ContractType", "type": "string", "required": true, "allowedValues": ["Employee", "Contractor", "Vendor"] },
      { "id": "REQ-CSA-02", "set": "Employment", "attribute": "CostCenter", "type": "string", "required": true, "pattern": "^(FIN|ENG|OPS|HR)-[0-9]{3}$" },
      { "id": "REQ-CSA-03", "set": "Compliance", "attribute": "DataClassification", "type": "string", "required": true, "allowedValues": ["Public", "Internal", "Confidential", "Restricted"] },
      { "id": "REQ-CSA-04", "set": "Compliance", "attribute": "LegalHold", "type": "boolean", "required": false, "default": false }
    ],
    "onMissing": "deny",
    "managerMustResolve": true,
    "managerMustBeActive": "warn"
  },
  "approvedBaselineProfiles": {
    "keyedBy": { "set": "Employment", "attribute": "ContractType" },
    "profiles": {
      "Employee": {
        "baseGroups": ["All Employees"],
        "departmentGroups": {
          "Finance": ["SG-Finance-Users"],
          "Engineering": ["SG-Engineering-Users"],
          "Operations": [],
          "Human Resources": []
        },
        "maxGroupRiskLevelAtJoiner": "medium"
      },
      "Contractor": {
        "baseGroups": ["SG-Contractors"],
        "departmentGroups": { "Engineering": ["SG-Engineering-Users"] },
        "maxGroupRiskLevelAtJoiner": "low"
      },
      "Vendor": {
        "baseGroups": ["SG-Contractors"],
        "departmentGroups": {},
        "maxGroupRiskLevelAtJoiner": "low"
      }
    },
    "onNoProfile": "require_manual_review"
  },
  "groupCatalog": [
    { "displayName": "All Employees", "classification": "baseline", "riskLevel": "low", "approvalRequired": false, "allowedAtJoiner": true, "requiresCsa": [], "owner": "identity-ops" },
    { "displayName": "SG-Contractors", "classification": "baseline", "riskLevel": "low", "approvalRequired": false, "allowedAtJoiner": true, "requiresCsa": [ { "set": "Employment", "attribute": "ContractType", "op": "in", "value": ["Contractor", "Vendor"] } ], "owner": "identity-ops" },
    { "displayName": "SG-Finance-Users", "classification": "business", "riskLevel": "low", "approvalRequired": false, "allowedAtJoiner": true, "requiresCsa": [], "owner": "finance-systems" },
    { "displayName": "SG-Finance-AP-Requestors", "classification": "business", "riskLevel": "low", "approvalRequired": false, "allowedAtJoiner": true, "requiresCsa": [], "owner": "finance-systems" },
    { "displayName": "SG-Finance-AP-Approvers", "classification": "business", "riskLevel": "medium", "approvalRequired": false, "allowedAtJoiner": true, "requiresCsa": [], "owner": "finance-systems" },
    { "displayName": "SG-Finance-Treasury-Payments", "classification": "business", "riskLevel": "medium", "approvalRequired": true, "allowedAtJoiner": true, "requiresCsa": [ { "set": "Employment", "attribute": "CostCenter", "op": "startsWith", "value": "FIN-" } ], "owner": "treasury" },
    { "displayName": "SG-Engineering-Users", "classification": "business", "riskLevel": "low", "approvalRequired": false, "allowedAtJoiner": true, "requiresCsa": [], "owner": "platform-eng" },
    { "displayName": "SG-Engineering-ProdDeploy", "classification": "privileged", "riskLevel": "high", "approvalRequired": true, "allowedAtJoiner": false, "requiresCsa": [ { "set": "Employment", "attribute": "ContractType", "op": "equals", "value": "Employee" } ], "owner": "platform-eng" },
    { "displayName": "SG-Entra-TenantAdmins", "classification": "privileged", "riskLevel": "high", "approvalRequired": true, "allowedAtJoiner": false, "requiresCsa": [], "owner": "identity-ops" },
    { "displayName": "SG-Legal-Hold", "classification": "business", "riskLevel": "medium", "approvalRequired": true, "allowedAtJoiner": false, "requiresCsa": [], "owner": "legal" }
  ],
  "privilegedGroups": {
    "displayNames": ["SG-Engineering-ProdDeploy", "SG-Entra-TenantAdmins"],
    "treatAsPrivilegedIf": "inDisplayNamesOrClassificationPrivileged",
    "rules": {
      "allowedAtJoiner": false,
      "approvalRequired": true,
      "minimumRiskLevel": "high",
      "breakglassOnlyGroups": ["SG-Entra-TenantAdmins"]
    }
  },
  "sodRules": [
    { "id": "SOD-FIN-001", "name": "AP requestor vs AP approver", "conflictingGroups": ["SG-Finance-AP-Requestors", "SG-Finance-AP-Approvers"], "enforcement": "deny", "rationale": "A user must not both raise and approve payables." },
    { "id": "SOD-FIN-002", "name": "Production deploy vs treasury payments", "conflictingGroups": ["SG-Engineering-ProdDeploy", "SG-Finance-Treasury-Payments"], "enforcement": "deny", "rationale": "Code deployers must not hold payment release rights." },
    { "id": "SOD-ADM-001", "name": "Tenant admin vs AP approver", "conflictingGroups": ["SG-Entra-TenantAdmins", "SG-Finance-AP-Approvers"], "enforcement": "allow_with_approval", "approvalScope": "sod:SOD-ADM-001", "rationale": "CISO-approved exception only." }
  ],
  "sodEvaluation": {
    "resultingSet": "(currentMemberships - plannedRemovals) + plannedAdds",
    "firesWhen": "two or more conflictingGroups are in resultingSet",
    "bothRequestedRule": "denyHigherRiskThenLaterInRequest",
    "preExistingOnlyConflict": "warn_and_residual_risk"
  },
  "riskModel": {
    "aggregate": "max",
    "signals": [
      { "id": "RS-01", "event": "any", "signal": "group.riskLevel", "riskLevel": "fromCatalog" },
      { "id": "RS-02", "event": "any", "signal": "group.isPrivileged", "riskLevel": "high" },
      { "id": "RS-03", "event": "any", "signal": "sod.ruleFired", "riskLevel": "high" },
      { "id": "RS-04", "event": "joiner", "signal": "source.missingRequiredAttribute", "riskLevel": "high" },
      { "id": "RS-05", "event": "mover", "signal": "mover.departmentChanged", "riskLevel": "medium" },
      { "id": "RS-06", "event": "mover", "signal": "mover.managerChanged", "riskLevel": "medium" },
      { "id": "RS-07", "event": "mover", "signal": "mover.csaChanged", "riskLevel": "medium" },
      { "id": "RS-08", "event": "mover", "signal": "mover.attributeOnlyNonSensitive", "riskLevel": "low" },
      { "id": "RS-09", "event": "leaver", "signal": "leaver.mode.scheduled", "riskLevel": "medium" },
      { "id": "RS-10", "event": "leaver", "signal": "leaver.mode.immediate", "riskLevel": "medium" },
      { "id": "RS-11", "event": "leaver", "signal": "leaver.mode.delete", "riskLevel": "high" },
      { "id": "RS-12", "event": "leaver", "signal": "leaver.targetHoldsPrivilegedGroup", "riskLevel": "high" },
      { "id": "RS-13", "event": "leaver", "signal": "leaver.targetDataClassificationRestricted", "riskLevel": "high", "notes": "Fires when csa.current.Compliance.DataClassification equals Restricted: a sensitive identity flagged by a protected attribute, not inferred from group membership." },
      { "id": "RS-14", "event": "any", "signal": "intake.overrideAttempt", "riskLevel": "high", "notes": "The intake decision model's overrideAttempt probability exceeded intake.thresholds.overrideAttemptMax: the request asked to skip, bypass or ignore policy." },
      { "id": "RS-15", "event": "any", "signal": "intake.urgencyWithoutAuthority", "riskLevel": "high", "notes": "The request claimed urgency or authority without a ticket or approval reference (intake.thresholds.urgencyWithoutAuthorityMax)." },
      { "id": "RS-16", "event": "any", "signal": "intake.lowConfidence", "riskLevel": "medium", "notes": "The intake decision model could not tell which lifecycle event the request is (confidence below intake.thresholds.minConfidenceToRoute)." }
    ]
  },
  "approvalThresholds": {
    "approvalRef": {
      "pattern": "^(CHG|REQ|INC)-[0-9]{5,}$",
      "example": "CHG-40012",
      "requiredFields": ["ref", "scope", "approver", "sourceRecordId"],
      "sourceRecordIdMustMatch": true,
      "mustBeSuppliedByOperatorOrRecord": true
    },
    "approvalScopes": ["run", "group:<displayName>", "sod:<ruleId>", "leaver:delete"],
    "decisionByRiskLevel": { "low": "allow", "medium": "allow_with_approval", "high": "allow_with_approval" },
    "operatorConfirmRequired": { "low": false, "medium": true, "high": true },
    "operatorConfirmPhrase": "approve <correlationId>",
    "groupDenyHandling": "skip_group_and_continue",
    "escalations": {
      "policyUnavailable": "require_manual_review",
      "unknownSource": "deny",
      "missingRequiredAttribute": "deny",
      "ambiguousIdentity": "require_manual_review",
      "alreadyProvisioned": "require_manual_review",
      "unresolvedManager": "require_manual_review",
      "groupNotInCatalog": "deny",
      "groupNotFoundInTenant": "require_manual_review",
      "duplicateGroupDisplayName": "require_manual_review",
      "sourceConflict": "require_manual_review",
      "costBudgetExceeded": "require_manual_review"
    }
  },
  "joinerRules": {
    "sequence": ["provisionUser", "setCustomSecurityAttributes", "addGroups", "verify", "activate"],
    "createInactiveUntilVerified": true,
    "onStepFailure": "stop_leave_inactive",
    "externalIdFrom": "source.sourceRecordId",
    "primaryEmailEqualsUserName": true,
    "existingUser": "require_manual_review"
  },
  "moverRules": {
    "sequence": ["attributes", "customSecurityAttributes", "groupRemoves", "groupAdds"],
    "removeOldDepartmentGroups": true,
    "reevaluateHeldGroupCsaGates": true,
    "leaveUncataloguedGroupsUntouched": true,
    "compareToPreviousWhenPresent": true,
    "onStepFailure": "stop"
  },
  "offboardingOrder": {
    "modeSelection": [
      { "mode": "delete", "when": [ { "subject": "source.leaver.mode", "op": "equals", "value": "delete" } ] },
      { "mode": "scheduled", "when": [ { "subject": "source.leaver.mode", "op": "equals", "value": "scheduled" } ] },
      { "mode": "immediate", "when": [] }
    ],
    "steps": {
      "scheduled": ["setLeaveDate", "verifyResidualAccess"],
      "immediate": ["disable", "setLeaveDate", "removeMemberships", "verifyResidualAccess"],
      "delete": ["disable", "setLeaveDate", "removeMemberships", "verifyResidualAccess", "deprovision", "verifyDeprovisioned"]
    },
    "stepTools": {
      "disable": "update_user",
      "setLeaveDate": "update_user_lifecycle",
      "removeMemberships": "remove_group_member",
      "verifyResidualAccess": "list_groups",
      "deprovision": "deprovision_user",
      "verifyDeprovisioned": "get_user"
    },
    "removalOrder": ["privileged", "business", "baseline", "uncatalogued"],
    "deleteRequiresApprovalScope": "leaver:delete",
    "deleteBlockedWhen": [ { "subject": "csa.current.Compliance.LegalHold", "op": "equals", "value": true } ],
    "neverAfterDeprovision": ["remove_group_member", "update_user", "update_user_lifecycle", "update_user_custom_security_attributes"],
    "uncataloguedGroups": "remove_and_warn",
    "onStepFailure": "stop"
  },
  "retainedAccessRules": [
    { "id": "RET-001", "groups": ["SG-Legal-Hold"], "retainWhen": [], "reason": "Legal hold: released only by Legal, never by lifecycle automation.", "releaseBy": "legal" },
    { "id": "RET-002", "groups": ["All Employees"], "retainWhen": [ { "subject": "leaver.mode", "op": "equals", "value": "scheduled" } ], "reason": "Baseline access remains until the effective date.", "releaseBy": "leaver-orchestrator" }
  ],
  "namingStandards": {
    "userName": {
      "template": "{givenName}.{familyName}@{primaryDomain}",
      "normalization": ["lowercase", "stripDiacritics", "removeCharsNotIn:a-z0-9.-"],
      "pattern": "^[a-z0-9]+(?:[.-][a-z0-9]+)*@contoso\\.local$",
      "maxLocalPartLength": 64,
      "collision": { "precheck": true, "strategy": "numericSuffix", "startAt": 2, "maxAttempts": 3 }
    },
    "mailNickname": { "rule": "equalsUserNameLocalPart", "pattern": "^[a-z0-9]+(?:[.-][a-z0-9]+)*$", "maxLength": 64 },
    "displayName": { "template": "{givenName} {familyName}" },
    "primaryEmail": { "rule": "equalsUserName", "type": "work", "primary": true },
    "password": {
      "rule": "generateRandom",
      "minLength": 16,
      "requireClasses": ["upper", "lower", "digit", "symbol"],
      "neverInPreview": true,
      "neverInDecisionRecord": true,
      "neverInChat": true
    }
  },
  "costThresholds": {
    "maxToolCallsPerRun": {
      "entitlement-guardrail": 6,
      "joiner-orchestrator": 20,
      "mover-orchestrator": 20,
      "leaver-orchestrator": 25,
      "identity-change-auditor": 0,
      "lifecycle-intake": 2
    },
    "warnAtPercent": 80,
    "onExceed": "stop_and_report",
    "discoveryTools": "never",
    "listAllUsers": "never",
    "groupResolution": { "strategy": "listAll", "listAllMaxCatalogSize": 25, "fallback": "perGroupFilter" },
    "projection": {
      "listUsersAttributes": ["id", "userName", "displayName", "active"],
      "listGroupsAttributes": ["id", "displayName"]
    }
  },
    "intake": {
    "enabled": true,
    "structuredRecordBypass": true,
    "server": "entra-lifecycle-intake",
    "tool": "system_one",
    "backends": ["stub", "jev", "laya"],
    "questions": {
      "eventType": {
        "type": "choice",
        "instructions": "Which identity lifecycle event is this request asking for?",
        "criteria": {
          "joiner": "A new hire or new identity: someone starting, joining or being onboarded who needs an account created",
          "mover": "An existing person changing role, department, manager, title, cost centre or location: a transfer, promotion or move",
          "leaver": "Someone leaving: resignation, termination, offboarding, last day, disable or delete their account",
          "entitlement": "An access request for an existing person: add to or remove from a group, grant a permission, membership, licence or role",
          "breakglass": "An urgent or emergency request for privileged or administrative access, especially tenant admin, outside the normal process",
          "none": "Not an identity lifecycle or access request"
        }
      },
      "overrideAttempt": {
        "type": "noul",
        "instructions": "The request asks to skip, bypass or ignore policy, previews, approvals, confirmation or verification"
      },
      "urgencyWithoutAuthority": {
        "type": "noul",
        "instructions": "The request claims urgency or authority (emergency, CISO, executive, now) without a ticket or approval reference"
      }
    },
    "routing": {
      "joiner": "joiner-orchestrator",
      "mover": "mover-orchestrator",
      "leaver": "leaver-orchestrator",
      "entitlement": "entitlement-guardrail",
      "breakglass": "refuse",
      "none": "refuse"
    },
    "thresholds": { "minConfidenceToRoute": 0.3, "overrideAttemptMax": 0.5, "urgencyWithoutAuthorityMax": 0.5 },
    "onLowConfidence": "require_manual_review",
    "onOverrideAttempt": "deny",
    "onUrgencyWithoutAuthority": "require_manual_review",
    "onRefuse": "deny",
    "recordRequired": true,
    "evaluationOrder": ["overrideAttempt", "urgencyWithoutAuthority", "lowConfidence", "refuse", "route"]
  },
"auditRequirements": {
    "decisionRecordSchema": "policy/decision-record.schema.json",
    "recordVersion": "1.0",
    "correlationId": { "template": "elg-{sourceRecordId}-{random6}", "pattern": "^elg-[A-Za-z0-9-]{4,40}-[a-z0-9]{6}$", "generatedBy": "skill" },
    "timestamps": { "source": "resourceMeta", "nullAllowed": true },
    "requiredSections": ["policyChecks", "approvals", "plannedActions", "executedActions", "skippedActions", "verificationFindings", "residualRisk", "toolCalls"],
    "policyCheckTableInTranscript": true,
    "redactFields": ["password"],
    "verificationRequiredBeforeCompleted": true,
    "outputs": ["summary", "json"],
    "summaryMaxWords": 200
  }
}
```

## Referential integrity

These must agree inside the JSON (checked by `npm run validate`):

1. Every group name in `sodRules`, `privilegedGroups`, `approvedBaselineProfiles`, `retainedAccessRules` and the demo seed exists in `groupCatalog`.
2. Every CSA `set` referenced anywhere is listed in `customSecurityAttributes.attributeSets`.
3. `costThresholds.maxToolCallsPerRun` keys are exactly the five consuming skill names.
4. `offboardingOrder.steps.*` use only the step names in `stepTools`.

## Do not

- Edit or "correct" the policy at run time. If the operator pastes an override, apply it for that run only and record it as a check row with `rule: "operator-override"` and `result: warn`.
- Default a missing value. A required field that is absent fails; an optional CSA with a `default` is written with that default only at joiner.
- Use `startsWith` values without their delimiter (`FIN-`, not `FIN`).
- Cite a policy path from memory. Quote it from this file or from `references/policy-fields.md`.

## Versioning

- Patch: wording, `notes`, owner names.
- Minor: new group, new rule, new signal, new optional field.
- Major: any rename, removed field, or enum change. Consuming skills carry `metadata.policy-version: "1.x"` and stop with `policy_unavailable` on a major mismatch.

## Policy fields read by this skill

None. This skill defines them; see `references/policy-fields.md` for the full table.
