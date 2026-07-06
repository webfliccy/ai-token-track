#!/usr/bin/env node
/**
 * token-cost.mjs — per-feature AI token/cost tracking derived from git history,
 * with optional exact capture of real session usage at commit time.
 *
 * Zero dependencies, zero network calls, zero LLM calls: running this script
 * never spends tokens. Reading local transcript files that your AI tool already
 * wrote is free. All totals are recomputed from `git log` (+ git notes), so
 * additional commits against the same issue automatically increment its total.
 *
 * Attribution (first match wins):
 *   1. Issue refs in the commit message:  #42, closes #42, (closes #16, #17)
 *      -> feature key "#42" (multiple refs split the commit's tokens evenly)
 *   2. Conventional-commit scope:  feat(auth): ...  -> feature key "auth"
 *   3. Otherwise -> "unattributed"
 *
 * Token source per commit (first match wins):
 *   1. Token-Usage trailer in the commit message (manual exact):
 *        Token-Usage: input=182000 output=9400 model=claude-sonnet-5
 *   2. Git note on refs/notes/token-usage (written by `record`/`capture` from
 *      real session transcripts — per-model, includes cache tokens)
 *   3. Heuristic estimate from diff size (see "estimation" in config)
 *
 * Cost is computed PER MODEL:
 *   cost = (input + cacheWrite×writeMult + cacheRead×readMult)/1M × inputPerMTok
 *        + output/1M × outputPerMTok
 *
 * Usage:
 *   node scripts/token-cost/token-cost.mjs report [--md|--json] [--since <rev>]
 *   node scripts/token-cost/token-cost.mjs record        # post-commit hook: capture session usage -> git note + print
 *   node scripts/token-cost/token-cost.mjs capture --input N --output N [--model X]   # manual exact entry for HEAD
 *   node scripts/token-cost/token-cost.mjs install-hook  # writes .git/hooks/post-commit
 */

import { execFileSync } from "node:child_process";
import {
  readFileSync, writeFileSync, chmodSync, existsSync, readdirSync,
  openSync, closeSync, readSync, writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
// Root of the repo being measured: the one the command runs in, not the one
// the script file lives in — they differ when this repo is vendored as a
// submodule and reached through a symlink (Node resolves symlinks when
// loading ES modules, so script-relative paths would point at the submodule).
function resolveRepoRoot() {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  } catch {
    return resolve(scriptDir, "..", "..");
  }
}
const repoRoot = resolveRepoRoot();
const NOTES_REF = "token-usage";

// ---------- config ----------

function loadConfig() {
  const path = join(repoRoot, "token-costs.config.json");
  if (!existsSync(path)) {
    console.error(`Missing ${path} — see docs/token-cost-tracking.md.`);
    process.exit(1);
  }
  const cfg = JSON.parse(readFileSync(path, "utf8"));
  cfg._exclude = (cfg.excludePaths ?? []).map((p) => new RegExp(p));
  cfg.cache = { readMultiplier: 0.1, writeMultiplier: 1.25, ...cfg.cache };
  cfg.capture = { claudeProjectsDir: "~/.claude/projects", ...cfg.capture };
  return cfg;
}

const expandHome = (p) => (p.startsWith("~") ? join(homedir(), p.slice(1)) : p);

// ---------- git plumbing ----------

function git(args, opts = {}) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
}

const NUL = "\x00";

/** Parse `git log --numstat` into [{hash, subject, body, note, files:[{add,del,path}]}] */
function notesRefExists() {
  try {
    git(["show-ref", "--verify", "--quiet", `refs/notes/${NOTES_REF}`], { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

function readCommits(range) {
  // %x00 produces NUL bytes in git's *output* (safe separators — they can't
  // appear in commit messages or notes); the format string itself stays ASCII.
  // Only ask for notes once the ref exists — git warns loudly otherwise.
  const args = [
    "log", "--numstat", "--no-merges",
    ...(notesRefExists() ? [`--notes=${NOTES_REF}`] : ["--no-notes"]),
    "--format=%x00COMMIT%x00%H%x00%s%x00%b%x00%N%x00END%x00",
  ];
  if (range) args.push(range);
  const raw = git(args);
  const commits = [];
  for (const chunk of raw.split(`${NUL}COMMIT${NUL}`)) {
    if (!chunk.trim()) continue;
    const endIdx = chunk.indexOf(`${NUL}END${NUL}`);
    if (endIdx === -1) continue;
    const [hash, subject, body, note] = chunk.slice(0, endIdx).split(NUL);
    const files = [];
    for (const line of chunk.slice(endIdx + 5).split("\n")) {
      const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (!m) continue;
      files.push({ add: m[1] === "-" ? 0 : +m[1], del: m[2] === "-" ? 0 : +m[2], path: m[3] });
    }
    commits.push({ hash, subject, body: body ?? "", note: (note ?? "").trim(), files });
  }
  return commits;
}

// ---------- attribution ----------

function featureKeys(commit) {
  const msg = `${commit.subject}\n${commit.body}`;
  const issues = [...new Set([...msg.matchAll(/#(\d+)\b/g)].map((m) => `#${m[1]}`))];
  if (issues.length > 0) return issues;
  const scope = commit.subject.match(/^\w+\(([^)]+)\)!?:/);
  if (scope) return [scope[1]];
  return ["unattributed"];
}

// ---------- token accounting ----------
// A usage record is { models: { <model>: {input, output, cacheRead, cacheWrite} }, exact: bool }

const emptyModelUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

function parseTrailer(commit, cfg) {
  const m = `${commit.subject}\n${commit.body}`.match(
    /^Token-Usage:\s*input=(\d+)\s+output=(\d+)(?:\s+model=(\S+))?\s*$/im
  );
  if (!m) return null;
  const model = m[3] ?? cfg.defaultModel;
  return { models: { [model]: { ...emptyModelUsage(), input: +m[1], output: +m[2] } }, exact: true };
}

function parseNote(commit) {
  if (!commit.note) return null;
  try {
    const data = JSON.parse(commit.note);
    if (!data.models || typeof data.models !== "object") return null;
    const models = {};
    for (const [model, u] of Object.entries(data.models)) {
      models[model] = { ...emptyModelUsage(), ...u };
    }
    return { models, exact: true };
  } catch {
    return null; // unrelated note on this ref — ignore
  }
}

function estimateTokens(commit, cfg) {
  const { charsPerLine, charsPerToken, inputMultiplier } = cfg.estimation;
  let lines = 0;
  for (const f of commit.files) {
    if (cfg._exclude.some((re) => re.test(f.path))) continue;
    lines += f.add;
  }
  const output = Math.round((lines * charsPerLine) / charsPerToken);
  return {
    models: { [cfg.defaultModel]: { ...emptyModelUsage(), input: output * inputMultiplier, output } },
    exact: false,
  };
}

const usageForCommit = (commit, cfg) =>
  parseTrailer(commit, cfg) ?? parseNote(commit) ?? estimateTokens(commit, cfg);

/** Cost of one model's usage; null if the model has no price entry. Always
 *  priced at API rates — in subscription mode this is the API-equivalent
 *  figure (the plan's marginal cost is $0; output labels it accordingly). */
function costOfModel(model, u, cfg) {
  const price = cfg.models[model];
  if (!price) return null;
  const { readMultiplier, writeMultiplier } = cfg.cache;
  const effectiveInput = u.input + u.cacheWrite * writeMultiplier + u.cacheRead * readMultiplier;
  return (effectiveInput / 1e6) * price.inputPerMTok + (u.output / 1e6) * price.outputPerMTok;
}

// ---------- session-usage capture (Claude Code transcripts) ----------

/**
 * Read real usage from Claude Code's local transcript JSONL files for this
 * project, for entries in (sinceMs, untilMs], grouped by session so the
 * caller can decide which sessions belong to this commit. Purely local reads.
 * Returns { sessions: [{id, label, lastTs, perModel}], transcriptDir, found }.
 */
function readSessionUsage(cfg, sinceMs, untilMs) {
  const slug = repoRoot.replace(/[/.]/g, "-");
  const dir = join(expandHome(cfg.capture.claudeProjectsDir), slug);
  if (!existsSync(dir)) return { sessions: [], transcriptDir: dir, found: false };
  const sessions = new Map();
  const seen = new Set();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".jsonl")) continue;
    for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      const sid = e.sessionId ?? file.replace(/\.jsonl$/, "");
      // Remember each session's first user message as a human-readable label
      // for the "was this session related?" prompt.
      if (e.type === "user" && e.message?.content) {
        const c = e.message.content;
        const text = typeof c === "string" ? c : c.find?.((b) => b.type === "text")?.text ?? "";
        if (text && !text.startsWith("<") && sessions.get(sid)?.label === undefined) {
          const s = sessions.get(sid) ?? { id: sid, lastTs: 0, perModel: {} };
          s.label = text.replace(/\s+/g, " ").trim().slice(0, 60);
          sessions.set(sid, s);
        }
        continue;
      }
      if (e.type !== "assistant") continue;
      const usage = e.message?.usage;
      const model = e.message?.model;
      if (!usage || !model || model === "<synthetic>") continue;
      const ts = Date.parse(e.timestamp ?? "");
      if (!(ts > sinceMs && ts <= untilMs)) continue;
      const key = `${e.message.id ?? ""}:${e.requestId ?? ""}`;
      if (key !== ":" && seen.has(key)) continue; // streamed responses can repeat
      seen.add(key);
      const s = sessions.get(sid) ?? { id: sid, lastTs: 0, perModel: {} };
      s.lastTs = Math.max(s.lastTs, ts);
      const u = (s.perModel[model] ??= emptyModelUsage());
      u.input += usage.input_tokens ?? 0;
      u.output += usage.output_tokens ?? 0;
      u.cacheRead += usage.cache_read_input_tokens ?? 0;
      u.cacheWrite += usage.cache_creation_input_tokens ?? 0;
      sessions.set(sid, s);
    }
  }
  // Only sessions that actually accrued usage inside the window count.
  const list = [...sessions.values()].filter((s) => Object.keys(s.perModel).length > 0);
  list.sort((a, b) => b.lastTs - a.lastTs);
  return { sessions: list, transcriptDir: dir, found: true };
}

function mergeModels(target, source) {
  for (const [model, u] of Object.entries(source)) {
    const t = (target[model] ??= emptyModelUsage());
    t.input += u.input; t.output += u.output;
    t.cacheRead += u.cacheRead; t.cacheWrite += u.cacheWrite;
  }
  return target;
}

/**
 * Synchronous [Y/n] prompt on the controlling terminal. Git hooks usually run
 * with stdin detached, but /dev/tty still reaches the user's terminal. When
 * there is no terminal (CI, GUI clients), returns fallback without blocking.
 */
function askYesNo(question, fallback = true) {
  let fd;
  try { fd = openSync("/dev/tty", "r+"); } catch { return fallback; }
  try {
    writeSync(fd, question);
    const buf = Buffer.alloc(256);
    let line = "";
    while (!line.includes("\n")) {
      let n;
      try { n = readSync(fd, buf, 0, 256, null); } catch (err) {
        if (err.code === "EAGAIN") continue;
        return fallback;
      }
      if (n <= 0) break;
      line += buf.toString("utf8", 0, n);
    }
    const a = line.trim().toLowerCase();
    return a === "" ? fallback : a === "y" || a === "yes";
  } finally {
    closeSync(fd);
  }
}

const fmtAge = (ms) => (ms < 3600e3 ? `${Math.max(1, Math.round(ms / 60e3))}m` : `${(ms / 3600e3).toFixed(1)}h`);

/**
 * Decide which captured sessions belong to this commit. The session still
 * active (or active within staleAfterMinutes) is included automatically;
 * for every other session the user is asked, since usage from an earlier
 * session may be unrelated exploration. Declined usage is dropped for good —
 * the capture window advances regardless, so it won't attach to a later
 * commit either. No terminal → include everything (previous behavior).
 */
function selectSessions(sessions, cfg, untilMs) {
  if (sessions.length === 0) return {};
  const promptEnabled = cfg.capture.promptForPreviousSessions !== false;
  const staleMs = (cfg.capture.staleAfterMinutes ?? 60) * 60e3;
  const perModel = {};
  const describe = (s) => {
    const totals = Object.values(s.perModel).reduce(
      (a, u) => ({ in: a.in + u.input + u.cacheRead + u.cacheWrite, out: a.out + u.output }),
      { in: 0, out: 0 }
    );
    const label = s.label ? ` "${s.label}"` : "";
    return `${s.id.slice(0, 8)}${label} (last active ${fmtAge(untilMs - s.lastTs)} ago, in=${fmtTok(totals.in)} out=${fmtTok(totals.out)})`;
  };
  sessions.forEach((s, i) => {
    const isCurrent = i === 0 && untilMs - s.lastTs <= staleMs;
    if (isCurrent || !promptEnabled) {
      mergeModels(perModel, s.perModel);
      return;
    }
    const include = askYesNo(`[token-cost] include previous session ${describe(s)}? [Y/n] `, true);
    if (include) mergeModels(perModel, s.perModel);
    else console.log(`[token-cost] excluded session ${s.id.slice(0, 8)} — its usage will not attach to any commit`);
  });
  return perModel;
}

const statePath = () => join(repoRoot, ".git", "token-cost-state.json");

function readState() {
  try { return JSON.parse(readFileSync(statePath(), "utf8")); } catch { return {}; }
}

function writeNote(hash, models, source) {
  const payload = JSON.stringify({ models, source, capturedAt: new Date().toISOString() });
  git(["notes", `--ref=${NOTES_REF}`, "add", "-f", "-m", payload, hash]);
}

// ---------- aggregation ----------

function aggregate(commits, cfg) {
  const features = new Map();
  for (const c of commits) {
    const usage = usageForCommit(c, cfg);
    const keys = featureKeys(c);
    const share = 1 / keys.length;
    for (const key of keys) {
      const f = features.get(key) ?? {
        key, commits: 0, input: 0, output: 0, cost: 0,
        exactCommits: 0, unknownModelCost: false, models: new Set(),
      };
      f.commits += 1;
      if (usage.exact) f.exactCommits += 1;
      for (const [model, u] of Object.entries(usage.models)) {
        f.models.add(model);
        f.input += (u.input + u.cacheRead + u.cacheWrite) * share;
        f.output += u.output * share;
        const cost = costOfModel(model, u, cfg);
        if (cost === null) f.unknownModelCost = true;
        else f.cost += cost * share;
      }
      features.set(key, f);
    }
  }
  return [...features.values()].sort((a, b) => b.cost - a.cost || b.output - a.output);
}

// ---------- output ----------

const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${Math.round(n)}`);
const fmtUsd = (n) => `$${n.toFixed(2)}`;
const shortModel = (m) => m.replace(/^claude-/, "");

function renderTable(rows, cfg, md = false) {
  const total = rows.reduce(
    (a, r) => ({ input: a.input + r.input, output: a.output + r.output, cost: a.cost + r.cost, commits: a.commits + r.commits }),
    { input: 0, output: 0, cost: 0, commits: 0 }
  );
  const cost = (r) => fmtUsd(r.cost) + (r.unknownModelCost ? "+?" : "");
  const basis = (r) => (r.exactCommits === r.commits ? "exact" : r.exactCommits > 0 ? "mixed" : "estimate");
  const header = ["Feature", "Commits", "Input tok", "Output tok", "Cost", "Models", "Basis"];
  const body = rows.map((r) => [
    r.key, `${r.commits}`, fmtTok(r.input), fmtTok(r.output), cost(r),
    [...r.models].map(shortModel).join(", "), basis(r),
  ]);
  body.push(["TOTAL", `${total.commits}`, fmtTok(total.input), fmtTok(total.output),
    fmtUsd(total.cost), "", ""]);
  const subNote =
    cfg.billingMode === "subscription"
      ? `Costs are API-equivalent; actual billing is a flat-rate subscription${cfg.subscriptionPlanName ? ` (${cfg.subscriptionPlanName})` : ""} — marginal cost $0.`
      : "";

  if (md) {
    const lines = [`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`];
    for (const row of body) lines.push(`| ${row.join(" | ")} |`);
    if (subNote) lines.push("", `_${subNote}_`);
    lines.push("", `_Input tok includes cache reads/writes; cost prices them at ${cfg.cache.readMultiplier}× / ${cfg.cache.writeMultiplier}× input rate. "estimate" rows are diff-size heuristics (model assumed \`${cfg.defaultModel}\`), not measured usage — see docs/token-cost-tracking.md._`);
    return lines.join("\n");
  }
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)));
  const line = (row) => row.map((cell, i) => cell.padEnd(widths[i])).join("  ");
  const table = [line(header), line(widths.map((w) => "-".repeat(w))), ...body.map(line)];
  if (subNote) table.push("", subNote);
  return table.join("\n");
}

function printCommitSummary(head, usage, cfg) {
  const parts = Object.entries(usage.models).map(([model, u]) => {
    const cost = costOfModel(model, u, cfg);
    const costStr = cost === null ? "cost=?" : fmtUsd(cost) + (cfg.billingMode === "subscription" ? " api-equiv" : "");
    return `${shortModel(model)}: in=${fmtTok(u.input + u.cacheRead + u.cacheWrite)} out=${fmtTok(u.output)} ${costStr}`;
  });
  const keys = featureKeys(head);
  console.log(`[token-cost] ${head.hash.slice(0, 7)} → ${keys.join(", ")} (${usage.exact ? "exact" : "estimated"})`);
  for (const p of parts) console.log(`[token-cost]   ${p}`);
  const all = aggregate(readCommits(), cfg);
  for (const key of keys) {
    const f = all.find((r) => r.key === key);
    if (f) {
      console.log(
        `[token-cost] ${key} running total: in=${fmtTok(f.input)} out=${fmtTok(f.output)} ` +
          `cost=${fmtUsd(f.cost)}${cfg.billingMode === "subscription" ? " api-equiv" : ""} over ${f.commits} commit(s)`
      );
    }
  }
}

// ---------- commands ----------

const args = process.argv.slice(2);
const cmd = args[0] ?? "report";
const cfg = loadConfig();
const argVal = (name) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};

if (cmd === "report") {
  const since = argVal("--since");
  const rows = aggregate(readCommits(since ? `${since}..HEAD` : undefined), cfg);
  if (args.includes("--json")) {
    const out = rows.map((r) => ({ ...r, models: [...r.models] }));
    console.log(JSON.stringify({ defaultModel: cfg.defaultModel, billingMode: cfg.billingMode, subscriptionPlanName: cfg.subscriptionPlanName || undefined, features: out }, null, 2));
  } else {
    console.log(renderTable(rows, cfg, args.includes("--md")));
  }
} else if (cmd === "record") {
  // Post-commit hook: capture real session usage since the last capture (or the
  // previous commit) into a git note on HEAD, then print commit + running totals.
  const head = readCommits("HEAD~1..HEAD")[0] ?? readCommits("HEAD")[0];
  if (!head) process.exit(0);

  if (!parseTrailer(head, cfg)) {
    const state = readState();
    let sinceMs = state.lastCaptureMs;
    if (!sinceMs) {
      try { sinceMs = +git(["log", "-1", "--format=%ct", "HEAD~1"]).trim() * 1000; } catch { sinceMs = 0; }
    }
    const untilMs = Date.now();
    const { sessions, transcriptDir, found } = readSessionUsage(cfg, sinceMs, untilMs);
    const perModel = selectSessions(sessions, cfg, untilMs);
    if (sessions.length > 0) {
      // The window advances even when everything was declined — declined usage
      // must not leak into the next commit's capture.
      writeFileSync(statePath(), JSON.stringify({ lastCaptureMs: untilMs }));
    }
    if (Object.keys(perModel).length > 0) {
      writeNote(head.hash, perModel, "claude-code-transcripts");
      head.note = JSON.stringify({ models: perModel }); // so the summary below reads the fresh note
    } else if (!found) {
      console.log(`[token-cost] no transcript dir at ${transcriptDir} — falling back to diff estimate`);
    }
  }

  printCommitSummary(head, usageForCommit(head, cfg), cfg);
} else if (cmd === "capture") {
  // Manual exact entry for HEAD (any AI tool): capture --input N --output N [--model X]
  //   [--cache-read N] [--cache-write N] [--commit <hash>]
  const input = +(argVal("--input") ?? NaN);
  const output = +(argVal("--output") ?? NaN);
  if (Number.isNaN(input) || Number.isNaN(output)) {
    console.error("Usage: capture --input N --output N [--model X] [--cache-read N] [--cache-write N] [--commit <hash>]");
    process.exit(1);
  }
  const model = argVal("--model") ?? cfg.defaultModel;
  const hash = argVal("--commit") ?? "HEAD";
  const models = {
    [model]: {
      input, output,
      cacheRead: +(argVal("--cache-read") ?? 0),
      cacheWrite: +(argVal("--cache-write") ?? 0),
    },
  };
  writeNote(hash, models, "manual");
  console.log(`[token-cost] recorded exact usage on ${hash} for ${model}`);
} else if (cmd === "install-hook") {
  const hookDir = join(repoRoot, ".git", "hooks");
  if (!existsSync(hookDir)) {
    console.error("No .git/hooks directory — run from a git repo.");
    process.exit(1);
  }
  const hookPath = join(hookDir, "post-commit");
  const line = "node scripts/token-cost/token-cost.mjs record || true";
  if (existsSync(hookPath)) {
    const cur = readFileSync(hookPath, "utf8");
    if (cur.includes("token-cost.mjs")) {
      console.log("post-commit hook already installed.");
      process.exit(0);
    }
    writeFileSync(hookPath, cur.trimEnd() + "\n" + line + "\n");
  } else {
    writeFileSync(hookPath, "#!/bin/sh\n" + line + "\n");
  }
  chmodSync(hookPath, 0o755);
  console.log(`Installed post-commit hook at ${hookPath}`);
  console.log(`Tip: share captured usage with CI/teammates via: git push origin refs/notes/${NOTES_REF}`);
} else {
  console.error(`Unknown command: ${cmd}. Use report | record | capture | install-hook.`);
  process.exit(1);
}
