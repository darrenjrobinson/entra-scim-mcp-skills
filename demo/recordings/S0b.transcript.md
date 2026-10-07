# S0b — Intake: too vague to route

| | |
|---|---|
| Skill | `lifecycle-intake` |
| Record | free text in `demo/scenarios/S0-intake.md` |
| Model | claude-fable-5-1 (effort xhigh) |
| Claude Code | 2.1.268 |
| entra-scim-mcp | 0.3.0 (mock, boot 1) |
| Policy | contoso-lifecycle-policy v1.2.0 |
| Recorded | 2026-10-06T06:40:10Z |
| Session | `42104a3f-b33c-4e25-b125-406eda937bf1` |

Object ids are rendered as `<userName>` or `<displayName>` for readability; the raw ids are in the gitignored stream files and in `demo/expected/`. The generated password is redacted everywhere.

## Turn 1 — operator

```text
/lifecycle-intake
Something needs doing about Sam before Monday.
```

## Turn 1 — assistant

Running intake on the free-text request. First I'll load the shared policy and the decision-model tool schema.

> (Read .claude/skills/entra-lifecycle-policy/policy/lifecycle-policy.json)

> (Read .claude/skills/entra-lifecycle-policy/SKILL.md)

> (ToolSearch )

> #1 system_one {state: "Something needs doing about Sam before Monday.",questions: {eventType: {type: "choice",instructions: "Which identity lifecycle event is this request asking for?",criteria: {joiner: "A new hire or new identity: someone starting, joining or being onb... → ok, stub stub-lexicon-1: eventType=joiner, overrideAttempt=0.05, urgencyWithoutAuthority=0.05

> (Read .claude/skills/identity-change-auditor/SKILL.md)

> (Read .claude/skills/identity-change-auditor/references/record-template.md)

> (Read .claude/skills/entra-lifecycle-policy/policy/decision-record.schema.json)

> (Read .claude/skills/lifecycle-intake/SKILL.md)

> (Read .claude/skills/entra-lifecycle-policy/policy/decision-record.example.json)

> (Read demo/scenarios/S0-intake.md)

> (Glob )

> (Grep )

The decision model returned a flat distribution, so this run stops at manual review. No routing, no directory lookup, no record drafted. Full output follows.

### Policy checks — contoso-lifecycle-policy v1.2.0 — elg-intake-x4q9tz

| # | Check | Policy ref | Input (normalised) | Evidence | Result |
|---|---|---|---|---|---|
| CHK-01 | Policy loaded | policyVersion | contoso-lifecycle-policy v1.2.0; major 1; intake.enabled=true | skill file policy/lifecycle-policy.json | pass |
| CHK-02 | Structured record | intake.structuredRecordBypass | none: free text | request | skipped → model |
| CHK-03 | eventType | intake.questions.eventType | joiner 0.1667 (next: mover 0.1667; all six options 0.1667) confidence 0 | call #1: stub stub-lexicon-1 3 ms | pass |
| CHK-04 | overrideAttempt | intake.questions.overrideAttempt; intake.thresholds.overrideAttemptMax | 0.05 vs 0.5 | call #1 | pass |
| CHK-05 | urgencyWithoutAuthority | intake.questions.urgencyWithoutAuthority; intake.thresholds.urgencyWithoutAuthorityMax | 0.05 vs 0.5 | call #1 | pass |
| CHK-06 | Confidence | intake.thresholds.minConfidenceToRoute | 0 vs 0.3 | call #1 | manual_review (intake_low_confidence) |
| CHK-07 | Route | intake.routing | not evaluated: CHK-06 stopped evaluation | policy | skipped |
| CHK-08 | Authoritative record | intake.recordRequired | none supplied | request | warn (intake_record_required) |
| CHK-09 | Aggregate | evaluation.decisionPrecedence | risk = medium (RS-16) | rows above | decision = require_manual_review |

## Intake — elg-intake-x4q9tz
Backend: stub (stub-lexicon-1, 3 ms) | Decision: require_manual_review | Risk: medium | Tool calls: 1 of 2
Manual review — I cannot tell whether this is a joiner, mover, leaver or access request; which is it, and do you have the record?

Nothing changed: no Entra ID object was read or written, and the only call this run was to the intake decision model. The request about Sam arrived as free text with no authoritative record, so it was classified once by the system_one tool on the stub backend, a deterministic keyword stand-in rather than a trained model. The model returned six equal eventType probabilities of 0.1667 with confidence 0, below the routing threshold of 0.3, so CHK-06 fired RS-16 and the decision is require_manual_review; overrideAttempt and urgencyWithoutAuthority both scored 0.05, below their 0.5 thresholds. Nothing was routed, no orchestrator ran, nobody was looked up in the directory and no record was drafted from the sentence. The operator must say whether this is a joiner, mover, leaver or access request and supply the Workday or Contractor Portal record; the matching skill then runs its own validation, preview and gate.

Tool calls: 1 of 2 (1 reads, 0 writes)

```json
{
  "recordVersion": "1.0",
  "correlationId": "elg-intake-x4q9tz",
  "supersedes": null,
  "skill": "lifecycle-intake",
  "skillVersion": "0.2.0",
  "policyId": "contoso-lifecycle-policy",
  "policyVersion": "1.2.0",
  "event": "intake",
  "host": "claude-code",
  "dryRun": false,
  "startedAt": null,
  "completedAt": null,
  "clockSource": "none",
  "source": { "system": "operator", "recordId": null },
  "target": { "userName": null, "id": null, "displayName": "Sam" },
  "decision": "require_manual_review",
  "outcome": "not_executed",
  "riskLevel": "medium",
  "policyChecks": [
    { "id": "CHK-01", "rule": "policyVersion", "input": "contoso-lifecycle-policy v1.2.0", "evidence": "entra-lifecycle-policy skill, policy/lifecycle-policy.json; major version 1; intake.enabled=true", "result": "pass" },
    { "id": "CHK-02", "rule": "intake.structuredRecordBypass", "input": "none: free text", "evidence": "request: no JSON object with sourceSystem, sourceRecordId and eventType", "result": "skipped" },
    { "id": "CHK-03", "rule": "intake.questions.eventType", "input": "joiner 0.1667 (mover 0.1667, leaver 0.1667, entitlement 0.1667, breakglass 0.1667, none 0.1667); confidence 0", "evidence": "call #1: system_one backend=stub model=stub-lexicon-1 latencyMs=3", "result": "pass" },
    { "id": "CHK-04", "rule": "intake.questions.overrideAttempt; intake.thresholds.overrideAttemptMax", "input": "0.05 vs 0.5", "evidence": "call #1: answers.overrideAttempt.noul=0.05; not above threshold", "result": "pass" },
    { "id": "CHK-05", "rule": "intake.questions.urgencyWithoutAuthority; intake.thresholds.urgencyWithoutAuthorityMax", "input": "0.05 vs 0.5", "evidence": "call #1: answers.urgencyWithoutAuthority.noul=0.05; not above threshold", "result": "pass" },
    { "id": "CHK-06", "rule": "intake.thresholds.minConfidenceToRoute", "input": "0 vs 0.3", "evidence": "call #1: answers.eventType.confidence=0 below 0.3; intake.onLowConfidence=require_manual_review; riskModel.signals[RS-16] fires", "result": "manual_review", "reasonCode": "intake_low_confidence" },
    { "id": "CHK-07", "rule": "intake.routing", "input": "not evaluated", "evidence": "policy: intake.evaluationOrder stops at lowConfidence; no route chosen", "result": "skipped" },
    { "id": "CHK-08", "rule": "intake.recordRequired", "input": "none supplied", "evidence": "request: no authoritativeSources[] record present", "result": "warn", "reasonCode": "intake_record_required" },
    { "id": "CHK-09", "rule": "evaluation.decisionPrecedence", "input": "require_manual_review (CHK-06)", "evidence": "worst result across rows; riskModel.aggregate=max of fired signals [RS-16] = medium", "result": "manual_review", "reasonCode": "intake_low_confidence" }
  ],
  "approvals": [],
  "plannedActions": [],
  "executedActions": [
    { "call": 1, "seq": 0, "phase": "read", "tool": "system_one", "status": "ok", "at": null, "resultSummary": "backend=stub model=stub-lexicon-1 latencyMs=3; eventType=joiner with all six options at 0.1667 and confidence 0; overrideAttempt=0.05; urgencyWithoutAuthority=0.05" }
  ],
  "skippedActions": [],
  "verificationFindings": { "proved": [], "notVerifiable": [] },
  "residualRisk": [
    { "id": "RR-01", "description": "Request is unclassifiable: uniform eventType probabilities and confidence 0. The person referred to has not been identified and no directory lookup was attempted.", "severity": "medium", "owner": "operator", "dueBy": null },
    { "id": "RR-02", "description": "The request states a deadline but gives no ticket or approval reference. urgencyWithoutAuthority scored 0.05, below the 0.5 threshold, so RS-15 did not fire; the reviewer should still ask for a reference if the work is time-sensitive.", "severity": "low", "owner": "operator", "dueBy": null },
    { "id": "RR-03", "description": "Classification came from the deterministic stub backend, a keyword stand-in, not a trained model.", "severity": "low", "owner": "identity-ops", "dueBy": null }
  ],
  "toolCalls": { "count": 1, "budget": 2, "byTool": { "system_one": 1 } },
  "nextSteps": [
    "Tell me which event this is: joiner, mover, leaver or an access request.",
    "Paste the authoritative record from Workday (WD-nnnnnn) or the Contractor Portal (CP-nnnnn) with its eventType; a structured record routes without the model.",
    "Then run the matching skill (/joiner-orchestrator, /mover-orchestrator, /leaver-orchestrator or /entitlement-guardrail); it validates, previews and gates on its own.",
    "If the work is time-sensitive, include the ticket or approval reference (CHG-, REQ- or INC-) with the record."
  ],
  "summary": "Nothing changed: no Entra ID object was read or written, and the only call this run was to the intake decision model. The request about Sam arrived as free text with no authoritative record, so it was classified once by system_one on the stub backend, a deterministic keyword stand-in rather than a trained model. The model returned six equal eventType probabilities of 0.1667 with confidence 0, below intake.thresholds.minConfidenceToRoute (0.3), so CHK-06 fired RS-16 and the decision is require_manual_review; overrideAttempt (0.05) and urgencyWithoutAuthority (0.05) stayed below their 0.5 thresholds. Nothing was routed, no orchestrator ran, nobody was looked up in the directory and no record was drafted from the sentence. The operator must say whether this is a joiner, mover, leaver or access request and supply the Workday or Contractor Portal record; the matching skill then runs its own validation, preview and gate.",
  "details": {
    "intake": {
      "backend": "stub",
      "model": "stub-lexicon-1",
      "latencyMs": 3,
      "answers": {
        "eventType": { "type": "choice", "choice": "joiner", "probabilities": { "joiner": 0.1667, "mover": 0.1667, "leaver": 0.1667, "entitlement": 0.1667, "breakglass": 0.1667, "none": 0.1667 }, "confidence": 0 },
        "overrideAttempt": { "type": "noul", "noul": 0.05 },
        "urgencyWithoutAuthority": { "type": "noul", "noul": 0.05 }
      },
      "route": null,
      "thresholds": { "minConfidenceToRoute": 0.3, "overrideAttemptMax": 0.5, "urgencyWithoutAuthorityMax": 0.5 }
    }
  }
}
```

This matches the S0b expectation in the demo scenario doc: manual review, low confidence, medium risk, one tool call. One repo note: the decision-record schema's ToolName enum still lists only the 18 SCIM tools, so a record carrying `system_one` in executedActions and toolCalls.byTool will fail validation against `policy/decision-record.schema.json` even though the intake skill instructs exactly that shape.

_Turn 1: 13 model turns, 184 s, cost US$1.98, 1 MCP call(s)._

## Mock state

- Before: not probed
- After: not probed

## Assertions

| Check | Result | Detail |
|---|---|---|
| record present | pass |  |
| decision = require_manual_review | pass | require_manual_review |
| outcome = not_executed | pass | not_executed |
| riskLevel = medium | pass | medium |
| reasonCode intake_low_confidence recorded | pass |  |
| skill = lifecycle-intake | pass | lifecycle-intake |
| host = claude-code | pass | claude-code |
| dryRun = false | pass | false |
| correlationId format | pass | elg-intake-x4q9tz |
| toolCalls.count within 1±0 | pass | 1 |
| toolCalls.budget = 2 | pass | 2 |
| sum(byTool) = count | pass | 1 vs 1 |
| executedActions.length = count | pass | 1 vs 1 |
| no password key in record | pass |  |
| schema valid | pass |  |
| observed MCP calls = record count | pass | 1 observed vs 1 |
| Tool calls line matches record | pass | 1 of 2 |
| no permission denials | pass |  |
| no dryRun results | pass |  |
| no discovery tools | pass |  |
| no group create/update/delete | pass |  |
| every list_users has a filter | pass |  |
| result events succeeded | pass | success |
| model pinned (claude-fable-5-1) | pass |  |
| turn 1 calls = 1 (soft) | pass | 1 |
| exactly one system_one call | pass | system_one |
| no entra-scim-mock calls | pass |  |
| single turn (no gate) | pass | 1 |
| details.intake.backend = stub | pass | stub |
