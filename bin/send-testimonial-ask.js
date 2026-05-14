#!/usr/bin/env node
// bin/send-testimonial-ask.js — one-shot Resend email asking the
// highest-engagement user for a 3-sentence testimonial quote.
//
// Picked Joshua because the find-top-engagement.js leaderboard shows
// he's the only user with sustained "Mark Posted" behavior across the
// cohort (36 on Idea Validation Tool + 10 on SmallBiz Social = 46
// total). His engagement deltas are zero, so the ask is framed around
// discovery value / time saved, not "drove revenue."
//
// Reply-To is set to Olumide's personal inbox so Joshua's response
// lands directly without bouncing through the support address.
//
// Usage:
//   railway run node bin/send-testimonial-ask.js              # send
//   railway run node bin/send-testimonial-ask.js --dry-run    # preview only

import { Resend } from 'resend'
import { loadEnv } from '../lib/env.js'

loadEnv()

const dryRun = process.argv.includes('--dry-run')

const RESEND_KEY  = process.env.RESEND_API_KEY
const FROM_EMAIL  = process.env.FROM_EMAIL || 'insights@ebenova.org'
const REPLY_TO    = 'dgtalquantumleap@gmail.com'
const TO          = 'ayenioladejijoshua@gmail.com'
const FROM_HEADER = `Olumide @ Ebenova <${FROM_EMAIL}>`

const SUBJECT = "Quick favour — 3 sentences for the Ebenova site?"

const TEXT = `Hey Joshua,

Quick favour — you've been the most active user of Ebenova by a clear margin (46 posts marked across Idea Validation Tool + SmallBiz Social Eavesdrop, which is more than the rest of our cohort combined). I'd love to put a 3-sentence quote from you on ebenova.dev so other founders see that someone real is actually getting use out of this.

No pressure on length or polish — just a quick honest sentence on (a) what you were trying to do before you tried Ebenova, (b) the kind of posts/threads it's helped you find that you wouldn't have stumbled on otherwise, and (c) anything you'd change. I'll send you the exact words that go on the site before anything goes live.

Thanks in advance — and let me know if there's anything I can do to make either monitor work harder for you.

— Olumide
`

const HTML = `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 15px; line-height: 1.6; color: #0F172A; max-width: 580px;">
<p>Hey Joshua,</p>

<p>Quick favour &mdash; you&rsquo;ve been the most active user of Ebenova by a clear margin (<strong>46 posts marked</strong> across Idea Validation Tool + SmallBiz Social Eavesdrop, which is more than the rest of our cohort combined). I&rsquo;d love to put a 3-sentence quote from you on <a href="https://ebenova.dev" style="color:#2563EB;">ebenova.dev</a> so other founders see that someone real is actually getting use out of this.</p>

<p>No pressure on length or polish &mdash; just a quick honest sentence on:</p>
<ol>
  <li>what you were trying to do <em>before</em> you tried Ebenova,</li>
  <li>the kind of posts/threads it&rsquo;s helped you find that you wouldn&rsquo;t have stumbled on otherwise, and</li>
  <li>anything you&rsquo;d change.</li>
</ol>
<p>I&rsquo;ll send you the exact words that go on the site before anything goes live.</p>

<p>Thanks in advance &mdash; and let me know if there&rsquo;s anything I can do to make either monitor work harder for you.</p>

<p>&mdash; Olumide</p>
</div>`

console.log('━'.repeat(60))
console.log('Testimonial-ask email')
console.log('━'.repeat(60))
console.log(`From:     ${FROM_HEADER}`)
console.log(`Reply-To: ${REPLY_TO}`)
console.log(`To:       ${TO}`)
console.log(`Subject:  ${SUBJECT}`)
console.log('─'.repeat(60))
console.log(TEXT)
console.log('━'.repeat(60))

if (dryRun) {
  console.log('[dry-run] not calling Resend')
  process.exit(0)
}

if (!RESEND_KEY) {
  console.error('RESEND_API_KEY missing — abort.')
  process.exit(1)
}

const resend = new Resend(RESEND_KEY)
const r = await resend.emails.send({
  from:     FROM_HEADER,
  to:       [TO],
  reply_to: REPLY_TO,
  subject:  SUBJECT,
  text:     TEXT,
  html:     HTML,
  // CASL/NDPR: not a transactional/operational email per the strict
  // definition — it's a direct 1:1 outreach to a known user about their
  // own account behavior. Sending under the operational-relationship
  // basis. If Joshua replies "don't email me again" we'll suppress.
  tags: [{ name: 'category', value: 'testimonial-ask' }],
})

if (r.error) {
  console.error('Resend error:', r.error)
  process.exit(1)
}
console.log(`✓ Sent. Resend message id: ${r.data?.id || '(no id returned)'}`)
console.log(`  Joshua's reply will land in ${REPLY_TO}.`)
