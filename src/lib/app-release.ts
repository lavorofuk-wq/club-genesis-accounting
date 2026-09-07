import version from "../../version.json";

export const APP_VERSION = version.version;
export const APP_BUILD_ID = process.env.NEXT_PUBLIC_GMS_BUILD_ID || "local";
export const PRODUCTION_ORIGIN = "https://club-genesis-accounting.vercel.app";
export const DEVELOPMENT_ORIGIN = "https://club-genesis-accounting-git-dev-lavorofuk-wqs-projects.vercel.app";
export type ReleaseEnvironment = "production" | "development" | "local";
export type AppRelease = { schema: 1; version: string; buildId: string; environment: ReleaseEnvironment };

export function releaseLocation(origin: string): { supported: boolean; environment: ReleaseEnvironment; updateUrl: string } {
  const url = new URL(origin);
  if (url.origin === PRODUCTION_ORIGIN) return { supported: true, environment: "production", updateUrl: url.origin };
  if (url.origin === DEVELOPMENT_ORIGIN) return { supported: true, environment: "development", updateUrl: url.origin };
  if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return { supported: true, environment: "local", updateUrl: url.origin };
  const productionAlias = ["club-genesis-gms.web.app", "club-genesis-gms.firebaseapp.com"].includes(url.hostname);
  return { supported: false, environment: productionAlias ? "production" : "development", updateUrl: productionAlias ? PRODUCTION_ORIGIN : DEVELOPMENT_ORIGIN };
}

export function parseAppRelease(value: unknown, environment: ReleaseEnvironment): AppRelease {
  const row = value as Partial<AppRelease> | null;
  if (!row || row.schema !== 1 || typeof row.version !== "string" || !/^\d+\.\d+\.\d+$/.test(row.version)
    || typeof row.buildId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(row.buildId) || row.environment !== environment) {
    throw new Error("最新版の情報が正しくありません。時間をおいて再確認してください。");
  }
  return row as AppRelease;
}

export function isSameRelease(release: AppRelease, version = APP_VERSION, buildId = APP_BUILD_ID) {
  // 大小比較はしない。緊急ロールバック・同一Verの別コミット公開も検知する。
  return release.version === version && release.buildId === buildId;
}
