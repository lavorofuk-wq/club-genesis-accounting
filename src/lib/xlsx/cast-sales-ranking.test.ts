import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs/dist/exceljs.min.js";
import JSZip from "jszip";
import type { CastSalesRanking } from "@/domain/cast-sales-ranking";
import { CAST_SALES_RANKING_TEMPLATE_URL, createCastSalesRankingWorkbook } from "./cast-sales-ranking";

function input(count: number): CastSalesRanking {
  return { rosterMissing: false, rows: Array.from({ length: count }, (_, i) => ({
    id: `test-${i}`, name: `テスト${i + 1}`, rank: i + 1,
    honShimeiSales: 300_000 - i * 1_000, jonaiExtensionSales: 40_000, additionalSales: 90_000,
    totalSales: 430_000 - i * 1_000, honShimeiCount: 3, banaiShimeiCount: 2, dohanCount: 1, hours: 48.25,
  })) };
}

beforeEach(async () => {
  const template = await readFile("public/templates/cast-sales-ranking-v1.xlsx");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new Uint8Array(template).buffer }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("売上順位表XLSX", () => {
  it("見本の10列に保存値を転記し、追加売上を独立表示する", async () => {
    const data = input(3);
    const before = structuredClone(data);
    const book = await createCastSalesRankingWorkbook(data, "2026-09");
    const sheet = book.worksheets[0];
    expect(fetch).toHaveBeenCalledWith(CAST_SALES_RANKING_TEMPLATE_URL, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(sheet.getCell("A2").value).toBe("2026年9月 売上順位表");
    expect(sheet.getCell("E5").value).toBe("追加売上");
    expect(sheet.getRow(6).values).toEqual([, 1, "テスト1", 300000, 40000, 90000, 430000, 3, 2, 1, 48.25]);
    expect(sheet.getCell("B6").font.name).toBe("Yu Gothic");
    expect(sheet.getCell("F6").font.bold).toBe(true);
    expect(data).toEqual(before);
  });

  it.each([1, 20, 21, 40, 41])("%i名を欠落させず印刷範囲・20名改ページを設定し保存し直せる", async (count) => {
    const book = await createCastSalesRankingWorkbook(input(count), "2026-09");
    const loaded = new ExcelJS.Workbook();
    const bytes = await book.xlsx.writeBuffer();
    await loaded.xlsx.load(bytes);
    const sheet = loaded.worksheets[0];
    expect(loaded.worksheets).toHaveLength(1);
    expect(sheet.rowCount).toBe(count + 5);
    expect(sheet.getCell(`B${count + 5}`).value).toBe(`テスト${count}`);
    expect(sheet.pageSetup).toMatchObject({ paperSize: 9, orientation: "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0, printArea: `A1:J${count + 5}`, printTitlesRow: "1:5" });
    // ExcelJS読取器は改ページを復元しないため、保存したOOXML自体で検証する。
    const zip = await JSZip.loadAsync(bytes);
    const xml = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
    expect([...xml.matchAll(/<brk id="(\d+)"/g)].map((match) => Number(match[1]))).toEqual(Array.from({ length: Math.floor((count - 1) / 20) }, (_, i) => 25 + i * 20));
    expect(sheet.views[0].showGridLines).toBe(false);
  });

  it("同順位は同じ色、売上0円も数値0として保持し、長い名前は折り返す", async () => {
    const data = input(3);
    data.rows[1].rank = 1;
    data.rows[2] = { ...data.rows[2], name: "非常に長いキャスト名を省略せず表示", honShimeiSales: 0, jonaiExtensionSales: 0, additionalSales: 0, totalSales: 0, hours: 0 };
    const sheet = (await createCastSalesRankingWorkbook(data, "2026-09")).worksheets[0];
    expect(sheet.getCell("A6").fill).toEqual(sheet.getCell("A7").fill);
    expect(sheet.getCell("F8").value).toBe(0);
    expect(sheet.getCell("J8").value).toBe(0);
    expect(sheet.getCell("B8").alignment.wrapText).toBe(true);
    expect(sheet.getRow(8).height).toBeGreaterThan(36);
  });

  it.each([false, true])("名簿未保存=%sでも説明文・警告をXLSXに保存せず、金額と印刷レイアウトを維持する", async (rosterMissing) => {
    const data = { ...input(1), rosterMissing };
    const book = await createCastSalesRankingWorkbook(data, "2026-09");
    const bytes = await book.xlsx.writeBuffer();
    const loaded = new ExcelJS.Workbook();
    await loaded.xlsx.load(bytes);
    const sheet = loaded.worksheets[0];
    expect(sheet.getCell("A3").value).toBeNull();
    expect(sheet.getCell("A4").value).toBeNull();
    expect(sheet.getCell("A2").value).toBe("2026年9月 売上順位表");
    expect(sheet.getRow(6).values).toEqual([, 1, "テスト1", 300000, 40000, 90000, 430000, 3, 2, 1, 48.25]);
    expect(sheet.getRow(6).height).toBe(36);
    expect(sheet.pageSetup).toMatchObject({ paperSize: 9, orientation: "portrait", fitToWidth: 1, fitToHeight: 0, printArea: "A1:J6", printTitlesRow: "1:5" });
    const template = new ExcelJS.Workbook();
    await template.xlsx.load(new Uint8Array(await readFile("public/templates/cast-sales-ranking-v1.xlsx")).buffer);
    for (let row = 1; row <= 5; row++) {
      expect(sheet.getRow(row).height).toBe(template.worksheets[0].getRow(row).height);
    }
    const zip = await JSZip.loadAsync(bytes);
    const xml = (await Promise.all(Object.values(zip.files).filter((file) => /\.xml$/.test(file.name)).map((file) => file.async("string")))).join("\n");
    expect(xml).not.toMatch(/承認済み|未確定|確定済み|金額：|勤務：|掲載：|原価控除前|在籍者名簿は未保存|保存済みの出勤者のみ/);
  });

  it("数式に見える名前は文字列として保存する", async () => {
    const data = input(1); data.rows[0].name = '=SUM(1,2)';
    const book = await createCastSalesRankingWorkbook(data, "2026-09");
    const loaded = new ExcelJS.Workbook(); await loaded.xlsx.load(await book.xlsx.writeBuffer());
    expect(loaded.worksheets[0].getCell("B6").value).toBe('=SUM(1,2)');
    expect(loaded.worksheets[0].getCell("B6").formula).toBeUndefined();
  });

  it("読込失敗・誤った様式・空名簿・対象月不正はダウンロード前に停止する", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false } as Response);
    await expect(createCastSalesRankingWorkbook(input(1), "2026-09")).rejects.toThrow("様式を読み込めません");
    const wrong = new ExcelJS.Workbook(); wrong.addWorksheet("別の様式");
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, arrayBuffer: async () => wrong.xlsx.writeBuffer() } as Response);
    await expect(createCastSalesRankingWorkbook(input(1), "2026-09")).rejects.toThrow("様式が正しくありません");
    await expect(createCastSalesRankingWorkbook(input(0), "2026-09")).rejects.toThrow("在籍キャストがありません");
    await expect(createCastSalesRankingWorkbook(input(1), "2026-13")).rejects.toThrow("対象月が正しくありません");
  });
});
