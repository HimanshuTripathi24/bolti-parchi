// Speaks text with the device's own voice (used when the server has no natural-voice key, and for doctor previews).
// Long text is split into sentences because some phone browsers stop speaking after ~15 seconds per utterance.

let voicesReady = null;
function loadVoices() {
  if (!("speechSynthesis" in window)) return Promise.resolve([]);
  if (voicesReady) return voicesReady;
  voicesReady = new Promise((resolve) => {
    const v = speechSynthesis.getVoices();
    if (v.length) return resolve(v);
    speechSynthesis.addEventListener("voiceschanged", () => resolve(speechSynthesis.getVoices()), { once: true });
    setTimeout(() => resolve(speechSynthesis.getVoices()), 1500);
  });
  return voicesReady;
}

export const speechSupported = () => "speechSynthesis" in window;

export function stopSpeaking() {
  if (speechSupported()) speechSynthesis.cancel();
}

/**
 * @param {string} text
 * @param {"en"|"hi"} lang
 * @param {{onend?: () => void, onerror?: (msg: string) => void}} cb
 */
export async function speak(text, lang, cb = {}) {
  if (!speechSupported()) return cb.onerror?.("This browser cannot speak. Try Chrome.");
  stopSpeaking();
  const voices = await loadVoices();
  const tag = lang === "hi" ? "hi-IN" : "en-IN";
  const matching = voices.filter((v) => v.lang.replace("_", "-").toLowerCase().startsWith(lang));
  if (lang === "hi" && voices.length && !matching.length) {
    return cb.onerror?.("No Hindi voice on this phone. Install it in Settings → Text-to-speech → Google → Hindi.");
  }
  const voice = matching.find((v) => v.lang.replace("_", "-").toLowerCase() === tag.toLowerCase()) || matching[0] || null;
  const sentences = text.split(/(?<=[.।!?\n])\s+/).map((s) => s.trim()).filter(Boolean);
  sentences.forEach((s, i) => {
    const u = new SpeechSynthesisUtterance(s);
    u.lang = tag;
    if (voice) u.voice = voice;
    u.rate = 0.85;
    if (i === sentences.length - 1) u.onend = () => cb.onend?.();
    u.onerror = (e) => { if (e.error !== "interrupted" && e.error !== "canceled") cb.onerror?.("Speech failed. Check the phone's text-to-speech settings."); };
    speechSynthesis.speak(u);
  });
}
