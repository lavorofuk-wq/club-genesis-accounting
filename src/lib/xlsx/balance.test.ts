import { beforeEach, describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs/dist/exceljs.min.js";
import { buildBalanceExportReport, type BalanceExportInput, type BalanceExportReport } from "@/domain/balance-export";
import { createMonthlyBalanceWorkbook } from "./balance";

vi.mock("@/domain/balance-export", () => ({ buildBalanceExportReport: vi.fn() }));

function report(): BalanceExportReport {
  return {
    month: "2026-09", approvedDays: 2, castDailyAndAdvance: 3000, castTransport: 500,
    castWithholding: 123, castNet: 43877, employeeDaily: 1200, honShimeiSales: 180000, jonaiExtensionSales: 10000,
    days: [
      {
        businessDate: "2026-09-02", cashSales: 100000, cardSales: 50000, totalSales: 150000,
        groups: 5, customers: 10, honShimeiCount: 3, jonaiCount: 4, dohanCount: 2, castCount: 4,
        castHourly: 11500, castSalesReward: 7000, dispatchCastCount: 2, dispatchCastPayment: 5000,
        employeeGross: 3500, introducerPayment: 0, expenses: 2000,
      },
      {
        businessDate: "2026-09-20", cashSales: 20000, cardSales: 10000, totalSales: 30000,
        groups: 2, customers: 3, honShimeiCount: 1, jonaiCount: 2, dohanCount: 1, castCount: 2,
        castHourly: 18500, castSalesReward: 10500, dispatchCastCount: 1, dispatchCastPayment: 3000,
        employeeGross: 7000, introducerPayment: 6500, expenses: 11000,
      },
    ],
  };
}

const input = {} as BalanceExportInput;
const mockedBuild = vi.mocked(buildBalanceExportReport);

function value(sheet: ExcelJS.Worksheet, address: string): unknown {
  const cell = sheet.getCell(address);
  return cell.type === ExcelJS.ValueType.Formula ? cell.result : cell.value;
}

beforeEach(() => {
  vi.resetAllMocks();
  mockedBuild.mockReturnValue(report());
});

describe("見本形式の月次収支XLSX", () => {
  it("検証済み日別データを紹介料列追加後の正しい列へ出力する", () => {
    const book = createMonthlyBalanceWorkbook(input, "承認済みデータ（未確定）");
    expect(mockedBuild).toHaveBeenCalledWith(input);
    expect(book.creator).toBe("GENESIS Management System Ver2.17.0");
    expect(book.worksheets).toHaveLength(1);
    const sheet = book.worksheets[0];
    expect(sheet.name).toBe("ジェネシス収支表");
    expect(value(sheet, "F1")).toBe(2026);
    expect(value(sheet, "H1")).toBe(9);
    expect(value(sheet, "I1")).toBe("月度");
    for (const [column, title] of [["R", "従業員給"], ["S", "紹介料"], ["T", "経費"], ["U", "経費比"], ["V", "収支"]]) {
      expect(value(sheet, `${column}2`)).toBe(title);
    }
    const expected = { C: 150000, D: 100000, E: 50000, F: 5, G: 10, H: 15000, I: 3, J: 4, K: 2, L: 4, M: 11500, N: 7000, O: 2, P: 5000, R: 3500, S: 0, T: 2000, V: 121000 };
    for (const [column, amount] of Object.entries(expected)) expect(value(sheet, `${column}4`)).toBe(amount);
    expect(value(sheet, "Q4")).toBeCloseTo(23500 / 150000);
    expect(value(sheet, "U4")).toBeCloseTo(2000 / 150000);
    expect(value(sheet, "A22")).toBe(20);
    expect(value(sheet, "S22")).toBe(6500);
    expect(value(sheet, "V22")).toBe(-26500);
    expect(value(sheet, "C3")).toBeNull();
    expect(value(sheet, "A33")).toBeNull();
  });

  it("平均は承認日数、合計比率は月額を分母にし、日別比率の単純合計にしない", () => {
    const sheet = createMonthlyBalanceWorkbook(input, "未確定").worksheets[0];
    expect(value(sheet, "D36")).toBe(2);
    expect(value(sheet, "C35")).toBe(180000);
    expect(value(sheet, "C34")).toBe(90000);
    expect(value(sheet, "H34")).toBe(12500);
    expect(value(sheet, "H35")).toBeCloseTo(180000 / 13);
    expect(value(sheet, "Q35")).toBeCloseTo(55500 / 180000);
    expect(value(sheet, "U35")).toBeCloseTo(13000 / 180000);
    expect(value(sheet, "Q34")).toBeCloseTo((23500 / 150000 + 32000 / 30000) / 2);
    expect(value(sheet, "U34")).toBeCloseTo((2000 / 150000 + 11000 / 30000) / 2);
    expect(sheet.getCell("Q35").value).toEqual({ formula: 'IF(C35=0,"",SUM(M35:N35,P35)/C35)', result: 55500 / 180000 });
    expect(value(sheet, "V35")).toBe(94500);
    expect(value(sheet, "V34")).toBe(47250);
  });

  it("報酬・派遣・紹介料・経費を一度ずつ計上し送迎控除のみを現金残へ戻す", () => {
    const sheet = createMonthlyBalanceWorkbook(input, "未確定").worksheets[0];
    expect(value(sheet, "H36")).toBeNull();
    expect(value(sheet, "N36")).toBe(500);
    expect(value(sheet, "Q36")).toBe(1200);
    expect(value(sheet, "W36")).toBe(10500);
    expect(value(sheet, "F37")).toBe(55500);
    expect(value(sheet, "M37")).toBe(43877);
    expect(value(sheet, "U37")).toBe(85500);
    expect(sheet.getCell("U37").value).toEqual({ formula: "SUM(M35:N35,P35,R35:T35)", result: 85500 });
    expect(value(sheet, "M38")).toBe(35000);
    expect(sheet.getCell("M38").value).toEqual({ formula: "SUM(D35,J42,O42)-U37+N36", result: 35000 });
    expect(value(sheet, "V38")).toBe(34500);
    expect(value(sheet, "V39")).toBe(94500);
    expect(value(sheet, "D39")).toBe(3000);
    expect(value(sheet, "J39")).toBe(1200);
    expect(value(sheet, "U41")).toBe(43877);
    expect(value(sheet, "U42")).toBe(123);
    expect(value(sheet, "U43")).toBe(6500);
    expect(value(sheet, "U44")).toBe(50500);
    expect(value(sheet, "U46")).toBe(123);
    expect(value(sheet, "D44")).toBe(190000);
    expect(value(sheet, "C40")).toBeCloseTo(55500 / 180000);
    expect(value(sheet, "F40")).toBeCloseTo(13000 / 180000);
    expect(value(sheet, "K40")).toBeCloseTo(66000 / 180000);
  });

  it("カード入金2欄は空の数値入力欄で、現金残高の式から直接参照する", () => {
    const sheet = createMonthlyBalanceWorkbook(input, "未確定").worksheets[0];
    for (const address of ["J42", "O42"]) {
      const cell = sheet.getCell(address);
      expect(cell.value).toBeNull();
      expect(cell.fill).toEqual({ type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFF99" } });
      expect(cell.dataValidation).toMatchObject({ type: "decimal", operator: "greaterThanOrEqual", allowBlank: true, formulae: [0] });
      expect(cell.protection.locked).toBe(false);
    }
    expect(sheet.getCell("K42").master.address).toBe("J42");
    expect(sheet.getCell("P42").master.address).toBe("O42");
    expect(sheet.getCell("M38").formula).toContain("J42,O42");
  });

  it("売上・客数0円でも比率や客単価を0として取り繕わず空欄にする", () => {
    const zero = report();
    for (const day of zero.days) {
      day.cashSales = 0;
      day.cardSales = 0;
      day.totalSales = 0;
      day.customers = 0;
    }
    mockedBuild.mockReturnValue(zero);
    const sheet = createMonthlyBalanceWorkbook(input, "未確定").worksheets[0];
    for (const address of ["H4", "H35", "Q4", "U4", "Q34", "Q35", "U34", "U35", "C40", "F40", "K40"]) expect(value(sheet, address)).toBe("");
    expect(value(sheet, "V35")).toBe(-85500);
    const empty = { ...report(), days: [], approvedDays: 0 };
    mockedBuild.mockReturnValue(empty);
    const emptySheet = createMonthlyBalanceWorkbook(input, "未確定").worksheets[0];
    for (const address of ["C34", "H34", "Q34", "U34", "V34"]) expect(value(emptySheet, address)).toBe("");
  });

  it.each([["2026-02", 28], ["2028-02", 29], ["2026-04", 30], ["2026-12", 31]])("%sは実在する日付だけを表示する", (month, lastDay) => {
    const data = report();
    data.month = String(month);
    data.days = [{ ...data.days[0], businessDate: `${month}-${lastDay}` }];
    data.approvedDays = 1;
    mockedBuild.mockReturnValue(data);
    const sheet = createMonthlyBalanceWorkbook(input, "未確定").worksheets[0];
    expect(value(sheet, `A${Number(lastDay) + 2}`)).toBe(lastDay);
    expect(value(sheet, `C${Number(lastDay) + 2}`)).toBe(150000);
    if (Number(lastDay) < 31) expect(value(sheet, `A${Number(lastDay) + 3}`)).toBeNull();
    expect(value(sheet, "L42")).toBe(`後期・カード入金／16日～${lastDay}日分`);
  });

  it("保存後も数値・式・見本の結合セル・游ゴシック・印刷設定を保持する", async () => {
    const book = createMonthlyBalanceWorkbook(input, "月次確定済み 第2版");
    const restored = new ExcelJS.Workbook();
    await restored.xlsx.load(await book.xlsx.writeBuffer());
    const sheet = restored.worksheets[0];
    expect(sheet.pageSetup).toMatchObject({ orientation: "landscape", paperSize: 9, fitToPage: true, fitToWidth: 1, printArea: "A1:W46" });
    expect(sheet.views[0].showGridLines).toBe(false);
    expect(sheet.headerFooter.oddFooter).toContain("月次確定済み 第2版");
    expect(sheet.getCell("C4").font.name).toBe("Yu Gothic");
    expect(sheet.getCell("C4").border.bottom?.style).toBe("thin");
    expect(sheet.getCell("Q4").numFmt).toContain("%");
    expect(sheet.getCell("V37").master.address).toBe("U37");
    expect(sheet.getCell("W38").master.address).toBe("V38");
    expect(sheet.getCell("V41").master.address).toBe("U41");
    expect(sheet.getCell("W46").master.address).toBe("U46");
    expect(value(sheet, "M38")).toBe(35000);
    expect(value(sheet, "V39")).toBe(94500);
    expect(value(sheet, "J42")).toBeNull();
    expect(value(sheet, "O42")).toBeNull();
    sheet.eachRow((row) => row.eachCell((cell) => {
      if (cell.type === ExcelJS.ValueType.Formula && (!cell.isMerged || cell.master.address === cell.address)) {
        expect(Number.isFinite(cell.result), `${cell.address}: ${JSON.stringify(cell.value)}`).toBe(true);
      }
    }));
  });

  it("ドメイン検証で不整合とされた月次からXLSXを生成しない", () => {
    mockedBuild.mockImplementation(() => { throw new Error("月次金額が一致しません。"); });
    expect(() => createMonthlyBalanceWorkbook(input, "未確定")).toThrow("月次金額が一致しません。");
  });
});
