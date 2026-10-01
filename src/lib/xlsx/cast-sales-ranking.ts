"use client";

import ExcelJS from "exceljs/dist/exceljs.min.js";
import type { CastSalesRanking } from "@/domain/cast-sales-ranking";

export const CAST_SALES_RANKING_TEMPLATE_URL = "/templates/cast-sales-ranking-v1.xlsx";
const font = { name: "Yu Gothic", size: 11, color: { argb: "FF223C49" } };
const amountFormat = '#,##0;[Red]-#,##0;0';
const decimalAmountFormat = '#,##0.###############;[Red]-#,##0.###############;0';

async function loadTemplate() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(CAST_SALES_RANKING_TEMPLATE_URL, { signal: controller.signal });
    if (!response.ok) throw new Error("売上順位表の様式を読み込めません。通信状態を確認して再度お試しください。");
    return await response.arrayBuffer();
  } finally { clearTimeout(timer); }
}

/** GMSで検証済みの順位・保存値を転記する。給与や店舗の売上は変更しない。 */
export async function createCastSalesRankingWorkbook(ranking: CastSalesRanking, month: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("対象月が正しくありません。");
  if (!ranking.rows.length) throw new Error("売上順位表に出力する在籍キャストがありません。");
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(await loadTemplate());
  const sheet = book.getWorksheet("売上順位表");
  if (!sheet || book.worksheets.length !== 1 || sheet.getCell("A5").value !== "順位" || sheet.getCell("J5").value !== "勤務時間") {
    throw new Error("売上順位表の様式が正しくありません。画面を更新して再度お試しください。");
  }
  const [year, selectedMonth] = month.split("-").map(Number);
  book.creator = "GMS";
  book.title = `${year}年${selectedMonth}月 売上順位表`;
  sheet.getCell("A2").value = book.title;
  // 説明・警告はGMS画面だけに表示する。セル位置と印刷寸法は維持する。
  sheet.getCell("A3").value = null;
  sheet.getCell("A4").value = null;
  const lastRow = 5 + ranking.rows.length;
  ranking.rows.forEach((entry, index) => {
    const rowNumber = index + 6;
    const row = sheet.getRow(rowNumber);
    row.values = [entry.rank, entry.name, entry.honShimeiSales, entry.jonaiExtensionSales, entry.additionalSales,
      entry.totalSales, entry.honShimeiCount, entry.banaiShimeiCount, entry.dohanCount, entry.hours];
    // 通常は20名で改ページ。長い名前は縮小せず折り返し、行高を拡張する。
    const nameUnits = Array.from(entry.name).reduce((sum, char) => sum + (/^[\x20-\x7E]$/.test(char) ? 0.5 : 1), 0);
    row.height = Math.max(36, Math.ceil(nameUnits / 7) * 15 + 8);
    const fill = entry.rank === 1 ? "FFF7EDD7" : entry.rank === 2 ? "FFEBF0F3" : entry.rank === 3 ? "FFF2EAE3"
      : index % 2 ? "FFF5F7F8" : "FFFFFFFF";
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      cell.font = { ...font, bold: col === 1 || col === 2 || col === 6 };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
      cell.border = { bottom: { style: "thin", color: { argb: "FFDCE3E6" } } };
      cell.alignment = { vertical: "middle", horizontal: col === 2 ? "left" : col >= 3 && col <= 6 ? "right" : "center", wrapText: col === 2 };
      const integer = typeof cell.value === "number" && Number.isInteger(cell.value);
      cell.numFmt = col >= 3 && col <= 6 ? integer ? amountFormat : decimalAmountFormat : col === 10 && !integer ? "0.##" : "0";
    });
    if ((index + 1) % 20 === 0 && index + 1 < ranking.rows.length) row.addPageBreak();
  });
  sheet.views = [{ state: "frozen", ySplit: 5, activeCell: "A6", showGridLines: false }];
  sheet.pageSetup = {
    paperSize: 9, orientation: "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0,
    horizontalCentered: true, printArea: `A1:J${lastRow}`, printTitlesRow: "1:5",
    margins: { left: 0.28, right: 0.28, top: 0.35, bottom: 0.35, header: 0.12, footer: 0.15 },
  };
  sheet.headerFooter = { oddFooter: "&LCLUB GENESIS&C売上順位表&R&P / &N" };
  return book;
}
