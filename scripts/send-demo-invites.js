// scripts/send-demo-invites.js — Send branded demo invites to a list of testers.
//
// Usage:
//   railway run node scripts/send-demo-invites.js scripts/testers.csv --dry-run
//   railway run node scripts/send-demo-invites.js scripts/testers.csv
//   railway run node scripts/send-demo-invites.js --emails "Name,email@x.com" "name2,e@y.com"
//
// CSV format (one tester per line, # for comments):
//   Matthew Sunday, silahubtechnologies@gmail.com
//   Joshua Ayeni, ayenioladejijoshua@gmail.com
//   plain@email.com    # name optional
//
// Env required:
//   DEMO_INVITE_CODE   — the invite string testers' URL contains
//   RESEND_API_KEY     — Resend API key (skipped in --dry-run)
//   APP_URL            — defaults to https://ebenova-insights-production.up.railway.app
//   FROM_EMAIL         — defaults to insights@ebenova.dev
//
// Safety:
//   --dry-run prints the rendered emails to stdout without sending
//   2-second delay between sends to respect Resend rate limits
//   Per-email log line so you can see exactly what was delivered

import fs from 'node:fs'
import { Resend } from 'resend'

function parseArgs() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')

  // --emails takes the rest of the positional args after it
  const emailsIdx = args.indexOf('--emails')
  if (emailsIdx >= 0) {
    const entries = args.slice(emailsIdx + 1).filter(a => !a.startsWith('--'))
    if (!entries.length) throw new Error('--emails passed but no entries followed')
    return { entries, dryRun, source: '--emails' }
  }

  // Otherwise: first positional arg is a CSV file path
  const file = args.find(a => !a.startsWith('--'))
  if (!file) {
    throw new Error('Pass a CSV file path or use --emails "Name,email" "Name,email"\n\n' +
                    'Example: node scripts/send-demo-invites.js scripts/testers.csv --dry-run')
  }
  if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`)
  const content = fs.readFileSync(file, 'utf-8')
  const entries = content
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
  return { entries, dryRun, source: file }
}

function parseEntry(entry) {
  const parts = entry.split(',').map(s => s.trim()).filter(Boolean)
  if (parts.length === 1) return { name: '', email: parts[0] }
  // Last token is the email; everything before is the name (joined w/ space)
  const email = parts[parts.length - 1]
  const name = parts.slice(0, -1).join(' ').trim()
  return { name, email }
}

function buildEmail({ firstName, demoUrl }) {
  const greeting = firstName ? `Hi ${firstName},` : 'Hi there,'
  const subject = 'Ebenova Insights just got a lot smarter'

  const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;background:#f5f5f5;color:#0F172A;line-height:1.6;">
    <div style="padding:20px 24px;background:#0D1520;border-radius:8px 8px 0 0;display:flex;align-items:center;gap:12px;">
      <div style="width:34px;height:34px;background:linear-gradient(135deg,#6366F1,#818CF8);border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:800;color:#fff;">EI</div>
      <div>
        <div style="font-size:15px;font-weight:700;color:#F8FAFC;letter-spacing:-.3px;">Ebenova Insights</div>
        <div style="font-size:10px;font-weight:600;color:#475569;text-transform:uppercase;letter-spacing:.6px;">Product Update</div>
      </div>
    </div>
    <div style="padding:32px;background:#fff;border-radius:0 0 8px 8px;border:1px solid #eee;border-top:none;">
      <p style="margin:0 0 18px;font-size:15px;">${greeting}</p>
      <p style="margin:0 0 18px;font-size:15px;color:#334155;">Since you last used Ebenova Insights, we've shipped a significant update based on real user feedback. Here's what's new:</p>

      <div style="margin:0 0 16px;padding:16px 20px;background:#F8FAFC;border-radius:8px;border:1px solid #E2E8F0;">
        <div style="font-size:11px;font-weight:700;color:#6366F1;text-transform:uppercase;letter-spacing:.8px;margin-bottom:12px;">What's new</div>
        <p style="margin:0 0 10px;font-size:14px;color:#334155;"><strong>🔥 Hot Leads tab</strong> — separates switching signals and buying intent from background noise. No more manual triage.</p>
        <p style="margin:0 0 10px;font-size:14px;color:#334155;"><strong>💡 WHY THIS MATCHED</strong> — every signal now shows exactly why it surfaced: competitor named, budget signal, switching language, urgency. No black box.</p>
        <p style="margin:0 0 10px;font-size:14px;color:#334155;"><strong>⏱ 3-hour engagement clock</strong> — shows time remaining in the peak reply window on every match. Amber when you're running out of time.</p>
        <p style="margin:0 0 10px;font-size:14px;color:#334155;"><strong>📊 Intelligence Brief</strong> — 5-number daily summary at the top of your feed: hot leads, evaluation signals, expiring posts, and engagement wins.</p>
        <p style="margin:0;font-size:14px;color:#334155;"><strong>🌙 Full dark redesign</strong> — the dashboard now matches the product's intent: focused, signal-first, no noise.</p>
      </div>

      <p style="margin:0 0 22px;font-size:15px;color:#334155;">The product now answers the question your monitor was always trying to answer: <em>not just what people are saying — but who is ready to buy.</em></p>

      <a href="${demoUrl}" style="display:inline-block;background:linear-gradient(135deg,#6366F1,#818CF8);color:#fff;font-weight:700;padding:14px 28px;border-radius:8px;text-decoration:none;font-size:15px;letter-spacing:.2px;margin-bottom:28px;">Open Ebenova Insights →</a>

      <div style="margin:0 0 24px;padding:18px 20px;background:#FFFBEB;border-left:3px solid #F59E0B;border-radius:4px;">
        <div style="font-size:11px;font-weight:700;color:#92400E;text-transform:uppercase;letter-spacing:.6px;margin-bottom:8px;">One ask</div>
        <p style="margin:0;font-size:14px;color:#78350F;">If the product is delivering value, Growth is <strong>$29/month</strong> — 20 monitors, 100 keywords, Slack delivery, AI reply drafts, and everything above. If you're not ready, no pressure. The free tier stays free.</p>
      </div>

      <p style="margin:0 0 4px;font-size:14px;color:#475569;">As always, hit the 💬 Feedback button inside the dashboard — I read every one.</p>
      <p style="margin:0;font-size:14px;color:#475569;">— Olumide</p>
    </div>
    <p style="margin:18px 0 0;font-size:11px;color:#94A3B8;text-align:center;">Ebenova Solutions · Calgary, Alberta · <a href="https://ebenova.org" style="color:#94A3B8;">ebenova.org</a></p>
  </body></html>`

  const text = `${greeting}

Since you last used Ebenova Insights, we've shipped a significant update. Here's what's new:

🔥 Hot Leads tab — separates switching signals and buying intent from background noise.
💡 WHY THIS MATCHED — every signal now explains why it surfaced: competitor named, budget signal, switching language, urgency.
⏱ 3-hour engagement clock — shows time remaining in the peak reply window on every match.
📊 Intelligence Brief — 5-number daily summary at the top of your feed.
🌙 Full dark redesign — the dashboard now matches the product's intent: focused, signal-first, no noise.

The product now answers the question your monitor was always trying to answer: not just what people are saying — but who is ready to buy.

Open the dashboard:
→ ${demoUrl}

If the product is delivering value, Growth is $29/month — 20 monitors, 100 keywords, Slack delivery, and AI reply drafts. Free tier stays free if you're not ready.

Hit the Feedback button inside the dashboard anytime — I read every one.

— Olumide

Ebenova Solutions · Calgary, Alberta · ebenova.org`

  return { subject, html, text }
}
async function main() {
  const { entries, dryRun, source } = parseArgs()

  const code = process.env.DEMO_INVITE_CODE
  const appUrl = process.env.APP_URL || 'https://ebenova-insights-production.up.railway.app'
  const fromAddress = process.env.FROM_EMAIL || 'insights@ebenova.dev'
  const resendKey = process.env.RESEND_API_KEY

  if (!code) throw new Error('DEMO_INVITE_CODE not set in env (use `railway run` to inject)')
  if (!resendKey && !dryRun) {
    throw new Error('RESEND_API_KEY not set. Either run with --dry-run or via `railway run` to inject env.')
  }

  const demoUrl = `${appUrl}/?invite=${encodeURIComponent(code)}`
  const resend = dryRun ? null : new Resend(resendKey)

  console.log(`\n${dryRun ? '🔍 DRY RUN' : '📨 LIVE SEND'} — ${entries.length} invite(s) from ${source}`)
  console.log(`From:    Olumide @ Ebenova Insights <${fromAddress}>`)
  console.log(`URL:     ${demoUrl.replace(code, '•'.repeat(Math.min(code.length, 12)))}\n`)

  let ok = 0, failed = 0, skipped = 0
  for (const [i, entry] of entries.entries()) {
    const parsed = parseEntry(entry)
    if (!parsed.email || !parsed.email.includes('@')) {
      console.log(`  [${i+1}/${entries.length}] ⏭  skip — invalid email: "${entry}"`)
      skipped++
      continue
    }
    const firstName = (parsed.name || '').split(/\s+/)[0]
    const { subject, html, text } = buildEmail({ firstName, demoUrl })

    if (dryRun) {
      console.log(`  [${i+1}/${entries.length}] 📋 ${parsed.email}  (greeting: "Hi ${firstName || 'there'},")`)
      console.log(`         subject: ${subject}`)
      console.log(`         text preview: ${text.slice(0, 120).replace(/\n/g, ' ')}…`)
      ok++
      continue
    }

    try {
      await resend.emails.send({
        from: `Olumide @ Ebenova Insights <${fromAddress}>`,
        to: parsed.email,
        subject,
        html,
        text,
      })
      console.log(`  [${i+1}/${entries.length}] ✅ sent to ${parsed.email}`)
      ok++
    } catch (err) {
      console.log(`  [${i+1}/${entries.length}] ❌ failed: ${parsed.email} — ${err.message}`)
      failed++
    }

    if (i < entries.length - 1) await new Promise(r => setTimeout(r, 2000))
  }

  console.log(`\n${dryRun ? '✓ Dry run complete' : '✓ Send complete'} — ${ok} ok, ${failed} failed, ${skipped} skipped\n`)
  if (dryRun && ok > 0) {
    console.log('Re-run without --dry-run to actually send:')
    console.log(`  railway run node scripts/send-demo-invites.js ${source === '--emails' ? '--emails ...' : source}\n`)
  }
}

main().catch(err => {
  console.error('\n💥', err.message, '\n')
  process.exit(1)
})
