# Auth email setup (6-digit codes)

Scout verifies signups and password resets with a **6-digit email code**
(`supabase.auth.verifyOtp`, see `app/app/AuthScreen.tsx`). The code is generated
and emailed by **Supabase**, not by the app, so getting codes to actually arrive
is all dashboard configuration. This file records that configuration so it can be
reproduced.

> Nothing here needs an env var or a code change. It lives entirely in the
> Supabase and Resend dashboards.

## 1. Sending provider: Resend + custom SMTP

Supabase's built-in email sender is heavily rate-limited (~2-4/hour) and drops
mail silently, so we send through **Resend** over custom SMTP.

**Domain (one-time):** In Resend → Domains, verify the subdomain
`mail.scout-source.com` by adding the DNS records Resend lists into Cloudflare
(where `scout-source.com`'s DNS is hosted). The records are:

| Type | Name (Cloudflare, zone-relative) | Content |
|------|----------------------------------|---------|
| TXT  | `resend._domainkey.mail`         | the DKIM `p=…` key from Resend (copy exactly) |
| MX   | `send.mail`                      | `feedback-smtp.us-east-1.amazonses.com` (priority `10`) |
| TXT  | `send.mail`                      | `v=spf1 include:amazonses.com ~all` |
| TXT  | `_dmarc`                         | `v=DMARC1; p=none;` |

Cloudflare auto-appends `scout-source.com`, so enter Names without it. TXT values
take no manual quotes. Click **Verify DNS Records** in Resend when done.

**SMTP (Supabase → Authentication → Emails → SMTP Settings):** enable custom SMTP
and set:

| Field        | Value                            |
|--------------|----------------------------------|
| Sender email | `no-reply@mail.scout-source.com` |
| Sender name  | `Scout`                          |
| Host         | `smtp.resend.com`                |
| Port         | `465`                            |
| Username     | `resend`                         |
| Password     | a Resend API key (Sending access) — **keep it out of git** |

## 2. Templates must contain the code

Supabase's default templates use a confirmation **link**, not a code. For the
6-digit code to appear, the body must include `{{ .Token }}`. Update **both**
templates under Authentication → Emails:

- **Confirm signup**
- **Reset password**

Minimal body:

```html
<h2>Your Scout verification code</h2>
<p style="font-size:28px;font-weight:bold;letter-spacing:6px">{{ .Token }}</p>
<p>Enter it in the app to continue.</p>
```

## 3. Code length must be 6

Authentication → Providers → Email → **Email OTP Length** = `6` (Supabase defaults
can be 8; the app's input box accepts exactly 6, so a longer code can't be
entered). This one setting covers both signup and password-reset codes.

## Troubleshooting

- **No email at all, nothing in Resend or Supabase Auth logs:** the app is hitting
  a different Supabase project than the one configured. Confirm the project ref in
  `NEXT_PUBLIC_SUPABASE_URL` matches the dashboard you set SMTP on. On Vercel,
  changing env vars requires a redeploy.
- **Stuck on the verify screen with no email after a repeat signup:** that email
  already has an account. Supabase sends nothing for a repeat signup
  (anti-enumeration); the app now detects this and routes to sign in instead
  (`app/app/AuthScreen.tsx`). Delete the test user under Authentication → Users to
  re-test, or use a fresh address.
- **Where to look:** Resend → Emails (every send + bounce reason);
  Supabase → Logs → Auth (send errors).
