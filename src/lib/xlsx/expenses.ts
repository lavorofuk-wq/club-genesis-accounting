"use client";

import ExcelJS from "exceljs/dist/exceljs.min.js";
import { summarizeExpenseIntroducers, validateExpenseExport, type ExpenseExportInput } from "@/domain/expense-export";
import type { ExpenseCategory } from "@/domain/gms";

const font = { name: "Yu Gothic", size: 10 };
// 既存保存値を再丸めしない。小数を含む旧データも表示から失わない。
const amountFormat = '#,##0.########;[Red]-#,##0.########;0';
const border: Partial<ExcelJS.Borders> = Object.fromEntries(
  ["top", "bottom", "left", "right"].map((side) => [side, { style: "thin", color: { argb: "FFCBD5E1" } }]),
);
const categories: Array<{ category: ExpenseCategory | "dispatchFee"; column: string; amount: string; label: string }> = [
  { category: "liquor", column: "B", amount: "C", label: "酒代" },
  { category: "introduction", column: "D", amount: "E", label: "広告宣伝①" },
  { category: "advertising", column: "F", amount: "G", label: "広告宣伝②" },
  { category: "supplies", column: "H", amount: "I", label: "消耗品/備品" },
  { category: "entertainment", column: "J", amount: "K", label: "交際費" },
  { category: "transportOther", column: "L", amount: "M", label: "交通費" },
  { category: "dispatchFee", column: "N", amount: "O", label: "その他" },
  { category: "beautyTrial", column: "P", amount: "Q", label: "美容室" },
];
const sum = <T,>(rows: T[], amount: (row: T) => number) => rows.reduce((total, row) => total + amount(row), 0);
const formula = (expression: string, result: number): ExcelJS.CellFormulaValue => ({ formula: expression, result });
const normalizedAccount = (value: string) => value.normalize("NFKC").trim();

function merge(sheet: ExcelJS.Worksheet, range: string, value: ExcelJS.CellValue) {
  sheet.mergeCells(range);
  sheet.getCell(range.split(":")[0]).value = value;
}

function label(sheet: ExcelJS.Worksheet, address: string, value: string) {
  const cell = sheet.getCell(address);
  cell.value = value;
  cell.alignment = { horizontal: "left", vertical: "middle", wrapText: true };
  const estimatedLines = value.split("\n").reduce((count, line) => count + Math.max(1, Math.ceil(line.length / 8)), 0);
  const row = sheet.getRow(Number(cell.row));
  row.height = Math.min(409, Math.max(row.height || 21, estimatedLines * 15));
}

/** 添付「GENESIS経費表」の列・集計欄を再現。保存済み月次金額を丸め直さない。 */
export function createMonthlyExpenseWorkbook(input: ExpenseExportInput, sourceLabel: string) {
  validateExpenseExport(input);
  const { results, month, adjustments } = input;
  const introducers = summarizeExpenseIntroducers(results);
  const approved = input.closings.filter((row) => row.status === "approved" && row.businessDate.startsWith(`${month}-`));
  const byDate = new Map(approved.map((row) => [row.businessDate, row]));
  const [year, monthNumber] = month.split("-").map(Number);
  const lastDay = new Date(year, monthNumber, 0).getDate();
  const fixed = ["賃料", "カラオケ", "おしぼり", "リースキン", "固定電話", "西部ガス", "USEN", "酒代", "カード決済手数料"]
    .map((account) => ({ account, amount: 0 }));
  for (const item of adjustments.fixedExpenses) {
    const account = normalizedAccount(item.account);
    const existing = fixed.find((row) => normalizedAccount(row.account) === account);
    if (existing) existing.amount += item.amount;
    else fixed.push({ account: item.account.trim(), amount: item.amount });
  }
  fixed[7].amount += results.expenses.liquorDelivery;
  fixed[8].amount += results.expenses.cardFee;

  // 見本の定員を超える場合は下段を伸ばし、金額・氏名の切捨てを避ける。
  const driverHeader = 37 + Math.max(4, Math.ceil(introducers.length / 3));
  const driverStart = driverHeader + 1;
  const totalRow = Math.max(45, 36 + fixed.length, 37 + Math.ceil(results.staffPayroll.length / 2),
    driverStart + Math.max(3, Math.ceil(results.driverPayroll.length / 2)));
  const book = new ExcelJS.Workbook();
  book.creator = "GENESIS Management System Ver2.17.0";
  book.created = new Date();
  book.calcProperties.fullCalcOnLoad = true;
  const sheet = book.addWorksheet("ジェネシス経費表");
  sheet.columns = [6, 16, 12, 16, 12, 16, 12, 16, 12, 16, 12, 16, 12, 16, 12, 16, 12, 14].map((width) => ({ width }));
  sheet.views = [{ state: "frozen", xSplit: 1, ySplit: 2, showGridLines: false, zoomScale: 69 }];
  sheet.pageSetup = {
    orientation: "landscape", paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0,
    horizontalCentered: true, printArea: `A1:R${totalRow}`, printTitlesRow: "1:2",
    margins: { left: .25, right: .25, top: .4, bottom: .4, header: .2, footer: .2 },
  };
  sheet.headerFooter.oddFooter = `&"Yu Gothic,Regular"${sourceLabel.replace(/&/g, "&&")}（承認済み日次のみ） &R&P / &N`;
  for (let row = 1; row <= totalRow; row += 1) {
    sheet.getRow(row).height = row === 1 ? 24 : 21;
    for (let column = 1; column <= 18; column += 1) {
      const cell = sheet.getCell(row, column);
      cell.font = { ...font, bold: row <= 2 || row === 34 || row === totalRow };
      cell.alignment = { vertical: "middle", horizontal: column === 1 ? "center" : "right", wrapText: true };
      cell.numFmt = amountFormat;
      if (row >= 2) cell.border = border;
      if (row === 2 || row === 35) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2E8F0" } };
      else if (row === 34 || row === totalRow || row >= 36 && row % 2 === 0) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFC" } };
      }
    }
  }
  merge(sheet, "A1:F1", "ジェネシス経費表");
  sheet.getCell("A1").font = { ...font, size: 12, bold: true };
  sheet.getCell("A1").alignment = { horizontal: "left", vertical: "middle" };
  sheet.getCell("G1").value = `${year}年`;
  sheet.getCell("H1").value = `${monthNumber}月度`;
  merge(sheet, "J1:R1", sourceLabel);
  sheet.getCell("J1").alignment = { horizontal: "right", vertical: "middle" };
  sheet.getCell("J1").font = { ...font, size: 9 };
  sheet.getCell("A2").value = "日";
  sheet.getCell("R2").value = "合計";
  for (const category of categories) {
    sheet.getCell(`${category.column}2`).value = category.label;
    sheet.getCell(`${category.amount}2`).value = "金額";
  }
  sheet.getRow(2).alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  const categoryTotals = new Map<string, number>();
  for (let day = 1; day <= 31; day += 1) {
    const row = day + 2;
    if (day > lastDay) continue;
    sheet.getCell(`A${row}`).value = day;
    const closing = byDate.get(`${month}-${String(day).padStart(2, "0")}`);
    let dailyTotal = 0;
    for (const category of categories) {
      const payments = new Map<string, number>();
      if (category.category === "dispatchFee") {
        if (closing?.dispatchFee) payments.set("派遣手数料", closing.dispatchFee);
      } else {
        for (const expense of closing?.expenses || []) {
          if (expense.category !== category.category) continue;
          const name = expense.payee;
          payments.set(name, (payments.get(name) || 0) + expense.amount);
        }
      }
      const amount = sum([...payments.values()], (value) => value);
      const names = [...payments.keys()];
      if (names.length) label(sheet, `${category.column}${row}`, names.join("\n"));
      sheet.getCell(`${category.amount}${row}`).value = amount;
      categoryTotals.set(category.amount, (categoryTotals.get(category.amount) || 0) + amount);
      dailyTotal += amount;
    }
    sheet.getCell(`R${row}`).value = formula(`SUM(${categories.map((category) => `${category.amount}${row}`).join(",")})`, dailyTotal);
  }
  for (const category of categories) {
    label(sheet, `${category.column}34`, category.column === "P" ? "変動費合計" : "合計");
    sheet.getCell(`${category.amount}34`).value = formula(`SUM(${category.amount}3:${category.amount}33)`, categoryTotals.get(category.amount) || 0);
  }
  const variableTotal = results.expenses.dailyExpenseTotal + results.expenses.dispatchFee;
  sheet.getCell("R34").value = formula(`SUM(${categories.map((category) => `${category.amount}34`).join(",")})`, variableTotal);

  label(sheet, "B35", "固定費");
  label(sheet, "F35", "人件費");
  label(sheet, "H35", "人件費");
  merge(sheet, "L35:O35", "スカウト報酬");
  merge(sheet, "F36:G36", "女子総支給額");
  merge(sheet, "H36:K36", "従業員給与");
  label(sheet, "L36", "紹介料計");
  label(sheet, "N36", "顧問料計");
  const advisoryTotal = sum(results.introducerPayments, (row) => row.advisory);
  const introducerTotal = sum(results.introducerPayments, (row) => row.total);
  sheet.getCell("M36").value = introducerTotal - advisoryTotal;
  sheet.getCell("O36").value = advisoryTotal;
  sheet.getCell("R35").value = formula("SUM(R34,M36,O36)", variableTotal + introducerTotal);
  fixed.forEach((row, index) => {
    label(sheet, `B${36 + index}`, row.account);
    sheet.getCell(`C${36 + index}`).value = row.amount;
  });
  label(sheet, "F37", "時給");
  label(sheet, "F38", "売上報酬");
  label(sheet, "F40", "派遣支払");
  sheet.getCell("G37").value = sum(results.castRewards.filter((row) => row.adoptedSystem === "hourlyAndBack"), (row) => row.grossPay);
  sheet.getCell("G38").value = sum(results.castRewards.filter((row) => row.adoptedSystem === "salesReward"), (row) => row.grossPay);
  const dispatchPayment = results.expenses.dispatchCast + results.expenses.dispatchStaff;
  sheet.getCell("G40").value = dispatchPayment;
  results.staffPayroll.forEach((person, index) => {
    const row = 37 + Math.floor(index / 2);
    label(sheet, `${index % 2 ? "J" : "H"}${row}`, person.name);
    sheet.getCell(`${index % 2 ? "K" : "I"}${row}`).value = person.gross;
  });
  introducers.forEach((person, index) => {
    const row = 37 + Math.floor(index / 3);
    const column = ["L", "N", "P"][index % 3];
    const amount = `${["M", "O", "Q"][index % 3]}${row}`;
    label(sheet, `${column}${row}`, person.name);
    sheet.getCell(amount).value = person.total;
  });
  // 明細全件の合計から顧問料を引き、紹介料計の式と表示済みキャッシュを一致させる。
  sheet.getCell("M36").value = formula(`SUM(M37:M${driverHeader - 1},O37:O${driverHeader - 1},Q37:Q${driverHeader - 1})-O36`, introducerTotal - advisoryTotal);
  merge(sheet, `L${driverHeader}:O${driverHeader}`, "送迎給与");
  results.driverPayroll.forEach((person, index) => {
    const row = driverStart + Math.floor(index / 2);
    label(sheet, `${index % 2 ? "N" : "L"}${row}`, person.name);
    sheet.getCell(`${index % 2 ? "O" : "M"}${row}`).value = person.gross;
  });
  label(sheet, `B${totalRow}`, "固定費合計");
  label(sheet, `F${totalRow}`, "女子給合計");
  merge(sheet, `H${totalRow}:I${totalRow}`, "従業員給合計");
  merge(sheet, `L${totalRow}:M${totalRow}`, "送迎給合計");
  sheet.getCell(`C${totalRow}`).value = formula(`SUM(C36:C${totalRow - 1})`, results.expenses.fixed + results.expenses.liquorDelivery + results.expenses.cardFee);
  sheet.getCell(`G${totalRow}`).value = formula(`SUM(G37:G${totalRow - 1})`, results.balance.cast + dispatchPayment);
  sheet.getCell(`J${totalRow}`).value = formula(`SUM(I37:I${totalRow - 1},K37:K${totalRow - 1})`, results.balance.staff);
  sheet.getCell(`N${totalRow}`).value = formula(`SUM(M${driverStart}:M${totalRow - 1},O${driverStart}:O${totalRow - 1})`, results.balance.driver);
  merge(sheet, `P${totalRow - 2}:R${totalRow - 1}`, "総支出合計");
  merge(sheet, `P${totalRow}:R${totalRow}`, formula(`SUM(R34,C${totalRow},G${totalRow},J${totalRow},M36,O36,N${totalRow})`, results.balance.totalCosts));
  sheet.getCell(`P${totalRow}`).font = { ...font, bold: true, size: 12 };
  for (const address of ["L35", "F36", "H36", `L${driverHeader}`, `H${totalRow}`, `L${totalRow}`, `P${totalRow - 2}`]) {
    sheet.getCell(address).font = { ...font, bold: true };
    sheet.getCell(address).alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  }
  sheet.eachRow((row) => row.eachCell((cell) => {
    const value = cell.type === ExcelJS.ValueType.Formula ? cell.result : cell.value;
    if (typeof value === "number" && Number.isInteger(value)) cell.numFmt = '#,##0;[Red]-#,##0;0';
  }));
  return book;
}
