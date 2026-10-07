#!/usr/bin/env node
// Validates the skill pack without any dependency: SKILL.md frontmatter rules
// for the six expected skills, the policy embedded in entra-lifecycle-policy's
// SKILL.md against the canonical policy/lifecycle-policy.json, referential
// integrity inside the policy, and the demo seed against the policy catalog.
//
//   node scripts/validate-skills.mjs
//
// Env: SKILLS_DIR (default <repo>/.claude/skills), SEED_FILE (default
// <repo>/demo/seed/contoso-demo-seed.json), ALLOW_MISSING_POLICY=1 to pass
// when the policy files do not exist yet. Exit 1 on any failure.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SKILLS = [
  "entra-lifecycle-policy",
  "entitlement-guardrail",
  "identity-change-auditor",
  "joiner-orchestrator",
  "mover-orchestrator",
  "leaver-orchestrator",
  "lifecycle-intake",
];
const POLICY_SKILL = "entra-lifecycle-policy";
const NON_POLICY_SKILLS = SKILLS.filter((name) => name !== POLICY_SKILL);
const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const NAME_MAX = 64;
const DESCRIPTION_MAX = 1024;
const BODY_WARN_LINES = 500;
// MCPJam's fallback skill-catalog budget, used when the model's context length is unknown. The live cap is
// 2% of the model's context window at about 4 chars per token (16,000 for a 200k-token model), so 8,000 is
// the conservative floor to validate against.
const CATALOG_BUDGET_CHARS = 8000;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillsDir = resolve(process.env.SKILLS_DIR ?? join(repoRoot, ".claude", "skills"));
const seedFile = resolve(process.env.SEED_FILE ?? join(repoRoot, "demo", "seed", "contoso-demo-seed.json"));

const errors = [];
const warnings = [];
const fail = (message) => errors.push(message);
const warn = (message) => warnings.push(message);
const out = (line) => process.stdout.write(`${line}\n`);

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

/**
 * Minimal YAML subset: top-level `key: value` with single-line plain, "double"
 * or 'single' quoted scalars, and `>` / `|` block scalars (with optional +/-
 * chomping). Indented lines outside a block scalar (nested maps such as
 * metadata) are skipped. Enough for the skill spec's fields; anything else
 * surfaces as a validation error rather than a guess.
 */
function parseFrontmatter(lines) {
  const fields = new Map();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const match = line.match(/^([A-Za-z0-9_-]+):(.*)$/);
    if (!match) {
      i++;
      continue;
    }
    const key = match[1];
    const rest = match[2].trim();
    const block = rest.match(/^([>|])([+-]?)\s*(#.*)?$/);
    if (block) {
      const collected = [];
      i++;
      while (i < lines.length && (lines[i].trim() === "" || /^\s/.test(lines[i]))) {
        collected.push(lines[i]);
        i++;
      }
      const indents = collected.filter((l) => l.trim() !== "").map((l) => l.match(/^\s*/)[0].length);
      const indent = indents.length ? Math.min(...indents) : 0;
      const body = collected.map((l) => (l.trim() === "" ? "" : l.slice(indent)));
      const text = block[1] === "|" ? body.join("\n") : foldLines(body);
      fields.set(key, text.replace(/\s+$/, "") + (block[2] === "+" ? "\n" : ""));
      continue;
    }
    fields.set(key, parseScalar(rest));
    i++;
  }
  return fields;
}

function foldLines(body) {
  let text = "";
  for (const line of body) {
    if (line === "") {
      text = text.replace(/ $/, "") + "\n";
    } else {
      text += (text === "" || text.endsWith("\n") ? "" : " ") + line.trim();
    }
  }
  return text;
}

function parseScalar(raw) {
  if (raw.startsWith('"')) {
    const end = raw.lastIndexOf('"');
    if (end <= 0) throw new Error(`unterminated double-quoted value: ${raw}`);
    const escapes = { '"': '"', "\\": "\\", n: "\n", t: "\t" };
    return raw.slice(1, end).replace(/\\(["\\nt])/g, (_, c) => escapes[c]);
  }
  if (raw.startsWith("'")) {
    const end = raw.lastIndexOf("'");
    if (end <= 0) throw new Error(`unterminated single-quoted value: ${raw}`);
    return raw.slice(1, end).replace(/''/g, "'");
  }
  const comment = raw.indexOf(" #");
  return (comment === -1 ? raw : raw.slice(0, comment)).trim();
}

function readSkill(dirName) {
  const skillFile = join(skillsDir, dirName, "SKILL.md");
  if (!existsSync(skillFile)) return { dirName, error: `${skillFile} not found` };
  const text = readFileSync(skillFile, "utf8").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  if (lines[0] !== "---") return { dirName, error: `${skillFile}: first line must be exactly "---"` };
  const close = lines.indexOf("---", 1);
  if (close === -1) return { dirName, error: `${skillFile}: frontmatter is not closed by a "---" line` };
  let fields;
  try {
    fields = parseFrontmatter(lines.slice(1, close));
  } catch (err) {
    return { dirName, error: `${skillFile}: ${err.message}` };
  }
  return {
    dirName,
    skillFile,
    fields,
    body: lines.slice(close + 1).join("\n"),
    lineCount: lines.length,
  };
}

function validateSkill(skill) {
  if (skill.error) {
    fail(skill.error);
    out(`FAIL  ${skill.dirName}`);
    return null;
  }
  const { dirName, skillFile, fields, body, lineCount } = skill;
  const name = fields.get("name");
  const description = fields.get("description");
  let ok = true;
  if (typeof name !== "string" || name.length === 0) {
    fail(`${dirName}: frontmatter "name" is missing`);
    ok = false;
  } else {
    if (name !== dirName) {
      fail(`${dirName}: name "${name}" must equal the directory name`);
      ok = false;
    }
    if (!NAME_PATTERN.test(name)) {
      fail(`${dirName}: name "${name}" must match ${NAME_PATTERN} (lowercase, digits, single hyphens)`);
      ok = false;
    }
    if (name.length > NAME_MAX) {
      fail(`${dirName}: name is ${name.length} chars; max ${NAME_MAX}`);
      ok = false;
    }
  }
  if (typeof description !== "string" || description.trim().length === 0) {
    fail(`${dirName}: frontmatter "description" is missing or empty`);
    ok = false;
  } else if (description.length > DESCRIPTION_MAX) {
    fail(`${dirName}: description is ${description.length} chars; max ${DESCRIPTION_MAX}`);
    ok = false;
  }
  if (body.trim().length === 0) {
    fail(`${dirName}: SKILL.md body is empty`);
    ok = false;
  }
  if (lineCount > BODY_WARN_LINES) {
    warn(`${dirName}: SKILL.md is ${lineCount} lines (> ${BODY_WARN_LINES}); consider moving detail into references/`);
  }
  if (ok) {
    out(`OK    ${dirName.padEnd(26)} ${String(lineCount).padStart(4)} lines, description ${description.length} chars`);
  } else {
    out(`FAIL  ${dirName.padEnd(26)} (${skillFile})`);
  }
  return ok ? { name, description, body } : null;
}

// ---------------------------------------------------------------------------
// Policy: embed drift + referential integrity
// ---------------------------------------------------------------------------

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

/** First path at which two JSON values differ, for a drift message a human can act on. */
function firstDiff(a, b, path = "$") {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path} (array length ${a.length} vs ${b.length})`;
    for (let i = 0; i < a.length; i++) {
      const diff = firstDiff(a[i], b[i], `${path}[${i}]`);
      if (diff) return diff;
    }
    return null;
  }
  const isObject = (v) => v && typeof v === "object" && !Array.isArray(v);
  if (isObject(a) && isObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of [...keys].sort()) {
      if (!(key in a)) return `${path}.${key} (only in policy file)`;
      if (!(key in b)) return `${path}.${key} (only in embedded block)`;
      const diff = firstDiff(a[key], b[key], `${path}.${key}`);
      if (diff) return diff;
    }
    return null;
  }
  return JSON.stringify(a) === JSON.stringify(b) ? null : `${path} (${JSON.stringify(a)} vs ${JSON.stringify(b)})`;
}

function extractEmbeddedPolicy(body) {
  const lines = body.split("\n");
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimEnd() !== "```json policy") continue;
    const close = lines.findIndex((line, idx) => idx > i && line.trimEnd() === "```");
    if (close === -1) throw new Error("```json policy block is never closed by a ``` line");
    blocks.push(lines.slice(i + 1, close).join("\n"));
    i = close;
  }
  if (blocks.length === 0) throw new Error('no fenced block opening with the line "```json policy" found');
  if (blocks.length > 1) warn(`${POLICY_SKILL}: ${blocks.length} "json policy" blocks found; only the first is compared`);
  try {
    return JSON.parse(blocks[0]);
  } catch (err) {
    throw new Error(`embedded "json policy" block is not valid JSON: ${err.message}`);
  }
}

function checkPolicyEmbed(policySkill, policy) {
  let embedded;
  try {
    embedded = extractEmbeddedPolicy(policySkill.body);
  } catch (err) {
    fail(`${POLICY_SKILL}/SKILL.md: ${err.message}`);
    return;
  }
  const a = canonical(embedded);
  const b = canonical(policy);
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    fail(`${POLICY_SKILL}: embedded "json policy" block drifts from policy/lifecycle-policy.json at ${firstDiff(a, b)}`);
  } else {
    out(`OK    embedded policy block matches policy/lifecycle-policy.json (${policy.policyId ?? "?"} v${policy.policyVersion ?? "?"})`);
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function checkPolicyReferences(policy) {
  const catalogEntries = asArray(policy.groupCatalog);
  if (catalogEntries.length === 0) {
    fail("policy: groupCatalog is missing or empty");
    return null;
  }
  const catalog = new Set(catalogEntries.map((g) => g?.displayName).filter((n) => typeof n === "string"));
  const refs = [];
  const collect = (path, names) => {
    for (const name of asArray(names)) refs.push({ path, name });
  };

  asArray(policy.sodRules).forEach((rule, i) =>
    collect(`sodRules[${rule?.id ?? i}].conflictingGroups`, rule?.conflictingGroups),
  );
  collect("privilegedGroups.displayNames", policy.privilegedGroups?.displayNames);
  collect("privilegedGroups.rules.breakglassOnlyGroups", policy.privilegedGroups?.rules?.breakglassOnlyGroups);
  for (const [profileName, profile] of Object.entries(policy.approvedBaselineProfiles?.profiles ?? {})) {
    collect(`approvedBaselineProfiles.profiles.${profileName}.baseGroups`, profile?.baseGroups);
    for (const [dept, groups] of Object.entries(profile?.departmentGroups ?? {})) {
      collect(`approvedBaselineProfiles.profiles.${profileName}.departmentGroups.${dept}`, groups);
    }
  }
  asArray(policy.retainedAccessRules).forEach((rule, i) =>
    collect(`retainedAccessRules[${rule?.id ?? i}].groups`, rule?.groups),
  );

  for (const { path, name } of refs) {
    if (!catalog.has(name)) fail(`policy: ${path} references "${name}", which is not in groupCatalog`);
  }

  const sets = new Set(asArray(policy.customSecurityAttributes?.attributeSets));
  if (sets.size === 0) fail("policy: customSecurityAttributes.attributeSets is missing or empty");
  let setRefs = 0;
  asArray(policy.requiredJoinerAttributes?.customSecurityAttributes).forEach((req, i) => {
    setRefs++;
    if (!sets.has(req?.set)) {
      fail(`policy: requiredJoinerAttributes.customSecurityAttributes[${req?.id ?? i}].set "${req?.set}" is not in customSecurityAttributes.attributeSets`);
    }
  });
  catalogEntries.forEach((group) => {
    asArray(group?.requiresCsa).forEach((cond, i) => {
      setRefs++;
      if (!sets.has(cond?.set)) {
        fail(`policy: groupCatalog[${group?.displayName}].requiresCsa[${i}].set "${cond?.set}" is not in customSecurityAttributes.attributeSets`);
      }
    });
  });

    // Intake: routing targets must be skills in this pack (or "refuse"), the eventType options
  // must be exactly the routing keys, and the thresholds must be probabilities.
  const intake = policy.intake;
  if (!intake) {
    fail("policy: intake section is missing");
  } else {
    const routeTargets = new Set([...NON_POLICY_SKILLS, "refuse"]);
    for (const [option, target] of Object.entries(intake.routing ?? {})) {
      if (!routeTargets.has(target)) fail(`policy: intake.routing.${option} = "${target}" is not a skill in this pack or "refuse"`);
    }
    const options = Object.keys(intake.questions?.eventType?.criteria ?? {}).sort();
    const routes = Object.keys(intake.routing ?? {}).sort();
    if (JSON.stringify(options) !== JSON.stringify(routes)) {
      fail(`policy: intake.questions.eventType.criteria options [${options.join(", ")}] must equal intake.routing keys [${routes.join(", ")}]`);
    }
    for (const [name, value] of Object.entries(intake.thresholds ?? {})) {
      if (typeof value !== "number" || value < 0 || value > 1) fail(`policy: intake.thresholds.${name} must be a probability in [0, 1]`);
    }
    for (const [name, q] of Object.entries(intake.questions ?? {})) {
      if (q?.type === "choice" && Object.keys(q.criteria ?? {}).length < 2) fail(`policy: intake.questions.${name} (choice) needs at least two criteria options`);
    }
  }

const budgetKeys = Object.keys(policy.costThresholds?.maxToolCallsPerRun ?? {}).sort();
  const expected = [...NON_POLICY_SKILLS].sort();
  if (JSON.stringify(budgetKeys) !== JSON.stringify(expected)) {
    fail(`policy: costThresholds.maxToolCallsPerRun keys [${budgetKeys.join(", ")}] must be exactly [${expected.join(", ")}]`);
  }
  out(`OK    policy cross-references: ${refs.length} group ref(s) against ${catalog.size} catalog groups, ${setRefs} CSA set ref(s), ${budgetKeys.length} budget key(s), ${Object.keys(policy.intake?.routing ?? {}).length} intake route(s)`);
  return catalog;
}

function checkSeed(catalog) {
  if (!existsSync(seedFile)) {
    out(`SKIP  seed check: ${seedFile} not found`);
    return;
  }
  let seed;
  try {
    seed = JSON.parse(readFileSync(seedFile, "utf8"));
  } catch (err) {
    fail(`seed: ${seedFile} is not valid JSON: ${err.message}`);
    return;
  }
  const users = new Set(asArray(seed.users).map((u) => u?.userName?.toLowerCase()).filter(Boolean));
  const seedGroups = asArray(seed.groups).map((g) => g?.displayName).filter((n) => typeof n === "string");
  for (const name of seedGroups) {
    if (!catalog.has(name)) fail(`seed: groups[] displayName "${name}" is not in the policy groupCatalog`);
  }
  for (const name of catalog) {
    if (!seedGroups.includes(name)) warn(`seed: catalog group "${name}" is not seeded, so the demo tenant cannot resolve it`);
  }
  const managers = seed["x-managers"] ?? {};
  const memberships = seed["x-memberships"] ?? {};
  for (const [user, manager] of Object.entries(managers)) {
    if (!users.has(user.toLowerCase())) fail(`seed: x-managers key "${user}" is not a seeded userName`);
    if (typeof manager !== "string" || !users.has(manager.toLowerCase())) {
      fail(`seed: x-managers["${user}"] = "${manager}" is not a seeded userName`);
    }
  }
  for (const [group, members] of Object.entries(memberships)) {
    if (!catalog.has(group)) fail(`seed: x-memberships key "${group}" is not in the policy groupCatalog`);
    for (const member of asArray(members)) {
      if (typeof member !== "string" || !users.has(member.toLowerCase())) {
        fail(`seed: x-memberships["${group}"] member "${member}" is not a seeded userName`);
      }
    }
  }
  out(`OK    seed: ${users.size} user(s), ${seedGroups.length} group(s), ${Object.keys(managers).length} manager link(s), ${Object.keys(memberships).length} membership group(s) checked against the catalog`);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

out(`validate-skills: ${skillsDir}`);
const validated = new Map();
for (const dirName of SKILLS) {
  const result = validateSkill(readSkill(dirName));
  if (result) validated.set(dirName, result);
}

const descriptionChars = [...validated.values()].reduce((sum, s) => sum + s.description.length, 0);
const catalogChars = [...validated.values()].reduce((sum, s) => sum + s.name.length + s.description.length, 0);
out(`      descriptions total ${descriptionChars} chars; names + descriptions ${catalogChars} chars (MCPJam fallback catalog budget ${CATALOG_BUDGET_CHARS}; the live cap is 2% of the model's context window) across ${validated.size} of ${SKILLS.length} skills`);
if (catalogChars > CATALOG_BUDGET_CHARS) {
  warn(`names + descriptions total ${catalogChars} chars exceeds MCPJam's ${CATALOG_BUDGET_CHARS}-char fallback catalog budget (the live cap is 2% of the model's context window)`);
}

const policyFile = join(skillsDir, POLICY_SKILL, "policy", "lifecycle-policy.json");
const policySkill = validated.get(POLICY_SKILL);
if (!existsSync(policyFile) || !policySkill) {
  const reason = !existsSync(policyFile) ? `${policyFile} not found` : `${POLICY_SKILL}/SKILL.md did not validate`;
  if (process.env.ALLOW_MISSING_POLICY === "1") {
    out(`SKIP  policy checks: ${reason} (ALLOW_MISSING_POLICY=1)`);
  } else {
    fail(`policy checks could not run: ${reason}. Set ALLOW_MISSING_POLICY=1 to pass without them.`);
  }
} else {
  let policy;
  try {
    policy = JSON.parse(readFileSync(policyFile, "utf8"));
  } catch (err) {
    fail(`${policyFile} is not valid JSON: ${err.message}`);
  }
  if (policy) {
    checkPolicyEmbed(policySkill, policy);
    const catalog = checkPolicyReferences(policy);
    if (catalog) checkSeed(catalog);
  }
}

for (const message of warnings) out(`WARN  ${message}`);
for (const message of errors) out(`FAIL  ${message}`);
if (errors.length > 0) {
  out(`validate-skills: ${errors.length} error(s), ${warnings.length} warning(s)`);
  process.exit(1);
}
out(`validate-skills: OK (${warnings.length} warning(s))`);
