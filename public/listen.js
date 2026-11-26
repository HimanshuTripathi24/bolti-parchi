import { speak, stopSpeaking, hasVoiceFor } from "./speak.js";

const $ = (id) => document.getElementById(id);
const token = location.hash.slice(1);
let rx = null;
let lang = "hi";
let speaking = false; // device-voice playback (no pause support), as opposed to the <audio> player
const audioCache = {};


const UI = {
  hi: {
    title: "आपकी दवाइयां", sub: "डॉक्टर ने जांच कर यह संदेश भेजा है। जितनी बार चाहें सुनें।",
    play: "सुनें", pause: "रोकें", again: "फिर से सुनें", stop: "बंद करें",
    loading: "आवाज़ तैयार हो रही है…", playing: "सुनाया जा रहा है…",
    busy: "आवाज़ अभी उपलब्ध नहीं है। थोड़ी देर बाद ▶ दोबारा दबाएं। तब तक नीचे लिखी दवाइयां पढ़ लें।",
    busyPhone: "आवाज़ अभी उपलब्ध नहीं है, इसलिए फ़ोन की आवाज़ में सुनाया जा रहा है।",
    expires: "यह लिंक इस तारीख तक चलेगा:", checked: "जांच की तारीख",
  },
  en: {
    title: "Your medicines", sub: "Your doctor checked this message. Listen as many times as you need.",
    play: "Listen", pause: "Pause", again: "Listen again", stop: "Stop",
    loading: "Preparing the voice…", playing: "Playing…",
    busy: "The voice isn't available right now. Press ▶ again in a little while. Meanwhile you can read your medicines below.",
    busyPhone: "The voice isn't available right now, so your phone's own voice is reading it.",
    expires: "This link works until", checked: "Checked on",
  },
};

const fmtDate = (sec, l) => new Date(sec * 1000).toLocaleDateString(l === "hi" ? "hi-IN" : "en-IN", { day: "numeric", month: "long", year: "numeric" });

// Once a voice note has loaded, a copy is kept on this phone (until the link expires), so listening
// again works offline and doesn't use the clinic's voice quota.
const STORE = "bolti-voice-v1";
async function storeKey(l) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${l}|${token}`));
  return `/voice-cache/${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
async function fromPhone(l) {
  if (!("caches" in window)) return null;
  try {
    const hit = await (await caches.open(STORE)).match(await storeKey(l));
    return hit ? await hit.blob() : null;
  } catch { return null; }
}
async function toPhone(l, blob) {
  if (!("caches" in window)) return;
  try {
    await (await caches.open(STORE)).put(await storeKey(l), new Response(blob, { headers: { "Content-Type": "audio/wav", "X-Expires": String(rx.exp) } }));
  } catch {}
}
async function pruneExpired() {
  if (!("caches" in window)) return;
  try {
    const cache = await caches.open(STORE);
    for (const req of await cache.keys()) {
      const res = await cache.match(req);
      if (Number(res?.headers.get("X-Expires")) < Date.now() / 1000) await cache.delete(req);
    }
  } catch {}
}

/** Gets the natural-voice audio once per language: from this phone if saved, else from the server. */
function loadAudio(l) {
  if (!audioCache[l]) {
    audioCache[l] = (async () => {
      let blob = await fromPhone(l);
      if (!blob) {
        const res = await fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, lang: l }) });
        if (!res.ok) throw new Error(res.status === 503 || res.status === 429 ? "busy" : "tts");
        blob = await res.blob();
        toPhone(l, blob);
      }
      return URL.createObjectURL(blob);
    })();
    audioCache[l].catch(() => { delete audioCache[l]; });
  }
  return audioCache[l];
}

function fail(msg) {
  $("loading").classList.add("hidden");
  $("error").classList.remove("hidden");
  $("errorText").textContent = msg;
}

async function open() {
  if (!token) return fail("यह लिंक अधूरा है। This link is incomplete.");
  const res = await fetch("/api/open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) return fail(out.error || "This link is not valid.");
  rx = out;
  $("loading").classList.add("hidden");
  $("patient").classList.remove("hidden");
  select("hi");
  pruneExpired();
  if (rx.tts) loadAudio("hi").catch(() => {}); // start preparing the Hindi voice while the patient reads
}

/** Shows the script as readable blocks: intro, one block per medicine, then advice. */
function renderScript(text, l) {
  const box = $("script");
  box.replaceChildren();
  box.lang = l;
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const list = document.createElement("ol");
  list.className = "rx-list";
  paras.forEach((p, i) => {
    const m = /^(?:Medicine|दवा)\s*(\d+)\s*:\s*([^\n]*)\n?([\s\S]*)$/.exec(p);
    if (m) {
      if (!list.isConnected) box.append(list);
      const li = document.createElement("li");
      li.className = "rx-item";
      const n = document.createElement("span");
      n.className = "n";
      n.textContent = m[1];
      const body = document.createElement("div");
      const h = document.createElement("h3");
      h.textContent = m[2].replace(/[।.]\s*$/, "");
      const how = document.createElement("p");
      how.textContent = m[3].trim();
      body.append(h, how);
      li.append(n, body);
      list.append(li);
    } else {
      const para = document.createElement("p");
      para.className = i === 0 ? "rx-intro" : "rx-extra";
      para.textContent = p;
      box.append(para);
    }
  });
}

function setButton(state) {
  const t = UI[lang];
  const btn = $("play");
  $("iconPlay").classList.toggle("hidden", state === "playing");
  $("iconPause").classList.toggle("hidden", state !== "playing");
  btn.setAttribute("aria-label", state === "playing" ? t.pause : t.play);
  $("playLabel").textContent = state === "playing" ? t.pause : state === "ended" ? t.again : t.play;
}

function select(l) {
  stop();
  lang = l;
  const t = UI[l];
  $("hi").setAttribute("aria-pressed", String(l === "hi"));
  $("en").setAttribute("aria-pressed", String(l === "en"));
  document.documentElement.lang = l;
  $("title").textContent = t.title;
  $("subtitle").textContent = t.sub;
  $("stop").textContent = t.stop;
  $("stampLine").textContent = rx.iat ? fmtDate(rx.iat, "en") : "";
  renderScript(rx[l], l);
  $("speechStatus").textContent = "";
  $("expires").textContent = `${t.expires} ${fmtDate(rx.exp, l)}`;
  $("audio").classList.add("hidden");
  setButton("idle");
}

function stop() {
  stopSpeaking();
  speaking = false;
  $("audio").pause();
  $("stop").classList.add("hidden");
}

async function play() {
  const t = UI[lang];
  const a = $("audio");
  // Second press pauses (natural voice) or stops (phone voice).
  if (!a.paused) { a.pause(); return; }
  if (speaking) { stop(); setButton("idle"); $("speechStatus").textContent = ""; return; }

  if (rx.tts) {
    try {
      $("speechStatus").textContent = t.loading;
      const url = await loadAudio(lang);
      if (a.src !== url) a.src = url;
      a.classList.remove("hidden");
      if (a.ended) a.currentTime = 0;
      await a.play();
      $("speechStatus").textContent = "";
      return;
    } catch {
      // Natural voice unavailable. Use the phone's own voice if it speaks this language; otherwise say so plainly.
      if (!(await hasVoiceFor(lang))) {
        $("speechStatus").textContent = t.busy;
        setButton("idle");
        return;
      }
    }
  }
  speaking = true;
  setButton("playing");
  $("stop").classList.remove("hidden");
  $("speechStatus").textContent = rx.tts ? t.busyPhone : t.playing;
  speak(rx[lang], lang, {
    onend: () => { speaking = false; $("speechStatus").textContent = ""; $("stop").classList.add("hidden"); setButton("ended"); },
    onerror: (m) => { speaking = false; $("speechStatus").textContent = m; $("stop").classList.add("hidden"); setButton("idle"); },
  });
}

const audio = $("audio");
audio.addEventListener("play", () => setButton("playing"));
audio.addEventListener("pause", () => setButton(audio.ended ? "ended" : "idle"));
audio.addEventListener("ended", () => setButton("ended"));

$("hi").onclick = () => select("hi");
$("en").onclick = () => select("en");
$("play").onclick = play;
$("stop").onclick = () => { stop(); setButton("idle"); $("speechStatus").textContent = ""; };

open().catch(() => fail("इंटरनेट जांचें और दोबारा खोलें। Check your internet and open the link again."));
