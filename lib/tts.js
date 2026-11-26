// Optional natural-voice audio through Google Cloud Text-to-Speech. Used only when GOOGLE_TTS_API_KEY is set.
const KEY = process.env.GOOGLE_TTS_API_KEY;

export const hasTts = () => Boolean(KEY);

const VOICES = {
  en: { languageCode: "en-IN", ssmlGender: "FEMALE" },
  hi: { languageCode: "hi-IN", ssmlGender: "FEMALE" },
};

/** Google accepts up to 5000 bytes per request, so long scripts are split at sentence ends and joined. */
function chunks(text, maxBytes = 4500) {
  const parts = text.split(/(?<=[.।!?\n])\s+/);
  const out = [];
  let cur = "";
  for (const p of parts) {
    const next = cur ? `${cur} ${p}` : p;
    if (Buffer.byteLength(next) > maxBytes && cur) {
      out.push(cur);
      cur = p;
    } else {
      cur = next;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export async function synthesize(text, lang) {
  const buffers = [];
  for (const part of chunks(text)) {
    const res = await fetch("https://texttospeech.googleapis.com/v1/text:synthesize", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": KEY },
      body: JSON.stringify({
        input: { text: part },
        voice: VOICES[lang],
        audioConfig: { audioEncoding: "MP3", speakingRate: 0.85 },
      }),
    });
    if (!res.ok) throw new Error(`Text-to-speech failed (${res.status})`);
    const { audioContent } = await res.json();
    buffers.push(Buffer.from(audioContent, "base64"));
  }
  return Buffer.concat(buffers); // MP3 frames can be concatenated directly
}
