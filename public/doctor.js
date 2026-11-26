import { buildScripts } from "./scripts.js";
import { speak, stopSpeaking } from "./speak.js";

const $ = (id) => document.getElementById(id);
const MAX_EDGE = 2576; // long edge sent to Gemini; enough detail for handwriting
const MAX_B64 = 3.3 * 1024 * 1024; // keeps each upload under Vercel's 4.5 MB request limit

const FORMS = ["tablet", "capsule", "syrup", "suspension", "drops", "injection", "ointment", "cream", "gel", "lotion", "powder", "sachet", "inhaler", "spray", "suppository", "mouthwash", "soap", "other"];
const TIMES = [["morning", "Morning"], ["afternoon", "Afternoon"], ["evening", "Evening"], ["night", "Night"], ["bedtime", "Bedtime"]];
const FOOD = [["not_specified", "Not specified"], ["before_food", "Before food"], ["after_food", "After food"], ["with_food", "With food"], ["empty_stomach", "Empty stomach"]];
const UNITS = [["days", "days"], ["weeks", "weeks"], ["months", "months"], ["until_finished", "until finished"], ["continue", "continue (no end)"], ["not_specified", "not specified"]];

let config = {};
let password = sessionStorage.getItem("bp-pw") || "";
let mode = "photo";
let data = null; // extraction result being edited
let token = null;

// ---------- server calls ----------
async function api(path, body, { raw = false } = {}) {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", "x-app-password": password },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    sessionStorage.removeItem("bp-pw");
    showLogin("Please sign in again.");
    throw new Error("Wrong password.");
  }
  if (!res.ok) {
    let msg = `Error ${res.status}`;
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  return raw ? res : res.json();
}

function showLogin(msg = "") {
  $("app").classList.add("hidden");
  $("login").classList.remove("hidden");
  $("loginStatus").textContent = msg;
  $("pw").focus();
}

async function init() {
  config = await api("/api/config");
  $("demoBanner").classList.toggle("hidden", !config.demo);
  $("days").value = config.linkDays;
  if (config.passwordRequired && !password) return showLogin();
  if (config.passwordRequired) {
    try { await api("/api/login", {}); } catch { return; }
  }
  $("app").classList.remove("hidden");
}

$("loginBtn").onclick = async () => {
  password = $("pw").value;
  try {
    await api("/api/login", {});
    sessionStorage.setItem("bp-pw", password);
    $("login").classList.add("hidden");
    $("app").classList.remove("hidden");
  } catch (e) {
    $("loginStatus").textContent = e.message;
  }
};
$("pw").addEventListener("keydown", (e) => { if (e.key === "Enter") $("loginBtn").click(); });

// ---------- step 1: input ----------
function setMode(m) {
  mode = m;
  $("tabPhoto").classList.toggle("on", m === "photo");
  $("tabText").classList.toggle("on", m === "text");
  $("photoPane").classList.toggle("hidden", m !== "photo");
  $("textPane").classList.toggle("hidden", m !== "text");
  updateReadBtn();
}
$("tabPhoto").onclick = () => setMode("photo");
$("tabText").onclick = () => setMode("text");

const img = { el: null, rot: 0, crop: null, scale: 1 };
const canvas = $("canvas");
const ctx = canvas.getContext("2d");

function updateReadBtn() {
  $("readBtn").disabled = mode === "photo" ? !img.el : !$("rxText").value.trim();
}
$("rxText").addEventListener("input", updateReadBtn);

async function loadFile(file) {
  if (!file) return;
  const url = URL.createObjectURL(file);
  const el = new Image();
  el.onload = () => {
    img.el = el;
    img.rot = 0;
    img.crop = null;
    $("editorWrap").classList.remove("hidden");
    draw();
    updateReadBtn();
  };
  el.onerror = () => { $("readStatus").textContent = "That file could not be opened as an image."; };
  el.src = url;
}
$("camera").onchange = (e) => loadFile(e.target.files[0]);
$("gallery").onchange = (e) => loadFile(e.target.files[0]);
$("txtFile").onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  $("rxText").value = (await f.text()).slice(0, 8000);
  updateReadBtn();
};

/** Draws the (rotated) image at full resolution onto a canvas, optionally cropped and contrast-boosted. */
function render(target, maxEdge, crop) {
  const { el, rot } = img;
  const swap = rot % 180 !== 0;
  const fw = swap ? el.naturalHeight : el.naturalWidth;
  const fh = swap ? el.naturalWidth : el.naturalHeight;
  const full = document.createElement("canvas");
  full.width = fw;
  full.height = fh;
  const f = full.getContext("2d");
  f.translate(fw / 2, fh / 2);
  f.rotate((rot * Math.PI) / 180);
  f.drawImage(el, -el.naturalWidth / 2, -el.naturalHeight / 2);
  const c = crop || { x: 0, y: 0, w: fw, h: fh };
  const s = Math.min(1, maxEdge / Math.max(c.w, c.h));
  target.width = Math.round(c.w * s);
  target.height = Math.round(c.h * s);
  const t = target.getContext("2d");
  t.imageSmoothingQuality = "high";
  t.drawImage(full, c.x, c.y, c.w, c.h, 0, 0, target.width, target.height);
  if ($("enhance").checked) enhance(t, target.width, target.height);
  return { fw, fh };
}

/** Grayscale + stretch the darkest 1% to black and brightest 1% to white. Helps faint ink. */
function enhance(t, w, h) {
  const d = t.getImageData(0, 0, w, h);
  const px = d.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < px.length; i += 4) {
    const g = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) | 0;
    px[i] = g;
    hist[g]++;
  }
  const total = w * h;
  let lo = 0, hi = 255, acc = 0;
  while (lo < 255 && (acc += hist[lo]) < total * 0.01) lo++;
  acc = 0;
  while (hi > 0 && (acc += hist[hi]) < total * 0.01) hi--;
  const range = Math.max(1, hi - lo);
  for (let i = 0; i < px.length; i += 4) {
    const v = Math.max(0, Math.min(255, ((px[i] - lo) * 255) / range));
    px[i] = px[i + 1] = px[i + 2] = v;
  }
  t.putImageData(d, 0, 0);
}

function draw() {
  const maxW = $("editor").clientWidth || 800;
  const { fw } = render(canvas, Math.max(maxW, 900), null);
  img.scale = canvas.width / fw; // display canvas px per full-res px
  drawCropBox();
}

function drawCropBox() {
  const box = $("cropbox");
  if (!img.crop) return box.classList.add("hidden");
  const r = canvas.getBoundingClientRect();
  const k = (r.width / canvas.width) * img.scale; // css px per full-res px
  const offX = canvas.offsetLeft;
  box.style.left = `${offX + img.crop.x * k}px`;
  box.style.top = `${img.crop.y * k}px`;
  box.style.width = `${img.crop.w * k}px`;
  box.style.height = `${img.crop.h * k}px`;
  box.classList.remove("hidden");
}

$("rotL").onclick = () => { img.rot = (img.rot + 270) % 360; img.crop = null; draw(); };
$("rotR").onclick = () => { img.rot = (img.rot + 90) % 360; img.crop = null; draw(); };
$("clearCrop").onclick = () => { img.crop = null; drawCropBox(); };
$("enhance").onchange = draw;
window.addEventListener("resize", () => img.el && draw());

let dragStart = null;
function toFull(e) {
  const r = canvas.getBoundingClientRect();
  const k = (r.width / canvas.width) * img.scale;
  const fw = canvas.width / img.scale, fh = canvas.height / img.scale;
  return { x: Math.max(0, Math.min(fw, (e.clientX - r.left) / k)), y: Math.max(0, Math.min(fh, (e.clientY - r.top) / k)) };
}
canvas.addEventListener("pointerdown", (e) => { if (!img.el) return; canvas.setPointerCapture(e.pointerId); dragStart = toFull(e); });
canvas.addEventListener("pointermove", (e) => {
  if (!dragStart) return;
  const p = toFull(e);
  img.crop = { x: Math.min(dragStart.x, p.x), y: Math.min(dragStart.y, p.y), w: Math.abs(p.x - dragStart.x), h: Math.abs(p.y - dragStart.y) };
  drawCropBox();
});
canvas.addEventListener("pointerup", () => {
  dragStart = null;
  if (img.crop && (img.crop.w < 40 || img.crop.h < 40)) { img.crop = null; drawCropBox(); }
});

async function exportImage() {
  const out = document.createElement("canvas");
  let edge = MAX_EDGE;
  for (;;) {
    render(out, edge, img.crop);
    for (const q of [0.92, 0.85, 0.75]) {
      const dataUrl = out.toDataURL("image/jpeg", q);
      const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
      if (b64.length <= MAX_B64) return { b64, dataUrl };
    }
    edge = Math.round(edge * 0.8);
  }
}

$("readBtn").onclick = async () => {
  const btn = $("readBtn");
  const status = $("readStatus");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Reading… (usually 10–30 seconds)';
  status.textContent = "";
  try {
    let body, refUrl = null;
    if (mode === "photo") {
      const { b64, dataUrl } = await exportImage();
      body = { imageBase64: b64, mediaType: "image/jpeg" };
      refUrl = dataUrl;
    } else {
      body = { text: $("rxText").value };
    }
    data = await api("/api/extract", body);
    showReview(refUrl, mode === "text" ? $("rxText").value : null);
  } catch (e) {
    status.textContent = e.message;
  } finally {
    btn.innerHTML = "✨ Read prescription";
    updateReadBtn();
  }
};

// ---------- step 2: review ----------
function showReview(refUrl, typedText) {
  for (const m of data.medicines) m._checked = false;
  $("refImg").classList.toggle("hidden", !refUrl);
  if (refUrl) $("refImg").src = refUrl;
  $("transcription").value = typedText ?? data.transcription ?? "";
  $("readBy").textContent = data.model ? `Read by ${data.model}. ` : data.demo ? "Sample data (demo mode). " : "";
  $("notRx").classList.toggle("hidden", data.is_prescription !== false);
  $("unreadable").classList.toggle("hidden", !data.unreadable_parts);
  $("unreadable").textContent = data.unreadable_parts ? `Could not read: ${data.unreadable_parts}` : "";
  $("advice").value = (data.general_advice || []).join("\n");
  $("adviceHi").value = (data.general_advice_hindi || []).join("\n");
  $("followUp").value = data.follow_up || "";
  $("followUpHi").value = data.follow_up_hindi || "";
  renderMeds();
  $("reviewCard").classList.remove("hidden");
  $("scriptCard").classList.add("hidden");
  $("shareCard").classList.add("hidden");
  $("reviewCard").scrollIntoView({ behavior: "smooth" });
}

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, "");
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) e.append(c);
  return e;
}

let uid = 0;
function field(labelText, input) {
  const id = `f${++uid}`;
  input.id = id;
  return el("div", {}, el("label", { for: id }, labelText), input);
}

function onTableChange() {
  token = null;
  $("shareCard").classList.add("hidden");
  if (!$("scriptCard").classList.contains("hidden")) {
    $("scriptCard").classList.add("hidden");
    $("reviewStatus").textContent = "You changed the table. Press “Make patient scripts” again.";
  }
}

function bindText(m, key, attrs = {}) {
  return el("input", { type: "text", value: m[key] ?? "", ...attrs, oninput: (e) => { m[key] = e.target.value; uncheck(m); } });
}
function bindSelect(m, key, options) {
  const s = el("select", { onchange: (e) => { m[key] = e.target.value; uncheck(m); } },
    options.map(([v, t]) => el("option", { value: v, selected: m[key] === v }, t)));
  return s;
}
function uncheck(m) {
  onTableChange();
}

function renderMeds() {
  const box = $("meds");
  box.replaceChildren();
  data.medicines.forEach((m, i) => {
    const conf = m.confidence || "high";
    const times = el("div", { class: "times" }, TIMES.map(([v, t]) =>
      el("label", {}, el("input", { type: "checkbox", checked: (m.times_of_day || []).includes(v), onchange: (e) => {
        const set = new Set(m.times_of_day || []);
        e.target.checked ? set.add(v) : set.delete(v);
        m.times_of_day = [...set];
        uncheck(m);
      } }), t)));
    const checkId = `chk${++uid}`;
    const card = el("div", { class: `med ${conf}` },
      el("div", { class: "med-head" },
        el("h3", {}, `Medicine ${i + 1}`),
        el("span", { class: `badge ${conf}` }, conf === "high" ? "AI confident" : conf === "medium" ? "AI partly unsure" : "AI unsure — check carefully"),
        el("button", { class: "small danger", onclick: () => { if (confirm("Remove this medicine?")) { data.medicines.splice(i, 1); renderMeds(); onTableChange(); } } }, "Remove")),
      m.as_written ? el("div", { class: "written" }, `Written: ${m.as_written}`) : null,
      m.doubts ? el("div", { class: "doubt" }, `⚠ ${m.doubts}`) : null,
      el("div", { class: "grid4" },
        field("Medicine name", bindText(m, "medicine_name")),
        field("Hindi pronunciation", bindText(m, "name_hindi", { lang: "hi" })),
        field("Strength", bindText(m, "strength", { placeholder: "500 mg" })),
        field("Form", bindSelect(m, "form", FORMS.map((f) => [f, f])))),
      el("div", { class: "grid4" },
        field("Dose each time", bindText(m, "dose", { placeholder: "1, 1/2, 5 ml" })),
        field("Times per day", el("input", { type: "number", min: 0, max: 12, value: m.times_per_day ?? 0, oninput: (e) => { m.times_per_day = Number(e.target.value) || 0; uncheck(m); } })),
        field("Food", bindSelect(m, "food", FOOD)),
        el("div", {}, el("label", {}, "Only if needed (SOS)"), el("label", { class: "inline" }, el("input", { type: "checkbox", checked: !!m.as_needed, onchange: (e) => { m.as_needed = e.target.checked; uncheck(m); } }), "SOS"))),
      el("label", {}, "When in the day"),
      times,
      el("div", { class: "grid4" },
        field("Duration", el("input", { type: "number", min: 0, value: m.duration_number ?? 0, oninput: (e) => { m.duration_number = Number(e.target.value) || 0; uncheck(m); } })),
        field("Unit", bindSelect(m, "duration_unit", UNITS))),
      el("div", { class: "grid2" },
        field("Other instructions (English)", bindText(m, "other_instructions")),
        field("अन्य निर्देश (हिन्दी)", bindText(m, "other_instructions_hindi", { lang: "hi" }))),
      el("div", { class: "check checked-line" },
        el("input", { type: "checkbox", id: checkId, checked: !!m._checked, onchange: (e) => { m._checked = e.target.checked; onTableChange(); } }),
        el("label", { for: checkId }, "I checked this medicine against the original prescription")));
    box.append(card);
  });
}

$("addMed").onclick = () => {
  data.medicines.push({ as_written: "", medicine_name: "", name_hindi: "", strength: "", form: "tablet", dose: "1", frequency_as_written: "", times_per_day: 0, times_of_day: [], as_needed: false, food: "not_specified", duration_number: 0, duration_unit: "days", other_instructions: "", other_instructions_hindi: "", confidence: "high", doubts: "", _checked: false });
  renderMeds();
  onTableChange();
};
for (const id of ["advice", "adviceHi", "followUp", "followUpHi"]) $(id).addEventListener("input", onTableChange);

$("makeScripts").onclick = () => {
  const status = $("reviewStatus");
  if (!data.medicines.length) return (status.textContent = "Add at least one medicine.");
  const unnamed = data.medicines.findIndex((m) => !m.medicine_name.trim());
  if (unnamed >= 0) return (status.textContent = `Medicine ${unnamed + 1} has no name.`);
  const unchecked = data.medicines.findIndex((m) => !m._checked);
  if (unchecked >= 0) return (status.textContent = `Tick “checked” on medicine ${unchecked + 1} first.`);
  const noTiming = data.medicines.findIndex((m) => !m.as_needed && !m.times_per_day && !(m.times_of_day || []).length);
  if (noTiming >= 0) return (status.textContent = `Medicine ${noTiming + 1}: set how many times a day, or tick SOS.`);
  status.textContent = "";
  data.general_advice = $("advice").value.split("\n").map((s) => s.trim()).filter(Boolean);
  data.general_advice_hindi = $("adviceHi").value.split("\n").map((s) => s.trim()).filter(Boolean);
  data.follow_up = $("followUp").value.trim();
  data.follow_up_hindi = $("followUpHi").value.trim();
  const { en, hi } = buildScripts(data);
  $("enScript").value = en;
  $("hiScript").value = hi;
  for (const c of ["c1", "c2", "c3"]) $(c).checked = false;
  $("scriptCard").classList.remove("hidden");
  $("shareCard").classList.add("hidden");
  $("scriptCard").scrollIntoView({ behavior: "smooth" });
};

// ---------- step 3: approve ----------
for (const id of ["enScript", "hiScript"]) $(id).addEventListener("input", () => {
  token = null;
  $("shareCard").classList.add("hidden");
  for (const c of ["c1", "c2", "c3"]) $(c).checked = false;
});
$("previewEn").onclick = () => speak($("enScript").value, "en", { onerror: (m) => ($("approveStatus").textContent = m) });
$("previewHi").onclick = () => speak($("hiScript").value, "hi", { onerror: (m) => ($("approveStatus").textContent = m) });
$("previewStop").onclick = stopSpeaking;

$("approveBtn").onclick = async () => {
  const status = $("approveStatus");
  const en = $("enScript").value.trim();
  const hi = $("hiScript").value.trim();
  if (!en || !hi) return (status.textContent = "Both scripts are needed.");
  if (!/[ऀ-ॿ]/.test(hi)) return (status.textContent = "The Hindi script must be in Devanagari.");
  if (!["c1", "c2", "c3"].every((c) => $(c).checked)) return (status.textContent = "Tick all three checks to approve.");
  status.textContent = "";
  try {
    const out = await api("/api/approve", { en, hi, approved: true, days: Number($("days").value) });
    token = out.token;
    const url = `${location.origin}/listen#${token}`;
    $("link").textContent = url;
    $("openLink").href = url;
    $("expiry").textContent = new Date(out.exp * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
    $("mp3Row").classList.toggle("hidden", !config.tts);
    $("shareCard").classList.remove("hidden");
    $("shareCard").scrollIntoView({ behavior: "smooth" });
  } catch (e) {
    status.textContent = e.message;
  }
};

// ---------- step 4: share ----------
const linkUrl = () => $("link").textContent;
$("copyBtn").onclick = async () => {
  try {
    await navigator.clipboard.writeText(linkUrl());
    $("shareStatus").textContent = "Link copied.";
  } catch {
    $("shareStatus").textContent = "Could not copy. Select the link and copy it by hand.";
  }
};
$("shareBtn").onclick = async () => {
  const text = "Listen to your prescription from the doctor / डॉक्टर की पर्ची सुनें:";
  if (navigator.share) {
    try { await navigator.share({ title: "Bolti Parchi", text, url: linkUrl() }); } catch {}
  } else {
    $("copyBtn").click();
  }
};

async function shareMp3(lang) {
  const status = $("shareStatus");
  status.textContent = "Making voice note…";
  try {
    const res = await api("/api/tts", { token, lang }, { raw: true });
    const blob = await res.blob();
    const name = lang === "hi" ? "parchi-hindi.wav" : "parchi-english.wav";
    const file = new File([blob], name, { type: "audio/wav" });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: "Bolti Parchi" });
    } else {
      const a = el("a", { href: URL.createObjectURL(blob), download: name });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    }
    status.textContent = "";
  } catch (e) {
    status.textContent = e.name === "AbortError" ? "" : e.message;
  }
}
$("mp3Hi").onclick = () => shareMp3("hi");
$("mp3En").onclick = () => shareMp3("en");

$("newRx").onclick = () => {
  data = null;
  token = null;
  img.el = null;
  img.crop = null;
  $("rxText").value = "";
  $("camera").value = "";
  $("gallery").value = "";
  $("editorWrap").classList.add("hidden");
  for (const id of ["reviewCard", "scriptCard", "shareCard"]) $(id).classList.add("hidden");
  $("readStatus").textContent = "";
  updateReadBtn();
  window.scrollTo({ top: 0, behavior: "smooth" });
};

init().catch((e) => { $("readStatus").textContent = e.message; $("app").classList.remove("hidden"); });
