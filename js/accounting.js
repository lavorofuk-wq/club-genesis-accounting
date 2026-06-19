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
  introducerCollectionName,
  fixedExpenseCollectionName,
  trialCastCollectionName,
  firebaseProjectId
} from "./firebase-config.js";
import { requireRole, logout, showMessage, hideMessage } from "./auth.js";
import { deleteDoc } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js";

const yen = new Intl.NumberFormat("ja-JP");
const expenseCategories = ["酒代", "広告宣伝①", "広告宣伝②", "消耗品/備品", "交際費", "交通費", "その他", "美容室"];
const allowanceTypes = ["美容室", "遠方手当", "送迎手当", "その他"];
const fixedExpenseFields = [
  ["rent", "賃料"],
  ["karaoke", "カラオケ"],
  ["towel", "おしぼり"],
  ["leasekin", "リースキン"],
  ["landline", "固定電話"],
  ["saibuGas", "西部ガス"],
  ["usen", "USEN"]
];
let currentUser = null;
let allClosings = [];
let receivedClosings = [];
let finalizedClosings = [];
let visibleFinalized = [];
let castMembers = [];
let staffMembers = [];
let introducers = [];
let fixedExpenseRecords = [];
let trialCastRecords = [];
let fixedExpenseLoadError = null;
let editingClosing = null;
let deletingClosing = null;

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
byId("cancelDeleteReceivedButton").addEventListener("click", closeDeleteReceivedModal);
byId("deleteReceivedInput").addEventListener("input", updateDeleteConfirmation);
byId("confirmDeleteReceivedButton").addEventListener("click", deleteReceived);
byId("loadFixedExpenseButton").addEventListener("click", renderFixedExpenseForm);
byId("saveFixedExpenseButton").addEventListener("click", saveFixedExpenses);
byId("fixedExpenseMonth").addEventListener("change", renderFixedExpenseForm);
document.querySelectorAll(".fixed-expense-input").forEach((input) => {
  input.addEventListener("input", updateFixedExpenseTotal);
});

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
  byId("fixedExpenseMonth").value = start.slice(0, 7);
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
  if (name === "trialCastRewards") renderTrialCastRewards();
  if (name === "staffPayroll") renderStaffPayroll();
  if (name === "introducerFees") renderIntroducerFees();
  if (name === "fixedExpenses") renderFixedExpenseForm();
}

async function loadData() {
  hideMessage("errorMessage");
  hideMessage("successMessage");
  try {
    const [closingSnap, castSnap, staffSnap, introducerSnap, fixedExpenseSnap, trialCastSnap] = await Promise.all([
      getDocs(collection(db, closingsCollectionName)),
      getDocs(collection(db, castCollectionName)),
      getDocs(collection(db, staffCollectionName)),
      getDocs(collection(db, introducerCollectionName)),
      getDocs(collection(db, fixedExpenseCollectionName)).catch((error) => ({ docs: [], error })),
      getDocs(collection(db, trialCastCollectionName)).catch(() => ({ docs: [] }))
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
    introducers = introducerSnap.docs.map((item) => ({ id: item.id, ...item.data() }));
    fixedExpenseLoadError = fixedExpenseSnap.error || null;
    fixedExpenseRecords = fixedExpenseSnap.docs.map((item) => normalizeFixedExpense(item.id, item.data()));
    trialCastRecords = trialCastSnap.docs.map((item) => ({ id: item.id, ...item.data() }));
    renderReceivedList();
    renderFinalizedView();
    renderFixedExpenseForm();
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
    castWork: normalizeWorkRows(raw.castWork || raw.castHours, false).filter((row) => !row.isTrial),
    trialWork: normalizeTrialWork(raw.trialWork, raw.castWork || raw.castHours, raw.trialCasts),
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

function normalizeTrialWork(trialWork, castWork, trialCasts) {
  if (Array.isArray(trialWork) && trialWork.length) {
    return trialWork.map((row) => ({
      id: String(row.castId || row.id || row.castName || ""),
      name: String(row.castName || row.name || ""),
      startTime: String(row.startTime || ""),
      endTime: String(row.endTime || ""),
      hours: toNumber(row.hours),
      introducerName: String(row.introducerName || ""),
      hourlyRate: toNumber(row.hourlyRate),
      isTrial: true
    }));
  }
  const trialIds = new Set((trialCasts || []).map((cast) => String(cast.castId || "")));
  return normalizeWorkRows(castWork, false).filter((row) => row.isTrial || trialIds.has(String(row.id)));
}

function normalizeFixedExpense(id, raw = {}) {
  const normalized = { id, month: String(raw.month || id) };
  fixedExpenseFields.forEach(([key]) => {
    normalized[key] = toNumber(raw[key]);
  });
  return normalized;
}

function fixedExpenseForMonth(month) {
  return fixedExpenseRecords.find((item) => item.month === month) || normalizeFixedExpense(month);
}

function alcoholExpenseForMonth(month, closings = finalizedClosings) {
  return closings
    .filter((closing) => closing.businessDate.startsWith(`${month}-`))
    .reduce((total, closing) => total + closing.expenses
      .filter((expense) => expense.category === "酒代")
      .reduce((sum, expense) => sum + expense.amount, 0), 0);
}

function renderFixedExpenseForm() {
  const month = byId("fixedExpenseMonth").value;
  if (!month) return;
  const record = fixedExpenseForMonth(month);
  document.querySelectorAll(".fixed-expense-input").forEach((input) => {
    input.value = String(record[input.dataset.fixedExpenseKey] || 0);
    markFixedExpenseInvalid(input, false);
  });
  byId("fixedExpenseAlcohol").value = String(alcoholExpenseForMonth(month));
  byId("fixedExpenseStatus").textContent = fixedExpenseLoadError
    ? `固定費データを取得できません。Firestoreルールの fixedExpenses 権限を反映してください。酒代の自動集計のみ表示しています。`
    : fixedExpenseRecords.some((item) => item.month === month)
      ? `${month.replace("-", "年")}月の保存済み固定費を表示しています。酒代は確定データから再集計しています。`
      : `${month.replace("-", "年")}月は未保存です。酒代は確定データから自動集計しています。`;
  updateFixedExpenseTotal();
}

function collectFixedExpenseValues() {
  const values = {};
  document.querySelectorAll(".fixed-expense-input").forEach((input) => {
    const amount = Number(input.value);
    const valid = Number.isInteger(amount) && amount >= 0;
    markFixedExpenseInvalid(input, !valid);
    if (!valid) throw new Error("固定費は0以上の整数で入力してください。");
    values[input.dataset.fixedExpenseKey] = amount;
  });
  return values;
}

function markFixedExpenseInvalid(input, invalid) {
  input.classList.toggle("invalid", invalid);
  input.setAttribute("aria-invalid", String(invalid));
}

function updateFixedExpenseTotal() {
  let total = toNumber(byId("fixedExpenseAlcohol").value);
  document.querySelectorAll(".fixed-expense-input").forEach((input) => {
    const amount = Number(input.value);
    const valid = Number.isInteger(amount) && amount >= 0;
    markFixedExpenseInvalid(input, !valid);
    if (valid) total += amount;
  });
  byId("fixedExpenseTotal").textContent = yenCell(total);
}

async function saveFixedExpenses() {
  const button = byId("saveFixedExpenseButton");
  const month = byId("fixedExpenseMonth").value;
  if (!/^\d{4}-\d{2}$/.test(month)) {
    showMessage("errorMessage", "固定費の対象月を選択してください。");
    return;
  }
  hideMessage("errorMessage");
  hideMessage("successMessage");
  try {
    const values = collectFixedExpenseValues();
    button.disabled = true;
    await setDoc(doc(db, fixedExpenseCollectionName, month), {
      month,
      ...values,
      updatedBy: currentUser.email || currentUser.uid,
      updatedAt: serverTimestamp()
    }, { merge: true });
    const normalized = normalizeFixedExpense(month, { month, ...values });
    fixedExpenseRecords = [
      ...fixedExpenseRecords.filter((item) => item.month !== month),
      normalized
    ].sort((a, b) => a.month.localeCompare(b.month));
    fixedExpenseLoadError = null;
    renderFixedExpenseForm();
    renderFinalizedView();
    showMessage("successMessage", `${month.replace("-", "年")}月の固定費を保存しました。`);
  } catch (error) {
    showMessage("errorMessage", `固定費を保存できませんでした。${error.message}`);
  } finally {
    button.disabled = false;
  }
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
    const actions = document.createElement("div");
    actions.className = "flex flex-wrap gap-2";
    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.className = "primary-button";
    editButton.textContent = "確認・編集";
    editButton.addEventListener("click", () => openReceivedEdit(closing.id));
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "danger-button";
    deleteButton.textContent = "削除";
    deleteButton.addEventListener("click", () => openDeleteReceivedModal(closing.id));
    actions.append(editButton, deleteButton);
    item.append(main, actions);
    root.appendChild(item);
  });
}

function openDeleteReceivedModal(id) {
  deletingClosing = receivedClosings.find((item) => item.id === id);
  if (!deletingClosing) return;
  byId("deleteReceivedTarget").textContent = `${deletingClosing.businessDate} の受信データを完全に削除します。`;
  byId("deleteReceivedInput").value = "";
  byId("confirmDeleteReceivedButton").disabled = true;
  hideMessage("deleteReceivedError");
  byId("deleteReceivedModal").showModal();
  byId("deleteReceivedInput").focus();
}

function closeDeleteReceivedModal() {
  byId("deleteReceivedModal").close();
  byId("deleteReceivedInput").value = "";
  byId("confirmDeleteReceivedButton").disabled = true;
  hideMessage("deleteReceivedError");
  deletingClosing = null;
}

function updateDeleteConfirmation() {
  byId("confirmDeleteReceivedButton").disabled = byId("deleteReceivedInput").value !== "削除";
}

async function deleteReceived() {
  if (!deletingClosing || byId("deleteReceivedInput").value !== "削除") return;
  const target = deletingClosing;
  const button = byId("confirmDeleteReceivedButton");
  button.disabled = true;
  try {
    await deleteDoc(doc(db, closingsCollectionName, target.id));
    closeDeleteReceivedModal();
    await loadData();
    showMessage("successMessage", `${target.businessDate} の受信データを削除しました。`);
  } catch (error) {
    showMessage("deleteReceivedError", `受信データを削除できませんでした。${error.message}`);
    updateDeleteConfirmation();
  }
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
    label: value.category || "酒代",
    amount: value.amount || 0,
    detail: value.note || ""
  }));
}

function addAllowanceRow(value = {}) {
  byId("editAllowanceRows").appendChild(createMoneyRow("allowance", allowanceTypes, {
    label: value.type || "その他",
    amount: value.amount || 0,
    detail: value.recipientName || value.recipient || "",
    recipientId: value.recipientId || "",
    note: value.note || ""
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
  if (value.label && !options.includes(value.label)) {
    const legacy = document.createElement("option");
    legacy.value = value.label;
    legacy.textContent = `${value.label}（旧データ）`;
    legacy.selected = true;
    select.appendChild(legacy);
  }
  const amount = document.createElement("input");
  amount.type = "number";
  amount.min = "0";
  amount.step = "1";
  amount.className = "form-input edit-amount";
  amount.value = value.amount;
  const detail = kind === "expense" ? document.createElement("input") : document.createElement("select");
  detail.className = kind === "expense" ? "form-input edit-detail" : "form-select edit-detail";
  const note = document.createElement("input");
  note.type = "text";
  note.maxLength = "120";
  note.className = "form-input edit-note";
  note.placeholder = "その他の備考（必須）";
  note.value = kind === "expense" ? value.detail : value.note;
  if (kind === "expense") {
    detail.type = "text";
    detail.maxLength = "120";
    detail.placeholder = "その他の備考（必須）";
    detail.value = value.detail;
  }
  const refreshRecipient = () => {
    if (kind !== "allowance") return;
    const members = select.value === "美容室"
      ? castMembers.filter((member) => member.status === "active")
      : staffMembers.filter((member) => member.status !== "departed");
    detail.replaceChildren(makeSelectOption("", "支給対象者を選択"));
    members.forEach((member) => {
      const option = makeSelectOption(member.id, member.name);
      option.dataset.name = member.name;
      detail.appendChild(option);
    });
    const matched = members.find((member) =>
      member.id === value.recipientId
      || member.name === value.detail
      || (select.value === "美容室" && String(member.posCastId || "") === String(value.recipientId || ""))
    );
    if (matched) {
      detail.value = matched.id;
    } else if (value.detail) {
      const legacy = makeSelectOption(value.recipientId || `legacy:${value.detail}`, `${value.detail}（旧データ）`);
      legacy.dataset.name = value.detail;
      detail.appendChild(legacy);
      detail.value = legacy.value;
    }
  };
  const updateNote = () => {
    const required = select.value === "その他";
    const target = kind === "expense" ? detail : note;
    target.classList.toggle("hidden", !required);
    if (!required) target.classList.remove("invalid");
  };
  select.addEventListener("change", () => {
    if (kind === "allowance") {
      value.recipientId = "";
      value.detail = "";
      refreshRecipient();
    }
    updateNote();
  });
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "danger-button";
  remove.textContent = "削除";
  remove.addEventListener("click", () => row.remove());
  row.append(select, amount, detail);
  if (kind === "allowance") row.appendChild(note);
  row.appendChild(remove);
  refreshRecipient();
  updateNote();
  return row;
}

function makeSelectOption(value, label) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  return option;
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
  root.appendChild(createTableBlock(
    "体入キャスト情報",
    ["体入キャスト", "開始", "終了", "勤務時間", "紹介者", "当日時給"],
    closing.trialWork,
    (row) => [row.name, row.startTime, row.endTime, hoursCell(row.hours), row.introducerName, yenCell(row.hourlyRate)]
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
    if (finalize) {
      await Promise.all(editingClosing.trialWork.map((row) => setDoc(
        doc(db, trialCastCollectionName, trialCastRecordId(editingClosing.businessDate, row.id)),
        {
          businessDate: editingClosing.businessDate,
          castId: row.id,
          castName: row.name,
          startTime: row.startTime,
          endTime: row.endTime,
          hours: row.hours,
          introducerName: row.introducerName,
          hourlyRate: row.hourlyRate,
          sourceClosingId: editingClosing.id,
          updatedBy: currentUser.uid,
          updatedAt: serverTimestamp()
        },
        { merge: true }
      )));
    }
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
  editingClosing.trialWork.forEach((row) => {
    if (!row.name || !row.introducerName) throw new Error("体入キャスト名と紹介者を確認してください。");
    if (row.hours <= 0 || !Number.isInteger(row.hourlyRate) || row.hourlyRate <= 0) {
      throw new Error(`${row.name}の勤務時間または当日時給を確認してください。`);
    }
  });
  return result;
}

function collectMoneyRows(rootId, labelKey) {
  return [...byId(rootId).querySelectorAll(".dynamic-row")].map((row) => {
    const label = row.querySelector(".edit-label").value;
    const amount = Number(row.querySelector(".edit-amount").value);
    const detailControl = row.querySelector(".edit-detail");
    const detail = detailControl.tagName === "SELECT"
      ? detailControl.selectedOptions[0]?.dataset.name || ""
      : detailControl.value.trim();
    const recipientId = detailControl.tagName === "SELECT" ? detailControl.value : "";
    const note = row.querySelector(".edit-note")?.value.trim() || (labelKey === "category" ? detail : "");
    if (!Number.isInteger(amount) || amount < 0) throw new Error("経費・手当の金額は0以上の整数で入力してください。");
    if (label === "その他" && !note) throw new Error("「その他」の備考を入力してください。");
    if (labelKey === "type" && !detail) throw new Error("手当の支給対象者を選択してください。");
    if (labelKey === "type" && !String(recipientId).startsWith("legacy:")) {
      const isCast = castMembers.some((member) => member.id === recipientId && member.status === "active");
      const isStaff = staffMembers.some((member) => member.id === recipientId && member.status !== "departed");
      if (label === "美容室" && !isCast) throw new Error("美容室手当の対象者は在籍キャストから選択してください。");
      if (label !== "美容室" && !isStaff) throw new Error(`${label}の対象者は在籍スタッフから選択してください。`);
    }
    return labelKey === "category"
      ? { category: label, amount, note: detail }
      : { type: label, amount, recipientId, recipient: detail, recipientName: detail, note };
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
  renderWorkSummary("trialCastWorkSummary", aggregateWork(visibleFinalized, "trialWork"));
  renderBreakdown("expenseBreakdown", summary.expenseByCategory);
  renderBreakdown("calculatedExpenseBreakdown", summary.calculatedExpenseBreakdown);
}

function summarize(items) {
  const start = byId("startDate").value;
  const end = byId("endDate").value;
  const result = {
    totalSales: 0,
    totalExpenses: 0,
    fixedExpenses: 0,
    castRewards: 0,
    staffPayroll: 0,
    trialCastRewards: 0,
    introducerExpenses: 0,
    totalOutflow: 0,
    unresolvedPayments: 0,
    grossProfit: 0,
    castHours: 0,
    staffHours: 0,
    expenseByCategory: {},
    calculatedExpenseBreakdown: {}
  };
  items.forEach((closing) => {
    result.totalSales += closing.totalSales;
    result.castHours += closing.castWork.reduce((sum, row) => sum + row.hours, 0);
    result.staffHours += closing.staffWork.reduce((sum, row) => sum + row.hours, 0);
    closing.expenses.forEach((row) => {
      result.totalExpenses += row.amount;
      result.expenseByCategory[row.category || "未分類"] = (result.expenseByCategory[row.category || "未分類"] || 0) + row.amount;
    });
  });
  monthsInRange(start, end).forEach((month) => {
    const fixed = fixedExpenseForMonth(month);
    fixedExpenseFields.forEach(([key, label]) => {
      const amount = toNumber(fixed[key]);
      result.fixedExpenses += amount;
      result.expenseByCategory[label] = (result.expenseByCategory[label] || 0) + amount;
    });
  });
  const monthGroups = groupClosingsByMonth(items);
  const rewardRows = [...monthGroups.values()].flatMap((closings) => calculateCastRewardRows(closings));
  rewardRows.forEach((row) => {
    if (row.payable === null) result.unresolvedPayments += 1;
    else result.castRewards += row.payable;
  });
  const staffRows = calculateStaffPayrollRows(items);
  result.staffPayroll = staffRows.reduce((sum, row) => sum + row.payable, 0);
  result.trialCastRewards = calculateTrialCastRewardRows(items).reduce((sum, row) => sum + row.payable, 0);
  const introducerRows = rewardRows
    .filter((row) => row.member?.introducerId)
    .map((row) => calculateIntroducerFee(row));
  introducerRows.forEach((row) => {
    if (row.totalExpense === null) result.unresolvedPayments += 1;
    else result.introducerExpenses += row.totalExpense;
  });
  result.totalExpenses += result.fixedExpenses;
  result.totalOutflow = result.totalExpenses + result.castRewards + result.trialCastRewards + result.staffPayroll + result.introducerExpenses;
  result.grossProfit = result.totalSales - result.totalOutflow;
  result.calculatedExpenseBreakdown = {
    "キャスト報酬": result.castRewards,
    "体入キャスト報酬": result.trialCastRewards,
    "スタッフ給与": result.staffPayroll,
    "紹介料・顧問料": result.introducerExpenses
  };
  return result;
}

function renderSummaryCards(summary) {
  const cards = [
    ["総売上", yenCell(summary.totalSales)],
    ["経費合計", yenCell(summary.totalExpenses)],
    ["キャスト報酬", summary.unresolvedPayments ? `${yenCell(summary.castRewards)}ほか未計算` : yenCell(summary.castRewards)],
    ["体入キャスト報酬", yenCell(summary.trialCastRewards)],
    ["スタッフ給与", yenCell(summary.staffPayroll)],
    ["紹介料・顧問料", yenCell(summary.introducerExpenses)],
    ["総支出", summary.unresolvedPayments ? `${yenCell(summary.totalOutflow)}ほか未計算` : yenCell(summary.totalOutflow)],
    ["最終収支", summary.unresolvedPayments ? "未計算項目あり" : yenCell(summary.grossProfit)],
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

function banaiExtensionSalesPhases(items) {
  const phases = new Map();
  let currentCastIds = [];
  items.forEach((item) => {
    if (item.isBanaiExtension) {
      currentCastIds = [...new Set([
        ...item.banaiExtCastIds,
        item.banaiExtCastId,
        item.castId
      ].filter(Boolean).map(String))];
    }
    if (!currentCastIds.length || item.isDiscount) return;
    const sortedIds = [...currentCastIds].sort();
    const key = sortedIds.join("|");
    if (!phases.has(key)) phases.set(key, { castIds: sortedIds, subtotal: 0 });
    phases.get(key).subtotal += item.price * item.quantity;
  });
  return [...phases.values()];
}

function aggregateCastSales(items) {
  const map = new Map();
  const ensure = (id, name = "") => {
    const key = String(id || name || "unknown");
    if (!map.has(key)) {
      map.set(key, {
        key,
        name: name || castNameForId(key) || "名称未設定",
        honShimeiSales: 0,
        jonaiExtensionSales: 0,
        totalAttributedSales: 0
      });
    }
    return map.get(key);
  };
  items.forEach((closing) => {
    if (!closing.transactions.length) {
      closing.castSales.forEach((row) => {
        const current = ensure(row.castId || row.posCastId, row.castName || row.name);
        current.honShimeiSales += toNumber(row.honShimeiSales);
        current.jonaiExtensionSales += toNumber(row.jonaiExtensionSales);
        current.totalAttributedSales += toNumber(row.honShimeiSales) + toNumber(row.jonaiExtensionSales);
      });
      return;
    }
    closing.transactions.forEach((transaction) => {
      const honCasts = [...new Map(
        transaction.items
          .filter((item) => item.isHonShimei && item.castId)
          .map((item) => [item.castId, item])
      ).values()];
      if (honCasts.length) {
        const share = Math.floor(transaction.subtotal / honCasts.length);
        honCasts.forEach((item) => {
          const current = ensure(item.castId);
          current.honShimeiSales += share;
          current.totalAttributedSales += share;
        });
        return;
      }
      banaiExtensionSalesPhases(transaction.items)
        .forEach((phase) => {
          const share = Math.floor(phase.subtotal / phase.castIds.length);
          phase.castIds.forEach((castId) => {
            const current = ensure(castId);
            current.jonaiExtensionSales += share;
            current.totalAttributedSales += share;
          });
        });
    });
  });
  return [...map.values()].sort((a, b) => b.totalAttributedSales - a.totalAttributedSales);
}

function renderCastSales() {
  const body = byId("castSalesTableBody");
  body.replaceChildren();
  const rows = aggregateCastSales(visibleFinalized);
  if (!rows.length) {
    appendEmptyTableRow(body, 4, "キャスト売上データはありません。");
    return;
  }
  rows.forEach((row) => {
    const tr = document.createElement("tr");
    [row.name, yenCell(row.honShimeiSales), yenCell(row.jonaiExtensionSales), yenCell(row.totalAttributedSales)]
      .forEach((value) => appendCell(tr, value));
    body.appendChild(tr);
  });
}

function aggregateWork(items, key) {
  const map = new Map();
  items.forEach((closing) => {
    closing[key].forEach((row) => {
      const id = String(row.id || row.name);
      const current = map.get(id) || { id, name: row.name, hours: 0, days: new Set(), shifts: [], payType: row.payType, payAmount: row.payAmount };
      current.hours += row.hours;
      current.days.add(closing.businessDate);
      current.shifts.push({
        date: closing.businessDate,
        startTime: row.startTime,
        endTime: row.endTime,
        hours: row.hours
      });
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
    const timeSummary = row.shifts
      .filter((shift) => shift.startTime && shift.endTime)
      .map((shift) => `${shift.date.slice(5)} ${shift.startTime}-${shift.endTime}`)
      .join(" / ");
    name.textContent = timeSummary ? `${row.name} / ${timeSummary}` : row.name;
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
  const rewardRows = calculateCastRewardRows();
  const root = byId("castRewardList");
  root.replaceChildren();
  const month = byId("startDate").value.slice(0, 7);
  const period = document.createElement("div");
  period.className = "notice";
  period.textContent = `${month.replace("-", "年")}月の確定データで月間報酬を計算しています。`;
  root.appendChild(period);
  if (!rewardRows.length) {
    root.appendChild(emptyMessage("この月のキャスト報酬計算対象はありません。"));
    return;
  }
  rewardRows.forEach((row) => {
    root.appendChild(createPayrollCard(
      row.name,
      `${month} / ${rewardSystemLabel(row.member?.rewardSystem)}${row.calculationError ? `（${row.calculationError}）` : ""}`,
      [
        ["月間小計売上", yenCell(row.monthlySales)],
        ["適用時給", row.hourlyRate ? yenCell(row.hourlyRate) : "未設定"],
        ["月間勤務時間", hoursCell(row.hours)],
        ["時給分", row.hourlyBase === null ? "計算不可" : yenCell(row.hourlyBase)],
        ["本指名バック", `${row.backs.honCount}回 / ${yenCell(row.backs.hon)}`],
        ["場内指名バック", `${row.backs.banaiCount}回 / ${yenCell(row.backs.banai)}`],
        ["同伴バック", `${row.backs.dohanCount}回 / ${yenCell(row.backs.dohan)}`],
        ["VIP室料バック", yenCell(row.backs.vip)],
        ["ボトル類バック", yenCell(row.backs.keepBottle + row.backs.champagneWine)],
        ["ドリンクバック", yenCell(row.backs.drink)],
        ["バック合計", yenCell(row.backs.total)],
        ["時給＋バック", row.hourlyAndBack === null ? "計算不可" : yenCell(row.hourlyAndBack)],
        ["売上報酬", row.salesRewardRate ? `${Math.round(row.salesRewardRate * 100)}% / ${yenCell(row.salesReward)}` : "対象外"],
        ["支給額（高い方）", row.payable === null ? "計算不可" : yenCell(row.payable)]
      ]
    ));
  });
}

function renderTrialCastRewards() {
  updateVisibleFinalized();
  const root = byId("trialCastRewardList");
  root.replaceChildren();
  const rows = calculateTrialCastRewardRows(visibleFinalized);
  if (!rows.length) {
    root.appendChild(emptyMessage("指定期間の体入キャスト勤務データはありません。"));
    return;
  }
  rows.forEach((row) => {
    root.appendChild(createPayrollCard(
      row.name,
      `${row.businessDate} / 紹介者：${row.introducerName || "未入力"}`,
      [
        ["勤務時間", hoursCell(row.hours)],
        ["当日時給", yenCell(row.hourlyRate)],
        ["体入報酬", yenCell(row.payable)]
      ]
    ));
  });
  const saved = trialCastRecords
    .filter((row) => row.businessDate >= byId("startDate").value && row.businessDate <= byId("endDate").value)
    .length;
  const notice = document.createElement("div");
  notice.className = "notice";
  notice.textContent = `体入キャスト一覧 保存済み ${saved}件`;
  root.prepend(notice);
}

function calculateTrialCastRewardRows(closings) {
  return closings.flatMap((closing) => closing.trialWork.map((row) => ({
    ...row,
    businessDate: closing.businessDate,
    payable: Math.round(toNumber(row.hours) * toNumber(row.hourlyRate))
  }))).sort((a, b) => b.businessDate.localeCompare(a.businessDate) || a.name.localeCompare(b.name, "ja"));
}

function calculateCastRewardRows(rewardClosings = rewardMonthClosings()) {
  const salesRows = aggregateCastSales(rewardClosings);
  const workRows = aggregateWork(rewardClosings, "castWork");
  const backRows = aggregateCastBacks(rewardClosings);
  const salesMap = new Map(salesRows.map((row) => [row.key, row]));
  const workMap = new Map(workRows.map((row) => [row.id, row]));
  const backMap = new Map(backRows.map((row) => [row.id, row]));
  const trialIds = new Set(rewardClosings.flatMap((closing) => closing.trialWork.map((row) => String(row.id))));
  const keys = new Set([...salesMap.keys(), ...workMap.keys(), ...backMap.keys()]);
  return [...keys].map((key) => {
    const sales = salesMap.get(key) || {};
    const work = workMap.get(key) || {};
    const backs = backMap.get(key) || emptyCastBack(key, sales.name || work.name);
    const member = findMember(castMembers, key, sales.name || work.name);
    if (member?.status === "trial" || trialIds.has(String(key))) return null;
    const monthlySales = toNumber(sales.totalAttributedSales);
    const rewardSystem = member?.rewardSystem || "";
    const guaranteedHourlyRate = toNumber(member?.guaranteedHourlyRate);
    const hourlyRate = rewardSystem === "slideHourly"
      ? slideHourlyRate(monthlySales)
      : rewardSystem === "guaranteedHourly"
        ? guaranteedHourlyRate
        : 0;
    const calculationError = !rewardSystem
      ? "報酬システム未設定"
      : rewardSystem === "guaranteedHourly" && guaranteedHourlyRate <= 0
        ? "保証時給金額未設定"
        : "";
    const hourlyBase = calculationError ? null : Math.round(hourlyRate * toNumber(work.hours));
    const hourlyAndBack = hourlyBase === null ? null : hourlyBase + backs.total;
    const salesRewardRate = castSalesRewardRate(monthlySales);
    const salesReward = Math.floor(monthlySales * salesRewardRate);
    return {
      key,
      name: sales.name || work.name || backs.name || member?.name || "名称未設定",
      member,
      monthlySales,
      monthlyHonShimeiSales: toNumber(sales.honShimeiSales),
      hours: toNumber(work.hours),
      hourlyRate,
      hourlyBase,
      backs,
      hourlyAndBack,
      salesRewardRate,
      salesReward,
      payable: hourlyAndBack === null ? null : Math.max(hourlyAndBack, salesReward),
      calculationError
    };
  }).filter(Boolean).sort((a, b) => b.monthlySales - a.monthlySales);
}

function renderIntroducerFees() {
  const root = byId("introducerFeeList");
  const summaryRoot = byId("introducerFeeSummary");
  root.replaceChildren();
  summaryRoot.replaceChildren();
  const month = byId("startDate").value.slice(0, 7);
  const rows = calculateIntroducerFeeRows(calculateCastRewardRows());
  const totals = rows.reduce((result, row) => {
    if (row.introductionFee === null) {
      result.unresolved += 1;
    } else {
      result.introduction += row.introductionFee;
    }
    result.advisory += row.advisoryFee;
    if (row.totalExpense !== null) result.expense += row.totalExpense;
    return result;
  }, { introduction: 0, advisory: 0, expense: 0, unresolved: 0 });
  renderIntroducerSummary(summaryRoot, [
    ["紹介料合計", totals.unresolved ? `計算不可 ${totals.unresolved}名` : yenCell(totals.introduction)],
    ["顧問料合計", yenCell(totals.advisory)],
    ["紹介関連支出合計", totals.unresolved ? `計算不可 ${totals.unresolved}名` : yenCell(totals.expense)]
  ]);
  if (!rows.length) {
    root.appendChild(emptyMessage("紹介者が設定されたキャストはありません。"));
    return;
  }
  rows.forEach((row) => {
    root.appendChild(createPayrollCard(
      row.castName,
      `${month} / 紹介者：${row.introducerName} / ${introducerFeeSystemLabel(row.feeSystem)}`,
      [
        ["本指名小計売上", yenCell(row.honShimeiSales)],
        ["本指名売上10%", yenCell(row.sales10)],
        ["キャスト総支給額", row.payable === null ? "計算不可" : yenCell(row.payable)],
        ["総支給額10%", row.pay10 === null ? "計算不可" : yenCell(row.pay10)],
        ["採用した紹介料", row.introductionFee === null ? "計算不可" : yenCell(row.introductionFee)],
        ["顧問料", yenCell(row.advisoryFee)],
        ["紹介関連支出", row.totalExpense === null ? "計算不可" : yenCell(row.totalExpense)]
      ]
    ));
  });
}

function calculateIntroducerFeeRows(rewardRows) {
  return rewardRows
    .filter((row) => row.member?.introducerId)
    .map((row) => calculateIntroducerFee(row));
}

function calculateIntroducerFee(reward) {
  const member = reward.member || {};
  const introducer = introducers.find((item) => item.id === member.introducerId);
  const feeSystem = member.introducerFeeSystem || introducer?.feeSystem || "";
  const honShimeiSales = toNumber(reward.monthlyHonShimeiSales);
  const sales10 = Math.floor(honShimeiSales * 0.10);
  const pay10 = reward.payable === null ? null : Math.floor(reward.payable * 0.10);
  let introductionFee = null;
  if (feeSystem === "sales10") introductionFee = sales10;
  if (feeSystem === "pay10" && pay10 !== null) introductionFee = pay10;
  if (feeSystem === "higher10" && pay10 !== null) introductionFee = Math.max(sales10, pay10);
  const advisoryFee = member.advisoryFeeEnabled ? toNumber(member.advisoryFeeAmount) : 0;
  return {
    castName: reward.name,
    introducerName: member.introducerName || introducer?.name || "名称未設定",
    feeSystem,
    honShimeiSales,
    payable: reward.payable,
    sales10,
    pay10,
    introductionFee,
    advisoryFee,
    totalExpense: introductionFee === null ? null : introductionFee + advisoryFee
  };
}

function renderIntroducerSummary(root, cards) {
  cards.forEach(([label, value]) => {
    const card = document.createElement("article");
    card.className = "summary-card";
    const key = document.createElement("p");
    key.textContent = label;
    const amount = document.createElement("strong");
    amount.textContent = value;
    card.append(key, amount);
    root.appendChild(card);
  });
}

function introducerFeeSystemLabel(value) {
  return {
    sales10: "売上10%",
    pay10: "総支給額10%",
    higher10: "売上10%か総支給額10%の高い方"
  }[value] || "紹介料システム未設定";
}

function rewardMonthClosings() {
  const month = byId("startDate").value.slice(0, 7);
  return finalizedClosings.filter((item) => item.businessDate.startsWith(`${month}-`));
}

function slideHourlyRate(sales) {
  if (sales >= 1010000) return 6000;
  if (sales >= 910000) return 5500;
  if (sales >= 710000) return 5000;
  if (sales >= 610000) return 4500;
  if (sales >= 410000) return 4000;
  return 3000;
}

function castSalesRewardRate(sales) {
  if (sales >= 5010000) return 0.70;
  if (sales >= 3010000) return 0.60;
  if (sales >= 2010000) return 0.55;
  if (sales >= 1310000) return 0.50;
  return 0;
}

function aggregateCastBacks(items) {
  const map = new Map();
  const ensure = (id, name = "") => {
    const key = String(id || name || "unknown");
    if (!map.has(key)) map.set(key, emptyCastBack(key, name));
    const row = map.get(key);
    if (!row.name && name) row.name = name;
    return row;
  };
  const add = (id, name, key, amount, countKey = "") => {
    const row = ensure(id, name);
    row[key] += Math.floor(toNumber(amount));
    if (countKey) row[countKey] += 1;
  };

  items.forEach((closing) => {
    closing.transactions.forEach((transaction) => {
      const honItems = transaction.items.filter((item) => item.isHonShimei && item.castId);
      const honCasts = [...new Map(honItems.map((item) => [item.castId, item])).values()];
      honItems.forEach((item) => add(item.castId, castNameForId(item.castId), "hon", 1000, "honCount"));
      transaction.items
        .filter((item) => item.isBanaiShimei && item.castId)
        .forEach((item) => add(item.castId, castNameForId(item.castId), "banai", 500, "banaiCount"));

      const dohanItem = transaction.items.find((item) => item.category === "dohan" || item.label === "同伴料");
      if (dohanItem && honCasts.length) {
        const amount = dohanBackAmount(transaction.startTime);
        honCasts.forEach((item) => add(item.castId, castNameForId(item.castId), "dohan", amount, "dohanCount"));
      }

      const sharedBack = (categories, rate, key) => {
        if (!honCasts.length) return;
        const sourceTotal = transaction.items
          .filter((item) => categories.includes(item.category))
          .reduce((sum, item) => sum + item.price * item.quantity, 0);
        const share = Math.floor(Math.floor(sourceTotal * rate) / honCasts.length);
        honCasts.forEach((item) => add(item.castId, castNameForId(item.castId), key, share));
      };
      sharedBack(["vipRoom"], 0.10, "vip");
      sharedBack(["keepBottle"], 0.10, "keepBottle");
      sharedBack(["champagne", "wine"], 0.20, "champagneWine");

      transaction.items
        .filter((item) => item.category === "castDrink" && item.castId)
        .forEach((item) => {
          add(item.castId, castNameForId(item.castId), "drink", Math.floor(item.price * item.quantity * 0.10));
        });
    });
  });
  return [...map.values()].map((row) => ({
    ...row,
    total: row.hon + row.banai + row.dohan + row.vip + row.keepBottle + row.champagneWine + row.drink
  }));
}

function emptyCastBack(id, name = "") {
  return {
    id: String(id || name || "unknown"),
    name,
    hon: 0,
    honCount: 0,
    banai: 0,
    banaiCount: 0,
    dohan: 0,
    dohanCount: 0,
    vip: 0,
    keepBottle: 0,
    champagneWine: 0,
    drink: 0,
    total: 0
  };
}

function castNameForId(id) {
  return findMember(castMembers, id, "")?.name || "";
}

function dohanBackAmount(startTime) {
  const date = new Date(toNumber(startTime));
  if (Number.isNaN(date.getTime())) return 0;
  const minutes = date.getHours() * 60 + date.getMinutes();
  if (minutes <= 21 * 60) return 3000;
  if (minutes <= 21 * 60 + 30) return 2000;
  return 0;
}

function renderStaffPayroll() {
  updateVisibleFinalized();
  const rows = calculateStaffPayrollRows(visibleFinalized);
  const root = byId("staffPayrollList");
  root.replaceChildren();
  if (!rows.length) {
    root.appendChild(emptyMessage("指定期間の従業員給与計算対象はありません。"));
    return;
  }
  rows.forEach((row) => {
    root.appendChild(createPayrollCard(
      row.name,
      `${payTypeLabel(row.payType)} ${yenCell(row.payAmount)}`,
      [
        ["勤務日数", `${row.days.size}日`],
        ["勤務時間", hoursCell(row.hours)],
        ["基本給与", yenCell(row.basePay)],
        ["手当", yenCell(row.allowance)],
        ["支給見込", yenCell(row.payable)]
      ]
    ));
  });
}

function calculateStaffPayrollRows(closings) {
  return aggregateWork(closings, "staffWork").map((row) => {
    const member = findMember(staffMembers, row.id, row.name);
    const payType = row.payType || member?.payType || "";
    const payAmount = toNumber(row.payAmount || member?.payAmount);
    const basePay = payType === "hourly" ? Math.round(payAmount * row.hours) : payAmount * row.days.size;
    const allowance = closings.reduce((total, closing) => total + closing.allowances
      .filter((item) => (item.recipientName || item.recipient || "") === row.name)
      .reduce((sum, item) => sum + item.amount, 0), 0);
    return {
      ...row,
      payType,
      payAmount,
      basePay,
      allowance,
      payable: basePay + allowance
    };
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
  body.appendChild(createTableBlock("スタッフ勤務", ["スタッフ", "開始", "終了", "勤務時間"], closing.staffWork, (row) => [
    row.name, row.startTime || "", row.endTime || "", hoursCell(row.hours)
  ]));
  body.appendChild(createTableBlock("キャスト勤務", ["キャスト", "開始", "終了", "勤務時間"], closing.castWork, (row) => [
    row.name, row.startTime || "", row.endTime || "", hoursCell(row.hours)
  ]));
  body.appendChild(createTableBlock("体入キャスト勤務", ["体入キャスト", "開始", "終了", "勤務時間", "紹介者", "当日時給", "報酬"], closing.trialWork, (row) => [
    row.name, row.startTime || "", row.endTime || "", hoursCell(row.hours), row.introducerName || "", yenCell(row.hourlyRate), yenCell(row.hours * row.hourlyRate)
  ]));
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
  const summary = summarize(visibleFinalized);
  rows.push(
    [],
    ["期間集計"],
    ["総売上", summary.totalSales],
    ["経費合計", summary.totalExpenses],
    ["キャスト報酬", summary.castRewards],
    ["体入キャスト報酬", summary.trialCastRewards],
    ["スタッフ給与", summary.staffPayroll],
    ["紹介料・顧問料", summary.introducerExpenses],
    ["総支出", summary.totalOutflow],
    ["最終収支", summary.unresolvedPayments ? "未計算項目あり" : summary.grossProfit]
  );
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
    tableId: String(row.tableId || ""),
    tableLabel: String(row.tableLabel || ""),
    startTime: toNumber(row.startTime),
    endTime: toNumber(row.endTime),
    guests: toNumber(row.guests),
    payMethod: row.payMethod === "card" ? "card" : "cash",
    splits: Array.isArray(row.splits) ? row.splits : [],
    subtotal: toNumber(row.subtotal),
    discount: toNumber(row.discount),
    total: toNumber(row.total),
    items: Array.isArray(row.items) ? row.items.map((item) => ({
      itemId: String(item.itemId || item.id || ""),
      label: String(item.label || ""),
      category: transactionItemCategory(item),
      price: toNumber(item.price),
      quantity: toNumber(item.quantity ?? item.qty),
      castId: String(item.castId || ""),
      banaiExtCastIds: Array.isArray(item.banaiExtCastIds) ? item.banaiExtCastIds.map(String) : [],
      banaiExtCastId: String(item.banaiExtCastId || ""),
      isHonShimei: Boolean(item.isHonShimei),
      isBanaiShimei: Boolean(item.isBanaiShimei),
      isBanaiExtension: Boolean(item.isBanaiExtension),
      isVipCharge: Boolean(item.isVipCharge),
      isDiscount: Boolean(item.isDiscount)
    })) : []
  }));
}

function transactionItemCategory(item) {
  if (item.category) return String(item.category);
  const id = String(item.itemId || item.id || "");
  const label = String(item.label || "");
  if (item.isVipCharge) return "vipRoom";
  if (item.isHonShimei) return "honShimei";
  if (item.isBanaiShimei) return "banaiShimei";
  if (id === "dh" || label === "同伴料") return "dohan";
  if (id.startsWith("cd_") || /キャストDrink|キャストドリンク/i.test(label)) return "castDrink";
  if (/シャンパン/.test(label)) return "champagne";
  if (/ワイン/.test(label)) return "wine";
  if (/キープ|ボトル/.test(label)) return "keepBottle";
  return "";
}

function normalizeWorkRows(work, staff) {
  if (!Array.isArray(work)) return [];
  return work.map((row) => ({
    id: String(row.staffId || row.castId || row.posCastId || row.id || row.staffName || row.castName || row.name || ""),
    name: String(staff ? row.staffName || row.name || "" : row.castName || row.name || ""),
    startTime: String(row.startTime || ""),
    endTime: String(row.endTime || ""),
    hours: toNumber(row.hours),
    payType: String(row.payType || ""),
    payAmount: toNumber(row.payAmount),
    isTrial: row.isTrial === true || row.castType === "trial",
    introducerName: String(row.introducerName || ""),
    hourlyRate: toNumber(row.hourlyRate)
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

function monthsInRange(start, end) {
  if (!start || !end) return [];
  const months = [];
  const cursor = new Date(`${start.slice(0, 7)}-01T00:00:00`);
  const last = new Date(`${end.slice(0, 7)}-01T00:00:00`);
  while (cursor <= last) {
    months.push(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`);
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return months;
}

function groupClosingsByMonth(closings) {
  const groups = new Map();
  closings.forEach((closing) => {
    const month = closing.businessDate.slice(0, 7);
    if (!groups.has(month)) groups.set(month, []);
    groups.get(month).push(closing);
  });
  return groups;
}

function trialCastRecordId(date, castId) {
  return `${date}_${String(castId).replace(/[^a-zA-Z0-9_-]/g, "_")}`;
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
