import { speak, stopSpeaking } from "./speak.js";

const $ = (id) => document.getElementById(id);
const token = location.hash.slice(1);
let rx = null;
let lang = "hi";
const audioCache = {};

const UI = {
  hi: { title: "अपनी पर्ची सुनें", sub: "भाषा चुनें और जितनी बार चाहें सुनें।", play: "▶ सुनें", playing: "सुनाया जा रहा है…", done: "खत्म। दोबारा सुनने के लिए ▶ दबाएं।", stop: "■ रोकें", expires: "यह लिंक इस तारीख तक चलेगा:", loadingAudio: "आवाज़ तैयार हो रही है…" },
  en: { title: "Listen to your prescription", sub: "Choose a language and listen as many times as you need.", play: "▶ Play", playing: "Playing…", done: "Finished. Press ▶ to listen again.", stop: "■ Stop", expires: "This link works until", loadingAudio: "Preparing audio…" },
};

function fail(msg) {
  $("loading").classList.add("hidden");
  $("error").classList.remove("hidden");
  $("errorText").textContent = msg;
}

async function open() {
  if (!token) return fail("This link is incomplete. / यह लिंक अधूरा है।");
  const res = await fetch("/api/open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) return fail(out.error || "This link is not valid.");
  rx = out;
  $("loading").classList.add("hidden");
  $("patient").classList.remove("hidden");
  select("hi");
}

function select(l) {
  stop();
  lang = l;
  const t = UI[l];
  $("hi").classList.toggle("on", l === "hi");
  $("en").classList.toggle("on", l === "en");
  document.documentElement.lang = l;
  $("title").textContent = t.title;
  $("subtitle").textContent = t.sub;
  $("play").textContent = t.play;
  $("stop").textContent = t.stop;
  $("script").textContent = rx[l];
  $("script").lang = l;
  $("speechStatus").textContent = "";
  $("expires").textContent = `${t.expires} ${new Date(rx.exp * 1000).toLocaleDateString(l === "hi" ? "hi-IN" : "en-IN", { day: "numeric", month: "long", year: "numeric" })}`;
  $("audio").classList.add("hidden");
}

function stop() {
  stopSpeaking();
  $("audio").pause();
  $("stop").classList.add("hidden");
}

async function play() {
  const t = UI[lang];
  if (rx.tts) {
    // Natural voice from the server, shown as a normal audio player (pause, seek, replay).
    try {
      if (!audioCache[lang]) {
        $("speechStatus").textContent = t.loadingAudio;
        const res = await fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, lang }) });
        if (!res.ok) throw new Error("tts");
        audioCache[lang] = URL.createObjectURL(await res.blob());
      }
      const a = $("audio");
      if (a.src !== audioCache[lang]) a.src = audioCache[lang];
      a.classList.remove("hidden");
      a.currentTime = 0;
      await a.play();
      $("speechStatus").textContent = "";
      return;
    } catch {
      $("speechStatus").textContent = "";
      // fall through to the phone's voice
    }
  }
  $("stop").classList.remove("hidden");
  $("speechStatus").textContent = t.playing;
  speak(rx[lang], lang, {
    onend: () => { $("speechStatus").textContent = t.done; $("stop").classList.add("hidden"); },
    onerror: (m) => { $("speechStatus").textContent = m; $("stop").classList.add("hidden"); },
  });
}

$("hi").onclick = () => select("hi");
$("en").onclick = () => select("en");
$("play").onclick = play;
$("stop").onclick = () => { stop(); $("speechStatus").textContent = ""; };

open().catch(() => fail("Could not load. Check your internet. / इंटरनेट जांचें।"));
