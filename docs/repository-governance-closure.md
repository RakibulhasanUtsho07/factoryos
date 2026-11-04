# Repository governance and protected-main closure

**Audit date:** 2026-11-04  
**Repository:** `RakibulhasanUtsho07/factoryos`  
**Baseline inspected:** `main@35918fb460839c6aa9d9b5f3a6c84a0a65053501` (before this governance PR)

## Verified starting state

The GitHub branch metadata returned `protected=false` for `main`; protection was disabled and required-status enforcement was off. The repository rulesets endpoint returned an empty list. Neither root `CODEOWNERS` nor `.github/CODEOWNERS` existed at the inspected baseline.

This change adds `.github/CODEOWNERS` and documents the required administrative configuration. **It does not claim that main is protected.** The connected GitHub actions support reads of branch protection/rulesets but do not expose a write operation to create branch protection or rulesets. The settings must be applied by a repository administrator through GitHub's repository settings or an authorized administrative integration, then independently re-read and recorded.

## Code ownership

The current owner mapping assigns the repository's authenticated maintainer `@RakibulhasanUtsho07` as the default code owner. This is a starter map, not a substitute for the Blueprint's team ownership matrix. As accountable teams are established, replace broad ownership with team-specific ownership:

| Area | Intended accountable review | Current mapping |
|---|---|---|
| Repository-wide defaults | Repository maintainer | `@RakibulhasanUtsho07` |
| Platform / IAM / tenant / security | Platform Engineering + Security | Not yet mapped to a team |
| Manufacturing / domain | Domain Engineering + Product/domain owner | Not yet mapped to a team |
| AI runtime / tools / agents | AI Platform + Security | Not yet mapped to a team |
| Research / Growth / CBB | Knowledge/Growth + Product/data governance | Not yet mapped to a team |
| Data / search / vector / event projections | Data Engineering + Data Governance | Not yet mapped to a team |
| OT / device gateway / edge | OT/Edge + Security | Not yet mapped to a team |
| Infrastructure / observability / DR | SRE/DevOps + Security | Not yet mapped to a team |
| Requirements / release acceptance | Product/Business + QA/Evaluation | Not yet mapped to a team |

The Blueprint Appendix C team ownership matrix is the basis for the intended review groups. A PR author must not self-approve. At least one additional authorized human reviewer must exist before a required-approval rule can be enforced without blocking all routine merges.

## Required main-branch rules

Apply a ruleset or branch-protection rule to `main` with these controls:

1. Require pull requests; disallow direct pushes for routine changes.
2. Require at least one approval from a reviewer other than the PR author. Require code-owner review for CODEOWNERS-covered files.
3. Dismiss stale approvals after new commits and require approval of the most recent push.
4. Require all review conversations to be resolved before merge.
5. Require the applicable API CI, API PostgreSQL CI, Production Dependency Security and SRS/HLD/Blueprint Traceability checks. Select the exact check-run context names from GitHub's returned check runs; do not guess workflow/job display strings. Add path-specific checks only if skipped workflows are not treated as required failures for unrelated changes.
6. Block force pushes and branch deletion. Define any emergency bypass explicitly, restrict it to named administrators and audit every use.
7. Keep merge queue / stale-branch update policy consistent with migration ordering and the repository's PR promotion workflow.

## Evidence required to close this item

- [ ] A second authorized reviewer/team is identified and can review changes independently of the PR author.
- [ ] The CODEOWNERS change is merged and GitHub reports the expected owner requests on a test PR.
- [ ] A repository administrator applies the branch protection/ruleset settings above.
- [ ] The branch endpoint reports `protected=true` and effective required-review/status-check settings are retrievable.
- [ ] The rulesets endpoint returns the active ruleset ID and enforcement mode, or the branch-protection endpoint returns the effective classic policy.
- [ ] A test PR confirms direct push is blocked, one independent approval is required, code owner approval works, stale approvals are dismissed, conversations must be resolved and required checks block merge.

**Current decision:** CODEOWNERS is added in this PR; protected-main/ruleset enforcement remains **OPEN / NOT VERIFIED** until an administrator applies settings and the effective policy is re-read. Do not label repository governance complete before that evidence exists.


## Post-merge verification — 2026-11-04

The CODEOWNERS/governance documentation change was merged via [PR #351](https://github.com/RakibulhasanUtsho07/factoryos/pull/351) at `main@91dd6a5629562ca8ce01fbc8892a7200d85577c8`. Re-reading GitHub branch metadata after that merge still returns `protected=false`, with required-status enforcement disabled and an empty rulesets collection. The `.github/CODEOWNERS` file is present and assigns the repository maintainer as the provisional default owner; it does not provide independent Product, Architecture, Security, Operations or QA reviewers.

**Current result:** CODEOWNERS file `PRESENT`; protected-main policy `NOT ENABLED`; independent reviewer/team map `NOT COMPLETE`; required CI enforcement `NOT VERIFIED`. The connected GitHub integration exposes branch-protection/ruleset reads but no write operation. An authorized administrator must apply the policy in GitHub repository settings or through an administrative integration, then re-read the effective rule and test a PR. Do not close this item based solely on CODEOWNERS presence.
