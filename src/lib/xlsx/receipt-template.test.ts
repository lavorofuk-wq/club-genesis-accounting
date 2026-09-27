import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import ExcelJS from "exceljs/dist/exceljs.min.js";
import { describe, expect, it } from "vitest";
import { fillReceiptTemplate, receiptCellAddress, type ReceiptDocument, type ReceiptSheet } from "./receipt-template";
import layouts from "./receipt-layouts.json";
import { statementAllowanceLines } from "./statement-allowance-pages";

const template = () => readFile("public/templates/cast-receipt-v3.xlsx");
const cells = { G1: "9月報酬分", G2: 100000, G3: 8300, G4: 1000, G5: 109300, G6: 10000, G7: 3000, G8: 96300, G10: "花子" };
const statementCells = { D3: "2026年9月分", F4: "花子", E5: "山田花子", F6: 20, F7: 80.25, F8: "3,000 / 4,000", F9: 100000, F10: 8300, F11: 0, F12: 0, F13: 0, F14: 0, F15: 1000, F18: 109300, F19: 3000, F20: 8000, F21: 1000, F22: 1000, F25: 13000, F26: 96300 };
const part = async (zip: JSZip, path: string) => zip.file(path)!.async("string");
const open = async (bytes: Uint8Array) => { const book = new ExcelJS.Workbook(); await book.xlsx.load(bytes as unknown as ExcelJS.Buffer); return book; };

describe("受領書と明細書の分割出力", () => {
  const combinations = (["receipt", "statement"] as const).flatMap((document) => [
    ["salesReward"], ["hourlyAndBack", "salesReward"], ["salesReward", "hourlyAndBack", "salesReward"],
  ].map((kinds) => ({ document, kinds: kinds as ReceiptSheet["template"][] })));
  it.each(combinations)("$document: 方式混在・順序変更でも選択した帳票だけを1人1シートへ出す（$kinds）", async ({ document, kinds }) => {
    const input = kinds.map((kind, index): ReceiptSheet => ({ template: kind, name: `キャスト${index + 1}`,
      cells: kind === "salesReward" ? { B2: "①　日売上－酒代（50％）×65％", G1: "9月報酬分", G2: 1234567, G3: 500, G4: 1235067, G5: 10000, G6: 2000, G7: 1223067, G9: `キャスト${index + 1}` } : { ...cells, G10: `キャスト${index + 1}` },
      statementCells: { ...statementCells, F4: `キャスト${index + 1}`, ...(kind === "salesReward" ? { B11: "報酬率", F11: 65, F12: 1234567, F18: 1235067, F25: 12000, F26: 1223067 } : {}) },
    }));
    const bytes = await fillReceiptTemplate(await template(), input, document);
    const output = await JSZip.loadAsync(bytes);
    const book = await open(bytes);
    expect(book.worksheets).toHaveLength(kinds.length);
    expect(Object.keys(output.files).filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))).toHaveLength(kinds.length);
    for (const [index, kind] of kinds.entries()) {
      const sales = kind === "salesReward";
      const sheet = book.worksheets[index];
      const value = (section: "receipt" | "statement", address: string) => sheet.getCell(receiptCellAddress(kind, section, address));
      const entries = document === "receipt" ? input[index].cells : input[index].statementCells;
      for (const [address, expected] of Object.entries(entries)) expect(value(document, address).value).toBe(expected);
      if (document === "receipt") {
        expect(value("receipt", sales ? "C15" : "C16").value).toBeNull();
        for (const [col, label] of [["B", "令和"], ["C", "年"], ["D", "月"], ["E", "日"]]) expect(value("receipt", `${col}${sales ? 12 : 13}`).value).toBe(label);
        expect(value("receipt", sales ? "G4" : "G5").font).toMatchObject({ name: "Yu Gothic", bold: true, size: 11 });
      } else {
        expect(value("statement", "B2").value).toBe("報酬明細書");
        expect(value("statement", "B9").value).toBe(sales ? "日売上計" : "基本支給額");
        expect(value("statement", "F16").value).toBeNull();
        expect(value("statement", "F23").value).toBeNull();
      }
      const printArea = document === "receipt" ? layouts[kind].receiptPrintArea : layouts[kind].statementPrintArea;
      expect(sheet.pageSetup.printArea).toBe(printArea.replace(/\$/g, ""));
      expect(sheet.pageSetup).toMatchObject({ paperSize: 281, orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 1 });
      const xml = await part(output, `xl/worksheets/sheet${index + 1}.xml`);
      expect(xml).not.toContain("<f>");
      expect(xml).not.toMatch(/<(rowBreaks|colBreaks)\b/);
      expect(xml).toContain(`<dimension ref="${printArea.replace(/\$/g, "")}"/>`);
      const lastRow = Number(printArea.match(/\$(\d+)$/)![1]);
      const lastCol = document === "receipt" ? "H" : "K";
      for (const address of xml.matchAll(/<c\b[^>]*\br="([A-Z]+)(\d+)"/g)) {
        expect(address[1]).toHaveLength(1);
        expect(address[1].charCodeAt(0)).toBeLessThanOrEqual(lastCol.charCodeAt(0));
        expect(Number(address[2])).toBeLessThanOrEqual(lastRow);
      }
      if (index > 0) expect(xml).not.toContain('tabSelected="1"');
      const nativePrinter = await output.file(`xl/printerSettings/printerSettings${sales ? 2 : 1}.bin`)!.async("uint8array");
      expect(createHash("sha256").update(nativePrinter).digest("hex")).toBe(sales ? "06e0b636885ac380d329aac7bb7be53c0709b65c65f6dafc74cb00d1705c08c5" : "8b28e3931744541a16b2f61c5497b634bc22498711ebf826f6515bacbe20f3ba");
    }
    const count = (await Promise.all(kinds.map((_, index) => part(output, `xl/worksheets/sheet${index + 1}.xml`)))).reduce((sum, xml) => sum + (xml.match(/<c\b[^>]*\bt="s"/g) || []).length, 0);
    expect(await part(output, "xl/sharedStrings.xml")).toContain(`count="${count}"`);
    const content = (await Promise.all(Object.keys(output.files).filter((path) => /\.xml$/.test(path)).map((path) => part(output, path)))).join("");
    if (document === "receipt") {
      expect(content).not.toContain("報酬明細書");
      expect(content).not.toContain("山田花子");
      expect(content).not.toContain("2026年9月分");
      expect(content).toContain("受領印");
    } else {
      expect(content).toContain("報酬明細書");
      expect(content).toContain("山田花子");
      expect(content).not.toContain("受領印");
      expect(content).not.toContain("上記のとおり確かに受領いたしました。");
      expect(content).not.toContain("9月報酬分");
    }
  });

  it("分割元テンプレートは従来の幅・各行の物理位置・受領書の余白を保っている", async () => {
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

  it.each(["receipt", "statement"] as const)("%s: 列幅・物理行高・結合・余白を分割元からそのまま保持する", async (document) => {
    const source = await open(await template());
    const kinds = ["hourlyAndBack", "salesReward"] as const;
    const output = await open(await fillReceiptTemplate(await template(), kinds.map((kind) => ({
      template: kind, name: kind, cells: {}, statementCells: {},
    })), document));
    for (const [index, kind] of kinds.entries()) {
      const before = source.worksheets[index]; const after = output.worksheets[index];
      const offset = document === "receipt" ? 0 : layouts[kind].statementColumnOffset;
      const width = document === "receipt" ? 8 : 11;
      const printArea = document === "receipt" ? layouts[kind].receiptPrintArea : layouts[kind].statementPrintArea;
      const lastRow = Number(printArea.match(/\$(\d+)$/)![1]);
      for (let col = 1; col <= width; col += 1) expect(after.getColumn(col).width).toBe(before.getColumn(col + offset).width);
      let beforeHeight = 0; let afterHeight = 0;
      for (let row = 1; row <= lastRow; row += 1) {
        expect(after.getRow(row).height).toBe(before.getRow(row).height);
        beforeHeight += before.getRow(row).height || before.properties.defaultRowHeight;
        afterHeight += after.getRow(row).height || after.properties.defaultRowHeight;
      }
      expect(afterHeight).toBe(beforeHeight);
      const expectedMerges = before.model.merges!.filter((range) => {
        const [, left, , right] = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range)!;
        return left.length === 1 && right.length === 1 && left.charCodeAt(0) > 64 + offset && right.charCodeAt(0) <= 64 + offset + width;
      }).map((range) => range.replace(/[A-Z]+/g, (col) => String.fromCharCode(col.charCodeAt(0) - offset))).sort();
      expect(after.model.merges!.sort()).toEqual(expectedMerges);
      expect(after.pageSetup.margins).toEqual(before.pageSetup.margins);
      // 元の右側明細はJ列基点。分割後の同名セルとの比較時も元位置を独立に求める。
      const originalHeader = document === "receipt" ? "D1" : `K${layouts[kind].statementRows[1]}`;
      const outputHeader = document === "receipt" ? "D1" : receiptCellAddress(kind, document, "B2");
      expect(after.getCell(outputHeader).value).toEqual(before.getCell(originalHeader).value);
    }
  });

  it.each(["receipt", "statement"] as const)("%s: 大きい金額・小数・長い名前を保持し、既存小数書式を壊さない", async (document) => {
    const name = "長いキャスト名テスト";
    const bytes = await fillReceiptTemplate(await template(), [{ template: "hourlyAndBack", name, cells: { ...cells, G10: name, G2: 12345678, G8: 1234567.5 }, statementCells: { ...statementCells, F4: name, E5: "山田花子名前が長い場合", F9: 12345678, F26: 1234567.5 } }], document);
    const sheet = (await open(bytes)).worksheets[0];
    const get = (section: "receipt" | "statement", address: string) => sheet.getCell(receiptCellAddress("hourlyAndBack", section, address));
    expect(get(document, document === "receipt" ? "G2" : "F9").value).toBe(12345678);
    const net = get(document, document === "receipt" ? "G8" : "F26");
    expect(net.value).toBe(1234567.5);
    expect(net.numFmt).toContain(".###############");
    const nameCell = get(document, document === "receipt" ? "G10" : "F4");
    expect(nameCell.font.size).toBeLessThan(11);
    expect(nameCell.alignment.shrinkToFit).toBe(true);
    if (document === "statement") expect(get("statement", "F7").value).toBe(80.25);
    const styles = await part(await JSZip.loadAsync(bytes), "xl/styles.xml");
    expect((styles.match(/<numFmts\b/g) || [])).toHaveLength(1);
    expect(styles).toContain('numFmtId="176"');
    expect(styles).toContain('formatCode="0.##"');
  });

  it.each(["receipt", "statement"] as const)("%s: 数式風の氏名を文字列で扱い、同名・禁止文字・長いシート名を安全に出力する", async (document) => {
    const names = ["=1+1<&>\"'", "a/b", "A:B", "history", "'末尾'", "あ".repeat(50), "あ".repeat(50), "😀".repeat(20)];
    const book = await open(await fillReceiptTemplate(await template(), names.map((name) => ({ template: "hourlyAndBack", name, cells: { ...cells, G10: name }, statementCells: { ...statementCells, E5: name } })), document));
    expect(new Set(book.worksheets.map((sheet) => sheet.name.toLowerCase())).size).toBe(names.length);
    book.worksheets.forEach((sheet, index) => {
      expect(sheet.name.length).toBeLessThanOrEqual(31);
      expect(sheet.name).not.toMatch(/[\\/*?:\[\]]/);
      expect(sheet.getCell(receiptCellAddress("hourlyAndBack", document, document === "receipt" ? "G10" : "E5")).value).toBe(names[index]);
    });
  });

  it.each(["receipt", "statement"] as const)("%s: 欠損テンプレート・対象外セル・不正値・1ページ設定の欠損を拒否する", async (document) => {
    const bytes = await template();
    await expect(fillReceiptTemplate(bytes, [], document)).rejects.toThrow("出力するキャスト");
    const invalidCells: Record<string, string | number>[] = document === "receipt"
      ? [{ C16: "署名" }, { G8: NaN }, { G10: "あ\u0001" }, { G10: "\uD800" }]
      : [{ F23: 100 }, { F26: NaN }, { E5: "あ\u0001" }, { E5: "\uD800" }];
    for (const invalid of invalidCells) await expect(fillReceiptTemplate(bytes, [{ template: "hourlyAndBack", name: "テスト",
      cells: document === "receipt" ? invalid : cells, statementCells: document === "statement" ? invalid : statementCells,
    }], document)).rejects.toThrow();
    for (const printer of [true, false]) {
      const missing = await JSZip.loadAsync(bytes);
      if (printer) missing.remove("xl/printerSettings/printerSettings1.bin");
      else missing.file("xl/worksheets/sheet1.xml", (await part(missing, "xl/worksheets/sheet1.xml")).replace('fitToHeight="1"', 'fitToHeight="2"'));
      await expect(fillReceiptTemplate(await missing.generateAsync({ type: "uint8array" }), [{ template: "hourlyAndBack", name: "テスト", cells, statementCells }], document)).rejects.toThrow("印刷設定");
    }
  });

  it("未指定・不正な帳票区分を一体型へ補完しない", async () => {
    for (const document of [undefined, "combined", ""]) {
      await expect(fillReceiptTemplate(await template(), [{ template: "hourlyAndBack", name: "テスト", cells, statementCells }], document as ReceiptDocument)).rejects.toThrow("出力する帳票");
    }
  });

  it.each(["receipt", "statement"] as const)("%s: 分割境界をまたぐ結合や数式が混入した様式は壊れた帳票を生成せず停止する", async (document) => {
    for (const corruption of ["merge", "formula"] as const) {
      const zip = await JSZip.loadAsync(await template());
      const xml = await part(zip, "xl/worksheets/sheet1.xml");
      zip.file("xl/worksheets/sheet1.xml", corruption === "merge"
        ? xml.replace("</mergeCells>", '<mergeCell ref="H1:J2"/></mergeCells>')
        : xml.replace("</sheetData>", '<row r="47"><c r="A47"><f>1+1</f><v>2</v></c></row></sheetData>'));
      await expect(fillReceiptTemplate(await zip.generateAsync({ type: "uint8array" }), [{ template: "hourlyAndBack", name: "テスト", cells, statementCells }], document))
        .rejects.toThrow(corruption === "merge" ? "結合範囲" : "分割できない項目");
    }
  });
});

describe("明細書の美容室と名目別手当・固定寸法の続き頁", () => {
  const kinds = ["hourlyAndBack", "salesReward"] as const;
  const input = (kind: ReceiptSheet["template"], allowances: NonNullable<ReceiptSheet["statementAllowances"]>): ReceiptSheet => ({
    template: kind, name: "花子", cells: kind === "hourlyAndBack" ? cells : { G1: cells.G1, G2: cells.G2, G3: cells.G3, G4: cells.G4, G5: cells.G5, G6: cells.G6, G7: cells.G8, G9: cells.G10 },
    statementCells: { ...statementCells, B15: "美容室手当" }, statementAllowances: allowances,
  });
  async function inspect(kind: ReceiptSheet["template"], allowances: NonNullable<ReceiptSheet["statementAllowances"]>) {
    const bytes = await fillReceiptTemplate(await template(), [input(kind, allowances)], "statement");
    const zip = await JSZip.loadAsync(bytes), book = await open(bytes), sheet = book.worksheets[0];
    const workbook = await part(zip, "xl/workbook.xml");
    const areas = [...workbook.matchAll(/!\$A\$(\d+):\$K\$(\d+)/g)].map((match) => ({ start: Number(match[1]), end: Number(match[2]) }));
    const detail = areas.flatMap(({ start }, page) => (page === 0 ? [16, 17] : Array.from({ length: 20 }, (_, n) => n + 7))
      .map((logical) => ({ label: sheet.getCell("B" + (layouts[kind].statementRows[logical - 1] + start - 1)),
        amount: sheet.getCell("F" + (layouts[kind].statementRows[logical - 1] + start - 1)) })));
    return { bytes, zip, sheet, areas, detail, xml: await part(zip, "xl/worksheets/sheet1.xml") };
  }
  async function qa(name: string, bytes: Uint8Array) {
    const directory = process.env.GMS_STATEMENT_QA_DIR;
    if (!directory) return;
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, name + ".xlsx"), bytes);
  }

  it.each(kinds)("%s: 追加なしは固定の手当表示を消し、美容室と元の給与・控除を独立保持する", async (kind) => {
    const result = await inspect(kind, []);
    expect(result.areas).toHaveLength(1);
    expect(result.sheet.getCell(receiptCellAddress(kind, "statement", "B15")).value).toBe("美容室手当");
    expect(result.sheet.getCell(receiptCellAddress(kind, "statement", "F15")).value).toBe(1000);
    for (const logical of [16, 17]) for (const col of ["B", "F", "J"]) expect(result.sheet.getCell(receiptCellAddress(kind, "statement", col + logical)).value).toBeNull();
    for (const [logical, amount] of Object.entries(statementCells)) if (logical.startsWith("F")) expect(result.sheet.getCell(receiptCellAddress(kind, "statement", logical)).value).toBe(amount);
    const legacy = (await open(await fillReceiptTemplate(await template(), [{ ...input(kind, []), statementAllowances: undefined }], "statement"))).worksheets[0];
    expect(legacy.getCell(receiptCellAddress(kind, "statement", "B16")).value).toBe("手当");
  });

  it.each(kinds)("%s: 1・2名目は既存の空き枠だけに収め、0円を欠損にしない", async (kind) => {
    for (const allowances of [[{ label: "売上手当", amount: 0 }], [{ label: "売上手当", amount: 0 }, { label: "特別手当", amount: 1500 }]]) {
      const result = await inspect(kind, allowances);
      expect(result.areas).toHaveLength(1);
      expect(result.detail.filter((item) => item.label.value !== null).map((item) => item.label.value)).toEqual(allowances.map((item) => item.label));
      expect(result.detail.filter((item) => item.amount.value !== null).map((item) => item.amount.value)).toEqual(allowances.map((item) => item.amount));
      for (const item of result.detail) { expect(item.label.font.size).toBe(11); expect(item.label.alignment.shrinkToFit).toBe(false); }
    }
  });

  it.each(kinds)("%s: 初頁の手当単位欄は件数・空欄・0円によらず元様式の右罫線を保持する", async (kind) => {
    const sourceBook = await open(await template()), sourceSheet = sourceBook.worksheets[layouts[kind].source - 1];
    const cases: NonNullable<ReceiptSheet["statementAllowances"]>[] = [
      [], [{ label: "売上手当", amount: 0 }], [{ label: "売上手当", amount: 1500 }],
      [{ label: "売上手当", amount: 1500 }, { label: "特別手当", amount: 2000 }],
      Array.from({ length: 43 }, (_, i) => ({ label: "手当" + (i + 1), amount: i * 100 })),
    ];
    for (const allowances of cases) {
      const result = await inspect(kind, allowances);
      for (const logical of [16, 17]) {
        const physical = layouts[kind].statementRows[logical - 1];
        const unit = result.sheet.getCell("J" + physical), sourceUnit = sourceSheet.getCell("S" + physical);
        expect(sourceUnit.border.right?.style).toBeTruthy();
        expect(unit.border.right, `${kind} J${physical}, 手当${allowances.length}件`).toEqual(sourceUnit.border.right);
        expect(unit.style).toEqual(sourceUnit.style);
        expect(unit.value).toBe(allowances[logical - 16] ? "円" : null);
      }
    }
  });

  it.each(kinds)("%s: 多数の手当は同じ用紙・幅・各行高の離散印刷領域へ1回ずつ出力する", async (kind) => {
    const allowances = Array.from({ length: 43 }, (_, i) => ({ label: "手当" + (i + 1), amount: i === 0 ? 0 : i + .5 }));
    const result = await inspect(kind, allowances);
    expect(result.areas).toHaveLength(4);
    const sourceZip = await JSZip.loadAsync(await template());
    const original = await part(sourceZip, `xl/worksheets/sheet${layouts[kind].source}.xml`);
    const sourceBook = await open(await template()), sourceSheet = sourceBook.worksheets[layouts[kind].source - 1];
    const height = Number(layouts[kind].statementPrintArea.match(/\$(\d+)$/)![1]);
    const firstPageOnly = await inspect(kind, allowances.slice(0, 2));
    for (let physical = 1; physical <= height; physical += 1) {
      if (physical === layouts[kind].statementRows[26]) continue; // 続き頁の案内欄だけは従来どおり追加される。
      const unit = result.sheet.getCell("J" + physical), unchanged = firstPageOnly.sheet.getCell("J" + physical);
      expect(unit.value).toEqual(unchanged.value);
      expect(unit.master.address).toBe(unchanged.master.address);
      expect(unit.style).toEqual(unchanged.style);
    }
    expect(result.sheet.pageSetup).toMatchObject({ paperSize: 281, orientation: "landscape", fitToWidth: 1, fitToHeight: 1, fitToPage: true });
    for (const tag of ["pageSetup", "pageMargins", "pageSetUpPr"]) expect(result.xml.match(new RegExp(`<${tag}\\b[^>]*\\/>`))?.[0]).toBe(original.match(new RegExp(`<${tag}\\b[^>]*\\/>`))?.[0]);
    for (const [page, area] of result.areas.entries()) {
      expect(area).toEqual({ start: page * (height + 1) + 1, end: page * (height + 1) + height });
      for (let n = 0; n < height; n += 1) expect(result.sheet.getRow(area.start + n).height).toBe(sourceSheet.getRow(n + 1).height);
      if (page) {
        expect(result.sheet.getCell("B" + (area.start + layouts[kind].statementRows[1] - 1)).value).toBe("手当明細書");
        expect(result.sheet.getCell("D" + (area.start + layouts[kind].statementRows[2] - 1)).value).toBe("2026年9月分");
        expect(result.sheet.getCell("F" + (area.start + layouts[kind].statementRows[3] - 1)).value).toBe("花子");
        for (let logical = 6; logical <= 26; logical += 1) {
          const top = area.start + layouts[kind].statementRows[logical - 1] - 1;
          const bottom = area.start + layouts[kind].statementRows[logical] - 2;
          if (bottom > top) expect(result.xml).toContain(`<mergeCell ref="J${top}:J${bottom}"/>`);
          for (let physical = top; physical <= bottom; physical += 1) {
            expect(result.sheet.getCell("J" + physical).master.address).toBe("J" + top);
          }
          const amount = result.sheet.getCell("F" + top).value;
          expect(result.sheet.getCell("J" + top).value).toBe(typeof amount === "number" ? "円" : null);
        }
      }
    }
    for (let column = 1; column <= 11; column += 1) expect(result.sheet.getColumn(column).width).toBe(sourceSheet.getColumn(column + 9).width);
    expect(result.detail.filter((item) => item.label.value !== null).map((item) => item.label.value)).toEqual(allowances.map((item) => item.label));
    expect(result.detail.filter((item) => item.amount.value !== null).map((item) => item.amount.value)).toEqual(allowances.map((item) => item.amount));
    const subsequent = result.xml.split(`<row r="${height + 2}"`)[1];
    for (const amount of [statementCells.F9, statementCells.F18, statementCells.F25, statementCells.F26]) expect(subsequent).not.toContain(`<v>${amount}</v>`);
    const printerPath = `xl/printerSettings/printerSettings${layouts[kind].source}.bin`;
    expect(await result.zip.file(printerPath)!.async("uint8array")).toEqual(await sourceZip.file(printerPath)!.async("uint8array"));
    expect(await part(result.zip, "xl/worksheets/_rels/sheet1.xml.rels")).toBe(await part(sourceZip, `xl/worksheets/_rels/sheet${layouts[kind].source}.xml.rels`));
    expect(result.xml).not.toMatch(/<(rowBreaks|colBreaks)\b/);
    await qa("allowance-overflow-" + kind, result.bytes);
  });

  it.each(kinds)("%s: 100文字・多数改行・特殊文字の名目全文を縮小せず保持し、金額は1回だけ印字する", async (kind) => {
    const allowances = [{ label: "長".repeat(100), amount: 100 }, { label: "改行" + "\n".repeat(97) + "終", amount: 200 }, { label: "=1+1<&>\"'😀", amount: 300 }];
    const result = await inspect(kind, allowances);
    expect(result.areas.length).toBeGreaterThan(3);
    expect(result.detail.map((item) => item.label.value || "").join("")).toBe(allowances.map((item) => item.label).join(""));
    expect(result.detail.filter((item) => item.amount.value !== null).map((item) => item.amount.value)).toEqual([100, 200, 300]);
    for (const item of result.detail) { expect(item.label.font.size).toBe(11); expect(item.label.alignment.shrinkToFit).toBe(false); }
    expect(result.xml).not.toContain("<f>");
    expect(statementAllowanceLines("e\u0301e\u0301e\u0301", 1)).toEqual(["e\u0301", "e\u0301", "e\u0301"]);
    await qa("allowance-long-label-" + kind, result.bytes);
  });

  it.each(kinds)("%s: 空き枠と続き頁の境界に余計な白紙頁や欠落を作らない", async (kind) => {
    for (const [count, pages] of [[2, 1], [3, 2], [22, 2], [23, 3], [42, 3]]) {
      const result = await inspect(kind, Array.from({ length: count }, (_, i) => ({ label: "手当" + i, amount: i })));
      expect(result.areas).toHaveLength(pages);
      expect(result.detail.filter((item) => item.amount.value !== null)).toHaveLength(count);
    }
  });

  it.each(kinds)("%s: 受領書は新しい手当明細の有無にかかわらず全ZIPパーツが同一", async (kind) => {
    const source = await template();
    const plain = await JSZip.loadAsync(await fillReceiptTemplate(source, [{ ...input(kind, []), statementAllowances: undefined }], "receipt"));
    const extra = await JSZip.loadAsync(await fillReceiptTemplate(source, [input(kind, [{ label: "長".repeat(100), amount: 100 }])], "receipt"));
    expect(Object.keys(extra.files)).toEqual(Object.keys(plain.files));
    for (const file of Object.keys(plain.files)) if (!plain.files[file].dir) expect(await extra.file(file)!.async("uint8array")).toEqual(await plain.file(file)!.async("uint8array"));
  });

  it("不正な名目・金額では壊れた明細を出さない", async () => {
    for (const allowance of [{ label: " ", amount: 1 }, { label: "a".repeat(101), amount: 1 }, { label: "a\u0001", amount: 1 },
      { label: "\uD800", amount: 1 }, { label: "手当", amount: -1 }, { label: "手当", amount: NaN }, { label: "手当", amount: Infinity }, { label: "手当", amount: Number.MAX_SAFE_INTEGER + 1 }]) {
      await expect(fillReceiptTemplate(await template(), [input("hourlyAndBack", [allowance])], "statement")).rejects.toThrow("手当名目・金額");
    }
  });
});
