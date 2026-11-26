# Front Desk customer discovery and activation

Prepared 26 November 2026. Owner-approved direction: prioritize paying customer onboarding and reliable calls, texts and bookings. This kit is prepared for internal use. It sends nothing, starts no scans and changes no client, booking, phone number or production configuration.

## Start with a small, qualified audience

Focus the next three new customer conversations on appointment-based Canadian businesses, beginning with Calgary salons and barbers. Use the public Perfect Touch example without inventing revenue or no-show results. U.S. warm referrals use assisted setup and business-specific messaging review. Keep warm introductions moving while data-access questions are resolved; Insights is one source of prospects, not a prerequisite to selling.

Find owners with an explicit operational problem, rather than consumers looking for a salon or other AI vendors. The [internal configuration](../config/examples/ebenova-frontdesk-discovery.json) uses eight owner-problem phrases instead of the consumer beauty preset. These are search hypotheses, not guaranteed leads. A community name in code is not permission to promote there.

## Safe configuration contract

After this API change is deployed to an approved environment, authenticated `POST /v1/monitors` accepts:

- `setupOnly: true`: save an owner-scoped draft with `active:false` and `emailEnabled:false`, even if the request asks for email. No active-worker membership, keyword-expansion request, community-suggestion request or creation email.
- `emailEnabled: false`: suppress creation email for normal active creation too. This alone does **not** disable scanning or AI initialization.
- Both flags must be JSON booleans if present; strings, null, numbers, arrays and objects return 400 before monitor writes.
- Existing callers omitting these flags retain active creation and default email behavior. Existing monitors and Redis key names are unchanged.

The response returns `setup_only:true`, `active:false`, `email_enabled:false` and `next_poll_eta:null`. Owner listing includes setup-only drafts; other owners cannot list or delete them. Drafts consume the normal monitor allowance. DELETE removes the owner listing and frees capacity using the existing behavior.

This release is API-only: it adds no activation button, MCP schema change, dashboard badge or activation endpoint. The current companion MCP create tool does not expose these flags; do not use it to submit the inactive payload. Inspect the reviewed payload directly instead. To activate later: record the reviewed settings, delete only the exact internal draft, and explicitly recreate it through the authenticated API after the prerequisites below are satisfied. Delete/create is not atomic; preserve the payload and recheck plan capacity. Never edit Redis manually to bypass authorization. Record the new monitor ID after recreation; this is not an in-place activation.

There is no duplicate-prevention key for create. Do not automatically retry POST after an uncertain response. List owner monitors and reconcile first; if ambiguous, stop rather than creating another monitor. The test account and fake Redis used by the tests are not a real internal account enrollment.

## Before any live collection or paid work

1. Verify the intended internal account/plan and existing monitor capacity. Preserve other products' monitors and shared service budgets.
2. Establish authorized commercial Reddit data access. Reddit says commercial use needs permission and a contract: [official guidance](https://support.reddithelp.com/hc/en-us/articles/14945211791892-Developer-Platform-Accessing-Reddit-Data), [API terms](https://redditinc.com/policies/data-api-terms). Being signed into Reddit does not establish this authorization. No agreement was verified in this work.
3. Review each selected community's rules and current discussion fit. Keep posting and unsolicited messages off. Any later reply must be helpful, honest about affiliation and individually approved. [Reddit spam guidance](https://support.reddithelp.com/hc/en-us/articles/360043504051-Spam).
4. Approve a separate internal experiment budget and verify controls cover all intended model paths. Current caps count requests, not dollars. Do not describe them as a hard dollar cap, change shared limits or activate new provider spend without approval.
5. Verify read-only authentication/routing for the actual Insights endpoint. Backend routes are `/v1/...`; companion MCP uses `/v1/insights/...` through its gateway. Do not bypass TLS or assume an unverified gateway route works. The old README's `insights.ebenova.dev` hostname failed certificate validation in the earlier audit.
6. Select the internal alert recipient and cadence only after no-send setup is reviewed. No additional mailbox or sending-key setup is required by this kit.

## Turn a match into a useful conversation

### Community review on 26 November 2026

The owner's signed-in Reddit session was verified read-only. [r/smallbusiness](https://www.reddit.com/r/smallbusiness/) prohibits promotional product mentions/links in ordinary posts and comments and prohibits market-research/pain-point solicitation posts. Do not use the generic opening below in those discussions. Its moderator-authored [Q4 2026 promotion thread](https://www.reddit.com/r/smallbusiness/comments/1wwpjlw/promote_your_business_thread_for_q4_2026/) explicitly provides the place for business introductions, while still prohibiting spam and repetition. No post, comment, message, vote or subscription was made. The temporary research tab was closed; the owner's Reddit tab remains open.

Prepared introduction for that designated thread only, subject to owner review and a fresh rule/thread check before publishing:

> I'm Olumide, founder of Ebenova Solutions in Calgary. Ebenova Front Desk helps appointment-based businesses answer incoming calls and texts, explain their services and hours, and capture callback requests while staff are busy. Appointment actions depend on the business's enabled booking connection; we confirm that fit during setup. Canadian businesses can start through our website, and U.S. businesses have assisted setup with messaging readiness reviewed before activation. You can try the demo and see pricing at https://ebenova.net/#demo. If missed enquiries are a problem for your business, I'd be happy to discuss your current phone and booking setup.

This draft is unsent. Signing into Reddit neither enables automated commercial collection nor authorizes public posting. No prospect has been identified or contacted merely by reading a thread; qualify the business and channel before contact.

Review the first 20 candidates manually. Record the stated problem, owner relevance and why rejected matches were noise. Suggested experiment threshold: at least five genuinely relevant owner problems; this is a targeting check, not a sales forecast. Tune wording before adding more platforms, monitors or paid tools.

Use this minimal worksheet, in private storage, for both warm introductions and permitted public conversations:

| Field | Record |
| --- | --- |
| Source | Introduction or public thread URL; no scraped private contact list |
| Business/problem | Owner's stated issue; do not invent missed-call volumes |
| Fit | Decision maker? Country confirmed? Current calendar/CRM? |
| Number preference | New line, forwarding or possible port; verify compatibility |
| Response permission | Appropriate channel/community rules; approval to contact |
| Next action | Useful answer, demo, fit review or close as unsuitable |
| Sales stage | Qualified conversation → demo → signup → paid → activated |
| Evidence | Accepted demo, customer-confirmed setup, authoritative payment and provider references |
| Objection/failure | Integration, pricing, trust, setup or operational issue and next owner |

Draft opening for owner review, only where appropriate:

> I work on Ebenova Front Desk. When you're serving a client, do missed calls mostly need answers, a callback or a booking change? We help with those enquiries while keeping your existing setup where supported. Happy to show you how it handles that specific situation: https://ebenova.net/#demo

Do not paste this indiscriminately into communities. A useful answer to the person's actual question comes first. No messages were sent by preparing this draft.

## Fifteen-minute fit demo

Ask what happens to calls while staff are busy, which questions recur, what system manages appointments, which country/number they need and who handles exceptions. Show the existing demo and [Perfect Touch example](https://ebenova.net/work#perfect-touch-yyc). Use the prospect's described scenario; do not test on an existing client's line or ask U.S. prospects to send international texts.

Sell only enabled capabilities. Supported direct booking needs a verified connection; otherwise offer enquiry/callback capture. Do not promise arbitrary integrations, a universal receptionist template without review or Core automation that is not released. Show final pricing and included usage in the actual checkout currency before payment. Explain SMS segments, incoming/outgoing usage, overages and number charges. Avoid repeating a homepage currency estimate as a fixed checkout price.

## Activation and first-week reliability checklist

| Gate | Evidence required | If it fails |
| --- | --- | --- |
| Account and settings | Owner verified; correct tenant, timezone, hours, services, voice, enabled booking/handoff rules | Correct settings before activation; no availability invented by the agent |
| Integration fit | Correct business calendar/agent/service identifiers and supported actions | Use callback capture until fit is confirmed |
| Payment | Stripe's authoritative successful payment/subscription state for that customer | Keep fulfillment pending; reconcile webhook before retrying |
| Number | Exactly one intended number assignment, or a reviewed existing-number route | Reconcile provider and workspace before another purchase; never rent a second line as a blind retry |
| U.S. messaging | Customer-specific registration/service/number readiness | Keep SMS pending with clear status; Ebenova's own campaign does not cover unrelated businesses |
| Existing numbers | Control verified; forwarding instructions and readiness confirmed | Explain that forwarding calls does not forward SMS; porting is a separate reviewed process |
| Call and text | Correct tenant; authoritative provider acceptance and delivery status plus the actual interaction where available | Use existing event-driven error/delivery alerts, assign an incident owner and state exactly what is unverified |
| Booking | Provider booking ID and correct calendar/time/customer, reconciled before retry | Do not say confirmed after a failed sync; prevent duplicate customers/bookings and use escalation |
| Customer handover | Dashboard access, support route, billing/usage explanation, exceptions and staff owner | Give one concrete next step rather than an active-status claim |

During the first week, review meaningful activation/delivery/booking alerts and customer-reported issues. Do not add periodic Codex polling or new speculative Core workflows. A social complaint is a signal to investigate; the operational provider record determines what happened. Do not classify calls, texts or bookings as reliable solely because this Insights suite passes.

## Measurement and rollback

Measure qualified conversations, accepted demos, completed setup, cleared payments and activated customers. Insights' replies/clicks/thread changes are leading indicators, not verified revenue. UTM parameters do not by themselves establish full-funnel attribution. No new customer-data sharing into Insights is required.

Release only after tests/review and explicit deployment scope are established. This branch does not change any live setting. If the API change is later deployed, rollback its commit to restore existing behavior; identify and delete only the new internal setup-only records first because older list code hides inactive drafts. Do not wipe Redis, alter shared monitors or modify Front Desk routing. Any subsequent collection activation needs its own exact monitor ID/config and stop procedure.
