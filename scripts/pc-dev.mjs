import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_URL = "http://localhost:3000";
const RELEASE_URL = `${APP_URL}/api/release?check=pc-launcher`;

export async function isGmsReady(fetcher = fetch) {
  try {
    const response = await fetcher(RELEASE_URL, { cache: "no-store" });
    if (!response.ok) return false;
    const release = await response.json();
    return release?.schema === 1 && release?.environment === "local";
  } catch {
    return false;
  }
}

export async function waitForGms({ fetcher = fetch, timeoutMs = 60_000, intervalMs = 250, getAbortError = () => null } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const abortError = getAbortError();
    if (abortError) throw abortError;
    if (await isGmsReady(fetcher)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
  }
  throw new Error("開発サーバーの起動を60秒以内に確認できませんでした。");
}

export function openDefaultBrowser(url = APP_URL, spawnProcess = spawn) {
  const browser = spawnProcess("cmd.exe", ["/d", "/s", "/c", `start "" "${url}"`], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  browser.unref();
}

export async function startPcDevelopment() {
  if (await isGmsReady()) {
    console.log("開発サーバーはすでに起動しています。ブラウザーを開きます。");
    openDefaultBrowser();
    return;
  }

  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const projectDirectory = resolve(scriptDirectory, "..");
  const nextCli = resolve(projectDirectory, "node_modules", "next", "dist", "bin", "next");
  if (!existsSync(nextCli)) {
    throw new Error("Next.jsが見つかりません。先に npm ci を実行してください。");
  }

  console.log("PC専用の開発サーバーを起動しています…");
  const child = spawn(process.execPath, [nextCli, "dev", "--hostname", "127.0.0.1", "--port", "3000"], {
    cwd: projectDirectory,
    stdio: "inherit",
  });

  let startupError = null;
  const onError = (error) => { startupError = error; };
  const onExit = (code) => {
    startupError = new Error(`開発サーバーが起動前に終了しました（終了コード: ${code ?? "不明"}）。`);
  };
  child.once("error", onError);
  child.once("exit", onExit);
  await waitForGms({ getAbortError: () => startupError });
  child.off("error", onError);
  child.off("exit", onExit);

  console.log(`起動を確認しました: ${APP_URL}`);
  openDefaultBrowser();
  child.once("exit", (code, signal) => {
    process.exitCode = typeof code === "number" ? code : signal ? 1 : 0;
  });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  startPcDevelopment().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
