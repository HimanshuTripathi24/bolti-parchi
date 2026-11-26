# Bolti Parchi · बोलती पर्ची

A website where a doctor photographs (or types) a prescription, AI reads the handwriting, the doctor checks and approves it, and the patient gets a link to **hear** their medicines in simple Hindi or English.

```
Photo or text ──► Gemini reads it ──► Doctor checks every medicine ──► Doctor approves the script ──► Patient link / voice note
```

## Why the old demo couldn't read handwriting

The old offline HTML had no handwriting reader at all, and ordinary OCR (Tesseract and similar) only reads printed text. This version sends the photo to **Google Gemini**, a vision AI model that reads messy handwriting. It is told:

- the Indian prescription shorthand (OD, BD, TDS, HS, SOS, AC/PC, BF/AF, `1-0-1`, `x 5d`, `½`…)
- to use medical context (real Indian brands, strengths that exist, usual dosing) to work out unclear words
- to **flag** what it isn't sure about instead of guessing silently: each medicine gets a confidence level (green, yellow or red) and a note on what is unclear

Tips for best reading:
1. **Crop** to just the medicines (drag a box). This also keeps the patient's name out of the upload.
2. Take the photo flat, in good light, without shadows. Use **Rotate** if it's sideways.
3. Try **Boost contrast** for faint ink or pencil.

The AI is never the last word. The doctor must tick every medicine as checked and tick three approval checks before a link can be made.

## How the patient message works

- The English and Hindi scripts come from **fixed templates** filled from the checked table, so the doctor sees exactly what will be spoken (no hidden AI translation). The doctor can still edit the wording.
- After approval the doctor gets a **patient link**, which they can share on WhatsApp or SMS. The patient opens it, picks हिन्दी or English, and presses play.
- **Hindi voice: offline and unlimited.** Hindi is spoken by Piper's "Pratham" voice running on the server itself (via sherpa-onnx), so there is no quota and the text never leaves the server. It speaks phrase by phrase with clear pauses, says each medicine name slowly on its own, and the doctor can press 🔊 next to any medicine to hear exactly how its name will be said (and fix the Hindi spelling if needed). The voice is downloaded at build time and checked against a fixed fingerprint (`scripts/fetch-voice.mjs`; run `npm run fetch-voice` locally). Licence: the Pratham voice was trained on data under CC BY-NC-SA 4.0 (non-commercial use only).
- English voice (same key) gives patients a natural Hindi or English voice, and the doctor can share a **voice note** (WAV file) straight to WhatsApp. If that fails, or `NATURAL_VOICE=off`, the patient's phone voice reads it instead (most Android phones have Hindi; if not, the page explains how to turn it on).

## Privacy (what is and isn't stored)

- **No database.** The server stores no images, text or patient data. The approved script lives inside the patient link itself, signed so nobody can change it, and the link expires (30 days by default).
- Photos and text go to the Gemini API to be read. **Turn on billing for the key's Google Cloud project before using real patient data.** On the free tier, Google may use what you send to improve its products, and people may review it. On the paid tier it doesn't.
- Crop out names and don't type names or phone numbers. The AI is also told not to return any identifying details.
- The doctor side needs a clinic password, which is swapped for a 12-hour signed session at sign-in. Repeated wrong passwords lock the address out for 15 minutes. A deployment without a strong password and link secret switches the doctor side off rather than leaving it open. See [SECURITY.md](SECURITY.md) for the full picture.
- Limitation: a link can't be revoked before it expires. Anyone who has the link can listen, so share it only with the patient.

> This is a research prototype (see the study protocol). Get IEC and data-security approval and test it on 10–15 de-identified prescriptions before using it with patients.

## Run it on your computer

Needs Node.js 20.12 or newer.

```powershell
cd bolti-parchi
copy .env.example .env    # then fill in GEMINI_API_KEY, APP_PASSWORD, LINK_SECRET
npm start
```

Open http://localhost:3000. Without an API key it runs in **demo mode**: you can try every screen, but “Read prescription” returns a sample result.

## Put it online on Vercel (recommended: no sleeping)

1. On https://vercel.com, choose **Add New → Project**, import the GitHub repository, and leave the framework as **Other**. `vercel.json` sets up everything else: Mumbai region, routing, security headers, and up to 5 minutes per scan.
2. Under **Environment Variables**, add `GEMINI_API_KEY`, `APP_PASSWORD` and `LINK_SECRET` (a long random string, which must never change).
3. Click **Deploy**. Every push to GitHub redeploys automatically.

Vercel limits each request and response to 4.5 MB, so the app keeps photo uploads under about 3.3 MB and sends very long voice notes at a lower sound quality.

## Or put it online on Render (free tier sleeps)

1. Put this folder in a GitHub repository (private is fine).
2. On https://render.com, choose **New → Blueprint** and pick the repository. `render.yaml` sets everything up and creates `LINK_SECRET` for you.
3. Fill in `GEMINI_API_KEY` (from https://aistudio.google.com/apikey) and `APP_PASSWORD`.
4. Share `https://<your-app>.onrender.com` with doctors. Render gives you HTTPS automatically.

The free tier sleeps after 15 minutes without use, so the first visit after that takes about 30 seconds. Railway, Fly.io or any VPS work too: it's a plain `npm start` app with no database.

## Models, speed and cost

The app tries these Gemini models in order (`GEMINI_MODELS`). To keep scans fast:
- If a model is busy, out of quota or not answering, the next one is tried at once, and the failing model is skipped for a while (1 minute if busy, 10 minutes if out of quota).
- If a model hasn't answered after 20 seconds (45 for Pro), a backup model starts in parallel and whichever answers first is used.
- The Hindi and English voices start being made as soon as the doctor approves, so they are usually ready by the time anyone presses play.

1. `gemini-pro-latest`: best at messy handwriting. **Only works once billing is turned on.**
2. `gemini-3-flash-preview`, `gemini-flash-latest`, `gemini-3.8-flash`, `gemini-3.5-flash`: these work on the free tier.

**Free-tier limits:** Google's free tier allows only about **10 voice notes per voice model per day** (the app falls back across 4 voice models) and a small number of scans. When the voice is used up, patients see a clear message and can read their medicines on screen, or hear their phone's own voice if it speaks the language. Once a patient's voice note has loaded, it is saved on their phone, so listening again costs nothing. Turning on billing removes these limits.

A scan usually takes 10–30 seconds. On the free tier, Google gives lower priority when demand is high, so it can occasionally take longer or fail with "try again". With billing on, you get Pro and faster answers, and each scan costs only a few rupees. The review screen shows which model read each prescription.

## Files

| File | What it does |
|---|---|
| `server.js` | Runs the site as a normal Node server (local, Render) |
| `lib/app.js` | All request handling (shared by `server.js` and Vercel) |
| `api/index.js`, `vercel.json` | Vercel function and settings |
| `lib/extract.js` | The Gemini prompt, output format and model fallback for reading prescriptions |
| `lib/tokens.js` | Signed, expiring patient links |
| `lib/auth.js` | Sign-in, sessions, lockout, safe-setup checks |
| `lib/tts.js` | Voice notes: offline Hindi (Piper) and Gemini English |
| `lib/piper.js` | Offline Hindi voice: pauses, slow medicine names |
| `scripts/fetch-voice.mjs` | Downloads and fingerprint-checks the Hindi voice |
| `public/index.html`, `doctor.js` | Doctor screens: upload, crop, review, approve, share |
| `public/scripts.js` | English and Hindi script templates |
| `public/listen.html`, `listen.js` | Patient listening page |
