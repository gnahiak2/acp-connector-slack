---
name: prepare-pr
description: Prepare a reviewable draft pull request from a session workspace, including an accurate summary, test evidence and risk notes.
version: 1.0.0
license: MIT
---

# Prepare a pull request

Use this skill when asked to prepare a branch or draft pull request.

## Process

1. Inspect the working tree status and the complete diff against the base branch. Never describe changes you have not read.
2. Confirm the branch does not contain unrelated edits, generated artefacts or secrets.
3. Run the repository's documented lint, typecheck, test and build commands. Capture failures rather than hiding them.
4. Group the change into a short, factual summary. Explain why the change was needed and what behaviour changed.
5. List verification evidence: exact commands and outcomes. List anything not run.
6. Note risks, migration steps, rollback considerations and follow-up work.
7. Draft the pull request body in Markdown. Keep it concise and avoid unverifiable claims.
8. Push and create the pull request only through the approved Slackboard workflow. Never merge and never force-push.

## Output

- Proposed title
- Summary
- Verification
- Risks and rollout notes
- Explicitly unverified items
