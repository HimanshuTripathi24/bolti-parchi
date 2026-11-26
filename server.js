import "./lib/env.js";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { extractPrescription, demoResult, hasApiKey, UserFacingError } from "./lib/extract.js";
import { makeToken, readToken } from "./lib/tokens.js";
import { hasTts, synthesize } from "./lib/tts.js";

const PORT = Number(process.env.PORT) || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || "";
const LINK_DAYS = Number(process.env.LINK_DAYS) || 30;
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const MAX_BODY = 12 * 1024 * 1024; // photos are resized in the browser, so this is generous
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

if (!APP_PASSWORD) console.warn("[warn] APP_PASSWORD is not set. Anyone who finds the site can use the scanner.");
if (!hasApiKey()) console.warn("[warn] ANTHROPIC_API_KEY is not set. The scanner runs in DEMO mode with a sample prescription.");

const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Permissions-Policy": "camera=(self), microphone=(), geolocation=()",
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

function readJson(req) {
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

function passwordOk(req) {
  if (!APP_PASSWORD) return true;
  const given = Buffer.from(String(req.headers["x-app-password"] || ""));
  const expected = Buffer.from(APP_PASSWORD);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

const cleanText = (s, max) => (typeof s === "string" ? s.trim().slice(0, max) : "");

// --- API handlers ---
const api = {
  "GET /api/config": async () => ({ passwordRequired: Boolean(APP_PASSWORD), demo: !hasApiKey(), tts: hasTts(), linkDays: LINK_DAYS }),

  "POST /api/login": async (req) => {
    if (!passwordOk(req)) return [401, { error: "Wrong password." }];
    return { ok: true };
  },

  "POST /api/extract": async (req, ip) => {
    if (!passwordOk(req)) return [401, { error: "Wrong password." }];
    if (rateLimited(ip, "extract", 40, 60 * 60 * 1000)) return [429, { error: "Too many scans this hour. Please wait a bit." }];
    const body = await readJson(req);
    const text = cleanText(body.text, 8000);
    const imageBase64 = typeof body.imageBase64 === "string" ? body.imageBase64 : "";
    if (imageBase64 && !IMAGE_TYPES.has(body.mediaType)) return [400, { error: "Unsupported image type." }];
    if (!imageBase64 && !text) return [400, { error: "Send a photo or the prescription text." }];
    if (!hasApiKey()) return demoResult();
    return extractPrescription(imageBase64 ? { imageBase64, mediaType: body.mediaType } : { text });
  },

  "POST /api/approve": async (req, ip) => {
    if (!passwordOk(req)) return [401, { error: "Wrong password." }];
    if (rateLimited(ip, "approve", 200, 60 * 60 * 1000)) return [429, { error: "Too many requests." }];
    const body = await readJson(req);
    const en = cleanText(body.en, 6000);
    const hi = cleanText(body.hi, 6000);
    if (!en || !hi) return [400, { error: "Both English and Hindi scripts are needed." }];
    if (body.approved !== true) return [400, { error: "Doctor approval is required." }];
    const days = Math.min(Math.max(Number(body.days) || LINK_DAYS, 1), 90);
    return makeToken({ en, hi, days });
  },

  "POST /api/open": async (req, ip) => {
    if (rateLimited(ip, "open", 300, 60 * 60 * 1000)) return [429, { error: "Too many requests." }];
    const body = await readJson(req);
    try {
      const p = readToken(body.token);
      return { en: p.en, hi: p.hi, exp: p.exp, tts: hasTts() };
    } catch (err) {
      return [400, { error: err.message }];
    }
  },

  "POST /api/tts": async (req, ip) => {
    if (!hasTts()) return [404, { error: "Natural voice is not set up on this server." }];
    if (rateLimited(ip, "tts", 60, 60 * 60 * 1000)) return [429, { error: "Too many requests." }];
    const body = await readJson(req);
    let p;
    try {
      p = readToken(body.token);
    } catch (err) {
      return [400, { error: err.message }];
    }
    const lang = body.lang === "hi" ? "hi" : "en";
    const mp3 = await synthesize(p[lang], lang);
    return [200, mp3, { "Content-Type": "audio/mpeg" }];
  },
};

// --- static files ---
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };
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

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://x");
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress;
  const handler = api[`${req.method} ${pathname}`];
  if (!handler) {
    if (req.method === "GET" && !pathname.startsWith("/api/")) return serveStatic(req, res, pathname);
    return send(res, 404, { error: "Not found" });
  }
  try {
    const out = await handler(req, ip);
    if (Array.isArray(out)) send(res, out[0], out[1], out[2]);
    else send(res, 200, out);
  } catch (err) {
    // Never log request bodies: they may contain patient information.
    if (err instanceof UserFacingError) return send(res, 400, { error: err.message });
    if (err instanceof Anthropic.AuthenticationError) {
      console.error("Claude API key rejected");
      return send(res, 500, { error: "The server's AI key is not valid. Contact the administrator." });
    }
    if (err instanceof Anthropic.RateLimitError) return send(res, 503, { error: "The AI service is busy. Try again in a minute." });
    if (err instanceof Anthropic.APIError) {
      console.error(`Claude API error ${err.status}`);
      return send(res, 502, { error: "The AI service had a problem. Please try again." });
    }
    console.error("Server error:", err?.message);
    send(res, 500, { error: "Something went wrong. Please try again." });
  }
});

server.listen(PORT, () => console.log(`Bolti Parchi running on http://localhost:${PORT}`));
