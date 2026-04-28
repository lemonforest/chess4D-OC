# Repo Setup — One-Time Steps

These steps need to be done by a maintainer with admin access to the GitHub repo. They are not automated because they configure the repo's deployment surface and merge policy.

Once these are in place, the M1+ pipeline runs unattended per the plan in `~/.claude/plans/4d-chess-spectral-visualizer-floating-church.md` (see "Automatic Pipeline" section).

## 1. Connect Cloudflare Pages

Cloudflare Pages serves the live site at `https://<project>.pages.dev` (production = `main`) and per-PR previews at `https://<sha>-<project>.pages.dev` (each non-production branch gets a unique URL).

1. Sign in at [pages.cloudflare.com](https://pages.cloudflare.com).
2. **Create a project → Connect to Git** → authorize the Cloudflare GitHub app on the repo (`lemonforest/chess4D-OC` or wherever this lives).
3. Configure the project:
   - **Production branch**: `main`
   - **Framework preset**: None (static site, no build)
   - **Build command**: *(empty)*
   - **Build output directory**: `/`
   - **Environment variables**: *(none required for v0.1)*
4. **Settings → Builds & deployments → Preview Deployments** = "All non-Production branches" (default).
5. Note the production URL Cloudflare assigns (e.g., `chess4d-oc.pages.dev`).
6. (Optional, for direct-upload deploys later) In Cloudflare → My Profile → API Tokens → Create Token using the "Edit Cloudflare Workers" template, scope to **Pages: Edit**. Add as GitHub repo secret `CLOUDFLARE_API_TOKEN`. Add `CLOUDFLARE_ACCOUNT_ID` from the dashboard sidebar. We don't need this for v0.1 — Git Integration handles deploy without API tokens — but it's the path forward if we ever want CI-driven artifact uploads.

After connecting, every push to `main` deploys to the production URL; every push to any other branch deploys to a unique preview URL. PR previews appear as a status check + comment from the Cloudflare GitHub app.

## 2. Create the milestone labels

Run this once. The `next-milestone.yml` workflow uses these to detect which PR maps to which milestone.

```bash
gh label create "milestone:M1"   --color "1f6feb" --description "M1 — repo hygiene + CI bootstrap"
gh label create "milestone:M2"   --color "1f6feb" --description "M2 — Cloudflare headers + smoke harness"
gh label create "milestone:M3"   --color "1f6feb" --description "M3 — Pyodide bootstrap"
gh label create "milestone:M3.5" --color "fbca04" --description "M3.5 — parity harness (autonomy gate)"
gh label create "milestone:M4a"  --color "1f6feb" --description "M4a — Pyodide legality oracle wired"
gh label create "milestone:M4b"  --color "1f6feb" --description "M4b — JS legality removed"
gh label create "milestone:M5"   --color "1f6feb" --description "M5 — hover spectral preview"
gh label create "milestone:M6"   --color "1f6feb" --description "M6 — incremental delta-encoding"
gh label create "milestone:M7"   --color "fbca04" --description "M7 — perf optimization (stretch, paused)"
gh label create "milestone:M8"   --color "fbca04" --description "M8 — WASM encoder (backlog)"
gh label create "milestone:M9"   --color "fbca04" --description "M9 — tutorial / UX (paused)"
gh label create "claude:next-milestone" --color "5319e7" --description "Auto-opened: agent should pick up and execute"
gh label create "claude:human-review"   --color "d93f0b" --description "Pause point: requires user review before continuing"
gh label create "claude:investigate"    --color "d93f0b" --description "CI failure that the agent should attempt to fix"
```

## 3. Configure branch protection on `main`

Run once after merging M1 (CodeQL must exist as a workflow before its check name is registerable). Replace `<owner>` and `<repo>`:

```bash
gh api -X PUT "repos/<owner>/<repo>/branches/main/protection" --input - <<'EOF'
{
  "required_status_checks": {
    "strict": true,
    "checks": [
      { "context": "Analyze JavaScript" }
    ]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": false,
  "lock_branch": false,
  "allow_fork_syncing": false
}
EOF
```

Then enable auto-merge at the repo level:

```bash
gh api -X PATCH "repos/<owner>/<repo>" -F allow_auto_merge=true -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false
```

**As later milestones add CI workflows, append their check names to the `checks` array:**

| Milestone PR adds workflow | Check name to add |
|---|---|
| M2 | `lint`, `smoke`, plus `Cloudflare Pages` (the CF GitHub app's check) |
| M3.5 | `parity` |

The check name is the `name:` field at the top of the workflow file (or the `name:` of the job if the workflow has multiple jobs). For Cloudflare's check, copy the exact context string from a successful PR's "Checks" tab. Easiest verification: after the workflow runs once on a PR, open the PR's "Checks" tab in the GitHub UI and copy the check name verbatim into the `checks` array.

To update the protection rule, re-run the `gh api -X PUT` command above with the appended `checks` entries.

## 4. (Optional) Enable Claude GitHub App

If the `claude.ai/code` GitHub App is installed on this repo, mentions of `@claude` in issues opened by `next-milestone.yml` will auto-trigger an agent run. Without it, you'll need to manually pick up `claude:next-milestone`-tagged issues by opening Claude Code and pointing it at the issue.

Install: https://github.com/apps/claude (instructions and scopes will be on the install page).

## 5. Verify the setup

After M1 merges and you've run steps 1–3 above:

1. Push any small change to a non-`main` branch and open a PR.
2. CodeQL workflow should run and post a check.
3. Cloudflare should auto-deploy the branch and post a preview URL as a PR comment.
4. Merging without CodeQL passing should be blocked by branch protection.
5. After M2 merges, the smoke workflow should run against the Cloudflare preview URL.

If any of those don't happen, check:
- Workflow ran at all (Actions tab → workflow → run logs)
- Branch protection rules are applied (Settings → Branches → main)
- Cloudflare GitHub app is installed and authorized on the repo
- Auto-merge is enabled (Settings → General → "Allow auto-merge")
