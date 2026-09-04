import { afterEach, describe, expect, it, vi } from "vitest";
import { readOneShotValue } from "./one-shot-value";

describe("readOneShotValue", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("値を受信してlistenerを解除する", async () => {
    const unsubscribe = vi.fn();
    const result = await readOneShotValue<number>((onValue) => {
      queueMicrotask(() => onValue(125));
      return unsubscribe;
    });

    expect(result).toBe(125);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("同期通知でもlistenerを一度だけ解除する", async () => {
    const unsubscribe = vi.fn();
    const result = await readOneShotValue<number>((onValue) => {
      onValue(0);
      return unsubscribe;
    });

    expect(result).toBe(0);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("Firebaseエラーをそのまま返してlistenerを解除する", async () => {
    const unsubscribe = vi.fn();
    const firebaseError = new Error("permission-denied");
    const result = readOneShotValue<number>((_onValue, onError) => {
      queueMicrotask(() => onError(firebaseError));
      return unsubscribe;
    });

    await expect(result).rejects.toBe(firebaseError);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("未応答をタイムアウトしlistenerを解除する", async () => {
    vi.useFakeTimers();
    const unsubscribe = vi.fn();
    const result = readOneShotValue<number>(() => unsubscribe, 100);
    const assertion = expect(result).rejects.toThrow("Firebaseサーバーから応答がありません");

    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
