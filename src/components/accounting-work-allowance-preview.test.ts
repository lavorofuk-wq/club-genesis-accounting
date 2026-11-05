import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "firebase/auth";
import type { DailyCast, DailyClosing } from "@/domain/gms";
import type { AccountingWorkspaceData } from "@/domain/month-accounting";
import { calculateCashFunding, cashFundingContext } from "@/domain/cash-funding";

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, effects: [] as Array<() => void>, drafts: new Map<string, unknown>() }));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return { ...actual,
    useState<T>(initial: T | (() => T)) {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? (initial as () => T)() : initial;
      return [hooks.values[index] as T, (next: T | ((old: T) => T)) => {
        hooks.values[index] = typeof next === "function" ? (next as (old: T) => T)(hooks.values[index] as T) : next;
      }];
    },
    useEffect(effect: () => void) { hooks.effects.push(effect); },
    useMemo<T>(factory: () => T) { return factory(); },
  };
});
vi.mock("./update-drafts", () => ({
  useRecoverableState<T>(key: string, initial: T | (() => T)) {
    if (!hooks.drafts.has(key)) hooks.drafts.set(key, typeof initial === "function" ? (initial as () => T)() : initial);
    return [hooks.drafts.get(key) as T, (next: T) => hooks.drafts.set(key, next)];
  }, useUpdateDraftBusy() {},
}));
vi.mock("@/lib/firebase/repository", () => ({ approveClosing: vi.fn(), returnClosing: vi.fn() }));
import { AccountingForms, closingReviewKey } from "./accounting-forms";

const month = "2026-09", businessDate = `${month}-02`;
function fixture(): AccountingWorkspaceData {
  const cast = { id: "member", name: "花子", legalName: "", note: "", status: "active" as const, hourlyRates: { [month]: 3000 }, createdAt: "", updatedAt: "" };
  const row: DailyCast = { masterId: cast.id, posCastId: "pos-member", name: cast.name, kind: "regular", startTime: "20:00", endTime: "00:00", hours: 4, hourlyRate: 3000,
    honShimeiCount: 0, banaiShimeiCount: 0, dohanCount: 0, dohanBack: 0, honShimeiSales: 0, jonaiExtensionSales: 0, drinkSales: 0, drinkAllocations: [], bottles: [], liquorCost: 0,
    beautyAllowance: 0, transportFee: 0, dailyPayment: 3000, advancePayment: 0 };
  const funding = calculateCashFunding(cashFundingContext([], businessDate, 200000, "day-2"), { companyReplenishment: 0, personalReplenishment: 0, companyTransfer: 0 }, 5000, true);
  funding.schema = 2;
  const closing: DailyClosing = { id: "day-2", businessDate, status: "submitted", submissionId: "submitted", checksum: "a".repeat(64), updatedAt: `${businessDate}T12:00:00Z`,
    sales: { cashSales: 10000, cardSales: 5000, totalSales: 15000 }, customers: { groupCount: 1, totalCustomers: 2 }, nominations: { honShimeiCount: 0, jonaiCount: 0 },
    casts: [row, { ...row, masterId: "trial", posCastId: "pos-trial", name: "体入花子", kind: "trial", dailyPayment: 1500 }],
    staffWork: [], drivers: [{ driverId: "driver", name: "太郎", dailyRate: 10000, dailyPayment: 0 }],
    expenses: [{ id: "expense", category: "beautyTrial", personId: "trial", payee: "体入花子", amount: 500 }],
    staffDailyPaymentTotal: 0, dispatchStaffPayment: 0, dispatchCastPayment: 0, dispatchFee: 0, liquorDeliveryAmount: 0,
    cash: { cashSales: 10000, cardSales: 5000, totalSales: 15000, cashFloat: 200000, expenseAndPaymentTotal: 5000,
      expectedClosingCash: 205000, actualClosingCash: 205000, cashProfit: 5000, difference: 0, funding },
    posSnapshot: { transactions: [] } as unknown as DailyClosing["posSnapshot"] };
  return { casts: [cast], staff: [], drivers: [], introducers: [], liquor: [], closings: [closing], adjustments: [], cashFloat: 200000,
    archivedCasts: [], archivedStaff: [], introducerEntryEvents: [], introducerMonthEvents: [], introducerDeletionCommits: [], monthStates: [], monthSnapshots: [],
    beautyMonths: { [month]: { revision: 1, casts: { member: { [businessDate]: { eligible: true, attendanceClosingId: closing.id, attendanceIndex: 0, attendancePosCastId: row.posCastId } } } } },
    transportMonths: { [month]: { revision: 1, casts: { member: { [businessDate]: { amount: 1500, legacyInputIds: [], attendanceClosingId: closing.id, attendanceIndex: 0 } } },
      drivers: { driver: { [businessDate]: { entries: { first: 2000 }, attendanceClosingId: closing.id, attendanceIndex: 0 } } } } } };
}

type Element = ReactElement<Record<string, any>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children)];
}
const run = vi.fn(async () => true);
function renderOnce(data: AccountingWorkspaceData) {
  hooks.cursor = 0; hooks.effects = [];
  const component = AccountingForms({ section: "approval", data, user: { uid: "test" } as User, busy: false, run });
  const tree = (component.type as (props: typeof component.props) => ReactNode)(component.props);
  for (const effect of hooks.effects) effect();
  return tree;
}
function render(data: AccountingWorkspaceData) { renderOnce(data); return renderOnce(data); }
function detail(tree: ReactNode) {
  const component = elements(tree).find((element) => typeof element.type === "function" && element.type.name === "ClosingDetail")!;
  expect(component).toBeDefined();
  return (component.type as (props: typeof component.props) => ReactNode)(component.props);
}
function button(tree: ReactNode, label: string) {
  const result = elements(tree).find((element) => element.type === "button" && element.props.children === label);
  expect(result).toBeDefined(); return result!;
}
function castCells(tree: ReactNode, index = 0) {
  const rows = elements(detail(tree)).filter((element) => element.type === "tr" && element.key?.startsWith("pos-"));
  return renderToStaticMarkup(createElement("table", null, createElement("tbody", null, rows[index])));
}
beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.effects = []; hooks.drafts.clear();
  hooks.drafts.set("accounting.approval.expanded", "day-2"); run.mockClear();
});

describe("受信承認の美容室手当・送迎表示", () => {
  it("承認前に登録した美容室500円・送迎1500円を表示し、体入経費と現金・原本は変更しない", () => {
    const data = fixture(), before = structuredClone(data), tree = render(data);
    expect(castCells(tree)).toContain("美容室 ￥500");
    expect(castCells(tree)).toContain("送迎 ￥1,500");
    expect(castCells(tree, 1)).toContain("美容室 ￥0");
    const markup = renderToStaticMarkup(detail(tree));
    expect(markup).toContain("体入花子"); expect(markup).toContain("￥205,000");
    expect(markup).not.toContain("遠方手当"); expect(markup).not.toContain("￥2,000");
    expect(data).toEqual(before); expect(run).not.toHaveBeenCalled();
  });

  it("表示額を変更・取消しても確認済みと承認可能状態を維持する", () => {
    const data = fixture(), sourceKey = closingReviewKey(data.closings[0], data.closings);
    let tree = render(data);
    expect(button(tree, "承認").props.disabled).toBe(true);
    const review = button(detail(tree), "店舗・現金プレビューの全項目を確認済みにする");
    expect(review.props.disabled).toBe(false); review.props.onClick();
    tree = render(data); expect(button(tree, "承認").props.disabled).toBe(false);
    const changed = structuredClone(data);
    changed.beautyMonths![month].revision++;
    changed.beautyMonths![month].casts.member[businessDate].eligible = false;
    changed.transportMonths![month].revision++;
    changed.transportMonths![month].casts.member[businessDate].amount = 2000;
    tree = render(changed);
    expect(castCells(tree)).toContain("美容室 ￥0"); expect(castCells(tree)).toContain("送迎 ￥2,000");
    expect(button(detail(tree), "全項目を確認済み").props.disabled).toBe(true);
    expect(button(tree, "承認").props.disabled).toBe(false);
    changed.transportMonths![month].casts.member[businessDate].amount = 0;
    tree = render(changed);
    expect(castCells(tree)).toContain("送迎 ￥0"); expect(button(tree, "承認").props.disabled).toBe(false);
    expect(closingReviewKey(changed.closings[0], changed.closings)).toBe(sourceKey);
    expect(changed.closings).toEqual(data.closings); expect(run).not.toHaveBeenCalled();
  });

  it("承認済みの日次も最新額を表示し、承認状態は維持する", () => {
    const data = fixture(); data.closings[0].status = "approved";
    const before = structuredClone(data), tree = render(data);
    expect(castCells(tree)).toContain("美容室 ￥500"); expect(castCells(tree)).toContain("送迎 ￥1,500");
    expect(elements(tree).some((element) => element.type === "button" && element.props.children === "承認")).toBe(false);
    expect(data).toEqual(before); expect(run).not.toHaveBeenCalled();
  });

  it("人物や出勤元が不一致なら要確認を表示し、旧額や他人の額へ置き換えない", () => {
    const data = fixture(); data.beautyMonths![month].casts.member[businessDate].attendancePosCastId = "other-pos";
    data.transportMonths![month].casts.member[businessDate].attendanceIndex = 5;
    const before = structuredClone(data), tree = render(data);
    expect(castCells(tree)).toContain("美容室 要確認"); expect(castCells(tree)).toContain("送迎 要確認");
    expect(renderToStaticMarkup(detail(tree))).toContain("登録を確認してください");
    expect(data).toEqual(before);
  });

  it("現金・日次原本が変わった際の従来の再確認は引き続き必要", () => {
    const data = fixture(); let tree = render(data);
    button(detail(tree), "店舗・現金プレビューの全項目を確認済みにする").props.onClick();
    expect(button(render(data), "承認").props.disabled).toBe(false);
    const changed = structuredClone(data); changed.closings[0].updatedAt = `${businessDate}T13:00:00Z`;
    tree = render(changed);
    expect(button(tree, "承認").props.disabled).toBe(true);
    expect(button(detail(tree), "店舗・現金プレビューの全項目を確認済みにする").props.disabled).toBe(false);
  });
});
