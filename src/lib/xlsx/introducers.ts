"use client";

import ExcelJS from "exceljs/dist/exceljs.min.js";
import { buildIntroducerExport, type IntroducerExportCast, type IntroducerExportResults } from "@/domain/introducer-export";

const font = { name: "Yu Gothic", size: 10, color: { argb: "FF253140" } };
const border: Partial<ExcelJS.Borders> = Object.fromEntries(["top", "bottom", "left", "right"]
  .map((side) => [side, { style: "thin", color: { argb: "FF9EADC4" } }]));
const fills = { header: "FFE2E8F0", total: "FFF0F5FA", adopted: "FFFFF2CC" };

function safeSheetName(name: string, used: Set<string>) {
  const clean = name.replace(/[\x00-\x1f\\/*?:[\]]/g, " ").trim().replace(/^'+|'+$/g, "").trim() || "紹介者";
  const base = clean.toLowerCase() === "history" ? `${clean}_` : clean;
  let suffix = "";
  let candidate = "";
  for (let index = 1; ; index += 1) {
    candidate = base.slice(0, 31 - suffix.length).replace(/[\uD800-\uDBFF]$/, "").replace(/'+$/g, "") + suffix;
    if (!used.has(candidate.toLowerCase())) break;
    suffix = ` (${index + 1})`;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

/** 帳票の見出しだけ必要な範囲で結合し、明細には編集しやすい実幅の列を使う。 */
function cell(sheet: ExcelJS.Worksheet, row: number, col: number, width: number, value: string | number | null,
  tone?: keyof typeof fills, outline = true) {
  if (width > 1) sheet.mergeCells(row, col, row, col + width - 1);
  const target = sheet.getCell(row, col);
  target.value = value;
  target.font = { ...font, size: typeof value === "string" ? 9 : 10, bold: Boolean(tone) };
  target.alignment = { horizontal: typeof value === "number" ? "right" : "center", vertical: "middle",
    ...(typeof value === "string" ? { wrapText: true } : { shrinkToFit: true }) };
  // 確定済みの旧小数も整数表示に丸めて隠さない。
  target.numFmt = typeof value === "number" && !Number.isInteger(value)
    ? '#,##0.###############;[Red]-#,##0.###############;0' : '#,##0;[Red]-#,##0;0';
  for (let current = col; current < col + width; current += 1) {
    const part = sheet.getCell(row, current);
    // 結合直後はstyleを共有するため、各セルの外周を別オブジェクトにする。
    part.style = { ...part.style,
      ...(outline ? { border: { top: border.top, bottom: border.bottom,
        ...(current === col ? { left: border.left } : {}), ...(current === col + width - 1 ? { right: border.right } : {}) } } : {}),
      ...(tone ? { fill: { type: "pattern", pattern: "solid", fgColor: { argb: fills[tone] } } as ExcelJS.Fill } : {}) };
  }
  return target;
}

function payroll(sheet: ExcelJS.Worksheet, cast: Exclude<IntroducerExportCast, { layout: "sales" }>, row: number,
  col: number, labelWidth: number, valueWidth: number) {
  const pay = cast.remuneration;
  cell(sheet, row, col, labelWidth + valueWidth, cast.name, "header");
  const values: Array<[string | null, number | null, (keyof typeof fills)?]> = [
    ["出勤日数", cast.attendanceDays], [pay.baseLabel, pay.basePay], ["バック計", pay.backs],
    ["手当て等", pay.allowance], ["総支給額", pay.grossPay, "total"], ["日払い・その他", pay.deductions],
    ["源泉所得税", pay.withholding], ["差引支給額", pay.netPay, "total"], [null, null],
    ["総支給額 10%", cast.grossFee], ["顧問料", cast.advisory],
    ["紹介料合計", cast.adopted === "売上10%" ? cast.grossFee + cast.advisory : cast.total,
      cast.layout === "comparison" && cast.adopted !== "売上10%" ? "adopted" : "total"],
  ];
  values.forEach(([label, value, tone], index) => {
    cell(sheet, row + index + 1, col, labelWidth, label, tone);
    cell(sheet, row + index + 1, col + labelWidth, valueWidth, value, tone);
  });
}

function sales(sheet: ExcelJS.Worksheet, cast: Exclude<IntroducerExportCast, { layout: "gross" }>, month: string,
  row: number, col: number, widths: [number, number, number]) {
  const [dayWidth, countWidth, salesWidth] = widths;
  const countCol = col + dayWidth;
  const amountCol = countCol + countWidth;
  const width = dayWidth + countWidth + salesWidth;
  cell(sheet, row, col, width, cast.name, "header");
  cell(sheet, row + 1, col, dayWidth + countWidth, "出勤日数");
  cell(sheet, row + 1, amountCol, salesWidth, cast.attendanceDays);
  cell(sheet, row + 2, col, dayWidth, "日", "header");
  cell(sheet, row + 2, countCol, countWidth, "本指", "header");
  cell(sheet, row + 2, amountCol, salesWidth, "本指売上計", "header");
  const [year, monthNumber] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const dates = new Map(cast.days.map((day) => [Number(day.businessDate.slice(8)), day]));
  for (let day = 1; day <= 31; day += 1) {
    const entry = dates.get(day);
    cell(sheet, row + 2 + day, col, dayWidth, day <= lastDay ? day : null).alignment.horizontal = "center";
    cell(sheet, row + 2 + day, countCol, countWidth, day <= lastDay ? entry?.honShimeiCount ?? 0 : null);
    cell(sheet, row + 2 + day, amountCol, salesWidth, day <= lastDay ? entry?.sales ?? 0 : null);
  }
  cell(sheet, row + 34, col, dayWidth, "合計", "total");
  cell(sheet, row + 34, countCol, countWidth, cast.honShimeiCount, "total");
  cell(sheet, row + 34, amountCol, salesWidth, cast.salesTotal, "total");
  const selected = cast.adopted === "売上10%";
  const totals: Array<[string, number, (keyof typeof fills)?]> = [
    ["売上10%", cast.salesFee], ["顧問料", cast.advisory],
    ["合計", selected ? cast.total : cast.salesFee + cast.advisory,
      cast.layout === "comparison" && selected ? "adopted" : "total"],
  ];
  totals.forEach(([label, value, tone], index) => {
    cell(sheet, row + 35 + index, col, dayWidth + countWidth, label, tone);
    cell(sheet, row + 35 + index, amountCol, salesWidth, value, tone);
  });
}

/** 見本の3様式を、人数に応じたページへ展開する。保存結果を値として記載し、数式・原価情報を残さない。 */
export function createIntroducerWorkbook(results: IntroducerExportResults, month: string) {
  const report = buildIntroducerExport(results, month);
  const book = new ExcelJS.Workbook();
  book.creator = "GENESIS Management System Ver2.36.0";
  book.created = new Date();
  const used = new Set<string>();
  for (const group of report.sheets) {
    const sheet = book.addWorksheet(safeSheetName(group.name, used));
    const allGross = group.casts.every((cast) => cast.layout === "gross");
    const allSales = group.casts.every((cast) => cast.layout === "sales");
    const widths = allGross ? [17, 15, 3] : allSales ? [4, 8, 13, 3] : [4, 8, 13, 2, 17, 15, 3];
    const columnsPerPage = allGross ? 3 : allSales ? 5 : 2;
    sheet.columns = Array.from({ length: columnsPerPage }, () => widths).flat().map((width) => ({ width }));
    sheet.views = [{ showGridLines: false }];
    sheet.properties.defaultRowHeight = 14;
    // 見本と同じB5横。比較様式は左右の金額欄が読める幅を確保して2人ずつ改ページする。
    sheet.pageSetup = { paperSize: 13, orientation: "landscape", scale: 85, fitToPage: false,
      margins: { left: 0, right: 0, top: 0, bottom: 0, header: 0, footer: 0 } };
    const perPage = allGross ? 6 : columnsPerPage;
    const pageHeight = allGross ? 30 : 41;
    const lastColumn = allGross ? "I" : allSales ? "T" : "N";
    const header = allGross ? [2, 4, 1, 2] : allSales ? [4, 8, 4, 4] : [3, 6, 1, 4];
    const pages = Math.ceil(group.casts.length / perPage);
    for (let page = 0; page < pages; page += 1) {
      const first = page * pageHeight + 1;
      for (let row = first; row < first + pageHeight; row += 1) sheet.getRow(row).height = allGross ? 16.8 : 14;
      sheet.getRow(first).height = Math.max(24, Math.ceil(group.name.length / 16) * 13);
      sheet.getRow(first + 1).height = 10;
      cell(sheet, first, 1, header[0], `${month.slice(0, 4)}年 ${Number(month.slice(5))}月`, undefined, false);
      cell(sheet, first, 1 + header[0], header[1], `紹介表 【 ${group.name} 】 殿`, undefined, false);
      cell(sheet, first, 1 + header[0] + header[1], header[2], `${group.casts.length}名`, undefined, false);
      cell(sheet, first, 1 + header[0] + header[1] + header[2], header[3], group.total, undefined, false).numFmt =
        Number.isInteger(group.total) ? '#,##0"円"' : '#,##0.###############"円"';
      const casts = group.casts.slice(page * perPage, (page + 1) * perPage);
      casts.forEach((cast, index) => {
        const col = 1 + (allGross ? index % 3 : index) * widths.length;
        const row = first + 2 + (allGross ? Math.floor(index / 3) * 14 : 0);
        sheet.getRow(row).height = Math.max(sheet.getRow(row).height || 0, Math.ceil(cast.name.length / (allSales ? 13 : 16)) * 14, 18);
        if (cast.layout === "gross") payroll(sheet, cast, row, col, allGross ? 1 : 3, allGross ? 1 : 3);
        else {
          sales(sheet, cast, month, row, col, [1, 1, 1]);
          if (cast.layout === "comparison") {
            sheet.getRow(row + 25).height = Math.max(sheet.getRow(row + 25).height || 0, Math.ceil(cast.name.length / 11) * 14, 18);
            payroll(sheet, cast, row + 25, col + 4, 1, 1);
          }
        }
      });
      if (page < pages - 1) sheet.getRow(first + pageHeight - 1).addPageBreak();
    }
    sheet.pageSetup.printArea = `A1:${lastColumn}${pages * pageHeight - 1}`;
  }
  return book;
}
