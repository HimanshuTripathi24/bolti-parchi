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
function chunks(text, max = 1200) {
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

/** Returns a WAV file (16-bit mono PCM) of the whole script. */
export async function synthesize(text, lang) {
  const pieces = [];
  for (const c of chunks(text)) pieces.push(await speakChunk(c, lang));
  const rate = pieces[0].rate;
  const gap = Buffer.alloc(Math.round(rate * 0.5) * 2); // half a second of silence between pieces
  const pcm = Buffer.concat(pieces.flatMap((p, i) => (i ? [gap, p.pcm] : [p.pcm])));
  return Buffer.concat([wavHeader(pcm.length, rate), pcm]);
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
