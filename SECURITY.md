# Security

Bolti Parchi handles prescriptions, so it is built to keep as little as possible and to fail closed.
This is a research prototype: do not use it with real patients without your institution's ethics
and data-security approval.

## How it is protected

**No database.** The server stores no images, prescriptions or patient details. The doctor-approved
text travels inside the patient link itself, and the server only checks the link's signature.

**Doctor side**
- One clinic password (`APP_PASSWORD`), checked once at sign-in in constant time.
- Sign-in returns a signed session that lasts 12 hours. The browser keeps only that session (in
  `sessionStorage`, cleared when the tab closes), never the password.
- Changing `APP_PASSWORD` or `LINK_SECRET` signs everyone out.
- 8 wrong passwords from one address lock that address out for 15 minutes.
- When deployed (Vercel, Render or `NODE_ENV=production`), the doctor features refuse to run unless
  `APP_PASSWORD` has at least 10 characters and `LINK_SECRET` has at least 32. A missing setting
  switches the site off instead of leaving it open.

**Patient links**
- Signed with HMAC-SHA256 using a key derived from `LINK_SECRET`. Changing any part of a link
  breaks the signature. Session tokens and link tokens use different keys, so one can't be used
  as the other.
- Links expire (30 days by default, 90 at most).
- The approved text is in the part of the URL after `#`, which browsers never send to servers,
  so it doesn't appear in server or proxy logs.

**Web page and API**
- Strict Content Security Policy: scripts, styles, fonts and requests come only from the site
  itself. No third-party scripts, fonts or trackers.
- HSTS, `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `nosniff`, `no-referrer`,
  same-origin opener and resource policies, and `noindex` on every page.
- Doctor actions need an `Authorization` header, so other websites can't trigger them on a signed-in
  doctor's behalf.
- Uploads are size-limited and the image type is checked. Request bodies are never logged.
- Rate limits on scanning, approving, opening links and generating audio. Addresses come only from
  headers the hosting platform sets, so a faked `X-Forwarded-For` doesn't get around them.
- No npm dependencies at runtime.

**Injection**

There is no database, so there is nothing for SQL injection to reach. The injection risks that do
apply are handled like this:
- *Request tampering:* every API call is checked against a strict list of allowed fields, types and
  lengths. Unknown fields (including `__proto__`) are rejected, and only JSON is accepted.
- *Script injection (XSS):* the page never turns text into HTML. Everything is inserted as plain text,
  and the browser enforces this with Trusted Types (`require-trusted-types-for 'script'`), plus a
  strict Content Security Policy with no inline or third-party scripts.
- *Fake files:* an uploaded "image" must start with the real JPEG, PNG, WebP or GIF signature.
  SVG and other formats that can carry scripts are refused.
- *Hidden characters:* invisible control characters and text-direction overrides are removed from
  all text, so a medicine name can't display differently from what it really says.
- *Prompt injection:* the AI is told that everything on the prescription is data, never
  instructions. Its answer is rebuilt field by field from the expected shape, with values checked
  and lengths capped, before anyone sees it.
- *Log injection:* anything written to the server log is flattened to one short line.

Run `npm test` to check all of the above (17 automated security tests).

**AI**
- Gemini reads the prescription and is told not to return names, phone numbers or other identifiers.
- Every medicine must be ticked by the doctor, and three checks confirmed, before a link can be made.
- The spoken scripts come from fixed templates filled from the checked table, not free AI text.

## Known limits

- **A shared password.** Everyone at the clinic uses the same one; there are no per-doctor accounts
  or audit trail.
- **Links can't be cancelled early.** Anyone who has a link can open it until it expires, so share it
  only with the patient.
- **Rate limits are per server instance.** On serverless hosting each instance counts separately. For
  stronger protection, add a rate-limit rule in your host's firewall (for example the Vercel Firewall).
- **AI can be wrong or be misled** by text inside a prescription. The doctor's review is the safety step.
- **Free-tier Gemini.** On Google's free tier, what you send may be used to improve Google's products
  and may be reviewed by people. Turn on billing before using real patient data.

## Setting it up safely

1. Set a strong `APP_PASSWORD`: 12 or more characters, not used anywhere else.
2. Set `LINK_SECRET` to a long random value and never change it, or old links stop working:
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
3. Keep `.env` and `vercel.env` out of git (they are in `.gitignore`).
4. Turn on billing for the Gemini key, and restrict the key to the Generative Language API.
5. If a key or password is ever shared by mistake, replace it, then redeploy.

## Reporting a problem

Please open a private security advisory on this repository (**Security → Report a vulnerability**)
rather than a public issue.
