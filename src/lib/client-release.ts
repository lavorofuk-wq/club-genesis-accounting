import { APP_BUILD_ID, APP_VERSION, isSameRelease, parseAppRelease, releaseLocation, type AppRelease } from "./app-release";

export type ClientReleaseState = {
  status: "checking" | "current" | "outdated" | "unavailable" | "unsupported";
  release?: AppRelease;
  message?: string;
  updateUrl?: string;
};

const CHECK_TIMEOUT_MS = 10_000;
const UNAVAILABLE = "最新版を確認できません。入力は保持されています。通信状態を確認し、最新版の確認が完了してから保存してください。";

export class ClientReleaseMonitor {
  private state: ClientReleaseState = { status: "checking" };
  private listeners = new Set<(state: ClientReleaseState) => void>();
  private pending?: Promise<ClientReleaseState>;

  constructor(
    private origin: string,
    // ブラウザのfetchをクラスのメソッドとして呼ばない（Illegal invocation防止）。
    private request: typeof fetch = (input, init) => globalThis.fetch(input, init),
    private version = APP_VERSION,
    private buildId = APP_BUILD_ID,
  ) {}

  getSnapshot = () => this.state;
  subscribe = (listener: (state: ClientReleaseState) => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(state: ClientReleaseState) {
    this.state = state;
    this.listeners.forEach((listener) => listener(state));
    return state;
  }

  check = (): Promise<ClientReleaseState> => {
    if (this.pending) return this.pending;
    const location = releaseLocation(this.origin);
    if (!location.supported) return Promise.resolve(this.publish({ status: "unsupported", updateUrl: location.updateUrl,
      message: "この固定URLでは最新版を確認できません。未保存の内容を控えてから、下記の最新環境URLを開いてください。" }));
    // 通常のfetchを使用し、Next.jsの旧deploymentを指定するdpl/headerを付けない。
    this.pending = this.fetchCurrent(location.environment).finally(() => { this.pending = undefined; });
    return this.pending;
  };

  private async fetchCurrent(environment: AppRelease["environment"]): Promise<ClientReleaseState> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
    try {
      const response = await this.request(`${this.origin}/api/release?check=${Date.now()}`, {
        cache: "no-store", credentials: "same-origin", redirect: "error", signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error(UNAVAILABLE);
      const release = parseAppRelease(await response.json(), environment);
      return this.publish({ status: isSameRelease(release, this.version, this.buildId) ? "current" : "outdated", release });
    } catch {
      // すでに新版を検知した端末は、その後通信が切れても旧版を再許可しない。
      if (this.state.status === "outdated") return this.state;
      return this.publish({ status: "unavailable", message: UNAVAILABLE });
    } finally {
      clearTimeout(timer);
    }
  }

  async assertCurrent() {
    const state = await this.check();
    if (state.status !== "current") throw new Error(state.status === "outdated"
      ? `新しいバージョン（Ver${state.release?.version}）が公開されています。入力を退避して最新版へ更新してください。`
      : state.message || UNAVAILABLE);
  }
}

let browserMonitor: ClientReleaseMonitor | undefined;
export function clientReleaseMonitor() {
  if (typeof window === "undefined") return undefined;
  return browserMonitor ??= new ClientReleaseMonitor(window.location.origin);
}

export async function assertCurrentClientRelease() {
  // repositoryはブラウザ用。サーバーレンダリング/通信しない単体テストでは監視しない。
  await clientReleaseMonitor()?.assertCurrent();
}
