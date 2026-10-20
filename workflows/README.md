# Workflow packages

Owner ruling (2026-09-17, LESS IS MORE): the shipped workflow catalog is
deleted. The bench worker (`packages/worker`) creates workflows dynamically for a
tenant's own needs; there is no seeded catalog of ready-made workflows
any more. The `echo` fixture workflow is gone too — the e2e smoke suites
now deploy the `packages/worker` definition to prove the
mail-triggered contract works.
