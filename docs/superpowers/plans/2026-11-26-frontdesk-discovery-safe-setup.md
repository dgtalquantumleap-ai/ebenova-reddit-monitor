# Front Desk Discovery Safe Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prepare owner-focused Front Desk discovery without starting paid work or emails, and connect sales qualification to evidence-based customer activation.

**Architecture:** Add opt-in `setupOnly: true` creation to the existing monitor API. These records remain owner-scoped and consume the existing plan allowance, but are inactive, excluded from the worker set, and cause no initialization side effects. Existing creation and existing monitors retain their behavior. Save a reusable internal payload and an owner-operated acquisition/activation checklist; do not connect Core or post messages.

**Tech Stack:** Existing Express/Redis application, Node test runner, built-in HTTP test doubles; no new packages.

**Spec:** Owner approved the focused discovery recommendation on 2026-11-26. Research: `ebenova-core-independent/docs/acquisition/2026-11-26-insights-repository-assessment.md` in the adjacent local repository (commit 94cd8cd). This approval supersedes historical roadmap priority for this targeted preparation.

## Global Constraints

- Never break existing monitors; Redis keys remain stable and schema additions backward-compatible.
- No live collection, paid scans, outbound email, posts, credentials or production deployment in this change.
- No external platform collection until authorized commercial access is established.
- Preserve existing clients, bookings, demo routing and operational alerts.
- `emailEnabled=false` must always skip Resend calls.
- No new npm packages.

## Review Focus

- Malformed boolean input must fail before saving records or starting work.
- An inactive draft must not be hidden from its owner or appear for another owner.
- Deleting a draft must remove its listing and free plan capacity.
- Legacy creation must still be active; explicit email opt-out must suppress the creation email.
- No live credentials or network access may be needed to test the HTTP route.

### Task 1: Safe setup creation

**Files:** Modify `api-server.js`; create `test/monitor-setup-http.test.js` and `test/helpers/monitor-api-sandbox.mjs`.

**Interface:** Optional request `setupOnly: boolean`, optional `emailEnabled: boolean`. Defaults preserve existing behavior. Setup-only forces `active:false` and `emailEnabled:false`; persisted `setupOnly:true` makes the draft visible in the owner's list. Response states setup-only and returns `next_poll_eta:null`. No activation endpoint or dashboard feature in this release.

- [x] Add real HTTP tests with in-memory fake Redis and blocked external fetches. Cover no worker membership/AI/email, owner isolation, malformed inputs, default compatibility, email opt-out, deletion and plan limit.
- [x] Run tests before the fix and confirm behavioral failures.
- [x] Validate booleans before writes; persist and return setup state; skip active-set membership and the three creation side effects when inactive; skip creation email for opt-out.
- [x] List setup-only records for their owner. Existing deleted records remain excluded and DELETE retains its existing owner-set cleanup.
- [x] Run targeted tests, full suite, syntax checks and credential-free API boot via the sandbox. Review the diff and commit.

### Task 2: Internal operating kit

**Files:** Create `config/examples/ebenova-frontdesk-discovery.json` and `docs/FRONTDESK-DISCOVERY-OPERATIONS.md`.

- [x] Save the eight owner-problem phrases, professional tone, salon page and UTM settings in an inactive setup-only payload without a real recipient or webhook.
- [x] Document creation semantics, deletion/recreation after review, data-access and budget prerequisites; explicitly distinguish request counts from dollar caps.
- [x] Provide a qualification worksheet and demo/signup/payment/activation checklist using existing provider records and event-driven alerts. Social matches do not authorize sending or prove payment/delivery/booking success.
- [x] Validate JSON and local document links, confirm no paid/network actions, and record actual test evidence and remaining deployment/access steps.

## Execution ledger

- Fresh dedicated clone, branch `feat/frontdesk-discovery-safe-setup`; no open repository PRs at inspection.
- Baseline: 912 tests, 911 passed, 1 skipped, 0 failed. Locked install used `--ignore-scripts`; no dependencies added or changed.
- Ruling: Implement setup-only as an opt-in request rather than changing default creation. This prevents changing existing users' behavior while allowing the approved internal preparation.
- Ruling: No activation endpoint in this preparation. After authorization/budget review, delete the draft and explicitly create an active monitor; do not add a general automation engine or polling task.
- Four new HTTP tests failed on the baseline for the intended reasons: setup started active, malformed flags were ignored, setup contacted AI/email, and explicit email opt-out was ignored. After the fix, all four passed.
- Final full suite: 916 tests, 915 passed, 1 existing skipped, 0 failed. API syntax and diff whitespace checks passed; JSON payload passed monitor-quality checks and Starter keyword/context limits.
- Independent reviewer found no actionable issue in API gating, tenant/plan behavior, worker/weekly/visibility/reply sweep exclusion, test sandbox or operating kit. No production credentials, monitor writes or provider calls were used by tests.
- Browser work was read-only: verified Reddit sign-in and r/smallbusiness's restrictions and designated Q4 promotion thread. Prepared an unsent introduction; no account settings or public content changed.
- Remaining live prerequisites: approved deployment, actual internal account capacity/authentication, authorized commercial collection and an approved scoped spend allowance. These are not claimed complete by local tests.
