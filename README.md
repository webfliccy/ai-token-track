# AI token & cost tracking per feature

Tracks how many AI tokens (and dollars) each feature/issue in this repo has consumed, derived entirely from git history. The tooling is a plain Node script — **no LLM or network calls, so running it never spends tokens**.

## How it works

Every commit is attributed to a feature and assigned a token count:

- **Attribution** — issue refs in the commit message win (`#42`, `closes #42`, `(closes #16, #17)` → features `#16`, `#17`, tokens split evenly). If there's no issue ref, the conventional-commit scope is used (`feat(auth): …` → feature `auth`). Otherwise the commit lands in `unattributed`.
- **Additional commits against the same issue increment that issue's total** automatically — totals are recomputed from the full history on every run, so they're reproducible from any clone with no ledger file to keep in sync.

## What the numbers are based on (read this before trusting them)

Per commit, the token source is resolved in this order: **trailer → captured git note → estimate**. The report's Basis column shows which tier each feature's numbers come from (`exact`, `mixed`, or `estimate`).

### 1. Exact, automatic — session usage captured at commit time (recommended)

Claude Code writes every session to local transcript files (`~/.claude/projects/<project>/*.jsonl`) that include the **actual `usage` and `model` of every API response** — main model and subagents alike. The post-commit hook (`record`) reads the usage accrued since the previous capture, sums it **per model**, and attaches it to the new commit as a **git note** on `refs/notes/token-usage`:

```json
{"models": {"claude-sonnet-5":  {"input": 5000, "output": 2000, "cacheRead": 100000, "cacheWrite": 20000},
            "claude-haiku-4-5": {"input": 30000, "output": 1500, "cacheRead": 0, "cacheWrite": 0}},
 "source": "claude-code-transcripts", "capturedAt": "..."}
```

Why this design:

- **Reading transcripts is a purely local file read** — capturing costs zero tokens.
- **Git notes don't touch the commit** — no message rewriting, no extra files in the tree, works after the commit exists.
- **Per-model accuracy** — a session that used Sonnet 5 for the main loop and Haiku for subagents is costed at each model's own rates, and cache reads/writes are priced at their multipliers (`cache.readMultiplier` = 0.1×, `cache.writeMultiplier` = 1.25× input rate) instead of full input price — this matters a lot, since agent sessions are often >90% cache reads.
- The capture window is `(last capture, now]`, tracked in `.git/token-cost-state.json`; the first capture falls back to the previous commit's timestamp. Commits made with no intervening AI usage get no note and fall back to the estimate (usually ≈0 for hand-written tweaks — you can `capture --input 0 --output 0` to zero them explicitly).
- **Previous sessions are confirmed, not assumed.** Usage is grouped by session. The session still active (or active within `capture.staleAfterMinutes`, default 60) is attributed to the commit automatically; for any *other* session in the window — exploration, abandoned work, an old session that never led to a commit — the hook asks in the terminal, labelled with that session's first user message: `include previous session aaaa1111 "research turso pricing options" (last active 2h ago, in=100.0k out=5.0k)? [Y/n]`. Enter/`y` includes it (the exploration was usually part of the feature's cost); `n` drops it permanently — the window still advances, so declined usage never attaches to a later commit. Where no terminal is available (CI, GUI git clients), everything is included without prompting so the hook never hangs. Set `capture.promptForPreviousSessions: false` to always include silently.

**Sharing captured usage** — notes are local until pushed. To make CI and teammates see exact numbers:

```sh
git push origin refs/notes/token-usage        # after committing (add to your push routine)
git fetch origin +refs/notes/token-usage:refs/notes/token-usage   # to pull others' notes
```

The GitHub workflow fetches this ref automatically. (Caveat: notes attach to commit hashes, so a rebase orphans them — squash-merge workflows will fall back to estimates for the squashed commit unless you re-capture.)

**Other AI tools** (Codex CLI, Cursor, aider…): the transcript parser is Claude Code-specific, but any tool can record exact usage with the manual command, using numbers from that tool's usage report:

```sh
node scripts/token-cost/token-cost.mjs capture --input 500000 --output 25000 \
  --model gpt-5.2 --cache-read 200000 [--commit <hash>]
```

### 2. Exact, manual — the `Token-Usage` commit trailer

A trailer in the commit message overrides everything (useful when you want the number baked into the commit itself, immune to rebases):

```
feat: add comment moderation (closes #23)

Token-Usage: input=1820000 output=94000 model=claude-sonnet-5
```

`model` is optional (defaults to `defaultModel`) and must match a key in `models`.

### 3. Estimated — diff-size heuristic (the fallback)

Commits without a trailer are estimated from `git log --numstat`:

```
outputTokens = addedLines × charsPerLine ÷ charsPerToken
inputTokens  = outputTokens × inputMultiplier
```

with defaults `charsPerLine=45`, `charsPerToken=3.5`, `inputMultiplier=20` (coding agents read roughly an order of magnitude more context than they write). Lockfiles and binary assets are excluded via `excludePaths`. These are **rough heuristics** — good enough for relative comparison between features, not for accounting. The report marks such rows `estimate`.

**Calibrate:** after a week of real usage, compare the estimated totals against your provider's usage dashboard and adjust the three `estimation` numbers in `token-costs.config.json`.

### Cost

```
cost = effectiveInput/1M × inputPerMTok + output/1M × outputPerMTok
```

applied **per model** using each model's own prices, where `effective input = input + cacheWrite×1.25 + cacheRead×0.1` (multipliers configurable under `cache`). Cache pricing only applies to captured/manual usage, which carries the cache breakdown; trailers and estimates treat all input as full-price.

Prices live in `token-costs.config.json` → `models`. Claude prices were verified against Anthropic's docs in July 2026 (note Sonnet 5 has intro pricing through 2026-08-31); **the OpenAI/Gemini entries are placeholders — verify against the provider's pricing page before relying on them.** Add any model your team uses under `models` — captured usage referencing a model with no price entry shows `+?` in the cost column rather than silently pricing it wrong.

**Subscription plans** (Claude Pro/Max, ChatGPT Plus, etc.): set `billingMode` to `"subscription"` and optionally `subscriptionPlanName`. Tokens are still tracked (useful for plan-limit awareness) but cost is reported as the plan rather than a dollar figure, since marginal cost is $0.

Not modelled: batch-API discounts (50%), 1-hour-TTL cache writes (2× rather than 1.25×), or per-model intro pricing windows. For estimated commits, if most of your real usage is cache reads the `inputMultiplier` heuristic overstates cost — calibrate it down.

## Setup in your repository

1. **Get the files into place** — two ways:

   **Option A — copy** (no ongoing link to this repo):
   - `scripts/token-cost/token-cost.mjs`
   - `token-costs.config.json` (repo root)
   - `.github/workflows/token-cost.yml` (optional, for GitHub integration)

   **Option B — submodule** (updates arrive via `git submodule update --remote`):
   ```sh
   git submodule add https://github.com/webfliccy/ai-token-track.git vendor/ai-token-track
   ln -s ../vendor/ai-token-track/scripts/token-cost scripts/token-cost
   cp vendor/ai-token-track/token-costs.config.json .
   cp vendor/ai-token-track/.github/workflows/token-cost.yml .github/workflows/   # optional
   ```
   Notes on this layout:
   - The scripts resolve the repo they measure from the **working directory** (`git rev-parse --show-toplevel`), so running them through the symlink measures *your* repo, not the submodule.
   - The config is a deliberate **copy**, not a symlink — it holds per-repo choices (prices, `defaultModel`, `excludePaths`) that shouldn't change when the submodule updates.
   - If you use the GitHub workflow, add `submodules: true` to its `actions/checkout` step so CI can resolve the symlink.
   - Symlinks require Developer Mode or admin rights on Windows; use Option A there.
2. **Edit `token-costs.config.json`**: set `defaultModel` to what your team actually uses, fix up `models` prices for your providers/discounts, set `billingMode`, and extend `excludePaths` for your generated files.
3. **Install the git hook** (each developer, once per clone — hooks aren't cloned):
   ```sh
   node scripts/token-cost/token-cost.mjs install-hook
   ```
   After every commit the hook captures session usage since the last capture, writes the git note, and prints the commit's per-model spend plus the running total for its issue:
   ```
   [token-cost] 7f8fea2 → #7 (exact)
   [token-cost]   sonnet-5: in=125.0k out=2.0k $0.15
   [token-cost]   haiku-4-5: in=30.0k out=1.5k $0.04
   [token-cost] #7 running total: in=299.5k out=10.7k cost=$0.73 over 2 commit(s)
   ```
4. **Reference issues in commit messages** (`closes #N`) or use conventional-commit scopes — that's what attribution keys on.
5. **Push the notes ref** (`git push origin refs/notes/token-usage`) so CI and teammates get exact numbers instead of estimates.

Requires Node 18+ and git. No npm installs.

## Commands

```sh
node scripts/token-cost/token-cost.mjs report              # table, whole history
node scripts/token-cost/token-cost.mjs report --md         # markdown table
node scripts/token-cost/token-cost.mjs report --json       # machine-readable
node scripts/token-cost/token-cost.mjs report --since v1.0 # any git rev/range start
node scripts/token-cost/token-cost.mjs record              # capture session usage -> note on HEAD + print (what the hook runs)
node scripts/token-cost/token-cost.mjs capture --input N --output N [--model X] [--cache-read N] [--cache-write N] [--commit <hash>]
node scripts/token-cost/token-cost.mjs install-hook        # set up .git/hooks/post-commit
```

## GitHub Projects: cost fields on the board

`scripts/token-cost/sync-project-field.mjs` pushes each issue's running totals into two project-level custom number fields — **AI Cost (USD)** and **AI Tokens (out)** — on a GitHub Projects (v2) board, creating the fields if they don't exist:

```sh
node scripts/token-cost/sync-project-field.mjs --owner <login> --project <number> \
  [--org] [--add-missing] [--dry-run]
```

- Requires the `gh` CLI authenticated with the `project` scope (`gh auth refresh -h github.com -s project,read:project`).
- `--add-missing` adds tracked issues to the project if they aren't already items; `#N` refs that aren't issues (PR numbers) are skipped.
- Values are running totals from `report --json`, so re-running after new commits updates the board. Run it manually, from the post-commit hook, or as a workflow step (the workflow would need a PAT with `project` scope — the default `GITHUB_TOKEN` can't access Projects v2).
- Fields are project-level in Projects v2, so the same fields apply to every issue on the board and can be shown as columns, summed in group footers, etc.

## GitHub integration

`.github/workflows/token-cost.yml` runs on every push to `main` and every PR:

- writes the full per-feature report to the **job summary**, and
- on PRs, posts (and keeps updated) a **sticky comment** with the token spend for just that branch (`--since <base sha>`).

It needs `fetch-depth: 0` (full history) and the default `GITHUB_TOKEN` with `pull-requests: write` — both already configured in the workflow file. No secrets required.

## Known quirks

- A commit that closes several issues is split evenly across them, so the TOTAL row's commit count can exceed the true number of commits (each split commit counts once per feature it touches).
- `unattributed` collects everything without an issue ref or scope — a big bucket there means commit messages need issue refs, not that the tooling is broken.
- Deletion-heavy commits estimate near zero (only added lines are counted), which underestimates the tokens an agent spent reading code in order to delete it. Capture or trailers fix this.
- Session usage that never led to a commit (exploration, abandoned work) lands in the *next* commit's capture window — but the hook asks before attributing any previous session to the commit, so a trivial commit right after a heavy unrelated session only inherits it if you say yes.
- Rebasing/squashing orphans git notes (they're keyed to commit hashes). The trailer survives rewrites; notes don't. Re-run `capture` on the new hash if you need exactness after a rewrite.
- Capture only reads *Claude Code* transcripts. Usage from other tools needs `capture` or a trailer.
