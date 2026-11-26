// Doctor sign-in, sessions, brute-force protection and client IPs.
//
// The clinic password is checked once, at sign-in. The browser then gets a signed session token
// (valid 12 hours) and never stores or re-sends the password. Changing APP_PASSWORD or LINK_SECRET
// signs everyone out.
import crypto from "node:crypto";

const APP_PASSWORD = process.env.APP_PASSWORD || "";
const LINK_SECRET = process.env.LINK_SECRET || "";
const SESSION_HOURS = 12;

/** Running on a real host (not a developer's laptop): never fail open there. */
export const PRODUCTION = Boolean(process.env.VERCEL || process.env.RENDER || process.env.NODE_ENV === "production");

/** Why the doctor side can't run safely, or "" if it can. */
export function setupProblem() {
  if (!PRODUCTION) return "";
  if (APP_PASSWORD.length < 10) return "APP_PASSWORD is missing or shorter than 10 characters.";
  if (LINK_SECRET.length < 32) return "LINK_SECRET is missing or shorter than 32 characters.";
  return "";
}
export const passwordRequired = () => PRODUCTION || Boolean(APP_PASSWORD);

const sha = (s) => crypto.createHash("sha256").update(s).digest();
// Session key depends on both secrets, so rotating either one invalidates old sessions.
const sessionKey = sha(`bolti-session|${LINK_SECRET}|${sha(APP_PASSWORD).toString("hex")}`);
const sign = (data) => crypto.createHmac("sha256", sessionKey).update(data).digest("base64url");

/** Constant-time password check (hashing first hides the password's length). */
export function passwordMatches(given) {
  if (!APP_PASSWORD) return !PRODUCTION;
  return crypto.timingSafeEqual(sha(String(given ?? "")), sha(APP_PASSWORD));
}

export function makeSession() {
  const exp = Math.floor(Date.now() / 1000) + SESSION_HOURS * 3600;
  const data = `v1.${exp}`;
  return { session: `${data}.${sign(data)}`, exp };
}

/** True if the request carries a valid, unexpired session (or no password is configured locally). */
export function sessionOk(req) {
  if (!passwordRequired()) return true;
  const m = /^Bearer\s+(v1\.(\d+))\.([\w-]+)$/.exec(String(req.headers.authorization || ""));
  if (!m) return false;
  const expected = Buffer.from(sign(m[1]));
  const given = Buffer.from(m[3]);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return false;
  return Number(m[2]) > Date.now() / 1000;
}

// ---- brute-force protection: too many wrong passwords from one address locks it out for a while ----
const MAX_FAILS = 8;
const WINDOW_MS = 15 * 60_000;
const fails = new Map(); // ip -> [timestamps]

export function lockedOut(ip) {
  const now = Date.now();
  const list = (fails.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  fails.set(ip, list);
  return list.length >= MAX_FAILS;
}
export function recordFail(ip) {
  const list = fails.get(ip) || [];
  list.push(Date.now());
  fails.set(ip, list);
}
setInterval(() => fails.clear(), 60 * 60_000).unref();

/**
 * The visitor's real address, for rate limits. Only trusts headers that the hosting platform sets
 * itself; a plain X-Forwarded-For can be faked by anyone.
 */
export function clientIp(req) {
  if (process.env.VERCEL) return String(req.headers["x-real-ip"] || req.headers["x-vercel-forwarded-for"] || "unknown");
  if (process.env.RENDER || process.env.TRUST_PROXY) {
    const xff = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1]; // the hop added by the platform's own proxy
  }
  return req.socket?.remoteAddress || "unknown";
}
