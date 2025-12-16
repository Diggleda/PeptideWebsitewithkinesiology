# Contributing

## Workflow

- Prefer small PRs that can be reviewed quickly.
- Keep branches short-lived (trunk-based or near-trunk).
- Merge frequently to avoid painful integration drift.

## Commit messages (conventional commits)

Use `type(scope): summary` (imperative mood). Examples:

- `feat(checkout): add idempotency key support`
- `fix(api): redact secrets from logs`
- `docs(runbook): add incident response steps`

Common types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`.

## Safety checklist

- Never commit secrets (`.env`, API keys, tokens).
- Validate input at API boundaries (server-side, even if the client validates).
- Keep external integrations retry-safe and idempotent where possible (webhooks, order creation).

