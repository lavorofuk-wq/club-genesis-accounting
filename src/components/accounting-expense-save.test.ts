import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeMonthlyAdjustments, type MonthlyAdjustments } from "@/domain/gms";
import { buildMonthlySnapshot, calculateMonthlyAccounting, type AccountingWorkspaceData } from "@/domain/month-accounting";

const hooks = vi.hoisted(() => ({ refs: [] as unknown[], cursor: 0, effects: [] as Array<() => unknown>, drafts: new Map<string, unknown>() }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual,
    useRef: <T,>(initial: T) => {
      const index = hooks.cursor++;
      if (!(index in hooks.refs)) hooks.refs[index] = { current: initial };
      return hooks.refs[index];
    },
    useEffect: (effect: () => unknown) => { hooks.effects.push(effect); },
    useMemo: <T,>(factory: () => T) => factory(),
  };
});
vi.mock("./update-drafts", () => ({
  useRecoverableState: <T,>(key: string, initial: T | (() => T)) => {
    if (!hooks.drafts.has(key)) hooks.drafts.set(key, typeof initial === "function" ? (initial as () => T)() : initial);
    return [hooks.drafts.get(key), (value: T | ((old: T) => T)) => hooks.drafts.set(key, typeof value === "function" ? (value as (old: T) => T)(hooks.drafts.get(key) as T) : value)];
  },
  useUpdateDraftBusy: () => undefined,
}));
vi.mock("@/lib/firebase/repository", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/firebase/repository")>(),
  saveMonthlyAdjustments: vi.fn(),
}));
import { saveMonthlyAdjustments } from "@/lib/firebase/repository";
import { AccountingForms, Expenses, adjustmentSignature } from "./accounting-forms";
import { AccountingExpenseInputs } from "./accounting-expense-inputs";
import { Card, Field } from "./ui";

type Element = ReactElement<Record<string, any>>;
const month = "2026-09";
const base: MonthlyAdjustments = { month, revision: 3, withholdingByCast: {}, staffSalesAllowance: {}, staffBottleAllowance: {}, driverRemoteAllowance: {}, fixedExpenses: [], cardFee: 0 };
function fixture(adjustments: MonthlyAdjustments): AccountingWorkspaceData {
  return { casts: [], staff: [], drivers: [], introducers: [], liquor: [], closings: [], adjustments: [adjustments], cashFloat: 200000, archivedCasts: [], archivedStaff: [], introducerEntryEvents: [], introducerDeletionCommits: [], introducerMonthEvents: [], monthStates: [], monthSnapshots: [] };
}
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode), ...elements(element.props.action as ReactNode)];
}
const dirty = vi.fn();
const run = vi.fn(async (action: () => Promise<unknown>) => { await action(); return true; });
function render(data: AccountingWorkspaceData, busy = false) {
  hooks.cursor = 0; hooks.effects = [];
  const element = AccountingForms({ section: "expenses", data, user: { uid: "test" } as never, busy, run, onDirtyChange: dirty });
  const tree = (element.type as (props: typeof element.props) => ReactNode)(element.props);
  for (const effect of hooks.effects) effect();
  return tree;
}
beforeEach(() => { hooks.refs = []; hooks.drafts.clear(); hooks.drafts.set("accounting.monthly.month", month); dirty.mockClear(); run.mockClear(); vi.mocked(saveMonthlyAdjustments).mockReset().mockResolvedValue(undefined); });

describe("追加経費保存後の月次同期", () => {
  it("FirebaseのID順で明細が反転して返っても保存済みと認識して新revisionを採用する", () => {
    const data = fixture(base);
    render(data);
    const local: MonthlyAdjustments = { ...base, expenseInputs: [
      { id: "z_last", category: "supplies", payee: "先に追加", amount: 1000 },
      { id: "a_first", category: "transportOther", payee: "後で追加", amount: 500 },
    ] };
    hooks.drafts.set("accounting.monthly.adjustments", local);
    render(data);
    expect(dirty).toHaveBeenLastCalledWith(true);
    const server = normalizeMonthlyAdjustments({ ...base, revision: 4, expenseInputs: {
      a_first: local.expenseInputs![1], z_last: local.expenseInputs![0],
    } } as unknown as MonthlyAdjustments);
    expect(adjustmentSignature(local)).toBe(adjustmentSignature(server));
    expect(local.expenseInputs!.map((row) => row.id)).toEqual(["z_last", "a_first"]);
    const updated = fixture(server);
    render(updated);
    expect(hooks.drafts.get("accounting.monthly.adjustments")).toMatchObject({ revision: 4, expenseInputs: server.expenseInputs });
    const tree = render(updated);
    expect(dirty).toHaveBeenLastCalledWith(false);
    expect(elements(tree).some((row) => row.props.role === "alert")).toBe(false);
    const save = elements(tree).find((row) => row.type === "button" && row.props.children === "経理入力を保存");
    expect(save?.props.disabled).toBe(true);
  });

  it("順序変更と同時に別端末が金額を変更した場合はローカル未保存入力を保持する", () => {
    const data = fixture(base); render(data);
    const local: MonthlyAdjustments = { ...base, expenseInputs: [{ id: "input", category: "supplies", payee: "編集中", amount: 1000 }] };
    hooks.drafts.set("accounting.monthly.adjustments", local);
    render(data);
    const server: MonthlyAdjustments = { ...local, revision: 4, expenseInputs: [{ ...local.expenseInputs![0], amount: 1500 }] };
    const updated = fixture(server);
    render(updated);
    expect(hooks.drafts.get("accounting.monthly.adjustments")).toBe(local);
    const tree = render(updated);
    expect(dirty).toHaveBeenLastCalledWith(true);
    expect(elements(tree).some((row) => row.props.role === "alert")).toBe(true);
  });
});

function rowSaveButtons(tree: ReactNode): Element[] {
  const section = elements(tree).find((row) => row.type === Expenses);
  if (!section) throw new Error("経費画面が見つかりません。");
  const inputs = elements(Expenses(section.props as Parameters<typeof Expenses>[0])).find((row) => row.type === AccountingExpenseInputs);
  if (!inputs) throw new Error("経費入力が見つかりません。");
  return elements(AccountingExpenseInputs(inputs.props as Parameters<typeof AccountingExpenseInputs>[0]))
    .filter((row) => row.type === "button" && /^追加経費/.test(row.props["aria-label"] || "") && row.props.children === "保存");
}
function inputDraft(): MonthlyAdjustments {
  return { ...base, expenseInputs: [
    { id: "z_last", category: "supplies", payee: "先に追加", amount: 1000 },
    { id: "a_first", category: "transportOther", payee: "後で追加", amount: 500 },
  ] };
}

describe("削除横の保存ボタン", () => {
  it("どの行からでも編集中の月次経理入力を既存APIへ保存し、返却後は保存済みになる", async () => {
    const data = fixture(base); render(data);
    const local = { ...inputDraft(), cardFee: 800, fixedExpenses: [{ id: "fixed", account: "家賃", amount: 10000 }] };
    hooks.drafts.set("accounting.monthly.adjustments", local);
    const buttons = rowSaveButtons(render(data));
    expect(buttons).toHaveLength(2);
    expect(buttons.every((button) => button.props.disabled === false)).toBe(true);
    buttons[1].props.onClick();
    await vi.waitFor(() => expect(saveMonthlyAdjustments).toHaveBeenCalledExactlyOnceWith(local, { uid: "test" }));
    expect(run).toHaveBeenCalledWith(expect.any(Function), `${month}の経理入力を保存しました。`);
    const server = normalizeMonthlyAdjustments({ ...local, revision: 4, expenseInputs: {
      a_first: local.expenseInputs![1], z_last: local.expenseInputs![0],
    } } as unknown as MonthlyAdjustments);
    const updated = fixture(server); render(updated);
    expect(hooks.drafts.get("accounting.monthly.adjustments")).toMatchObject({ revision: 4 });
    const saved = rowSaveButtons(render(updated));
    expect(saved.every((button) => button.props.disabled === true)).toBe(true);
    saved[0].props.onClick();
    expect(saveMonthlyAdjustments).toHaveBeenCalledTimes(1);
  });

  it.each(["invalid", "stale", "closed", "closing", "busy", "unchanged"] as const)("%sではボタンとイベントの両方で保存を停止する", async (condition) => {
    const local = inputDraft();
    const data = fixture(condition === "unchanged" ? local : base);
    render(data);
    if (condition === "invalid") local.expenseInputs![0].payee = "";
    hooks.drafts.set("accounting.monthly.adjustments", local);
    if (condition === "stale") data.adjustments = [{ ...base, revision: 4 }];
    if (condition === "closed" || condition === "closing") {
      data.monthStates = [{ month, status: condition, revision: 1, currentSnapshotRevision: 1, updatedAt: "2026-09-30", updatedBy: "test" }];
      if (condition === "closed") data.monthSnapshots = [buildMonthlySnapshot(month, 1, "test", local, calculateMonthlyAccounting(data, month, local), [], "test", "2026-09-30T00:00:00.000Z")];
    }
    const tree = render(data, condition === "busy");
    const buttons = rowSaveButtons(tree);
    expect(buttons).toHaveLength(2);
    for (const button of buttons) { expect(button.props.disabled).toBe(true); button.props.onClick(); }
    // 上部の共通保存も、disabled属性を迂回しても書き込まない。
    const toolbarSave = elements(tree).find((row) => row.type === "button" && row.props.children === "経理入力を保存");
    toolbarSave?.props.onClick();
    expect(run).not.toHaveBeenCalled();
    expect(saveMonthlyAdjustments).not.toHaveBeenCalled();
  });

  it("最後の行を削除した後も上部から削除を保存できる", async () => {
    const stored = inputDraft(); const data = fixture(stored); render(data);
    const local = { ...stored, expenseInputs: [] };
    hooks.drafts.set("accounting.monthly.adjustments", local);
    const tree = render(data);
    expect(rowSaveButtons(tree)).toHaveLength(0);
    const toolbarSave = elements(tree).find((row) => row.type === "button" && row.props.children === "経理入力を保存");
    expect(toolbarSave?.props.disabled).toBe(false);
    toolbarSave!.props.onClick();
    await vi.waitFor(() => expect(saveMonthlyAdjustments).toHaveBeenCalledExactlyOnceWith(local, { uid: "test" }));
  });
});
function taxControls(tree: ReactNode) {
  const section = elements(tree).find((row) => row.type === Expenses);
  if (!section) throw new Error("経費画面が見つかりません。");
  const inputs = elements(Expenses(section.props as Parameters<typeof Expenses>[0])).find((row) => row.type === AccountingExpenseInputs);
  if (!inputs) throw new Error("経費入力が見つかりません。");
  const contents = elements(AccountingExpenseInputs(inputs.props as Parameters<typeof AccountingExpenseInputs>[0]));
  const field = contents.find((row) => row.type === Field && row.props.label === "預かり消費税率（％）");
  return { input: field?.props.children as Element | undefined,
    save: contents.find((row) => row.type === "button" && row.props["aria-label"] === "預かり消費税率を保存"),
    props: inputs.props as Parameters<typeof AccountingExpenseInputs>[0] };
}
afterEach(() => vi.unstubAllGlobals());

describe("選択月の預かり消費税率入力", () => {
  it.each([0, 0.29, 3.5, 10, 100])("経費0行でも%s%%を横の保存から対象月の入力として保存できる", async (rate) => {
    const data = fixture(base);
    const initial = taxControls(render(data));
    expect(initial.input?.props.value).toBe("3");
    expect(initial.save?.props.disabled).toBe(true);
    initial.input!.props.onChange({ target: { value: String(rate) } });
    const changed = taxControls(render(data));
    expect(changed.input?.props.value).toBe(String(rate));
    expect(changed.props.consumptionTaxRate).toBe(rate);
    expect(changed.save?.props.disabled).toBe(false);
    expect(dirty).toHaveBeenLastCalledWith(true);
    changed.save!.props.onClick();
    await vi.waitFor(() => expect(saveMonthlyAdjustments).toHaveBeenCalledExactlyOnceWith({ ...normalizeMonthlyAdjustments(base), consumptionTaxRate: rate }, { uid: "test" }));
    const updated = fixture({ ...base, revision: 4, consumptionTaxRate: rate });
    render(updated);
    const saved = taxControls(render(updated));
    expect(saved.save?.props.disabled).toBe(true);
    expect(dirty).toHaveBeenLastCalledWith(false);
    expect(hooks.drafts.get("accounting.monthly.adjustments")).toMatchObject({ revision: 4, consumptionTaxRate: rate });
  });

  it.each(["", ".", "0.", "3.555", "100.01", "-1", "NaN", "Infinity", "abc"])("入力途中・不正値『%s』を文字列のまま保持して全保存を止める", (text) => {
    const data = fixture(inputDraft());
    taxControls(render(data)).input!.props.onChange({ target: { value: text } });
    const tree = render(data);
    const edited = taxControls(tree);
    expect(edited.input?.props.value).toBe(text);
    expect(edited.input?.props["aria-invalid"]).toBe(true);
    expect(edited.save?.props.disabled).toBe(true);
    expect(dirty).toHaveBeenLastCalledWith(true);
    expect(hooks.drafts.get("accounting.monthly.adjustments")).toMatchObject({ consumptionTaxRateInput: text });
    expect((hooks.drafts.get("accounting.monthly.adjustments") as MonthlyAdjustments).consumptionTaxRate).toBeUndefined();
    edited.save!.props.onClick();
    for (const button of rowSaveButtons(tree)) { expect(button.props.disabled).toBe(true); button.props.onClick(); }
    elements(tree).find((row) => row.type === "button" && row.props.children === "経理入力を保存")!.props.onClick();
    expect(saveMonthlyAdjustments).not.toHaveBeenCalled();
  });

  it("小数入力を完成させても表示文字列を保ち、保存時は数値だけを渡す", async () => {
    const data = fixture(base);
    taxControls(render(data)).input!.props.onChange({ target: { value: "0." } });
    const pending = taxControls(render(data));
    expect(pending.input?.props.value).toBe("0.");
    pending.input!.props.onChange({ target: { value: "0.29" } });
    const completed = taxControls(render(data));
    expect(completed.input?.props["aria-invalid"]).toBe(false);
    expect(hooks.drafts.get("accounting.monthly.adjustments")).toHaveProperty("consumptionTaxRateInput", "0.29");
    completed.save!.props.onClick();
    await vi.waitFor(() => expect(saveMonthlyAdjustments).toHaveBeenCalledExactlyOnceWith({ ...normalizeMonthlyAdjustments(base), consumptionTaxRate: 0.29 }, { uid: "test" }));
  });

  it.each(["busy", "stale", "closing", "closed"] as const)("%sでは税率保存を停止し確定月の値はsnapshotから表示する", (condition) => {
    const data = fixture(base); render(data);
    const local = { ...base, consumptionTaxRate: 10 };
    hooks.drafts.set("accounting.monthly.adjustments", local);
    if (condition === "stale") data.adjustments = [{ ...base, revision: 4 }];
    if (condition === "closed" || condition === "closing") {
      data.monthStates = [{ month, status: condition, revision: 1, currentSnapshotRevision: 1, updatedAt: "2026-09-30", updatedBy: "test" }];
      if (condition === "closed") {
        const saved = { ...base, consumptionTaxRate: 3.5 };
        data.monthSnapshots = [buildMonthlySnapshot(month, 1, "test", saved, calculateMonthlyAccounting(data, month, saved), [], "test", "2026-09-30T00:00:00.000Z")];
      }
    }
    const controls = taxControls(render(data, condition === "busy"));
    expect(controls.input?.props.value).toBe(condition === "closed" ? "3.5" : "10");
    expect(controls.save?.props.disabled).toBe(true);
    controls.save!.props.onClick();
    if (condition !== "stale") {
      controls.input!.props.onChange({ target: { value: "5" } });
      expect(hooks.drafts.get("accounting.monthly.adjustments")).toBe(local);
    }
    expect(saveMonthlyAdjustments).not.toHaveBeenCalled();
  });

  it("月を変えるとその月の保存税率へ切り替わり、他月の税率を引き継がない", () => {
    const data = fixture({ ...base, consumptionTaxRate: 10 });
    data.adjustments.push({ ...base, month: "2026-10", consumptionTaxRate: 0.29 });
    expect(taxControls(render(data)).input?.props.value).toBe("10");
    hooks.drafts.set("accounting.monthly.month", "2026-10");
    render(data);
    expect(taxControls(render(data)).input?.props.value).toBe("0.29");
    expect(hooks.drafts.get("accounting.monthly.adjustments")).toMatchObject({ month: "2026-10", consumptionTaxRate: 0.29 });
    expect(saveMonthlyAdjustments).not.toHaveBeenCalled();
  });

  it("未保存税率の月移動には破棄確認を行いキャンセルで入力を保持する", () => {
    vi.stubGlobal("window", { confirm: vi.fn(() => false) });
    const data = fixture(base);
    taxControls(render(data)).input!.props.onChange({ target: { value: "0." } });
    const tree = render(data);
    const monthInput = elements(tree).find((row) => row.type === "input" && row.props.type === "month");
    monthInput!.props.onChange({ target: { value: "2026-10" } });
    expect(window.confirm).toHaveBeenCalledOnce();
    expect(hooks.drafts.get("accounting.monthly.month")).toBe(month);
    expect(taxControls(render(data)).input?.props.value).toBe("0.");
  });

  it("旧2.43の確定税率は3％表示、税がない旧2.42は入力欄も補完しない", () => {
    const data = fixture({ ...base, consumptionTaxRate: 10 });
    const snapshot = buildMonthlySnapshot(month, 1, "test", base, calculateMonthlyAccounting(data, month, base), [], "test", "2026-09-30T00:00:00.000Z");
    snapshot.calculationVersion = "2.43.0";
    delete snapshot.expenses.consumptionTaxRate;
    data.monthStates = [{ month, status: "closed", revision: 1, currentSnapshotRevision: 1, updatedAt: "2026-09-30", updatedBy: "test" }];
    data.monthSnapshots = [snapshot];
    const old = taxControls(render(data));
    expect(old.input?.props.value).toBe("3");
    expect(old.input?.props.disabled).toBe(true);
    expect(old.save?.props.disabled).toBe(true);
    snapshot.calculationVersion = "2.42.0";
    delete snapshot.expenses.consumptionTax;
    expect(taxControls(render(data)).input).toBeUndefined();
    expect(taxControls(render(data)).save).toBeUndefined();
    expect(saveMonthlyAdjustments).not.toHaveBeenCalled();
  });
});
describe("税率の連続入力", () => {
  it.each(["2.01", "0.01", "10.05"])("%sの小数先頭ゼロを再描画後も保持する", async (text) => {
    const data = fixture(base);
    taxControls(render(data)).input!.props.onChange({ target: { value: "" } });
    let entered = "";
    for (const character of text) {
      const controls = taxControls(render(data));
      entered += character;
      controls.input!.props.onChange({ target: { value: controls.input!.props.value + character } });
      expect(taxControls(render(data)).input?.props.value).toBe(entered);
    }
    const completed = taxControls(render(data));
    expect(completed.save?.props.disabled).toBe(false);
    completed.save!.props.onClick();
    await vi.waitFor(() => expect(saveMonthlyAdjustments).toHaveBeenCalledExactlyOnceWith({ ...normalizeMonthlyAdjustments(base), consumptionTaxRate: Number(text) }, { uid: "test" }));
    const updated = fixture({ ...base, revision: 4, consumptionTaxRate: Number(text) });
    render(updated);
    expect(hooks.drafts.get("accounting.monthly.adjustments")).not.toHaveProperty("consumptionTaxRateInput");
    expect(taxControls(render(updated)).save?.props.disabled).toBe(true);
  });
  it("既存税率3を3.00と入力しても未保存判定は変えず、計算・確定向けに文字列を出さない", () => {
    const data = fixture(base);
    taxControls(render(data)).input!.props.onChange({ target: { value: "3.00" } });
    const tree = render(data);
    expect(taxControls(tree).input?.props.value).toBe("3.00");
    expect(taxControls(tree).save?.props.disabled).toBe(true);
    expect(dirty).toHaveBeenLastCalledWith(false);
    const exportCard = elements(tree).find(row => row.props.input?.adjustments);
    expect(exportCard?.props.input.adjustments).not.toHaveProperty("consumptionTaxRateInput");
  });
});
function fixedControls(tree: ReactNode) {
  const section = elements(tree).find((row) => row.type === Expenses);
  if (!section) throw new Error("経費画面が見つかりません。");
  const card = elements(Expenses(section.props as Parameters<typeof Expenses>[0]))
    .find((row) => row.type === Card && row.props.title === "固定経費・月締め調整");
  if (!card) throw new Error("固定経費が見つかりません。");
  const contents = elements(card);
  return {
    contents,
    save: contents.find((row) => row.type === "button" && row.props.children === "固定経費を保存")!,
    add: contents.find((row) => row.type === "button" && row.props.children === "固定経費を追加")!,
    account: contents.find((row) => row.type === "select"),
    field: (label: string) => contents.find((row) => row.type === Field && row.props.label === label)?.props.children as Element,
  };
}

describe("固定経費セクションの保存", () => {
  it("追加・科目選択・金額入力から共通月次APIへ保存し、返却revisionで未保存を解除する", async () => {
    const data = fixture(base);
    const initial = fixedControls(render(data));
    expect(initial.save.props.disabled).toBe(true);
    initial.add.props.onClick();
    const pendingTree = render(data);
    const pending = fixedControls(pendingTree);
    expect(pending.account?.props.value).toBe("");
    expect(pending.save.props.disabled).toBe(true);
    expect(elements(pendingTree).some((row) => row.props.role === "alert" && row.props.children === "固定経費の科目と金額を確認してください。")).toBe(true);
    pending.save.props.onClick();
    expect(saveMonthlyAdjustments).not.toHaveBeenCalled();
    pending.account!.props.onChange({ target: { value: "賃料" } });
    fixedControls(render(data)).field("金額").props.onChange(80000);
    const ready = fixedControls(render(data));
    expect(ready.save.props.disabled).toBe(false);
    expect(dirty).toHaveBeenLastCalledWith(true);
    const local = hooks.drafts.get("accounting.monthly.adjustments") as MonthlyAdjustments;
    expect(local.fixedExpenses).toEqual([{ id: expect.any(String), account: "賃料", amount: 80000 }]);
    ready.save.props.onClick();
    await vi.waitFor(() => expect(saveMonthlyAdjustments).toHaveBeenCalledExactlyOnceWith(local, { uid: "test" }));
    const updated = fixture({ ...local, revision: 4 });
    render(updated);
    const saved = fixedControls(render(updated));
    expect(hooks.drafts.get("accounting.monthly.adjustments")).toMatchObject({ revision: 4 });
    expect(dirty).toHaveBeenLastCalledWith(false);
    expect(saved.save.props.disabled).toBe(true);
    saved.save.props.onClick();
    expect(saveMonthlyAdjustments).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["酒代納品書分（月締め後は確定解除して修正）", "liquorDeliveryAmount"],
    ["カード決済手数料", "cardFee"],
  ] as const)("固定経費0行でも%sだけ変更して同じセクションから保存できる", async (label, key) => {
    const data = fixture(base);
    fixedControls(render(data)).field(label).props.onChange(1234);
    const changed = fixedControls(render(data));
    expect(changed.account).toBeUndefined();
    expect(changed.save.props.disabled).toBe(false);
    changed.save.props.onClick();
    await vi.waitFor(() => expect(saveMonthlyAdjustments).toHaveBeenCalledExactlyOnceWith({ ...normalizeMonthlyAdjustments(base), [key]: 1234 }, { uid: "test" }));
  });

  it("最後の固定経費を削除した後もセクションの保存から空配列を保存する", async () => {
    const stored = { ...base, fixedExpenses: [{ id: "last", account: "家賃", amount: 80000 }] };
    const data = fixture(stored);
    const controls = fixedControls(render(data));
    controls.contents.find((row) => row.type === "button" && row.props.children === "削除")!.props.onClick();
    const deleted = fixedControls(render(data));
    expect(deleted.account).toBeUndefined();
    expect(deleted.save.props.disabled).toBe(false);
    deleted.save.props.onClick();
    await vi.waitFor(() => expect(saveMonthlyAdjustments).toHaveBeenCalledExactlyOnceWith({ ...normalizeMonthlyAdjustments(stored), fixedExpenses: [] }, { uid: "test" }));
  });

  it.each(["invalidExpense", "invalidTax", "blankFixed", "negativeFixed", "stale", "closed", "closing", "busy", "unchanged"] as const)("%sでは固定経費の保存イベントも停止する", (condition) => {
    const local: MonthlyAdjustments & { consumptionTaxRateInput?: string } = { ...inputDraft(), fixedExpenses: [{ id: "fixed", account: "賃料", amount: 8000 }] };
    const data = fixture(condition === "unchanged" ? local : base);
    render(data);
    if (condition === "invalidExpense") local.expenseInputs![0].payee = "";
    if (condition === "invalidTax") local.consumptionTaxRateInput = "2.";
    if (condition === "blankFixed") local.fixedExpenses[0].account = "";
    if (condition === "negativeFixed") local.fixedExpenses[0].amount = -1;
    hooks.drafts.set("accounting.monthly.adjustments", local);
    if (condition === "stale") data.adjustments = [{ ...base, revision: 4 }];
    if (condition === "closed" || condition === "closing") {
      data.monthStates = [{ month, status: condition, revision: 1, currentSnapshotRevision: 1, updatedAt: "2026-09-30", updatedBy: "test" }];
      if (condition === "closed") data.monthSnapshots = [buildMonthlySnapshot(month, 1, "test", local, calculateMonthlyAccounting(data, month, local), [], "test", "2026-09-30T00:00:00.000Z")];
    }
    const controls = fixedControls(render(data, condition === "busy"));
    expect(controls.save.props.disabled).toBe(true);
    controls.save.props.onClick();
    expect(run).not.toHaveBeenCalled();
    expect(saveMonthlyAdjustments).not.toHaveBeenCalled();
  });
});