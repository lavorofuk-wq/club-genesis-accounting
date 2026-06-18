import {
  db,
  collection,
  doc,
  getDocs,
  setDoc,
  serverTimestamp,
  closingsCollectionName,
  castCollectionName,
  staffCollectionName,
  firebaseProjectId
} from "./firebase-config.js";
import { requireRole, logout, showMessage, hideMessage } from "./auth.js";

const yen = new Intl.NumberFormat("ja-JP");
const expenseCategories = ["家賃", "水光熱", "酒代", "広告", "人件費", "雑費"];
const allowanceTypes = ["夜手当", "役職手当", "交通費", "その他"];
let currentUser = null;
let allClosings = [];
let receivedClosings = [];
let finalizedClosings = [];
let visibleFinalized = [];
let castMembers = [];
let staffMembers = [];
let editingClosing = null;

const byId = (id) => document.getElementById(id);

byId("logoutButton").addEventListener("click", logout);
byId("reloadReceivedButton").addEventListener("click", loadData);
byId("loadButton").addEventListener("click", renderFinalizedView);
byId("exportCsvButton").addEventListener("click", exportCsv);
byId("closeReceivedEditButton").addEventListener("click", () => byId("receivedEditModal").close());
byId("closeClosingDetailButton").addEventListener("click", () => byId("closingDetailModal").close());
byId("addEditExpenseButton").addEventListener("click", () => addExpenseRow());
byId("addEditAllowanceButton").addEventListener("click", () => addAllowanceRow());
byId("saveReceivedDraftButton").addEventListener("click", () => saveReceived(false));
byId("finalizeReceivedButton").addEventListener("click", () => saveReceived(true));

document.querySelectorAll("[data-accounting-view]").forEach((button) => {
  button.addEventListener("click", () => showWorkspace(button.dataset.accountingView));
});
document.querySelectorAll("[data-accounting-home]").forEach((button) => {
  button.addEventListener("click", showHome);
});

requireRole("accounting", async (user) => {
  currentUser = user;
  byId("dashboard").classList.remove("hidden");
  const { start, end } = currentMonthRange();
  byId("startDate").value = start;
  byId("endDate").value = end;
  showHome();
  await loadData();
});

function showHome() {
  byId("accountingHome").classList.remove("hidden");
  document.querySelectorAll("[data-accounting-workspace]").forEach((workspace) => workspace.classList.add("hidden"));
}

function showWorkspace(name) {
  byId("accountingHome").classList.add("hidden");
  document.querySelectorAll("[data-accounting-workspace]").forEach((workspace) => {
    workspace.classList.toggle("hidden", workspace.dataset.accountingWorkspace !== name);
  });
  if (name === "finalized") renderFinalizedView();
  if (name === "castRewards") renderCastRewards();
  if (name === "staffPayroll") renderStaffPayroll();
}

async function loadData() {
  hideMessage("errorMessage");
  hideMessage("successMessage");
  try {
    const [closingSnap, castSnap, staffSnap] = await Promise.all([
      getDocs(collection(db, closingsCollectionName)),
      getDocs(collection(db, castCollectionName)),
      getDocs(collection(db, staffCollectionName))
    ]);
    allClosings = closingSnap.docs.map((item) => normalizeClosing(item.id, item.data()));
    receivedClosings = allClosings
      .filter((item) => item.status !== "finalized")
      .sort((a, b) => b.businessDate.localeCompare(a.businessDate));
    finalizedClosings = allClosings
      .filter((item) => item.status === "finalized")
      .sort((a, b) => a.businessDate.localeCompare(b.businessDate));
    castMembers = castSnap.docs.map((item) => ({ id: item.id, ...item.data() }));
    staffMembers = staffSnap.docs.map((item) => ({ id: item.id, ...item.data() }));
    renderReceivedList();
    renderFinalizedView();
  } catch (error) {
    showMessage("errorMessage", `データの取得に失敗しました。${error.message}`);
  }
}

function normalizeClosing(id, raw) {
  const sales = raw.sales || {};
  const customers = raw.customers || {};
  const nominations = raw.nominations || raw.shimeiInfo || raw["指名情報"] || {};
  const totalSales = toNumber(sales.totalSales ?? raw.totalSales);
  const totalCustomers = toNumber(customers.totalCustomers ?? raw.totalCustomers);
  return {
    id,
    raw,
    businessDate: String(raw.businessDate || raw.date || id),
    status: raw.status || "submitted",
    totalSales,
    cashSales: toNumber(sales.cashSales ?? raw.cashSales),
    cardSales: toNumber(sales.cardSales ?? raw.cardSales),
    groupCount: toNumber(customers.groupCount ?? raw.groupCount),
    totalCustomers,
    customerUnitPrice: toNumber(customers.customerUnitPrice ?? raw.customerUnitPrice ?? (totalCustomers ? Math.floor(totalSales / totalCustomers) : 0)),
    honShimei: toNumber(nominations.honShimeiCount ?? nominations.honShimei),
    jonai: toNumber(nominations.jonaiCount ?? nominations.jonai),
    expenses: normalizeMoneyRows(raw.expenses, "category"),
    allowances: normalizeMoneyRows(raw.allowances, "type"),
    transactions: normalizeTransactions(raw.transactions),
    castSales: Array.isArray(raw.castSales) ? raw.castSales : [],
    castWork: normalizeWorkRows(raw.castWork || raw.castHours, false),
    staffWork: normalizeWorkRows(raw.staffWork || raw.staffHours, true),
    cashReconciliation: raw.cashReconciliation || {},
    cashDifference: toNumber(raw.cashReconciliation?.difference ?? raw.cashDifference),
    source: raw.source || {},
    reviewedBy: raw.reviewedEmail || raw.reviewedBy || raw.source?.reviewedEmail || "",
    finalizedBy: raw.finalizedEmail || raw.finalizedBy || ""
  };
}

function normalizeMoneyRows(rows, labelKey) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => ({
    ...row,
    [labelKey]: String(row[labelKey] || ""),
    amount: toNumber(row.amount)
  }));
}

function renderReceivedList() {
  const root = byId("receivedDataList");
  root.replaceChildren();
  if (!receivedClosings.length) {
    root.appendChild(emptyMessage("現在、経理確認待ちの受信データはありません。"));
    return;
  }
  receivedClosings.forEach((closing) => {
    const item = document.createElement("article");
    item.className = "pending-item";
    const main = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = closing.businessDate;
    const detail = document.createElement("p");
    detail.className = "mt-1 text-sm text-slate-500";
    detail.textContent = `総売上 ${yenCell(closing.totalSales)} / 会計 ${closing.transactions.length}件 / ${statusLabel(closing.status)}`;
    main.append(title, detail);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "primary-button";
    button.textContent = "確認・編集";
    button.addEventListener("click", () => openReceivedEdit(closing.id));
    item.append(main, button);
    root.appendChild(item);
  });
}

function openReceivedEdit(id) {
  editingClosing = receivedClosings.find((item) => item.id === id);
  if (!editingClosing) return;
  byId("receivedEditTitle").textContent = `${editingClosing.businessDate} 受信データ確認`;
  setInput("editTotalSales", editingClosing.totalSales);
  setInput("editCashSales", editingClosing.cashSales);
  setInput("editCardSales", editingClosing.cardSales);
  setInput("editGroupCount", editingClosing.groupCount);
  setInput("editTotalCustomers", editingClosing.totalCustomers);
  setInput("editHonShimei", editingClosing.honShimei);
  setInput("editJonai", editingClosing.jonai);
  byId("editExpenseRows").replaceChildren();
  byId("editAllowanceRows").replaceChildren();
  editingClosing.expenses.forEach(addExpenseRow);
  editingClosing.allowances.forEach(addAllowanceRow);
  renderReceivedTransactions(editingClosing);
  hideMessage("receivedEditError");
  byId("receivedEditModal").showModal();
}

function addExpenseRow(value = {}) {
  byId("editExpenseRows").appendChild(createMoneyRow("expense", expenseCategories, {
    label: value.category || "雑費",
    amount: value.amount || 0,
    detail: value.note || ""
  }));
}

function addAllowanceRow(value = {}) {
  byId("editAllowanceRows").appendChild(createMoneyRow("allowance", allowanceTypes, {
    label: value.type || "その他",
    amount: value.amount || 0,
    detail: value.recipientName || value.recipient || ""
  }));
}

function createMoneyRow(kind, options, value) {
  const row = document.createElement("div");
  row.className = `dynamic-row ${kind}-row`;
  const select = document.createElement("select");
  select.className = "form-input edit-label";
  options.forEach((option) => {
    const el = document.createElement("option");
    el.value = option;
    el.textContent = option;
    el.selected = option === value.label;
    select.appendChild(el);
  });
  const amount = document.createElement("input");
  amount.type = "number";
  amount.min = "0";
  amount.step = "1";
  amount.className = "form-input edit-amount";
  amount.value = value.amount;
  const detail = document.createElement("input");
  detail.type = "text";
  detail.maxLength = "100";
  detail.className = "form-input edit-detail";
  detail.placeholder = kind === "expense" ? "メモ" : "支給対象者";
  detail.value = value.detail;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "danger-button";
  remove.textContent = "削除";
  remove.addEventListener("click", () => row.remove());
  row.append(select, amount, detail, remove);
  return row;
}

function renderReceivedTransactions(closing) {
  const root = byId("receivedTransactionSummary");
  root.replaceChildren();
  const heading = document.createElement("h3");
  heading.className = "mb-2 font-bold";
  heading.textContent = "POS会計データ・会計明細（参照専用）";
  root.appendChild(heading);
  root.appendChild(createTableBlock(
    `${closing.transactions.length}件 / 合計 ${yenCell(closing.transactions.reduce((sum, row) => sum + row.total, 0))}`,
    ["テーブル", "人数", "支払", "小計", "値引", "合計"],
    closing.transactions,
    (row) => [row.tableLabel, row.guests, paymentLabel(row), yenCell(row.subtotal), yenCell(row.discount), yenCell(row.total)]
  ));
}

async function saveReceived(finalize) {
  if (!editingClosing) return;
  hideMessage("receivedEditError");
  const saveButton = byId("saveReceivedDraftButton");
  const finalizeButton = byId("finalizeReceivedButton");
  saveButton.disabled = true;
  finalizeButton.disabled = true;
  try {
    const values = collectReceivedValues();
    const status = finalize ? "finalized" : "submitted";
    const update = {
      status,
      sales: {
        ...(editingClosing.raw.sales || {}),
        totalSales: values.totalSales,
        cashSales: values.cashSales,
        cardSales: values.cardSales
      },
      customers: {
        ...(editingClosing.raw.customers || {}),
        groupCount: values.groupCount,
        totalCustomers: values.totalCustomers,
        customerUnitPrice: values.totalCustomers ? Math.floor(values.totalSales / values.totalCustomers) : 0
      },
      nominations: {
        ...(editingClosing.raw.nominations || {}),
        honShimeiCount: values.honShimei,
        jonaiCount: values.jonai
      },
      expenses: values.expenses,
      allowances: values.allowances,
      accountingEditedBy: currentUser.uid,
      accountingEditedEmail: currentUser.email || "",
      accountingEditedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    };
    if (finalize) {
      update.finalizedBy = currentUser.uid;
      update.finalizedEmail = currentUser.email || "";
      update.finalizedAt = serverTimestamp();
    }
    await setDoc(doc(db, closingsCollectionName, editingClosing.id), update, { merge: true });
    byId("receivedEditModal").close();
    editingClosing = null;
    await loadData();
    showMessage("successMessage", finalize ? "経理データを確定しました。" : "経理編集内容を保存しました。");
  } catch (error) {
    showMessage("receivedEditError", error.message);
  } finally {
    saveButton.disabled = false;
    finalizeButton.disabled = false;
  }
}

function collectReceivedValues() {
  const fields = [
    ["totalSales", "editTotalSales", "総売上"],
    ["cashSales", "editCashSales", "現金売上"],
    ["cardSales", "editCardSales", "カード売上"],
    ["groupCount", "editGroupCount", "来店組数"],
    ["totalCustomers", "editTotalCustomers", "総客数"],
    ["honShimei", "editHonShimei", "本指名"],
    ["jonai", "editJonai", "場内指名"]
  ];
  const result = {};
  fields.forEach(([key, id, label]) => {
    const value = Number(byId(id).value);
    if (!Number.isInteger(value) || value < 0) throw new Error(`${label}は0以上の整数で入力してください。`);
    result[key] = value;
  });
  result.expenses = collectMoneyRows("editExpenseRows", "category");
  result.allowances = collectMoneyRows("editAllowanceRows", "type");
  return result;
}

function collectMoneyRows(rootId, labelKey) {
  return [...byId(rootId).querySelectorAll(".dynamic-row")].map((row) => {
    const label = row.querySelector(".edit-label").value;
    const amount = Number(row.querySelector(".edit-amount").value);
    const detail = row.querySelector(".edit-detail").value.trim();
    if (!Number.isInteger(amount) || amount < 0) throw new Error("経費・手当の金額は0以上の整数で入力してください。");
    return labelKey === "category"
      ? { category: label, amount, note: detail }
      : { type: label, amount, recipient: detail, recipientName: detail };
  });
}

function renderFinalizedView() {
  const start = byId("startDate").value;
  const end = byId("endDate").value;
  if (!start || !end || start > end) {
    showMessage("errorMessage", "正しい日付範囲を指定してください。");
    return;
  }
  hideMessage("errorMessage");
  visibleFinalized = finalizedClosings.filter((item) => item.businessDate >= start && item.businessDate <= end);
  byId("syncInfo").textContent = `Firebase ${firebaseProjectId} / ${closingsCollectionName} / 確定 ${visibleFinalized.length}件`;
  const summary = summarize(visibleFinalized);
  renderSummaryCards(summary);
  renderFinalizedTable();
  renderCastSales();
  renderWorkSummary("castWorkSummary", aggregateWork(visibleFinalized, "castWork"));
  renderWorkSummary("staffWorkSummary", aggregateWork(visibleFinalized, "staffWork"));
  renderBreakdown("expenseBreakdown", summary.expenseByCategory);
}

function summarize(items) {
  const result = {
    totalSales: 0,
    totalExpenses: 0,
    totalAllowances: 0,
    grossProfit: 0,
    castHours: 0,
    staffHours: 0,
    expenseByCategory: {}
  };
  items.forEach((closing) => {
    result.totalSales += closing.totalSales;
    result.castHours += closing.castWork.reduce((sum, row) => sum + row.hours, 0);
    result.staffHours += closing.staffWork.reduce((sum, row) => sum + row.hours, 0);
    closing.expenses.forEach((row) => {
      result.totalExpenses += row.amount;
      result.expenseByCategory[row.category || "未分類"] = (result.expenseByCategory[row.category || "未分類"] || 0) + row.amount;
    });
    closing.allowances.forEach((row) => {
      result.totalAllowances += row.amount;
    });
  });
  result.grossProfit = result.totalSales - result.totalExpenses;
  return result;
}

function renderSummaryCards(summary) {
  const cards = [
    ["総売上", yenCell(summary.totalSales)],
    ["総経費", yenCell(summary.totalExpenses)],
    ["総手当", yenCell(summary.totalAllowances)],
    ["推定収支", yenCell(summary.grossProfit)],
    ["キャスト勤務", hoursCell(summary.castHours)],
    ["スタッフ勤務", hoursCell(summary.staffHours)]
  ];
  const root = byId("summaryCards");
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

function renderFinalizedTable() {
  const body = byId("finalizedTableBody");
  body.replaceChildren();
  if (!visibleFinalized.length) {
    appendEmptyTableRow(body, 8, "指定期間の確定データはありません。");
    return;
  }
  visibleFinalized.forEach((closing) => {
    const expense = sumAmounts(closing.expenses);
    const allowance = sumAmounts(closing.allowances);
    const values = [
      closing.businessDate,
      yenCell(closing.totalSales),
      yenCell(closing.cashSales),
      yenCell(closing.cardSales),
      yenCell(expense),
      yenCell(allowance),
      yenCell(closing.totalSales - expense)
    ];
    const tr = document.createElement("tr");
    values.forEach((value) => appendCell(tr, value));
    const action = document.createElement("td");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary-button";
    button.textContent = "詳細";
    button.addEventListener("click", () => openClosingDetail(closing.id));
    action.appendChild(button);
    tr.appendChild(action);
    body.appendChild(tr);
  });
}

function aggregateCastSales(items) {
  const map = new Map();
  items.forEach((closing) => {
    closing.castSales.forEach((row) => {
      const name = String(row.castName || row.name || "名称未設定");
      const key = String(row.castId || row.posCastId || name);
      const current = map.get(key) || { key, name, honShimeiSales: 0, jonaiExtensionSales: 0, drinkSales: 0, totalAttributedSales: 0 };
      current.honShimeiSales += toNumber(row.honShimeiSales);
      current.jonaiExtensionSales += toNumber(row.jonaiExtensionSales);
      current.drinkSales += toNumber(row.drinkSales);
      current.totalAttributedSales += toNumber(row.totalAttributedSales);
      map.set(key, current);
    });
  });
  return [...map.values()].sort((a, b) => b.totalAttributedSales - a.totalAttributedSales);
}

function renderCastSales() {
  const body = byId("castSalesTableBody");
  body.replaceChildren();
  const rows = aggregateCastSales(visibleFinalized);
  if (!rows.length) {
    appendEmptyTableRow(body, 5, "キャスト売上データはありません。");
    return;
  }
  rows.forEach((row) => {
    const tr = document.createElement("tr");
    [row.name, yenCell(row.honShimeiSales), yenCell(row.jonaiExtensionSales), yenCell(row.drinkSales), yenCell(row.totalAttributedSales)]
      .forEach((value) => appendCell(tr, value));
    body.appendChild(tr);
  });
}

function aggregateWork(items, key) {
  const map = new Map();
  items.forEach((closing) => {
    closing[key].forEach((row) => {
      const id = String(row.id || row.name);
      const current = map.get(id) || { id, name: row.name, hours: 0, days: new Set(), payType: row.payType, payAmount: row.payAmount };
      current.hours += row.hours;
      current.days.add(closing.businessDate);
      current.payType ||= row.payType;
      current.payAmount ||= row.payAmount;
      map.set(id, current);
    });
  });
  return [...map.values()].sort((a, b) => b.hours - a.hours);
}

function renderWorkSummary(id, rows) {
  const root = byId(id);
  root.replaceChildren();
  if (!rows.length) {
    root.appendChild(emptyMessage("勤務データはありません。"));
    return;
  }
  rows.forEach((row) => {
    const item = document.createElement("div");
    item.className = "breakdown-item";
    const name = document.createElement("span");
    name.textContent = row.name;
    const value = document.createElement("strong");
    value.textContent = `${row.days.size}日 / ${hoursCell(row.hours)}`;
    item.append(name, value);
    root.appendChild(item);
  });
}

function renderBreakdown(id, data) {
  const root = byId(id);
  root.replaceChildren();
  const rows = Object.entries(data).sort((a, b) => b[1] - a[1]);
  if (!rows.length) {
    root.appendChild(emptyMessage("経費データはありません。"));
    return;
  }
  rows.forEach(([label, amount]) => {
    const item = document.createElement("div");
    item.className = "breakdown-item";
    const name = document.createElement("span");
    name.textContent = label;
    const value = document.createElement("strong");
    value.textContent = yenCell(amount);
    item.append(name, value);
    root.appendChild(item);
  });
}

function renderCastRewards() {
  updateVisibleFinalized();
  const salesRows = aggregateCastSales(visibleFinalized);
  const workRows = aggregateWork(visibleFinalized, "castWork");
  const workMap = new Map(workRows.map((row) => [row.id, row]));
  const root = byId("castRewardList");
  root.replaceChildren();
  if (!salesRows.length && !workRows.length) {
    root.appendChild(emptyMessage("指定期間のキャスト報酬計算対象はありません。"));
    return;
  }
  const keys = new Set([...salesRows.map((row) => row.key), ...workRows.map((row) => row.id)]);
  [...keys].forEach((key) => {
    const sales = salesRows.find((row) => row.key === key) || {};
    const work = workMap.get(key) || {};
    const member = findMember(castMembers, key, sales.name || work.name);
    root.appendChild(createPayrollCard(
      sales.name || work.name || member?.name || "名称未設定",
      rewardSystemLabel(member?.rewardSystem),
      [
        ["売上計算基礎", yenCell(sales.totalAttributedSales)],
        ["勤務日数", `${work.days?.size || 0}日`],
        ["勤務時間", hoursCell(work.hours || 0)],
        ["報酬額", "報酬設定待ち"]
      ]
    ));
  });
}

function renderStaffPayroll() {
  updateVisibleFinalized();
  const rows = aggregateWork(visibleFinalized, "staffWork");
  const root = byId("staffPayrollList");
  root.replaceChildren();
  if (!rows.length) {
    root.appendChild(emptyMessage("指定期間の従業員給与計算対象はありません。"));
    return;
  }
  rows.forEach((row) => {
    const member = findMember(staffMembers, row.id, row.name);
    const payType = row.payType || member?.payType || "";
    const payAmount = toNumber(row.payAmount || member?.payAmount);
    const basePay = payType === "hourly" ? Math.round(payAmount * row.hours) : payAmount * row.days.size;
    const allowance = visibleFinalized.reduce((total, closing) => total + closing.allowances
      .filter((item) => (item.recipientName || item.recipient || "") === row.name)
      .reduce((sum, item) => sum + item.amount, 0), 0);
    root.appendChild(createPayrollCard(
      row.name,
      `${payTypeLabel(payType)} ${yenCell(payAmount)}`,
      [
        ["勤務日数", `${row.days.size}日`],
        ["勤務時間", hoursCell(row.hours)],
        ["基本給与", yenCell(basePay)],
        ["手当", yenCell(allowance)],
        ["支給見込", yenCell(basePay + allowance)]
      ]
    ));
  });
}

function createPayrollCard(title, subtitle, metrics) {
  const card = document.createElement("article");
  card.className = "payroll-item";
  const header = document.createElement("div");
  const name = document.createElement("h3");
  name.textContent = title;
  const detail = document.createElement("p");
  detail.className = "mt-1 text-sm text-slate-500";
  detail.textContent = subtitle || "設定情報なし";
  header.append(name, detail);
  const grid = document.createElement("div");
  grid.className = "payroll-metrics";
  metrics.forEach(([label, value]) => {
    const box = document.createElement("div");
    const key = document.createElement("span");
    key.textContent = label;
    const amount = document.createElement("strong");
    amount.textContent = value;
    box.append(key, amount);
    grid.appendChild(box);
  });
  card.append(header, grid);
  return card;
}

function openClosingDetail(id) {
  const closing = finalizedClosings.find((item) => item.id === id);
  if (!closing) return;
  byId("closingDetailTitle").textContent = `${closing.businessDate} 確定データ詳細`;
  const body = byId("closingDetailBody");
  body.replaceChildren();
  body.appendChild(createTableBlock("会計データ", ["テーブル", "人数", "支払", "小計", "値引", "合計"], closing.transactions, (row) => [
    row.tableLabel, row.guests, paymentLabel(row), yenCell(row.subtotal), yenCell(row.discount), yenCell(row.total)
  ]));
  closing.transactions.forEach((transaction) => {
    body.appendChild(createTableBlock(`会計明細 ${transaction.tableLabel || ""}`, ["明細", "単価", "数量", "金額"], transaction.items, (item) => [
      item.label, yenCell(item.price), item.quantity, yenCell(item.price * item.quantity)
    ]));
  });
  body.appendChild(createTableBlock("経費", ["カテゴリ", "金額", "メモ"], closing.expenses, (row) => [row.category, yenCell(row.amount), row.note || ""]));
  body.appendChild(createTableBlock("手当", ["種類", "金額", "対象者"], closing.allowances, (row) => [row.type, yenCell(row.amount), row.recipientName || row.recipient || ""]));
  byId("closingDetailModal").showModal();
}

function createTableBlock(title, headers, rows, mapper) {
  const block = document.createElement("section");
  block.className = "detail-block overflow-x-auto";
  const heading = document.createElement("h3");
  heading.textContent = title;
  block.appendChild(heading);
  if (!rows.length) {
    block.appendChild(emptyMessage("データはありません。"));
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
  rows.forEach((row) => {
    const tr = document.createElement("tr");
    mapper(row).forEach((value) => appendCell(tr, value));
    tbody.appendChild(tr);
  });
  table.append(thead, tbody);
  block.appendChild(table);
  return block;
}

function exportCsv() {
  if (!visibleFinalized.length) {
    showMessage("errorMessage", "CSV出力対象の確定データがありません。");
    return;
  }
  const rows = [["日付", "総売上", "現金", "カード", "総客数", "組数", "客単価", "本指名", "場内指名", "経費", "手当", "推定収支"]];
  visibleFinalized.forEach((closing) => {
    const expense = sumAmounts(closing.expenses);
    const allowance = sumAmounts(closing.allowances);
    rows.push([
      closing.businessDate, closing.totalSales, closing.cashSales, closing.cardSales,
      closing.totalCustomers, closing.groupCount, closing.customerUnitPrice,
      closing.honShimei, closing.jonai, expense, allowance, closing.totalSales - expense
    ]);
  });
  const csv = rows.map((row) => row.map(escapeCsv).join(",")).join("\r\n");
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `gms_export_${todayString().replaceAll("-", "")}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function normalizeTransactions(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => ({
    transactionId: String(row.transactionId || row.id || ""),
    tableLabel: String(row.tableLabel || ""),
    guests: toNumber(row.guests),
    payMethod: row.payMethod === "card" ? "card" : "cash",
    splits: Array.isArray(row.splits) ? row.splits : [],
    subtotal: toNumber(row.subtotal),
    discount: toNumber(row.discount),
    total: toNumber(row.total),
    items: Array.isArray(row.items) ? row.items.map((item) => ({
      label: String(item.label || ""),
      price: toNumber(item.price),
      quantity: toNumber(item.quantity ?? item.qty)
    })) : []
  }));
}

function normalizeWorkRows(work, staff) {
  if (!Array.isArray(work)) return [];
  return work.map((row) => ({
    id: String(row.staffId || row.castId || row.posCastId || row.id || row.staffName || row.castName || row.name || ""),
    name: String(staff ? row.staffName || row.name || "" : row.castName || row.name || ""),
    hours: toNumber(row.hours),
    payType: String(row.payType || ""),
    payAmount: toNumber(row.payAmount)
  })).filter((row) => row.name);
}

function findMember(members, id, name) {
  return members.find((member) =>
    String(member.id) === String(id)
    || String(member.posCastId || "") === String(id)
    || (name && member.name === name)
  );
}

function updateVisibleFinalized() {
  const start = byId("startDate").value;
  const end = byId("endDate").value;
  visibleFinalized = finalizedClosings.filter((item) => item.businessDate >= start && item.businessDate <= end);
}

function paymentLabel(row) {
  if (row.splits.length) {
    return row.splits.map((split) => `${split.method === "card" ? "カード" : "現金"} ${yenCell(split.amount)}`).join(" / ");
  }
  return row.payMethod === "card" ? "カード" : "現金";
}

function statusLabel(status) {
  return {
    draft: "下書き",
    submitted: "経理確認待ち",
    approved: "旧形式・経理確認待ち",
    rejected: "差し戻し",
    finalized: "経理確定"
  }[status] || status || "経理確認待ち";
}

function rewardSystemLabel(value) {
  return {
    slideHourly: "スライド時給",
    guaranteedHourly: "保証時給"
  }[value] || "報酬システム未設定";
}

function payTypeLabel(value) {
  return { daily: "日給", hourly: "時給" }[value] || "給与形態未設定";
}

function currentMonthRange() {
  const now = new Date();
  const start = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return { start, end: formatDate(last) };
}

function todayString() {
  return formatDate(new Date());
}

function formatDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function setInput(id, value) {
  byId(id).value = value;
}

function toNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function sumAmounts(rows) {
  return rows.reduce((sum, row) => sum + toNumber(row.amount), 0);
}

function yenCell(value) {
  return `${yen.format(Math.round(toNumber(value)))}円`;
}

function hoursCell(value) {
  return `${toNumber(value).toFixed(2).replace(/\.?0+$/, "")}時間`;
}

function emptyMessage(text) {
  const p = document.createElement("p");
  p.className = "text-sm text-slate-500";
  p.textContent = text;
  return p;
}

function appendCell(row, value) {
  const cell = document.createElement("td");
  cell.textContent = value ?? "";
  row.appendChild(cell);
}

function appendEmptyTableRow(body, colspan, text) {
  const row = document.createElement("tr");
  const cell = document.createElement("td");
  cell.colSpan = colspan;
  cell.className = "text-center text-slate-500";
  cell.textContent = text;
  row.appendChild(cell);
  body.appendChild(row);
}

function escapeCsv(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
