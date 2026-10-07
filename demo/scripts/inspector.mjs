#!/usr/bin/env node
// Launch MCPJam Inspector with this pack's skills in the picker and both demo servers connected.
//
//   npm run inspector                  copy the skills to ~/.mcpjam/skills, write an MCP config with
//                                      absolute paths, run `npx @mcpjam/inspector@3.13.0 --config <it>`
//   npm run inspector -- --port 6275   anything else is passed through to the inspector
//   npm run inspector -- --no-copy     launch without touching ~/.mcpjam/skills
//   npm run inspector -- --copy-only   copy the skills and exit (no browser, no server)
//   npm run inspector -- --clean       remove the copies this script made and exit
//
// Why this exists. Inspector 3.13.0's npx launcher starts its server with the installed package
// as the working directory, so skills under `./.claude/skills` of the folder you launched from are
// never discovered, and stdio servers are spawned from that directory too, so relative paths in
// `.mcp.json` do not resolve. The home-level `~/.mcpjam/skills` is scanned on every request, but
// only real directories count (symlinks and junctions are skipped). Copying the seven skill folders
// there and passing a config with absolute paths gives a reader the one-command experience the
// README describes. The copies are marked so `--clean` removes only what this script created.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const INSPECTOR = "@mcpjam/inspector@3.13.0";
const MARKER = ".entra-lifecycle-guardrails";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const skillsSrc = join(repo, ".claude", "skills");
const skillsDest = join(homedir(), ".mcpjam", "skills");

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const passthrough = argv.filter((a) => !["--no-copy", "--copy-only", "--clean", "--help", "-h"].includes(a));

if (has("--help") || has("-h")) {
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
  process.exit(0);
}

function skillDirs() {
  return readdirSync(skillsSrc, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(skillsSrc, d.name, "SKILL.md")))
    .map((d) => d.name)
    .sort();
}

function copySkills() {
  mkdirSync(skillsDest, { recursive: true });
  const copied = [];
  for (const name of skillDirs()) {
    const dest = join(skillsDest, name);
    if (existsSync(dest) && !existsSync(join(dest, MARKER))) {
      console.error(`inspector: ${dest} exists and was not created by this script; leaving it alone. Remove it to let the pack's copy through.`);
      continue;
    }
    rmSync(dest, { recursive: true, force: true });
    cpSync(join(skillsSrc, name), dest, { recursive: true });
    writeFileSync(join(dest, MARKER), `copied from ${join(skillsSrc, name)} on ${new Date().toISOString()}\n`);
    copied.push(name);
  }
  console.log(`inspector: ${copied.length} skill(s) copied to ${skillsDest}: ${copied.join(", ")}`);
  console.log("inspector: `npm run inspector -- --clean` removes them again.");
  return copied;
}

function cleanSkills() {
  if (!existsSync(skillsDest)) { console.log(`inspector: nothing to clean (${skillsDest} does not exist)`); return; }
  const removed = [];
  for (const d of readdirSync(skillsDest, { withFileTypes: true })) {
    if (d.isDirectory() && existsSync(join(skillsDest, d.name, MARKER))) { rmSync(join(skillsDest, d.name), { recursive: true, force: true }); removed.push(d.name); }
  }
  console.log(removed.length ? `inspector: removed ${removed.join(", ")} from ${skillsDest}` : `inspector: no copies made by this script in ${skillsDest}`);
}

/** The repo's .mcp.json with every path-like arg made absolute, so the inspector can spawn the servers from anywhere. */
function writeConfig() {
  const config = JSON.parse(readFileSync(join(repo, ".mcp.json"), "utf8"));
  for (const server of Object.values(config.mcpServers ?? {})) {
    server.args = (server.args ?? []).map((a) => (!isAbsolute(a) && existsSync(join(repo, a)) ? join(repo, a) : a));
  }
  const file = join(tmpdir(), "entra-lifecycle-guardrails.mcpjam.json");
  writeFileSync(file, JSON.stringify(config, null, 2));
  return file;
}

if (has("--clean")) { cleanSkills(); process.exit(0); }
if (!has("--no-copy")) copySkills();
if (has("--copy-only")) process.exit(0);

const configFile = writeConfig();
console.log(`inspector: config with absolute paths written to ${configFile}`);
console.log(`inspector: starting ${INSPECTOR} --config ... ${passthrough.join(" ")}`.trimEnd());
// One quoted command string: `npx` is a .cmd shim on Windows, which needs a shell, and Node 24
// warns when an args array is combined with `shell: true`.
const q = (s) => (/^[A-Za-z0-9_@./:=+-]+$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`);
const command = ["npx", INSPECTOR, "--config", configFile, ...passthrough].map(q).join(" ");
const child = spawn(command, { cwd: repo, stdio: "inherit", shell: true });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
