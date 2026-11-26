// Patient links carry the approved text inside the link itself, signed so it cannot be altered.
// The server keeps no database: nothing about the patient is stored anywhere on it.
import crypto from "node:crypto";
import zlib from "node:zlib";

let secret = process.env.LINK_SECRET;
if (!secret) {
  secret = crypto.randomBytes(32).toString("hex");
  console.warn("[warn] LINK_SECRET is not set. Using a temporary one: patient links will stop working when the server restarts.");
}

const sign = (data) => crypto.createHmac("sha256", secret).update(data).digest("base64url");

export function makeToken({ en, hi, days }) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { v: 1, en, hi, iat: now, exp: now + days * 86400 };
  const data = zlib.deflateRawSync(Buffer.from(JSON.stringify(payload), "utf8")).toString("base64url");
  return { token: `${data}.${sign(data)}`, exp: payload.exp };
}

/** Returns the payload, or throws an Error whose message is safe to show to patients. */
export function readToken(token) {
  if (typeof token !== "string" || token.length > 20000) throw new Error("This link is not valid.");
  const [data, sig] = token.split(".");
  if (!data || !sig) throw new Error("This link is not valid.");
  const expected = Buffer.from(sign(data));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
    throw new Error("This link is not valid or has been changed.");
  }
  const payload = JSON.parse(zlib.inflateRawSync(Buffer.from(data, "base64url")).toString("utf8"));
  if (payload.exp < Date.now() / 1000) throw new Error("This link has expired. Please ask your doctor for a new one.");
  return payload;
}
