# Monitor delivery verification and source-access diagnosis

Scope: only Insights; no Front Desk, client, booking or demo changes. Keep existing monitors, Redis keys, AI routing, budgets, opt-outs and unsubscribe behavior. No new dependencies. Do not bypass blocked collection or manufacture a lead.

Observed root causes:
- The Front Desk monitor actually ran on November 26 at 09:17 UTC with its eight new keywords. Successful lazy keyword/community generation establishes model access for those operations. Reddit's repeated HTTP 429 responses opened the shared circuit breaker; the monitor then logged no matches. These logs do not establish a successful empty search. Its zero-match counter and old lastPollAt are not reliable source-health evidence.
- Resend SDK resolves refusals as `{data:null,error}`. The worker did not inspect the result and could stamp `lastEmailSentAt` despite refusal. This is a separate reproducible reporting bug, not proof that the current key is invalid.

Implementation:
1. Reproduced resolved-error and missing-receipt false successes using the actual worker function in an isolated VM, without importing its scheduling entrypoint. Both new negative tests failed before the fix.
2. Require no error and a nonempty string receipt ID before acceptance logging or timestamp mutation. Keep transport failure and opt-out behavior; do not introduce retries that could duplicate accepted emails. Do not equate acceptance with inbox delivery.
3. Full baseline: 919 passed, one existing skip. After fix: 923 passed, one existing skip, zero failures. Syntax/diff checks passed. These tests use fixture providers; no carrier or payment action.
4. A single separately labelled `QA-INSIGHTS-20261126-VERIFY` email was sent with the existing Resend key, normal sending identity, owner destination, daily cap, unsubscribe headers and a stable provider idempotency key. It explicitly states it is not a lead or successful scan. No match or operational last-email timestamp was fabricated. Gmail search confirmed it in the owner's INBOX at 09:45:35 UTC; message ID `1a2173f04a7efd28`, provider ID `01a2173f-01b1-7b8e-8fb9-0d44cd92b20d`.

Access boundary: owner confirmed no commercial agreement; only preparation of the request is authorized. See REDDIT-ACCESS-REQUEST.md. A successful full scan cannot honestly be claimed until the source is authorized and returns valid data. Existing shared-platform 429 handling was not weakened; other monitors and their customer settings are outside this task.

Known remaining work: worker source-failure/partial coverage should be distinguished from true zero results, and source attempts need timestamps even on empty cycles. This narrow email fix does not implement those wider scan-status changes, durable alert retry/reconciliation or an approved Reddit transport. Pausing the owned collector avoids presenting continued blocked attempts as a working acquisition feed while access is unresolved; record the actual readback separately before claiming the pause succeeded.

Actual pause readback: only owned monitor `mon_b2f0769c477ccf09d80d0516` was updated through a guarded atomic Redis script. It remains in its owner's listing, active=false, active scheduler membership=0, history=969 and emailEnabled=true. Settings, unsubscribe token and other monitors were retained. The first script attempt failed before mutation because the SDK-stored value required a second JSON decode; a read-only check confirmed unchanged active membership, then the corrected encoding-preserving script completed and the result above was read back. The shared worker and other customers were not stopped. This is a reversible collection pause, not deletion or a claim that access is approved.

Independent review found no production correctness issue. Its nonblocking suggestion to assert the current acceptance-log wording was applied; the reviewed full suite again passed 923 tests with one existing skip. The source-access request is prepared only, not submitted.

Release: review the exact diff and tests, release only the email-acceptance guard to Insights if authorized by the final deployment review, verify source/deployment health, then retain the paused internal collection state. Rollback uses preceding model-compatible source `71b9a0067a30d131e4eb0658bf4b6dd443aacc1e`, preserving data and provider keys. A code rollback does not authorize collection or cancel an email already accepted.
