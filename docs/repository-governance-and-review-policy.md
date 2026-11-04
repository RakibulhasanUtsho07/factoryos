# FactoryOS repository governance and protected-branch policy

**Policy:** FOS-GOV-REPO-01  
**Reviewed:** 2026-11-04  
**Status:** `CODEOWNERS PRESENT; MAIN PROTECTION NOT VERIFIED`  
**Owner mapping:** `.github/CODEOWNERS`

## 1. Current ownership evidence

The repository contains a default code-owner entry:

```
* @RakibulhasanUtsho07
```

This identifies the known repository maintainer. It is not an independent review, does not prove that a review was requested, and does not protect a branch by itself. No verified additional GitHub team or independent reviewer identity was present in the repository record used for this policy. Do not invent team slugs or claim that the author can approve their own change as independent review.

When engineering/security/operations teams are created, replace or extend the default rule with verified team ownership for the relevant path families. Record the actual team slug and maintainers.

## 2. Required `main` protection

Apply a GitHub branch protection rule or repository ruleset matching `main` with:

- Require a pull request before merging; disallow routine direct pushes.
- Require at least one approving review from a person other than the PR author.
- Require code-owner review; dismiss stale approvals; require approval of the latest pushed commit.
- Require every review conversation to be resolved.
- Require the latest commit to be up to date with the base branch before merge.
- Require the exact applicable status checks: `API CI`, `API PostgreSQL CI`, `Production Dependency Security`, and `SRS HLD Blueprint Traceability`. Require `Web CI` when web paths are changed. Add other path-specific checks only where skipped workflows cannot create an unrelated permanent block.
- Restrict force pushes and branch deletion.
- Disable routine bypass by actors and integrations. Define an audited emergency break-glass procedure with named authority, incident/change reference, UTC timestamp and mandatory post-action review.

Protect `dev` and `rakibul-hasan` from force-push and deletion as promotion branches. Keep the release sequence `rakibul-hasan → dev → main`; verify ancestry and exact-head checks at each promotion.

## 3. Independent reviewer prerequisite

The repository owner is currently the only verified default CODEOWNERS identity. A required one-approval rule is useful only after a second authorized reviewer has been identified and granted repository review access. Do not weaken review independence to make a self-authored PR merge. Until the second reviewer exists, arrange the reviewer first and keep the release blocked from direct promotion.

## 4. Read-back and acceptance evidence

After an administrator applies protection, attach to issue #350:

1. Ruleset/protection ID, target branch, enforcement mode and last-modified time.
2. Required reviewer count, code-owner review, stale approval dismissal, latest-push approval and conversation-resolution settings.
3. Exact required status-check contexts and strict/up-to-date setting.
4. Force-push, deletion and bypass actor settings.
5. A sanitized GitHub settings export or screenshots, plus a negative probe showing that a direct push/force push is rejected.

A CODEOWNERS file or this policy document is not proof that the GitHub rule is active.

## 5. Verified boundary on 2026-11-04

- `.github/CODEOWNERS` is present on `main`.
- The repository rulesets endpoint returned an empty array at the time of inspection.
- The GitHub branch-protection read endpoint returned HTTP 403 `Resource not accessible by integration`; current protection state therefore cannot be freshly read back through the available integration.
- The repository integration does not expose a branch-protection/ruleset mutation action. No protection change is claimed by this commit.

The issue must remain OPEN until a repository administrator applies the settings and independently attaches the required read-back evidence. Do not label `main` protected on the basis of CODEOWNERS alone.
