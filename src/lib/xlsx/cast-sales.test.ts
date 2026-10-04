import ExcelJS from "exceljs/dist/exceljs.min.js";
import { describe, expect, it } from "vitest";
import { calculateCastRewards, calculateCastSalesReports } from "@/domain/gms";
import type { CastRecord, CastReward, CastSalesDay, CastSalesReport, DailyCast, DailyClosing } from "@/domain/gms";
import { createCastSalesWorkbook } from "./cast-sales";

const day: CastSalesDay = {
  businessDate: "2026-09-02", startTime: "20:00", endTime: "00:22", hours: 4.25,
  honShimeiSales: 40000, jonaiExtensionSales: 10000, totalSales: 50000,
  honShimeiLiquorCost: 10000, jonaiExtensionLiquorCost: 5000, totalLiquorCost: 15000,
  honShimeiCount: 2, banaiShimeiCount: 1, nominationCount: 3, dohanCount: 1,
  backs: [
    { key: "honShimei", label: "本指名バック", amount: 2000 },
    { key: "banaiShimei", label: "場内指名バック", amount: 500 },
    { key: "dohan", label: "同伴バック", amount: 4000 },
    { key: "bottle", label: "ボトルバック", amount: 1999 },
    { key: "drink", label: "ドリンクバック", amount: 333 },
  ],
  bottleBackByKind: { keepBottle: 333, champagneWine: 1666 },
  backTotal: 8832,
  bottles: [{ name: "テスト通常ボトル", quantity: 1 }, { name: "テストシャンパン", quantity: 2 }],
  beautyAllowance: 500,
  dailyPayment: 1000, advancePayment: 2000,
};
const { businessDate: _date, startTime: _start, endTime: _end, ...dayTotals } = day;
const report: CastSalesReport = {
  id: "cast-1", name: "花子", attendanceDays: 1, days: [day], totals: { ...dayTotals, attendanceDays: 1 },
};
const reward: CastReward = {
  id: report.id, name: report.name, days: 1, advisoryDays: 1, hours: 4.25, trialOnly: false,
  hourlyPay: 12700, honShimeiSales: 40000, jonaiExtensionSales: 10000,
  liquorCost: 15000, honShimeiLiquorCost: 10000,
  honShimeiBack: 2000, banaiShimeiBack: 500, dohanBack: 4000, bottleBack: 1999, drinkBack: 333,
  hourlyAndBack: 21532, rewardRate: 0, salesRewardBase: 42500, salesReward: 0,
  adoptedSystem: "hourlyAndBack", adoptedReward: 21532, beautyAllowance: 500, grossPay: 22032,
  dailyPayment: 1000, advancePayment: 2000, transportFee: 500, withholding: 1000, netPay: 17532,
};
const input = () => structuredClone({ castSalesReports: [report], castRewards: [reward] });

describe("キャスト売上XLSX", () => {
  it.each([false, true])("勤務時間の右へ対象月の適用時給を数値で保存する（体入のみ=%s）", async (trialOnly) => {
    const data = input();
    data.castRewards[0].trialOnly = trialOnly;
    data.castRewards[0].appliedHourlyRates = [3500];
    const before = structuredClone(data);
    const book = createCastSalesWorkbook(data, "2026-09", "未確定");
    const restored = new ExcelJS.Workbook();
    await restored.xlsx.load(await book.xlsx.writeBuffer());
    expect(book.worksheets[0].getCell("T1").value).toEqual({ formula: "E34", result: 4.25 / 24 });
    // ExcelJSは時刻書式のキャッシュ値を再読込時にDateへ復元する。
    expect(restored.worksheets[0].getCell("T1").result).toEqual(new Date("1899-12-30T04:15:00.000Z"));
    for (const sheet of [book.worksheets[0], restored.worksheets[0]]) {
      expect(sheet.getCell("R1").value).toBe("勤務時間");
      expect(sheet.getCell("T1").formula).toBe("E34");
      expect(sheet.getCell("W1").value).toBe("設定時給");
      expect(sheet.getCell("X1").master.address).toBe("W1");
      expect(sheet.getCell("Y1").value).toBe(3500);
      expect(sheet.getCell("Z1").master.address).toBe("Y1");
      expect(sheet.getCell("AA1").master.address).toBe("Y1");
      expect(sheet.getCell("Y1").numFmt).toContain("円");
      expect(sheet.getCell("Y1").font.name).toBe("Yu Gothic");
      expect(sheet.getCell("Y1").formula).toBeUndefined();
      expect(sheet.getCell("I36").value).toBe(12700);
      expect(sheet.getCell("U44").value).toBe(17532);
    }
    expect(data).toEqual(before);
  });

  it("複数の実適用時給を昇順で併記し、配列・給与計算結果を変更しない", async () => {
    const data = input();
    data.castRewards[0].appliedHourlyRates = [3500, 2000];
    const before = structuredClone(data);
    const book = createCastSalesWorkbook(data, "2026-09", "月次確定済み 第2版");
    const restored = new ExcelJS.Workbook();
    await restored.xlsx.load(await book.xlsx.writeBuffer());
    for (const sheet of [book.worksheets[0], restored.worksheets[0]]) {
      expect(sheet.getCell("Y1").value).toBe("2,000円 / 3,500円");
      expect(sheet.getCell("I36").value).toBe(12700);
      expect(sheet.getCell("U44").value).toBe(17532);
    }
    expect(data).toEqual(before);
  });

  it.each(["未確定", "月次確定済み 第1版"])("%sの時給未保存を総時給報酬÷時間から推定せず—とする", async (sourceLabel) => {
    const data = input();
    const before = structuredClone(data);
    const book = createCastSalesWorkbook(data, "2026-09", sourceLabel);
    const restored = new ExcelJS.Workbook();
    await restored.xlsx.load(await book.xlsx.writeBuffer());
    expect(restored.worksheets[0].getCell("Y1").value).toBe("—");
    expect(restored.worksheets[0].getCell("I36").value).toBe(12700);
    expect(restored.worksheets[0].getCell("U44").value).toBe(17532);
    expect(data).toEqual(before);
  });

  it.each([0, 1500.25])("保存済み時給%s円を欠損扱いや丸め直しせず保持する", async (hourlyRate) => {
    const data = input();
    data.castRewards[0].appliedHourlyRates = [hourlyRate];
    const restored = new ExcelJS.Workbook();
    await restored.xlsx.load(await createCastSalesWorkbook(data, "2026-09", "確定済み").xlsx.writeBuffer());
    expect(restored.worksheets[0].getCell("Y1").value).toBe(hourlyRate);
    expect(restored.worksheets[0].getCell("Y1").numFmt).toContain("円");
    expect(restored.worksheets[0].getCell("I36").value).toBe(12700);
  });

  it.each([
    ["空配列", []], ["null", null], ["数値", 3000], ["文字列", "3000"],
    ["オブジェクト", { 0: 3000 }], ["文字列要素", ["3000"]],
    ["負数", [-1]], ["NaN", [NaN]], ["Infinity", [Infinity]],
    ["一部不正", [3000, NaN]], ["重複", [3000, 3000]], ["上限超過", [Number.MAX_SAFE_INTEGER + 1]],
    ["疎配列", Array<number>(1)], ["一部疎配列", [3000, ...Array<number>(1)]],
  ])("適用時給の%sを未保存に置換せず明示的に拒否する", (_label, appliedHourlyRates) => {
    const data = input();
    data.castRewards[0].appliedHourlyRates = appliedHourlyRates as number[];
    const before = structuredClone(data);
    expect(() => createCastSalesWorkbook(data, "2026-09", "確定済み")).toThrow(/時給|不一致/);
    expect(data).toEqual(before);
  });

  it("設定時給の有無によって既存セル・式・列幅・行高・印刷設定を変更しない", async () => {
    const original = input();
    // 追加入力明細を含む場合でも日別W～AA列・下部明細の場所を保持する。
    const additions = { additionalSales: 90000, additionalAllowance: 123, additionalTransportFee: 500 };
    const accountingInputs = [
      { id: "sales", castId: report.id, castName: report.name, kind: "sales" as const, label: "アフター売上", amount: 90000, businessDate: day.businessDate },
      { id: "allowance", castId: report.id, castName: report.name, kind: "allowance" as const, label: "イベント手当", amount: 123, businessDate: day.businessDate },
      { id: "transport", castId: report.id, castName: report.name, kind: "transport" as const, label: "追加送迎", amount: 500, businessDate: day.businessDate },
    ];
    for (const row of [original.castSalesReports[0].days[0], original.castSalesReports[0].totals]) {
      Object.assign(row, additions, { totalSales: 140000, accountingInputs: structuredClone(accountingInputs) });
    }
    Object.assign(original.castRewards[0], additions, { transportFee: 1000, grossPay: 22155, netPay: 17155 });
    const data = structuredClone(original);
    data.castRewards[0].appliedHourlyRates = [2000, 3500];
    const before = structuredClone(data);
    const baseline = new ExcelJS.Workbook();
    await baseline.xlsx.load(await createCastSalesWorkbook(original, "2026-09", "未確定").xlsx.writeBuffer());
    const book = createCastSalesWorkbook(data, "2026-09", "未確定");
    const restored = new ExcelJS.Workbook();
    await restored.xlsx.load(await book.xlsx.writeBuffer());
    const baseSheet = baseline.worksheets[0];
    const sheet = restored.worksheets[0];
    expect(sheet.pageSetup).toEqual(baseSheet.pageSetup);
    expect(sheet.pageSetup).toMatchObject({
      paperSize: 9, orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      horizontalCentered: true, printArea: "B1:AA54", printTitlesRow: "1:2",
      margins: { left: .25, right: .25, top: .35, bottom: .35, header: .15, footer: .15 },
    });
    expect(sheet.views).toEqual(baseSheet.views);
    expect(sheet.headerFooter).toEqual(baseSheet.headerFooter);
    expect(book.worksheets[0].columns.map((column) => column.width)).toEqual([3, 5, 8, 8, 9, 6, 12, 13, 6, 12, 13, 6, 12, 12, 12, 25, 25, 29, 13, 14, 12, 11, 11, 11, 11, 11, 11]);
    expect(sheet.columns.map((column) => column.width)).toEqual(baseSheet.columns.map((column) => column.width));
    expect(sheet.getRow(1).height).toBe(27);
    expect(sheet.getRow(2).height).toBe(32);
    expect(sheet.rowCount).toBe(baseSheet.rowCount);
    expect(sheet.columnCount).toBe(27);
    for (let row = 1; row <= sheet.rowCount; row++) {
      expect(sheet.getRow(row).height).toBe(baseSheet.getRow(row).height);
      for (let column = 1; column <= sheet.columnCount; column++) {
        if (row === 1 && column >= 23) continue;
        const actual = sheet.getCell(row, column);
        const expected = baseSheet.getCell(row, column);
        expect(actual.value, actual.address).toEqual(expected.value);
        expect(actual.style, actual.address).toEqual(expected.style);
        expect(actual.note, actual.address).toEqual(expected.note);
        expect(actual.master.address, actual.address).toBe(expected.master.address);
      }
    }
    expect(sheet.getCell("W4").value).toBe(1000);
    expect(sheet.getCell("X4").value).toBeNull();
    expect(sheet.getCell("X34").value).toBe(1000);
    expect(sheet.getCell("Y4").value).toBe(2000);
    expect(sheet.getCell("Z4").value).toBeNull();
    expect(sheet.getCell("AA4").value).toBe(123);
    expect(sheet.getCell("I42").formula).toBe("I39-I40-I41");
    expect(sheet.getCell("I42").result).toBe(17155);
    expect(data).toEqual(before);
  });

  it("体入から同月入店した実計算の体入時給と月度時給を出力し、未承認単価を混ぜない", async () => {
    const month = "2026-09";
    const member: CastRecord = {
      id: "active", name: "花子", legalName: "", status: "active", hiredAt: "2026-09-03",
      convertedFromTrialId: "trial", hourlyRates: { [month]: 3500, "2026-10": 9000 },
      note: "", createdAt: "", updatedAt: "",
    };
    const trial: CastRecord = { ...member, id: "trial", status: "trial", convertedFromTrialId: undefined, convertedToCastId: member.id };
    const daily = (overrides: Partial<DailyCast>): DailyCast => ({
      masterId: member.id, posCastId: "pos", name: member.name, kind: "regular",
      startTime: "20:00", endTime: "23:15", hours: 3.25, hourlyRate: 3000,
      honShimeiCount: 0, banaiShimeiCount: 0, dohanCount: 0, dohanBack: 0,
      honShimeiSales: 0, jonaiExtensionSales: 0, drinkSales: 0, drinkAllocations: [], bottles: [], liquorCost: 0,
      beautyAllowance: 0, dailyPayment: 0, advancePayment: 0, transportFee: 0, ...overrides,
    });
    const closings = [
      { id: "trial-day", businessDate: "2026-09-02", status: "approved", casts: [daily({ masterId: trial.id, kind: "trial", hourlyRate: 2000, hours: 2.25, endTime: "22:15", dailyPayment: 4500 })] },
      { id: "active-day", businessDate: "2026-09-03", status: "approved", casts: [daily({})] },
      { id: "pending-day", businessDate: "2026-09-04", status: "submitted", casts: [daily({ hourlyRate: 8000 })] },
    ] as DailyClosing[];
    const casts = [trial, member];
    const data = { castRewards: calculateCastRewards(closings, casts, month), castSalesReports: calculateCastSalesReports(closings, casts, month) };
    expect(data.castRewards).toHaveLength(1);
    expect(data.castRewards[0]).toMatchObject({ id: member.id, appliedHourlyRates: [2000, 3500], trialOnly: false, hourlyPay: 15875, dailyPayment: 4500, netPay: 11375 });
    const before = structuredClone(data);
    const book = createCastSalesWorkbook(data, month, "承認済みデータ（未確定）");
    const restored = new ExcelJS.Workbook();
    await restored.xlsx.load(await book.xlsx.writeBuffer());
    expect(restored.worksheets).toHaveLength(1);
    expect(restored.worksheets[0].getCell("Y1").value).toBe("2,000円 / 3,500円");
    expect(restored.worksheets[0].getCell("I36").value).toBe(15875);
    expect(restored.worksheets[0].getCell("U44").value).toBe(11375);
    expect(data).toEqual(before);
  });

  it("指定の列・勤務時間・月合計・左右両方の給与を保存値どおり出力する", () => {
    const book = createCastSalesWorkbook(input(), "2026-09", "承認済みデータ（未確定）");
    const sheet = book.worksheets[0];
    expect(book.creator).toBe("GENESIS Management System Ver2.39.0");
    expect(sheet.getCell("G4").value).toBe(2000);
    expect(sheet.getCell("J4").value).toBe(500);
    expect(sheet.getCell("M4").value).toBe(4000);
    expect(sheet.getCell("P4").value).toBe(333);
    expect(sheet.getCell("Q4").value).toBe(1666);
    expect(sheet.getCell("U4").value).toBe(333);
    expect(sheet.getCell("H4").value).toBe(40000);
    expect(sheet.getCell("K4").value).toBe(10000);
    expect(sheet.getCell("N4").value).toBe(10000);
    expect(sheet.getCell("O4").value).toBe(5000);
    expect(sheet.getCell("S4").value).toBe(15000);
    expect(sheet.getCell("T4").value).toBe(50000);
    expect(sheet.getCell("V4").value).toBe(500);
    expect(sheet.getCell("D4").value).toBe(22 / 1440);
    expect(sheet.getCell("E4").value).toBe(4.25 / 24);
    expect(sheet.getCell("E4").numFmt).toBe("[h]:mm");
    expect(sheet.getCell("T34").value).toEqual({ formula: "SUM(T3:T33)", result: 50000 });
    expect(sheet.getCell("E34").value).toEqual({ formula: "SUM(E3:E33)", result: 4.25 / 24 });
    expect(sheet.getCell("R4").value).toBe("テスト通常ボトル ×1\nテストシャンパン ×2");
    expect(sheet.getCell("I37").value).toBe(8832);
    expect(sheet.getCell("I40").value).toBe(3500);
    expect(sheet.getCell("U39").value).toBe(3500);
    expect(sheet.getCell("I42").value).toEqual({ formula: "I39-I40-I41", result: 17532 });
    expect(sheet.getCell("U41").value).toEqual({ formula: "U38-U39-U40", result: -4000 });
    expect(sheet.getCell("U44").value).toBe(17532);
    expect(sheet.getCell("D35").value).toContain("採用");
    expect(sheet.getCell("R35").value).toContain("対象外");
  });

  it("新規計算の10円単位の時給・バック・報酬合計を丸め直さず出力する", () => {
    const data = input();
    for (const row of [data.castSalesReports[0].days[0], data.castSalesReports[0].totals]) {
      row.backs.find((back) => back.key === "bottle")!.amount = 1990;
      row.backs.find((back) => back.key === "drink")!.amount = 330;
      row.bottleBackByKind = { keepBottle: 330, champagneWine: 1660 };
      row.backTotal = 8820;
    }
    Object.assign(data.castRewards[0], {
      hourlyPay: 12750,
      bottleBack: 1990,
      drinkBack: 330,
      hourlyAndBack: 21570,
      adoptedReward: 21570,
      grossPay: 22070,
      netPay: 17570,
    });

    const sheet = createCastSalesWorkbook(data, "2026-09", "承認済みデータ（未確定）").worksheets[0];
    expect(sheet.getCell("P4").value).toBe(330);
    expect(sheet.getCell("Q4").value).toBe(1660);
    expect(sheet.getCell("U4").value).toBe(330);
    expect(sheet.getCell("I36").value).toBe(12750);
    expect(sheet.getCell("I37").value).toBe(8820);
    expect(sheet.getCell("I42").value).toEqual({ formula: "I39-I40-I41", result: 17570 });
    expect(sheet.getCell("U44").value).toBe(17570);
  });

  it("旧確定スナップショットの333円配賦を10円単位へ丸め直さず出力する", () => {
    const sheet = createCastSalesWorkbook(input(), "2026-09", "月次確定済み 第2版").worksheets[0];
    expect(sheet.getCell("P4").value).toBe(333);
    expect(sheet.getCell("Q4").value).toBe(1666);
    expect(sheet.getCell("U4").value).toBe(333);
    expect(sheet.getCell("I37").value).toBe(8832);
    expect(sheet.getCell("I42").value).toEqual({ formula: "I39-I40-I41", result: 17532 });
    expect(sheet.getCell("U44").value).toBe(17532);
  });

  it("保存された売上報酬率・金額を再計算せず使い、採用方式を明示する", () => {
    const data = input();
    Object.assign(data.castRewards[0], {
      rewardRate: .65, salesReward: 1234500, adoptedSystem: "salesReward", adoptedReward: 1234500,
      grossPay: 1235000, netPay: 1230500,
    });
    const sheet = createCastSalesWorkbook(data, "2026-09", "月次確定済み 第3版").worksheets[0];
    expect(sheet.getCell("R36").value).toContain("65%");
    expect(sheet.getCell("U36").value).toBe(1234500);
    expect(sheet.getCell("U41").value).toEqual({ formula: "U38-U39-U40", result: 1230500 });
    expect(sheet.getCell("R35").value).toContain("採用");
    expect(sheet.getCell("D35").value).toContain("比較用");
    expect(sheet.headerFooter.oddFooter).toContain("月次確定済み 第3版");
  });

  it.each(["2026-02", "2028-02", "2026-04", "2026-12"])("%sの暦日と休みを正しく扱う", (month) => {
    const data = input();
    const last = new Date(Number(month.slice(0, 4)), Number(month.slice(5)), 0).getDate();
    data.castSalesReports[0].days[0].businessDate = `${month}-${last}`;
    const sheet = createCastSalesWorkbook(data, month, "未確定").worksheets[0];
    expect(sheet.getCell(`B${last + 2}`).value).toBe(last);
    expect(sheet.getCell(`G${last + 2}`).value).toBe(2000);
    if (last < 31) expect(sheet.getCell(`B${last + 3}`).value).toBeNull();
    expect(sheet.getCell("B3").value).toBe(1);
    expect(sheet.getCell("C3").value).toBeNull();
    expect(sheet.getCell("G3").value).toBeNull();
  });

  it("過去確定のボトル内訳を推測せず、P・Qを結合して合計と明記する", async () => {
    const data = input();
    delete data.castSalesReports[0].days[0].bottleBackByKind;
    delete data.castSalesReports[0].totals.bottleBackByKind;
    const book = createCastSalesWorkbook(data, "2026-09", "月次確定済み 第1版");
    const restored = new ExcelJS.Workbook();
    await restored.xlsx.load(await book.xlsx.writeBuffer());
    const sheet = restored.worksheets[0];
    expect(sheet.getCell("Q4").master.address).toBe("P4");
    expect(sheet.getCell("P4").value).toBe(1999);
    expect(sheet.getCell("P4").numFmt).toContain("内訳未保存・合計");
    expect(sheet.getCell("P34").value).toEqual({ formula: "SUM(P3:Q33)", result: 1999 });
    expect(sheet.getCell("I37").value).toBe(8832);
    expect(sheet.getCell("U44").value).toBe(17532);
  });

  it("全員を1ファイルにし、同名・禁止文字・長いキャスト名を安全なシート名にする", async () => {
    const data = input();
    const names = ["花子", "花子", "a", "A", "'[]:/?*\\'", "長い名前".repeat(15)];
    data.castSalesReports = names.map((name, i) => ({ ...structuredClone(report), name, id: `c${i}` }));
    data.castRewards = names.map((name, i) => ({ ...structuredClone(reward), name, id: `c${i}` }));
    const book = createCastSalesWorkbook(data, "2026-09", "未確定");
    const buffer = await book.xlsx.writeBuffer();
    const restored = new ExcelJS.Workbook();
    await restored.xlsx.load(buffer);
    expect(restored.worksheets).toHaveLength(names.length);
    expect(new Set(restored.worksheets.map((sheet) => sheet.name.toLowerCase())).size).toBe(names.length);
    restored.worksheets.forEach((sheet, index) => {
      expect(sheet.name.length).toBeLessThanOrEqual(31);
      expect(sheet.name).not.toMatch(/[\\/*?:[\]]/);
      expect(sheet.getCell("F1").value).toBe(`【キャスト名】${names[index]}`);
      expect(sheet.getCell("U44").value).toBe(17532);
      expect(sheet.getCell("G4").font.name).toBe("Yu Gothic");
      expect(sheet.views[0]).toMatchObject({ xSplit: 2, ySplit: 2 });
      expect(sheet.pageSetup.printArea).toBe("B1:AA45");
    });
  });

  it("24時間を超える月合計時間を保持する", () => {
    const data = input();
    data.castSalesReports[0].days[0].hours = 28.5;
    data.castSalesReports[0].totals.hours = 28.5;
    const sheet = createCastSalesWorkbook(data, "2026-09", "未確定").worksheets[0];
    expect(sheet.getCell("E34").value).toEqual({ formula: "SUM(E3:E33)", result: 28.5 / 24 });
    expect(sheet.getCell("T1").numFmt).toBe('[h]"時間"mm"分"');
  });

  it("W～AAを美容室と同じ幅・書式で追加し、減給は合計も含め全て空欄にする", async () => {
    const book = createCastSalesWorkbook(input(), "2026-09", "未確定");
    const restored = new ExcelJS.Workbook();
    await restored.xlsx.load(await book.xlsx.writeBuffer());
    const sheet = restored.worksheets[0];
    for (const [column, label] of [["W", "日払い"], ["X", "送迎代"], ["Y", "立替"], ["Z", "減給"], ["AA", "手当"]]) {
      expect(sheet.getCell(`${column}2`).value).toBe(label);
      expect(sheet.getColumn(column).width).toBe(sheet.getColumn("V").width);
      for (const row of [2, 4, 34]) {
        expect(sheet.getCell(`${column}${row}`).style).toEqual(sheet.getCell(`V${row}`).style);
      }
      expect(sheet.getCell(`${column}3`).value).toBeNull();
    }
    expect(sheet.getCell("W4").value).toBe(1000);
    expect(sheet.getCell("Y4").value).toBe(2000);
    // 旧確定で総送迎代の日別額が未保存なら、月額を保持して日別を空欄にする。
    expect(sheet.getCell("X4").value).toBeNull();
    expect(sheet.getCell("X34").value).toBe(reward.transportFee);
    expect(sheet.getCell("AA4").value).toBe(0);
    for (const [column, result] of [["W", 1000], ["Y", 2000], ["AA", 0]] as const) {
      // ExcelJS.valueのコピーは0のresultを省略するため、保存モデルのresultを検証する。
      expect(sheet.getCell(`${column}34`).formula).toBe(`SUM(${column}3:${column}33)`);
      expect(sheet.getCell(`${column}34`).result).toBe(result);
    }
    for (let row = 3; row <= 34; row++) expect(sheet.getCell(`Z${row}`).value).toBeNull();
    expect(sheet.getCell("B45").value).toContain("送迎控除の合計");
    expect(sheet.getCell("B45").value).toContain("X送迎代：日別内訳未保存");
    expect(sheet.pageSetup.printArea).toBe("B1:AA45");
  });

  it("旧確定の日別日払い・立替を推定せず、保存された月合計を保持する", async () => {
    const data = input();
    for (const row of [...data.castSalesReports[0].days, data.castSalesReports[0].totals]) {
      delete row.dailyPayment;
      delete row.advancePayment;
    }
    const before = structuredClone(data);
    const book = createCastSalesWorkbook(data, "2026-09", "月次確定済み 第1版");
    const restored = new ExcelJS.Workbook();
    await restored.xlsx.load(await book.xlsx.writeBuffer());
    const sheet = restored.worksheets[0];
    for (let row = 3; row <= 33; row++) {
      expect(sheet.getCell(`W${row}`).value).toBeNull();
      expect(sheet.getCell(`Y${row}`).value).toBeNull();
    }
    expect(sheet.getCell("W34").value).toBe(1000);
    expect(sheet.getCell("Y34").value).toBe(2000);
    expect(sheet.getCell("B45").value).toContain("日別内訳未保存");
    expect(sheet.getCell("W34").note).toBeTruthy();
    expect(sheet.getCell("Y34").note).toBeTruthy();
    expect(sheet.getCell("U44").value).toBe(17532);
    expect(data).toEqual(before);
  });

  it("保存済み0円は空欄と区別し、金額を丸め直さない", () => {
    const data = input();
    for (const row of [...data.castSalesReports[0].days, data.castSalesReports[0].totals, data.castRewards[0]]) {
      row.dailyPayment = 0;
      row.advancePayment = 2000.5;
    }
    data.castRewards[0].netPay = 18531.5;
    const sheet = createCastSalesWorkbook(data, "2026-09", "確定済み").worksheets[0];
    expect(sheet.getCell("W4").value).toBe(0);
    expect(sheet.getCell("Y4").value).toBe(2000.5);
    expect(sheet.getCell("W34").formula).toBe("SUM(W3:W33)");
    expect(sheet.getCell("W34").result).toBe(0);
    expect(sheet.getCell("Y34").value).toEqual({ formula: "SUM(Y3:Y33)", result: 2000.5 });
  });

  it.each(["dailyPayment", "advancePayment"] as const)("%sの日別・合計・報酬の不一致や部分欠損を拒否する", (key) => {
    for (const value of [undefined, NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1, 999]) {
      const data = input();
      data.castSalesReports[0].days[0][key] = value;
      expect(() => createCastSalesWorkbook(data, "2026-09", "")).toThrow("不一致");
    }
    const noTotals = input();
    delete noTotals.castSalesReports[0].totals[key];
    expect(() => createCastSalesWorkbook(noTotals, "2026-09", "")).toThrow("不一致");
    const mismatch = input();
    mismatch.castSalesReports[0].days[0][key]! += 1;
    mismatch.castSalesReports[0].totals[key]! += 1;
    expect(() => createCastSalesWorkbook(mismatch, "2026-09", "")).toThrow("不一致");
  });

  it("欠損・重複・合計不一致のあるデータの出力を拒否する", () => {
    expect(() => createCastSalesWorkbook({ castSalesReports: [], castRewards: [] }, "2026-09", "未確定")).toThrow("ありません");
    expect(() => createCastSalesWorkbook(input(), "2026-13", "未確定")).toThrow("対象月");
    const missing = input();
    missing.castRewards = [];
    expect(() => createCastSalesWorkbook(missing, "2026-09", "未確定")).toThrow("報酬データ");
    for (const key of ["totalSales", "hours", "backTotal"] as const) {
      const broken = input();
      broken.castSalesReports[0].totals[key] += 1;
      expect(() => createCastSalesWorkbook(broken, "2026-09", "未確定")).toThrow("不一致");
    }
    const wrongKind = input();
    wrongKind.castSalesReports[0].days[0].bottleBackByKind!.keepBottle = 0;
    expect(() => createCastSalesWorkbook(wrongKind, "2026-09", "未確定")).toThrow("不一致");
    const wrongDay = input();
    wrongDay.castSalesReports[0].days[0].businessDate = "2026-09-31";
    expect(() => createCastSalesWorkbook(wrongDay, "2026-09", "未確定")).toThrow("出勤日");
  });
});
