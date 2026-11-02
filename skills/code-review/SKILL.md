---
name: code-review
description: Review a change for correctness, security, regressions and missing tests, then report findings with precise evidence.
version: 1.0.0
license: MIT
---

# Code review

Use this skill when asked to review a diff, branch, commit or working tree.

## Process

1. Establish the review scope. Prefer the actual diff (`git diff`, `git diff --cached`, or the supplied patch) over assumptions.
2. Read the surrounding implementation, tests and configuration that the diff depends on. Do not review changed lines in isolation.
3. Check these dimensions:
   - correctness and edge cases, including error paths and empty inputs
   - security boundaries: authentication, authorisation, injection, path traversal, secret handling
   - data integrity and migration safety
   - concurrency, ordering and retry behaviour
   - performance regressions with a concrete mechanism
   - accessibility and user-visible failure states for UI changes
   - tests that actually exercise the changed behaviour
4. Verify every finding against the code. Do not report style preferences as defects.
5. Report only actionable findings, ordered by severity. For each finding include severity, file and line, the failure mode, and the smallest credible fix.
6. State explicitly what you could not verify, including commands or tests you did not run.

## Output

- Blocking findings
- Non-blocking findings
- Open questions
- Verification performed

Never claim tests passed unless you ran them and observed the result.
