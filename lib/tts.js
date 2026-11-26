// Natural Hindi/English voice using Gemini's text-to-speech model (same GEMINI_API_KEY as the reader).
import { gemini, hasApiKey } from "./extract.js";

const TTS_MODEL = process.env.GEMINI_TTS_MODEL || "gemini-3.8-flash-tts";
const VOICE = process.env.GEMINI_TTS_VOICE || "Kore";

export const hasTts = () => hasApiKey() && process.env.NATURAL_VOICE !== "off";

const STYLE = {
  en: "Read this aloud in a calm, warm, clear voice with an Indian English accent, slowly, pausing between medicines, for a patient:",
  hi: "इसे एक मरीज़ के लिए शांत, साफ़ और धीमी आवाज़ में पढ़ें, हर दवा के बीच थोड़ा रुकें:",
};

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

async function speakChunk(text, lang) {
  const data = await gemini(TTS_MODEL, {
    contents: [{ role: "user", parts: [{ text: `${STYLE[lang]}\n\n${text}` }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } },
    },
  });
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
export async function synthesize(text, lang) {
  const pieces = await Promise.all(chunks(text).map((c) => speakChunk(c, lang)));
  const gap = Buffer.alloc(Math.round(OUT_RATE * 0.5) * 2); // half a second of silence between pieces
  const pcm = Buffer.concat(pieces.flatMap((p, i) => {
    const r = resample(p.pcm, p.rate, OUT_RATE);
    return i ? [gap, r] : [r];
  }));
  return Buffer.concat([wavHeader(pcm.length, OUT_RATE), pcm]);
}

// Small in-memory cache so audio started at approval time is ready when the patient presses play.
// Holds only recent audio (no text, no names) and is lost on restart.
const cache = new Map(); // key -> { at, promise }
const CACHE_MAX = 16, CACHE_TTL = 6 * 60 * 60_000;

export function getAudio(key, text, lang) {
  const now = Date.now();
  for (const [k, v] of cache) if (now - v.at > CACHE_TTL) cache.delete(k);
  const id = `${lang}:${key}`;
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
