# Insights Provider Model Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Repair the retired model IDs revealed by the approved Insights credential rotation.

**Architecture:** Keep task routing, fallback order, existing monitor data and provider caps unchanged. Use currently listed models, with environment overrides for future provider changes. Align reported model metadata with actual request bodies and explicitly disable DeepSeek's newly default-on thinking mode for these bounded classification/draft tasks.

**Tech Stack:** Existing JavaScript AI router and Node tests; no packages.

**Spec:** Owner directed completing Insights setup and repurposing the owned Automation Leads monitor for Front Desk. Both replacement credentials authenticated via free model-list GETs on the isolated Insights service; both Groq legacy IDs and `deepseek-chat` were absent. Official references: https://console.groq.com/docs/models and https://api-docs.deepseek.com/api/create-chat-completion/ . This is an Insights-only repair, not Front Desk's production receptionist model configuration.

## Global Constraints

- No paid validation prompts, new monitor, top-up, outbound post/email, other application credential change or booking change.
- Preserve task routing, fallback ordering, per-provider caps and existing Redis data.
- Defaults: both Groq roles use `qwen/qwen3.8-27b` with reasoning off; DeepSeek uses `deepseek-flash`.
- Optional `GROQ_FAST_MODEL`, `GROQ_QUALITY_MODEL`, `DEEPSEEK_MODEL` override the respective default; trim strings and fall back on blank input.
- DeepSeek request sets `thinking: { type: 'disabled' }`; Groq Qwen uses supported `reasoning_effort: 'none'` for bounded tasks. Reject empty/length-limited completions so fallback can run.

## Review Focus

- Reported model and outgoing request model must agree after overrides.
- Override restoration must not contaminate unrelated tests.
- JSON output and max-token budget must survive model selection.
- No actual provider call is allowed in regression tests.
- Other Groq overrides must not receive Qwen-specific options.

### Task 1: Repair provider catalog and requests

**Files:** `lib/ai-router.js`, `test/ai-router.test.js`, `.env.example`.

- [x] Write request-capture regressions for defaults, trimmed/blank overrides, JSON/budget forwarding and thinking controls; observe failures on old code.
- [x] Implement current defaults and shared model resolution for getters/request bodies, preserving public provider keys and routing.
- [x] Document the optional model variables and model-list verification limits.
- [x] Run targeted tests, full suite, syntax and diff checks; obtain independent review before committing/releasing.

## Ledger

- Base is merged PR #95, `738d14ab87cf6e2f40ea1fbad9adb8de83bdd56a`; dedicated branch `fix/insights-provider-models`.
- Insights credential deployment `b01ad46e-2a2c-43fa-b0fa-706b0914a666` succeeded. Free GET authentication checks passed; generation quality remains unverified without a paid prompt.
- Review identified that low-effort GPT-OSS can consume the existing 80/120-token budgets before answering. Ruling: use the listed Qwen non-thinking mode for both independently configurable Groq roles, preserving budgets instead of increasing spend; reject empty/truncated outputs. This avoids claiming that the role names guarantee different model quality. Official Groq reference confirms Qwen 3.8 supports `none`: https://console.groq.com/docs/api-reference .
- Two new regressions failed before the completion guard: empty output was accepted and fallback never ran. These tests use synthetic fetch responses only.
- Final suite: 920 tests, 919 passed, 1 existing skipped, 0 failed. Syntax and whitespace checks passed. Independent follow-up review found no remaining actionable issue after the token-budget correction.
- No production repair is claimed until the model commit is deployed. No paid validation prompt was run; model-list access and mocked request tests do not prove live draft quality.
