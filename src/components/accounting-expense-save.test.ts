import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeMonthlyAdjustments, type MonthlyAdjustments } from "@/domain/gms";
import type { AccountingWorkspaceData } from "@/domain/month-accounting";

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
import { AccountingForms, adjustmentSignature } from "./accounting-forms";

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
function render(data: AccountingWorkspaceData) {
  hooks.cursor = 0; hooks.effects = [];
  const element = AccountingForms({ section: "expenses", data, user: { uid: "test" } as never, busy: false, run: async () => true, onDirtyChange: dirty });
  const tree = (element.type as (props: typeof element.props) => ReactNode)(element.props);
  for (const effect of hooks.effects) effect();
  return tree;
}
beforeEach(() => { hooks.refs = []; hooks.drafts.clear(); hooks.drafts.set("accounting.monthly.month", month); dirty.mockClear(); });

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
