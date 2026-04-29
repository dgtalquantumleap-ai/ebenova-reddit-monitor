# Project guidance for Claude Code

**Read [docs/ROADMAP.md](docs/ROADMAP.md) before touching any file.** It is the
single source of truth for what this product is, what's already built, what's
in flight, and what to build next. Roadmap priority order is binding — do not
deviate without explicit approval in the conversation.

## Session Start Checklist

1. Read `docs/ROADMAP.md` completely.
2. Run `npm test` and confirm the current baseline test count.
3. Check open GitHub PRs: `gh pr list --state open`.
4. Confirm which branch you're on: `git branch --show-current`.
5. Read all files you plan to modify before editing them.

## Hard constraints (lifted from the roadmap; the roadmap is canonical)

- Never break existing monitors — schema changes are backward-compatible.
- Redis key structure is stable — no migrations without explicit approval.
- Classification (`lib/classify.js`) routes through `lib/ai-router.js`.
- All draft generation routes through `lib/ai-router.js`.
- Cost caps (`lib/cost-cap.js`) checked per provider separately.
- `emailEnabled=false` must always skip Resend calls.
- `unsubscribeToken` required on all alert emails (CASL/NDPR compliance).
- No PR opened until tests pass and boots clean.
- Audit-style report format on every PR.
- No new npm packages without explicit approval.

## Style of work

- Read every file in scope before writing.
- Keep PRs focused: one feature per PR, one branch per PR.
- Tests first when fixing bugs; tests alongside code when adding features.
- The PR description is the audit trail — be specific about schema impact,
  what was tested, and any spec divergences.
