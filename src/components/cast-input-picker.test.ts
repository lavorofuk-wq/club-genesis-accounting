import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CastAccountingInput } from "@/domain/gms";
import type { AccountingWorkspaceData } from "@/domain/month-accounting";

// DOM を持たない Vitest でも操作時の最新 props・下書き保持を検証するイベントハーネス。
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, effects: [] as Array<() => unknown>, drafts: new Map<string, unknown>() }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: <T,>(initial: T | (() => T)) => {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? (initial as () => T)() : initial;
      return [hooks.values[index], (value: T | ((old: T) => T)) => { hooks.values[index] = typeof value === "function" ? (value as (old: T) => T)(hooks.values[index] as T) : value; }];
    },
    useRef: <T,>(initial: T) => {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = { current: initial };
      return hooks.values[index];
    },
    useEffect: (effect: () => unknown) => { hooks.effects.push(effect); },
    useMemo: <T,>(factory: () => T) => factory(),
    useId: () => "test-dialog",
  };
});
vi.mock("react-dom", () => ({ createPortal: (node: ReactNode) => node }));
vi.mock("./update-drafts", () => ({
  useRecoverableState: <T,>(key: string, initial: T) => {
    if (!hooks.drafts.has(key)) hooks.drafts.set(key, initial);
    return [hooks.drafts.get(key), (value: T | ((old: T) => T)) => hooks.drafts.set(key, typeof value === "function" ? (value as (old: T) => T)(hooks.drafts.get(key) as T) : value)];
  },
}));
vi.mock("@/lib/firebase/client", () => ({ isProductionEnvironment: () => false }));
vi.mock("@/lib/firebase/repository", () => ({ saveCastAccountingInputs: vi.fn() }));
import { CastAccountingInputs, castInputSourceKey } from "./cast-accounting-inputs";
import { saveCastAccountingInputs } from "@/lib/firebase/repository";
import { CastInputPicker, CastInputPickerTable, filterCastInputPickerRows } from "./cast-input-picker";

type Element = ReactElement<Record<string, any>>; // JSX callbacks are invoked deliberately by this harness.
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode)];
}
const find = (node: ReactNode, predicate: (element: Element) => boolean) => {
  const result = elements(node).find(predicate);
  if (!result) throw new Error("対象の要素がありません。");
  return result;
};
const button = (node: ReactNode, label: string) => find(node, (item) => item.type === "button" && item.props.children === label);
const month = "2026-09";
const entry: CastAccountingInput = { id: "entry", castId: "A", castName: "あい", kind: "sales", label: "未保存の名目", amount: 1000, businessDate: month + "-01" };
function fixture() {
  return {
    casts: [{ id: "A", name: "あい", status: "active" }, { id: "B", name: "べに", status: "active" }, { id: "C", name: "出勤なし", status: "active" }, { id: "T", name: "体入", status: "trial" }, { id: "R", name: "退店", status: "departed" }],
    archivedCasts: [], closings: [{ id: "day", businessDate: month + "-01", status: "approved", casts: [{ masterId: "A", kind: "regular", name: "あい" }, { masterId: "B", kind: "regular", name: "べに" }] }],
    adjustments: [{ month, revision: 2, castInputs: [entry] }], monthStates: [], monthSnapshots: [],
  } as unknown as AccountingWorkspaceData;
}
function renderForm(data = fixture(), busy = false, run: Parameters<typeof CastAccountingInputs>[0]["run"] = vi.fn(async () => true)) {
  hooks.cursor = 0; hooks.effects = [];
  const element = CastAccountingInputs({ data, user: { uid: "qa" } as never, busy, run });
  return (element.type as (props: typeof element.props) => ReactNode)(element.props);
}
function recover(data: AccountingWorkspaceData) {
  hooks.drafts.set("accounting.castInputs.selected", "A");
  hooks.drafts.set("accounting.castInputs.editing", { input: entry, amountText: "1007", revision: 2, context: castInputSourceKey(data, month) });
}
function picker(node: ReactNode) { return find(node, (item) => item.type === CastInputPicker); }
beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.effects = []; hooks.drafts.clear(); hooks.drafts.set("accounting.castInputs.month", month);
  vi.mocked(saveCastAccountingInputs).mockReset();
  vi.stubGlobal("window", { confirm: vi.fn(() => true) });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("キャスト選択・明細のイベント", () => {
  it("保存時に参照した月次版を渡し、他人の入力を保持する", async () => {
    const data = fixture();
    const other: CastAccountingInput = { ...entry, id: "other", castId: "B", castName: "べに", label: "他人の保存済み手当", kind: "allowance", amount: 700 };
    data.adjustments[0].castInputs!.push(other);
    recover(data);
    const run: Parameters<typeof CastAccountingInputs>[0]["run"] = vi.fn(async (action) => { await action(); return true; });
    button(renderForm(data, false, run), "この入力を保存").props.onClick();
    await vi.waitFor(() => expect(hooks.drafts.get("accounting.castInputs.editing")).toBeNull());
    expect(saveCastAccountingInputs).toHaveBeenCalledExactlyOnceWith(month, [other, entry], 2, { uid: "qa" });
    expect(data.adjustments[0].castInputs).toEqual([entry, other]);
  });
  it("保存が失敗した場合は入力内容と参照版を保持する", async () => {
    const data = fixture(); recover(data);
    const before = hooks.drafts.get("accounting.castInputs.editing");
    vi.mocked(saveCastAccountingInputs).mockRejectedValue(new Error("他の処理で更新されました"));
    const run: Parameters<typeof CastAccountingInputs>[0]["run"] = vi.fn(async (action) => { try { await action(); return true; } catch { return false; } });
    button(renderForm(data, false, run), "この入力を保存").props.onClick();
    await vi.waitFor(() => expect(saveCastAccountingInputs).toHaveBeenCalledOnce());
    expect(hooks.drafts.get("accounting.castInputs.editing")).toBe(before);
    expect(saveCastAccountingInputs).toHaveBeenCalledWith(month, [entry], 2, { uid: "qa" });
  });
  it.each(["busy", "closed", "stale"] as const)("%sでは保存イベント自体も書込みを実行しない", (condition) => {
    const data = fixture(); recover(data);
    const before = hooks.drafts.get("accounting.castInputs.editing");
    if (condition === "closed") data.monthStates = [{ month, status: "closed", revision: 1, updatedAt: "", updatedBy: "" }];
    if (condition === "stale") data.adjustments[0].revision = 3;
    const run: Parameters<typeof CastAccountingInputs>[0]["run"] = vi.fn(async (action) => { await action(); return true; });
    const saveButton = button(renderForm(data, condition === "busy", run), "この入力を保存");
    expect(saveButton.props.disabled).toBe(true);
    saveButton.props.onClick();
    expect(run).not.toHaveBeenCalled();
    expect(saveCastAccountingInputs).not.toHaveBeenCalled();
    expect(hooks.drafts.get("accounting.castInputs.editing")).toBe(before);
  });
  it("モーダルに現在の在籍者だけを渡し、承認済み本人出勤を集計する", () => {
    button(renderForm(), "キャストを選ぶ").props.onClick();
    const options = picker(renderForm()).props.rows;
    expect(options.map((row: { id: string }) => row.id).sort()).toEqual(["A", "B", "C"]);
    expect(options.find((row: { id: string }) => row.id === "A").attendanceDays).toBe(1);
    expect(options.find((row: { id: string }) => row.id === "C").attendanceDays).toBe(0);
  });
  it("開く・閉じる・同じキャストを選ぶ操作では下書きを変更しない", () => {
    const data = fixture(); recover(data);
    const before = hooks.drafts.get("accounting.castInputs.editing");
    button(renderForm(data), "キャストを変更").props.onClick();
    picker(renderForm(data)).props.onClose();
    expect(hooks.drafts.get("accounting.castInputs.editing")).toBe(before);
    button(renderForm(data), "キャストを変更").props.onClick();
    picker(renderForm(data)).props.onSelect("A");
    expect(elements(renderForm(data)).some((item) => item.type === CastInputPicker)).toBe(false);
    expect(hooks.drafts.get("accounting.castInputs.editing")).toBe(before);
    expect(window.confirm).not.toHaveBeenCalled();
  });
  it("別キャスト変更の確認を取消したらモーダルと下書きの両方を保持する", () => {
    const data = fixture(); recover(data); vi.mocked(window.confirm).mockReturnValue(false);
    const before = hooks.drafts.get("accounting.castInputs.editing");
    button(renderForm(data), "キャストを変更").props.onClick();
    picker(renderForm(data)).props.onSelect("B");
    expect(window.confirm).toHaveBeenCalledOnce();
    expect(picker(renderForm(data)).props.selected).toBe("A");
    expect(hooks.drafts.get("accounting.castInputs.editing")).toBe(before);
    vi.mocked(window.confirm).mockReturnValue(true);
    picker(renderForm(data)).props.onSelect("B");
    expect(hooks.drafts.get("accounting.castInputs.selected")).toBe("B");
    expect(hooks.drafts.get("accounting.castInputs.editing")).toBeNull();
    expect(elements(renderForm(data)).some((item) => item.type === CastInputPicker)).toBe(false);
  });
  it.each(["no-work", "departed", "returned", "closed", "busy"])("選択直前の%s更新で選択できなくても下書きを保持して閉じられる", (change) => {
    const data = fixture(); recover(data);
    const before = hooks.drafts.get("accounting.castInputs.editing");
    button(renderForm(data), "キャストを変更").props.onClick();
    let castId = "B";
    if (change === "no-work") castId = "C";
    if (change === "departed") data.casts[1].status = "departed";
    if (change === "returned") data.closings[0].status = "returned";
    if (change === "closed") data.monthStates = [{ month, status: "closed", revision: 1, updatedAt: "", updatedBy: "" }];
    const latest = picker(renderForm(data, change === "busy"));
    latest.props.onSelect(castId);
    expect(hooks.drafts.get("accounting.castInputs.selected")).toBe("A");
    expect(hooks.drafts.get("accounting.castInputs.editing")).toBe(before);
    latest.props.onClose();
    expect(elements(renderForm(data, change === "busy")).some((item) => item.type === CastInputPicker)).toBe(false);
    expect(window.confirm).not.toHaveBeenCalled();
  });
  it("明細を開閉しても入力対象・下書き・保存済み配列を変更しない", () => {
    const data = fixture(), before = structuredClone(data.adjustments);
    let tree = renderForm(data);
    const detail = find(tree, (item) => item.type === "button" && item.props["aria-label"] === "あいの明細を表示");
    detail.props.onClick();
    tree = renderForm(data);
    expect(button(tree, "編集").props.disabled).toBe(false);
    expect(elements(tree).some((item) => item.props.children === "未保存の名目")).toBe(true);
    find(tree, (item) => item.type === "button" && item.props["aria-label"] === "あいの明細を閉じる").props.onClick();
    expect(elements(renderForm(data)).some((item) => item.type === "button" && item.props.children === "編集")).toBe(false);
    expect(hooks.drafts.get("accounting.castInputs.selected")).toBe("");
    expect(data.adjustments).toEqual(before);
  });
});

describe("選択モーダルの検索・キーボード保護", () => {
  const rows = [{ id: "A", name: "Ａｉ", attendanceDays: 2 }, { id: "B", name: "出勤なし", attendanceDays: 0 }];
  it("全半角・大文字小文字・前後空白を吸収して名前で絞る", () => {
    expect(filterCastInputPickerRows(rows, " ai ")).toEqual([rows[0]]);
    expect(filterCastInputPickerRows(rows, "該当なし")).toEqual([]);
  });
  it("出勤なし・busyを選択不可にし、現在の選択を伝える", () => {
    const table = CastInputPickerTable({ rows, selected: "A", disabled: false, onSelect: vi.fn() });
    expect(button(table, "選択中").props["aria-pressed"]).toBe(true);
    expect(button(table, "選択").props.disabled).toBe(true);
    const locked = CastInputPickerTable({ rows, selected: "A", disabled: true, onSelect: vi.fn() });
    expect(button(locked, "選択中").props.disabled).toBe(true);
  });
  function mount(busy = false) {
    class FocusTarget {
      isConnected = true;
      focus = vi.fn(() => { Object.defineProperty(document, "activeElement", { value: this, configurable: true }); });
    }
    vi.stubGlobal("HTMLElement", FocusTarget);
    const opener = new FocusTarget(), close = new FocusTarget(), search = new FocusTarget(), footer = new FocusTarget();
    const dialog = { showModal: vi.fn(), close: vi.fn(), querySelectorAll: () => [close, search, footer] };
    vi.stubGlobal("document", { activeElement: opener, body: { style: { overflow: "auto" } } });
    hooks.cursor = 0; hooks.effects = [];
    const onClose = vi.fn(), onSelect = vi.fn();
    const tree = CastInputPicker({ month, rows, selected: "A", disabled: false, busy, onSelect, onClose });
    (hooks.values[1] as { current: unknown }).current = dialog;
    (hooks.values[2] as { current: unknown }).current = search;
    const cleanup = hooks.effects[0]() as () => void;
    return { tree: tree as Element, opener, close, search, footer, dialog, cleanup, onClose };
  }
  it("native dialogで背景操作を止め、検索へ焦点移動し、閉じたら元の焦点・スクロールを戻す", () => {
    const result = mount();
    expect(result.dialog.showModal).toHaveBeenCalledOnce();
    expect(result.search.focus).toHaveBeenCalledOnce();
    expect(document.body.style.overflow).toBe("hidden");
    result.cleanup();
    expect(result.dialog.close).toHaveBeenCalledOnce();
    expect(document.body.style.overflow).toBe("auto");
    expect(result.opener.focus).toHaveBeenCalledOnce();
  });
  it("Tab/Shift+Tabはモーダルの最終・先頭で循環する", () => {
    const result = mount();
    const preventDefault = vi.fn();
    result.footer.focus();
    result.tree.props.onKeyDown({ key: "Tab", shiftKey: false, currentTarget: result.dialog, preventDefault });
    expect(result.close.focus).toHaveBeenCalledOnce();
    result.tree.props.onKeyDown({ key: "Tab", shiftKey: true, currentTarget: result.dialog, preventDefault });
    expect(result.footer.focus).toHaveBeenCalledTimes(2);
    expect(preventDefault).toHaveBeenCalledTimes(2);
  });
  it.each([false, true])("busy=%sでもEscape・閉じるで背景の更新操作へ戻れる", (busy) => {
    const result = mount(busy), preventDefault = vi.fn();
    result.tree.props.onCancel({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(result.onClose).toHaveBeenCalledOnce();
    expect(button(result.tree, "閉じる").props.disabled).toBeUndefined();
    button(result.tree, "閉じる").props.onClick();
    expect(result.onClose).toHaveBeenCalledTimes(2);
    const table = find(result.tree, (item) => item.type === CastInputPickerTable);
    expect(table.props.disabled).toBe(busy);
  });
  it("内容内のクリックでは閉じず、背景クリックだけ閉じる", () => {
    const result = mount();
    const target = { getBoundingClientRect: () => ({ left: 100, right: 700, top: 100, bottom: 700 }) };
    result.tree.props.onClick({ target, currentTarget: target, clientX: 300, clientY: 300 });
    expect(result.onClose).not.toHaveBeenCalled();
    result.tree.props.onClick({ target, currentTarget: target, clientX: 20, clientY: 20 });
    expect(result.onClose).toHaveBeenCalledOnce();
  });
});
