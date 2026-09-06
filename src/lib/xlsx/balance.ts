"use client";

import ExcelJS from "exceljs/dist/exceljs.min.js";
import { buildBalanceExportReport, type BalanceExportDay, type BalanceExportInput } from "@/domain/balance-export";

const font = { name: "Yu Gothic", size: 10 };
const amountFormat = '#,##0.########;[Red]-#,##0.########;0';
const percentageFormat = '0.0%;[Red]-0.0%;0.0%';
const border: Partial<ExcelJS.Borders> = Object.fromEntries(
  ["top", "bottom", "left", "right"].map((side) => [side, { style: "thin", color: { argb: "FFCBD5E1" } }]),
);
const formula = (expression: string, result: number | string): ExcelJS.CellFormulaValue => ({ formula: expression, result });
const ratio = (numerator: number, denominator: number) => denominator === 0 ? "" : numerator / denominator;
const columns: Array<{ column: string; field: Exclude<keyof BalanceExportDay, "businessDate">; label: string }> = [
  { column: "C", field: "totalSales", label: "売上" },
  { column: "D", field: "cashSales", label: "現金" },
  { column: "E", field: "cardSales", label: "カード" },
  { column: "F", field: "groups", label: "組数" },
  { column: "G", field: "customers", label: "客数" },
  { column: "I", field: "honShimeiCount", label: "本指名" },
  { column: "J", field: "jonaiCount", label: "場内" },
  { column: "K", field: "dohanCount", label: "同伴" },
  { column: "L", field: "castCount", label: "総出勤" },
  { column: "M", field: "castHourly", label: "時給" },
  { column: "N", field: "castSalesReward", label: "売上報酬" },
  { column: "O", field: "dispatchCastCount", label: "派遣数" },
  { column: "P", field: "dispatchCastPayment", label: "派遣給" },
  { column: "R", field: "employeeGross", label: "従業員給" },
  { column: "S", field: "introducerPayment", label: "紹介料" },
  { column: "T", field: "expenses", label: "経費" },
];

function merge(sheet: ExcelJS.Worksheet, range: string, value: ExcelJS.CellValue) {
  sheet.mergeCells(range);
  sheet.getCell(range.split(":")[0]).value = value;
}

function label(sheet: ExcelJS.Worksheet, range: string, value: string) {
  if (range.includes(":")) merge(sheet, range, value);
  else sheet.getCell(range).value = value;
  const cell = sheet.getCell(range.split(":")[0]);
  cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2E8F0" } };
}

/** 見本の収支表へ紹介料列を追加。金額配分は検証済みの月次帳票データを使用する。 */
export function createMonthlyBalanceWorkbook(input: BalanceExportInput, sourceLabel: string) {
  const report = buildBalanceExportReport(input);
  const [year, monthNumber] = report.month.split("-").map(Number);
  const lastDay = new Date(year, monthNumber, 0).getDate();
  const byDate = new Map(report.days.map((day) => [day.businessDate, day]));
  const total = (field: Exclude<keyof BalanceExportDay, "businessDate">) => report.days.reduce((sum, day) => sum + day[field], 0);
  const castGross = total("castHourly") + total("castSalesReward") + total("dispatchCastPayment");
  const expenses = total("expenses");
  const employeeGross = total("employeeGross");
  const introducerPayment = total("introducerPayment");
  const totalCosts = castGross + employeeGross + introducerPayment + expenses;
  const cash = total("cashSales");
  const sales = total("totalSales");
  const profit = sales - totalCosts;
  const meanCustomerUnitPrice = ratio(report.days.reduce((sum, day) => sum + (day.customers === 0 ? 0 : day.totalSales / day.customers), 0), report.approvedDays);
  const meanCastRatio = sales === 0 ? "" : ratio(report.days.reduce((sum, day) => sum + (day.totalSales === 0 ? 0 : (day.castHourly + day.castSalesReward + day.dispatchCastPayment) / day.totalSales), 0), report.approvedDays);
  const meanExpenseRatio = sales === 0 ? "" : ratio(report.days.reduce((sum, day) => sum + (day.totalSales === 0 ? 0 : day.expenses / day.totalSales), 0), report.approvedDays);
  const book = new ExcelJS.Workbook();
  book.creator = "GENESIS Management System Ver2.17.0";
  book.created = new Date();
  book.calcProperties.fullCalcOnLoad = true;
  const sheet = book.addWorksheet("ジェネシス収支表");
  sheet.columns = [5.5, 5.5, 13, 12, 12, 7, 7, 11, 8.5, 8.5, 8.5, 8.5, 12, 12, 12, 8.5, 11, 10, 12, 12, 12, 11, 13.5]
    .map((width) => ({ width }));
  sheet.views = [{ state: "frozen", xSplit: 2, ySplit: 2, showGridLines: false, zoomScale: 70 }];
  sheet.pageSetup = {
    orientation: "landscape", paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0,
    horizontalCentered: true, printArea: "A1:W46", printTitlesRow: "1:2",
    margins: { left: .2, right: .2, top: .3, bottom: .3, header: .15, footer: .15 },
  };
  sheet.headerFooter.oddFooter = `&"Yu Gothic,Regular"${sourceLabel.replace(/&/g, "&&")}（承認済み日次のみ） &R&P / &N`;
  for (let row = 1; row <= 46; row += 1) {
    sheet.getRow(row).height = row === 1 ? 25.5 : row === 45 ? 9 : 21;
    for (let column = 1; column <= 23; column += 1) {
      const cell = sheet.getCell(row, column);
      cell.font = { ...font, bold: row <= 2 || row === 35 };
      cell.alignment = { vertical: "middle", horizontal: column <= 2 ? "center" : "right" };
      cell.numFmt = amountFormat;
      if (row >= 2 && row <= 35 && column <= 22) cell.border = border;
      if (row === 2 && column <= 22) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2E8F0" } };
      if ((row === 34 || row === 35) && column <= 22) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFC" } };
    }
  }
  merge(sheet, "A1:E1", "ジェネシス収支表");
  sheet.getCell("A1").font = { ...font, size: 12, bold: true };
  sheet.getCell("A1").alignment = { horizontal: "left", vertical: "middle" };
  sheet.getCell("F1").value = year;
  sheet.getCell("F1").numFmt = "0";
  sheet.getCell("G1").value = "年";
  sheet.getCell("H1").value = monthNumber;
  sheet.getCell("I1").value = "月度";
  merge(sheet, "K1:W1", sourceLabel);
  sheet.getCell("K1").alignment = { horizontal: "right", vertical: "middle" };
  sheet.getCell("K1").font = { ...font, size: 9 };
  for (let row = 2; row <= 35; row += 1) merge(sheet, `A${row}:B${row}`, null);
  sheet.getCell("A2").value = "日";
  for (const item of columns) sheet.getCell(`${item.column}2`).value = item.label;
  for (const [column, header] of [["H", "客単"], ["Q", "女子給比"], ["U", "経費比"], ["V", "収支"]]) sheet.getCell(`${column}2`).value = header;
  sheet.getRow(2).alignment = { horizontal: "center", vertical: "middle", wrapText: true };

  for (let day = 1; day <= lastDay; day += 1) {
    const row = day + 2;
    sheet.getCell(`A${row}`).value = day;
    const item = byDate.get(`${report.month}-${String(day).padStart(2, "0")}`);
    if (!item) continue;
    for (const mapping of columns) sheet.getCell(`${mapping.column}${row}`).value = item[mapping.field];
    sheet.getCell(`C${row}`).value = formula(`SUM(D${row}:E${row})`, item.totalSales);
    sheet.getCell(`H${row}`).value = formula(`IF(G${row}=0,"",C${row}/G${row})`, ratio(item.totalSales, item.customers));
    const dailyCast = item.castHourly + item.castSalesReward + item.dispatchCastPayment;
    sheet.getCell(`Q${row}`).value = formula(`IF(C${row}=0,"",SUM(M${row}:N${row},P${row})/C${row})`, ratio(dailyCast, item.totalSales));
    sheet.getCell(`U${row}`).value = formula(`IF(C${row}=0,"",T${row}/C${row})`, ratio(item.expenses, item.totalSales));
    sheet.getCell(`V${row}`).value = formula(`C${row}-SUM(M${row}:N${row},P${row},R${row}:T${row})`, item.totalSales - dailyCast - item.employeeGross - item.introducerPayment - item.expenses);
  }
  sheet.getCell("A34").value = "平均";
  sheet.getCell("A35").value = "合計";
  for (const mapping of columns) {
    sheet.getCell(`${mapping.column}35`).value = formula(`SUM(${mapping.column}3:${mapping.column}33)`, total(mapping.field));
    sheet.getCell(`${mapping.column}34`).value = formula(`IF($D$36=0,"",${mapping.column}35/$D$36)`, ratio(total(mapping.field), report.approvedDays));
  }
  sheet.getCell("H35").value = formula('IF(G35=0,"",C35/G35)', ratio(sales, total("customers")));
  sheet.getCell("H34").value = formula('IF($D$36=0,"",SUM(H3:H33)/$D$36)', meanCustomerUnitPrice);
  sheet.getCell("Q35").value = formula('IF(C35=0,"",SUM(M35:N35,P35)/C35)', ratio(castGross, sales));
  sheet.getCell("Q34").value = formula('IF(OR($D$36=0,$C$35=0),"",SUM(Q3:Q33)/$D$36)', meanCastRatio);
  sheet.getCell("U35").value = formula('IF(C35=0,"",T35/C35)', ratio(expenses, sales));
  sheet.getCell("U34").value = formula('IF(OR($D$36=0,$C$35=0),"",SUM(U3:U33)/$D$36)', meanExpenseRatio);
  sheet.getCell("V35").value = formula("SUM(V3:V33)", profit);
  sheet.getCell("V34").value = formula('IF($D$36=0,"",V35/$D$36)', ratio(profit, report.approvedDays));
  for (let row = 3; row <= 35; row += 1) {
    for (const column of ["Q", "U"]) sheet.getCell(`${column}${row}`).numFmt = percentageFormat;
    sheet.getCell(`H${row}`).numFmt = '#,##0.00;[Red]-#,##0.00;0';
  }

  label(sheet, "C36", "営業日数");
  sheet.getCell("D36").value = report.approvedDays;
  label(sheet, "E36:G36", "キャストバック（バック＋手当）");
  // 見本の別枠手当はGMS未実装。M・N列に含むバックを再加算しない。
  sheet.getCell("H36").value = null;
  label(sheet, "I36:M36", "キャスト（送迎）");
  sheet.getCell("N36").value = report.castTransport;
  label(sheet, "O36:P36", "従業員（日払い等）");
  sheet.getCell("Q36").value = report.employeeDaily;
  label(sheet, "R36:V36", "総従業員給");
  sheet.getCell("W36").value = formula("R35", employeeGross);

  label(sheet, "B37:E37", "時給給＋売上給＋派遣給＝キャスト総支給額");
  merge(sheet, "F37:G37", formula("SUM(M35:N35,P35)", castGross));
  label(sheet, "H37:L37", "キャスト総支給額－日払・立替－送迎代－派遣支払－源泉所得税＝差引支給額");
  merge(sheet, "M37:N37", formula("F37-D39-N36-P35-U42", report.castNet));
  label(sheet, "O37:T37", "キャスト総支給額＋総従業員給＋紹介料＋経費＝総支出");
  merge(sheet, "U37:V37", formula("SUM(M35:N35,P35,R35:T35)", totalCosts));
  label(sheet, "A38:L38", "現金売上＋前期・後期カード入金－キャスト差引支給額－紹介者支払額－従業員差引支給額（送迎含む）－キャスト日払・立替－従業員日払－源泉所得税－派遣支払・手数料－変動費－固定費＝現状現金残高");
  // 総支出に含まれる日払い・源泉税は別途引かず、実際の支出ではない送迎控除だけを戻す。
  merge(sheet, "M38:N38", formula("SUM(D35,J42,O42)-U37+N36", cash - totalCosts + report.castTransport));
  label(sheet, "O38:U38", "現金売上－総支出＝現金残");
  merge(sheet, "V38:W38", formula("D35-U37", cash - totalCosts));
  label(sheet, "A39:C39", "キャスト（日払・立替）計");
  merge(sheet, "D39:F39", report.castDailyAndAdvance);
  label(sheet, "G39:I39", "従業員日払い計");
  merge(sheet, "J39:L39", formula("Q36", report.employeeDaily));
  label(sheet, "O39:U39", "現金残＋カード＝利益");
  merge(sheet, "V39:W39", formula("V38+E35", profit));
  label(sheet, "A40:B40", "キャスト報酬比");
  sheet.getCell("C40").value = formula("Q35", ratio(castGross, sales));
  label(sheet, "D40:E40", "経費比（固定・変動）");
  merge(sheet, "F40:G40", formula("U35", ratio(expenses, sales)));
  label(sheet, "H40:J40", "人件費率（キャスト・従業員）");
  merge(sheet, "K40:L40", formula('IF(C35=0,"",SUM(F37,W36)/C35)', ratio(castGross + employeeGross, sales)));
  for (const address of ["C40", "F40", "K40"]) sheet.getCell(address).numFmt = percentageFormat;

  sheet.getCell("G41").value = "【入出金】";
  label(sheet, "G42:I42", "前期・カード入金／1日～15日分");
  merge(sheet, "J42:K42", null);
  label(sheet, "L42:N42", `後期・カード入金／16日～${lastDay}日分`);
  merge(sheet, "O42:P42", null);
  for (const address of ["J42", "O42"]) {
    const cell = sheet.getCell(address);
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFF99" } };
    cell.protection = { locked: false };
    cell.dataValidation = { type: "decimal", operator: "greaterThanOrEqual", formulae: [0], allowBlank: true, showErrorMessage: true, errorTitle: "入金額", error: "0円以上の数値を入力してください。" };
  }
  label(sheet, "C42", "本指売上");
  sheet.getCell("D42").value = report.honShimeiSales;
  label(sheet, "C43", "場内売上");
  sheet.getCell("D43").value = report.jonaiExtensionSales;
  label(sheet, "C44", "キャスト総売上");
  sheet.getCell("D44").value = formula("SUM(D42:D43)", report.honShimeiSales + report.jonaiExtensionSales);
  label(sheet, "R41:T41", "キャスト報酬額");
  merge(sheet, "U41:V41", formula("M37", report.castNet));
  label(sheet, "R42:T42", "源泉税");
  merge(sheet, "U42:V42", report.castWithholding);
  label(sheet, "R43:T43", "紹介料");
  merge(sheet, "U43:V43", formula("S35", introducerPayment));
  label(sheet, "R44:S44", "15日");
  label(sheet, "T44", "準備金");
  merge(sheet, "U44:V44", formula("SUM(U41:U43)", report.castNet + report.castWithholding + introducerPayment));
  label(sheet, "R46:T46", "【源泉所得税】");
  merge(sheet, "U46:W46", formula("U42", report.castWithholding));

  for (const [address, color] of [["M37", "FFFFFF99"], ["U41", "FFFFFF99"], ["U42", "FFDDEBF7"], ["U43", "FFE2EFDA"], ["W36", "FFFCE4D6"]]) {
    sheet.getCell(address).fill = { type: "pattern", pattern: "solid", fgColor: { argb: color } };
  }
  for (const row of [36, 37, 38, 39, 40, 42, 44]) sheet.getRow(row).height = row === 37 || row === 38 ? 48 : 30;
  // 下段は見本に存在するラベル・数値範囲だけに罫線を引き、余白を保つ。
  for (const range of ["C36:W36", "B37:V37", "A38:W38", "A39:L39", "O39:W39", "A40:L40", "G42:P42", "C42:D44", "R41:V44", "R46:W46"]) {
    const [start, end] = range.split(":").map((address) => sheet.getCell(address));
    for (let row = Number(start.row); row <= Number(end.row); row += 1) {
      for (let column = Number(start.col); column <= Number(end.col); column += 1) sheet.getCell(row, column).border = border;
    }
  }
  sheet.eachRow((row) => row.eachCell((cell) => {
    const value = cell.type === ExcelJS.ValueType.Formula ? cell.result : cell.value;
    if (typeof value === "number" && Number.isInteger(value) && cell.numFmt === amountFormat) cell.numFmt = '#,##0;[Red]-#,##0;0';
  }));
  return book;
}
