import ExcelJS from "exceljs/dist/exceljs.min.js";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import type { CastReward, CastSalesDay, CastSalesReport, IntroducerFeeType } from "@/domain/gms";
import type { IntroducerPaymentRow } from "@/domain/month-accounting";
import type { IntroducerExportResults } from "@/domain/introducer-export";
import { createIntroducerWorkbook } from "./introducers";

const month = "2026-09";
function day(date: string, sales: number, cost: number): CastSalesDay {
  return { businessDate: date, startTime: "20:00", endTime: "21:00", hours: 1,
    honShimeiSales: sales, honShimeiLiquorCost: cost, honShimeiCount: 1,
    jonaiExtensionSales: 987654, totalSales: sales + 987654, jonaiExtensionLiquorCost: 876543,
    totalLiquorCost: cost + 876543, banaiShimeiCount: 1, nominationCount: 2,
    dohanCount: 0, backs: [], backTotal: 0, bottles: [], beautyAllowance: 0 };
}

function fixture(feeType: IntroducerFeeType = "gross10", dates = [day(`${month}-01`, 20000, 5000), day(`${month}-02`, 10000, 2000)]): IntroducerExportResults {
  const sum = (key: "honShimeiSales" | "honShimeiLiquorCost" | "honShimeiCount") => dates.reduce((total, row) => total + row[key], 0);
  const attendanceDays = new Set(dates.map((row) => row.businessDate)).size;
  const reward: CastReward = {
    id: "cast_internal_1", name: "架空キャスト甲", days: attendanceDays, advisoryDays: attendanceDays, hours: 2, trialOnly: false,
    hourlyPay: 1200, honShimeiSales: sum("honShimeiSales"), jonaiExtensionSales: 10000,
    liquorCost: sum("honShimeiLiquorCost") + 1000, honShimeiLiquorCost: sum("honShimeiLiquorCost"),
    honShimeiBack: 100, banaiShimeiBack: 50, dohanBack: 50, bottleBack: 50, drinkBack: 50,
    hourlyAndBack: 1500, rewardRate: 0, salesRewardBase: 35000, salesReward: 0,
    adoptedSystem: "hourlyAndBack", adoptedReward: 1500, beautyAllowance: 500, grossPay: 2000,
    dailyPayment: 100, advancePayment: 200, transportFee: 500, withholding: 10, netPay: 1190,
    introducer: { id: "intro_internal_1", name: "架空紹介者甲", feeType, attendanceAdvisoryFee: 50, entryAdvisoryFee: 500 },
  };
  const report: CastSalesReport = { id: reward.id, name: reward.name, attendanceDays, days: dates,
    totals: { ...day("", sum("honShimeiSales"), sum("honShimeiLiquorCost")), honShimeiCount: sum("honShimeiCount"), attendanceDays } };
  const net = feeType === "netSales10" || feeType === "higherNetSalesGross10";
  const salesBase = Math.max(0, reward.honShimeiSales - (net ? reward.honShimeiLiquorCost : 0));
  const salesFee = Math.floor(salesBase / 10);
  const grossWins = feeType === "gross10" || (feeType.startsWith("higher") && 200 > salesFee);
  const payment: IntroducerPaymentRow = {
    id: "intro_internal_1_cast_internal_1", introducerId: "intro_internal_1", castId: reward.id,
    introducer: "架空紹介者甲", cast: reward.name, feeType, honShimeiLiquorCost: reward.honShimeiLiquorCost,
    salesBase, salesFee, grossBase: 2000, grossFee: 200,
    adopted: grossWins ? "総支給額10%" : net ? "酒代原価引き売上10%" : "売上10%",
    attendanceAdvisory: 100, entryAdvisory: 500, advisory: 600, total: (grossWins ? 200 : salesFee) + 600,
  };
  return { castRewards: [reward], castSalesReports: [report], introducerPayments: [payment], warnings: [],
    balance: { cast: 2000, introducer: payment.total, staff: 0, driver: 0, expenses: 0, totalCosts: 2000 + payment.total, profit: 0 } };
}

function batch(types: IntroducerFeeType[], names = types.map(() => "架空紹介者甲"), sameIntroducer = true) {
  const inputs = types.map((type, index) => {
    const input = fixture(type);
    const castId = `cast_internal_${index + 1}`;
    const introducerId = `intro_internal_${sameIntroducer ? 1 : index + 1}`;
    input.castRewards[0].id = castId;
    input.castSalesReports[0].id = castId;
    Object.assign(input.introducerPayments[0], { id: `${introducerId}_${castId}`, castId, introducerId, introducer: names[index] });
    return input;
  });
  return { ...inputs[0], castRewards: inputs.flatMap((input) => input.castRewards),
    castSalesReports: inputs.flatMap((input) => input.castSalesReports),
    introducerPayments: inputs.flatMap((input) => input.introducerPayments),
    balance: { ...inputs[0].balance, introducer: inputs.reduce((sum, input) => sum + input.balance.introducer, 0) } };
}

async function reload(input: IntroducerExportResults, targetMonth = month) {
  const original = createIntroducerWorkbook(input, targetMonth);
  const bytes = await original.xlsx.writeBuffer();
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(bytes);
  const zip = await JSZip.loadAsync(bytes);
  const allXml = (await Promise.all(Object.values(zip.files).filter((file) => /\.(xml|rels)$/.test(file.name)).map((file) => file.async("string")))).join("\n");
  return { book, zip, allXml };
}

describe("紹介者支払明細XLSX", () => {
  it.each([
    ["gross10", "gross"], ["sales10", "sales"], ["netSales10", "sales"],
    ["higherSalesGross10", "comparison"], ["higherNetSalesGross10", "comparison"],
  ] as const)("%sを%s様式へ値だけで出力し、再読込後も月額と印刷設定を保持する", async (feeType, layout) => {
    const input = fixture(feeType);
    const { book, allXml } = await reload(input);
    expect(book.worksheets).toHaveLength(1);
    const sheet = book.worksheets[0];
    expect(sheet.name).toBe("架空紹介者甲");
    const headerTotal = layout === "gross" ? "H1" : layout === "sales" ? "Q1" : "K1";
    expect(sheet.getCell(headerTotal).value).toBe(input.balance.introducer);
    expect(sheet.getCell(headerTotal).numFmt).toBe('#,##0"円"');
    expect(sheet.getCell("A3").value).toBe("架空キャスト甲");
    expect(sheet.pageSetup.paperSize).toBe(13);
    expect(sheet.pageSetup.orientation).toBe("landscape");
    expect(sheet.pageSetup.fitToPage).toBe(false);
    expect(sheet.pageSetup.printArea).toBe(layout === "gross" ? "A1:I29" : layout === "sales" ? "A1:T40" : "A1:N40");
    expect(sheet.views[0].showGridLines).toBe(false);
    expect(sheet.getCell("A3").font.name).toBe("Yu Gothic");
    if (layout === "gross") {
      expect(sheet.getCell("B5").value).toBe(1200);
      expect(sheet.getCell("B6").value).toBe(300);
      expect(sheet.getCell("B7").value).toBe(500);
      expect(sheet.getCell("B8").value).toBe(2000);
      expect(sheet.getCell("B9").value).toBe(800);
      expect(sheet.getCell("B10").value).toBe(10);
      expect(sheet.getCell("B11").value).toBe(1190);
      expect(sheet.getCell("B13").value).toBe(200);
      expect(sheet.getCell("B14").value).toBe(600);
      expect(sheet.getCell("B15").value).toBe(800);
      expect(sheet.getCell("A12").value).toBeNull();
      expect(sheet.getCell("B12").value).toBeNull();
      expect(sheet.getColumn("A").width).toBe(17);
      expect(sheet.getColumn("B").width).toBe(15);
    } else {
      const column = "C";
      expect(sheet.getCell(`${column}37`).value).toBe(feeType.includes("Net") || feeType === "netSales10" ? 23000 : 30000);
      expect(sheet.getCell(`${column}38`).value).toBe(input.introducerPayments[0].salesFee);
      expect(sheet.getCell(`${column}39`).value).toBe(600);
      expect(sheet.getCell(`${column}40`).value).toBe(input.introducerPayments[0].total);
      expect(sheet.getColumn("C").width).toBe(13);
      if (layout === "comparison") {
        expect(sheet.getCell("F33").value).toBe(2000);
        expect(sheet.getCell("F38").value).toBe(200);
        expect(sheet.getCell("F40").value).toBe(800);
        expect(sheet.getCell("E37").value).toBeNull();
        expect(sheet.getCell("F37").value).toBeNull();
        expect(sheet.getColumn("E").width).toBe(17);
        expect(sheet.getColumn("F").width).toBe(15);
      }
    }
    expect(allXml).not.toMatch(/<f(?:\s|>)/);
    expect(allXml).not.toMatch(/原価|netSales10|gross10|sales10|higherSalesGross10|higherNetSalesGross10|cast_internal_|intro_internal_|987654|876543/);
  });

  it("全紹介者をID別のシートに分け、同名でも人数・合計を混ぜない", async () => {
    const input = batch(["gross10", "gross10", "gross10"], ["同名紹介者", "同名紹介者", "同名紹介者"], false);
    const { book } = await reload(input);
    expect(book.worksheets.map((sheet) => sheet.name)).toEqual(["同名紹介者", "同名紹介者 (2)", "同名紹介者 (3)"]);
    expect(book.worksheets.map((sheet) => sheet.getCell("H1").value)).toEqual([800, 800, 800]);
    expect(book.worksheets.reduce((sum, sheet) => sum + Number(sheet.getCell("H1").value), 0)).toBe(input.balance.introducer);
  });

  it("1紹介者に異なる契約が混在しても1シートに各様式を並べる", async () => {
    const { book } = await reload(batch(["gross10", "sales10", "higherNetSalesGross10"]));
    expect(book.worksheets).toHaveLength(1);
    const sheet = book.worksheets[0];
    expect(sheet.getCell("K1").value).toBe(7300);
    expect(sheet.getCell("A3").value).toBe("架空キャスト甲");
    expect(sheet.getCell("H3").value).toBe("架空キャスト甲");
    expect(sheet.getCell("A44").value).toBe("架空キャスト甲");
    expect(sheet.getCell("E69").value).toBe("架空キャスト甲");
    expect(sheet.getCell("D15").value).toBe(800);
    expect(sheet.getCell("J40").value).toBe(3600);
    expect(sheet.getCell("C81").value).toBe(2900);
    expect(sheet.getCell("F81").value).toBe(800);
    expect(sheet.pageSetup.printArea).toBe("A1:N81");
  });

  it("売上報酬採用者のバック欄を空欄にし、比較の採用額を強調する", async () => {
    const input = fixture("higherSalesGross10");
    Object.assign(input.castRewards[0], { adoptedSystem: "salesReward", salesReward: 50000, adoptedReward: 50000, grossPay: 50500, netPay: 49690 });
    Object.assign(input.introducerPayments[0], { grossBase: 50500, grossFee: 5050, adopted: "総支給額10%", total: 5650 });
    input.balance.introducer = 5650;
    const { book } = await reload(input);
    const sheet = book.worksheets[0];
    expect(sheet.getCell("E30").value).toBe("売上報酬");
    expect(sheet.getCell("F30").value).toBe(50000);
    expect(sheet.getCell("F31").value).toBeNull();
    expect(sheet.getCell("F33").value).toBe(50500);
    expect(sheet.getCell("F38").value).toBe(5050);
    expect(sheet.getCell("F40").value).toBe(5650);
    expect(sheet.getCell("F40").fill).toMatchObject({ fgColor: { argb: "FFFFF2CC" } });
    expect(sheet.getCell("C40").value).toBe(3600);
  });

  it.each([
    [[day(`${month}-01`, 10000, 15000), day(`${month}-02`, 20000, 5000)], [-5000, 15000], 10000, 1000],
    [[day(`${month}-01`, 10000, 15000), day(`${month}-02`, 1000, 3000)], [-5000, -2000], -7000, 0],
  ] as const)("日別の負売上と保存済み報酬を改変せず出力する #%#", async (dates, values, total, fee) => {
    const { book } = await reload(fixture("netSales10", [...dates]));
    const sheet = book.worksheets[0];
    expect(sheet.getCell("C6").value).toBe(values[0]);
    expect(sheet.getCell("C7").value).toBe(values[1]);
    expect(sheet.getCell("C37").value).toBe(total);
    expect(sheet.getCell("C38").value).toBe(fee);
    expect(sheet.getCell("C40").value).toBe(fee + 600);
    expect(sheet.getCell("C6").numFmt).toContain("[Red]-");
  });

  it("ZIP全体に元原価・内部契約種別・ID・本名や数式を残さない", async () => {
    const input = fixture("higherNetSalesGross10", [day(`${month}-01`, 800000, 123457), day(`${month}-02`, 600000, 234567)]);
    Object.assign(input.castRewards[0], { legalName: "架空の非出力本名", note: "秘密の管理情報" });
    const { allXml } = await reload(input);
    expect(allXml).not.toMatch(/123457|234567|358024|987654|876543|原価|netSales|NetSales|feeType|cast_internal|intro_internal|架空の非出力本名|秘密の管理情報/);
    expect(allXml).toContain("本指売上計");
    expect(allXml).toContain("売上10%");
    expect(allXml).not.toMatch(/<f(?:\s|>)/);
  });

  it.each(["2026-02", "2028-02", "2026-04", "2026-12"])("%sの存在しない日は空欄にする", async (targetMonth) => {
    const last = new Date(Date.UTC(Number(targetMonth.slice(0, 4)), Number(targetMonth.slice(5)), 0)).getUTCDate();
    const { book } = await reload(fixture("sales10", [day(`${targetMonth}-${last}`, 20000, 5000)]), targetMonth);
    const sheet = book.worksheets[0];
    expect(sheet.getCell(`A${last + 5}`).value).toBe(last);
    expect(sheet.getCell(`C${last + 5}`).value).toBe(20000);
    expect(sheet.getCell("C6").value).toBe(0);
    for (let date = last + 1; date <= 31; date += 1) {
      expect(sheet.getCell(`A${date + 5}`).value).toBeNull();
      expect(sheet.getCell(`B${date + 5}`).value).toBeNull();
      expect(sheet.getCell(`C${date + 5}`).value).toBeNull();
    }
  });

  it.each([
    ["gross10", 7, 30, 59, "I", 8], ["sales10", 6, 41, 81, "T", 17], ["higherNetSalesGross10", 3, 41, 81, "N", 11],
  ] as const)("%sが定員を超えると同一シート内で改ページし最終行まで印刷する", async (type, size, pageHeight, lastRow, endColumn, totalColumn) => {
    const input = batch(Array.from({ length: size }, () => type));
    const { book, zip } = await reload(input);
    expect(book.worksheets).toHaveLength(1);
    const sheet = book.worksheets[0];
    expect(sheet.pageSetup.printArea).toBe(`A1:${endColumn}${lastRow}`);
    expect(sheet.getCell(pageHeight + 1, totalColumn).value).toBe(input.balance.introducer);
    expect(sheet.getCell(pageHeight + 3, 1).value).toBe("架空キャスト甲");
    const xml = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
    expect(xml).toMatch(new RegExp(`<brk[^>]*id="${pageHeight}"`));
    expect(sheet.pageSetup.fitToPage).toBe(false);
  });

  it("禁止文字・長名・予約名・大文字小文字衝突でも安全な一意シート名になる", async () => {
    const names = ["'同名/?:[]*\\紹介者'", "同名/?:[]*\\紹介者", "History", "history", "😀".repeat(30), "😀".repeat(30), "///"];
    const { book } = await reload(batch(names.map(() => "gross10"), names, false));
    expect(book.worksheets).toHaveLength(names.length);
    const output = book.worksheets.map((sheet) => sheet.name);
    expect(new Set(output.map((name) => name.toLowerCase())).size).toBe(names.length);
    for (const name of output) {
      expect(name.length).toBeLessThanOrEqual(31);
      expect(name).not.toMatch(/[\\/*?:[\]]|^'|'$|[\uD800-\uDBFF]$/);
      expect(name.toLowerCase()).not.toBe("history");
    }
  });

  it.each(["gross10", "sales10", "netSales10", "higherSalesGross10", "higherNetSalesGross10"] as const)("%sの出勤なし入店顧問料を対象から除かず印字する", async (feeType) => {
    const input = fixture(feeType);
    input.castRewards = [];
    input.castSalesReports = [];
    Object.assign(input.introducerPayments[0], { honShimeiLiquorCost: 0, salesBase: 0, salesFee: 0,
      grossBase: 0, grossFee: 0, attendanceAdvisory: 0, entryAdvisory: 500, advisory: 500,
      total: 500, adopted: "入店顧問料のみ" });
    input.balance.introducer = 500;
    const { book } = await reload(input);
    const sheet = book.worksheets[0];
    expect(sheet.getCell("A3").value).toBe("架空キャスト甲");
    expect(sheet.getCell(feeType === "gross10" ? "H1" : feeType.startsWith("higher") ? "K1" : "Q1").value).toBe(500);
    const feeCell = feeType === "gross10" ? "B14" : "C39";
    const totalCell = feeType === "gross10" ? "B15" : "C40";
    expect(sheet.getCell(feeCell).value).toBe(500);
    expect(sheet.getCell(totalCell).value).toBe(500);
  });

  it("旧確定の小数支給額と紹介料を再丸めせず、表示書式も小数を隠さない", async () => {
    const input = fixture();
    Object.assign(input.castRewards[0], { hourlyPay: 1200.5, hourlyAndBack: 1500.5, adoptedReward: 1500.5, grossPay: 2000.5, netPay: 1190.5 });
    Object.assign(input.introducerPayments[0], { grossBase: 2000.5, grossFee: 201, total: 801 });
    input.balance.introducer = 801;
    const before = structuredClone(input);
    const { book } = await reload(input);
    const sheet = book.worksheets[0];
    expect(sheet.getCell("B5").value).toBe(1200.5);
    expect(sheet.getCell("B8").value).toBe(2000.5);
    expect(sheet.getCell("B11").value).toBe(1190.5);
    expect(sheet.getCell("B13").value).toBe(201);
    expect(sheet.getCell("B15").value).toBe(801);
    expect(sheet.getCell("B5").numFmt).toContain("0.###");
    expect(input).toEqual(before);
  });

  it("数式に似たキャスト名や紹介者名も数式やハイパーリンクに変換しない", async () => {
    const input = fixture();
    const name = '=HYPERLINK("https://invalid.example","架空")';
    input.introducerPayments[0].introducer = name;
    input.introducerPayments[0].cast = name;
    const { book, allXml } = await reload(input);
    expect(book.worksheets[0].getCell("A3").value).toBe(name);
    expect(allXml).not.toMatch(/<f(?:\s|>)|<hyperlink\b|TargetMode="External"/);
  });
});
