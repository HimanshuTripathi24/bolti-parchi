// Downloads the offline Hindi voice (Piper "hi_IN-pratham", int8) into voices/pratham.
// Runs automatically on Vercel at build time (npm run vercel-build); run `npm run fetch-voice` locally.
// The download is checked against a fixed SHA-256 fingerprint, so a changed or tampered file is refused.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const URL_ = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-hi_IN-pratham-medium-int8.tar.bz2";
const SHA256 = "20f568c56207c13b9a0d9478aec8b7d1449122e618aeebc7211f6abc942b58b7";
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEST = path.join(ROOT, "voices", "pratham");
const MODEL = path.join(DEST, "hi_IN-pratham-medium.onnx");

if (fs.existsSync(MODEL)) {
  console.log("[voice] Hindi voice already present.");
  process.exit(0);
}

console.log("[voice] Downloading the offline Hindi voice (about 21 MB)…");
const res = await fetch(URL_, { redirect: "follow" });
if (!res.ok) throw new Error(`[voice] Download failed: HTTP ${res.status}`);
const buf = Buffer.from(await res.arrayBuffer());
const got = crypto.createHash("sha256").update(buf).digest("hex");
if (got !== SHA256) throw new Error(`[voice] Fingerprint mismatch (got ${got}). Refusing to use this file.`);

const tmp = fs.mkdtempSync(path.join(ROOT, ".voice-"));
try {
  const archive = path.join(tmp, "voice.tar.bz2");
  fs.writeFileSync(archive, buf);
  // Relative paths: some Windows tar builds read "C:\..." as a remote host.
  execFileSync("tar", ["-xjf", "voice.tar.bz2"], { cwd: tmp, stdio: "inherit" });
  const unpacked = path.join(tmp, "vits-piper-hi_IN-pratham-medium-int8");
  fs.mkdirSync(path.dirname(DEST), { recursive: true });
  fs.rmSync(DEST, { recursive: true, force: true });
  fs.cpSync(unpacked, DEST, { recursive: true });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
if (!fs.existsSync(MODEL)) throw new Error("[voice] The voice file is missing after unpacking.");
console.log("[voice] Offline Hindi voice ready.");
