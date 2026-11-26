// Voices. Hindi: the offline Piper "Pratham" voice on this server (no quota, text stays here), with
// Gemini as a backup. English: Gemini's text-to-speech (same GEMINI_API_KEY as the reader).
import { createHash } from "node:crypto";
import { piperAvailable, speakHindi, speakName } from "./piper.js";
import { gemini, hasApiKey, GeminiError, cooldownFor } from "./extract.js";

// Tried in order; if one is out of quota or busy, the next is used.
const TTS_MODELS = (process.env.GEMINI_TTS_MODELS || "gemini-3.8-flash-tts,gemini-3.8-flash-lite-tts,gemini-3.1-flash-tts-preview,gemini-2.5-flash-preview-tts")
  .split(",").map((m) => m.trim()).filter(Boolean);
const VOICE = process.env.GEMINI_TTS_VOICE || "Kore";

export const hasTts = () => process.env.NATURAL_VOICE !== "off" && (piperAvailable() || hasApiKey());

// How the voice should sound. Sent as "director's notes", a section the model follows but does not
// read aloud; only the TRANSCRIPT section is spoken. (A plain "Read this slowly:" prefix gets spoken.)
const NOTES = {
  en: "Speak slowly, calmly and clearly, with a warm Indian English accent, like a kind nurse explaining medicines to an elderly patient. Pause briefly between medicines. Read every word of the transcript exactly as written; do not skip, add or change anything.",
  hi: "Speak in natural, warm Hindi, slowly, calmly and clearly, like a kind nurse explaining medicines to an elderly patient. Pause briefly between medicines. Read every word of the transcript exactly as written; do not skip, add or change anything.",
};
const prompt = (text, lang) => `### DIRECTOR'S NOTES\n${NOTES[lang]}\n\n### TRANSCRIPT\n${text}`;

/** Long scripts are split at paragraph/sentence ends so each request stays short and reliable. */
function chunks(text, max = 1500) {
  const parts = text.split(/(?<=[.।!?\n])\s+/);
  const out = [];
  let cur = "";
  for (const p of parts) {
    const next = cur ? `${cur} ${p}` : p;
    if (next.length > max && cur) {
      out.push(cur);
      cur = p;
    } else cur = next;
  }
  if (cur) out.push(cur);
  return out;
}

const RETRYABLE = new Set([404, 429, 500, 503]);
const coolUntil = new Map(); // model -> time it may be tried again (e.g. after its daily free quota ran out)

/** Thrown when every voice model is out of quota or busy. */
export class VoiceUnavailableError extends Error {}

async function speakChunk(text, lang, attempt = 0) {
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt(text, lang) }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } },
    },
  };
  let data;
  let shortestWait = Infinity;
  const now = Date.now();
  const ready = TTS_MODELS.filter((m) => !(coolUntil.get(m) > now));
  for (const model of ready) {
    try {
      data = await gemini(model, body);
      break;
    } catch (err) {
      const timedOut = err?.name === "TimeoutError";
      if (!timedOut && !(err instanceof GeminiError && RETRYABLE.has(err.status))) throw err;
      const wait = cooldownFor(err);
      coolUntil.set(model, Date.now() + wait);
      if (err.status === 429 && !err.daily) shortestWait = Math.min(shortestWait, wait);
      console.warn(`[tts] ${model} unavailable (${timedOut ? "timeout" : err.status}${err.daily ? ", daily quota used up" : ""}), trying next voice model`);
    }
  }
  if (!data) {
    // A per-minute limit clears quickly: wait once and try again. A daily limit won't, so give up.
    if (attempt === 0 && shortestWait <= 30_000) {
      await new Promise((r) => setTimeout(r, shortestWait + 500));
      for (const m of TTS_MODELS) if (coolUntil.get(m) <= Date.now() + 1000) coolUntil.delete(m);
      return speakChunk(text, lang, 1);
    }
    throw new VoiceUnavailableError("All voice models are out of quota or busy.");
  }
  const part = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!part) throw new Error("No audio returned");
  const rate = Number(/rate=(\d+)/.exec(part.inlineData.mimeType || "")?.[1]) || 24000;
  return { pcm: Buffer.from(part.inlineData.data, "base64"), rate };
}

const OUT_RATE = 16000; // speech sounds the same at 16 kHz and the file is a third smaller than 24 kHz

/** Resamples 16-bit mono PCM by linear interpolation. */
function resample(pcm, from, to) {
  if (from === to) return pcm;
  const inN = pcm.length / 2, outN = Math.floor((inN * to) / from);
  const out = Buffer.alloc(outN * 2);
  for (let i = 0; i < outN; i++) {
    const x = (i * from) / to, i0 = Math.floor(x), f = x - i0;
    const a = pcm.readInt16LE(Math.min(i0, inN - 1) * 2), b = pcm.readInt16LE(Math.min(i0 + 1, inN - 1) * 2);
    out.writeInt16LE(Math.round(a + (b - a) * f), i * 2);
  }
  return out;
}

/** Returns a WAV file (16-bit mono PCM) of the whole script. Pieces are made in parallel. */
/** A single medicine name in the offline Hindi voice, as a WAV file. */
export function nameAudio(name) {
  const { pcm, rate } = speakName(name);
  const r = resample(pcm, rate, OUT_RATE);
  return Buffer.concat([wavHeader(r.length, OUT_RATE), r]);
}

export async function synthesize(text, lang) {
  let pieces;
  if (lang === "hi" && piperAvailable()) {
    try {
      pieces = [speakHindi(text)];
    } catch (err) {
      console.error("[tts] offline Hindi voice failed, using Gemini:", err?.message);
    }
  }
  if (!pieces) pieces = await Promise.all(chunks(text).map((c) => speakChunk(c, lang)));
  const gap = Buffer.alloc(Math.round(OUT_RATE * 0.5) * 2); // half a second of silence between pieces
  const pcm = Buffer.concat(pieces.flatMap((p, i) => {
    const r = resample(p.pcm, p.rate, OUT_RATE);
    return i ? [gap, r] : [r];
  }));
  // Vercel can't send responses over 4.5 MB (about 2 minutes 15 s at 16 kHz); very long scripts use a lower rate.
  if (process.env.VERCEL && pcm.length > 4.2e6) {
    const low = resample(pcm, OUT_RATE, 11025);
    return Buffer.concat([wavHeader(low.length, 11025), low]);
  }
  return Buffer.concat([wavHeader(pcm.length, OUT_RATE), pcm]);
}

// Small in-memory cache so audio started at approval time is ready when the patient presses play.
// Holds only recent audio (no text, no names) and is lost on restart.
const cache = new Map(); // key -> { at, promise }
const CACHE_MAX = 16, CACHE_TTL = 6 * 60 * 60_000;

/** Audio for this exact text. Keyed by a hash of the text, so the doctor's preview is reused for the patient. */
export function getAudio(text, lang) {
  const now = Date.now();
  for (const [k, v] of cache) if (now - v.at > CACHE_TTL) cache.delete(k);
  const id = createHash("sha256").update(`${lang}
${text}`).digest("base64url");
  let hit = cache.get(id);
  if (!hit) {
    hit = { at: now, promise: synthesize(text, lang) };
    hit.promise.catch(() => cache.delete(id)); // don't keep failures
    cache.set(id, hit);
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }
  return hit.promise;
}

function wavHeader(dataLen, rate) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + dataLen, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(dataLen, 40);
  return h;
}
