import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import ExcelJS from "exceljs/dist/exceljs.min.js";
import { describe, expect, it } from "vitest";
import { fillReceiptTemplate, receiptCellAddress, type ReceiptSheet } from "./receipt-template";
import layouts from "./receipt-layouts.json";

const template = () => readFile("public/templates/cast-receipt-v3.xlsx");
const cells = { G1: "9月報酬分", G2: 100000, G3: 8300, G4: 1000, G5: 109300, G6: 10000, G7: 3000, G8: 96300, G10: "花子" };
const statementCells = { D3: "2026年9月分", F4: "花子", E5: "山田花子", F6: 20, F7: 80.25, F8: "3,000 / 4,000", F9: 100000, F10: 8300, F11: 0, F12: 0, F13: 0, F14: 0, F15: 1000, F18: 109300, F19: 3000, F20: 8000, F21: 1000, F22: 1000, F25: 13000, F26: 96300 };
const part = async (zip: JSZip, path: string) => zip.file(path)!.async("string");
const open = async (bytes: Uint8Array) => { const book = new ExcelJS.Workbook(); await book.xlsx.load(bytes as unknown as ExcelJS.Buffer); return book; };

describe("受領書と明細書の1ページ出力", () => {
  it.each([
    ["salesReward"], ["hourlyAndBack", "salesReward"], ["salesReward", "hourlyAndBack", "salesReward"],
  ] as const)("全員一括・方式混在・順序変更でも採用様式と記入欄が一致する（%s）", async (...kinds) => {
    const input = kinds.map((kind, index): ReceiptSheet => ({ template: kind, name: `キャスト${index + 1}`,
      cells: kind === "salesReward" ? { B2: "①　日売上－酒代（50％）×65％", G1: "9月報酬分", G2: 1234567, G3: 500, G4: 1235067, G5: 10000, G6: 2000, G7: 1223067, G9: `キャスト${index + 1}` } : { ...cells, G10: `キャスト${index + 1}` },
      statementCells: { ...statementCells, F4: `キャスト${index + 1}`, ...(kind === "salesReward" ? { B11: "報酬率", F11: 65, F12: 1234567, F18: 1235067, F25: 12000, F26: 1223067 } : {}) },
    }));
    const bytes = await fillReceiptTemplate(await template(), input);
    const output = await JSZip.loadAsync(bytes);
    const book = await open(bytes);
    expect(book.worksheets).toHaveLength(kinds.length);
    expect(Object.keys(output.files).filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))).toHaveLength(kinds.length);
    for (const [index, kind] of kinds.entries()) {
      const sales = kind === "salesReward";
      const sheet = book.worksheets[index];
      const value = (section: "receipt" | "statement", address: string) => sheet.getCell(receiptCellAddress(kind, section, address));
      for (const [address, expected] of Object.entries(input[index].cells)) expect(value("receipt", address).value).toBe(expected);
      for (const [address, expected] of Object.entries(input[index].statementCells)) expect(value("statement", address).value).toBe(expected);
      expect(value("statement", "B2").value).toBe("報酬明細書");
      expect(value("statement", "B9").value).toBe(sales ? "日売上計" : "基本支給額");
      expect(value("receipt", sales ? "C15" : "C16").value).toBeNull();
      for (const [col, label] of [["B", "令和"], ["C", "年"], ["D", "月"], ["E", "日"]]) expect(value("receipt", `${col}${sales ? 12 : 13}`).value).toBe(label);
      expect(value("statement", "F16").value).toBeNull();
      expect(value("statement", "F23").value).toBeNull();
      expect(value("receipt", sales ? "G4" : "G5").font).toMatchObject({ name: "Yu Gothic", bold: true, size: 11 });
      expect(sheet.pageSetup.printArea).toBe(layouts[kind].printArea.replace(/\$/g, ""));
      expect(sheet.pageSetup).toMatchObject({ paperSize: 281, orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 1 });
      const xml = await part(output, `xl/worksheets/sheet${index + 1}.xml`);
      expect(xml).not.toContain("<f>");
      expect(xml).not.toMatch(/<(rowBreaks|colBreaks)\b/);
      if (index > 0) expect(xml).not.toContain('tabSelected="1"');
      const nativePrinter = await output.file(`xl/printerSettings/printerSettings${sales ? 2 : 1}.bin`)!.async("uint8array");
      expect(createHash("sha256").update(nativePrinter).digest("hex")).toBe(sales ? "06e0b636885ac380d329aac7bb7be53c0709b65c65f6dafc74cb00d1705c08c5" : "8b28e3931744541a16b2f61c5497b634bc22498711ebf826f6515bacbe20f3ba");
    }
    const count = (await Promise.all(kinds.map((_, index) => part(output, `xl/worksheets/sheet${index + 1}.xml`)))).reduce((sum, xml) => sum + (xml.match(/<c\b[^>]*\bt="s"/g) || []).length, 0);
    expect(await part(output, "xl/sharedStrings.xml")).toContain(`count="${count}"`);
  });

  it("両様式の幅・各行の物理位置・受領書の余白を保ち、右側明細を印刷範囲に含める", async () => {
    const before = await open(await readFile("public/templates/cast-receipt-v2.xlsx"));
    const after = await open(await template());
    for (const [index, kind] of (["hourlyAndBack", "salesReward"] as const).entries()) {
      const source = before.worksheets[index]; const result = after.worksheets[index];
      for (let col = 1; col <= 8; col += 1) expect(result.getColumn(col).width).toBe(source.getColumn(col).width ?? source.properties.defaultColWidth);
      for (let col = 11; col <= 20; col += 1) expect(result.getColumn(col).width).toBe(3.6640625);
      const y = (row: number) => Array.from({ length: row - 1 }, (_, i) => result.getRow(i + 1).height || 14.25).reduce((a, b) => a + b, 0);
      let height = 0;
      layouts[kind].receiptRows.forEach((row, original) => { expect(y(row)).toBeCloseTo(height, 6); height += source.getRow(original + 1).height; });
      const detailHeights = [14.25, 32.25, 17.65, 17.65, 17.65, 17.65, 17.65, 18, 18, 17.65, index === 0 ? 17.65 : 18, index === 0 ? 17.65 : 18, 17.65, 17.65, 17.65, 17.65, 18, 18.4, 18, 17.65, 17.65, 17.65, 17.65, 18, 18.4, 18.4, 18, 22.15];
      height = 0;
      layouts[kind].statementRows.forEach((row, original) => { expect(y(row)).toBeCloseTo(height, 6); height += detailHeights[original]; });
      expect(result.pageSetup.margins).toEqual(source.pageSetup.margins);
    }
    const zip = await JSZip.loadAsync(await template());
    for (const path of ["xl/workbook.xml", "docProps/core.xml", "docProps/app.xml"]) expect(await part(zip, path)).not.toMatch(/absPath|d\.docs\.live\.net|rulun/i);
  });

  it("大きい金額・小数・長い名前を型と書式を保持して再読込でき、既存小数書式を壊さない", async () => {
    const name = "長いキャスト名テスト";
    const bytes = await fillReceiptTemplate(await template(), [{ template: "hourlyAndBack", name, cells: { ...cells, G10: name, G2: 12345678, G8: 1234567.5 }, statementCells: { ...statementCells, F4: name, E5: "山田花子名前が長い場合", F26: 1234567.5 } }]);
    const sheet = (await open(bytes)).worksheets[0];
    const get = (section: "receipt" | "statement", address: string) => sheet.getCell(receiptCellAddress("hourlyAndBack", section, address));
    expect(get("receipt", "G2").value).toBe(12345678);
    for (const [section, address] of [["receipt", "G8"], ["statement", "F26"]] as const) {
      expect(get(section, address).value).toBe(1234567.5);
      expect(get(section, address).numFmt).toContain(".###############");
    }
    expect(get("statement", "F7").value).toBe(80.25);
    expect(get("receipt", "G10").font.size).toBeLessThan(11);
    expect(get("statement", "F4").alignment.shrinkToFit).toBe(true);
    const styles = await part(await JSZip.loadAsync(bytes), "xl/styles.xml");
    expect((styles.match(/<numFmts\b/g) || [])).toHaveLength(1);
    expect(styles).toContain('numFmtId="176"');
    expect(styles).toContain('formatCode="0.##"');
  });

  it("数式風の氏名を文字列で扱い、同名・禁止文字・長いシート名を安全に出力する", async () => {
    const names = ["=1+1<&>\"'", "a/b", "A:B", "history", "'末尾'", "あ".repeat(50), "あ".repeat(50), "😀".repeat(20)];
    const book = await open(await fillReceiptTemplate(await template(), names.map((name) => ({ template: "hourlyAndBack", name, cells: { ...cells, G10: name }, statementCells: { ...statementCells, E5: name } }))));
    expect(new Set(book.worksheets.map((sheet) => sheet.name.toLowerCase())).size).toBe(names.length);
    book.worksheets.forEach((sheet, index) => {
      expect(sheet.name.length).toBeLessThanOrEqual(31);
      expect(sheet.name).not.toMatch(/[\\/*?:\[\]]/);
      expect(sheet.getCell(receiptCellAddress("hourlyAndBack", "statement", "E5")).value).toBe(names[index]);
    });
  });

  it("欠損テンプレート・対象外セル・不正値・1ページ設定の欠損を拒否する", async () => {
    const bytes = await template();
    await expect(fillReceiptTemplate(bytes, [])).rejects.toThrow("出力するキャスト");
    const invalidCells: Record<string, string | number>[] = [{ C16: "署名" }, { G8: NaN }, { G10: "あ\u0001" }, { G10: "\uD800" }];
    for (const invalid of invalidCells) await expect(fillReceiptTemplate(bytes, [{ template: "hourlyAndBack", name: "テスト", cells: invalid, statementCells }])).rejects.toThrow();
    await expect(fillReceiptTemplate(bytes, [{ template: "hourlyAndBack", name: "テスト", cells, statementCells: { F23: 100 } }])).rejects.toThrow("対象セル");
    for (const printer of [true, false]) {
      const missing = await JSZip.loadAsync(bytes);
      if (printer) missing.remove("xl/printerSettings/printerSettings1.bin");
      else missing.file("xl/worksheets/sheet1.xml", (await part(missing, "xl/worksheets/sheet1.xml")).replace('fitToHeight="1"', 'fitToHeight="2"'));
      await expect(fillReceiptTemplate(await missing.generateAsync({ type: "uint8array" }), [{ template: "hourlyAndBack", name: "テスト", cells, statementCells }])).rejects.toThrow("印刷設定");
    }
  });
});
