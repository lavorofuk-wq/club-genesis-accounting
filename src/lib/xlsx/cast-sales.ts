"use client";

import ExcelJS from "exceljs/dist/exceljs.min.js";
import type { CastReward, CastSalesDay, CastSalesReport } from "@/domain/gms";
import type { MonthlyAccountingResults } from "@/domain/month-accounting";

const amountFormat = '#,##0;[Red]-#,##0;0';
const font = { name: "Yu Gothic", size: 10 };
const border: Partial<ExcelJS.Borders> = {
  top: { style: "thin", color: { argb: "FFD0D5DC" } },
  bottom: { style: "thin", color: { argb: "FFD0D5DC" } },
  left: { style: "thin", color: { argb: "FFD0D5DC" } },
  right: { style: "thin", color: { argb: "FFD0D5DC" } },
};
type ReportNumbers = Pick<CastSalesDay, "backs" | "bottleBackByKind">;
type ExportResults = Pick<MonthlyAccountingResults, "castSalesReports" | "castRewards">;
const dailyNumberKeys = [
  "hours", "honShimeiSales", "jonaiExtensionSales", "totalSales", "honShimeiLiquorCost", "jonaiExtensionLiquorCost",
  "totalLiquorCost", "honShimeiCount", "banaiShimeiCount", "nominationCount", "dohanCount", "backTotal", "beautyAllowance",
] as const;
const closeEnough = (left: number, right: number) => Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) < 0.000001;

function back(row: ReportNumbers, key: CastSalesDay["backs"][number]["key"]) {
  return row.backs.filter((item) => item.key === key).reduce((sum, item) => sum + item.amount, 0);
}

function validateReport(report: CastSalesReport, reward: CastReward) {
  const fail = () => { throw new Error(`${report.name}の売上・報酬データに欠損または合計の不一致があります。元データを確認してください。`); };
  // 新規計算は10円単位だが、確定済みスナップショットには旧仕様の333円等が残る。
  // 帳票では保存済み結果を再計算しないため、金額は安全な整数と合計整合だけを検証する。
  for (const row of [...report.days, report.totals]) {
    if (dailyNumberKeys.some((key) => !Number.isFinite(row[key]) || row[key] < 0)
      || row.backs.some((item) => !Number.isSafeInteger(item.amount) || item.amount < 0)
      || new Set(row.backs.map((item) => item.key)).size !== row.backs.length
      || !closeEnough(row.totalSales, row.honShimeiSales + row.jonaiExtensionSales)
      || !closeEnough(row.totalLiquorCost, row.honShimeiLiquorCost + row.jonaiExtensionLiquorCost)
      || !closeEnough(row.backTotal, row.backs.reduce((sum, item) => sum + item.amount, 0))) fail();
    if (row.bottleBackByKind && (!Number.isSafeInteger(row.bottleBackByKind.keepBottle)
      || row.bottleBackByKind.keepBottle < 0 || !Number.isSafeInteger(row.bottleBackByKind.champagneWine)
      || row.bottleBackByKind.champagneWine < 0
      || row.bottleBackByKind.keepBottle + row.bottleBackByKind.champagneWine !== back(row, "bottle"))) fail();
  }
  if (!report.days.length || report.attendanceDays !== report.days.length || report.totals.attendanceDays !== report.attendanceDays
    || dailyNumberKeys.some((key) => !closeEnough(report.totals[key], report.days.reduce((sum, day) => sum + day[key], 0)))) fail();
  for (const key of ["honShimei", "banaiShimei", "dohan", "bottle", "drink"] as const) {
    if (!closeEnough(back(report.totals, key), report.days.reduce((sum, day) => sum + back(day, key), 0))) fail();
  }
  const rewardKeys = ["hourlyPay", "honShimeiBack", "banaiShimeiBack", "dohanBack", "bottleBack", "drinkBack",
    "hourlyAndBack", "salesReward", "beautyAllowance", "dailyPayment", "advancePayment", "transportFee", "withholding", "grossPay", "adoptedReward"] as const;
  if (rewardKeys.some((key) => !Number.isFinite(reward[key]) || reward[key] < 0)
    || !Number.isFinite(reward.rewardRate) || reward.rewardRate < 0 || reward.rewardRate > 1
    || !closeEnough(reward.hourlyAndBack, reward.hourlyPay + reward.honShimeiBack + reward.banaiShimeiBack + reward.dohanBack + reward.bottleBack + reward.drinkBack)
    || !closeEnough(reward.adoptedReward, reward.adoptedSystem === "hourlyAndBack" ? reward.hourlyAndBack : reward.salesReward)
    || !closeEnough(reward.grossPay, reward.adoptedReward + reward.beautyAllowance)
    || !closeEnough(reward.netPay, reward.grossPay - reward.dailyPayment - reward.advancePayment - reward.transportFee - reward.withholding)) fail();
}

function safeSheetName(name: string, used: Set<string>) {
  const cleaned = name.replace(/[\x00-\x1f\\/*?:[\]]/g, " ").trim().replace(/^'+|'+$/g, "").trim() || "キャスト";
  const base = cleaned.toLowerCase() === "history" ? `${cleaned}_` : cleaned;
  let suffix = "";
  let candidate = "";
  let index = 1;
  do {
    candidate = base.slice(0, 31 - suffix.length).replace(/[\uD800-\uDBFF]$/, "").replace(/'+$/g, "") + suffix;
    suffix = `_${++index}`;
  } while (used.has(candidate.toLocaleLowerCase()));
  used.add(candidate.toLocaleLowerCase());
  return candidate;
}

function timeValue(value: string) {
  if (!value) return null;
  const match = /^(\d{1,2}):([0-5]\d)$/.exec(value);
  if (!match || Number(match[1]) > 47) throw new Error(`出退勤時刻「${value}」を確認してください。`);
  return (Number(match[1]) * 60 + Number(match[2])) / 1440;
}

function mergeValue(sheet: ExcelJS.Worksheet, range: string, value: ExcelJS.CellValue) {
  sheet.mergeCells(range);
  sheet.getCell(range.split(":")[0]).value = value;
}

function sumCell(sheet: ExcelJS.Worksheet, column: string, result: number) {
  sheet.getCell(`${column}34`).value = { formula: `SUM(${column}3:${column}33)`, result };
}

function addPayroll(sheet: ExcelJS.Worksheet, reward: CastReward, report: CastSalesReport) {
  const hourlyAdopted = reward.adoptedSystem === "hourlyAndBack";
  mergeValue(sheet, "D35:K35", `時給＋バック${hourlyAdopted ? "（採用）" : "（比較用）"}`);
  mergeValue(sheet, "R35:V35", `売上報酬${!reward.rewardRate ? "（対象外）" : hourlyAdopted ? "（比較用）" : "（採用）"}`);
  const deductions = reward.dailyPayment + reward.advancePayment + reward.transportFee;
  const totalBack = reward.honShimeiBack + reward.banaiShimeiBack + reward.dohanBack + reward.bottleBack + reward.drinkBack;
  const hourlyGross = reward.hourlyAndBack + reward.beautyAllowance;
  const salesGross = reward.salesReward + reward.beautyAllowance;
  const left: Array<[string, ExcelJS.CellValue]> = [
    ["① 時給 計", reward.hourlyPay],
    ["② 総バック 計", totalBack],
    ["③ 美容室・手当て等", reward.beautyAllowance],
    ["④ 総支給額", { formula: "SUM(I36:I38)", result: hourlyGross }],
    ["⑤ 日払い・その他", deductions],
    ["⑥ 源泉所得税", reward.withholding],
    ["④－⑤－⑥ 差引支給額", { formula: "I39-I40-I41", result: hourlyGross - deductions - reward.withholding }],
  ];
  const right: Array<[string, ExcelJS.CellValue]> = [
    [reward.rewardRate ? `① 売上報酬（売上－酒代×50%）×${Math.round(reward.rewardRate * 100)}%` : "① 売上報酬（対象外）", reward.salesReward],
    ["② 美容室・手当て等", reward.beautyAllowance],
    ["③ 総支給額", { formula: "SUM(U36:U37)", result: salesGross }],
    ["④ 日払い・その他", deductions],
    ["⑤ 源泉所得税", reward.withholding],
    ["③－④－⑤ 差引支給額", { formula: "U38-U39-U40", result: salesGross - deductions - reward.withholding }],
  ];
  for (let row = 35; row <= 42; row += 1) {
    sheet.getRow(row).height = row === 36 ? 32 : 22;
    for (let col = 4; col <= 22; col += 1) {
      const cell = sheet.getRow(row).getCell(col);
      cell.font = font;
      cell.alignment = { vertical: "middle", wrapText: true };
      cell.numFmt = amountFormat;
    }
  }
  for (const [items, labelRange, valueRange] of [
    [left, ["D", "H"], ["I", "K"]],
    [right, ["R", "T"], ["U", "V"]],
  ] as const) {
    items.forEach(([label, value], index) => {
      const row = 36 + index;
      mergeValue(sheet, `${labelRange[0]}${row}:${labelRange[1]}${row}`, label);
      mergeValue(sheet, `${valueRange[0]}${row}:${valueRange[1]}${row}`, value);
      for (let col = sheet.getColumn(labelRange[0]).number; col <= sheet.getColumn(valueRange[1]).number; col += 1) {
        sheet.getRow(row).getCell(col).border = border;
      }
      sheet.getCell(`${valueRange[0]}${row}`).alignment = { horizontal: "right", vertical: "middle" };
    });
  }
  sheet.getCell(hourlyAdopted ? "D35" : "R35").font = { ...font, bold: true };
  mergeValue(sheet, "B44:K44", `採用方式：${reward.trialOnly ? "体入時給" : hourlyAdopted ? "時給＋バック" : "売上報酬"}`);
  mergeValue(sheet, "R44:T44", "採用した差引支給額");
  mergeValue(sheet, "U44:V44", reward.netPay);
  sheet.getCell("U44").numFmt = amountFormat;
  sheet.getRow(44).height = 25;
  sheet.getRow(44).font = { ...font, bold: true };
  sheet.getRow(44).alignment = { vertical: "middle" };
  const notes = ["金額は円。日払い・その他＝日払い＋立替＋送迎代。給与欄はキャスト報酬の月次計算結果。"];
  if (report.totals.beautyAllowance !== reward.beautyAllowance) notes.push("日別の美容室欄には、即日支払済みの体入手当を含みます。");
  if (report.totals.backTotal !== totalBack) notes.push("日別バック合計と給与欄の総バックが異なるため、それぞれの月次計算結果を記載しています。");
  mergeValue(sheet, "B45:V45", notes.join("\n"));
  sheet.getCell("B45").font = { ...font, size: 9 };
  sheet.getCell("B45").alignment = { vertical: "middle", wrapText: true };
  sheet.getRow(45).height = 15 * notes.length;
}

/** 集計済み画面データ／確定スナップショットのみを受け取り、原本・現在マスタから再計算しない。 */
export function createCastSalesWorkbook(results: ExportResults, month: string, sourceLabel: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("対象月を選択してください。");
  if (!results.castSalesReports.length) throw new Error("対象月の承認済みキャスト売上がありません。");
  const book = new ExcelJS.Workbook();
  book.creator = "GENESIS Management System Ver2.14.0";
  book.created = new Date();
  book.calcProperties.fullCalcOnLoad = true;
  const used = new Set<string>();
  const [year, monthNumber] = month.split("-").map(Number);
  const lastDay = new Date(year, monthNumber, 0).getDate();
  const rewardById = new Map(results.castRewards.map((reward) => [reward.id, reward]));
  if (new Set(results.castSalesReports.map((report) => report.id)).size !== results.castSalesReports.length
    || rewardById.size !== results.castRewards.length) throw new Error("キャストIDが重複しています。元データを確認してください。");

  for (const report of results.castSalesReports) {
    const reward = rewardById.get(report.id);
    if (!reward) throw new Error(`${report.name}のキャスト報酬データがありません。最新データを読み込んでください。`);
    validateReport(report, reward);
    const byDate = new Map<string, CastSalesDay>();
    for (const day of report.days) {
      if (!day.businessDate.startsWith(`${month}-`) || !/^\d{4}-\d{2}-\d{2}$/.test(day.businessDate)
        || Number(day.businessDate.slice(8)) < 1 || Number(day.businessDate.slice(8)) > lastDay) {
        throw new Error(`${report.name}の出勤日が対象月と一致しません。`);
      }
      if (byDate.has(day.businessDate)) throw new Error(`${report.name}の${day.businessDate}に複数の勤務記録があります。重複を確認してください。`);
      byDate.set(day.businessDate, day);
    }
    const sheet = book.addWorksheet(safeSheetName(report.name, used));
    sheet.columns = [3, 5, 8, 8, 9, 6, 12, 13, 6, 12, 13, 6, 12, 12, 12, 25, 25, 29, 13, 14, 12, 11].map((width) => ({ width }));
    sheet.views = [{ state: "frozen", xSplit: 2, ySplit: 2, showGridLines: false }];
    sheet.pageSetup = {
      paperSize: 9, orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      horizontalCentered: true, printArea: "B1:V45", printTitlesRow: "1:2",
      margins: { left: .25, right: .25, top: .35, bottom: .35, header: .15, footer: .15 },
    };
    sheet.headerFooter.oddFooter = `&"${font.name},Regular"${sourceLabel.replace(/&/g, "&&")} &R&P / &N`;
    for (let row = 1; row <= 34; row += 1) {
      sheet.getRow(row).height = row === 2 ? 32 : row === 1 ? 27 : 21;
      for (let col = 2; col <= 22; col += 1) {
        const cell = sheet.getRow(row).getCell(col);
        cell.font = { ...font, bold: row <= 2 || row === 34 };
        cell.border = border;
        cell.alignment = { horizontal: col <= 6 || col === 9 || col === 12 ? "center" : "right", vertical: "middle", wrapText: true };
        cell.numFmt = amountFormat;
        if (row <= 2 || row === 34) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE4E8ED" } };
      }
    }
    mergeValue(sheet, "B1:D1", `${year}年 ${monthNumber}月分`);
    mergeValue(sheet, "F1:K1", `【キャスト名】${report.name}`);
    mergeValue(sheet, "L1:M1", "出勤日数");
    mergeValue(sheet, "N1:O1", report.attendanceDays);
    sheet.getCell("N1").numFmt = '0"日"';
    mergeValue(sheet, "P1:P2", "B\n（料金ー原価）×１５％");
    mergeValue(sheet, "Q1:Q2", "C/W\n（料金ー原価）×２５％");
    mergeValue(sheet, "R1:S1", "勤務時間");
    mergeValue(sheet, "T1:V1", { formula: "E34", result: report.totals.hours / 24 });
    sheet.getCell("T1").numFmt = '[h]"時間"mm"分"';
    const headings: Record<string, string> = {
      B: "日", C: "出勤", D: "退勤", E: "勤務時間", F: "本指", G: "バック", H: "本指売上",
      I: "場内", J: "バック", K: "場延売上", L: "同伴", M: "バック",
      N: "本指酒代", O: "場内酒代", R: "ボトル名", S: "酒代計", T: "日売上", U: "ドリンク10%", V: "美容室",
    };
    Object.entries(headings).forEach(([column, value]) => { sheet.getCell(`${column}2`).value = value; });
    sheet.getRow(2).alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    const unknownBottleBreakdown = report.days.some((day) => !day.bottleBackByKind);

    for (let dayNumber = 1; dayNumber <= 31; dayNumber += 1) {
      const rowIndex = dayNumber + 2;
      if (dayNumber > lastDay) continue;
      const row = sheet.getRow(rowIndex);
      row.getCell("B").value = dayNumber;
      const day = byDate.get(`${month}-${String(dayNumber).padStart(2, "0")}`);
      if (!day) continue;
      const values: Record<string, ExcelJS.CellValue> = {
        C: timeValue(day.startTime), D: timeValue(day.endTime), E: day.hours / 24,
        F: day.honShimeiCount, G: back(day, "honShimei"), H: day.honShimeiSales,
        I: day.banaiShimeiCount, J: back(day, "banaiShimei"), K: day.jonaiExtensionSales,
        L: day.dohanCount, M: back(day, "dohan"), N: day.honShimeiLiquorCost, O: day.jonaiExtensionLiquorCost,
        R: day.bottles.map((bottle) => `${bottle.name} ×${bottle.quantity}`).join("\n"),
        S: day.totalLiquorCost, T: day.totalSales, U: back(day, "drink"), V: day.beautyAllowance,
      };
      Object.entries(values).forEach(([column, value]) => { row.getCell(column).value = value; });
      row.getCell("C").numFmt = "[h]:mm";
      row.getCell("D").numFmt = "[h]:mm";
      row.getCell("E").numFmt = "[h]:mm";
      row.getCell("R").alignment = { horizontal: "left", vertical: "middle", wrapText: true };
      const bottleLines = day.bottles.reduce((sum, bottle) => sum + Math.max(1, Math.ceil((`${bottle.name} ×${bottle.quantity}`).length / 13)), 0);
      row.height = Math.max(21, bottleLines * 15);
      if (day.bottleBackByKind) {
        row.getCell("P").value = day.bottleBackByKind.keepBottle;
        row.getCell("Q").value = day.bottleBackByKind.champagneWine;
      } else {
        mergeValue(sheet, `P${rowIndex}:Q${rowIndex}`, back(day, "bottle"));
        row.getCell("P").numFmt = '#,##0"（内訳未保存・合計）"';
      }
    }

    sheet.getCell("B34").value = "合計";
    const sumColumns = ["E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "S", "T", "U", "V"];
    for (const column of sumColumns) {
      const total = report.days.reduce((sum, day) => {
        const date = Number(day.businessDate.slice(8));
        return sum + Number(sheet.getCell(`${column}${date + 2}`).value || 0);
      }, 0);
      sumCell(sheet, column, total);
    }
    sheet.getCell("E34").numFmt = "[h]:mm";
    if (unknownBottleBreakdown) {
      mergeValue(sheet, "P34:Q34", { formula: "SUM(P3:Q33)", result: report.days.reduce((sum, day) => sum + back(day, "bottle"), 0) });
      sheet.getCell("P34").numFmt = '#,##0"（種類合計）"';
    } else {
      sumCell(sheet, "P", report.days.reduce((sum, day) => sum + day.bottleBackByKind!.keepBottle, 0));
      sumCell(sheet, "Q", report.days.reduce((sum, day) => sum + day.bottleBackByKind!.champagneWine, 0));
    }
    addPayroll(sheet, reward, report);
  }
  return book;
}
