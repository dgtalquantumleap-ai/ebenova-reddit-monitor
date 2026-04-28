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
  const subject = 'A quiet invite — come test what I\'ve been building'

  const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;background:#f5f5f5;color:#0F172A;line-height:1.6;">
    <div style="padding:24px;background:#0e0e0e;border-radius:8px;margin-bottom:20px;">
      <div style="font-size:18px;font-weight:700;color:#FF6B35;letter-spacing:-.3px;">📡 Ebenova Insights</div>
      <div style="font-size:11px;font-weight:600;color:#64748B;text-transform:uppercase;letter-spacing:.6px;margin-top:3px;">QUIET INVITE // 30-DAY DEMO</div>
    </div>
    <div style="padding:28px;background:#fff;border-radius:8px;border:1px solid #eee;">
      <p style="margin:0 0 18px;font-size:15px;">${greeting}</p>
      <p style="margin:0 0 18px;font-size:15px;color:#334155;">I built something I want you to break before anyone else does.</p>
      <p style="margin:0 0 22px;font-size:15px;color:#334155;"><strong>Ebenova Insights</strong> finds people on Reddit and 8 other platforms the moment they're asking for what you sell. It surfaces the thread, the buying context, and a reply draft you can edit and post in seconds. No outbound spam. No CSV upload. Just the right conversation, at the right moment.</p>
      <p style="margin:0 0 14px;font-size:14px;color:#64748B;">Your 30-day Growth-tier access is ready. One click, no card:</p>
      <a href="${demoUrl}" style="display:inline-block;background:#FF6B35;color:#fff;font-weight:700;padding:14px 28px;border-radius:6px;text-decoration:none;font-size:15px;letter-spacing:.2px;margin-bottom:24px;">Open the terminal →</a>
      <div style="margin:0 0 18px;padding:18px 20px;background:#FFF7F3;border-left:3px solid #FF6B35;border-radius:4px;">
        <div style="font-size:11px;font-weight:700;color:#9A3412;text-transform:uppercase;letter-spacing:.6px;margin-bottom:10px;">THREE THINGS TO TRY</div>
        <p style="margin:0 0 8px;font-size:14px;color:#334155;"><strong>1.</strong> Describe your business in a sentence on the <em>Find Customers</em> screen. See what conversations surface.</p>
        <p style="margin:0 0 8px;font-size:14px;color:#334155;"><strong>2.</strong> Save a monitor. First matches usually arrive within 15 minutes.</p>
        <p style="margin:0;font-size:14px;color:#334155;"><strong>3.</strong> Click the floating <strong>💬 Feedback</strong> button anytime. Brutal honesty is the gift.</p>
      </div>
      <p style="margin:0 0 14px;font-size:14px;color:#475569;">The product is rough in places. That's what you're here for. Anything broken, confusing, or surprising — tell me through that feedback widget and I'll see it in real time.</p>
      <p style="margin:0 0 4px;font-size:14px;color:#475569;">Thanks for spending an afternoon (or thirty) with this.</p>
      <p style="margin:0;font-size:14px;color:#475569;">— Olumide</p>
    </div>
    <p style="margin:18px 0 0;font-size:11px;color:#94A3B8;text-align:center;">This invite link was sent only to you. If you'd rather not, no worries — just ignore.</p>
  </body></html>`

  const text = `${greeting}

I built something I want you to break before anyone else does.

Ebenova Insights finds people on Reddit and 8 other platforms the moment they're asking for what you sell. It surfaces the thread, the buying context, and a reply draft you can edit and post in seconds. No outbound spam. No CSV upload. Just the right conversation, at the right moment.

Your 30-day Growth-tier access is ready. One click, no card:

→ ${demoUrl}

Three things to try:

1. Describe your business in a sentence on the Find Customers screen. See what conversations surface.
2. Save a monitor. First matches usually arrive within 15 minutes.
3. Click the floating Feedback button anytime. Brutal honesty is the gift.

The product is rough in places. That's what you're here for. Anything broken, confusing, or surprising — tell me through that feedback widget and I'll see it in real time.

Thanks for spending an afternoon (or thirty) with this.

— Olumide`

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
