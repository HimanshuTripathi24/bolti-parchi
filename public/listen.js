import { speak, stopSpeaking } from "./speak.js";

const $ = (id) => document.getElementById(id);
const token = location.hash.slice(1);
let rx = null;
let lang = "hi";
let speaking = false; // device-voice playback (no pause support), as opposed to the <audio> player
const audioCache = {};

const PLAY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/></svg>';
const PAUSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor"/></svg>';

const UI = {
  hi: {
    title: "आपकी दवाइयां", sub: "डॉक्टर ने जांच कर यह संदेश भेजा है। जितनी बार चाहें सुनें।",
    play: "सुनें", pause: "रोकें", again: "फिर से सुनें", stop: "बंद करें",
    loading: "आवाज़ तैयार हो रही है…", playing: "सुनाया जा रहा है…",
    expires: "यह लिंक इस तारीख तक चलेगा:", checked: "जांच की तारीख",
  },
  en: {
    title: "Your medicines", sub: "Your doctor checked this message. Listen as many times as you need.",
    play: "Listen", pause: "Pause", again: "Listen again", stop: "Stop",
    loading: "Preparing the voice…", playing: "Playing…",
    expires: "This link works until", checked: "Checked on",
  },
};

const fmtDate = (sec, l) => new Date(sec * 1000).toLocaleDateString(l === "hi" ? "hi-IN" : "en-IN", { day: "numeric", month: "long", year: "numeric" });

/** Fetches the natural-voice audio once per language; the promise is reused. */
function loadAudio(l) {
  if (!audioCache[l]) {
    audioCache[l] = fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, lang: l }) })
      .then((res) => { if (!res.ok) throw new Error("tts"); return res.blob(); })
      .then((blob) => URL.createObjectURL(blob));
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
  btn.innerHTML = state === "playing" ? PAUSE_ICON : PLAY_ICON;
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
      $("speechStatus").textContent = ""; // fall back to the phone's own voice
    }
  }
  speaking = true;
  setButton("playing");
  $("stop").classList.remove("hidden");
  $("speechStatus").textContent = t.playing;
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
