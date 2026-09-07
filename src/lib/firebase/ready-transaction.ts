import {
  onValue,
  runTransaction,
  type DatabaseReference,
  type TransactionOptions,
  type TransactionResult,
} from "firebase/database";

const INITIAL_READ_TIMEOUT_MS = 15_000;

/**
 * 初回の値を受信し、キャッシュを保持したままトランザクションを実行する。
 * get() や onlyOnce の読込だけでは監視解除後にキャッシュが失われ、
 * サーバーに存在するレコードでも最初の更新関数へ null が渡ることがある。
 */
export async function runReadyTransaction(
  reference: DatabaseReference,
  transactionUpdate: Parameters<typeof runTransaction>[1],
  options?: TransactionOptions,
): Promise<TransactionResult> {
  let unsubscribe: (() => void) | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let readFailed = false;
  let readError: unknown;
  let updateFailed = false;
  let updateError: unknown;

  const clearReadTimeout = () => {
    if (timeout !== undefined) clearTimeout(timeout);
    timeout = undefined;
  };

  try {
    await new Promise<void>((resolve, reject) => {
      timeout = setTimeout(() => {
        reject(new Error("Firebaseサーバーから応答がありません。通信状態を確認してからやり直してください。"));
      }, INITIAL_READ_TIMEOUT_MS);

      // onlyOnce は使用しない。更新完了までこの監視がキャッシュを維持する。
      unsubscribe = onValue(reference, () => {
        clearReadTimeout();
        resolve();
      }, (error) => {
        readFailed = true;
        readError = error;
        clearReadTimeout();
        reject(error);
      });
    });

    if (readFailed) throw readError;

    // 書込開始後の独自タイムアウトは設けない。結果不明のまま再実行を促すと
    // 二重処理につながるため、Firebaseによる確定／中断まで待つ。
    const result = await runTransaction(reference, (current) => {
      if (updateFailed) return undefined;
      if (readFailed) {
        updateFailed = true;
        updateError = readError;
        return undefined;
      }
      try {
        return transactionUpdate(current);
      } catch (error) {
        // SDK内へ例外を投げると内部監視の解除を飛ばしてしまう。
        // undefinedで安全に中断し、SDKの終了処理後に元のエラーを返す。
        updateFailed = true;
        updateError = error;
        return undefined;
      }
    }, options);

    if (updateFailed) throw updateError;
    return result;
  } finally {
    clearReadTimeout();
    unsubscribe?.();
  }
}
