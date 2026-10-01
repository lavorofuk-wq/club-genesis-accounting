"use client";

import ExcelJS from "exceljs/dist/exceljs.min.js";
import { buildStaffPaymentExport, buildDriverPaymentExport, type PayrollExportInput } from "@/domain/payroll-export";

const font = { name: "Yu Gothic", size: 9, color: { argb: "FF253140" } };
const colors = { header: "FFE2E8F0", total: "FFF0F5FA", net: "FFFFF2CC", missing: "FFFFF4E5", blank: "FFF2F2F2" };
const numberFormat = '#,##0.###############;[Red]-#,##0.###############;0';
const integerFormat = '#,##0;[Red]-#,##0;0';
const line = { style: "thin" as const, color: { argb: "FFA8B3BF" } };
type StaffRow = ReturnType<typeof buildStaffPaymentExport>["rows"][number];
type DriverRow = ReturnType<typeof buildDriverPaymentExport>["rows"][number];
type Tone = keyof typeof colors;

function put(sheet: ExcelJS.Worksheet, row: number, col: number, value: ExcelJS.CellValue, width = 1, tone?: Tone) {
  if (width > 1) sheet.mergeCells(row, col, row, col + width - 1);
  const cell = sheet.getCell(row, col);
  cell.value = value;
  cell.font = { ...font, bold: Boolean(tone && tone !== "blank" && tone !== "missing") };
  const numericValue = typeof value === "number" ? value : value && typeof value === "object" && "result" in value ? value.result : undefined;
  cell.numFmt = typeof numericValue === "number" && !Number.isInteger(numericValue) ? numberFormat : integerFormat;
  cell.alignment = { horizontal: typeof value === "number" || typeof value === "object" && value !== null ? "right" : "center", vertical: "middle", wrapText: typeof value === "string" };
  for (let c = col; c < col + width; c += 1) {
    const part = sheet.getCell(row, c);
    part.style = { ...part.style, border: { top: line, bottom: line, ...(c === col ? { left: line } : {}), ...(c === col + width - 1 ? { right: line } : {}) },
      ...(tone ? { fill: { type: "pattern", pattern: "solid", fgColor: { argb: colors[tone] } } as ExcelJS.Fill } : {}) };
  }
  return cell;
}

function units(value: string) {
  return Array.from(value).reduce((sum, char) => sum + (/^[\x20-\x7e]$/.test(char) ? 0.5 : 1), 0);
}

function noteHeight(value: string, width: number) {
  return Math.max(14, value.split("\n").reduce((sum, part) => sum + Math.max(1, Math.ceil(units(part) / Math.max(1, width / 2))), 0) * 12);
}

function setup(book: ExcelJS.Workbook, name: string, widths: number[]) {
  const sheet = book.addWorksheet(name);
  sheet.columns = widths.map((width) => ({ width }));
  sheet.properties.defaultRowHeight = 11;
  sheet.views = [{ state: "frozen", xSplit: 1, ySplit: 5, showGridLines: false }];
  // 人数をページごとの縦ブロックへ分ける。印刷時に全員を一枚へ縮小しない。
  sheet.pageSetup = { paperSize: 9, orientation: "landscape", fitToPage: false, scale: 100,
    horizontalCentered: true, margins: { left: .2, right: .2, top: .2, bottom: .2, header: .05, footer: .1 } };
  sheet.headerFooter.oddFooter = '&LCLUB GENESIS&R&P / &N';
  return sheet;
}

function header(sheet: ExcelJS.Worksheet, first: number, lastCol: number, month: string, title: string, page: number, pages: number) {
  const dateLabel = `${month.slice(0, 4)}年 ${Number(month.slice(5))}月`;
  put(sheet, first, 1, `GENESIS ${title}`, lastCol).font = { ...font, size: 13, bold: true };
  put(sheet, first + 1, 1, `${dateLabel}　${page + 1} / ${pages}`, lastCol);
  sheet.getRow(first).height = 18;
  sheet.getRow(first + 1).height = 12;
  sheet.getRow(first + 2).height = 26;
  sheet.getRow(first + 3).height = 17;
  sheet.getRow(first + 4).height = 16;
  put(sheet, first + 4, 1, "日付", 1, "header");
  const [year, monthNumber] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  for (let day = 1; day <= 31; day += 1) {
    const cell = put(sheet, first + 4 + day, 1, day <= lastDay ? day : null, 1, day <= lastDay ? undefined : "blank");
    cell.numFmt = '0"日"';
    cell.alignment.horizontal = "center";
  }
  return lastDay;
}

function moneyWidth(values: number[]) {
  const maxLength = Math.max(0, ...values.map((value) => value.toLocaleString("en-US", { maximumFractionDigits: 15 }).length));
  return Math.max(11, Math.min(32, maxLength * .9 + 1));
}

function sumFormula(sheet: ExcelJS.Worksheet, refs: Array<[number, number]>, result: number): ExcelJS.CellValue {
  // SUMの引数上限255を超えないよう、人数が多い場合も全員を集計する。
  const parts = [];
  for (let start = 0; start < refs.length; start += 200) {
    parts.push(`SUM(${refs.slice(start, start + 200).map(([row, col]) => `${sheet.getColumn(col).letter}${row}`).join(",")})`);
  }
  const formula = parts.join("+");
  if (formula.length > 8192) throw new Error("人数がExcelの集計式の上限を超えています。出力内容を確認してください。");
  return { formula, result };
}

function missingText(row: { missingDetails: string[] }) {
  return row.missingDetails.length ? `日別内訳未保存\n${row.missingDetails.join("・")}` : "";
}

function staffSheet(book: ExcelJS.Workbook, month: string, name: string, rows: StaffRow[]) {
  const sum = (key: "hours" | "hourly" | "sales" | "bottle" | "gross" | "daily" | "net") => rows.reduce((total, row) => total + row[key], 0);
  const numeric = rows.flatMap((row) => [row.hourly, row.sales, row.bottle, row.gross, row.daily, row.net,
    ...(row.days || []).flatMap((day) => [day.amount ?? 0, day.dailyPayment ?? 0])]);
  const money = moneyWidth([...numeric, sum("gross"), sum("daily"), sum("net")]);
  const widths = [7, money, money];
  const groupWidth = widths.reduce((total, value) => total + value, 0);
  const perPage = Math.min(Math.max(1, Math.floor((138 - 19) / groupWidth) - 1), Math.max(1, rows.length));
  const lastCol = 1 + (perPage + 1) * 3;
  const sheet = setup(book, name, [19, ...Array.from({ length: perPage + 1 }, () => widths).flat()]);
  if (!rows.length) {
    put(sheet, 1, 1, `GENESIS ${name}支払　${month}`, lastCol).font = { ...font, size: 13, bold: true };
    put(sheet, 3, 1, "対象者なし", lastCol);
    sheet.getRow(1).height = 24;
    sheet.pageSetup.printArea = `A1:${sheet.getColumn(lastCol).letter}3`;
    return;
  }
  const pageRows = 46;
  const pages = Math.ceil(rows.length / perPage);
  const position = (index: number) => ({ first: Math.floor(index / perPage) * pageRows + 1, col: 2 + index % perPage * 3 });
  const totals = [
    ["勤務時間合計", "hours"], ["基本給与合計", "hourly"], ["売上手当", "sales"], ["ボトル手当", "bottle"],
    ["総支給", "gross"], ["日払い合計", "daily"], ["差引支給額", "net"],
  ] as const;
  const monthlyTotals = totals.map(([, key], offset) => sumFormula(sheet,
    rows.map((_, i) => [position(i).first + 36 + offset, position(i).col]), sum(key)));
  // 全員合計は一度だけ準備し、同じ集計をページ数分やり直さない。
  const dailyTotals = Array.from({ length: 31 }, (_, dayIndex) =>
    (["hours", "amount", "dailyPayment"] as const).map((key, offset) => {
      const known = rows.every((row) => row.days !== undefined && row.days.every((entry) => entry[key] !== undefined));
      const entries = rows.map((row) => row.days?.find((entry) => Number(entry.businessDate.slice(8)) === dayIndex + 1));
      return known && entries.some(Boolean) ? sumFormula(sheet,
        rows.map((_, i) => [position(i).first + 5 + dayIndex, position(i).col + offset]),
        entries.reduce((total, entry) => total + (entry?.[key] ?? 0), 0)) : null;
    }));
  for (let page = 0; page < pages; page += 1) {
    const first = page * pageRows + 1;
    const lastDay = header(sheet, first, lastCol, month, `${name}支払`, page, pages);
    const subset = rows.slice(page * perPage, (page + 1) * perPage);
    const totalCol = 2 + perPage * 3;
    totals.forEach(([label, key], offset) => {
      const tone = key === "net" ? "net" : "total";
      put(sheet, first + 36 + offset, 1, label, 1, tone);
      sheet.getRow(first + 36 + offset).height = 12;
      const cell = put(sheet, first + 36 + offset, totalCol, monthlyTotals[offset], 3, tone);
      if (key === "hours") cell.numFmt = Number.isInteger(sum(key)) ? '0"時間"' : '0.###############"時間"';
    });
    put(sheet, first + 43, 1, "送迎");
    put(sheet, first + 43, totalCol, null, 3);
    put(sheet, first + 44, 1, "内訳の記録");
    put(sheet, first + 44, totalCol, rows.some((row) => row.missingDetails.length) ? "日別内訳未保存の項目あり" : null, 3,
      rows.some((row) => row.missingDetails.length) ? "missing" : undefined);
    sheet.getRow(first + 44).height = 28;
    put(sheet, first + 2, totalCol, `${name}合計（全員）`, 3, "header");
    put(sheet, first + 3, totalCol, `${rows.length}名`, 3, "header");
    ["勤務時間", "基本給与", "日払い"].forEach((label, index) => put(sheet, first + 4, totalCol + index, label, 1, "header"));
    subset.forEach((row, index) => {
      const col = 2 + index * 3;
      put(sheet, first + 2, col, row.name, 3, "header");
      sheet.getRow(first + 2).height = Math.max(sheet.getRow(first + 2).height || 0, noteHeight(row.name, groupWidth));
      const rates = row.appliedHourlyRates?.map((value) => `${value.toLocaleString("ja-JP", { maximumFractionDigits: 15 })}円`).join(" / ") || "—";
      const rateText = `時給 ${rates}`;
      put(sheet, first + 3, col, rateText, 3, "header");
      sheet.getRow(first + 3).height = Math.max(sheet.getRow(first + 3).height || 0, noteHeight(rateText, groupWidth));
      ["勤務時間", "基本給与", "日払い"].forEach((label, i) => put(sheet, first + 4, col + i, label, 1, "header"));
      const days = new Map(row.days?.map((day) => [Number(day.businessDate.slice(8)), day]));
      for (let day = 1; day <= 31; day += 1) {
        const entry = days.get(day);
        [entry?.hours, entry?.amount, entry?.dailyPayment].forEach((value, i) => {
          put(sheet, first + 4 + day, col + i, day <= lastDay ? value ?? null : null, 1, day > lastDay ? "blank" : undefined);
        });
      }
      totals.forEach(([, key], offset) => {
        const cell = put(sheet, first + 36 + offset, col, row[key], 3, key === "net" ? "net" : "total");
        if (key === "hours") cell.numFmt = Number.isInteger(row[key]) ? '0"時間"' : '0.###############"時間"';
      });
      put(sheet, first + 43, col, null, 3);
      const note = missingText(row);
      put(sheet, first + 44, col, note || null, 3, note ? "missing" : undefined);
      sheet.getRow(first + 44).height = Math.max(sheet.getRow(first + 44).height || 0, noteHeight(note, groupWidth));
    });
    for (let day = 1; day <= 31; day += 1) {
      dailyTotals[day - 1].forEach((dailyTotal, offset) => {
        // 一人でもその項目の内訳が不明なら、全員合計も既知分だけの過少表示にしない。
        const value = day <= lastDay ? dailyTotal : null;
        put(sheet, first + 4 + day, totalCol + offset, value, 1, day > lastDay ? "blank" : "total");
      });
    }
    sheet.getRow(first + pageRows - 1).height = 3;
    if (page < pages - 1) sheet.getRow(first + pageRows - 1).addPageBreak();
  }
  sheet.pageSetup.printArea = `A1:${sheet.getColumn(lastCol).letter}${pages * pageRows - 1}`;
}

export function createStaffPaymentWorkbook(input: PayrollExportInput) {
  const report = buildStaffPaymentExport(input);
  const book = new ExcelJS.Workbook();
  book.creator = "GENESIS Management System";
  book.title = `${report.month} スタッフ支払`;
  staffSheet(book, report.month, "在籍スタッフ", report.rows.filter((row) => row.group === "regular"));
  staffSheet(book, report.month, "体入スタッフ", report.rows.filter((row) => row.group === "trial"));
  const unknown = report.rows.filter((row) => row.group === "unknown");
  if (unknown.length) staffSheet(book, report.month, "区分記録なし", unknown);
  return book;
}

export function createDriverPaymentWorkbook(input: PayrollExportInput) {
  const report = buildDriverPaymentExport(input);
  const rows: DriverRow[] = report.rows;
  const book = new ExcelJS.Workbook();
  book.creator = "GENESIS Management System";
  book.title = `${report.month} ドライバー支払`;
  const total = (key: "basic" | "remote" | "gross" | "dailyPayment" | "net") => rows.reduce((sum, row) => sum + row[key], 0);
  const width = Math.max(15, moneyWidth([...rows.flatMap((row) => [row.basic, row.remote, row.gross, row.dailyPayment, row.net]), total("gross"), total("net")]));
  const perPage = Math.min(Math.max(1, Math.floor((138 - 19) / width) - 1), Math.max(1, rows.length));
  const pages = Math.ceil(rows.length / perPage);
  const pageRows = 42;
  const lastCol = perPage + 2;
  const sheet = setup(book, "ドライバー支払", [19, ...Array<number>(perPage + 1).fill(width)]);
  const position = (index: number) => ({ first: Math.floor(index / perPage) * pageRows + 1, col: 2 + index % perPage });
  const totals = [["小計", "basic"], ["遠方手当", "remote"], ["日払い", "dailyPayment"], ["差引支給額", "net"]] as const;
  const monthlyTotals = totals.map(([, key], offset) => sumFormula(sheet,
    rows.map((_, i) => [position(i).first + 36 + offset, position(i).col]), total(key)));
  const dailyTotals = Array.from({ length: 31 }, (_, index) => {
    const entries = rows.map((row) => row.days?.find((entry) => Number(entry.businessDate.slice(8)) === index + 1));
    return rows.every((row) => row.days !== undefined) && entries.some(Boolean) ? sumFormula(sheet,
      rows.map((_, i) => [position(i).first + 5 + index, position(i).col]), entries.reduce((sum, entry) => sum + (entry?.amount ?? 0), 0)) : null;
  });
  for (let page = 0; page < pages; page += 1) {
    const first = page * pageRows + 1;
    const lastDay = header(sheet, first, lastCol, report.month, "ドライバー支払", page, pages);
    const subset = rows.slice(page * perPage, (page + 1) * perPage);
    put(sheet, first + 2, lastCol, "合計（全員）", 1, "header");
    put(sheet, first + 3, lastCol, `${rows.length}名`, 1, "header");
    put(sheet, first + 4, lastCol, "基本日給", 1, "header");
    totals.forEach(([label, key], offset) => {
      const tone = key === "net" ? "net" : "total";
      put(sheet, first + 36 + offset, 1, label, 1, tone);
      put(sheet, first + 36 + offset, lastCol, monthlyTotals[offset], 1, tone);
      sheet.getRow(first + 36 + offset).height = 15;
    });
    put(sheet, first + 40, 1, "内訳の記録");
    const incomplete = rows.some((row) => row.missingDetails.length);
    put(sheet, first + 40, lastCol, incomplete ? "日別内訳未保存の項目あり" : null, 1, incomplete ? "missing" : undefined);
    sheet.getRow(first + 40).height = incomplete ? 42 : 16;
    subset.forEach((row, index) => {
      const col = index + 2;
      put(sheet, first + 2, col, row.name, 1, "header");
      sheet.getRow(first + 2).height = Math.max(sheet.getRow(first + 2).height || 0, noteHeight(row.name, width));
      put(sheet, first + 3, col, `${row.daysCount}日出勤`, 1, "header");
      put(sheet, first + 4, col, "基本日給", 1, "header");
      const days = new Map(row.days?.map((day) => [Number(day.businessDate.slice(8)), day.amount]));
      for (let day = 1; day <= 31; day += 1) put(sheet, first + 4 + day, col, day <= lastDay ? days.get(day) ?? null : null, 1, day > lastDay ? "blank" : undefined);
      totals.forEach(([, key], offset) => put(sheet, first + 36 + offset, col, row[key], 1, key === "net" ? "net" : "total"));
      const note = missingText(row);
      put(sheet, first + 40, col, note || null, 1, note ? "missing" : undefined);
      sheet.getRow(first + 40).height = Math.max(sheet.getRow(first + 40).height || 0, noteHeight(note, width));
    });
    for (let day = 1; day <= 31; day += 1) {
      const value = day <= lastDay ? dailyTotals[day - 1] : null;
      put(sheet, first + 4 + day, lastCol, value, 1, day > lastDay ? "blank" : "total");
    }
    sheet.getRow(first + pageRows - 1).height = 3;
    if (page < pages - 1) sheet.getRow(first + pageRows - 1).addPageBreak();
  }
  sheet.pageSetup.printArea = `A1:${sheet.getColumn(lastCol).letter}${pages * pageRows - 1}`;
  return book;
}
