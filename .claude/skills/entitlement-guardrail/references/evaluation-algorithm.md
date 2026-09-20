# Evaluation algorithm

Reference for `entitlement-guardrail`. Everything here is derived from `entra-lifecycle-policy/policy/lifecycle-policy.json`; when in doubt the policy wins.

## Normalisation

- Group names: trim, compare case-insensitively, but always *emit* the catalog spelling.
- CSA values: compare exactly (case-sensitive). `csa.effective.<Set>.<Attr>` = `csa.requested` value if present, else `csa.current` value, else absent.
- Absent subject + any operator except `exists`/`notExists` → condition false.

## The ten checks as truth tables

### 1. Catalog membership
| name in `groupCatalog`? | result |
|---|---|
| no | deny `group_not_in_catalog` (stop evaluating this group) |
| yes | continue |

### 2. Tenant resolution (only when `resolvedGroups` is supplied)
| ids for this name | result |
|---|---|
| 0 | require_manual_review `group_not_found_in_tenant` |
| 1 | continue |
| 2+ | require_manual_review `duplicate_group_display_name` (list the ids) |

### 3. Privileged
Privileged = name in `privilegedGroups.displayNames` OR catalog `classification = privileged`.
| privileged | in `breakglassOnlyGroups` | event | result |
|---|---|---|---|
| no | — | — | continue |
| yes | yes | any | deny `breakglass_only` |
| yes | no | joiner | deny `privileged_not_allowed_at_joiner` |
| yes | no | mover / evaluation | continue; mark needs approval scope `group:<name>`; risk at least `rules.minimumRiskLevel` (high) |

### 4. Allowed at joiner
| event | `allowedAtJoiner` | result |
|---|---|---|
| joiner | false | deny `not_allowed_at_joiner` |
| otherwise | — | continue |

### 5. Profile risk ceiling (joiner only)
Order: low < medium < high. Profile = `approvedBaselineProfiles.profiles[csa.effective.<keyedBy>]`.
| group `riskLevel` > profile `maxGroupRiskLevelAtJoiner` | result |
|---|---|
| yes | deny `exceeds_profile_risk` |
| no | continue |

Example: Contractor profile ceiling `low`; `SG-Finance-AP-Approvers` is `medium` → deny.

### 6. CSA gates
For each condition in `requiresCsa[]`, evaluate `csa.effective.<set>.<attribute> <op> <value>`.
| subject | condition | result |
|---|---|---|
| absent | — | deny `csa_missing` |
| present | false | deny `csa_condition_failed` |
| present | true (all) | continue |

Worked: `SG-Finance-Treasury-Payments` requires `Employment.CostCenter startsWith "FIN-"`. `FIN-100` → true. `ENG-210` → false → `csa_condition_failed`. `FINANCE` → false (no delimiter). Absent → `csa_missing`.

### 7. Separation of duties
```
resulting = (currentMemberships − requestedGroups.remove) ∪ requestedGroups.add
for each rule in sodRules:
  hits = rule.conflictingGroups ∩ resulting
  if |hits| >= 2:
    requestedHits = hits ∩ requestedGroups.add
    if requestedHits is empty:            # conflict existed before this request
      row result = warn; add residual risk "pre-existing SoD conflict <rule.id>"
    else for each g in requestedHits:
      if rule.enforcement == "deny":       g → deny sod_conflict
      else:                                g → allow_with_approval, needs scope rule.approvalScope
```
Joiner: `currentMemberships = []`, so only requested pairs can fire.

Worked S1: add = {AP-Requestors, AP-Approvers, Treasury-Payments, TenantAdmins}; SOD-FIN-001 hits both AP groups and both are requested. `sodEvaluation.bothRequestedRule = denyHigherRiskThenLaterInRequest`: deny the member with the higher catalog `riskLevel` (`SG-Finance-AP-Approvers`, medium, versus AP-Requestors, low); on a tie, the one listed later in the request. Cite the rule in the evidence. (`denyAllRequested` would deny both.)

Worked S3a: current = {All Employees, SG-Finance-Users, SG-Finance-AP-Requestors}; add = {SG-Finance-AP-Approvers} → SOD-FIN-001 hits both, requestedHits = {AP-Approvers} → deny `sod_conflict`. An approval scoped `group:SG-Finance-AP-Approvers` does not help: deny is not overridable.

### 8. Approval required?
| `approvalRequired` | `decisionByRiskLevel[riskLevel]` | needs approval |
|---|---|---|
| true | — | yes, scope `group:<name>` |
| false | allow_with_approval | yes, scope `group:<name>` or `run` |
| false | allow | no |

### 9. Approval validation
An approval satisfies a needed scope when ALL hold:
1. It was supplied by the operator (in a message) or by the source record. Never by the assistant.
2. `ref` matches `approvalThresholds.approvalRef.pattern` (`^(CHG|REQ|INC)-[0-9]{5,}$`). `CHG-40012` valid; `CHG0042117` invalid (no hyphen); `chg-40012` invalid (case).
3. Every `requiredFields` key is present and non-empty.
4. `sourceRecordId` equals the run's source record id (`sourceRecordIdMustMatch`).
5. `scope` equals the needed scope exactly, or is `run` (a run-scoped approval covers every group-scoped need in that run, but not `sod:` or `leaver:delete` scopes).

| needed | found | valid | result |
|---|---|---|---|
| yes | none | — | allow_with_approval `approval_missing` |
| yes | yes | no (pattern/fields/record) | allow_with_approval `approval_invalid` |
| yes | yes | scope wrong | allow_with_approval `approval_scope_mismatch` |
| yes | yes | yes | allow; mark approval `used: true` |

### 10. Otherwise
allow.

## Aggregation

- Per-group result = first failing check's decision, else allow.
- Run decision = worst per-group result by `evaluation.decisionPrecedence`. Callers decide whether a group-level deny is fatal; for a plain evaluation request, report it as the run decision.
- Run risk = max of: each evaluated group's `riskLevel` (RS-01), high if any privileged group (RS-02), high if any SoD rule fired (RS-03), high if the caller reports a missing required attribute (RS-04).

## Worked examples

### A. S1 joiner request (new hire, four groups)
Inputs: event joiner; csa.effective = {Employment.ContractType=Employee, Employment.CostCenter=FIN-100}; profile Employee (ceiling medium); add = [SG-Finance-AP-Requestors, SG-Finance-AP-Approvers, SG-Finance-Treasury-Payments, SG-Entra-TenantAdmins]; approvals = [CHG-40012 scope group:SG-Finance-Treasury-Payments].

| group | checks | result |
|---|---|---|
| SG-Finance-AP-Requestors | 1 ok, 3 not privileged, 4 ok, 5 low ≤ medium, 6 none, 7 SOD-FIN-001 fires but the higher-risk member is AP-Approvers, 8 no | **allow** |
| SG-Finance-AP-Approvers | 7 SOD-FIN-001 (medium, denied member) | **deny** `sod_conflict` |
| SG-Finance-Treasury-Payments | 6 CostCenter FIN-100 startsWith FIN- ok, 8 approvalRequired, 9 CHG-40012 valid | **allow** (approval used) — reported as `allow_with_approval` satisfied |
| SG-Entra-TenantAdmins | 3 breakglass-only | **deny** `breakglass_only` |

Run risk: max(low, medium, medium, high) = high (RS-02, RS-03). Run decision for the joiner: the joiner also has REQ-CSA-03 missing → deny.

### B. Contractor requesting a medium group
csa.effective.Employment.ContractType = Contractor → profile Contractor (ceiling low). Request SG-Finance-AP-Approvers (medium) → check 5 deny `exceeds_profile_risk`. Request SG-Contractors → check 6 `ContractType in [Contractor, Vendor]` true → allow.

### C. Mover into a privileged group
Alex (Employee, ENG-200) requests SG-Engineering-ProdDeploy. Check 3: privileged, not breakglass, event mover → needs scope `group:SG-Engineering-ProdDeploy`, risk high. Check 6: ContractType equals Employee → ok. Check 7: SOD-FIN-002 pairs ProdDeploy with Treasury-Payments; Alex holds neither → no fire. Check 9: with a valid REQ-… scoped to the group → allow (used); without → allow_with_approval `approval_missing`.

### D. Pre-existing conflict only
Diego holds SG-Finance-AP-Approvers; a mover requests adding SG-Engineering-Users only. SOD rules: none pair those. Suppose instead Diego already held both AP groups (bad data): SOD-FIN-001 hits 2 but requestedHits is empty → `warn` row + residual risk RR "pre-existing SoD conflict SOD-FIN-001; owner finance-systems". The request itself is not blocked by it.
