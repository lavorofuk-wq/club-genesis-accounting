export type OneShotValueSubscription<T> = (
  onValue: (value: T) => void,
  onError: (error: unknown) => void,
) => () => void;

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Firebaseのone-shot listenerを必ず解除し、応答がない場合も画面を待機状態のままにしない。
 */
export function readOneShotValue<T>(
  subscribe: OneShotValueSubscription<T>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    let unsubscribed = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const detach = () => {
      if (!unsubscribe || unsubscribed) return;
      unsubscribed = true;
      try {
        unsubscribe();
      } catch {
        // 読取結果を優先する。解除済みlistenerの再解除は処理結果へ影響させない。
      }
    };
    const settle = (complete: () => void) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      detach();
      complete();
    };

    timeoutHandle = setTimeout(() => {
      settle(() => reject(new Error("Firebaseサーバーから応答がありません。通信状態を確認してからやり直してください。")));
    }, timeoutMs);

    try {
      unsubscribe = subscribe(
        (value) => settle(() => resolve(value)),
        (error) => settle(() => reject(error)),
      );
      // キャッシュ済みの値はsubscribe中に同期通知される場合がある。
      if (settled) detach();
    } catch (error) {
      settle(() => reject(error));
    }
  });
}
