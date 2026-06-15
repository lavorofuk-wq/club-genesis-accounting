import {
  db,
  collection,
  getDocs,
  orderBy,
  query,
  where,
  closingsCollectionName
} from "./firebase-config.js";
import { requireRole, logout, showMessage, hideMessage } from "./auth.js";

const yen = new Intl.NumberFormat("ja-JP");
let closings = [];

document.getElementById("logoutButton").addEventListener("click", logout);
document.getElementById("loadButton").addEventListener("click", loadClosings);
document.getElementById("exportCsvButton").addEventListener("click", exportCsv);

requireRole("accounting", () => {
  document.getElementById("dashboard").classList.remove("hidden");
  const { start, end } = currentMonthRange();
  document.getElementById("startDate").value = start;
  document.getElementById("endDate").value = end;
  loadClosings();
});

function currentMonthRange() {
  const d = new Date();
  const start = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
  const endDate = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  const end = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, "0")}-${String(endDate.getDate()).padStart(2, "0")}`;
  return { start, end };
}

async function loadClosings() {
  hideMessage("errorMessage");
  const start = document.getElementById("startDate").value;
  const end = document.getElementById("endDate").value;
  if (!start || !end || start > end) {
    showMessage("errorMessage", "正しい日付範囲を指定してください。");
    return;
  }

  try {
    const q = query(
      collection(db, closingsCollectionName),
      where("businessDate", ">=", start),
      where("businessDate", "<=", end),
      orderBy("businessDate", "asc")
    );
    const snap = await getDocs(q);
    closings = snap.docs.map((docSnap) => normalizeClosing({ id: docSnap.id, ...docSnap.data() }));
    renderAll(start, end);
  } catch (error) {
    showMessage("errorMessage", `POS締めデータの取得に失敗しました。${error.message}`);
  }
}

function normalizeClosing(raw) {
  const sales = raw.sales || {};
  const customers = raw.customers || {};
  const nominations = raw.nominations || raw.shimeiInfo || raw["指名情報"] || {};
  const cashReconciliation = raw.cashReconciliation || {};
  const date = raw.businessDate || raw.date || raw.id;
  const totalSales = Number(sales.totalSales ?? raw.totalSales ?? 0);
  const totalCustomers = Number(customers.totalCustomers ?? raw.totalCustomers ?? 0);

  return {
    id: raw.id,
    businessDate: date,
    status: raw.status || "submitted",
    totalSales,
    cashSales: Number(sales.cashSales ?? raw.cashSales ?? 0),
    cardSales: Number(sales.cardSales ?? raw.cardSales ?? 0),
    groupCount: Number(customers.groupCount ?? raw.groupCount ?? 0),
    totalCustomers,
    customerUnitPrice: Number(customers.customerUnitPrice ?? raw.customerUnitPrice ?? (totalCustomers > 0 ? Math.floor(totalSales / totalCustomers) : 0)),
    honShimei: Number(nominations.honShimeiCount ?? nominations.honShimei ?? 0),
    jonai: Number(nominations.jonaiCount ?? nominations.jonai ?? 0),
    expenses: raw.expenses || [],
    allowances: raw.allowances || [],
    castWork: raw.castWork || raw.castHours || [],
    staffWork: raw.staffWork || raw.staffHours || [],
    cashDifference: Number(cashReconciliation.difference ?? raw.cashDifference ?? 0),
    closedBy: raw.source?.closedBy || raw.closedBy || "",
    closedAt: raw.source?.closedAt || raw.closedAt || raw.submittedAt || null
  };
}

function renderAll(start, end) {
  const summary = summarize(closings);
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
    cashDifference: 0,
    castHours: 0,
    staffHours: 0,
    expenseByCategory: {},
    allowanceByType: {}
  };

  items.forEach((closing) => {
    result.totalSales += closing.totalSales;
    result.cashDifference += closing.cashDifference;
    closing.expenses.forEach((expense) => {
      const amount = Number(expense.amount || 0);
      result.totalExpenses += amount;
      result.expenseByCategory[expense.category] = (result.expenseByCategory[expense.category] || 0) + amount;
    });
    closing.allowances.forEach((allowance) => {
      const amount = Number(allowance.amount || 0);
      result.totalAllowances += amount;
      result.allowanceByType[allowance.type] = (result.allowanceByType[allowance.type] || 0) + amount;
    });
    result.castHours += sumWorkHours(closing.castWork);
    result.staffHours += sumWorkHours(closing.staffWork);
  });
  result.grossProfit = result.totalSales - result.totalExpenses;
  return result;
}

function sumWorkHours(work) {
  if (Array.isArray(work)) return work.reduce((sum, row) => sum + Number(row.hours || 0), 0);
  if (!work || typeof work !== "object") return 0;
  return ["manager", "bartender", "kitchen", "cleaning", "other"]
    .reduce((sum, key) => sum + Number(work[key] || 0), 0);
}

function renderSummaryCards(summary) {
  const cards = [
    ["総売上", `${yen.format(summary.totalSales)}円`],
    ["総経費", `${yen.format(summary.totalExpenses)}円`],
    ["総手当", `${yen.format(summary.totalAllowances)}円`],
    ["推定粗利", `${yen.format(summary.grossProfit)}円`],
    ["延べキャスト勤務時間", `${summary.castHours.toFixed(1)}時間`],
    ["延べスタッフ勤務時間", `${summary.staffHours.toFixed(1)}時間`]
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
  closings.forEach((closing) => {
    const expenseTotal = closing.expenses.reduce((sum, row) => sum + Number(row.amount || 0), 0);
    const allowanceTotal = closing.allowances.reduce((sum, row) => sum + Number(row.amount || 0), 0);
    const values = [
      closing.businessDate,
      statusLabel(closing.status),
      `${yen.format(closing.totalSales)}円`,
      `${yen.format(closing.cashSales)}円`,
      `${yen.format(closing.cardSales)}円`,
      closing.totalCustomers,
      closing.groupCount,
      `${yen.format(closing.customerUnitPrice)}円`,
      closing.honShimei,
      closing.jonai,
      `${yen.format(expenseTotal)}円`,
      `${yen.format(allowanceTotal)}円`,
      `${yen.format(closing.cashDifference)}円`
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
  const submitted = new Set(closings.map((closing) => closing.businessDate));
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
    state.textContent = future ? "未来日" : submitted.has(date) ? "締め済" : "未締め";
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
  if (!closings.length) {
    showMessage("errorMessage", "CSV出力対象のPOS締めデータがありません。");
    return;
  }
  const rows = [
    ["日付", "状態", "総売上", "現金", "カード", "総客数", "組数", "客単価", "本指名", "場内指名", "経費合計", "手当合計", "現金差異"]
  ];
  closings.forEach((closing) => {
    rows.push([
      closing.businessDate,
      statusLabel(closing.status),
      closing.totalSales,
      closing.cashSales,
      closing.cardSales,
      closing.totalCustomers,
      closing.groupCount,
      closing.customerUnitPrice,
      closing.honShimei,
      closing.jonai,
      closing.expenses.reduce((sum, row) => sum + Number(row.amount || 0), 0),
      closing.allowances.reduce((sum, row) => sum + Number(row.amount || 0), 0),
      closing.cashDifference
    ]);
  });
  const csv = rows.map((row) => row.map(escapeCsv).join(",")).join("\r\n");
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const end = document.getElementById("endDate").value.replaceAll("-", "");
  a.href = url;
  a.download = `keiri_pos_closing_${end}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function escapeCsv(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function statusLabel(status) {
  return {
    draft: "下書き",
    submitted: "締め済",
    approved: "承認済",
    rejected: "差戻し"
  }[status] || status || "締め済";
}
