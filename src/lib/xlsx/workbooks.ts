"use client";

import ExcelJS from "exceljs/dist/exceljs.min.js";
import type { CastMember, FinalizedClosing, FixedExpense } from "@/domain/types";
import { calculateCastRewards, closingTotals, rowsForMonth } from "@/domain/monthly";

const yenFormat = '#,##0"円"';
const thinBorder: Partial<ExcelJS.Borders> = {
  top: { style: "thin", color: { argb: "FFD7DDE2" } },
  left: { style: "thin", color: { argb: "FFD7DDE2" } },
  bottom: { style: "thin", color: { argb: "FFD7DDE2" } },
  right: { style: "thin", color: { argb: "FFD7DDE2" } }
};

function workbook() {
  const book = new ExcelJS.Workbook();
  book.creator = "GENESIS Management System Ver2.16.0";
  book.created = new Date();
  return book;
}

function title(sheet: ExcelJS.Worksheet, value: string, range: string) {
  sheet.mergeCells(range);
  const cell = sheet.getCell(range.split(":")[0]);
  cell.value = value;
  cell.font = { name: "BIZ UDPGothic", size: 16, bold: true, color: { argb: "FF183E5A" } };
  cell.alignment = { horizontal: "center", vertical: "middle" };
}

function header(row: ExcelJS.Row) {
  row.eachCell((cell) => {
    cell.font = { name: "BIZ UDPGothic", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF142C3F" } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = thinBorder;
  });
}

function body(sheet: ExcelJS.Worksheet, first: number, last: number) {
  for (let rowIndex = first; rowIndex <= last; rowIndex += 1) {
    const row = sheet.getRow(rowIndex);
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.font = { name: "BIZ UDPGothic", size: 10 };
      cell.alignment = { vertical: "middle", wrapText: true };
      cell.border = thinBorder;
    });
  }
}

function setup(sheet: ExcelJS.Worksheet, orientation: "portrait" | "landscape" = "landscape") {
  sheet.views = [{ showGridLines: false, state: "frozen", ySplit: 2 }];
  sheet.pageSetup = {
    paperSize: 9,
    orientation,
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    margins: { left: .25, right: .25, top: .4, bottom: .4, header: .2, footer: .2 }
  };
}

function uniqueSheetName(name: string, used: Set<string>) {
  const base = name.replace(/[\\/*?:[\]]/g, " ").trim().slice(0, 31) || "明細";
  let candidate = base;
  let index = 2;
  while (used.has(candidate)) {
    const suffix = `_${index++}`;
    candidate = `${base.slice(0, 31 - suffix.length)}${suffix}`;
  }
  used.add(candidate);
  return candidate;
}

export function createFinalizedWorkbook(closings: FinalizedClosing[], month: string) {
  const book = workbook();
  const sheet = book.addWorksheet("ジェネシス収支表");
  setup(sheet);
  sheet.columns = [
    { width: 7 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 9 },
    { width: 9 }, { width: 12 }, { width: 14 }, { width: 14 }, { width: 14 }
  ];
  title(sheet, `${month.replace("-", "年")}月度 ジェネシス収支表`, "A1:J1");
  sheet.addRow(["日", "売上", "現金", "カード", "組数", "客数", "客単価", "経費", "手当", "収支"]);
  header(sheet.getRow(2));
  const monthRows = rowsForMonth(closings, month);
  const map = new Map(monthRows.map((closing) => [Number(closing.businessDate.slice(8)), closing]));
  const [year, monthNumber] = month.split("-").map(Number);
  const maxDay = new Date(year, monthNumber, 0).getDate();
  for (let day = 1; day <= 31; day += 1) {
    const closing = map.get(day);
    const totals = closing ? closingTotals(closing) : undefined;
    const row = sheet.addRow([
      day <= maxDay ? day : "",
      totals?.sales || 0,
      totals?.cash || 0,
      totals?.card || 0,
      totals?.groups || 0,
      totals?.customers || 0,
      totals?.customers ? Math.floor(totals.sales / totals.customers) : "",
      totals?.expense || 0,
      totals?.allowance || 0,
      totals?.profit || 0
    ]);
    [2, 3, 4, 7, 8, 9, 10].forEach((column) => { row.getCell(column).numFmt = yenFormat; });
  }
  const totalRow = sheet.addRow(["合計", ...Array(9).fill(null)]);
  for (let column = 2; column <= 10; column += 1) {
    totalRow.getCell(column).value = { formula: `SUM(${sheet.getColumn(column).letter}3:${sheet.getColumn(column).letter}33)`, result: 0 };
    if ([2, 3, 4, 7, 8, 9, 10].includes(column)) totalRow.getCell(column).numFmt = yenFormat;
  }
  header(totalRow);
  body(sheet, 3, 33);
  sheet.autoFilter = "A2:J33";
  sheet.pageSetup.printArea = "A1:J34";
  return book;
}

export function createExpenseWorkbook(
  closings: FinalizedClosing[],
  fixedExpenses: FixedExpense[],
  month: string
) {
  const book = workbook();
  const sheet = book.addWorksheet("ジェネシス経費表");
  setup(sheet);
  const categories = ["酒代", "紹介料・広告等", "備品・消耗品他", "交際費・プレゼント等", "交通費", "美容バック", "その他", "旧データ"];
  const categoryLabels: Record<string, string> = {
    beautyBack: "美容バック",
    introducerAdvertising: "紹介料・広告等",
    supplies: "備品・消耗品他",
    entertainment: "交際費・プレゼント等",
    liquor: "酒代",
    transport: "交通費",
    "美容室": "美容バック",
    "店内宣伝費": "紹介料・広告等",
    "店外宣伝費": "紹介料・広告等",
    "消耗品/備品": "備品・消耗品他",
    "交際費": "交際費・プレゼント等",
    "酒代": "酒代",
    "交通費": "交通費",
    "その他": "その他"
  };
  sheet.columns = [{ width: 6 }, ...categories.flatMap(() => [{ width: 15 }, { width: 12 }]), { width: 14 }];
  title(sheet, `${month.replace("-", "年")}月度 ジェネシス経費表`, `A1:${sheet.getColumn(18).letter}1`);
  const heading = ["日", ...categories.flatMap((category) => [category, "金額"]), "合計"];
  sheet.addRow(heading);
  header(sheet.getRow(2));
  const monthRows = rowsForMonth(closings, month);
  const byDay = new Map<number, Map<string, number>>();
  monthRows.forEach((closing) => {
    const day = Number(closing.businessDate.slice(8));
    const bucket = byDay.get(day) || new Map<string, number>();
    closing.expenses.forEach((expense) => {
      const category = categoryLabels[expense.category || ""] || "旧データ";
      bucket.set(category, (bucket.get(category) || 0) + Number(expense.amount || 0));
    });
    byDay.set(day, bucket);
  });
  for (let day = 1; day <= 31; day += 1) {
    const bucket = byDay.get(day);
    const values: (string | number | ExcelJS.CellFormulaValue)[] = [day];
    categories.forEach((category) => {
      const amount = bucket?.get(category) || 0;
      values.push(amount ? category : "", amount);
    });
    values.push({ formula: `SUM(C${day + 2},E${day + 2},G${day + 2},I${day + 2},K${day + 2},M${day + 2},O${day + 2},Q${day + 2})`, result: 0 });
    const row = sheet.addRow(values);
    for (let column = 3; column <= 18; column += 2) row.getCell(column).numFmt = yenFormat;
  }
  const fixed = fixedExpenses.find((item) => item.month === month);
  sheet.addRow([]);
  const fixedHeading = sheet.addRow(["固定費", "賃料", "光熱費", "おしぼり", "カラオケ", "リースキン", "通信費", "オーリック", "合計"]);
  header(fixedHeading);
  const monthlyAuric = monthRows.reduce((sum, closing) => sum + Number(closing.auricLiquorAmount || 0), 0);
  const fixedValues = [
    fixed?.rent || 0, fixed?.utilities || fixed?.saibuGas || 0, fixed?.towel || 0,
    fixed?.karaoke || 0, fixed?.leasekin || 0,
    fixed?.communications || (fixed?.landline || 0) + (fixed?.usen || 0), monthlyAuric
  ];
  const fixedRow = sheet.addRow(["金額", ...fixedValues, { formula: "SUM(B36:H36)", result: 0 }]);
  fixedRow.eachCell((cell, column) => { if (column > 1) cell.numFmt = yenFormat; });
  body(sheet, 3, 33);
  body(sheet, 36, 36);
  sheet.pageSetup.printArea = "A1:R36";
  return book;
}

export function createCastStatementsWorkbook(
  closings: FinalizedClosing[],
  members: CastMember[],
  month: string
) {
  const book = workbook();
  const used = new Set<string>();
  const rewards = calculateCastRewards(rowsForMonth(closings, month), members);
  rewards.forEach((reward) => {
    const sheet = book.addWorksheet(uniqueSheetName(reward.name, used));
    setup(sheet, "portrait");
    sheet.columns = [{ width: 25 }, { width: 22 }];
    title(sheet, "キャスト報酬明細書", "A1:B1");
    sheet.addRow(["対象月", `${month.replace("-", "年")}月`]);
    sheet.addRow(["氏名", reward.name]);
    sheet.addRow(["勤務日数", reward.days]);
    sheet.addRow(["勤務時間", reward.hours]);
    sheet.addRow(["適用時給", reward.hourlyRate]);
    sheet.addRow(["時給分", reward.hourlyPay]);
    sheet.addRow(["本指名売上", reward.honShimeiSales]);
    sheet.addRow(["場内延長売上", reward.jonaiExtensionSales]);
    sheet.addRow(["売上帰属合計", reward.attributedSales]);
    sheet.addRow(["手当", reward.allowances]);
    sheet.addRow(["支給額", reward.payable]);
    [6, 7, 8, 9, 10, 11, 12].forEach((row) => { sheet.getCell(`B${row}`).numFmt = yenFormat; });
    body(sheet, 2, 12);
    sheet.getRow(12).font = { name: "BIZ UDPGothic", bold: true };
    sheet.pageSetup.printArea = "A1:B12";
  });
  if (!rewards.length) {
    const sheet = book.addWorksheet("明細");
    sheet.addRow(["対象データがありません"]);
  }
  return book;
}

export function createCastMonthlyWorkbook(
  closings: FinalizedClosing[],
  members: CastMember[],
  month: string
) {
  const book = workbook();
  const monthClosings = rowsForMonth(closings, month);
  const rewards = calculateCastRewards(monthClosings, members);
  const used = new Set<string>(["目次"]);
  const index = book.addWorksheet("目次");
  setup(index, "portrait");
  index.columns = [{ width: 28 }, { width: 16 }, { width: 16 }, { width: 16 }];
  title(index, "キャスト月次報酬表 目次", "A1:D1");
  index.addRow(["氏名", "勤務日数", "勤務時間", "支給額"]);
  header(index.getRow(2));
  rewards.forEach((reward) => {
    const sheetName = uniqueSheetName(reward.name, used);
    const indexRow = index.addRow([{ text: reward.name, hyperlink: `#'${sheetName}'!A1` }, reward.days, reward.hours, reward.payable]);
    indexRow.getCell(4).numFmt = yenFormat;
    const sheet = book.addWorksheet(sheetName);
    setup(sheet);
    sheet.columns = [
      { width: 6 }, { width: 12 }, { width: 12 }, { width: 12 },
      { width: 14 }, { width: 14 }, { width: 14 }
    ];
    title(sheet, `${month.replace("-", "年")}月度 ${reward.name} 月次報酬表`, "A1:G1");
    sheet.addRow(["日", "勤務時間", "時給", "時給分", "本指名売上", "場内延長売上", "帰属売上"]);
    header(sheet.getRow(2));
    const sourceId = members.find((member) => (member.personKey || member.id) === reward.key)?.posCastId || reward.key;
    for (let day = 1; day <= 31; day += 1) {
      const closing = monthClosings.find((item) => Number(item.businessDate.slice(8)) === day);
      const work = closing?.castWork.filter((item) => {
        const raw = item as Record<string, unknown>;
        return String(raw.castId || raw.posCastId || raw.id || "") === sourceId;
      }) || [];
      const sales = closing?.castSales.filter((item) => {
        const raw = item as Record<string, unknown>;
        return String(raw.castId || raw.posCastId || raw.id || "") === sourceId;
      }) || [];
      const hours = work.reduce((sum, item) => sum + Number(item.hours || 0), 0);
      const hon = sales.reduce((sum, item) => sum + Number(item.honShimeiSales || 0), 0);
      const extension = sales.reduce((sum, item) => sum + Number(item.jonaiExtensionSales || 0), 0);
      const attributed = sales.reduce((sum, item) =>
        sum + Number(item.totalAttributedSales || Number(item.honShimeiSales || 0) + Number(item.jonaiExtensionSales || 0)), 0);
      const row = sheet.addRow([day, hours, hours ? reward.hourlyRate : 0, Math.round(hours * reward.hourlyRate), hon, extension, attributed]);
      [3, 4, 5, 6, 7].forEach((column) => { row.getCell(column).numFmt = yenFormat; });
    }
    const total = sheet.addRow(["合計"]);
    for (let column = 2; column <= 7; column += 1) {
      total.getCell(column).value = { formula: `SUM(${sheet.getColumn(column).letter}3:${sheet.getColumn(column).letter}33)`, result: 0 };
      if (column >= 3) total.getCell(column).numFmt = yenFormat;
    }
    header(total);
    body(sheet, 3, 33);
    sheet.pageSetup.printArea = "A1:G34";
  });
  body(index, 3, index.rowCount);
  return book;
}

export async function downloadWorkbook(book: ExcelJS.Workbook, filename: string) {
  const buffer = await book.xlsx.writeBuffer();
  const blob = new Blob([buffer as BlobPart], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
