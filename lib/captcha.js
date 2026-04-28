// hCaptcha verification (free tier — hcaptcha.com).
// Soft-skip if HCAPTCHA_SECRET_KEY is not set (e.g., dev / pre-config).
//
// Usage:
//   const r = await verifyCaptcha(token)
//   if (!r.ok) { return 400 with requiresCaptcha: true }
//   // r.skipped === true means HCAPTCHA was disabled, treat as ok
export async function verifyCaptcha(token) {
  const secret = process.env.HCAPTCHA_SECRET_KEY
  if (!secret) return { ok: true, skipped: true }
  if (!token) return { ok: false, error: 'no_token' }
  try {
    const r = await fetch('https://hcaptcha.com/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `secret=${encodeURIComponent(secret)}&response=${encodeURIComponent(token)}`,
    })
    const data = await r.json()
    return { ok: !!data.success, error: data['error-codes']?.join(',') }
  } catch (err) {
    console.error('[captcha] verify failed:', err.message)
    return { ok: false, error: 'fetch_failed' }
  }
}
