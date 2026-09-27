import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  values: [] as unknown[], cursor: 0,
  receiptError: "", statementError: "",
  receiptSheets: [{ template: "hourlyAndBack", name: "花子", cells: { G8: 12000 }, statementCells: { F15: 500 } }],
  statementSheets: [{ template: "hourlyAndBack", name: "花子", cells: { G8: 12000 }, statementCells: { F15: 500 },
    statementAllowances: [{ label: "イベント手当", amount: 1234 }] }],
  receiptBuilder: vi.fn(), statementBuilder: vi.fn(), fill: vi.fn(), download: vi.fn(), busy: vi.fn(),
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: <T,>(initial: T) => {
      const index = harness.cursor++;
      if (!(index in harness.values)) harness.values[index] = initial;
      return [harness.values[index], (value: T) => { harness.values[index] = value; }];
    },
    useRef: <T,>(initial: T) => {
      const index = harness.cursor++;
      if (!(index in harness.values)) harness.values[index] = { current: initial };
      return harness.values[index];
    },
    useEffect: () => undefined,
    useMemo: <T,>(factory: () => T) => factory(),
  };
});
vi.mock("./update-drafts", () => ({ useUpdateDraftBusy: harness.busy }));
vi.mock("@/domain/cast-receipt", () => ({
  buildCastReceiptSheets: (...args: unknown[]) => {
    harness.receiptBuilder(...args);
    if (harness.receiptError) throw new Error(harness.receiptError);
    return harness.receiptSheets;
  },
  buildCastStatementSheets: (...args: unknown[]) => {
    harness.statementBuilder(...args);
    if (harness.statementError) throw new Error(harness.statementError);
    return harness.statementSheets;
  },
}));
vi.mock("@/lib/xlsx/receipt-template", () => ({
  RECEIPT_TEMPLATE_URL: "/receipt-template.xlsx",
  fillReceiptTemplate: harness.fill,
  downloadReceiptFile: harness.download,
}));
import { CastReceiptExport } from "./cast-receipt-export";

type Element = ReactElement<Record<string, any>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.action as ReactNode), ...elements(element.props.children as ReactNode)];
}
function button(node: ReactNode, name: string) {
  const result = elements(node).find((element) => element.type === "button" && element.props.children === name);
  if (!result) throw new Error("ボタンが見つかりません：" + name);
  return result;
}
const props = () => ({
  rows: [{ id: "cast" }] as never,
  reports: [{ id: "cast" }] as never,
  casts: [{ id: "cast", legalName: "本名" }],
  month: "2026-09", sourceLabel: "未確定", disabledReason: "",
});
function render(value = props()) { harness.cursor = 0; return CastReceiptExport(value); }
function notice(node: ReactNode) {
  return elements(node).find((element) => element.props.role === "status")?.props.children as string | undefined;
}
beforeEach(() => {
  vi.clearAllMocks(); harness.values = []; harness.cursor = 0;
  harness.receiptError = ""; harness.statementError = "";
  harness.fill.mockResolvedValue(new Uint8Array([1, 2, 3]));
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) }));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("受領書・明細書の独立検証と非同期出力", () => {
  it("明細の名目欠損で明細だけを止め、受領書の検証・出力を妨げない", async () => {
    const value = props(); harness.statementError = "手当名目が保存されていません";
    const tree = render(value);
    expect(button(tree, "受領書をXLSX出力").props.disabled).toBe(false);
    expect(button(tree, "明細書をXLSX出力").props.disabled).toBe(true);
    button(tree, "明細書をXLSX出力").props.onClick();
    expect(fetch).not.toHaveBeenCalled();
    button(tree, "受領書をXLSX出力").props.onClick();
    await vi.waitFor(() => expect(harness.download).toHaveBeenCalledOnce());
    expect(harness.fill).toHaveBeenCalledWith(expect.any(ArrayBuffer), harness.receiptSheets, "receipt");
    expect(harness.receiptBuilder).toHaveBeenCalledWith(value.rows, value.month, { cast: "本名" });
    expect(harness.statementBuilder).toHaveBeenCalledWith(value.rows, value.reports, value.month, { cast: "本名" });
  });

  it("明細書には名目別手当付きの明細用データだけを渡す", async () => {
    const value = props();
    button(render(value), "明細書をXLSX出力").props.onClick();
    await vi.waitFor(() => expect(harness.download).toHaveBeenCalledOnce());
    expect(harness.fill).toHaveBeenCalledWith(expect.any(ArrayBuffer), harness.statementSheets, "statement");
    expect(harness.download).toHaveBeenCalledWith(expect.any(Uint8Array), "GENESIS明細書_2026-09.xlsx");
    expect(notice(render(value))).toContain("在籍キャスト1名分出力");
  });

  it.each(["receipt", "statement"] as const)("出力中に売上明細だけ変わる場合：%sは依存する場合だけ停止", async (document) => {
    const value = props();
    let complete!: (bytes: Uint8Array) => void;
    harness.fill.mockReturnValue(new Promise<Uint8Array>((resolve) => { complete = resolve; }));
    button(render(value), document === "receipt" ? "受領書をXLSX出力" : "明細書をXLSX出力").props.onClick();
    await vi.waitFor(() => expect(harness.fill).toHaveBeenCalledOnce());
    const latest = { ...value, reports: [{ id: "changed" }] as never };
    render(latest);
    complete(new Uint8Array([1]));
    if (document === "statement") {
      await vi.waitFor(() => expect(notice(render(latest))).toContain("出力中に対象月または報酬データが更新"));
      expect(harness.download).not.toHaveBeenCalled();
    } else {
      await vi.waitFor(() => expect(harness.download).toHaveBeenCalledOnce());
    }
  });

  it.each(["receipt", "statement"] as const)("報酬そのものが更新されたら%sのダウンロードを止める", async (document) => {
    const value = props();
    let complete!: (bytes: Uint8Array) => void;
    harness.fill.mockReturnValue(new Promise<Uint8Array>((resolve) => { complete = resolve; }));
    button(render(value), document === "receipt" ? "受領書をXLSX出力" : "明細書をXLSX出力").props.onClick();
    await vi.waitFor(() => expect(harness.fill).toHaveBeenCalledOnce());
    const latest = { ...value, rows: [{ id: "updated" }] as never };
    render(latest);
    complete(new Uint8Array([1]));
    await vi.waitFor(() => expect(notice(render(latest))).toContain("出力中に対象月または報酬データが更新"));
    expect(harness.download).not.toHaveBeenCalled();
  });

  it("未保存・確定処理中などの共通停止理由は両方の出力を停止する", () => {
    const tree = render({ ...props(), disabledReason: "未保存の経理入力を保存してください。" });
    expect(button(tree, "受領書をXLSX出力").props.disabled).toBe(true);
    expect(button(tree, "明細書をXLSX出力").props.disabled).toBe(true);
    expect(harness.receiptBuilder).not.toHaveBeenCalled();
    expect(harness.statementBuilder).not.toHaveBeenCalled();
  });

  it("出力失敗後は処理中状態を解除して再試行できる", async () => {
    const value = props(); harness.fill.mockRejectedValueOnce(new Error("テンプレート不正"));
    button(render(value), "明細書をXLSX出力").props.onClick();
    await vi.waitFor(() => expect(notice(render(value))).toContain("テンプレート不正"));
    expect(harness.download).not.toHaveBeenCalled();
    expect(button(render(value), "明細書をXLSX出力").props.disabled).toBe(false);
    button(render(value), "受領書をXLSX出力").props.onClick();
    await vi.waitFor(() => expect(harness.download).toHaveBeenCalledOnce());
  });
});
