---
name: investigate-failing-test
description: Reproduce a failing test, isolate the cause with evidence, and propose or implement the smallest correct fix.
version: 1.0.0
license: MIT
---

# Investigate a failing test

Use this skill when a test fails, flakes, or is suspected of testing the wrong thing.

## Process

1. Record the exact command, environment and failure output. Do not paraphrase the error before capturing it.
2. Reproduce the failure in isolation. If it does not reproduce, treat that as a finding rather than a success, and look for ordering, timing, shared state, randomness or environment dependencies.
3. Read the test and the production code together. Identify the behaviour the test intends to protect, not merely the assertion text.
4. Form one or more hypotheses and test them cheaply. Distinguish:
   - a production defect
   - a test defect
   - an environmental or flaky dependency
5. Make the smallest change that restores the intended behaviour. Do not weaken assertions to make a test pass.
6. Re-run the narrow test, then the relevant suite. Report the exact commands and results.
7. If the fix changes a contract, update documentation and other tests that depend on it.

## Output

- Reproduction command and observed failure
- Root cause with evidence
- Fix applied or proposed
- Verification commands and results
- Residual uncertainty
