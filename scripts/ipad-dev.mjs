import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 3000;
const ACCESS_FILE = "iPad開発環境.html";

export function isPrivateIpv4(address) {
  const octets = String(address).split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  const [first, second] = octets;
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

function interfacePriority(name) {
  if (/wi-?fi|wlan|wireless/i.test(name)) return 0;
  if (/ethernet|イーサネット/i.test(name)) return 1;
  return 2;
}

export function selectLanIpv4(interfaces) {
  const candidates = Object.entries(interfaces)
    .flatMap(([name, entries]) => (entries || []).map((entry) => ({ name, entry })))
    .filter(({ entry }) => (entry.family === "IPv4" || entry.family === 4) && !entry.internal && isPrivateIpv4(entry.address))
    .sort((left, right) => interfacePriority(left.name) - interfacePriority(right.name));
  return candidates[0]?.entry.address || "";
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function createAccessHtml(url) {
  const safeUrl = escapeHtml(url);
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="0; url=${safeUrl}">
  <title>CLUB GENESIS 開発環境</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #101827; color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { width: min(88vw, 30rem); padding: 2rem; border: 1px solid #334155; border-radius: 1rem; background: #172033; text-align: center; box-shadow: 0 1rem 3rem #0005; }
    h1 { margin-top: 0; font-size: 1.35rem; }
    a { display: block; margin: 1.5rem 0 1rem; padding: 1rem; border-radius: .75rem; background: #f2c94c; color: #111827; font-weight: 700; text-decoration: none; }
    small { overflow-wrap: anywhere; color: #94a3b8; }
  </style>
</head>
<body>
  <main>
    <h1>CLUB GENESIS 開発環境</h1>
    <p>自動で開かない場合は、下のボタンを押してください。</p>
    <a href="${safeUrl}">開発環境を開く</a>
    <small>${safeUrl}</small>
  </main>
</body>
</html>
`;
}

export async function startIpadDevelopment() {
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const projectDirectory = resolve(scriptDirectory, "..");
  const lanIp = selectLanIpv4(networkInterfaces());
  if (!lanIp) {
    throw new Error("同一LANで利用できるプライベートIPv4アドレスが見つかりません。Wi-Fi接続を確認してください。");
  }

  const accessUrl = `http://${lanIp}:${PORT}/`;
  const accessPath = resolve(projectDirectory, ACCESS_FILE);
  await writeFile(accessPath, createAccessHtml(accessUrl), "utf8");

  const nextCli = resolve(projectDirectory, "node_modules", "next", "dist", "bin", "next");
  if (!existsSync(nextCli)) {
    throw new Error("Next.jsが見つかりません。先に npm ci を実行してください。");
  }

  console.log("");
  console.log("iPad用アクセスファイルを更新しました:");
  console.log(`  ${accessPath}`);
  console.log("");
  console.log("iPadのOneDriveから上のHTMLファイルを開いてください:");
  console.log(`  ${accessUrl}`);
  console.log("");

  const child = spawn(process.execPath, [nextCli, "dev", "--hostname", "0.0.0.0", "--port", String(PORT)], {
    cwd: projectDirectory,
    env: { ...process.env, GMS_ALLOWED_DEV_ORIGINS: lanIp },
    stdio: "inherit",
  });

  child.on("error", (error) => {
    console.error(`開発サーバーを起動できませんでした: ${error.message}`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    process.exitCode = typeof code === "number" ? code : signal ? 1 : 0;
  });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  startIpadDevelopment().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
