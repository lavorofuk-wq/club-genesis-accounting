import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DailyCast, DailyClosing } from "@/domain/gms";

const state = vi.hoisted(() => ({ open: false }));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(), useState: () => [state.open, (next: boolean) => { state.open = next; }] }));
import { dailyTransportDraftConflicts, DailyTransportDraftRecovery, restoreDailyTransportDraftRows } from "./store-work";
type Element = ReactElement<Record<string, any>>;
const cast = (id: string, amount: number) => ({ masterId: id, posCastId: id, name: id, kind: "regular", transportFee: amount, dailyPayment: 1234, advancePayment: 2345, honShimeiSales: 123450, jonaiExtensionSales: 45670 }) as DailyCast;
const source = (casts: DailyCast[]) => ({ id: "source", casts }) as DailyClosing;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const item = node as Element; return [item, ...elements(item.props.children)];
}
function button(node: ReactNode, label: string) {
  const value = elements(node).find((item) => item.type === "button" && item.props.children === label);
  if (!value) throw new Error("ボタンがありません: " + label); return value;
}
beforeEach(() => { state.open = false; });

describe("旧日次送迎下書きの回復", () => {
  it("初回送信の旧下書きと、原本と同額の再編集は変更対象にしない", () => {
    const rows = [cast("あい", 1500)];
    expect(dailyTransportDraftConflicts(null, rows)).toEqual([]);
    expect(dailyTransportDraftConflicts(source(rows), rows)).toEqual([]);
    expect(DailyTransportDraftRecovery({ conflicts: [], disabled: false, onRestore: vi.fn() })).toBeNull();
  });
  it("出勤配列が並び替わっていても本人の原本額を示し、他の入力を変更しない", () => {
    const first = cast("あい", 500), second = cast("べに", 1000);
    const draft = [{ ...second, transportFee: 2000 }, { ...first, transportFee: 1500 }];
    const original = structuredClone(draft);
    expect(dailyTransportDraftConflicts(source([first, second]), draft)).toEqual([
      { index: 0, name: "べに", draftAmount: 2000, storedAmount: 1000 },
      { index: 1, name: "あい", draftAmount: 1500, storedAmount: 500 },
    ]);
    const restored = restoreDailyTransportDraftRows(source([first, second]), draft);
    expect(restored).toEqual([{ ...draft[0], transportFee: 1000 }, { ...draft[1], transportFee: 500 }]);
    expect(restored[0].dailyPayment).toBe(1234); expect(restored[0].advancePayment).toBe(2345);
    expect(draft).toEqual(original);
  });
  it("システム内確認を取消した場合は入力を保持し、確認後にだけ回復する", () => {
    const conflicts = dailyTransportDraftConflicts(source([cast("あい", 500)]), [cast("あい", 1500)]);
    const restore = vi.fn();
    const render = (disabled = false) => DailyTransportDraftRecovery({ conflicts, disabled, onRestore: restore });
    button(render(), "旧未保存の送迎入力を確認").props.onClick();
    expect(state.open).toBe(true); expect(restore).not.toHaveBeenCalled();
    button(render(), "入力を保持して戻る").props.onClick();
    expect(state.open).toBe(false); expect(restore).not.toHaveBeenCalled();
    button(render(), "旧未保存の送迎入力を確認").props.onClick();
    button(render(), "原本の送迎額へ戻す").props.onClick();
    expect(restore).toHaveBeenCalledOnce(); expect(state.open).toBe(false);
  });
  it("処理中・月次確定後は確認を開く操作と確認済み操作の両方を止める", () => {
    const conflicts = dailyTransportDraftConflicts(source([cast("あい", 500)]), [cast("あい", 1500)]);
    const restore = vi.fn();
    const render = () => DailyTransportDraftRecovery({ conflicts, disabled: true, onRestore: restore });
    button(render(), "旧未保存の送迎入力を確認").props.onClick();
    expect(state.open).toBe(false);
    state.open = true;
    const confirm = button(render(), "原本の送迎額へ戻す");
    expect(confirm.props.disabled).toBe(true); confirm.props.onClick();
    expect(restore).not.toHaveBeenCalled();
  });
});
