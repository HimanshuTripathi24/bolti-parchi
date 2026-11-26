// Security tests. Run with:  npm test
// They drive the real request handler with fake requests, in "deployed" mode, without calling Gemini.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

process.env.VERCEL = "1"; // deployed mode: platform-parsed bodies, x-real-ip addresses, fail-closed checks
process.env.APP_PASSWORD = "correct-horse-battery-42";
process.env.LINK_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.GEMINI_API_KEY = ""; // demo mode: no AI calls
const PASSWORD = process.env.APP_PASSWORD;

const { handler } = await import("../lib/app.js");
const { cleanString, sanitizeExtraction, validateBody } = await import("../lib/validate.js");

let ipCounter = 0;
const freshIp = () => `203.0.113.${++ipCounter}`;

function call(route, body, { headers = {}, method = "POST", ip = "198.51.100.1", contentType = "application/json" } = {}) {
  return new Promise((resolve) => {
    const req = {
      method,
      url: `/api/index?route=${encodeURIComponent(route)}`,
      // Node always gives handlers lower-case header names.
      headers: Object.fromEntries(Object.entries({ "x-real-ip": ip, ...(contentType ? { "content-type": contentType } : {}), ...headers }).map(([k, v]) => [k.toLowerCase(), v])),
      body,
      socket: {},
    };
    const res = {
      status: 0,
      headers: {},
      writeHead(s, h) { this.status = s; this.headers = h; },
      end(b) {
        let json = null;
        try { json = JSON.parse(String(b)); } catch {}
        resolve({ status: this.status, headers: this.headers, json });
      },
    };
    handler(req, res);
  });
}

async function signIn(ip = "198.51.100.1") {
  const r = await call("login", { password: PASSWORD }, { ip });
  assert.equal(r.status, 200);
  return { Authorization: `Bearer ${r.json.session}` };
}
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]).toString("base64");

// ---------- sign-in and sessions ----------
test("wrong or empty password is refused", async () => {
  assert.equal((await call("login", { password: "nope" }, { ip: freshIp() })).status, 401);
  assert.equal((await call("login", {}, { ip: freshIp() })).status, 401);
});

test("doctor actions need a valid session", async () => {
  assert.equal((await call("extract", { text: "Tab X" })).status, 401);
  assert.equal((await call("extract", { text: "Tab X" }, { headers: { "x-app-password": PASSWORD } })).status, 401, "old password header no longer works");
  const auth = await signIn();
  assert.equal((await call("extract", { text: "Tab X" }, { headers: auth })).status, 200);
});

test("tampered or extended sessions are refused", async () => {
  const { Authorization } = await signIn();
  const [, , exp, sig] = Authorization.match(/^(Bearer v1)\.(\d+)\.(.+)$/);
  const flipped = sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A");
  assert.equal((await call("session", undefined, { method: "GET", headers: { Authorization: `Bearer v1.${exp}.${flipped}` } })).status, 401);
  assert.equal((await call("session", undefined, { method: "GET", headers: { Authorization: `Bearer v1.9999999999.${sig}` } })).status, 401);
});

test("8 wrong passwords lock the address out, even with the right one", async () => {
  const ip = freshIp();
  for (let i = 0; i < 8; i++) await call("login", { password: `guess-${i}` }, { ip, headers: { "x-forwarded-for": `10.0.0.${i}` } });
  const r = await call("login", { password: PASSWORD }, { ip });
  assert.equal(r.status, 429);
});

// ---------- request shape ("injection" into the API) ----------
test("unknown fields are rejected, including __proto__", async () => {
  const auth = await signIn();
  assert.equal((await call("extract", { text: "Tab X", admin: true }, { headers: auth })).status, 400);
  assert.equal((await call("extract", JSON.parse('{"text":"Tab X","__proto__":{"isAdmin":true}}'), { headers: auth })).status, 400);
  assert.equal({}.isAdmin, undefined, "prototype not polluted");
});

test("wrong types and oversized fields are rejected", async () => {
  const auth = await signIn();
  assert.equal((await call("extract", { text: ["Tab X"] }, { headers: auth })).status, 400);
  assert.equal((await call("extract", { text: "x".repeat(8001) }, { headers: auth })).status, 400);
  assert.equal((await call("approve", { en: "a", hi: "ब", approved: true, days: 500 }, { headers: auth })).status, 400);
});

test("non-JSON posts (e.g. HTML forms from other sites) are rejected", async () => {
  const auth = await signIn();
  const r = await call("extract", "text=Tab+X", { headers: auth, contentType: "application/x-www-form-urlencoded" });
  assert.equal(r.status, 400);
});

test("odd route names are not routed", async () => {
  assert.equal((await call("../../etc/passwd", {})).status, 404);
  assert.equal((await call("login%00", {})).status, 404);
});

// ---------- uploads ----------
test("files that only pretend to be images are rejected", async () => {
  const auth = await signIn();
  const fake = Buffer.from("<script>alert(1)</script>".repeat(10)).toString("base64");
  let r = await call("extract", { imageBase64: fake, mediaType: "image/jpeg" }, { headers: auth });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /isn't a real image/);
  r = await call("extract", { imageBase64: JPEG, mediaType: "image/svg+xml" }, { headers: auth });
  assert.equal(r.status, 400, "SVG (can carry scripts) is not accepted");
  r = await call("extract", { imageBase64: "not base64!!".repeat(20), mediaType: "image/png" }, { headers: auth });
  assert.equal(r.status, 400);
});

test("a real JPEG is accepted", async () => {
  const auth = await signIn();
  assert.equal((await call("extract", { imageBase64: JPEG, mediaType: "image/jpeg" }, { headers: auth })).status, 200);
});

// ---------- patient links ----------
test("approval needs real approval and a Devanagari Hindi script", async () => {
  const auth = await signIn();
  assert.equal((await call("approve", { en: "Take 1.", hi: "Take 1.", approved: true }, { headers: auth })).status, 400);
  assert.equal((await call("approve", { en: "Take 1.", hi: "1 गोली लें।", approved: false }, { headers: auth })).status, 400);
});

test("links open, but tampered links and sessions-as-links do not", async () => {
  const auth = await signIn();
  const a = await call("approve", { en: "Take 1 tablet.", hi: "1 गोली लें।", approved: true }, { headers: auth });
  assert.equal(a.status, 200);
  const ok = await call("open", { token: a.json.token });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.hi, "1 गोली लें।");
  const [data, sig] = a.json.token.split(".");
  const tampered = (data.slice(0, -2) + (data.endsWith("AA") ? "BB" : "AA")) + "." + sig;
  assert.equal((await call("open", { token: tampered })).status, 400);
  assert.equal((await call("open", { token: auth.Authorization.slice(7) })).status, 400);
  // and a link can't be used as a session
  assert.equal((await call("session", undefined, { method: "GET", headers: { Authorization: `Bearer ${a.json.token}` } })).status, 401);
});

// ---------- browser protections ----------
test("pages forbid injected scripts, framing and HTML-from-text", async () => {
  const r = await call("config", undefined, { method: "GET" });
  const csp = r.headers["Content-Security-Policy"];
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /require-trusted-types-for 'script'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(r.headers["X-Frame-Options"], "DENY");
  assert.match(r.headers["Strict-Transport-Security"], /max-age=/);
});

// ---------- text and AI output cleaning ----------
test("invisible control and text-direction characters are removed", () => {
  assert.equal(cleanString("Tab‮ 500\u0000mg​", 100), "Tab 500mg​".replace("​", "​"));
  assert.equal(cleanString("क्‍ष", 100), "क्‍ष", "Devanagari joiners are kept");
});

test("AI output is rebuilt to the expected shape", () => {
  const out = sanitizeExtraction({
    hacked: "yes",
    medicines: [{ medicine_name: "<img src=x onerror=alert(1)>".repeat(20), form: "bomb", confidence: "totally", times_of_day: ["morning", "midnight"], times_per_day: -4, extra: 1 }],
  });
  assert.equal(out.hacked, undefined);
  const m = out.medicines[0];
  assert.equal(m.extra, undefined);
  assert.ok(m.medicine_name.length <= 120);
  assert.equal(m.form, "other");
  assert.equal(m.confidence, "low", "unknown confidence is treated as unsure");
  assert.deepEqual(m.times_of_day, ["morning"]);
  assert.equal(m.times_per_day, 0);
});

test("validateBody ignores nothing it doesn't know", () => {
  assert.throws(() => validateBody({ a: 1 }, {}));
  assert.throws(() => validateBody(null, {}));
  assert.throws(() => validateBody([], {}));
});

// ---------- fail closed when deployed without secrets ----------
test("a deployment without APP_PASSWORD/LINK_SECRET switches the doctor side off", () => {
  const script = `
    process.env.VERCEL = "1"; process.env.APP_PASSWORD = ""; process.env.LINK_SECRET = ""; process.env.GEMINI_API_KEY = "";
    const { handler } = await import(${JSON.stringify(new URL("../lib/app.js", import.meta.url).href)});
    const res = { writeHead(s) { this.s = s; }, end() { console.log(this.s); } };
    handler({ method: "POST", url: "/api/index?route=login", headers: { "content-type": "application/json", "x-real-ip": "1.1.1.1" }, body: { password: "" }, socket: {} }, res);
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(r.stdout.trim(), "503", r.stderr);
});
