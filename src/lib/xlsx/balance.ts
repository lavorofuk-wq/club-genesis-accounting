"use client";

import ExcelJS from "exceljs/dist/exceljs.min.js";
import { buildBalanceExportReport, type BalanceExportDay, type BalanceExportInput } from "@/domain/balance-export";

const font = { name: "Yu Gothic", size: 10 };
const amountFormat = '#,##0.########;[Red]-#,##0.########;0';
const percentageFormat = '0.0%;[Red]-0.0%;0.0%';
const border: Partial<ExcelJS.Borders> = Object.fromEntries(
  ["top", "bottom", "left", "right"].map((side) => [side, { style: "thin", color: { argb: "FFCBD5E1" } }]),
);
const formulaValue = (expression: string, result: number | string): ExcelJS.CellFormulaValue => ({ formula: expression, result });
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
  const total = (field: Exclude<keyof BalanceExportDay, "businessDate">) => report.days.reduce((sum, day) => sum + day[field], 0)
    + (field === "expenses" ? report.monthlyExpenses.expenses : field === "introducerPayment" ? report.monthlyExpenses.introducerPayment : 0);
  const castGross = total("castHourly") + total("castSalesReward") + total("dispatchCastPayment");
  const expenses = total("expenses");
  const employeeGross = total("employeeGross");
  const introducerPayment = total("introducerPayment");
  const totalCosts = castGross + employeeGross + introducerPayment + expenses;
  const cash = total("cashSales");
  const sales = total("totalSales");
  const profit = sales - totalCosts;
  const cashFunding = report.cashFunding && report.cashFunding.managedDays > 0 ? report.cashFunding : undefined;
  const meanCustomerUnitPrice = ratio(report.days.reduce((sum, day) => sum + (day.customers === 0 ? 0 : day.totalSales / day.customers), 0), report.approvedDays);
  const meanCastRatio = sales === 0 ? "" : ratio(report.days.reduce((sum, day) => sum + (day.totalSales === 0 ? 0 : (day.castHourly + day.castSalesReward + day.dispatchCastPayment) / day.totalSales), 0), report.approvedDays);
  const meanExpenseRatio = ratio(expenses, sales);
  const book = new ExcelJS.Workbook();
  book.creator = "GENESIS Management System Ver2.37.0";
  book.created = new Date();
  book.calcProperties.fullCalcOnLoad = true;
  const sheet = book.addWorksheet("ジェネシス収支表");
  // 30日以下は既存の空行、31日月は新しい行を使用する。
  // 日付行は動かさず、平均以降のテンプレート座標と式を同じ規則で移す。
  const rowOffset = lastDay === 31 ? 1 : 0;
  const monthlyRow = 33 + rowOffset;
  const templateRowNumber = (row: number) => row >= 34 ? row + rowOffset : row;
  const address = (value: string) => value.replace(/(\$?[A-Z]{1,3}\$?)(\d+)/g,
    (_, column: string, row: string) => column + templateRowNumber(Number(row)));
  const templateCell = (row: string | number, column?: number) => typeof row === "string"
    ? sheet.getCell(address(row)) : sheet.getCell(templateRowNumber(row), column!);
  const templateRow = (row: number) => sheet.getRow(templateRowNumber(row));
  const mergeAt = (range: string, value: ExcelJS.CellValue) => merge(sheet, address(range), value);
  const labelAt = (range: string, value: string) => label(sheet, address(range), value);
  const formula = (expression: string, result: number | string) => formulaValue(address(expression), result);
  sheet.columns = [5.5, 5.5, 13, 12, 12, 7, 7, 11, 8.5, 8.5, 8.5, 8.5, 12, 12, 12, 8.5, 11, 10, 12, 12, 12, 11, 13.5]
    .map((width) => ({ width }));
  sheet.views = [{ state: "frozen", xSplit: 2, ySplit: 2, showGridLines: false, zoomScale: 70 }];
  sheet.pageSetup = {
    orientation: "landscape", paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0,
    horizontalCentered: true, printArea: address("A1:W46"), printTitlesRow: "1:2",
    margins: { left: .2, right: .2, top: .3, bottom: .3, header: .15, footer: .15 },
  };
  sheet.headerFooter.oddFooter = `&"Yu Gothic,Regular"${sourceLabel.replace(/&/g, "&&")}（承認済み日次のみ） &R&P / &N`;
  for (let row = 1; row <= 46; row += 1) {
    templateRow(row).height = row === 1 ? 25.5 : row === 45 ? 9 : 21;
    for (let column = 1; column <= 23; column += 1) {
      const cell = templateCell(row, column);
      cell.font = { ...font, bold: row <= 2 || row === 35 };
      cell.alignment = { vertical: "middle", horizontal: column <= 2 ? "center" : "right" };
      cell.numFmt = amountFormat;
      if (row >= 2 && row <= 35 && column <= 22) cell.border = border;
      if (row === 2 && column <= 22) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2E8F0" } };
      if ((row === 34 || row === 35) && column <= 22) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFC" } };
    }
  }
  mergeAt("A1:E1", "ジェネシス収支表");
  templateCell("A1").font = { ...font, size: 12, bold: true };
  templateCell("A1").alignment = { horizontal: "left", vertical: "middle" };
  templateCell("F1").value = year;
  templateCell("F1").numFmt = "0";
  templateCell("G1").value = "年";
  templateCell("H1").value = monthNumber;
  templateCell("I1").value = "月度";
  mergeAt("K1:W1", sourceLabel);
  templateCell("K1").alignment = { horizontal: "right", vertical: "middle" };
  templateCell("K1").font = { ...font, size: 9 };
  for (let row = 2; row <= 35; row += 1) mergeAt(`A${row}:B${row}`, null);
  templateCell("A2").value = "日";
  for (const item of columns) templateCell(`${item.column}2`).value = item.label;
  for (const [column, header] of [["H", "客単"], ["Q", "女子給比"], ["U", "経費比"], ["V", "収支"]]) templateCell(`${column}2`).value = header;
  templateRow(2).alignment = { horizontal: "center", vertical: "middle", wrapText: true };

  for (let day = 1; day <= lastDay; day += 1) {
    const row = day + 2;
    templateCell(`A${row}`).value = day;
    const item = byDate.get(`${report.month}-${String(day).padStart(2, "0")}`);
    if (!item) continue;
    for (const mapping of columns) templateCell(`${mapping.column}${row}`).value = item[mapping.field];
    templateCell(`C${row}`).value = formula(`SUM(D${row}:E${row})`, item.totalSales);
    templateCell(`H${row}`).value = formula(`IF(G${row}=0,"",C${row}/G${row})`, ratio(item.totalSales, item.customers));
    const dailyCast = item.castHourly + item.castSalesReward + item.dispatchCastPayment;
    templateCell(`Q${row}`).value = formula(`IF(C${row}=0,"",SUM(M${row}:N${row},P${row})/C${row})`, ratio(dailyCast, item.totalSales));
    templateCell(`U${row}`).value = formula(`IF(C${row}=0,"",T${row}/C${row})`, ratio(item.expenses, item.totalSales));
    templateCell(`V${row}`).value = formula(`C${row}-SUM(M${row}:N${row},P${row},R${row}:T${row})`, item.totalSales - dailyCast - item.employeeGross - item.introducerPayment - item.expenses);
  }
  // 営業日・人数・比率は空欄のまま、月額費用とその収支だけを計上する。
  if (rowOffset) sheet.mergeCells(`A${monthlyRow}:B${monthlyRow}`);
  sheet.getRow(monthlyRow).height = 21;
  for (let column = 1; column <= 22; column += 1) {
    const cell = sheet.getCell(monthlyRow, column);
    cell.font = font;
    cell.border = border;
    cell.alignment = { horizontal: column <= 2 ? "center" : "right", vertical: "middle" };
    cell.numFmt = amountFormat;
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFC" } };
  }
  sheet.getCell(`S${monthlyRow}`).value = report.monthlyExpenses.introducerPayment;
  sheet.getCell(`T${monthlyRow}`).value = report.monthlyExpenses.expenses;
  sheet.getCell(`V${monthlyRow}`).value = formulaValue(`-SUM(S${monthlyRow}:T${monthlyRow})`,
    -report.monthlyExpenses.introducerPayment - report.monthlyExpenses.expenses);
  templateCell("A34").value = "平均";
  templateCell("A35").value = "合計";
  for (const mapping of columns) {
    templateCell(`${mapping.column}35`).value = formulaValue(`SUM(${mapping.column}3:${mapping.column}${monthlyRow})`, total(mapping.field));
    templateCell(`${mapping.column}34`).value = formula(`IF($D$36=0,"",${mapping.column}35/$D$36)`, ratio(total(mapping.field), report.approvedDays));
  }
  templateCell("H35").value = formula('IF(G35=0,"",C35/G35)', ratio(sales, total("customers")));
  templateCell("H34").value = formula('IF($D$36=0,"",SUM(H3:H33)/$D$36)', meanCustomerUnitPrice);
  templateCell("Q35").value = formula('IF(C35=0,"",SUM(M35:N35,P35)/C35)', ratio(castGross, sales));
  templateCell("Q34").value = formula('IF(OR($D$36=0,$C$35=0),"",SUM(Q3:Q33)/$D$36)', meanCastRatio);
  templateCell("U35").value = formula('IF(C35=0,"",T35/C35)', ratio(expenses, sales));
  templateCell("U34").value = formula('IF(C35=0,"",T35/C35)', meanExpenseRatio);
  templateCell("V35").value = formulaValue(`SUM(V3:V${monthlyRow})`, profit);
  templateCell("V34").value = formula('IF($D$36=0,"",V35/$D$36)', ratio(profit, report.approvedDays));
  for (let row = 3; row <= 35; row += 1) {
    for (const column of ["Q", "U"]) templateCell(`${column}${row}`).numFmt = percentageFormat;
    templateCell(`H${row}`).numFmt = '#,##0.00;[Red]-#,##0.00;0';
  }

  labelAt("C36", "営業日数");
  templateCell("D36").value = report.approvedDays;
  labelAt("E36:G36", "キャストバック（バック＋手当）");
  // 見本の別枠手当はGMS未実装。M・N列に含むバックを再加算しない。
  templateCell("H36").value = null;
  labelAt("I36:M36", "キャスト（送迎）");
  templateCell("N36").value = report.castTransport;
  labelAt("O36:P36", "従業員（日払い等）");
  templateCell("Q36").value = report.employeeDaily;
  labelAt("R36:V36", "総従業員給");
  templateCell("W36").value = formula("R35", employeeGross);

  labelAt("B37:E37", "時給給＋売上給＋派遣給＝キャスト総支給額");
  mergeAt("F37:G37", formula("SUM(M35:N35,P35)", castGross));
  labelAt("H37:L37", "キャスト総支給額－日払・立替－送迎代－派遣支払－源泉所得税＝差引支給額");
  mergeAt("M37:N37", formula("F37-D39-N36-P35-U42", report.castNet));
  labelAt("O37:T37", "キャスト総支給額＋総従業員給＋紹介料＋経費＝総支出");
  mergeAt("U37:V37", formula("SUM(M35:N35,P35,R35:T35)", totalCosts));
  labelAt("A38:L38", "現金売上＋カード実入金（手数料控除後）－キャスト差引支給額－紹介者支払額－従業員差引支給額（送迎含む）－キャスト日払・立替－従業員日払－源泉所得税－派遣支払・手数料－経費（カード手数料除く）" + (cashFunding ? "＋会社補充＋個人補充＋会社送金－個人返済" : "") + "＝現状現金残高");
  // 総支出に含む日払い・源泉税は別途引かず、送迎控除と実入金で控除済みのカード手数料を戻す。
  // 手数料は検証済み月額の定数。入金2欄の直接参照は保持し、Excelでの入力後も再計算する。
  mergeAt("M38:N38", formula("SUM(D35,J42,O42)-U37+N36" + (report.cardFee ? `+${report.cardFee}` : "")
    + (cashFunding ? "+SUM(J43,O43,J44)-O44" : ""), cash - totalCosts + report.castTransport + report.cardFee + (cashFunding?.netCashMovement || 0)));
  labelAt("O38:U38", "現金売上－総支出＝現金残");
  mergeAt("V38:W38", formula("D35-U37", cash - totalCosts));
  labelAt("A39:C39", "キャスト（日払・立替）計");
  mergeAt("D39:F39", report.castDailyAndAdvance);
  labelAt("G39:I39", "従業員日払い計");
  mergeAt("J39:L39", formula("Q36", report.employeeDaily));
  labelAt("O39:U39", "現金残＋カード＝利益");
  mergeAt("V39:W39", formula("V38+E35", profit));
  labelAt("A40:B40", "キャスト報酬比");
  templateCell("C40").value = formula("Q35", ratio(castGross, sales));
  labelAt("D40:E40", "経費比（固定・変動）");
  mergeAt("F40:G40", formula("U35", ratio(expenses, sales)));
  labelAt("H40:J40", "人件費率（キャスト・従業員）");
  mergeAt("K40:L40", formula('IF(C35=0,"",SUM(F37,W36)/C35)', ratio(castGross + employeeGross, sales)));
  for (const address of ["C40", "F40", "K40"]) templateCell(address).numFmt = percentageFormat;

  templateCell("G41").value = "【入出金】";
  labelAt("G42:I42", "前期・カード入金／1日～15日分");
  mergeAt("J42:K42", null);
  labelAt("L42:N42", `後期・カード入金／16日～${lastDay}日分`);
  mergeAt("O42:P42", null);
  for (const address of ["J42", "O42"]) {
    const cell = templateCell(address);
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFF99" } };
    cell.protection = { locked: false };
    cell.dataValidation = { type: "decimal", operator: "greaterThanOrEqual", formulae: [0], allowBlank: true, showErrorMessage: true, errorTitle: "入金額", error: "0円以上の数値を入力してください。" };
  }
  if (cashFunding) {
    // 見本の入出金欄直下の余白だけを利用し、損益列・印刷範囲は変えない。
    const fundingCells: Array<[string, string, string, number]> = [
      ["G43:I43", "会社補充", "J43:K43", cashFunding.companyReplenishment],
      ["L43:N43", "個人補充", "O43:P43", cashFunding.personalReplenishment],
      ["G44:I44", "会社送金", "J44:K44", cashFunding.companyTransfer],
      ["L44:N44", "個人返済", "O44:P44", cashFunding.personalRepayment],
      ["G45:I45", "期首未返済", "J45:K45", cashFunding.openingPersonalDebt],
      ["L45:N45", "期末未返済", "O45:P45", cashFunding.closingPersonalDebt],
    ];
    for (const [labelRange, caption, amountRange, amount] of fundingCells) {
      labelAt(labelRange, caption);
      mergeAt(amountRange, amount);
    }
    templateRow(45).height = 30;
  }
  labelAt("C42", "本指売上");
  templateCell("D42").value = report.honShimeiSales;
  labelAt("C43", "場内売上");
  templateCell("D43").value = report.jonaiExtensionSales;
  labelAt("C44", "キャスト総売上");
  const additionalSales = report.additionalSales ?? 0;
  if (additionalSales) {
    labelAt("C45", "追加売上");
    templateCell("D45").value = additionalSales;
    templateRow(45).height = Math.max(templateRow(45).height || 0, 30);
    for (const column of ["C", "D"]) templateCell(`${column}45`).border = { ...templateCell(`${column}43`).border };
  }
  templateCell("D44").value = formula(additionalSales ? "SUM(D42:D43,D45)" : "SUM(D42:D43)",
    report.honShimeiSales + report.jonaiExtensionSales + additionalSales);
  labelAt("R41:T41", "キャスト報酬額");
  mergeAt("U41:V41", formula("M37", report.castNet));
  labelAt("R42:T42", "源泉税");
  mergeAt("U42:V42", report.castWithholding);
  labelAt("R43:T43", "紹介料");
  mergeAt("U43:V43", formula("S35", introducerPayment));
  labelAt("R44:S44", "15日");
  labelAt("T44", "準備金");
  mergeAt("U44:V44", formula("SUM(U41:U43)", report.castNet + report.castWithholding + introducerPayment));
  labelAt("R46:T46", "【源泉所得税】");
  mergeAt("U46:W46", formula("U42", report.castWithholding));

  for (const [address, color] of [["M37", "FFFFFF99"], ["U41", "FFFFFF99"], ["U42", "FFDDEBF7"], ["U43", "FFE2EFDA"], ["W36", "FFFCE4D6"]]) {
    templateCell(address).fill = { type: "pattern", pattern: "solid", fgColor: { argb: color } };
  }
  for (const row of [36, 37, 38, 39, 40, 42, 44]) templateRow(row).height = row === 37 || row === 38 ? 48 : 30;
  // 下段は見本に存在するラベル・数値範囲だけに罫線を引き、余白を保つ。
  for (const range of ["C36:W36", "B37:V37", "A38:W38", "A39:L39", "O39:W39", "A40:L40", "G42:P42", "C42:D44", "R41:V44", "R46:W46", ...(cashFunding ? ["G43:P45"] : [])]) {
    const [start, end] = range.split(":").map((address) => templateCell(address));
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
