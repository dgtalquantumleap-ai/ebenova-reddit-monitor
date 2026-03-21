# Reddit Monitor

Monitors Reddit for keyword mentions and sends email alerts via Resend.
Replacement for GummySearch / F5Bot — self-hosted, free to run.

## Setup

1. Copy `.env.example` to `.env` and fill in values
2. `npm install`
3. `npm start`

## Deploy to Railway

Push to GitHub, connect repo to Railway, add environment variables.
Runs 24/7 for ~$5/month (or free tier if under usage limits).

## How it works

- Polls Reddit's public JSON search API every 10 minutes
- Tracks seen post IDs in memory (resets on restart — no duplicates within a session)
- Sends a single digest email per poll cycle if new matches found
- No Reddit API key required — uses public endpoints

## Keywords configured (edit monitor.js KEYWORDS array)

- freelance contract
- unpaid invoice
- NDA template
- tenancy agreement nigeria
- client won't pay
- scope creep contract
- legal document generator
- need a contract
- verbal agreement
