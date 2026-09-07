import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEVELOPMENT_ORIGIN, PRODUCTION_ORIGIN, type AppRelease } from "./app-release";
import { ClientReleaseMonitor, assertCurrentClientRelease, clientReleaseMonitor } from "./client-release";

const version = "2.17.3";
const buildId = "commit-current";
const release: AppRelease = { schema: 1, version, buildId, environment: "production" };
const response = (value: unknown = release, status = 200) => Response.json(value, { status });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-07T12:00:00.000Z"));
});

afterEach(() => {
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("クライアント最新版監視", () => {
  it("既定のfetchをブラウザのglobalオブジェクトに束縛して呼び出す", async () => {
    const request = vi.fn(function (this: unknown) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(response());
    });
    vi.stubGlobal("fetch", request);
    const monitor = new ClientReleaseMonitor(PRODUCTION_ORIGIN, undefined, version, buildId);
    await expect(monitor.assertCurrent()).resolves.toBeUndefined();
    expect(monitor.getSnapshot()).toEqual({ status: "current", release });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("未確認時はchecking、同じversion/buildの確認後にcurrentになる", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response());
    const monitor = new ClientReleaseMonitor(PRODUCTION_ORIGIN, request, version, buildId);
    expect(monitor.getSnapshot()).toEqual({ status: "checking" });
    await expect(monitor.assertCurrent()).resolves.toBeUndefined();
    expect(monitor.getSnapshot()).toEqual({ status: "current", release });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("確認リクエストをno-storeで行い旧deploymentを指定しない", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response());
    const monitor = new ClientReleaseMonitor(PRODUCTION_ORIGIN, request, version, buildId);
    await monitor.check();
    const [url, options] = request.mock.calls[0];
    expect(url).toBe(`${PRODUCTION_ORIGIN}/api/release?check=${Date.now()}`);
    expect(options).toMatchObject({ cache: "no-store", credentials: "same-origin", redirect: "error",
      headers: { Accept: "application/json" } });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(String(url)).not.toContain("dpl=");
    expect(Object.keys(options?.headers || {})).toEqual(["Accept"]);
  });

  it("同時確認を1リクエストにまとめ、完了後の保存時は再確認する", async () => {
    const pending = deferred<Response>();
    const request = vi.fn<typeof fetch>().mockReturnValueOnce(pending.promise).mockResolvedValue(response());
    const monitor = new ClientReleaseMonitor(PRODUCTION_ORIGIN, request, version, buildId);
    const first = monitor.check();
    const second = monitor.check();
    expect(first).toBe(second);
    expect(request).toHaveBeenCalledTimes(1);
    pending.resolve(response());
    await Promise.all([first, second]);
    await monitor.assertCurrent();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([
    { ...release, version: "2.17.4" },
    { ...release, buildId: "commit-other" },
    { ...release, version: "2.17.2", buildId: "commit-rollback" },
  ])("version変更・同version別commit・rollbackをすべて停止する %#", async (remote) => {
    const request = vi.fn<typeof fetch>().mockImplementation(async () => response(remote));
    const monitor = new ClientReleaseMonitor(PRODUCTION_ORIGIN, request, version, buildId);
    await expect(monitor.assertCurrent()).rejects.toThrow("入力を退避して最新版へ更新してください。");
    expect(monitor.getSnapshot()).toEqual({ status: "outdated", release: remote });
  });

  it("既にcurrentでも保存直前に新版が出れば保存を止める", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(response()).mockResolvedValueOnce(response({ ...release, buildId: "new-build" }));
    const monitor = new ClientReleaseMonitor(PRODUCTION_ORIGIN, request, version, buildId);
    await monitor.check();
    await expect(monitor.assertCurrent()).rejects.toThrow("最新版へ更新してください。");
    expect(monitor.getSnapshot().status).toBe("outdated");
  });

  it.each([
    () => response({ ...release, environment: "development" }),
    () => response({ schema: 1, version: "invalid" }),
    () => response({ error: "unavailable" }, 503),
    () => new Response("<html>認証画面</html>", { status: 200 }),
  ])("別環境・不正JSON・HTTP失敗では保存を止める %#", async (makeResponse) => {
    const request = vi.fn<typeof fetch>().mockImplementation(async () => makeResponse());
    const monitor = new ClientReleaseMonitor(PRODUCTION_ORIGIN, request, version, buildId);
    await expect(monitor.assertCurrent()).rejects.toThrow("最新版を確認できません。");
    expect(monitor.getSnapshot().status).toBe("unavailable");
  });

  it("current確認後でも通信失敗した保存は止め、再確認成功後にのみ許可する", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(response()).mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce(response());
    const monitor = new ClientReleaseMonitor(PRODUCTION_ORIGIN, request, version, buildId);
    await monitor.assertCurrent();
    await expect(monitor.assertCurrent()).rejects.toThrow("最新版を確認できません。");
    expect(monitor.getSnapshot().status).toBe("unavailable");
    await expect(monitor.assertCurrent()).resolves.toBeUndefined();
    expect(monitor.getSnapshot().status).toBe("current");
  });

  it("10秒経過でfetchを中断し保存を止める", async () => {
    const request = vi.fn<typeof fetch>().mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const monitor = new ClientReleaseMonitor(PRODUCTION_ORIGIN, request, version, buildId);
    const operation = monitor.assertCurrent();
    const assertion = expect(operation).rejects.toThrow("最新版を確認できません。");
    await vi.advanceTimersByTimeAsync(9999);
    expect(request.mock.calls[0][1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(request.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(monitor.getSnapshot().status).toBe("unavailable");
  });

  it("新版検知後は通信失敗してもoutdatedを解除しない", async () => {
    const newer = { ...release, version: "2.17.4" };
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(response(newer)).mockRejectedValueOnce(new TypeError("network"));
    const monitor = new ClientReleaseMonitor(PRODUCTION_ORIGIN, request, version, buildId);
    const detected = await monitor.check();
    await expect(monitor.assertCurrent()).rejects.toThrow("Ver2.17.4");
    expect(monitor.getSnapshot()).toBe(detected);
    expect(monitor.getSnapshot().status).toBe("outdated");
  });

  it("dev/localではその環境と一致する応答だけ許可する", async () => {
    for (const [origin, environment] of [[DEVELOPMENT_ORIGIN, "development"], ["http://localhost:3000", "local"]] as const) {
      const request = vi.fn<typeof fetch>().mockResolvedValue(response({ ...release, environment }));
      const monitor = new ClientReleaseMonitor(origin, request, version, buildId);
      await expect(monitor.assertCurrent()).resolves.toBeUndefined();
      expect(String(request.mock.calls[0][0])).toContain(`${origin}/api/release?`);
    }
  });

  it("固定previewではfetchせずunsupportedとし正規環境へ誘導する", async () => {
    const request = vi.fn<typeof fetch>();
    const monitor = new ClientReleaseMonitor("https://club-genesis-accounting-abc123.vercel.app", request, version, buildId);
    await expect(monitor.assertCurrent()).rejects.toThrow("この固定URLでは最新版を確認できません。");
    expect(monitor.getSnapshot()).toMatchObject({ status: "unsupported", updateUrl: DEVELOPMENT_ORIGIN });
    expect(request).not.toHaveBeenCalled();
  });

  it("状態変更を購読者へ伝え、解除後は通知しない", async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async () => response());
    const monitor = new ClientReleaseMonitor(PRODUCTION_ORIGIN, request, version, buildId);
    const listener = vi.fn();
    const unsubscribe = monitor.subscribe(listener);
    await monitor.check();
    expect(listener).toHaveBeenCalledWith({ status: "current", release });
    unsubscribe();
    await monitor.check();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("windowのないテスト/SSRではブラウザ監視も通信も開始しない", async () => {
    vi.stubGlobal("window", undefined);
    const request = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", request);
    expect(clientReleaseMonitor()).toBeUndefined();
    await expect(assertCurrentClientRelease()).resolves.toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });
});
