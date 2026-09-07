import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DatabaseReference,
  DataSnapshot,
  TransactionOptions,
  TransactionResult,
} from "firebase/database";
import { runReadyTransaction } from "./ready-transaction";

const firebase = vi.hoisted(() => ({
  onValue: vi.fn(),
  runTransaction: vi.fn(),
}));

vi.mock("firebase/database", () => firebase);

const reference = { key: "target" } as DatabaseReference;
const existing = { id: "target", status: "submitted", revision: 1 };

function snapshot(value: unknown): DataSnapshot {
  return { val: () => value, exists: () => value !== null } as DataSnapshot;
}

function transactionResult(value: unknown, committed = true): TransactionResult {
  return {
    committed,
    snapshot: snapshot(value),
    toJSON: () => ({ committed, snapshot: value }),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("runReadyTransaction", () => {
  let notify: (value: unknown) => void;
  let denyRead: (error: Error) => void;
  let unsubscribe: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetAllMocks();
    unsubscribe = vi.fn();
    firebase.onValue.mockImplementation((
      _reference: DatabaseReference,
      onValue: (value: DataSnapshot) => void,
      onError: (error: Error) => void,
    ) => {
      notify = (value) => onValue(snapshot(value));
      denyRead = onError;
      return unsubscribe;
    });
    firebase.runTransaction.mockImplementation(async (
      _reference: DatabaseReference,
      update: (value: unknown) => unknown,
    ) => {
      const nextValue = update(existing);
      return transactionResult(nextValue, nextValue !== undefined);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("初期データの通知前には更新を始めず、初回から既存データで処理する", async () => {
    const update = vi.fn((value: typeof existing) => {
      if (!value) throw new Error("経理確認待ちまたは承認済みのデータだけ差し戻せます。");
      return { ...value, status: "returned" };
    });
    const pending = runReadyTransaction(reference, update, { applyLocally: false });

    expect(firebase.onValue).toHaveBeenCalledTimes(1);
    expect(firebase.onValue.mock.calls[0][0]).toBe(reference);
    expect(firebase.runTransaction).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();

    notify(existing);
    const result = await pending;

    expect(firebase.runTransaction).toHaveBeenCalledTimes(1);
    expect(firebase.runTransaction.mock.calls[0][0]).toBe(reference);
    expect(firebase.runTransaction.mock.calls[0][2]).toEqual({ applyLocally: false });
    expect(update).toHaveBeenCalledExactlyOnceWith(existing);
    expect(result.committed).toBe(true);
    expect(result.snapshot.val()).toEqual({ ...existing, status: "returned" });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("同期的な初期通知でも更新完了まで監視を維持して一度だけ解除する", async () => {
    const completion = deferred<TransactionResult>();
    firebase.onValue.mockImplementation((
      _reference: DatabaseReference,
      onValue: (value: DataSnapshot) => void,
    ) => {
      onValue(snapshot(existing));
      return unsubscribe;
    });
    firebase.runTransaction.mockReturnValue(completion.promise);

    const pending = runReadyTransaction(reference, (value) => value);
    await Promise.resolve();
    expect(firebase.runTransaction).toHaveBeenCalledTimes(1);
    expect(unsubscribe).not.toHaveBeenCalled();

    const result = transactionResult(existing);
    completion.resolve(result);
    await expect(pending).resolves.toBe(result);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("更新中の追加通知ではトランザクションを重複起動しない", async () => {
    const completion = deferred<TransactionResult>();
    firebase.runTransaction.mockReturnValue(completion.promise);
    const pending = runReadyTransaction(reference, (value) => value);

    notify(existing);
    notify({ ...existing, revision: 2 });
    await Promise.resolve();
    expect(firebase.runTransaction).toHaveBeenCalledTimes(1);
    expect(unsubscribe).not.toHaveBeenCalled();

    completion.resolve(transactionResult(existing));
    await pending;
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("読込後に本当に存在しないデータはSDKの中断・後始末後に元のエラーを返す", async () => {
    const missingError = new Error("経理確認待ちまたは承認済みのデータだけ差し戻せます。");
    const sdkCleanup = vi.fn();
    firebase.runTransaction.mockImplementation(async (
      _reference: DatabaseReference,
      update: (value: unknown) => unknown,
    ) => {
      expect(update(null)).toBeUndefined();
      sdkCleanup();
      return transactionResult(null, false);
    });

    const pending = runReadyTransaction(reference, (value) => {
      if (!value) throw missingError;
      return value;
    });
    const assertion = expect(pending).rejects.toBe(missingError);
    notify(null);

    await assertion;
    expect(sdkCleanup).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("競合によるコールバック再実行時も最新値で検証し、例外をSDKの外へ直接漏らさない", async () => {
    const conflictError = new Error("別の端末で更新されています。");
    const conflicting = { ...existing, revision: 2 };
    const sdkCleanup = vi.fn();
    const update = vi.fn((value: typeof existing) => {
      if (value.revision !== 1) throw conflictError;
      return { ...value, status: "returned" };
    });
    firebase.runTransaction.mockImplementation(async (
      _reference: DatabaseReference,
      guardedUpdate: (value: unknown) => unknown,
    ) => {
      expect(guardedUpdate(existing)).toEqual({ ...existing, status: "returned" });
      expect(guardedUpdate(conflicting)).toBeUndefined();
      sdkCleanup();
      return transactionResult(conflicting, false);
    });

    const pending = runReadyTransaction(reference, update);
    const assertion = expect(pending).rejects.toBe(conflictError);
    notify(existing);

    await assertion;
    expect(update).toHaveBeenNthCalledWith(1, existing);
    expect(update).toHaveBeenNthCalledWith(2, conflicting);
    expect(sdkCleanup).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("更新関数が正常にundefinedを返した場合は例外ではなく中断結果を返す", async () => {
    const pending = runReadyTransaction(reference, () => undefined);
    notify(existing);

    await expect(pending).resolves.toMatchObject({ committed: false });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("競合後の最新データを初期スナップショットで上書きせず更新関数へ渡す", async () => {
    const latest = { ...existing, revision: 2 };
    const update = vi.fn((value: typeof existing) => ({ ...value, revision: value.revision + 1 }));
    firebase.runTransaction.mockImplementation(async (
      _reference: DatabaseReference,
      guardedUpdate: (value: unknown) => unknown,
    ) => {
      guardedUpdate(existing);
      return transactionResult(guardedUpdate(latest));
    });
    const pending = runReadyTransaction(reference, update);
    notify(existing);

    expect((await pending).snapshot.val()).toEqual({ ...latest, revision: 3 });
    expect(update).toHaveBeenNthCalledWith(1, existing);
    expect(update).toHaveBeenNthCalledWith(2, latest);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("一度例外で中断した後は更新関数を再実行しない", async () => {
    const error = new Error("保存条件が変更されました。");
    const update = vi.fn(() => { throw error; });
    firebase.runTransaction.mockImplementation(async (
      _reference: DatabaseReference,
      guardedUpdate: (value: unknown) => unknown,
    ) => {
      expect(guardedUpdate(existing)).toBeUndefined();
      expect(guardedUpdate({ ...existing, revision: 2 })).toBeUndefined();
      return transactionResult(existing, false);
    });
    const pending = runReadyTransaction(reference, update);
    const assertion = expect(pending).rejects.toBe(error);
    notify(existing);

    await assertion;
    expect(update).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("undefinedをthrowした場合も正常なundefined返却と区別してエラー扱いにする", async () => {
    const pending = runReadyTransaction(reference, () => { throw undefined; });
    const assertion = expect(pending).rejects.toBeUndefined();
    notify(existing);

    await assertion;
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("実データが存在しない場所への新規登録はnullを使って正常に更新する", async () => {
    const update = vi.fn((value: unknown) => value ?? existing);
    firebase.runTransaction.mockImplementation(async (
      _reference: DatabaseReference,
      guardedUpdate: (value: unknown) => unknown,
    ) => transactionResult(guardedUpdate(null)));
    const pending = runReadyTransaction(reference, update);
    notify(null);

    expect((await pending).snapshot.val()).toEqual(existing);
    expect(update).toHaveBeenCalledExactlyOnceWith(null);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("初期読込の権限エラーは更新を開始せずに伝播し、監視を解除する", async () => {
    const error = new Error("PERMISSION_DENIED: Permission denied");
    const pending = runReadyTransaction(reference, (value) => value);
    const assertion = expect(pending).rejects.toBe(error);
    denyRead(error);

    await assertion;
    expect(firebase.runTransaction).not.toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("初期通知の直後に同一tickで読取権限を失った場合は更新を開始しない", async () => {
    const error = new Error("PERMISSION_DENIED: Permission denied");
    const pending = runReadyTransaction(reference, (value) => value);
    const assertion = expect(pending).rejects.toBe(error);
    notify(existing);
    denyRead(error);

    await assertion;
    expect(firebase.runTransaction).not.toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("競合再試行前に読取権限を失った場合は更新を中断して監視を解除する", async () => {
    const error = new Error("PERMISSION_DENIED: Permission denied");
    const update = vi.fn((value: typeof existing) => ({ ...value, status: "returned" }));
    const sdkCleanup = vi.fn();
    firebase.runTransaction.mockImplementation(async (
      _reference: DatabaseReference,
      guardedUpdate: (value: unknown) => unknown,
    ) => {
      expect(guardedUpdate(existing)).toEqual({ ...existing, status: "returned" });
      denyRead(error);
      expect(guardedUpdate({ ...existing, revision: 2 })).toBeUndefined();
      sdkCleanup();
      return transactionResult(existing, false);
    });
    const pending = runReadyTransaction(reference, update);
    const assertion = expect(pending).rejects.toBe(error);
    notify(existing);

    await assertion;
    expect(update).toHaveBeenCalledExactlyOnceWith(existing);
    expect(sdkCleanup).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("書込み成功が確定した後の監視側エラーだけで成功を失敗に変更しない", async () => {
    const completion = deferred<TransactionResult>();
    firebase.runTransaction.mockReturnValue(completion.promise);
    const pending = runReadyTransaction(reference, (value) => value);
    notify(existing);
    await Promise.resolve();
    expect(firebase.runTransaction).toHaveBeenCalledTimes(1);

    const result = transactionResult(existing);
    completion.resolve(result);
    denyRead(new Error("PERMISSION_DENIED: Permission denied"));

    await expect(pending).resolves.toBe(result);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("同期的な初期読込拒否でも監視を一度だけ解除する", async () => {
    const error = new Error("permission-denied");
    firebase.onValue.mockImplementation((
      _reference: DatabaseReference,
      _onValue: (value: DataSnapshot) => void,
      onError: (error: Error) => void,
    ) => {
      onError(error);
      return unsubscribe;
    });

    await expect(runReadyTransaction(reference, (value) => value)).rejects.toBe(error);
    expect(firebase.runTransaction).not.toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("読込監視の登録自体が失敗したときは更新を開始しない", async () => {
    const error = new Error("invalid reference");
    firebase.onValue.mockImplementation(() => { throw error; });

    await expect(runReadyTransaction(reference, (value) => value)).rejects.toBe(error);
    expect(firebase.runTransaction).not.toHaveBeenCalled();
  });

  it("初期通知が15秒間届かなければ更新せずタイムアウトし、遅い通知も無視する", async () => {
    vi.useFakeTimers();
    const pending = runReadyTransaction(reference, (value) => value);
    const assertion = expect(pending).rejects.toThrow("Firebaseサーバーから応答がありません");

    await vi.advanceTimersByTimeAsync(14_999);
    expect(firebase.runTransaction).not.toHaveBeenCalled();
    expect(unsubscribe).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    notify(existing);
    await Promise.resolve();
    expect(firebase.runTransaction).not.toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("書込み開始後は15秒を過ぎてもタイムアウトせず確定結果を待つ", async () => {
    vi.useFakeTimers();
    const completion = deferred<TransactionResult>();
    firebase.runTransaction.mockReturnValue(completion.promise);
    const pending = runReadyTransaction(reference, (value) => value);
    const settled = vi.fn();
    void pending.then(settled, settled);

    notify(existing);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(firebase.runTransaction).toHaveBeenCalledTimes(1);
    expect(settled).not.toHaveBeenCalled();
    expect(unsubscribe).not.toHaveBeenCalled();

    const result = transactionResult(existing);
    completion.resolve(result);
    await expect(pending).resolves.toBe(result);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("Firebaseの書込み失敗も元のエラーを伝播し、監視を解除する", async () => {
    const error = new Error("PERMISSION_DENIED: Permission denied");
    firebase.runTransaction.mockRejectedValue(error);
    const pending = runReadyTransaction(reference, (value) => value);
    const assertion = expect(pending).rejects.toBe(error);
    notify(existing);

    await assertion;
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("トランザクション開始自体が同期的に失敗しても監視を解除する", async () => {
    const error = new Error("transaction setup failed");
    firebase.runTransaction.mockImplementation(() => { throw error; });
    const pending = runReadyTransaction(reference, (value) => value);
    const assertion = expect(pending).rejects.toBe(error);
    notify(existing);

    await assertion;
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("指定された更新オプションとFirebaseの結果をそのまま維持する", async () => {
    const options: TransactionOptions = { applyLocally: true };
    const result = transactionResult(existing);
    firebase.runTransaction.mockResolvedValue(result);
    const pending = runReadyTransaction(reference, (value) => value, options);
    notify(existing);

    await expect(pending).resolves.toBe(result);
    expect(firebase.runTransaction.mock.calls[0][2]).toBe(options);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
