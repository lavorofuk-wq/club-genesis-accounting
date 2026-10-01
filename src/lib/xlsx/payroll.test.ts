import ExcelJS from "exceljs/dist/exceljs.min.js";
import JSZip from "jszip";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDriverPaymentExport, buildStaffPaymentExport, type PayrollExportInput } from "@/domain/payroll-export";
import { createDriverPaymentWorkbook, createStaffPaymentWorkbook } from "./payroll";

vi.mock("@/domain/payroll-export", () => ({ buildStaffPaymentExport: vi.fn(), buildDriverPaymentExport: vi.fn() }));
type Staff = ReturnType<typeof buildStaffPaymentExport>["rows"][number];
type Driver = ReturnType<typeof buildDriverPaymentExport>["rows"][number];
const staff = (id = "staff", group: Staff["group"] = "regular"): Staff => ({
  id, name: `スタッフ ${id}`, group, hours: 1.25, hourly: 1750, sales: 100, bottle: 200,
  gross: 2050, daily: 500, net: 1550, appliedHourlyRates: [1400], missingDetails: [],
  days: [{ businessDate: "2026-09-01", hours: 1.25, amount: 1750, dailyPayment: 500 }],
});
const driver = (id = "driver"): Driver => ({ id, name: `ドライバー ${id}`, daysCount: 2, basic: 12000,
  remote: 500, gross: 12500, dailyPayment: 2000, net: 10500, missingDetails: [],
  days: [{ businessDate: "2026-09-01", amount: 6000 }, { businessDate: "2026-09-02", amount: 6000 }],
});
const input = { month: "2026-09" } as PayrollExportInput;
const workbook = async (book: ExcelJS.Workbook) => {
  const restored = new ExcelJS.Workbook();
  await restored.xlsx.load(await book.xlsx.writeBuffer());
  return restored;
};
beforeEach(() => {
  vi.mocked(buildStaffPaymentExport).mockReset().mockReturnValue({ month: "2026-09", rows: [staff(), staff("trial", "trial")] });
  vi.mocked(buildDriverPaymentExport).mockReset().mockReturnValue({ month: "2026-09", rows: [driver()] });
});

describe("スタッフ支払XLSX", () => {
  it("在籍と体入を別シートにし、日別・手当・日払い・差引を保存金額どおり出力する", async () => {
    const book = await workbook(createStaffPaymentWorkbook(input));
    expect(buildStaffPaymentExport).toHaveBeenCalledWith(input);
    expect(book.worksheets.map((sheet) => sheet.name)).toEqual(["在籍スタッフ", "体入スタッフ"]);
    for (const sheet of book.worksheets) {
      expect(sheet.getCell("A5").value).toBe("日付");
      expect(sheet.getCell("B4").value).toBe("時給 1,400円");
      expect(sheet.getCell("B6").value).toBe(1.25);
      expect(sheet.getCell("C6").value).toBe(1750);
      expect(sheet.getCell("D6").value).toBe(500);
      expect(sheet.getCell("B37").value).toBe(1.25);
      expect(sheet.getCell("B38").value).toBe(1750);
      expect(sheet.getCell("B39").value).toBe(100);
      expect(sheet.getCell("B40").value).toBe(200);
      expect(sheet.getCell("B41").value).toBe(2050);
      expect(sheet.getCell("B42").value).toBe(500);
      expect(sheet.getCell("B43").value).toBe(1550);
      expect(sheet.getCell("A44").value).toBe("送迎");
      expect(sheet.getCell("B44").value).toBeNull();
      expect(sheet.getCell("B43").font.name).toBe("Yu Gothic");
      expect(sheet.getCell("C6").numFmt).toBe('#,##0;[Red]-#,##0;0');
      expect(sheet.pageSetup).toMatchObject({ paperSize: 9, orientation: "landscape", scale: 100, fitToPage: false, printArea: "A1:G45" });
    }
  });

  it("給与・日払いの未保存欄は空欄、月計は保存値、全員の日別合計も部分集計にしない", async () => {
    const legacy = { ...staff("old"), days: [{ businessDate: "2026-09-01", hours: 1.25 }], missingDetails: ["基本給与・日払い"] };
    vi.mocked(buildStaffPaymentExport).mockReturnValue({ month: "2026-09", rows: [staff(), legacy] });
    const sheet = (await workbook(createStaffPaymentWorkbook(input))).worksheets[0];
    expect(sheet.getCell("E6").value).toBe(1.25);
    expect(sheet.getCell("F6").value).toBeNull();
    expect(sheet.getCell("G6").value).toBeNull();
    expect(sheet.getCell("E38").value).toBe(1750);
    expect(sheet.getCell("E42").value).toBe(500);
    expect(sheet.getCell("E45").value).toContain("日別内訳未保存");
    expect(sheet.getCell("H6").result).toBe(2.5);
    expect(sheet.getCell("I6").value).toBeNull();
    expect(sheet.getCell("J6").value).toBeNull();
    expect(sheet.getCell("H43").result).toBe(3100);
  });

  it("原本欠損でも保存済みの日別時給給与は残し、日払いだけ空欄にする", () => {
    vi.mocked(buildStaffPaymentExport).mockReturnValue({ month: "2026-09", rows: [{ ...staff(),
      days: [{ businessDate: "2026-09-01", hours: 1.25, amount: 1750 }], missingDetails: ["日払い"] }] });
    const sheet = createStaffPaymentWorkbook(input).worksheets[0];
    expect(sheet.getCell("C6").value).toBe(1750);
    expect(sheet.getCell("D6").value).toBeNull();
    expect(sheet.getCell("B42").value).toBe(500);
    expect(sheet.getCell("F6").result).toBe(1750);
    expect(sheet.getCell("G6").value).toBeNull();
  });

  it("内訳が全くない旧確定は日別を埋めず、区分記録なしシートへ出す", () => {
    const unknown = { ...staff("legacy", "unknown"), appliedHourlyRates: undefined, days: undefined, missingDetails: ["勤務時間・基本給与・日払い"] };
    vi.mocked(buildStaffPaymentExport).mockReturnValue({ month: "2026-09", rows: [unknown] });
    const book = createStaffPaymentWorkbook(input);
    expect(book.worksheets.map((sheet) => sheet.name)).toEqual(["在籍スタッフ", "体入スタッフ", "区分記録なし"]);
    expect(book.worksheets[0].getCell("A3").value).toBe("対象者なし");
    const sheet = book.worksheets[2];
    expect(sheet.getCell("B4").value).toBe("時給 —");
    for (const address of ["B6", "C6", "D6", "E6", "F6", "G6"]) expect(sheet.getCell(address).value).toBeNull();
    expect(sheet.getCell("B43").value).toBe(1550);
  });

  it("在籍化した人の適用時給が複数あっても併記し、入力を変更しない", () => {
    const data = { month: "2026-09", rows: [{ ...staff(), appliedHourlyRates: [1300, 1400] }] };
    vi.mocked(buildStaffPaymentExport).mockReturnValue(data);
    const before = structuredClone(data);
    const sheet = createStaffPaymentWorkbook(input).worksheets[0];
    expect(sheet.getCell("B4").value).toBe("時給 1,300円 / 1,400円");
    expect(data).toEqual(before);
  });

  it("人数が増えたら見出しを繰り返し改ページし、全員合計を重複加算しない", async () => {
    const rows = Array.from({ length: 8 }, (_, i) => staff(String(i)));
    vi.mocked(buildStaffPaymentExport).mockReturnValue({ month: "2026-09", rows });
    const book = createStaffPaymentWorkbook(input);
    const sheet = book.worksheets[0];
    expect(sheet.getCell("B3").value).toBe("スタッフ 0");
    expect(sheet.getCell("B49").value).toBe("スタッフ 3");
    expect(sheet.getCell("B95").value).toBe("スタッフ 6");
    expect(sheet.getCell("A97").value).toBe("日付");
    expect(sheet.getCell("K43").result).toBe(8 * 1550);
    expect(sheet.getCell("K43").formula).toBe("SUM(B43,E43,H43,B89,E89,H89,B135,E135)");
    expect(sheet.getCell("K135").result).toBe(8 * 1550);
    expect(sheet.getCell("K6").result).toBe(10);
    expect(sheet.pageSetup.printArea).toBe("A1:M137");
    const zip = await JSZip.loadAsync(await book.xlsx.writeBuffer());
    const xml = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
    expect(xml).toContain('rowBreaks count="2"');
    expect(xml).toContain('<brk id="46"');
    expect(xml).toContain('<brk id="92"');
  });

  it.each([["2026-02", 28], ["2028-02", 29], ["2026-09", 30], ["2026-10", 31]])("%sは実在する日だけを表示する", (month, lastDay) => {
    vi.mocked(buildStaffPaymentExport).mockReturnValue({ month, rows: [{ ...staff(), days: [{ businessDate: `${month}-01`, hours: 1.25, amount: 1750, dailyPayment: 500 }] }] });
    const sheet = createStaffPaymentWorkbook(input).worksheets[0];
    expect(sheet.getCell(Number(lastDay) + 5, 1).value).toBe(lastDay);
    if (lastDay !== 31) expect(sheet.getCell(Number(lastDay) + 6, 1).value).toBeNull();
  });

  it("保存済み小数と負の差引を丸めない", () => {
    const row = { ...staff(), hourly: 1750.25, gross: 2050.25, daily: 3000.5, net: -950.25 };
    vi.mocked(buildStaffPaymentExport).mockReturnValue({ month: "2026-09", rows: [row] });
    const sheet = createStaffPaymentWorkbook(input).worksheets[0];
    expect(sheet.getCell("B38").value).toBe(1750.25);
    expect(sheet.getCell("B43").value).toBe(-950.25);
    expect(sheet.getCell("B43").numFmt).toContain(".###############");
  });

  it("通常・旧確定注記付き・複数ページがA4横の印刷高に収まる", () => {
    const rows = Array.from({ length: 7 }, (_, i) => i === 6 ? { ...staff(String(i)), days: undefined,
      missingDetails: ["日払い", "基本給与", "勤務時間", "区分・時給"] } : staff(String(i)));
    vi.mocked(buildStaffPaymentExport).mockReturnValue({ month: "2026-09", rows });
    const sheet = createStaffPaymentWorkbook(input).worksheets[0];
    for (let first = 1; first <= sheet.rowCount; first += 46) {
      const points = Array.from({ length: 46 }, (_, offset) => sheet.getRow(first + offset).height ?? sheet.properties.defaultRowHeight).reduce((a, b) => a + b, 0);
      expect(points).toBeLessThan(566.5);
    }
  });

  it("256名以上でもSUM関数の引数上限を超えず全員分を出力する", () => {
    vi.mocked(buildStaffPaymentExport).mockReturnValue({ month: "2026-09", rows: Array.from({ length: 256 }, (_, i) => staff(String(i))) });
    const sheet = createStaffPaymentWorkbook(input).worksheets[0];
    const formula = sheet.getCell("K43").formula;
    expect(formula).toContain(")+SUM(");
    for (const part of formula.split("+")) expect(part.split(",").length).toBeLessThanOrEqual(200);
    expect(sheet.getCell("K43").result).toBe(256 * 1550);
  }, 15000);

  it("長い氏名は省略や縮小せず折り返す", () => {
    const name = "長いスタッフ名".repeat(10);
    vi.mocked(buildStaffPaymentExport).mockReturnValue({ month: "2026-09", rows: [{ ...staff(), name }] });
    const sheet = createStaffPaymentWorkbook(input).worksheets[0];
    expect(sheet.getCell("B3").value).toBe(name);
    expect(sheet.getCell("B3").alignment.wrapText).toBe(true);
    expect(sheet.getCell("B3").alignment.shrinkToFit).not.toBe(true);
    expect(sheet.getRow(3).height).toBeGreaterThan(26);
  });
});

describe("ドライバー支払XLSX", () => {
  it("日給・遠方手当・日払い・差引を、スタッフと別ブックに出力する", async () => {
    const book = await workbook(createDriverPaymentWorkbook(input));
    expect(buildDriverPaymentExport).toHaveBeenCalledWith(input);
    expect(book.worksheets.map((sheet) => sheet.name)).toEqual(["ドライバー支払"]);
    const sheet = book.worksheets[0];
    expect(sheet.getCell("B6").value).toBe(6000);
    expect(sheet.getCell("B7").value).toBe(6000);
    expect(sheet.getCell("B8").value).toBeNull();
    expect(sheet.getCell("B37").value).toBe(12000);
    expect(sheet.getCell("B38").value).toBe(500);
    expect(sheet.getCell("B39").value).toBe(2000);
    expect(sheet.getCell("B40").value).toBe(10500);
    expect(sheet.getCell("C40").result).toBe(10500);
    expect(sheet.pageSetup).toMatchObject({ paperSize: 9, orientation: "landscape", scale: 100, fitToPage: false, printArea: "A1:C41" });
  });

  it("旧確定の日別は空欄、月計・日払い・差引は原額を保持する", () => {
    vi.mocked(buildDriverPaymentExport).mockReturnValue({ month: "2026-09", rows: [{ ...driver(), days: undefined, missingDetails: ["基本日給"] }] });
    const sheet = createDriverPaymentWorkbook(input).worksheets[0];
    expect(sheet.getCell("B6").value).toBeNull();
    expect(sheet.getCell("C6").value).toBeNull();
    expect(sheet.getCell("B41").value).toContain("日別内訳未保存");
    expect(sheet.getCell("B39").value).toBe(2000);
    expect(sheet.getCell("B40").value).toBe(10500);
  });

  it("人数超過分を別ページへ継続し、全員合計を保持する", async () => {
    vi.mocked(buildDriverPaymentExport).mockReturnValue({ month: "2026-09", rows: Array.from({ length: 9 }, (_, i) => driver(String(i))) });
    const book = createDriverPaymentWorkbook(input);
    const sheet = book.worksheets[0];
    expect(sheet.getCell("B45").value).toBe("ドライバー 6");
    expect(sheet.getCell("H40").result).toBe(9 * 10500);
    expect(sheet.getCell("H82").result).toBe(9 * 10500);
    const zip = await JSZip.loadAsync(await book.xlsx.writeBuffer());
    expect(await zip.file("xl/worksheets/sheet1.xml")!.async("string")).toContain('<brk id="42"');
  });

  it("不正データの検証エラーを握りつぶさない", () => {
    vi.mocked(buildDriverPaymentExport).mockImplementation(() => { throw new Error("給与不一致"); });
    expect(() => createDriverPaymentWorkbook(input)).toThrow("給与不一致");
  });
});
