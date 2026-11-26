import { buildScripts } from "./scripts.js";
import { speak, stopSpeaking, hasVoiceFor } from "./speak.js";

const $ = (id) => document.getElementById(id);
const MAX_EDGE = 2576; // long edge sent to Gemini; enough detail for handwriting
const MAX_B64 = 3.3 * 1024 * 1024; // keeps each upload under Vercel's 4.5 MB request limit

const FORMS = ["tablet", "capsule", "syrup", "suspension", "drops", "injection", "ointment", "cream", "gel", "lotion", "powder", "sachet", "inhaler", "spray", "suppository", "mouthwash", "soap", "other"];
const TIMES = [["morning", "Morning"], ["afternoon", "Afternoon"], ["evening", "Evening"], ["night", "Night"], ["bedtime", "Bedtime"]];
const FOOD = [["not_specified", "Not specified"], ["before_food", "Before food"], ["after_food", "After food"], ["with_food", "With food"], ["empty_stomach", "Empty stomach"]];
const UNITS = [["days", "days"], ["weeks", "weeks"], ["months", "months"], ["until_finished", "until finished"], ["continue", "continue (no end)"], ["not_specified", "not specified"]];

let config = {};
// A signed 12-hour session from the server. The clinic password itself is never stored in the browser.
let session = sessionStorage.getItem("bp-session") || "";
sessionStorage.removeItem("bp-pw"); // clean up what older versions stored
let mode = "photo";
let data = null; // extraction result being edited
let token = null;

// ---------- server calls ----------
async function api(path, body, { raw = false } = {}) {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", ...(session ? { Authorization: `Bearer ${session}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && path !== "/api/login") {
    session = "";
    sessionStorage.removeItem("bp-session");
    showLogin("Your session ended. Please sign in again.");
    throw new Error("Wrong password.");
  }
  if (!res.ok) {
    let msg = `Error ${res.status}`;
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  return raw ? res : res.json();
}

/** Marks the step rail: earlier steps done, this one current. */
function setStep(n) {
  for (const li of $("rail").children) {
    const k = Number(li.dataset.step);
    li.classList.toggle("done", k < n);
    if (k === n) li.setAttribute("aria-current", "step");
    else li.removeAttribute("aria-current");
  }
}

$("signOut").onclick = () => {
  sessionStorage.removeItem("bp-session");
  location.reload();
};

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
  if (config.setupError) return showLogin("This site isn't set up securely yet, so sign-in is switched off. Ask the administrator.");
  if (config.passwordRequired && !session) return showLogin();
  if (config.passwordRequired) {
    try { await api("/api/session"); } catch { return; }
    $("signOut").classList.remove("hidden");
  }
  $("app").classList.remove("hidden");
}

$("loginBtn").onclick = async () => {
  try {
    const out = await api("/api/login", { password: $("pw").value });
    $("pw").value = "";
    session = out.session;
    sessionStorage.setItem("bp-session", session);
    $("signOut").classList.remove("hidden");
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
  $("tabPhoto").setAttribute("aria-selected", String(m === "photo"));
  $("tabText").setAttribute("aria-selected", String(m === "text"));
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
  const spin = document.createElement("span");
  spin.className = "spinner";
  btn.replaceChildren(spin, " Reading the handwriting… usually 10–30 seconds");
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
    btn.textContent = "Read prescription";
    updateReadBtn();
  }
};

/** After reading, fold the scan step down to one line so the doctor's attention moves to checking. */
function foldScan(refUrl) {
  $("scanInputs").classList.add("hidden");
  $("scanLead").classList.add("hidden");
  $("scannedRow").classList.remove("hidden");
  $("scannedThumb").classList.toggle("hidden", !refUrl);
  if (refUrl) $("scannedThumb").src = refUrl;
  const n = data.medicines.length;
  $("scannedText").textContent = `Prescription read: ${n} ${n === 1 ? "medicine" : "medicines"} found.`;
}
function unfoldScan() {
  $("scanInputs").classList.remove("hidden");
  $("scanLead").classList.remove("hidden");
  $("scannedRow").classList.add("hidden");
}
$("rescan").onclick = () => $("newRx").click();

// ---------- step 2: review ----------
function showReview(refUrl, typedText) {
  for (const m of data.medicines) m._checked = false;
  $("refImg").classList.toggle("hidden", !refUrl);
  if (refUrl) $("refImg").src = refUrl;
  $("transcription").textContent = typedText ?? data.transcription ?? "";
  $("readBy").textContent = data.model ? `Read by ${data.model}` : data.demo ? "Sample data (demo mode)" : "";
  $("notRx").classList.toggle("hidden", data.is_prescription !== false);
  $("unreadable").classList.toggle("hidden", !data.unreadable_parts);
  $("unreadable").textContent = data.unreadable_parts ? `Could not read: ${data.unreadable_parts}` : "";
  $("advice").value = (data.general_advice || []).join("\n");
  $("adviceHi").value = (data.general_advice_hindi || []).join("\n");
  $("followUp").value = data.follow_up || "";
  $("followUpHi").value = data.follow_up_hindi || "";
  renderMeds();
  foldScan(refUrl);
  setStep(2);
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
    $("reviewStatus").textContent = "You changed a medicine. Press “Prepare patient message” again.";
    setStep(2);
  }
}

function bindText(m, key, attrs = {}) {
  return el("input", { type: "text", value: m[key] ?? "", ...attrs, oninput: (e) => { m[key] = e.target.value; changed(m); } });
}
function bindSelect(m, key, options) {
  return el("select", { onchange: (e) => { m[key] = e.target.value; changed(m); } },
    options.map(([v, t]) => el("option", { value: v, selected: m[key] === v }, t)));
}
function bindNumber(m, key, attrs = {}) {
  return el("input", { type: "number", min: 0, value: m[key] ?? 0, ...attrs, oninput: (e) => { m[key] = Number(e.target.value) || 0; changed(m); } });
}

/** Plain reading of one medicine, e.g. "1 tablet, twice a day (morning, night), after food, for 5 days". */
function plainReading(m) {
  const parts = [];
  const form = m.form && m.form !== "other" ? m.form : "";
  const dose = (m.dose || "").trim();
  if (dose) parts.push(/^(\d+(\.\d+)?|1\/2|½)$/.test(dose) && form ? `${dose} ${form}` : dose);
  const times = ["morning", "afternoon", "evening", "night", "bedtime"].filter((t) => (m.times_of_day || []).includes(t));
  if (m.as_needed) parts.push("only when needed");
  else {
    const n = Number(m.times_per_day) || times.length;
    const how = n === 1 ? "once a day" : n === 2 ? "twice a day" : n ? `${n} times a day` : "";
    if (how || times.length) parts.push(`${how}${times.length ? `${how ? " " : ""}(${times.join(", ")})` : ""}`);
  }
  const food = { before_food: "before food", after_food: "after food", with_food: "with food", empty_stomach: "on an empty stomach" }[m.food];
  if (food) parts.push(food);
  const n = Number(m.duration_number) || 0;
  const s = n > 1 ? "s" : "";
  const dur = { days: n && `for ${n} day${s}`, weeks: n && `for ${n} week${s}`, months: n && `for ${n} month${s}`, until_finished: "until finished", continue: "continue until told to stop" }[m.duration_unit];
  if (dur) parts.push(dur);
  return parts.join(", ");
}

const metaText = (m) => [m.strength, m.form !== "other" ? m.form : ""].filter(Boolean).join(" ");
const MISSING = "How to take it is missing. Use Edit to add it.";

/** Plays one medicine name exactly as the patient's Hindi voice will say it. */
let nameAudioEl;
async function hearName(m) {
  const name = (m.name_hindi || "").trim();
  const status = $("reviewStatus");
  if (!name) return (status.textContent = `Add how “${m.medicine_name || "this medicine"}” sounds in Hindi first (Edit → Name as spoken in Hindi).`);
  try {
    status.textContent = "";
    const res = await api("/api/preview-voice", { text: name, lang: "hi", name: true }, { raw: true });
    const url = URL.createObjectURL(await res.blob());
    nameAudioEl?.pause();
    nameAudioEl = new Audio(url);
    await nameAudioEl.play();
  } catch (e) {
    if (e.message !== "Wrong password.") status.textContent = e.message;
  }
}

/** After an edit: untick the line and refresh its summary, keeping the edit panel open. */
function changed(m) {
  m._checked = false;
  const li = m._li;
  if (li) {
    li.querySelector(".tick").checked = false;
    li.querySelector(".med-name").textContent = m.medicine_name || "Unnamed medicine";
    li.querySelector(".med-meta").textContent = metaText(m);
    const plain = plainReading(m);
    const p = li.querySelector(".med-plain");
    p.textContent = plain || MISSING;
    p.classList.toggle("empty", !plain);
  }
  onTableChange();
}

function renderMeds() {
  const box = $("meds");
  box.replaceChildren();
  data.medicines.forEach((m, i) => {
    const conf = m.confidence || "high";
    const tickId = `tick${++uid}`;
    const plain = plainReading(m);
    const times = el("div", { class: "times" }, TIMES.map(([v, t]) =>
      el("label", { class: "chip" }, el("input", { type: "checkbox", checked: (m.times_of_day || []).includes(v), onchange: (e) => {
        const set = new Set(m.times_of_day || []);
        e.target.checked ? set.add(v) : set.delete(v);
        m.times_of_day = [...set];
        changed(m);
      } }), t)));
    const remove = () => {
      if (!confirm("Remove this medicine?")) return;
      data.medicines.splice(i, 1);
      renderMeds();
      onTableChange();
    };
    const li = el("li", { class: `med ${conf}` },
      el("input", { class: "tick", type: "checkbox", id: tickId, checked: !!m._checked, "aria-label": `Checked medicine ${i + 1}`,
        onchange: (e) => { m._checked = e.target.checked; onTableChange(); } }),
      el("div", {},
        el("div", { class: "med-title" },
          el("label", { class: "med-name", for: tickId }, m.medicine_name || "Unnamed medicine"),
          config.nameCheck ? el("button", { class: "say", type: "button", title: "Hear how the patient's voice says this name", "aria-label": `Hear how ${m.medicine_name || "this medicine"} is pronounced`, onclick: () => hearName(m) }, "🔊") : null,
          el("span", { class: "med-meta" }, metaText(m)),
          conf === "medium" ? el("span", { class: "flag medium" }, "Check this") : conf === "low" ? el("span", { class: "flag low" }, "AI unsure") : null),
        el("p", { class: `med-plain${plain ? "" : " empty"}` }, plain || MISSING),
        m.as_written ? el("p", { class: "written" }, `Written as “${m.as_written}”`) : null,
        m.doubts ? el("p", { class: "doubt" }, m.doubts) : null),
      el("details", { class: "med-edit" },
        el("summary", {}, "Edit"),
        el("div", { class: "fields" },
          el("div", { class: "wide" }, field("Medicine name", bindText(m, "medicine_name"))),
          el("div", { class: "wide name-say" },
            field("Name as spoken in Hindi (spell it the way it sounds)", bindText(m, "name_hindi", { lang: "hi" })),
            config.nameCheck ? el("button", { class: "small", type: "button", "aria-label": "Hear how this name is spoken", onclick: () => hearName(m) }, "▶ Hear name") : null),
          field("Strength", bindText(m, "strength", { placeholder: "500 mg" })),
          field("Form", bindSelect(m, "form", FORMS.map((f) => [f, f]))),
          field("Dose each time", bindText(m, "dose", { placeholder: "1, 1/2, 5 ml" })),
          field("Times a day", bindNumber(m, "times_per_day", { max: 12 })),
          el("div", { class: "full" }, el("label", {}, "When in the day"), times),
          field("Food", bindSelect(m, "food", FOOD)),
          el("div", {}, el("label", {}, "Only if needed"),
            el("label", { class: "chip" }, el("input", { type: "checkbox", checked: !!m.as_needed, onchange: (e) => { m.as_needed = e.target.checked; changed(m); } }), "SOS")),
          field("For how long", bindNumber(m, "duration_number")),
          field("Unit", bindSelect(m, "duration_unit", UNITS)),
          el("div", { class: "wide" }, field("Other instructions", bindText(m, "other_instructions"))),
          el("div", { class: "wide" }, field("अन्य निर्देश", bindText(m, "other_instructions_hindi", { lang: "hi" }))),
          el("div", { class: "full" }, el("button", { class: "small danger", type: "button", onclick: remove }, "Remove this medicine")))));
    m._li = li;
    box.append(li);
  });
}

$("addMed").onclick = () => {
  data.medicines.push({ as_written: "", medicine_name: "", name_hindi: "", strength: "", form: "tablet", dose: "1", frequency_as_written: "", times_per_day: 0, times_of_day: [], as_needed: false, food: "not_specified", duration_number: 0, duration_unit: "days", other_instructions: "", other_instructions_hindi: "", confidence: "high", doubts: "", _checked: false });
  renderMeds();
  onTableChange();
  const last = $("meds").lastElementChild?.querySelector("details");
  if (last) { last.open = true; last.querySelector("input")?.focus(); }
};
for (const id of ["advice", "adviceHi", "followUp", "followUpHi"]) $(id).addEventListener("input", onTableChange);

$("makeScripts").onclick = () => {
  const status = $("reviewStatus");
  if (!data.medicines.length) return (status.textContent = "Add at least one medicine.");
  const unnamed = data.medicines.findIndex((m) => !m.medicine_name.trim());
  if (unnamed >= 0) return (status.textContent = `Medicine ${unnamed + 1} has no name.`);
  const unchecked = data.medicines.findIndex((m) => !m._checked);
  if (unchecked >= 0) return (status.textContent = `Tick medicine ${unchecked + 1} once you’ve checked it against the slip.`);
  const noHindi = data.medicines.findIndex((m) => !/[ऀ-ॿ]/.test(m.name_hindi || ""));
  if (noHindi >= 0) return (status.textContent = `Medicine ${noHindi + 1}: add how its name sounds in Hindi (Edit → Name as spoken in Hindi), so the voice says it correctly.`);
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
  $("stamp").classList.add("hidden");
  resetApprove();
  setStep(3);
  $("scriptCard").classList.remove("hidden");
  $("shareCard").classList.add("hidden");
  $("scriptCard").scrollIntoView({ behavior: "smooth" });
};

// ---------- step 3: approve ----------
function resetApprove() {
  $("approveBtn").disabled = false;
  $("approveBtn").textContent = "Approve and create link";
}
for (const c of ["c1", "c2", "c3"]) $(c).addEventListener("change", () => { if (!token) resetApprove(); });
for (const id of ["enScript", "hiScript"]) $(id).addEventListener("input", () => {
  token = null;
  resetApprove();
  $("shareCard").classList.add("hidden");
  $("stamp").classList.add("hidden");
  setStep(3);
  for (const c of ["c1", "c2", "c3"]) $(c).checked = false;
});
// Preview with the natural voice the patient will hear; fall back to this device's own voice.
const previewUrls = {};
async function preview(lang) {
  const text = $(lang === "hi" ? "hiScript" : "enScript").value.trim();
  const status = $("approveStatus");
  const a = $("previewAudio");
  stopPreview();
  if (!text) return;
  if (config.tts) {
    const key = `${lang}
${text}`;
    try {
      if (!previewUrls[key]) {
        status.textContent = lang === "hi" ? "हिन्दी आवाज़ तैयार हो रही है…" : "Preparing the voice…";
        const res = await api("/api/preview-voice", { text, lang }, { raw: true });
        previewUrls[key] = URL.createObjectURL(await res.blob());
      }
      status.textContent = "";
      a.src = previewUrls[key];
      a.classList.remove("hidden");
      await a.play();
      return;
    } catch (e) {
      if (e.message === "Wrong password.") return;
      status.textContent = "";
      if (!(await hasVoiceFor(lang))) {
        status.textContent = "The natural voice isn't available right now (Gemini's free voice limit is about 10 voice notes per model per day). You can still approve; the patient's page will offer the voice again later. Turning on Gemini billing removes this limit.";
        return;
      }
      status.textContent = "Natural voice unavailable right now, so this computer's voice is reading it.";
    }
  }
  speak(text, lang, { onerror: (m) => (status.textContent = m) });
}
function stopPreview() {
  stopSpeaking();
  $("previewAudio").pause();
}
$("previewEn").onclick = () => preview("en");
$("previewHi").onclick = () => preview("hi");
$("previewStop").onclick = stopPreview;

$("approveBtn").onclick = async () => {
  const status = $("approveStatus");
  const en = $("enScript").value.trim();
  const hi = $("hiScript").value.trim();
  if (!en || !hi) return (status.textContent = "Both scripts are needed.");
  if (!/[ऀ-ॿ]/.test(hi)) return (status.textContent = "The Hindi script must be in Devanagari.");
  if (!["c1", "c2", "c3"].every((c) => $(c).checked)) return (status.textContent = "Tick all three checks to approve.");
  status.textContent = "";
  try {
    const out = await api("/api/approve", { en, hi, approved: true, days: Math.min(90, Math.max(1, Math.round(Number($("days").value)) || 30)) });
    token = out.token;
    const url = `${location.origin}/listen#${token}`;
    $("link").textContent = url;
    $("openLink").href = url;
    $("expiry").textContent = new Date(out.exp * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
    $("mp3Row").classList.toggle("hidden", !config.tts);
    $("approveBtn").disabled = true;
    $("approveBtn").textContent = "Approved";
    // The doctor's stamp lands on the slip.
    const stamp = $("stamp");
    $("stampDate").textContent = new Date().toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
    stamp.classList.remove("hidden", "thump");
    void stamp.offsetWidth; // restart the animation
    stamp.classList.add("thump");
    setStep(4);
    $("shareCard").classList.remove("hidden");
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    setTimeout(() => $("shareCard").scrollIntoView({ behavior: reduce ? "auto" : "smooth" }), reduce ? 0 : 900);
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
  for (const id of ["reviewCard", "scriptCard", "shareCard", "stamp"]) $(id).classList.add("hidden");
  unfoldScan();
  resetApprove();
  setStep(1);
  $("readStatus").textContent = "";
  updateReadBtn();
  window.scrollTo({ top: 0, behavior: "smooth" });
};

init().catch((e) => { $("readStatus").textContent = e.message; $("app").classList.remove("hidden"); });
