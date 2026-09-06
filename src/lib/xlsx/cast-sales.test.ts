import ExcelJS from "exceljs/dist/exceljs.min.js";
import { describe, expect, it } from "vitest";
import type { CastReward, CastSalesDay, CastSalesReport } from "@/domain/gms";
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
  it("指定の列・勤務時間・月合計・左右両方の給与を保存値どおり出力する", () => {
    const book = createCastSalesWorkbook(input(), "2026-09", "承認済みデータ（未確定）");
    const sheet = book.worksheets[0];
    expect(book.creator).toBe("GENESIS Management System Ver2.15.1");
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
      expect(sheet.pageSetup.printArea).toBe("B1:V45");
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
