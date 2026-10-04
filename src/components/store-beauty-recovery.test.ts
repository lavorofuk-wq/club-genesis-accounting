import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DailyCast, DailyClosing } from "@/domain/gms";

const state = vi.hoisted(() => ({ open: false }));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(), useState: () => [state.open, (next: boolean) => { state.open = next; }] }));
import { dailyBeautyDraftConflicts, DailyBeautyDraftRecovery, restoreDailyBeautyDraftRows } from "./store-work";
type Element = ReactElement<Record<string, any>>;
const cast = (id: string, beautyAllowance: number) => ({ masterId: id, posCastId: id, name: id, kind: "regular", beautyAllowance, transportFee: 500, dailyPayment: 1234, advancePayment: 2345, honShimeiSales: 123450, jonaiExtensionSales: 45670 }) as DailyCast;
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

describe("旧日次美容室手当下書きの回復", () => {
  it("初回未送信の旧下書きと原本同額の再編集は変更せず引き継ぐ", () => {
    const rows = [cast("あい", 500)];
    expect(dailyBeautyDraftConflicts(null, rows)).toEqual([]);
    expect(restoreDailyBeautyDraftRows(null, rows)).toEqual(rows);
    expect(dailyBeautyDraftConflicts(source(rows), rows)).toEqual([]);
    expect(DailyBeautyDraftRecovery({ conflicts: [], disabled: false, onRestore: vi.fn() })).toBeNull();
  });
  it("並べ替え後も本人の原本額だけ戻し、日払い・立替・送迎を保持する", () => {
    const first = cast("あい", 500), second = cast("べに", 0);
    const draft = [{ ...second, beautyAllowance: 500 }, { ...first, beautyAllowance: 0 }];
    const original = structuredClone(draft);
    expect(dailyBeautyDraftConflicts(source([first, second]), draft)).toEqual([
      { index: 0, name: "べに", draftAmount: 500, storedAmount: 0 },
      { index: 1, name: "あい", draftAmount: 0, storedAmount: 500 },
    ]);
    const restored = restoreDailyBeautyDraftRows(source([first, second]), draft);
    expect(restored).toEqual([{ ...draft[0], beautyAllowance: 0 }, { ...draft[1], beautyAllowance: 500 }]);
    expect(restored[0].dailyPayment).toBe(1234); expect(restored[0].advancePayment).toBe(2345); expect(restored[0].transportFee).toBe(500);
    expect(draft).toEqual(original);
  });
  it("確認取消では未保存入力を維持し、確認したときだけ原本へ戻す", () => {
    const conflicts = dailyBeautyDraftConflicts(source([cast("あい", 0)]), [cast("あい", 500)]);
    const restore = vi.fn(), render = () => DailyBeautyDraftRecovery({ conflicts, disabled: false, onRestore: restore });
    button(render(), "旧未保存の美容室手当を確認").props.onClick(); expect(state.open).toBe(true);
    button(render(), "入力を保持して戻る").props.onClick(); expect(state.open).toBe(false); expect(restore).not.toHaveBeenCalled();
    button(render(), "旧未保存の美容室手当を確認").props.onClick();
    button(render(), "原本の美容室手当へ戻す").props.onClick();
    expect(restore).toHaveBeenCalledOnce(); expect(state.open).toBe(false);
  });
  it("処理中・月次確定中は確認も復旧も止める", () => {
    const conflicts = dailyBeautyDraftConflicts(source([cast("あい", 0)]), [cast("あい", 500)]);
    const restore = vi.fn(), render = () => DailyBeautyDraftRecovery({ conflicts, disabled: true, onRestore: restore });
    button(render(), "旧未保存の美容室手当を確認").props.onClick(); expect(state.open).toBe(false);
    state.open = true; const confirm = button(render(), "原本の美容室手当へ戻す");
    expect(confirm.props.disabled).toBe(true); confirm.props.onClick(); expect(restore).not.toHaveBeenCalled();
  });
});
