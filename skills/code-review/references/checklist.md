# Review checklist

- [ ] The diff does not silently change unrelated behaviour.
- [ ] Every new branch has an error path and a test.
- [ ] User input is validated at the boundary.
- [ ] Authorisation is checked on the resource, not only the route.
- [ ] Secrets are not logged, persisted in events, or returned by APIs.
- [ ] Paths are canonicalised and contained before filesystem access.
- [ ] Database changes are backward compatible or accompanied by a migration.
- [ ] Concurrency-sensitive updates are atomic.
- [ ] Failure states are visible to the operator.
- [ ] The pull request description states what was and was not verified.
