// Offline Hindi voice: Piper "hi_IN-pratham" running on this server through sherpa-onnx.
// No quota, no outside service: the text never leaves the server.
//
// The script is spoken phrase by phrase with deliberate pauses (short at commas, longer after
// sentences, longest between medicines), and medicine names are spoken more slowly, on their own.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const VOICE_DIR = process.env.PIPER_VOICE_DIR || path.join(ROOT, "voices", "pratham");
const MODEL = path.join(VOICE_DIR, "hi_IN-pratham-medium.onnx");

// Speaking rates (1 = Piper's normal speed; lower = slower).
const SPEED_TEXT = 0.88;
const SPEED_NAME = 0.72;
// Pauses, in milliseconds.
const PAUSE = { word: 120, comma: 320, colon: 450, sentence: 650, name: 450, medicine: 1100 };

export const piperAvailable = () => process.env.PIPER !== "off" && fs.existsSync(MODEL);

let engine;
function getEngine() {
  if (!engine) {
    const sherpa = require("sherpa-onnx-node");
    engine = new sherpa.OfflineTts({
      model: {
        vits: { model: MODEL, tokens: path.join(VOICE_DIR, "tokens.txt"), dataDir: path.join(VOICE_DIR, "espeak-ng-data") },
        numThreads: 2,
        provider: "cpu",
        debug: false,
      },
      maxNumSentences: 1,
    });
  }
  return engine;
}

// Latin letters left in Hindi text (e.g. the "D" in "Pantop D") are read out as letter names.
const LETTERS = { A: "ए", B: "बी", C: "सी", D: "डी", E: "ई", F: "एफ़", G: "जी", H: "एच", I: "आई", J: "जे", K: "के", L: "एल", M: "एम", N: "एन", O: "ओ", P: "पी", Q: "क्यू", R: "आर", S: "एस", T: "टी", U: "यू", V: "वी", W: "डब्ल्यू", X: "एक्स", Y: "वाई", Z: "ज़ेड" };
function prepare(text) {
  return text
    .replace(/\b([A-Z]{1,5})\b/g, (_, w) => [...w].map((c) => LETTERS[c]).join(" "))
    .replace(/(\S)-(\S)/g, "$1 $2") // "Pantop-D" style joins become a small gap
    .replace(/[()]/g, ",")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Turns a script into a list of phrases to speak, each with its speed and the pause after it.
 * Medicine lines look like "दवा 1: <name> <strength> <form>।" (see public/scripts.js).
 */
export function plan(text) {
  const out = [];
  const add = (t, speed, pause) => {
    const p = prepare(t);
    if (p) out.push({ text: p, speed, pause });
  };
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  for (const para of paragraphs) {
    const sentences = para.split(/(?<=[।.!?])\s+|\n/).map((s) => s.trim()).filter(Boolean);
    for (const sentence of sentences) {
      const med = /^(दवा|Medicine)\s*(\d+)\s*:\s*(.+)$/.exec(sentence);
      if (med) {
        add(`${med[1]} ${med[2]}`, SPEED_TEXT, PAUSE.colon);
        // Name first (slowly, on its own), then strength and form at normal speed.
        const body = med[3].replace(/[।.]\s*$/, "");
        const split = /^(.*?)\s+(\d.*)$/.exec(body);
        if (split) {
          add(split[1], SPEED_NAME, PAUSE.name);
          add(split[2], SPEED_TEXT, PAUSE.sentence);
        } else {
          add(body, SPEED_NAME, PAUSE.sentence);
        }
        continue;
      }
      const phrases = sentence.split(/(?<=[,;:])\s*/).map((s) => s.replace(/[,;:।.!?]\s*$/, "").trim()).filter(Boolean);
      phrases.forEach((ph, i) => add(ph, SPEED_TEXT, i === phrases.length - 1 ? PAUSE.sentence : PAUSE.comma));
    }
    if (out.length) out[out.length - 1].pause = PAUSE.medicine;
  }
  if (out.length) out[out.length - 1].pause = 0;
  return out;
}

/**
 * Removes long leading/trailing silence so the pauses we add are the pauses you hear.
 * Careful: soft first sounds (k, p, t, r, s) are quiet, and medicine names always start a phrase.
 * So we only look for real speech energy over 10 ms windows, and keep a generous 180 ms before it
 * and 120 ms after it. Clipping the first sound of a medicine name would change the name.
 */
function trim(samples, rate) {
  const win = Math.round(rate * 0.01);
  const threshold = 0.02; // RMS of clearly voiced speech
  const rms = (start) => {
    let s = 0;
    const end = Math.min(samples.length, start + win);
    for (let i = start; i < end; i++) s += samples[i] * samples[i];
    return Math.sqrt(s / Math.max(1, end - start));
  };
  let a = 0;
  while (a < samples.length && rms(a) < threshold) a += win;
  let b = samples.length - win;
  while (b > a && rms(b) < threshold) b -= win;
  if (a >= samples.length) return samples; // nothing loud: leave untouched
  const lead = Math.round(rate * 0.18), tail = Math.round(rate * 0.12);
  return samples.subarray(Math.max(0, a - lead), Math.min(samples.length, b + win + tail));
}

/** Speaks just a medicine name, at the slower name speed (for the doctor's check). */
export const speakName = (name) => speakHindi(name, [{ text: prepare(name), speed: SPEED_NAME, pause: 0 }]);

/** Speaks a Hindi script. Returns 16-bit mono PCM and its sample rate. */
export function speakHindi(text, phrases = plan(text)) {
  const tts = getEngine();
  const rate = tts.sampleRate;
  const parts = [];
  let total = 0;
  for (const { text: t, speed, pause } of phrases) {
    const audio = tts.generate({ text: t, sid: 0, speed });
    const s = trim(audio.samples, rate);
    const gap = Math.round((rate * pause) / 1000);
    parts.push({ s, gap });
    total += s.length + gap;
  }
  const pcm = Buffer.alloc(total * 2);
  let o = 0;
  for (const { s, gap } of parts) {
    for (let i = 0; i < s.length; i++) {
      const v = Math.max(-1, Math.min(1, s[i] * 0.95));
      pcm.writeInt16LE(Math.round(v * 32767), o);
      o += 2;
    }
    o += gap * 2; // silence (buffer is zero-filled)
  }
  return { pcm, rate };
}
