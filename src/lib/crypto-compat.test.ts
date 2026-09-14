import { createHash, webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { secureRandomUUID, sha256Hex } from "./crypto-compat";

afterEach(() => vi.unstubAllGlobals());

describe("HTTP LANでも同一のSHA-256と安全なUUIDを生成する", () => {
  const values = ["", "abc", "日本語・中村・🍾\u0000\r\n", "x".repeat(55), "x".repeat(56), "x".repeat(63),
    "x".repeat(64), "x".repeat(65), "本指名".repeat(100_000)];
  it.each(values.map((value, index) => ({ value, index })))("入力$indexのfallbackとWebCryptoが一致する", async ({ value }) => {
    const expected = createHash("sha256").update(value, "utf8").digest("hex");
    vi.stubGlobal("crypto", webcrypto);
    expect(await sha256Hex(value)).toBe(expected);
    vi.stubGlobal("crypto", { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) });
    expect(await sha256Hex(value)).toBe(expected);
    vi.stubGlobal("crypto", undefined);
    expect(await sha256Hex(value)).toBe(expected);
  });

  it("利用できるWebCryptoを優先し、処理失敗は隠さない", async () => {
    const digest = vi.fn().mockRejectedValue(new Error("digest failure"));
    vi.stubGlobal("crypto", { subtle: { digest } });
    await expect(sha256Hex("abc")).rejects.toThrow("digest failure");
    expect(digest).toHaveBeenCalledWith("SHA-256", new TextEncoder().encode("abc"));
  });

  it("利用できるrandomUUIDを優先する", () => {
    const randomUUID = vi.fn().mockReturnValue("00112233-4455-4677-8899-aabbccddeeff");
    vi.stubGlobal("crypto", { randomUUID });
    expect(secureRandomUUID()).toBe("00112233-4455-4677-8899-aabbccddeeff");
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it("暗号学的乱数16バイトからversionとvariantを正しく設定する", () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => { bytes.fill(255); return bytes; });
    vi.stubGlobal("crypto", { getRandomValues });
    expect(secureRandomUUID()).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
    expect(getRandomValues).toHaveBeenCalledOnce();
    expect(getRandomValues.mock.calls[0][0]).toHaveLength(16);
  });

  it("HTTP相当でも毎回別のUUID v4を生成する", () => {
    vi.stubGlobal("crypto", { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) });
    const ids = Array.from({ length: 256 }, () => secureRandomUUID());
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  });

  it.each([undefined, {}])("安全な乱数がない場合はIDを作らず停止する", (cryptoApi) => {
    vi.stubGlobal("crypto", cryptoApi);
    expect(() => secureRandomUUID()).toThrow("安全なIDを生成できない");
  });
});
