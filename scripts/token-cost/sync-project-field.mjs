#!/usr/bin/env node
/**
 * sync-project-field.mjs — push per-issue AI cost/tokens into GitHub Projects
 * (v2) custom fields, so cost is visible on the project board next to each issue.
 *
 * Creates the number fields "AI Cost (USD)" and "AI Tokens (out)" on the
 * project if they don't exist (custom fields are project-level in Projects v2),
 * then writes each issue's running total onto its project item. Issues not in
 * the project are skipped (use --add-missing to add them).
 *
 * Requires: gh CLI authenticated with `project` scope
 *   gh auth refresh -s project,read:project
 *
 * Usage:
 *   node scripts/token-cost/sync-project-field.mjs --owner <login> --project <number> [--org] [--add-missing] [--dry-run]
 */

import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
// Same cwd-based resolution as token-cost.mjs: when vendored as a submodule
// behind a symlink, the script's real path is inside the submodule, so the
// repo being measured must come from the working directory instead.
function resolveRepoRoot() {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  } catch {
    return resolve(scriptDir, "..", "..");
  }
}
const repoRoot = resolveRepoRoot();

const COST_FIELD = "AI Cost (USD)";
const TOKENS_FIELD = "AI Tokens (out)";

const args = process.argv.slice(2);
const argVal = (name) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};
const owner = argVal("--owner");
const projectNumber = +(argVal("--project") ?? NaN);
const isOrg = args.includes("--org");
const addMissing = args.includes("--add-missing");
const dryRun = args.includes("--dry-run");

if (!owner || Number.isNaN(projectNumber)) {
  console.error("Usage: sync-project-field.mjs --owner <login> --project <number> [--org] [--add-missing] [--dry-run]");
  process.exit(1);
}

function gql(query, variables = {}) {
  // Body goes via stdin as JSON — `gh -F` stringifies floats, which GraphQL
  // Float! variables then reject.
  const out = execFileSync("gh", ["api", "graphql", "--input", "-"], {
    encoding: "utf8",
    input: JSON.stringify({ query, variables }),
  });
  return JSON.parse(out).data;
}

// ---------- 1. per-issue totals from the token-cost report ----------

const report = JSON.parse(
  execFileSync("node", [join(repoRoot, "scripts/token-cost/token-cost.mjs"), "report", "--json"], {
    cwd: repoRoot, encoding: "utf8",
  })
);
const issueTotals = new Map(); // issueNumber -> {cost, output}
for (const f of report.features) {
  const m = f.key.match(/^#(\d+)$/);
  if (m) issueTotals.set(+m[1], { cost: f.cost, output: Math.round(f.output) });
}
if (issueTotals.size === 0) {
  console.log("No issue-attributed features in the report — nothing to sync.");
  process.exit(0);
}

// ---------- 2. project + fields ----------

const ownerType = isOrg ? "organization" : "user";
const projData = gql(
  `query($owner:String!,$number:Int!){ ${ownerType}(login:$owner){ projectV2(number:$number){ id title } } }`,
  { owner, number: projectNumber }
);
const project = projData[ownerType]?.projectV2;
if (!project) {
  console.error(`No project #${projectNumber} found for ${ownerType} ${owner}.`);
  process.exit(1);
}
console.log(`Project: "${project.title}" (${project.id})`);

function listFields() {
  const d = gql(
    `query($pid:ID!){ node(id:$pid){ ... on ProjectV2 { fields(first:50){ nodes { ... on ProjectV2FieldCommon { id name dataType } } } } } }`,
    { pid: project.id }
  );
  return d.node.fields.nodes;
}

function ensureNumberField(name) {
  const existing = listFields().find((f) => f.name === name);
  if (existing) {
    if (existing.dataType !== "NUMBER") {
      console.error(`Field "${name}" exists but is ${existing.dataType}, not NUMBER — rename or delete it first.`);
      process.exit(1);
    }
    return existing.id;
  }
  if (dryRun) {
    console.log(`[dry-run] would create number field "${name}"`);
    return null;
  }
  const d = gql(
    `mutation($pid:ID!,$name:String!){ createProjectV2Field(input:{projectId:$pid, dataType:NUMBER, name:$name}){ projectV2Field { ... on ProjectV2Field { id } } } }`,
    { pid: project.id, name }
  );
  console.log(`Created project field "${name}"`);
  return d.createProjectV2Field.projectV2Field.id;
}

const costFieldId = ensureNumberField(COST_FIELD);
const tokensFieldId = ensureNumberField(TOKENS_FIELD);

// ---------- 3. map issues -> project items ----------

const repoName = execFileSync("git", ["remote", "get-url", "origin"], { cwd: repoRoot, encoding: "utf8" })
  .trim().match(/github\.com[:/]([^/]+\/[^/.]+)/)?.[1];

const itemByIssue = new Map();
let cursor = null;
do {
  const d = gql(
    `query($pid:ID!,$cursor:String){ node(id:$pid){ ... on ProjectV2 { items(first:100, after:$cursor){
        nodes { id content { ... on Issue { number repository { nameWithOwner } } } }
        pageInfo { hasNextPage endCursor } } } } }`,
    cursor ? { pid: project.id, cursor } : { pid: project.id }
  );
  const items = d.node.items;
  for (const it of items.nodes) {
    if (it.content?.number && (!repoName || it.content.repository.nameWithOwner === repoName)) {
      itemByIssue.set(it.content.number, it.id);
    }
  }
  cursor = items.pageInfo.hasNextPage ? items.pageInfo.endCursor : null;
} while (cursor);

function addIssueToProject(issueNumber) {
  let issue;
  try {
    issue = gql(
      `query($owner:String!,$repo:String!,$number:Int!){ repository(owner:$owner,name:$repo){ issue(number:$number){ id } } }`,
      { owner: repoName.split("/")[0], repo: repoName.split("/")[1], number: issueNumber }
    ).repository?.issue;
  } catch {
    return null; // not an issue (PR number, deleted, or a stray #ref in a commit message)
  }
  if (!issue) return null;
  const d = gql(
    `mutation($pid:ID!,$cid:ID!){ addProjectV2ItemById(input:{projectId:$pid, contentId:$cid}){ item { id } } }`,
    { pid: project.id, cid: issue.id }
  );
  return d.addProjectV2ItemById.item.id;
}

// ---------- 4. write values ----------

let synced = 0, skipped = 0;
for (const [issue, totals] of [...issueTotals.entries()].sort((a, b) => a[0] - b[0])) {
  let itemId = itemByIssue.get(issue);
  if (!itemId && addMissing && !dryRun && repoName) {
    itemId = addIssueToProject(issue);
    if (itemId) console.log(`Added issue #${issue} to the project`);
  }
  if (!itemId) {
    skipped++;
    continue;
  }
  const cost = Math.round(totals.cost * 100) / 100;
  if (dryRun) {
    console.log(`[dry-run] #${issue}: ${COST_FIELD}=${cost}, ${TOKENS_FIELD}=${totals.output}`);
    synced++;
    continue;
  }
  for (const [fieldId, value] of [[costFieldId, cost], [tokensFieldId, totals.output]]) {
    gql(
      `mutation($pid:ID!,$item:ID!,$field:ID!,$value:Float!){ updateProjectV2ItemFieldValue(
          input:{projectId:$pid, itemId:$item, fieldId:$field, value:{number:$value}}){ projectV2Item { id } } }`,
      { pid: project.id, item: itemId, field: fieldId, value }
    );
  }
  console.log(`#${issue}: ${COST_FIELD}=$${cost}, ${TOKENS_FIELD}=${totals.output}`);
  synced++;
}
console.log(`Done: ${synced} issue(s) synced, ${skipped} not in project${addMissing ? "" : " (use --add-missing to add them)"}.`);
