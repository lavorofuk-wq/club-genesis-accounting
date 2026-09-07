import { describe, expect, it } from "vitest";
import {
  APP_BUILD_ID, APP_VERSION, DEVELOPMENT_ORIGIN, PRODUCTION_ORIGIN,
  isSameRelease, parseAppRelease, releaseLocation, type AppRelease,
} from "./app-release";
import { GET, dynamic } from "../../app/api/release/route";

const release: AppRelease = { schema: 1, version: "2.17.3", buildId: "commit_a1b2", environment: "production" };

describe("最新版確認の環境判定", () => {
  it.each([
    [PRODUCTION_ORIGIN, "production"],
    [DEVELOPMENT_ORIGIN, "development"],
    ["http://localhost:3000", "local"],
    ["http://127.0.0.1:3001", "local"],
    ["http://[::1]:3000", "local"],
  ])("%s は正規環境として扱う", (origin, environment) => {
    expect(releaseLocation(origin)).toEqual({ supported: true, environment, updateUrl: origin });
  });

  it.each([
    "https://club-genesis-accounting-abc123-lavorofuk-wqs-projects.vercel.app",
    "https://club-genesis-accounting-git-feature-lavorofuk-wqs-projects.vercel.app",
    "https://club-genesis-accounting.vercel.app.example.com",
  ])("固定preview等 %s では確認を許可せず正規devへ誘導する", (origin) => {
    expect(releaseLocation(origin)).toEqual({ supported: false, environment: "development", updateUrl: DEVELOPMENT_ORIGIN });
  });

  it.each(["club-genesis-gms.web.app", "club-genesis-gms.firebaseapp.com"])("旧本番alias %s は正規本番へ誘導する", (host) => {
    expect(releaseLocation(`https://${host}`)).toEqual({ supported: false, environment: "production", updateUrl: PRODUCTION_ORIGIN });
  });
});

describe("リリース応答の検証", () => {
  it("正しいschema/version/build/environmentを受理する", () => {
    expect(parseAppRelease(release, "production")).toEqual(release);
  });

  it.each([
    null, {}, [], "2.17.3",
    { ...release, schema: 2 },
    { ...release, version: "2.17" },
    { ...release, version: "Ver2.17.3" },
    { ...release, buildId: "" },
    { ...release, buildId: "commit/id" },
    { ...release, buildId: "a".repeat(101) },
    { ...release, environment: "development" },
  ])("不正または別環境の応答 %# を拒否する", (value) => {
    expect(() => parseAppRelease(value, "production")).toThrow("最新版の情報が正しくありません。");
  });

  it("versionとbuildの両方が一致した場合のみ同一とする", () => {
    expect(isSameRelease(release, "2.17.3", "commit_a1b2")).toBe(true);
    expect(isSameRelease(release, "2.17.3", "commit_other")).toBe(false);
    expect(isSameRelease(release, "2.17.4", "commit_a1b2")).toBe(false);
  });

  it("ロールバックによって配信versionが小さくなった場合も差を検出する", () => {
    expect(isSameRelease({ ...release, version: "2.17.2" }, "2.17.3", "commit_a1b2")).toBe(false);
  });
});

describe("リリース確認API", () => {
  it("動的APIとして宣言する", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it.each([
    [PRODUCTION_ORIGIN, "production"], [DEVELOPMENT_ORIGIN, "development"], ["http://localhost:3000", "local"],
  ])("%s のversion/build/environmentと全cache無効化ヘッダーを返す", async (origin, environment) => {
    const response = GET(new Request(`${origin}/api/release?check=123`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ schema: 1, version: APP_VERSION, buildId: APP_BUILD_ID, environment });
    expect(response.headers.get("Cache-Control")).toBe("no-store, no-cache, max-age=0, must-revalidate");
    expect(response.headers.get("CDN-Cache-Control")).toBe("no-store");
    expect(response.headers.get("Vercel-CDN-Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Type")).toContain("application/json");
  });
});
