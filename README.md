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
- Voice: Gemini's text-to-speech model (same key) gives patients a natural Hindi or English voice, and the doctor can share a **voice note** (WAV file) straight to WhatsApp. If that fails, or `NATURAL_VOICE=off`, the patient's phone voice reads it instead (most Android phones have Hindi; if not, the page explains how to turn it on).

## Privacy (what is and isn't stored)

- **No database.** The server stores no images, text or patient data. The approved script lives inside the patient link itself, signed so nobody can change it, and the link expires (30 days by default).
- Photos and text go to the Gemini API to be read. **Turn on billing for the key's Google Cloud project before using real patient data.** On the free tier, Google may use what you send to improve its products, and people may review it. On the paid tier it doesn't.
- Crop out names and don't type names or phone numbers. The AI is also told not to return any identifying details.
- The doctor side needs a clinic password. Pages are not indexed by search engines.
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

## Put it online (Render, free tier)

1. Put this folder in a GitHub repository (private is fine).
2. On https://render.com, choose **New → Blueprint** and pick the repository. `render.yaml` sets everything up and creates `LINK_SECRET` for you.
3. Fill in `GEMINI_API_KEY` (from https://aistudio.google.com/apikey) and `APP_PASSWORD`.
4. Share `https://<your-app>.onrender.com` with doctors. Render gives you HTTPS automatically.

The free tier sleeps after 15 minutes without use, so the first visit after that takes about 30 seconds. Railway, Fly.io or any VPS work too: it's a plain `npm start` app with no database.

## Models, speed and cost

The app tries these Gemini models in order (`GEMINI_MODELS`). If one is busy, out of quota or takes longer than 75 seconds, it moves on to the next:

1. `gemini-pro-latest`: best at messy handwriting. **Only works once billing is turned on.**
2. `gemini-3-flash-preview`, `gemini-flash-latest`, `gemini-3.8-flash`, `gemini-3.5-flash`: these work on the free tier.

On the free tier, Google gives lower priority when demand is high, so a scan can take 1–2 minutes or fail with "try again". With billing on, you get Pro and faster answers, and each scan costs only a few rupees. The review screen shows which model read each prescription.

## Files

| File | What it does |
|---|---|
| `server.js` | Web server and API (no framework, no dependencies) |
| `lib/extract.js` | The Gemini prompt, output format and model fallback for reading prescriptions |
| `lib/tokens.js` | Signed, expiring patient links |
| `lib/tts.js` | Natural voice with Gemini text-to-speech |
| `public/index.html`, `doctor.js` | Doctor screens: upload, crop, review, approve, share |
| `public/scripts.js` | English and Hindi script templates |
| `public/listen.html`, `listen.js` | Patient listening page |
