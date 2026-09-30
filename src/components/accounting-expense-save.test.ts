import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  return [element, ...elements(element.props.children as ReactNode)];
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
    .filter((row) => row.type === "button" && row.props.children === "保存");
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