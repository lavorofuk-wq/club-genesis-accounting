import ExcelJS from "exceljs/dist/exceljs.min.js";
import { describe, expect, it } from "vitest";
import type { CastReward, DailyClosing, ExpenseCategory, MonthlyAdjustments } from "@/domain/gms";
import type { ExpenseExportInput } from "@/domain/expense-export";
import type { MonthlyAccountingResults } from "@/domain/month-accounting";
import { createMonthlyExpenseWorkbook } from "./expenses";

const month = "2026-09";

function reward(id: string, adoptedSystem: CastReward["adoptedSystem"], amount: number, beautyAllowance: number): CastReward {
  return {
    id, name: id, days: 1, advisoryDays: 1, hours: 4, trialOnly: false,
    hourlyPay: 12000, honShimeiSales: 1400000, jonaiExtensionSales: 0,
    liquorCost: 0, honShimeiLiquorCost: 0,
    honShimeiBack: 1000, banaiShimeiBack: 500, dohanBack: 0, bottleBack: 0, drinkBack: 0,
    hourlyAndBack: 13500, rewardRate: .6, salesRewardBase: 1400000,
    salesReward: adoptedSystem === "salesReward" ? amount : 0,
    adoptedSystem, adoptedReward: amount, beautyAllowance, grossPay: amount + beautyAllowance,
    dailyPayment: 1000, advancePayment: 2000, transportFee: 500, withholding: 123,
    netPay: amount + beautyAllowance - 3623,
  };
}

function closing(): DailyClosing {
  const categories: ExpenseCategory[] = ["liquor", "introduction", "advertising", "supplies", "entertainment", "transportOther", "beautyTrial"];
  return {
    id: "closing-1", businessDate: "2026-09-02", status: "approved", submissionId: "submission-1", checksum: "a".repeat(64),
    sales: { cashSales: 100000, cardSales: 200000, totalSales: 300000 },
    customers: { groupCount: 0, totalCustomers: 0 }, nominations: { honShimeiCount: 0, jonaiCount: 0 },
    casts: [], staffWork: [], drivers: [],
    expenses: categories.map((category, i) => ({ id: category, category, payee: `${category}支払先`, amount: 101 * (i + 1) })),
    staffDailyPaymentTotal: 99999, dispatchStaffPayment: 1010, dispatchCastPayment: 909, dispatchFee: 808,
    liquorDeliveryAmount: 1111,
    cash: {
      cashSales: 100000, cardSales: 200000, totalSales: 300000, cashFloat: 200000,
      expenseAndPaymentTotal: 0, expectedClosingCash: 300000, cashProfit: 100000, actualClosingCash: 300000, difference: 0,
    },
    posSnapshot: { transactions: [] } as unknown as DailyClosing["posSnapshot"],
    approvedAt: "2026-09-03T03:00:00.000Z", approvedBy: "accounting-user", updatedAt: "2026-09-03T03:00:00.000Z",
  };
}

function refresh(data: ExpenseExportInput): ExpenseExportInput {
  const approved = data.closings.filter((row) => row.status === "approved" && row.businessDate.startsWith(`${data.month}-`));
  const sum = <T,>(rows: T[], value: (row: T) => number) => rows.reduce((total, row) => total + value(row), 0);
  const byCategory: Record<string, number> = {};
  approved.flatMap((row) => row.expenses).forEach((expense) => { byCategory[expense.category] = (byCategory[expense.category] || 0) + expense.amount; });
  const dailyExpenseTotal = sum(Object.values(byCategory), (value) => value);
  const dispatchCast = sum(approved, (row) => row.dispatchCastPayment);
  const dispatchStaff = sum(approved, (row) => row.dispatchStaffPayment);
  const dispatchFee = sum(approved, (row) => row.dispatchFee);
  const dispatchTotal = dispatchCast + dispatchStaff + dispatchFee;
  const liquorDelivery = data.adjustments.liquorDeliveryAmount ?? sum(approved, (row) => row.liquorDeliveryAmount);
  const fixed = sum(data.adjustments.fixedExpenses, (row) => row.amount);
  const cardFee = data.adjustments.cardFee;
  data.results.approvedDays = approved.length;
  data.results.expenses = { byCategory, dailyExpenseTotal, dispatchCast, dispatchStaff, dispatchFee, dispatchTotal, liquorDelivery, fixed, cardFee, total: dailyExpenseTotal + dispatchTotal + liquorDelivery + fixed + cardFee };
  const cash = sum(approved, (row) => row.sales.cashSales);
  const card = sum(approved, (row) => row.sales.cardSales);
  data.results.sales = { cash, card, total: cash + card };
  const cast = sum(data.results.castRewards, (row) => row.grossPay);
  const introducer = sum(data.results.introducerPayments, (row) => row.total);
  const staff = sum(data.results.staffPayroll, (row) => row.gross);
  const driver = sum(data.results.driverPayroll, (row) => row.gross);
  const expenses = data.results.expenses.total;
  const totalCosts = cast + introducer + staff + driver + expenses;
  data.results.balance = { cast, introducer, staff, driver, expenses, totalCosts, profit: data.results.sales.total - totalCosts };
  return data;
}

function input(): ExpenseExportInput {
  const adjustments: MonthlyAdjustments = {
    month, withholdingByCast: {}, staffSalesAllowance: {}, staffBottleAllowance: {}, driverRemoteAllowance: {},
    fixedExpenses: [{ id: "rent", account: "賃料", amount: 1300 }], cardFee: 1212,
    liquorDeliveryAmount: 2222, legacyBottleClassifications: {}, revision: 1,
    updatedAt: "2026-09-30T12:00:00.000Z", updatedBy: "accounting-user",
  };
  const results: MonthlyAccountingResults = {
    approvedDays: 0, castSalesReports: [],
    castRewards: [reward("時給キャスト", "hourlyAndBack", 13500, 500), reward("売上キャスト", "salesReward", 70000, 1000)],
    introducerPayments: [{ id: "intro-1", introducer: "紹介者A", cast: "時給キャスト", feeType: "sales10", honShimeiLiquorCost: 0, salesBase: 44000, salesFee: 4400, grossBase: 14000, grossFee: 1400, adopted: "売上10%", attendanceAdvisory: 11, entryAdvisory: 33, advisory: 44, total: 4444 }],
    staffPayroll: [{ id: "staff-1", name: "スタッフA", hours: 1, hourly: 2000, sales: 100, bottle: 100, gross: 2200, daily: 1000, net: 1200 }],
    driverPayroll: [{ id: "driver-1", name: "ドライバーA", days: 1, basic: 3000, remote: 300, gross: 3300, dailyPayment: 1000, net: 2300 }],
    expenses: { byCategory: {}, dailyExpenseTotal: 0, dispatchCast: 0, dispatchStaff: 0, dispatchFee: 0, dispatchTotal: 0, liquorDelivery: 0, fixed: 0, cardFee: 0, total: 0 },
    sales: { cash: 0, card: 0, total: 0 },
    balance: { cast: 0, introducer: 0, staff: 0, driver: 0, expenses: 0, totalCosts: 0, profit: 0 }, warnings: [],
  };
  return refresh({ month, adjustments, results, closings: [closing()] });
}

function value(sheet: ExcelJS.Worksheet, address: string): unknown {
  const cell = sheet.getCell(address);
  return cell.type === ExcelJS.ValueType.Formula ? cell.result : cell.value;
}

function unmergedCells(sheet: ExcelJS.Worksheet) {
  const cells: ExcelJS.Cell[] = [];
  sheet.eachRow((row) => row.eachCell((cell) => {
    if (!cell.isMerged || cell.master.address === cell.address) cells.push(cell);
  }));
  return cells;
}

describe("見本形式の月次経費XLSX", () => {
  it("指定の経費分類・支払先・日別金額を見本の列へ正確に出力する", () => {
    const data = input();
    const book = createMonthlyExpenseWorkbook(data, "承認済みデータ（未確定）");
    const sheet = book.worksheets[0];
    expect(sheet.name).toBe("ジェネシス経費表");
    expect(book.worksheets).toHaveLength(1);
    expect(sheet.getCell("G1").value).toBe("2026年");
    expect(sheet.getCell("H1").value).toBe("9月度");
    expect(sheet.getCell("A4").value).toBe(2);
    const columns = [["B", "C", "liquor", "酒代", 101], ["D", "E", "introduction", "広告宣伝①", 202], ["F", "G", "advertising", "広告宣伝②", 303], ["H", "I", "supplies", "消耗品/備品", 404], ["J", "K", "entertainment", "交際費", 505], ["L", "M", "transportOther", "交通費", 606], ["P", "Q", "beautyTrial", "美容室", 707]] as const;
    for (const [label, amount, category, header, expected] of columns) {
      expect(sheet.getCell(`${label}2`).value).toBe(header);
      expect(sheet.getCell(`${label}4`).value).toContain(`${category}支払先`);
      expect(value(sheet, `${amount}4`)).toBe(expected);
      expect(sheet.getCell(`${amount}34`).value).toEqual({ formula: `SUM(${amount}3:${amount}33)`, result: expected });
    }
    expect(sheet.getCell("N2").value).toBe("その他");
    expect(value(sheet, "O4")).toBe(808);
    expect(value(sheet, "R4")).toBe(3636);
    expect(value(sheet, "R34")).toBe(3636);
  });

  it("採用方式別の美容室手当込み総支給額を集計し、派遣・紹介料・給与を二重計上しない", () => {
    const data = input();
    const sheet = createMonthlyExpenseWorkbook(data, "未確定").worksheets[0];
    expect(value(sheet, "G37")).toBe(14000);
    expect(value(sheet, "G38")).toBe(71000);
    expect(value(sheet, "G40")).toBe(1919);
    expect(value(sheet, "M36")).toBe(4400);
    expect(value(sheet, "O36")).toBe(44);
    expect(value(sheet, "I37")).toBe(2200);
    expect(value(sheet, "M42")).toBe(3300);
    expect(value(sheet, "Q34")).toBe(707);
    expect(value(sheet, "C43")).toBe(2222);
    expect(value(sheet, "C44")).toBe(1212);
    expect(value(sheet, "C45")).toBe(4734);
    expect(value(sheet, "G45")).toBe(86919);
    expect(value(sheet, "J45")).toBe(2200);
    expect(value(sheet, "N45")).toBe(3300);
    expect(value(sheet, "R35")).toBe(8080);
    expect(value(sheet, "P45")).toBe(data.results.balance.totalCosts);
    expect(data.results.balance.totalCosts).toBe(105233);
  });

  it("同日に同じ科目の支払が複数あれば全支払先を表示して金額を合算する", () => {
    const data = input();
    data.closings[0].expenses.push({ id: "liquor-2", category: "liquor", payee: "別の酒屋", amount: 789 });
    refresh(data);
    const sheet = createMonthlyExpenseWorkbook(data, "未確定").worksheets[0];
    expect(sheet.getCell("B4").value).toContain("liquor支払先");
    expect(sheet.getCell("B4").value).toContain("別の酒屋");
    expect(value(sheet, "C4")).toBe(890);
    expect(value(sheet, "C34")).toBe(890);
    expect(value(sheet, "P45")).toBe(data.results.balance.totalCosts);
  });

  it("同名の固定酒代・カード手数料を保持して納品書調整・決済手数料へ加算する", () => {
    const data = input();
    data.adjustments.fixedExpenses.push({ id: "extra-liquor", account: "酒代", amount: 99 }, { id: "extra-card", account: "カード決済手数料", amount: 88 });
    refresh(data);
    const sheet = createMonthlyExpenseWorkbook(data, "未確定").worksheets[0];
    expect(value(sheet, "C43")).toBe(2321);
    expect(value(sheet, "C44")).toBe(1300);
    expect(value(sheet, "C45")).toBe(4921);
    expect(value(sheet, "P45")).toBe(data.results.balance.totalCosts);
  });

  it("任意の固定費科目・人数超過でも項目と全員分を落とさず出力する", () => {
    const data = input();
    data.adjustments.fixedExpenses.push(...Array.from({ length: 12 }, (_, i) => ({ id: `extra-${i}`, account: `任意固定費${i + 1}`, amount: 5000 + i })));
    data.results.staffPayroll = Array.from({ length: 21 }, (_, i) => ({ id: `s${i}`, name: `従業員${i + 1}`, hours: 1, hourly: 6000 + i, sales: 0, bottle: 0, gross: 6000 + i, daily: 0, net: 6000 + i }));
    data.results.driverPayroll = Array.from({ length: 9 }, (_, i) => ({ id: `d${i}`, name: `運転者${i + 1}`, days: 1, basic: 7000 + i, remote: 0, gross: 7000 + i, dailyPayment: 0, net: 7000 + i }));
    const sourceIntroducer = data.results.introducerPayments[0];
    data.results.introducerPayments = Array.from({ length: 16 }, (_, i) => ({ ...sourceIntroducer, id: `i${i}`, introducer: `紹介者${i + 1}`, cast: `対象キャスト${i + 1}`, salesFee: 8000 + i, total: 8044 + i }));
    refresh(data);
    const sheet = createMonthlyExpenseWorkbook(data, "未確定").worksheets[0];
    expect(sheet.rowCount).toBeGreaterThan(45);
    const cells = unmergedCells(sheet);
    const texts = cells.map((cell) => String(cell.value || ""));
    for (const item of data.adjustments.fixedExpenses) expect(texts.some((text) => text === item.account)).toBe(true);
    for (const item of [...data.results.staffPayroll, ...data.results.driverPayroll]) expect(texts).toContain(item.name);
    for (const item of data.results.introducerPayments) {
      expect(texts.some((text) => text.includes(item.introducer) && text.includes(item.cast))).toBe(true);
    }
    const grandTotal = sheet.getCell(`P${sheet.rowCount}`);
    expect(value(sheet, grandTotal.address)).toBe(data.results.balance.totalCosts);
    expect(sheet.pageSetup.printArea).toBe(`A1:R${sheet.rowCount}`);
  });

  it("未承認・差戻し・別月の日次を出力しない", () => {
    const data = input();
    data.closings.push(
      { ...structuredClone(data.closings[0]), id: "submitted", businessDate: "2026-09-03", status: "submitted" },
      { ...structuredClone(data.closings[0]), id: "returned", businessDate: "2026-09-04", status: "returned" },
      { ...structuredClone(data.closings[0]), id: "other-month", businessDate: "2026-08-02" },
    );
    const sheet = createMonthlyExpenseWorkbook(data, "未確定").worksheets[0];
    expect(value(sheet, "C34")).toBe(101);
    expect(value(sheet, "G40")).toBe(1919);
    expect([0, null]).toContain(value(sheet, "C5"));
    expect([0, null]).toContain(value(sheet, "C6"));
    expect(value(sheet, "P45")).toBe(data.results.balance.totalCosts);
  });

  it.each([["2026-02", 28], ["2028-02", 29], ["2026-04", 30], ["2026-12", 31]])("%sの実在日を表示し月末日へ経費を計上する", (targetMonth, lastDay) => {
    const data = input();
    data.month = String(targetMonth);
    data.adjustments.month = data.month;
    data.closings[0].businessDate = `${targetMonth}-${lastDay}`;
    refresh(data);
    const sheet = createMonthlyExpenseWorkbook(data, "未確定").worksheets[0];
    expect(sheet.getCell("A3").value).toBe(1);
    expect(sheet.getCell(`A${Number(lastDay) + 2}`).value).toBe(lastDay);
    expect(value(sheet, `C${Number(lastDay) + 2}`)).toBe(101);
    if (Number(lastDay) < 31) expect(sheet.getCell(`A${Number(lastDay) + 3}`).value).toBeNull();
  });

  it("文字列を数式化せず保存し、XLSX往復後も金額・罫線・印刷設定・計算結果を保持する", async () => {
    const data = input();
    data.closings[0].expenses[0].payee = "=1+1";
    const book = createMonthlyExpenseWorkbook(data, "月次確定済み 第2版");
    const restored = new ExcelJS.Workbook();
    await restored.xlsx.load(await book.xlsx.writeBuffer());
    const sheet = restored.worksheets[0];
    expect(sheet.getCell("B4").value).toContain("=1+1");
    expect(typeof sheet.getCell("B4").value).toBe("string");
    expect(sheet.getCell("C4").font.name).toBe("Yu Gothic");
    expect(sheet.getCell("C4").border.bottom?.style).toBe("thin");
    expect(sheet.getCell("G36").master.address).toBe("F36");
    expect(sheet.getCell("R45").master.address).toBe("P45");
    expect(sheet.pageSetup).toMatchObject({ orientation: "landscape", paperSize: 9, fitToPage: true, fitToWidth: 1, printArea: "A1:R45" });
    expect(sheet.views[0].showGridLines).toBe(false);
    expect(sheet.headerFooter.oddFooter).toContain("月次確定済み 第2版");
    expect(value(sheet, "P45")).toBe(data.results.balance.totalCosts);
    for (const cell of unmergedCells(sheet)) {
      if (cell.value && typeof cell.value === "object" && "formula" in cell.value) {
        expect(Number.isFinite(cell.result), `${cell.address}: ${JSON.stringify(cell.value)}`).toBe(true);
      }
    }
  });

  it("合計が一致しない入力から正しい金額に見える帳票を作成しない", () => {
    const data = input();
    data.results.balance.totalCosts += 1;
    expect(() => createMonthlyExpenseWorkbook(data, "未確定")).toThrow();
    const stale = input();
    stale.closings[0].expenses[0].amount += 1;
    expect(() => createMonthlyExpenseWorkbook(stale, "未確定")).toThrow();
  });
});
