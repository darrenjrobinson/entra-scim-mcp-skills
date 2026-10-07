// Deterministic stand-in for a System One decision model (TypeSafe Jev, Laya).
//
// Same contract as the real models: systemOne(state, questions) -> { model, answers, usage }
// with question types "choice", "score" and "noul" and the same answer shapes. The
// difference is how the answers are produced: a transparent keyword scorer with a
// built-in identity-lifecycle lexicon, so the demo is reproducible with no API key, no
// weights download and no randomness. It is not a classifier anyone should ship; it is
// here so the architecture around it can be shown and tested offline. Swap the backend
// with LIFECYCLE_INTAKE_BACKEND=jev or =laya to use a real model.

export const MODEL_ID = "stub-lexicon-1";

// Option name -> words and phrases that count as evidence for it. Single words match a
// whole token (or its prefix when 4+ chars long); phrases match the raw text.
const LEXICON = {
  joiner: ["new hire", "new starter", "onboard", "onboarding", "starting", "starts", "joining", "joins", "hire", "hired", "create an account", "new identity", "first day"],
  mover: ["move", "moving", "moves", "transfer", "promot", "department", "manager", "title", "cost centre", "cost center", "relocat", "role change", "changing role", "new role", "secondment"],
  leaver: ["leaving", "leaves", "left the", "resign", "terminat", "offboard", "last day", "final day", "disable", "deprovision", "delete their", "exit"],
  entitlement: ["access", "group", "add", "grant", "membership", "member of", "permission", "role", "entitlement", "remove from", "licence", "license"],
  breakglass: ["admin", "tenantadmin", "break-glass", "breakglass", "break glass", "emergency", "urgent", "urgently", "ciso", "now", "global admin", "privileged"],
  none: [],
};

// Phrases that signal the two guardrail questions the demo policy asks. Matched when the
// question's own words point at that topic, so the stub stays generic for other questions.
const PHRASES = {
  override: ["skip the preview", "skip preview", "skip the check", "skip approval", "bypass", "ignore the policy", "ignore policy", "no need to verify", "don't verify", "do not verify", "without approval", "no approval needed", "just do it", "straight away"],
  urgency: ["ticket to follow", "approval to follow", "paperwork to follow", "right now", "asap", "immediately", "this minute", "from the ciso", "ciso says", "the ceo", "on my authority"],
};

const STOPWORDS = new Set(["the", "a", "an", "or", "and", "to", "of", "with", "without", "that", "this", "is", "are", "as", "by", "for", "in", "on", "it", "its", "be", "any", "all", "not", "no", "does", "do", "has", "have", "their", "they", "them", "he", "she", "his", "her", "which", "what", "request", "asks", "asking", "ask"]);

function tokens(text) {
  return String(text).toLowerCase().split(/[^a-z0-9@.'-]+/).filter(Boolean).map((t) => t.replace(/^[.'-]+|[.'-]+$/g, "")).filter(Boolean);
}

const variants = (token) => (token.length > 3 && token.endsWith("s") ? [token, token.slice(0, -1)] : [token]);

function wordHit(entry, toks) {
  return toks.some((t) => variants(t).some((v) => v === entry || (entry.length >= 4 && v.startsWith(entry))));
}

function related(a, b) {
  return a === b || (a.length >= 5 && b.length >= 5 && a.slice(0, 5) === b.slice(0, 5));
}

function lexiconHits(option, text, toks) {
  const entries = LEXICON[option];
  if (!entries) return null;
  return entries.reduce((n, e) => n + (e.includes(" ") ? (text.includes(e) ? 1 : 0) : wordHit(e, toks) ? 1 : 0), 0);
}

function overlapHits(description, toks) {
  const words = tokens(description).filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  return words.reduce((n, w) => n + (toks.some((t) => variants(t).some((v) => related(v, w))) ? 1 : 0), 0);
}

function softmax(scores, temperature = 2) {
  const exps = scores.map((s) => Math.exp(temperature * s));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

const round = (x) => Math.round(x * 10000) / 10000;

function stateText(state) {
  if (typeof state === "string") return state;
  if (Array.isArray(state)) return state.map(stateText).join("\n");
  if (state && typeof state === "object") return Object.values(state).map(stateText).join("\n");
  return String(state ?? "");
}

function answerChoice(q, text, toks) {
  const options = Object.keys(q.criteria ?? {});
  if (!options.length) throw new Error("choice question needs a criteria map");
  const scores = options.map((o) => lexiconHits(o, text, toks) ?? overlapHits(q.criteria[o], toks));
  const probs = softmax(scores);
  const ranked = options.map((o, i) => [o, probs[i]]).sort((a, b) => b[1] - a[1]);
  const probabilities = Object.fromEntries(options.map((o, i) => [o, round(probs[i])]));
  return { type: "choice", choice: ranked[0][0], probabilities, confidence: round(ranked[0][1] - (ranked[1]?.[1] ?? 0)) };
}

function answerScore(q, toks) {
  const levels = Array.isArray(q.criteria) ? q.criteria : [];
  if (levels.length < 2) throw new Error("score question needs an ordered array of at least two levels");
  const probs = softmax(levels.map((l) => overlapHits(l, toks)));
  const score = probs.reduce((acc, p, i) => acc + i * p, 0);
  return {
    type: "score",
    score: round(score),
    legend: Object.fromEntries(levels.map((l, i) => [String(i), l])),
    probabilities: Object.fromEntries(levels.map((_, i) => [String(i), round(probs[i])])),
    confidence: round(Math.max(...probs) - [...probs].sort((a, b) => b - a)[1]),
  };
}

function answerNoul(q, text, toks) {
  const instruction = String(q.instructions ?? "").toLowerCase();
  let hits = overlapHits(instruction, toks);
  const topic = /skip|bypass|ignore|override|verification|approval|preview/.test(instruction) ? "override" : /urgen|authority|emergency|ticket|ciso|executive/.test(instruction) ? "urgency" : null;
  if (topic) hits += PHRASES[topic].reduce((n, p) => n + (text.includes(p) ? 1 : 0), 0);
  return { type: "noul", noul: round(Math.min(0.98, 0.05 + 0.3 * hits)) };
}

/** The Jev / Laya contract: state plus typed questions -> typed answers. Pure and deterministic. */
export async function systemOne(state, questions) {
  const text = stateText(state).toLowerCase();
  const toks = tokens(text);
  const answers = {};
  for (const [name, q] of Object.entries(questions ?? {})) {
    if (q.type === "choice") answers[name] = answerChoice(q, text, toks);
    else if (q.type === "score") answers[name] = answerScore(q, toks);
    else if (q.type === "noul") answers[name] = answerNoul(q, text, toks);
    else throw new Error(`question "${name}": unknown type ${q.type}; expected choice, score or noul`);
  }
  return { model: MODEL_ID, answers, usage: { input_tokens: toks.length, output_tokens: 0 } };
}
