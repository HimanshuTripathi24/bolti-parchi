// Input and output validation. Everything that comes from a browser or from the AI passes through here.
//
// There is no database, so there is no SQL to inject into. The real injection risks here are:
// script injection into the page, files that pretend to be images, instructions hidden in a
// prescription (prompt injection), oversized or oddly shaped requests, and log tampering.
import { UserFacingError } from "./errors.js";

// Control characters (except tab/newline) and invisible text-direction overrides, which can make
// text display differently from what it really says ("Trojan Source"). Joiners used by Devanagari
// (U+200C, U+200D) are kept.
const UNSAFE_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩﻿]/g;

/** Cleans one piece of text: Unicode-normalised, unsafe characters removed, trimmed, length-capped. */
export function cleanString(value, max) {
  if (typeof value !== "string") return "";
  return value.normalize("NFC").replace(UNSAFE_CHARS, "").replace(/\r\n?/g, "\n").trim().slice(0, max);
}

/** For log lines: one line, no control characters, short. Stops anyone forging fake log entries. */
export const logSafe = (value, max = 200) => String(value ?? "").replace(/[\u0000-\u001F\u007F]+/g, " ").slice(0, max);

/** POST bodies must be JSON. Rejects HTML-form posts and other content types. */
export function requireJson(req) {
  const type = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") throw new UserFacingError("Requests must be sent as JSON.");
}

/**
 * Checks a request body against a small schema and returns only the known fields.
 * spec: { field: { type: "string"|"boolean"|"number", max?, min?, required?, oneOf? } }
 * Unknown fields are rejected, so nothing unexpected (like "__proto__") ever reaches the code.
 */
export function validateBody(body, spec) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new UserFacingError("Bad request.");
  for (const key of Object.keys(body)) {
    if (!Object.hasOwn(spec, key)) throw new UserFacingError("Bad request.");
  }
  const out = {};
  for (const [key, rule] of Object.entries(spec)) {
    const v = body[key];
    if (v === undefined || v === null || v === "") {
      if (rule.required) throw new UserFacingError("Bad request.");
      continue;
    }
    if (typeof v !== rule.type) throw new UserFacingError("Bad request.");
    if (rule.type === "string") {
      if (rule.max && v.length > rule.max) throw new UserFacingError("That's too long.");
      out[key] = rule.raw ? v : cleanString(v, rule.max || 10_000);
    } else if (rule.type === "number") {
      if (!Number.isFinite(v) || (rule.min !== undefined && v < rule.min) || (rule.max !== undefined && v > rule.max)) throw new UserFacingError("Bad request.");
      out[key] = v;
    } else {
      out[key] = v;
    }
    if (rule.oneOf && !rule.oneOf.includes(out[key])) throw new UserFacingError("Bad request.");
  }
  return out;
}

// ---- images: the bytes must really be the image type they claim to be ----
const MAGIC = {
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/png": (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/gif": (b) => b.subarray(0, 4).toString("latin1") === "GIF8",
  "image/webp": (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
};
export const IMAGE_TYPES = Object.keys(MAGIC);
export const MAX_IMAGE_B64 = 4_600_000; // about 3.4 MB of image; the page resizes photos well below this

export function checkImage(b64, mediaType) {
  if (!MAGIC[mediaType]) throw new UserFacingError("Please upload a JPEG, PNG, WebP or GIF image.");
  if (b64.length > MAX_IMAGE_B64) throw new UserFacingError("The photo is too large. Try cropping it.");
  if (b64.length < 100 || b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new UserFacingError("The photo couldn't be read. Please try again.");
  const head = Buffer.from(b64.slice(0, 24), "base64");
  if (!MAGIC[mediaType](head)) throw new UserFacingError("That file isn't a real image. Please take or choose a photo.");
}

// ---- AI output: rebuild it from the expected shape, so nothing unexpected reaches the doctor's page ----
const FORMS = ["tablet", "capsule", "syrup", "suspension", "drops", "injection", "ointment", "cream", "gel", "lotion", "powder", "sachet", "inhaler", "spray", "suppository", "mouthwash", "soap", "other"];
const TIMES = ["morning", "afternoon", "evening", "night", "bedtime"];
const FOOD = ["before_food", "after_food", "with_food", "empty_stomach", "not_specified"];
const UNITS = ["days", "weeks", "months", "until_finished", "continue", "not_specified"];
const CONF = ["high", "medium", "low"];

const pick = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);
const int = (v, max) => (Number.isInteger(v) && v >= 0 && v <= max ? v : 0);
const str = (v, max) => cleanString(v, max);
const strList = (v, maxItems, maxLen) => (Array.isArray(v) ? v.slice(0, maxItems).map((s) => str(s, maxLen)).filter(Boolean) : []);

export function sanitizeExtraction(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const meds = Array.isArray(r.medicines) ? r.medicines.slice(0, 30) : [];
  return {
    is_prescription: r.is_prescription !== false,
    transcription: str(r.transcription, 4000),
    medicines: meds.filter((m) => m && typeof m === "object").map((m) => ({
      as_written: str(m.as_written, 300),
      medicine_name: str(m.medicine_name, 120),
      name_hindi: str(m.name_hindi, 120),
      strength: str(m.strength, 60),
      form: pick(m.form, FORMS, "other"),
      dose: str(m.dose, 60),
      frequency_as_written: str(m.frequency_as_written, 60),
      times_per_day: int(m.times_per_day, 12),
      times_of_day: Array.isArray(m.times_of_day) ? [...new Set(m.times_of_day.filter((t) => TIMES.includes(t)))] : [],
      as_needed: m.as_needed === true,
      food: pick(m.food, FOOD, "not_specified"),
      duration_number: int(m.duration_number, 365),
      duration_unit: pick(m.duration_unit, UNITS, "not_specified"),
      other_instructions: str(m.other_instructions, 400),
      other_instructions_hindi: str(m.other_instructions_hindi, 400),
      confidence: pick(m.confidence, CONF, "low"),
      doubts: str(m.doubts, 400),
    })),
    general_advice: strList(r.general_advice, 15, 300),
    general_advice_hindi: strList(r.general_advice_hindi, 15, 300),
    follow_up: str(r.follow_up, 120),
    follow_up_hindi: str(r.follow_up_hindi, 120),
    unreadable_parts: str(r.unreadable_parts, 400),
  };
}
