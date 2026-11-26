import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { extractPrescription, demoResult, hasApiKey, GeminiError } from "./extract.js";
import { UserFacingError } from "./errors.js";
import { validateBody, requireJson, checkImage, logSafe, IMAGE_TYPES } from "./validate.js";
import { makeToken, readToken } from "./tokens.js";
import { hasTts, getAudio } from "./tts.js";
import { setupProblem, passwordRequired, passwordMatches, makeSession, sessionOk, lockedOut, recordFail, clientIp, PRODUCTION } from "./auth.js";

const LINK_DAYS = Number(process.env.LINK_DAYS) || 30;
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const MAX_BODY = 12 * 1024 * 1024; // photos are resized in the browser, so this is generous

if (setupProblem()) console.error(`[security] Doctor features are switched off: ${setupProblem()}`);
else if (!passwordRequired()) console.warn("[warn] APP_PASSWORD is not set. Fine on your own computer; required when deployed.");
if (!hasApiKey()) console.warn("[warn] GEMINI_API_KEY is not set. The scanner runs in DEMO mode with a sample prescription.");

const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'; require-trusted-types-for 'script'; trusted-types 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Permissions-Policy": "camera=(self), microphone=(), geolocation=()",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Robots-Tag": "noindex, nofollow",
  ...(PRODUCTION ? { "Strict-Transport-Security": "max-age=63072000; includeSubDomains" } : {}),
};

// --- tiny per-IP rate limiter (in memory) ---
const hits = new Map();
function rateLimited(ip, bucket, limit, windowMs) {
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(key, list);
  return list.length > limit;
}
setInterval(() => hits.clear(), 60 * 60 * 1000).unref();

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "Cache-Control": "no-store",
    "Content-Type": isBuf ? "application/octet-stream" : "application/json; charset=utf-8",
    ...headers,
  });
  res.end(isBuf ? body : JSON.stringify(body));
}

// Request shapes. Any field not listed here is rejected.
const BODY = {
  login: { password: { type: "string", max: 200, raw: true } },
  extract: { text: { type: "string", max: 8000 }, imageBase64: { type: "string", max: 5_000_000, raw: true }, mediaType: { type: "string", max: 20, oneOf: IMAGE_TYPES } },
  approve: { en: { type: "string", max: 6000, required: true }, hi: { type: "string", max: 6000, required: true }, approved: { type: "boolean", required: true }, days: { type: "number", min: 1, max: 90 } },
  preview: { text: { type: "string", max: 6000, required: true }, lang: { type: "string", max: 2, required: true, oneOf: ["en", "hi"] } },
  open: { token: { type: "string", max: 20_000, required: true, raw: true } },
  tts: { token: { type: "string", max: 20_000, required: true, raw: true }, lang: { type: "string", max: 2, required: true, oneOf: ["en", "hi"] } },
};
const readBody = async (req, kind) => validateBody(await readJson(req), BODY[kind]);

function readJson(req) {
  requireJson(req);
  // On Vercel the platform has already read and parsed the body (and limits it to 4.5 MB).
  if (process.env.VERCEL) {
    const b = req.body;
    if (b && typeof b === "object" && !Buffer.isBuffer(b)) return Promise.resolve(b);
    try {
      return Promise.resolve(JSON.parse(Buffer.isBuffer(b) ? b.toString("utf8") : b || "{}"));
    } catch {
      return Promise.reject(new UserFacingError("Bad request."));
    }
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new UserFacingError("The upload is too large."));
        req.destroy();
      } else parts.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(parts).toString("utf8") || "{}"));
      } catch {
        reject(new UserFacingError("Bad request."));
      }
    });
    req.on("error", reject);
  });
}

/** Gate for doctor-only actions. Returns an error response, or null if the request may go ahead. */
function doctorGuard(req, ip) {
  const problem = setupProblem();
  if (problem) return [503, { error: "Doctor features are switched off until the server is set up securely. Ask the administrator." }];
  if (lockedOut(ip)) return [429, { error: "Too many wrong passwords. Try again in 15 minutes." }];
  if (!sessionOk(req)) return [401, { error: "Please sign in again." }];
  return null;
}


// --- API handlers ---
const api = {
  "GET /api/config": async () => ({ passwordRequired: passwordRequired(), setupError: Boolean(setupProblem()), demo: !hasApiKey(), tts: hasTts(), linkDays: LINK_DAYS }),

  // Swaps the clinic password for a 12-hour session token.
  "POST /api/login": async (req, ip) => {
    if (setupProblem()) return [503, { error: "This site isn't set up securely yet. Ask the administrator." }];
    if (lockedOut(ip)) return [429, { error: "Too many wrong passwords. Try again in 15 minutes." }];
    const body = await readBody(req, "login");
    if (!passwordMatches(body.password)) {
      recordFail(ip);
      return [401, { error: "Wrong password." }];
    }
    return makeSession();
  },

  // Lets the page check a stored session without sending the password again.
  "GET /api/session": async (req, ip) => doctorGuard(req, ip) || { ok: true },

  "POST /api/extract": async (req, ip) => {
    const denied = doctorGuard(req, ip);
    if (denied) return denied;
    if (rateLimited(ip, "extract", 40, 60 * 60 * 1000)) return [429, { error: "Too many scans this hour. Please wait a bit." }];
    const body = await readBody(req, "extract");
    const text = body.text || "";
    const imageBase64 = body.imageBase64 || "";
    if (imageBase64 && text) return [400, { error: "Send either a photo or text, not both." }];
    if (!imageBase64 && !text) return [400, { error: "Send a photo or the prescription text." }];
    if (imageBase64) checkImage(imageBase64, body.mediaType);
    if (!hasApiKey()) return demoResult();
    return extractPrescription(imageBase64 ? { imageBase64, mediaType: body.mediaType } : { text });
  },

  "POST /api/approve": async (req, ip) => {
    const denied = doctorGuard(req, ip);
    if (denied) return denied;
    if (rateLimited(ip, "approve", 200, 60 * 60 * 1000)) return [429, { error: "Too many requests." }];
    const body = await readBody(req, "approve");
    const { en, hi } = body;
    if (!/[ऀ-ॿ]/.test(hi)) return [400, { error: "The Hindi script must be in Devanagari." }];
    if (body.approved !== true) return [400, { error: "Doctor approval is required." }];
    const days = Math.min(Math.max(Number(body.days) || LINK_DAYS, 1), 90);
    const out = makeToken({ en, hi, days });
    if (hasTts()) {
      // Start making both voices now, so they are ready when the doctor or patient presses play.
      getAudio(hi, "hi").catch(() => {});
      getAudio(en, "en").catch(() => {});
    }
    return out;
  },

  // Doctor hears the natural voice before approving (same voice the patient will get).
  "POST /api/preview-voice": async (req, ip) => {
    const denied = doctorGuard(req, ip);
    if (denied) return denied;
    if (!hasTts()) return [404, { error: "Natural voice is not set up on this server." }];
    if (rateLimited(ip, "preview", 60, 60 * 60 * 1000)) return [429, { error: "Too many voice previews this hour." }];
    const { text, lang } = await readBody(req, "preview");
    const wav = await getAudio(text, lang);
    return [200, wav, { "Content-Type": "audio/wav" }];
  },

  "POST /api/open": async (req, ip) => {
    if (rateLimited(ip, "open", 300, 60 * 60 * 1000)) return [429, { error: "Too many requests." }];
    const body = await readBody(req, "open");
    try {
      const p = readToken(body.token);
      return { en: p.en, hi: p.hi, iat: p.iat, exp: p.exp, tts: hasTts() };
    } catch (err) {
      return [400, { error: err.message }];
    }
  },

  "POST /api/tts": async (req, ip) => {
    if (!hasTts()) return [404, { error: "Natural voice is not set up on this server." }];
    if (rateLimited(ip, "tts", 60, 60 * 60 * 1000)) return [429, { error: "Too many requests." }];
    const body = await readBody(req, "tts");
    let p;
    try {
      p = readToken(body.token);
    } catch (err) {
      return [400, { error: err.message }];
    }
    const lang = body.lang;
    const wav = await getAudio(p[lang], lang);
    return [200, wav, { "Content-Type": "audio/wav" }];
  },
};

// --- static files ---
const TYPES = { ".woff2": "font/woff2", ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };
const ROUTES = { "/": "index.html", "/listen": "listen.html" };

function serveStatic(req, res, pathname) {
  const rel = ROUTES[pathname] || pathname.slice(1);
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return send(res, 404, { error: "Not found" });
  }
  res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
  fs.createReadStream(file).pipe(res);
}

/** Handles every request. Used by server.js (local/Render) and api/index.js (Vercel). */
export async function handler(req, res) {
  const url = new URL(req.url, "http://x");
  // Vercel sends all /api/* calls to one function as /api/index?route=<name>
  const route = url.searchParams.get("route");
  if (route !== null && !/^[a-z-]{1,30}$/.test(route)) return send(res, 404, { error: "Not found" });
  const pathname = route ? `/api/${route}` : url.pathname;
  const ip = clientIp(req);
  const fn = api[`${req.method} ${pathname}`];
  if (!fn) {
    if (req.method === "GET" && !pathname.startsWith("/api/")) return serveStatic(req, res, pathname);
    return send(res, 404, { error: "Not found" });
  }
  try {
    const out = await fn(req, ip);
    if (Array.isArray(out)) send(res, out[0], out[1], out[2]);
    else send(res, 200, out);
  } catch (err) {
    // Never log request bodies: they may contain patient information.
    if (err instanceof UserFacingError) return send(res, 400, { error: err.message });
    if (err instanceof GeminiError) {
      console.error(`Gemini API error ${err.status}: ${logSafe(err.detail)}`);
      if (err.status === 400 && /api key/i.test(err.detail)) return send(res, 500, { error: "The server's AI key is not valid. Contact the administrator." });
      if (err.status === 401 || err.status === 403) return send(res, 500, { error: "The server's AI key is not valid or not allowed. Contact the administrator." });
      if (err.status === 429) return send(res, 503, { error: "The AI service limit was reached. Try again in a minute." });
      return send(res, 502, { error: "The AI service had a problem. Please try again." });
    }
    if (err?.name === "TimeoutError") return send(res, 504, { error: "The AI took too long. Please try again." });
    console.error("Server error:", logSafe(err?.message));
    send(res, 500, { error: "Something went wrong. Please try again." });
  }
}
