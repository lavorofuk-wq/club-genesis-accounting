import {
  db,
  collection,
  getDocs,
  orderBy,
  query,
  where,
  reportsCollectionName
} from "./firebase-config.js";
import { requireRole, logout, showMessage, hideMessage } from "./auth.js";

const yen = new Intl.NumberFormat("ja-JP");
let reports = [];

document.getElementById("logoutButton").addEventListener("click", logout);
document.getElementById("loadButton").addEventListener("click", loadReports);
document.getElementById("exportCsvButton").addEventListener("click", exportCsv);

requireRole("accounting", () => {
  document.getElementById("dashboard").classList.remove("hidden");
  const { start, end } = currentMonthRange();
  document.getElementById("startDate").value = start;
  document.getElementById("endDate").value = end;
  loadReports();
});

function currentMonthRange() {
  const d = new Date();
  const start = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
  const endDate = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  const end = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, "0")}-${String(endDate.getDate()).padStart(2, "0")}`;
  return { start, end };
}

async function loadReports() {
  hideMessage("errorMessage");
  const start = document.getElementById("startDate").value;
  const end = document.getElementById("endDate").value;
  if (!start || !end || start > end) {
    showMessage("errorMessage", "正しい日付範囲を指定してください。");
    return;
  }

  try {
    const q = query(
      collection(db, reportsCollectionName),
      where("date", ">=", start),
      where("date", "<=", end),
      orderBy("date", "asc")
    );
    const snap = await getDocs(q);
    reports = snap.docs.map((docSnap) => docSnap.data());
    renderAll(start, end);
  } catch (error) {
    showMessage("errorMessage", `データ取得に失敗しました。${error.message}`);
  }
}

function renderAll(start, end) {
  const summary = summarize(reports);
  renderSummaryCards(summary);
  renderBreakdown("expenseBreakdown", summary.expenseByCategory);
  renderBreakdown("allowanceBreakdown", summary.allowanceByType);
  renderTable();
  renderCalendar(start, end);
}

function summarize(items) {
  const result = {
    totalSales: 0,
    totalExpenses: 0,
    totalAllowances: 0,
    grossProfit: 0,
    castHours: 0,
    staffHours: 0,
    expenseByCategory: {},
    allowanceByType: {}
  };

  items.forEach((report) => {
    result.totalSales += Number(report.totalSales || 0);
    (report.expenses || []).forEach((expense) => {
      const amount = Number(expense.amount || 0);
      result.totalExpenses += amount;
      result.expenseByCategory[expense.category] = (result.expenseByCategory[expense.category] || 0) + amount;
    });
    (report.allowances || []).forEach((allowance) => {
      const amount = Number(allowance.amount || 0);
      result.totalAllowances += amount;
      result.allowanceByType[allowance.type] = (result.allowanceByType[allowance.type] || 0) + amount;
    });
    result.castHours += (report.castHours || []).reduce((sum, row) => sum + Number(row.hours || 0), 0);
    const staff = report.staffHours || {};
    result.staffHours += Array.isArray(staff)
      ? staff.reduce((sum, row) => sum + Number(row.hours || 0), 0)
      : ["manager", "bartender", "kitchen", "cleaning", "other"]
        .reduce((sum, key) => sum + Number(staff[key] || 0), 0);
  });
  result.grossProfit = result.totalSales - result.totalExpenses;
  return result;
}

function renderSummaryCards(summary) {
  const cards = [
    ["総売上", `${yen.format(summary.totalSales)}円`],
    ["総経費", `${yen.format(summary.totalExpenses)}円`],
    ["総手当", `${yen.format(summary.totalAllowances)}円`],
    ["推定粗利", `${yen.format(summary.grossProfit)}円`],
    ["延べキャスト労働時間", `${summary.castHours.toFixed(1)}時間`],
    ["延べスタッフ労働時間", `${summary.staffHours.toFixed(1)}時間`]
  ];
  const root = document.getElementById("summaryCards");
  root.replaceChildren();
  cards.forEach(([label, value]) => {
    const card = document.createElement("article");
    card.className = "summary-card";
    const p = document.createElement("p");
    p.textContent = label;
    const strong = document.createElement("strong");
    strong.textContent = value;
    card.append(p, strong);
    root.appendChild(card);
  });
}

function renderBreakdown(id, data) {
  const root = document.getElementById(id);
  root.replaceChildren();
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  if (!entries.length) {
    const empty = document.createElement("p");
    empty.className = "text-sm text-slate-500";
    empty.textContent = "データなし";
    root.appendChild(empty);
    return;
  }
  entries.forEach(([label, amount]) => {
    const row = document.createElement("div");
    row.className = "breakdown-item";
    const name = document.createElement("span");
    name.textContent = label;
    const value = document.createElement("strong");
    value.textContent = `${yen.format(amount)}円`;
    row.append(name, value);
    root.appendChild(row);
  });
}

function renderTable() {
  const body = document.getElementById("reportTableBody");
  body.replaceChildren();
  reports.forEach((report) => {
    const expenseTotal = (report.expenses || []).reduce((sum, row) => sum + Number(row.amount || 0), 0);
    const allowanceTotal = (report.allowances || []).reduce((sum, row) => sum + Number(row.amount || 0), 0);
    const values = [
      report.date,
      `${yen.format(report.totalSales || 0)}円`,
      `${yen.format(report.cashSales || 0)}円`,
      `${yen.format(report.cardSales || 0)}円`,
      report.totalCustomers || 0,
      report.groupCount || 0,
      `${yen.format(report.customerUnitPrice || 0)}円`,
      shimeiInfo(report).honShimei || 0,
      shimeiInfo(report).jonai || 0,
      `${yen.format(expenseTotal)}円`,
      `${yen.format(allowanceTotal)}円`
    ];
    const tr = document.createElement("tr");
    values.forEach((value) => {
      const td = document.createElement("td");
      td.textContent = value;
      tr.appendChild(td);
    });
    body.appendChild(tr);
  });
}

function renderCalendar(start, end) {
  const submitted = new Set(reports.map((report) => report.date));
  const grid = document.getElementById("calendarGrid");
  grid.replaceChildren();
  for (const date of datesBetween(start, end)) {
    const cell = document.createElement("div");
    const future = date > todayString();
    cell.className = `calendar-day ${future ? "future" : submitted.has(date) ? "submitted" : "missing"}`;
    const day = document.createElement("strong");
    day.textContent = date.slice(8, 10);
    const state = document.createElement("p");
    state.className = "mt-2";
    state.textContent = future ? "未来日" : submitted.has(date) ? "入力済" : "未入力";
    cell.append(day, state);
    grid.appendChild(cell);
  }
}

function datesBetween(start, end) {
  const list = [];
  const d = new Date(`${start}T12:00:00`);
  const last = new Date(`${end}T12:00:00`);
  while (d <= last) {
    list.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
    d.setDate(d.getDate() + 1);
  }
  return list;
}

function todayString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function exportCsv() {
  if (!reports.length) {
    showMessage("errorMessage", "CSV出力対象のデータがありません。");
    return;
  }
  const rows = [
    ["日付", "総売上", "現金", "カード", "総客数", "組数", "客単価", "本指名", "場内指名", "経費合計", "手当合計"]
  ];
  reports.forEach((report) => {
    rows.push([
      report.date,
      report.totalSales || 0,
      report.cashSales || 0,
      report.cardSales || 0,
      report.totalCustomers || 0,
      report.groupCount || 0,
      report.customerUnitPrice || 0,
      shimeiInfo(report).honShimei || 0,
      shimeiInfo(report).jonai || 0,
      (report.expenses || []).reduce((sum, row) => sum + Number(row.amount || 0), 0),
      (report.allowances || []).reduce((sum, row) => sum + Number(row.amount || 0), 0)
    ]);
  });
  const csv = rows.map((row) => row.map(escapeCsv).join(",")).join("\r\n");
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const end = document.getElementById("endDate").value.replaceAll("-", "");
  a.href = url;
  a.download = `keiri_export_${end}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function escapeCsv(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function shimeiInfo(report) {
  return report.shimeiInfo || report["指名情報"] || {};
}
