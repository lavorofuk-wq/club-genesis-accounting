import { sha256 } from "@noble/hashes/sha2.js";

const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** LANのHTTP接続でも同じUTF-8バイト列・SHA-256で検証し、検証自体を省略しない。 */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const subtle = globalThis.crypto?.subtle;
  if (typeof subtle?.digest === "function") {
    return hex(new Uint8Array(await subtle.digest("SHA-256", bytes)));
  }
  return hex(sha256(bytes));
}

/** randomUUIDがないHTTP環境では、暗号学的乱数を使ってUUID v4を生成する。 */
export function secureRandomUUID(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  if (typeof cryptoApi?.getRandomValues !== "function") {
    throw new Error("安全なIDを生成できないブラウザーです。対応ブラウザーまたはHTTPS環境で開いてください。");
  }
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const value = hex(bytes);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
