import { createElement, useState, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { User } from "firebase/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountingExpenseInput, DailyClosing, MonthlyAdjustments } from "@/domain/gms";
import type { AccountingWorkspaceData, MonthlyAccountingResults } from "@/domain/month-accounting";

const drafts = vi.hoisted(() => new Map<string, unknown>());
vi.mock("./update-drafts", () => ({
  useRecoverableState: <T,>(key: string, initial: T | (() => T)) => useState<T>(() => drafts.has(key) ? drafts.get(key) as T : typeof initial === "function" ? (initial as () => T)() : initial),
  useUpdateDraftBusy: () => undefined,
}));
import { AccountingExpenseInputs } from "./accounting-expense-inputs";
import { AccountingForms, Expenses, adjustmentSignature } from "./accounting-forms";
import { Field, MoneyInput } from "./ui";

const month = "2026-09";
const first: AccountingExpenseInput = { id: "first", category: "supplies", payee: "備品追加", amount: 1200, businessDate: month + "-02" };
const second: AccountingExpenseInput = { id: "second", category: "transportOther", payee: "郵送代", amount: 430 };
const closings = [
  { id: "day1", businessDate: month + "-02", status: "approved" },
  { id: "day2", businessDate: month + "-28", status: "approved" },
  { id: "pending", businessDate: month + "-29", status: "submitted" },
  { id: "previous", businessDate: "2026-08-31", status: "approved" },
] as DailyClosing[];
const adjustments: MonthlyAdjustments = { month, withholdingByCast: {}, staffSalesAllowance: {}, staffBottleAllowance: {}, driverRemoteAllowance: {}, fixedExpenses: [{ id: "fixed", account: "家賃", amount: 80000 }], cardFee: 300, expenseInputs: [first, second] };
const results: MonthlyAccountingResults = {
  approvedDays: 2, castSalesReports: [], castRewards: [], introducerPayments: [], staffPayroll: [], driverPayroll: [], warnings: [],
  sales: { total: 100999, cash: 100999, card: 0 },
  expenses: { byCategory: { supplies: 1000 }, dailyExpenseTotal: 1000, dispatchCast: 0, dispatchStaff: 0, dispatchFee: 0, dispatchTotal: 0, liquorDelivery: 5000, fixed: 80000, cardFee: 300, accountingExpenseTotal: 1630, accountingExpenseInputs: [first, second], consumptionTax: 3029, total: 90959 },
  balance: { cast: 0, introducer: 0, staff: 0, driver: 0, expenses: 90959, totalCosts: 90959, profit: 10040 },
};
const noChange = () => undefined;
const noSave = async () => true;
type Element = ReactElement<Record<string, any>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode), ...elements(element.props.action as ReactNode)];
}
function find(node: ReactNode, predicate: (element: Element) => boolean) {
  const found = elements(node).find(predicate);
  if (!found) throw new Error("対象の入力がありません。");
  return found;
}
function field(node: ReactNode, label: string) {
  return find(node, (item) => item.type === Field && item.props.label === label).props.children as Element;
}
function form(rows = [first, second], disabled = false, onChange: Parameters<typeof AccountingExpenseInputs>[0]["onChange"] = noChange) {
  return AccountingExpenseInputs({ month, rows, closings, total: 1630, consumptionTax: 3029, consumptionTaxRate: 3, taxRateInput: "3", taxRateError: "", onTaxRateChange: noChange, disabled, saveDisabled: false, onSave: noSave, onChange });
}
beforeEach(() => drafts.clear());

describe("経理の追加経費入力", () => {
  it("既存科目で入力し、当月の承認済み日または日付なしを選択できる", () => {
    const markup = renderToStaticMarkup(form());
    expect(markup).toContain("営業日（任意）");
    expect(markup).toContain("編集中の経理入力をまとめて保存");
    expect((markup.match(/>削除<\/button><button[^>]*>保存<\/button>/g) || [])).toHaveLength(2);
    expect(markup).toContain("未指定（日付がない行に表示）");
    expect(markup).toContain('value="2026-09-02"');
    expect(markup).toContain('value="2026-09-28"');
    expect(markup).not.toContain("2026-09-29");
    expect(markup).not.toContain("2026-08-31");
    const category = field(form(), "勘定科目");
    expect(elements(category).filter((row) => row.type === "option").map((row) => row.props.value)).toEqual([
      "beautyTrial", "introduction", "advertising", "supplies", "entertainment", "liquor", "transportOther",
    ]);
    expect(markup).toContain("￥1,630");
    expect(markup).toContain("預かり消費税");
    expect(markup).toContain("￥3,029");
  });

  it("日付を持たない新規行を追加し、他の行と元配列を保って編集・削除する", () => {
    const original = structuredClone([first, second]);
    let rows = original;
    const onChange = (update: (value: AccountingExpenseInput[]) => AccountingExpenseInput[]) => { rows = update(rows); };
    find(form(rows, false, onChange), (node) => node.type === "button" && node.props.children === "経費を追加").props.onClick();
    expect(rows).toHaveLength(3);
    expect(rows[2].businessDate).toBeUndefined();
    expect(rows[2].id).toBeTruthy();
    expect(rows.slice(0, 2)).toEqual(original);
    field(form(rows, false, onChange), "支払先・内容").props.onChange({ target: { value: "備品購入" } });
    field(form(rows, false, onChange), "勘定科目").props.onChange({ target: { value: "advertising" } });
    find(form(rows, false, onChange), (node) => node.type === MoneyInput).props.onChange(2400);
    field(form(rows, false, onChange), "営業日（任意）").props.onChange({ target: { value: "" } });
    expect(rows[0]).toMatchObject({ id: first.id, category: "advertising", payee: "備品購入", amount: 2400 });
    expect(rows[0].businessDate).toBeUndefined();
    field(form(rows, false, onChange), "営業日（任意）").props.onChange({ target: { value: month + "-28" } });
    expect(rows[0].businessDate).toBe(month + "-28");
    expect(rows[1]).toEqual(second);
    find(form(rows, false, onChange), (node) => node.type === "button" && node.props["aria-label"] === "追加経費 1 を削除").props.onClick();
    expect(rows.map((row) => row.id)).not.toContain(first.id);
    expect(original).toEqual([first, second]);
  });

  it("確定中・確定済み・処理中はUIとイベントの両方で変更を防ぐ", () => {
    const onChange = vi.fn();
    const node = form([first], true, onChange);
    const markup = renderToStaticMarkup(node);
    expect(markup).toContain('<fieldset class="cast-input-fields" disabled=""');
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>経費を追加/);
    find(node, (item) => item.type === "button" && item.props.children === "経費を追加").props.onClick();
    find(node, (item) => item.type === "button" && item.props.children === "削除").props.onClick();
    field(node, "支払先・内容").props.onChange({ target: { value: "変更" } });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("承認取消後も指定日を保持して修正できる", () => {
    const markup = renderToStaticMarkup(form([{ ...first, businessDate: month + "-29" }]));
    expect(markup).toContain("2026-09-29（現在は対象外）");
    expect(markup).toContain('value="2026-09-29" selected=""');
  });

  it("追加経費の内容・指定日の変更と削除を未保存として検知する", () => {
    const base = adjustmentSignature(adjustments);
    for (const change of [{ category: "advertising" as const }, { payee: "別内容" }, { amount: 900 }, { businessDate: undefined }]) {
      expect(adjustmentSignature({ ...adjustments, expenseInputs: [{ ...first, ...change }, second] })).not.toBe(base);
    }
    expect(adjustmentSignature({ ...adjustments, expenseInputs: [first] })).not.toBe(base);
    expect(adjustmentSignature({ ...adjustments, expenseInputs: undefined })).toBe(adjustmentSignature({ ...adjustments, expenseInputs: [] }));
  });
});

describe("経費画面の月次入力との接続", () => {
  it("固定経費の直前に経費入力を表示し、店舗経費の金額を保つ", () => {
    const markup = renderToStaticMarkup(createElement(Expenses, { results, adjustments, closings, disabled: false, setAdjustments: noChange, saveDisabled: false, onSave: noSave }));
    expect(markup.indexOf("<h2>経費入力</h2>")).toBeLessThan(markup.indexOf("<h2>固定経費・月締め調整</h2>"));
    expect(markup).toContain('日次経費計 <strong>￥1,000</strong>');
    expect(markup).toContain('経費総合計 <strong>￥90,959</strong>');
    expect(markup).toContain("家賃");
    expect(markup).toContain('value="300"');
  });

  it("確定月は確定時の入力と税額を表示し、後から渡された入力で補完しない", () => {
    const markup = renderToStaticMarkup(createElement(Expenses, {
      results, adjustments: { ...adjustments, expenseInputs: [{ ...first, payee: "現在の別入力" }] }, closings,
      closed: true, disabled: true, setAdjustments: noChange, saveDisabled: false, onSave: noSave,
    }));
    expect(markup).toContain("備品追加");
    expect(markup).not.toContain("現在の別入力");
    expect(markup).toContain("￥3,029");
    const old = structuredClone(results);
    delete old.expenses.accountingExpenseInputs;
    delete old.expenses.accountingExpenseTotal;
    delete old.expenses.consumptionTax;
    const previous = renderToStaticMarkup(createElement(Expenses, { results: old, adjustments, closings, closed: true, disabled: true, setAdjustments: noChange, saveDisabled: false, onSave: noSave }));
    expect(previous).not.toContain("預かり消費税");
    expect(previous).not.toContain("備品追加");
    expect(previous).not.toContain("￥3,029");
    expect(previous).toContain('経費総合計 <strong>￥90,959</strong>');
  });

  it("未完成の退避入力でも画面を表示し、保存を止めて内容を保持する", () => {
    const data: AccountingWorkspaceData = { casts: [], staff: [], drivers: [], introducers: [], liquor: [], closings: [], adjustments: [], cashFloat: 200000, archivedCasts: [], archivedStaff: [], introducerEntryEvents: [], introducerDeletionCommits: [], introducerMonthEvents: [], monthStates: [], monthSnapshots: [] };
    drafts.set("accounting.monthly.month", month);
    drafts.set("accounting.monthly.adjustments", { ...adjustments, expenseInputs: [{ ...second, payee: "" }] });
    const run = vi.fn(async () => true);
    const markup = renderToStaticMarkup(createElement(AccountingForms, { section: "expenses", data, user: { uid: "test" } as User, busy: false, run }));
    expect(markup).toContain("支払先を入力してください");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>経理入力を保存/);
    expect(markup).toContain("<h2>経費入力</h2>");
    expect(markup).toContain('value="430"');
    expect(run).not.toHaveBeenCalled();
  });
});

describe("固定経費の科目選択", () => {
  const allowed = ["賃料", "カラオケ", "おしぼり", "リースキン", "固定電話", "西部ガス", "USEN"];
  const fixedForm = (fixedExpenses: MonthlyAdjustments["fixedExpenses"], disabled = false, setAdjustments: Parameters<typeof Expenses>[0]["setAdjustments"] = noChange) => Expenses({
    results, adjustments: { ...adjustments, fixedExpenses }, closings, disabled, saveDisabled: false, onSave: noSave, setAdjustments,
  });

  it("新規入力ではXLSXの7科目だけを選択でき、酒代とカード決済手数料は専用欄に残る", () => {
    const node = fixedForm([{ id: "new", account: "", amount: 0 }]);
    const select = field(node, "科目");
    expect(select.type).toBe("select");
    expect(select.props.value).toBe("");
    expect(elements(select).filter((row) => row.type === "option").map((row) => row.props.value)).toEqual(["", ...allowed]);
    expect(field(node, "酒代納品書分（月締め後は確定解除して修正）").type).toBe(MoneyInput);
    expect(field(node, "カード決済手数料").type).toBe(MoneyInput);
    expect(renderToStaticMarkup(node)).toContain("保存時は編集中の経理入力をまとめて保存します。");
  });

  it.each(["家賃", "酒代", "カード決済手数料", " ＵＳＥＮ ", "既存の自由科目"])("保存済み『%s』を変換せず既存科目として表示し、金額だけ編集できる", (account) => {
    const original = [{ id: "legacy", account, amount: 1234 }];
    let local = { ...adjustments, fixedExpenses: original };
    const setAdjustments: Parameters<typeof Expenses>[0]["setAdjustments"] = (update) => { local = typeof update === "function" ? update(local) : update; };
    const node = fixedForm(local.fixedExpenses, false, setAdjustments);
    const select = field(node, "科目");
    expect(select.props.value).toBe(account);
    const options = elements(select).filter((row) => row.type === "option");
    expect(options.map((row) => row.props.value)).toEqual(["", ...allowed, account]);
    expect(options.at(-1)?.props.children).toEqual([account, "（既存科目）"]);
    field(node, "金額").props.onChange(5678);
    expect(local.fixedExpenses).toEqual([{ id: "legacy", account, amount: 5678 }]);
    expect(original).toEqual([{ id: "legacy", account, amount: 1234 }]);
  });

  it("処理中・確定済みでは新規追加と科目変更をイベントでも停止する", () => {
    const onChange = vi.fn();
    const node = fixedForm([{ id: "fixed", account: "賃料", amount: 80000 }], true, onChange);
    const select = field(node, "科目");
    expect(select.props.disabled).toBe(true);
    select.props.onChange({ target: { value: "カラオケ" } });
    const add = find(node, (row) => row.type === "button" && row.props.children === "固定経費を追加");
    expect(add.props.disabled).toBe(true);
    add.props.onClick();
    expect(onChange).not.toHaveBeenCalled();
  });
});