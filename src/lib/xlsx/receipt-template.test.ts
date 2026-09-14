import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import ExcelJS from "exceljs/dist/exceljs.min.js";
import { describe, expect, it } from "vitest";
import { fillReceiptTemplate } from "./receipt-template";

const template = () => readFile("public/templates/cast-receipt-v1.xlsx");
const cells = { G1: "9月報酬分", G2: 100000, G3: 8300, G4: 1000, G5: 109300, G6: 10000, G7: 3000, G8: 96300, G10: "花子" };
const part = async (zip: JSZip, path: string) => zip.file(path)!.async("string");
const cell = (xml: string, address: string) => xml.match(new RegExp(`<c\\b[^>]*\\br="${address}"[^>]*(?:\\/>|>[\\s\\S]*?<\\/c>)`))?.[0];

describe("受領書テンプレートの印刷設定保持", () => {
  it("全シートで元の行高・列幅・結合・余白・用紙・プリンターデータを保持し、日付と署名を空欄にする", async () => {
    const bytes = await template();
    const source = await JSZip.loadAsync(bytes);
    const output = await JSZip.loadAsync(await fillReceiptTemplate(bytes, [
      { name: "花子", cells }, { name: "太郎", cells: { ...cells, G10: "太郎" } },
    ]));
    const original = await part(source, "xl/worksheets/sheet1.xml");
    for (let index = 1; index <= 2; index += 1) {
      const sheet = await part(output, `xl/worksheets/sheet${index}.xml`);
      for (const pattern of [/<sheetFormatPr\b[^>]*\/>/, /<cols>[\s\S]*?<\/cols>/, /<row\b[^>]*>/g,
        /<mergeCells[\s\S]*?<\/mergeCells>/, /<pageMargins\b[^>]*\/>/, /<pageSetup\b[^>]*\/>/]) {
        expect(Array.from(sheet.match(pattern) || [])).toEqual(Array.from(original.match(pattern) || []));
      }
      // 日付の「令和・年・月・日」ラベルと氏名欄・受領印欄は全セルを元のまま保持。
      for (const row of [12, 13, 14, 15, 16, 17, 18]) {
        for (const col of "ABCDEFGH") expect(cell(sheet, `${col}${row}`)).toBe(cell(original, `${col}${row}`));
      }
      expect(await part(output, `xl/worksheets/_rels/sheet${index}.xml.rels`)).toBe(await part(source, "xl/worksheets/_rels/sheet1.xml.rels"));
      expect(sheet).not.toContain("<f>");
      if (index > 1) expect(sheet).not.toContain('tabSelected="1"');
    }
    const printer = "xl/printerSettings/printerSettings1.bin";
    expect(await output.file(printer)!.async("uint8array")).toEqual(await source.file(printer)!.async("uint8array"));
    expect(await part(output, "xl/theme/theme1.xml")).toBe(await part(source, "xl/theme/theme1.xml"));
    const workbook = await part(output, "xl/workbook.xml");
    expect(workbook).toContain('localSheetId="0">&apos;花子&apos;!$A$1:$H$18');
    expect(workbook).toContain('localSheetId="1">&apos;太郎&apos;!$A$1:$H$18');
    for (const path of ["xl/workbook.xml", "docProps/core.xml", "docProps/app.xml"]) {
      expect(await part(source, path)).not.toMatch(/absPath|d\.docs\.live\.net|rulun/i);
    }
    expect(await part(output, "xl/sharedStrings.xml")).toContain('count="32"');
  });

  it("長いキャスト名と大きい金額を、セルサイズを変えず縮小表示し再読込できる", async () => {
    const book = new ExcelJS.Workbook();
    const output = await fillReceiptTemplate(await template(), [{
      name: "長いキャスト名テスト", cells: { ...cells, G10: "長いキャスト名テスト", G2: 12345678, G8: 1234567.5 },
    }]);
    await book.xlsx.load(output as unknown as ExcelJS.Buffer);
    const sheet = book.worksheets[0];
    expect(sheet.getCell("G2").value).toBe(12345678);
    expect(sheet.getCell("G8").value).toBe(1234567.5);
    expect(sheet.getCell("G8").numFmt).toContain(".###############");
    expect(sheet.getCell("G10").value).toBe("長いキャスト名テスト");
    expect(sheet.getCell("G10").alignment.shrinkToFit).toBe(true);
    expect(sheet.getCell("G2").alignment.shrinkToFit).toBe(true);
    expect(sheet.getCell("G5").font.bold).toBe(true);
    expect(sheet.getCell("G5").font.name).toBe("Yu Gothic");
    expect(sheet.getCell("C16").value).toBeNull();
    expect(sheet.getCell("B13").value).toBe("令和");
    expect(sheet.getCell("B15").value).toBe("氏名");
  });

  it("キャスト名を文字列として扱い、使用禁止文字・大文字小文字の同名・長い名前・Historyを安全なシート名にする", async () => {
    const names = ["=1+1<&>\"'", "a/b", "A:B", "history", "'末尾'", "あ".repeat(50), "あ".repeat(50), "😀".repeat(20)];
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(await fillReceiptTemplate(await template(), names.map((name) => ({ name, cells: { ...cells, G10: name } }))) as unknown as ExcelJS.Buffer);
    expect(new Set(book.worksheets.map((sheet) => sheet.name.toLowerCase())).size).toBe(names.length);
    book.worksheets.forEach((sheet, index) => {
      expect(sheet.name.length).toBeLessThanOrEqual(31);
      expect(sheet.name).not.toMatch(/[\\/*?:\[\]]/);
      expect(sheet.getCell("G10").value).toBe(names[index]);
    });
  });

  it("テンプレート欠損・対象外セル・非数値・壊れた文字を出力しない", async () => {
    const bytes = await template();
    await expect(fillReceiptTemplate(bytes, [])).rejects.toThrow("出力するキャスト");
    const invalidCells: Record<string, string | number>[] = [{ C16: "署名" }, { G8: NaN }, { G10: "あ\u0001" }, { G10: "\uD800" }];
    for (const invalid of invalidCells) {
      await expect(fillReceiptTemplate(bytes, [{ name: "テスト", cells: invalid }])).rejects.toThrow();
    }
    const missing = await JSZip.loadAsync(bytes);
    missing.remove("xl/printerSettings/printerSettings1.bin");
    await expect(fillReceiptTemplate(await missing.generateAsync({ type: "uint8array" }), [{ name: "テスト", cells }])).rejects.toThrow("印刷設定");
  });
});
