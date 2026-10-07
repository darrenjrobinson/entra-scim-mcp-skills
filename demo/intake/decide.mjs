// The intake decision rules, as code, for the probe and the no-LLM verifier. The
// lifecycle-intake skill applies exactly these rules from the policy's `intake` section;
// this module exists so a script can prove the stub routes the demo prompts the way the
// skill will, without a model in the loop. The policy is the source of truth for the
// thresholds; nothing here is hard-coded except the order of evaluation.
//
//   evaluationOrder: overrideAttempt -> urgencyWithoutAuthority -> lowConfidence -> refuse -> route

export function decide(intake, answers) {
  const t = intake.thresholds;
  const et = answers.eventType ?? {};
  const override = answers.overrideAttempt?.noul ?? 0;
  const urgency = answers.urgencyWithoutAuthority?.noul ?? 0;
  const confidence = et.confidence ?? 0;
  const choice = et.choice ?? "none";
  const route = intake.routing[choice] ?? "refuse";
  const signals = [];
  if (override > t.overrideAttemptMax) signals.push("RS-14");
  if (urgency > t.urgencyWithoutAuthorityMax) signals.push("RS-15");
  if (confidence < t.minConfidenceToRoute) signals.push("RS-16");
  const riskLevel = signals.includes("RS-14") || signals.includes("RS-15") ? "high" : signals.includes("RS-16") ? "medium" : "low";
  if (override > t.overrideAttemptMax) {
    return { decision: intake.onOverrideAttempt, outcome: "blocked", reasonCode: "intake_override_attempt", route: null, riskLevel, signals, choice, confidence };
  }
  if (urgency > t.urgencyWithoutAuthorityMax) {
    return { decision: intake.onUrgencyWithoutAuthority, outcome: "not_executed", reasonCode: "approval_required", route: null, riskLevel, signals, choice, confidence };
  }
  if (confidence < t.minConfidenceToRoute) {
    return { decision: intake.onLowConfidence, outcome: "not_executed", reasonCode: "intake_low_confidence", route: null, riskLevel, signals, choice, confidence };
  }
  if (route === "refuse") {
    return { decision: intake.onRefuse, outcome: "blocked", reasonCode: choice === "breakglass" ? "breakglass_only" : "intake_not_lifecycle", route: null, riskLevel, signals, choice, confidence };
  }
  return {
    decision: "allow",
    outcome: intake.recordRequired ? "not_executed" : "completed",
    reasonCode: intake.recordRequired ? "intake_record_required" : null,
    route, riskLevel, signals, choice, confidence,
  };
}

/** True when the operator supplied a structured record the orchestrators can validate; the model is then skipped. */
export function structuredRecord(input, policy) {
  let record = input;
  if (typeof input === "string") {
    const start = input.indexOf("{");
    const end = input.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try { record = JSON.parse(input.slice(start, end + 1)); } catch { return null; }
  }
  if (!record || typeof record !== "object") return null;
  const { sourceSystem, sourceRecordId, eventType } = record;
  if (typeof sourceSystem !== "string" || typeof sourceRecordId !== "string" || typeof eventType !== "string") return null;
  const source = (policy.authoritativeSources ?? []).find((s) => s.id === sourceSystem);
  if (!source || !source.events?.includes(eventType)) return null;
  if (!new RegExp(source.recordIdPattern).test(sourceRecordId)) return null;
  return { sourceSystem, sourceRecordId, eventType, route: policy.intake.routing[eventType] ?? null };
}
