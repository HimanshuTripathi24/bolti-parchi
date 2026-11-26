// Builds the plain-language English and Hindi patient scripts from the verified medicine table.
// Deterministic templates (no AI translation) so the doctor sees exactly what will be spoken.

const FORM = {
  tablet: ["tablet", "tablets", "गोली", "गोलियां"],
  capsule: ["capsule", "capsules", "कैप्सूल", "कैप्सूल"],
  syrup: ["syrup", "syrup", "सिरप", "सिरप"],
  suspension: ["suspension", "suspension", "सिरप", "सिरप"],
  drops: ["drop", "drops", "बूंद", "बूंदें"],
  injection: ["injection", "injections", "इंजेक्शन", "इंजेक्शन"],
  ointment: ["ointment", "ointment", "मलहम", "मलहम"],
  cream: ["cream", "cream", "क्रीम", "क्रीम"],
  gel: ["gel", "gel", "जेल", "जेल"],
  lotion: ["lotion", "lotion", "लोशन", "लोशन"],
  powder: ["powder", "powder", "पाउडर", "पाउडर"],
  sachet: ["sachet", "sachets", "पाउच", "पाउच"],
  inhaler: ["inhaler", "inhaler", "इनहेलर", "इनहेलर"],
  spray: ["spray", "spray", "स्प्रे", "स्प्रे"],
  suppository: ["suppository", "suppositories", "सपोसिटरी", "सपोसिटरी"],
  mouthwash: ["mouthwash", "mouthwash", "माउथवॉश", "माउथवॉश"],
  soap: ["soap", "soap", "साबुन", "साबुन"],
  other: ["medicine", "medicine", "दवा", "दवा"],
};
const APPLY = new Set(["ointment", "cream", "gel", "lotion"]);
const USE = new Set(["drops", "inhaler", "spray", "mouthwash", "soap", "suppository", "injection"]);
const LIQUID = new Set(["syrup", "suspension", "mouthwash"]);

const TIME_EN = { morning: "in the morning", afternoon: "in the afternoon", evening: "in the evening", night: "at night", bedtime: "at bedtime" };
const TIME_HI = { morning: "सुबह", afternoon: "दोपहर", evening: "शाम", night: "रात", bedtime: "सोते समय" };
const FOOD_EN = { before_food: "before food", after_food: "after food", with_food: "with food", empty_stomach: "on an empty stomach" };
const FOOD_HI = { before_food: "खाना खाने से पहले", after_food: "खाना खाने के बाद", with_food: "खाने के साथ", empty_stomach: "खाली पेट" };
const COUNT_EN = { 1: "once a day", 2: "twice a day" };
const COUNT_HI = { 1: "एक", 2: "दो", 3: "तीन", 4: "चार", 5: "पांच", 6: "छह" };
const ORDER = ["morning", "afternoon", "evening", "night", "bedtime"];

const joinEn = (a) => (a.length < 2 ? a.join("") : `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`);
const joinHi = (a) => (a.length < 2 ? a.join("") : `${a.slice(0, -1).join(", ")} और ${a[a.length - 1]}`);

function unitsHi(s) {
  return s
    .replace(/(\d)\s*mcg\b/gi, "$1 माइक्रोग्राम")
    .replace(/(\d)\s*mg\b/gi, "$1 मिलीग्राम")
    .replace(/(\d)\s*ml\b/gi, "$1 मिलीलीटर")
    .replace(/(\d)\s*g(m)?\b/gi, "$1 ग्राम")
    .replace(/(\d)\s*%/g, "$1 प्रतिशत")
    .replace(/(\d)\s*IU\b/gi, "$1 यूनिट");
}

const isHalf = (d) => /^(1\/2|½|0?\.5|half)$/i.test(d.trim());
const isQuarter = (d) => /^(1\/4|¼|0?\.25)$/i.test(d.trim());

function doseEn(m) {
  const d = (m.dose || "").trim();
  const [one, many] = FORM[m.form] || FORM.other;
  if (!d) return APPLY.has(m.form) ? "" : `the ${one}`;
  if (isHalf(d)) return `half a ${one}`;
  if (isQuarter(d)) return `a quarter of a ${one}`;
  if (/^\d+(\.\d+)?$/.test(d)) return `${d} ${Number(d) === 1 ? one : many}`;
  if (LIQUID.has(m.form) && /\d\s*ml\b/i.test(d)) return `${d} of ${one}`;
  return d;
}

function doseHi(m) {
  const d = (m.dose || "").trim();
  const [, , one, many] = FORM[m.form] || FORM.other;
  if (!d) return APPLY.has(m.form) ? "" : one;
  if (isHalf(d)) return `आधी ${one}`;
  if (isQuarter(d)) return `एक चौथाई ${one}`;
  if (/^\d+(\.\d+)?$/.test(d)) return `${d} ${Number(d) === 1 ? one : many}`;
  return unitsHi(d);
}

function durationEn(m) {
  const n = Number(m.duration_number) || 0;
  switch (m.duration_unit) {
    case "days": return n ? `for ${n} ${n === 1 ? "day" : "days"}` : "";
    case "weeks": return n ? `for ${n} ${n === 1 ? "week" : "weeks"}` : "";
    case "months": return n ? `for ${n} ${n === 1 ? "month" : "months"}` : "";
    case "until_finished": return "until the medicine is finished";
    case "continue": return "every day, until your doctor tells you to stop";
    default: return "";
  }
}

function durationHi(m) {
  const n = Number(m.duration_number) || 0;
  switch (m.duration_unit) {
    case "days": return n ? `${n} दिन तक` : "";
    case "weeks": return n ? `${n} हफ़्ते तक` : "";
    case "months": return n ? `${n} महीने तक` : "";
    case "until_finished": return "दवा खत्म होने तक";
    case "continue": return "रोज़, जब तक डॉक्टर बंद करने को न कहें";
    default: return "";
  }
}

function lineEn(m, i) {
  const [one] = FORM[m.form] || FORM.other;
  const head = [m.medicine_name, m.strength, one].filter(Boolean).join(" ");
  const verb = APPLY.has(m.form) ? "Apply" : USE.has(m.form) ? "Use" : "Take";
  const times = ORDER.filter((t) => (m.times_of_day || []).includes(t)).map((t) => TIME_EN[t]);
  const parts = [];
  const dose = doseEn(m);
  if (m.as_needed) {
    parts.push(`${verb}${dose ? " " + dose : ""} only when needed`);
  } else {
    const n = Number(m.times_per_day) || times.length;
    let first = `${verb}${dose ? " " + dose : ""}`;
    if (n) first += ` ${COUNT_EN[n] || `${n} times a day`}`;
    parts.push(first);
    if (times.length) parts.push(joinEn(times));
  }
  if (FOOD_EN[m.food]) parts.push(FOOD_EN[m.food]);
  const dur = durationEn(m);
  if (dur) parts.push(dur);
  let text = `Medicine ${i + 1}: ${head}.\n${parts.join(", ")}.`;
  if (m.other_instructions) text += ` ${m.other_instructions.trim().replace(/([^.!?])$/, "$1.")}`;
  return text;
}

function lineHi(m, i) {
  const [, , one] = FORM[m.form] || FORM.other;
  const name = (m.name_hindi || m.medicine_name || "").trim();
  const head = [name, unitsHi(m.strength || ""), one].filter(Boolean).join(" ");
  const verb = APPLY.has(m.form) ? "लगाएं" : m.form === "drops" ? "डालें" : USE.has(m.form) ? "इस्तेमाल करें" : "लें";
  const times = ORDER.filter((t) => (m.times_of_day || []).includes(t)).map((t) => TIME_HI[t]);
  const parts = [];
  if (m.as_needed) parts.push("ज़रूरत पड़ने पर ही");
  else {
    const n = Number(m.times_per_day) || times.length;
    if (n) parts.push(`दिन में ${COUNT_HI[n] || n} बार`);
    if (times.length) parts.push(`${joinHi(times)}${times[times.length - 1] === "रात" ? " को" : ""}`);
  }
  if (FOOD_HI[m.food]) parts.push(FOOD_HI[m.food]);
  const dur = durationHi(m);
  if (dur) parts.push(dur);
  const dose = doseHi(m);
  let text = `दवा ${i + 1}: ${head}।\n${[...parts, `${dose ? dose + " " : ""}${verb}`].join(", ")}।`;
  if (m.other_instructions_hindi) text += ` ${m.other_instructions_hindi.trim().replace(/([^।.!?])$/, "$1।")}`;
  return text;
}

export function buildScripts(data) {
  const meds = data.medicines || [];
  const n = meds.length;
  const en = [
    `Hello. These are your medicines, checked by your doctor. You have ${n} ${n === 1 ? "medicine" : "medicines"}.`,
    ...meds.map(lineEn),
  ];
  const hi = [
    `नमस्ते। ये आपकी दवाइयां हैं, जिन्हें आपके डॉक्टर ने जांचा है। आपको ${n} ${n === 1 ? "दवा" : "दवाइयां"} लेनी हैं।`,
    ...meds.map(lineHi),
  ];
  const adviceEn = (data.general_advice || []).filter((s) => s.trim());
  const adviceHi = (data.general_advice_hindi || []).filter((s) => s.trim());
  if (adviceEn.length) en.push(`Other advice: ${adviceEn.map((s) => s.trim().replace(/([^.!?])$/, "$1.")).join(" ")}`);
  if (adviceHi.length) hi.push(`दूसरी सलाह: ${adviceHi.map((s) => s.trim().replace(/([^।.!?])$/, "$1।")).join(" ")}`);
  if (data.follow_up?.trim()) {
    const f = data.follow_up.trim();
    en.push(/^(after|in|on|next)\b/i.test(f) ? `Come back to see the doctor ${f}.` : `Next check-up: ${f}.`);
  }
  if (data.follow_up_hindi?.trim()) hi.push(`${data.follow_up_hindi.trim()} दोबारा दिखाने आएं।`);
  en.push("If you have any doubt, ask your doctor or pharmacist. Do not stop or change any medicine on your own.");
  hi.push("कोई भी शक हो तो अपने डॉक्टर या दवा वाले से पूछें। अपने मन से कोई दवा बंद न करें और न बदलें।");
  return { en: en.join("\n\n"), hi: hi.join("\n\n") };
}
