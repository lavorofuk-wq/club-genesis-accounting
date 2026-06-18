import {
  db,
  collection,
  getDocs,
  closingsCollectionName,
  firebaseProjectId
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
    const snap = await getDocs(collection(db, closingsCollectionName));
    closings = snap.docs
      .map((docSnap) => normalizeClosing({ id: docSnap.id, ...docSnap.data() }))
      .filter((closing) => closing.status === "approved")
      .filter((closing) => closing.businessDate >= start && closing.businessDate <= end)
      .sort((a, b) => a.businessDate.localeCompare(b.businessDate));
    renderSyncInfo(snap.size, closings.length);
    renderAll(start, end);
  } catch (error) {
    showMessage("errorMessage", `経理確定データの取得に失敗しました。${error.message}`);
    renderSyncInfo(0, 0);
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
    status: raw.status || "approved",
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
    castSales: raw.castSales || [],
    castWork: raw.castWork || raw.castHours || [],
    staffWork: raw.staffWork || raw.staffHours || [],
    cashReconciliation,
    cashDifference: Number(cashReconciliation.difference ?? raw.cashDifference ?? 0),
    closedBy: raw.source?.closedBy || raw.closedBy || "",
    closedAt: raw.source?.closedAt || raw.closedAt || raw.submittedAt || null,
    reviewedBy: raw.reviewedEmail || raw.source?.reviewedEmail || raw.reviewedBy || "",
    reviewedAt: raw.reviewedAt || raw.source?.reviewedAt || null,
    source: raw.source || {}
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

function renderSyncInfo(totalCount, visibleCount) {
  const el = document.getElementById("syncInfo");
  if (!el) return;
  el.textContent = `接続先: Firebase projectId=${firebaseProjectId} / collection=${closingsCollectionName} / host=${location.hostname} / 全件=${totalCount}件 / 経理確定=${visibleCount}件`;
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
  return ["manager", "bartender", "kitchen", "cleaning", "other"].reduce((sum, key) => sum + Number(work[key] || 0), 0);
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
    const detailTd = document.createElement("td");
    const detailButton = document.createElement("button");
    detailButton.type = "button";
    detailButton.className = "secondary-button";
    detailButton.textContent = "詳細";
    detailButton.addEventListener("click", () => openClosingDetail(closing.id));
    detailTd.appendChild(detailButton);
    tr.appendChild(detailTd);
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
    state.textContent = future ? "未来日" : submitted.has(date) ? "経理確定" : "未確定";
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
    showMessage("errorMessage", "CSV出力対象の経理確定データがありません。");
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
  a.download = `gms_export_${end}.csv`;
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
    submitted: "店舗確認待ち",
    approved: "経理確定",
    rejected: "差戻し"
  }[status] || status || "経理確定";
}

function openClosingDetail(closingId) {
  const closing = closings.find((item) => item.id === closingId);
  if (!closing) return;
  document.getElementById("closingDetailTitle").textContent = `${closing.businessDate} 締め詳細`;
  const body = document.getElementById("closingDetailBody");
  body.replaceChildren();

  body.appendChild(createSummaryGrid(closing));
  body.appendChild(createTableBlock("キャスト別売上", ["キャスト", "本指名", "場内延長", "ドリンク", "合計"], closing.castSales, (row) => [
    row.castName || "",
    yenCell(row.honShimeiSales),
    yenCell(row.jonaiExtensionSales),
    yenCell(row.drinkSales),
    yenCell(row.totalAttributedSales)
  ]));
  body.appendChild(createTableBlock("スタッフ勤務", ["スタッフ", "雇用形態", "業務区分", "給与形態", "給与金額", "開始", "終了", "時間"], normalizeWorkRows(closing.staffWork, true), (row) => [
    row.name,
    row.employmentType,
    row.jobType,
    row.payType,
    row.payAmount,
    row.startTime || "",
    row.endTime || "",
    formatWorkHours(row.hours)
  ]));
  body.appendChild(createTableBlock("キャスト勤務", ["キャスト", "開始", "終了", "休憩", "時間"], normalizeWorkRows(closing.castWork, false), (row) => [
    row.name,
    row.startTime || "",
    row.endTime || "",
    `${Number(row.breakMinutes || 0)}分`,
    formatWorkHours(row.hours)
  ]));
  body.appendChild(createTableBlock("経費", ["カテゴリ", "金額", "メモ"], closing.expenses, (row) => [
    row.category || "",
    yenCell(row.amount),
    row.note || ""
  ]));
  body.appendChild(createTableBlock("手当", ["種類", "金額", "対象者"], closing.allowances, (row) => [
    row.type || "",
    yenCell(row.amount),
    row.recipientName || row.recipient || ""
  ]));

  document.getElementById("closingDetailModal").showModal();
}

function createSummaryGrid(closing) {
  const grid = document.createElement("div");
  grid.className = "detail-grid";
  grid.appendChild(createDetailBlock("売上", [
    ["状態", statusLabel(closing.status)],
    ["総売上", yenCell(closing.totalSales)],
    ["現金", yenCell(closing.cashSales)],
    ["カード", yenCell(closing.cardSales)],
    ["客単価", yenCell(closing.customerUnitPrice)]
  ]));
  grid.appendChild(createDetailBlock("客数・指名", [
    ["組数", `${closing.groupCount}組`],
    ["総客数", `${closing.totalCustomers}名`],
    ["本指名", `${closing.honShimei}件`],
    ["場内指名", `${closing.jonai}件`]
  ]));
  grid.appendChild(createDetailBlock("現金照合", [
    ["想定現金", yenCell(closing.cashReconciliation.expectedCash)],
    ["実在高", yenCell(closing.cashReconciliation.actualCash)],
    ["差異", yenCell(closing.cashDifference)],
    ["メモ", closing.cashReconciliation.note || ""]
  ]));
  grid.appendChild(createDetailBlock("確認情報", [
    ["締め担当", closing.closedBy || ""],
    ["POS Ver", closing.source.posVersion || ""],
    ["店舗確認者", closing.reviewedBy || ""],
    ["店舗確認日時", formatTimestamp(closing.reviewedAt)]
  ]));
  return grid;
}

function createDetailBlock(title, rows) {
  const block = document.createElement("section");
  block.className = "detail-block";
  const heading = document.createElement("h3");
  heading.textContent = title;
  block.appendChild(heading);
  rows.forEach(([label, value]) => {
    const row = document.createElement("div");
    row.className = "detail-row";
    const labelEl = document.createElement("span");
    labelEl.textContent = label;
    const valueEl = document.createElement("strong");
    valueEl.textContent = value ?? "";
    row.append(labelEl, valueEl);
    block.appendChild(row);
  });
  return block;
}

function createTableBlock(title, headers, rows, mapRow) {
  const block = document.createElement("section");
  block.className = "detail-block";
  const heading = document.createElement("h3");
  heading.textContent = title;
  block.appendChild(heading);
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "text-sm text-slate-500";
    empty.textContent = "データなし";
    block.appendChild(empty);
    return block;
  }
  const table = document.createElement("table");
  table.className = "detail-mini-table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  headers.forEach((header) => {
    const th = document.createElement("th");
    th.textContent = header;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  const tbody = document.createElement("tbody");
  rows.forEach((item) => {
    const tr = document.createElement("tr");
    mapRow(item).forEach((value) => {
      const td = document.createElement("td");
      td.textContent = value ?? "";
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.append(thead, tbody);
  block.appendChild(table);
  return block;
}

function normalizeWorkRows(work, staff) {
  if (Array.isArray(work)) {
    return work.map((row) => ({
      name: staff ? row.staffName || row.name || "" : row.castName || row.name || "",
      role: staff ? roleLabel(row.role) : "",
      employmentType: staff ? employmentTypeLabel(row.employmentType) : "",
      jobType: staff ? jobTypeLabel(row.jobType, row.role) : "",
      payType: staff ? payTypeLabel(row.payType) : "",
      payAmount: staff && row.payAmount ? yenCell(row.payAmount) : "",
      startTime: row.startTime || "",
      endTime: row.endTime || "",
      breakMinutes: row.breakMinutes || 0,
      hours: row.hours || 0
    }));
  }
  if (!staff || !work || typeof work !== "object") return [];
  const labels = {
    manager: "店長/マネージャー",
    bartender: "バーテンダー",
    kitchen: "厨房",
    cleaning: "清掃",
    other: "その他"
  };
  return Object.entries(labels)
    .map(([role, label]) => ({ name: label, role: label, hours: Number(work[role] || 0) }))
    .filter((row) => row.hours > 0);
}

function employmentTypeLabel(type) {
  return {
    employee: "社員",
    partTime: "アルバイト"
  }[type] || "";
}

function jobTypeLabel(type, legacyRole) {
  return {
    kitchen: "キッチンスタッフ",
    hall: "ホールスタッフ",
    driver: "ドライバースタッフ"
  }[type] || roleLabel(legacyRole);
}

function payTypeLabel(type) {
  return {
    daily: "日給",
    hourly: "時給"
  }[type] || "";
}

function formatWorkHours(value) {
  const hours = Number(value || 0);
  return `${hours.toFixed(2).replace(/\.00$/, "").replace(/0$/, "")}時間`;
}

function roleLabel(role) {
  return {
    manager: "店長/マネージャー",
    bartender: "バーテンダー",
    kitchen: "厨房",
    cleaning: "清掃",
    other: "その他"
  }[role] || role || "";
}

function yenCell(value) {
  return `${yen.format(Number(value || 0))}円`;
}

function formatTimestamp(value) {
  if (!value) return "";
  if (typeof value.toDate === "function") return value.toDate().toLocaleString("ja-JP");
  if (typeof value === "string") return value;
  if (typeof value.seconds === "number") return new Date(value.seconds * 1000).toLocaleString("ja-JP");
  return "";
}
