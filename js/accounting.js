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
  employeeSalaryCollectionName,
  liquorCostCollectionName,
  firebaseProjectId
} from "./firebase-config.js";
import { requireRole, logout, showMessage, hideMessage } from "./auth.js";
import { initInternalMail } from "./internal-mail.js";
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
let employeeSalaryRecords = [];
let liquorCostRecords = [];
let fixedExpenseLoadError = null;
let liquorCostLoadError = null;
let editingClosing = null;
let deletingClosing = null;
let deletingFinalizedClosing = null;
let editingLiquorCostId = "";

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
byId("cancelDeleteFinalizedButton").addEventListener("click", closeDeleteFinalizedModals);
byId("deleteFinalizedInput").addEventListener("input", updateDeleteFinalizedConfirmation);
byId("openDeleteFinalizedStepTwoButton").addEventListener("click", openDeleteFinalizedStepTwoModal);
byId("backDeleteFinalizedButton").addEventListener("click", backDeleteFinalizedStepOne);
byId("confirmDeleteFinalizedButton").addEventListener("click", deleteFinalized);
byId("loadFixedExpenseButton").addEventListener("click", renderFixedExpenseForm);
byId("saveFixedExpenseButton").addEventListener("click", saveFixedExpenses);
byId("fixedExpenseMonth").addEventListener("change", renderFixedExpenseForm);
byId("exportCastRewardsXlsxButton").addEventListener("click", exportCastRewardsXlsx);
byId("exportStaffPayrollXlsxButton").addEventListener("click", exportStaffPayrollXlsx);
byId("exportIntroducerFeesXlsxButton").addEventListener("click", exportIntroducerFeesXlsx);
byId("loadStaffSalaryButton").addEventListener("click", renderStaffPayroll);
byId("staffSalaryMonth").addEventListener("change", renderStaffPayroll);
byId("saveEmployeeSalariesButton").addEventListener("click", saveEmployeeSalaries);
byId("castRewardSystemSearch").addEventListener("input", renderCastRewardSystem);
byId("castRewardSystemFilter").addEventListener("change", renderCastRewardSystem);
byId("castRewardStatusFilter").addEventListener("change", renderCastRewardSystem);
byId("saveLiquorCostButton").addEventListener("click", saveLiquorCost);
byId("cancelLiquorCostEditButton").addEventListener("click", resetLiquorCostForm);
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
  byId("staffSalaryMonth").value = start.slice(0, 7);
  showHome();
  initInternalMail({
    role: "accounting",
    currentUser: user,
    onError: (message) => showMessage("errorMessage", message),
    onSuccess: (message) => showMessage("successMessage", message, false)
  });
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
  if (name === "castRewardSystem") renderCastRewardSystem();
  if (name === "trialCastRewards") renderTrialCastRewards();
  if (name === "staffPayroll") renderStaffPayroll();
  if (name === "introducerFees") renderIntroducerFees();
  if (name === "fixedExpenses") renderFixedExpenseForm();
  if (name === "liquorCosts") renderLiquorCostSettings();
}

async function loadData() {
  hideMessage("errorMessage");
  hideMessage("successMessage");
  try {
    const [closingSnap, castSnap, staffSnap, introducerSnap, fixedExpenseSnap, trialCastSnap, employeeSalarySnap, liquorCostSnap] = await Promise.all([
      getDocs(collection(db, closingsCollectionName)),
      getDocs(collection(db, castCollectionName)),
      getDocs(collection(db, staffCollectionName)),
      getDocs(collection(db, introducerCollectionName)),
      getDocs(collection(db, fixedExpenseCollectionName)).catch((error) => ({ docs: [], error })),
      getDocs(collection(db, trialCastCollectionName)).catch(() => ({ docs: [] })),
      getDocs(collection(db, employeeSalaryCollectionName)).catch(() => ({ docs: [] })),
      getDocs(collection(db, liquorCostCollectionName)).catch((error) => ({ docs: [], error }))
    ]);
    allClosings = closingSnap.docs.map((item) => normalizeClosing(item.id, item.data()));
    receivedClosings = allClosings
      .filter((item) => item.status !== "finalized")
      .sort((a, b) => b.businessDate.localeCompare(a.businessDate) || b.id.localeCompare(a.id));
    finalizedClosings = allClosings
      .filter((item) => item.status === "finalized")
      .sort((a, b) => a.businessDate.localeCompare(b.businessDate));
    castMembers = castSnap.docs.map((item) => ({ id: item.id, ...item.data() }));
    staffMembers = staffSnap.docs.map((item) => ({ id: item.id, ...item.data() }));
    introducers = introducerSnap.docs.map((item) => ({ id: item.id, ...item.data() }));
    fixedExpenseLoadError = fixedExpenseSnap.error || null;
    fixedExpenseRecords = fixedExpenseSnap.docs.map((item) => normalizeFixedExpense(item.id, item.data()));
    trialCastRecords = trialCastSnap.docs.map((item) => ({ id: item.id, ...item.data() }));
    employeeSalaryRecords = employeeSalarySnap.docs.map((item) => ({ id: item.id, ...item.data() }));
    liquorCostLoadError = liquorCostSnap.error || null;
    liquorCostRecords = liquorCostSnap.docs.map((item) => normalizeLiquorCost(item.id, item.data()));
    renderReceivedList();
    renderFinalizedView();
    renderFixedExpenseForm();
    renderLiquorCostSettings();
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
      introducerId: String(row.introducerId || ""),
      introducerName: String(row.introducerName || ""),
      introducerFeeSystem: String(row.introducerFeeSystem || ""),
      advisoryFeeEnabled: row.advisoryFeeEnabled === true,
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

function normalizeLiquorCost(id, raw = {}) {
  return {
    id,
    brandName: String(raw.brandName || "").trim(),
    costAmount: toNumber(raw.costAmount)
  };
}

function normalizeBrandName(value) {
  return String(value || "").normalize("NFKC").trim().toLocaleLowerCase("ja");
}

function liquorCostForItem(item) {
  const brandKey = normalizeBrandName(item.label);
  return liquorCostRecords.find((record) => normalizeBrandName(record.brandName) === brandKey) || null;
}

function renderLiquorCostSettings() {
  const body = byId("liquorCostTableBody");
  body.replaceChildren();
  const rows = [...liquorCostRecords].sort((a, b) => a.brandName.localeCompare(b.brandName, "ja"));
  byId("liquorCostStatus").textContent = liquorCostLoadError
    ? "酒代原価を取得できません。Firestoreルールの liquorCosts 権限を反映してください。"
    : `登録済み ${rows.length}銘柄`;
  if (!rows.length) {
    appendEmptyTableRow(body, 3, "酒代原価はまだ登録されていません。");
    return;
  }
  rows.forEach((record) => {
    const tr = document.createElement("tr");
    appendCell(tr, record.brandName);
    appendCell(tr, yenCell(record.costAmount));
    const actionCell = document.createElement("td");
    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.className = "secondary-button";
    editButton.textContent = "編集";
    editButton.addEventListener("click", () => editLiquorCost(record.id));
    actionCell.appendChild(editButton);
    tr.appendChild(actionCell);
    body.appendChild(tr);
  });
}

function editLiquorCost(id) {
  const record = liquorCostRecords.find((item) => item.id === id);
  if (!record) return;
  editingLiquorCostId = id;
  byId("liquorCostBrandName").value = record.brandName;
  byId("liquorCostAmount").value = String(record.costAmount);
  byId("saveLiquorCostButton").textContent = "更新する";
  byId("cancelLiquorCostEditButton").classList.remove("hidden");
  byId("liquorCostBrandName").focus();
}

function resetLiquorCostForm() {
  editingLiquorCostId = "";
  byId("liquorCostBrandName").value = "";
  byId("liquorCostAmount").value = "";
  byId("saveLiquorCostButton").textContent = "登録する";
  byId("cancelLiquorCostEditButton").classList.add("hidden");
}

async function saveLiquorCost() {
  const brandName = byId("liquorCostBrandName").value.normalize("NFKC").trim();
  const costAmount = Number(byId("liquorCostAmount").value);
  if (!brandName || brandName.length > 80) {
    showMessage("errorMessage", "銘柄名を80文字以内で入力してください。");
    return;
  }
  if (!Number.isInteger(costAmount) || costAmount < 0) {
    showMessage("errorMessage", "酒代原価を0円以上の整数で入力してください。");
    return;
  }
  const duplicate = liquorCostRecords.find((record) =>
    record.id !== editingLiquorCostId
    && normalizeBrandName(record.brandName) === normalizeBrandName(brandName)
  );
  if (duplicate) {
    showMessage("errorMessage", "同じ銘柄名の原価が既に登録されています。既存行の編集を使用してください。");
    return;
  }
  const button = byId("saveLiquorCostButton");
  hideMessage("errorMessage");
  hideMessage("successMessage");
  try {
    button.disabled = true;
    const recordRef = editingLiquorCostId
      ? doc(db, liquorCostCollectionName, editingLiquorCostId)
      : doc(collection(db, liquorCostCollectionName));
    await setDoc(recordRef, {
      brandName,
      costAmount,
      updatedBy: currentUser.email || currentUser.uid,
      updatedAt: serverTimestamp()
    }, { merge: true });
    const record = normalizeLiquorCost(recordRef.id, { brandName, costAmount });
    liquorCostRecords = [
      ...liquorCostRecords.filter((item) => item.id !== recordRef.id),
      record
    ];
    liquorCostLoadError = null;
    resetLiquorCostForm();
    renderLiquorCostSettings();
    renderCastRewards();
    showMessage("successMessage", `${brandName}の酒代原価を保存しました。`);
  } catch (error) {
    showMessage("errorMessage", `酒代原価を保存できませんでした。${error.message}`);
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
    const duplicateCount = receivedClosings.filter((item) => item.businessDate === closing.businessDate).length;
    const duplicateLabel = duplicateCount > 1 ? ` / 重複受信 ${duplicateCount}件` : "";
    detail.textContent = `総売上 ${yenCell(closing.totalSales)} / 会計 ${closing.transactions.length}件 / 受信番号 ${closing.id.slice(-8)}${duplicateLabel} / ${statusLabel(closing.status)}`;
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

function openDeleteFinalizedStepOneModal(id) {
  deletingFinalizedClosing = finalizedClosings.find((item) => item.id === id);
  if (!deletingFinalizedClosing) return;
  byId("deleteFinalizedTarget").textContent = `${deletingFinalizedClosing.businessDate} の確定データを完全に削除します。`;
  byId("deleteFinalizedFinalTarget").textContent = `${deletingFinalizedClosing.businessDate} の確定データ`;
  byId("deleteFinalizedInput").value = "";
  byId("openDeleteFinalizedStepTwoButton").disabled = true;
  byId("confirmDeleteFinalizedButton").disabled = false;
  hideMessage("deleteFinalizedError");
  byId("deleteFinalizedStepTwoModal").close();
  byId("deleteFinalizedStepOneModal").showModal();
  byId("deleteFinalizedInput").focus();
}

function closeDeleteFinalizedModals() {
  byId("deleteFinalizedStepOneModal").close();
  byId("deleteFinalizedStepTwoModal").close();
  byId("deleteFinalizedInput").value = "";
  byId("openDeleteFinalizedStepTwoButton").disabled = true;
  byId("confirmDeleteFinalizedButton").disabled = false;
  hideMessage("deleteFinalizedError");
  deletingFinalizedClosing = null;
}

function updateDeleteFinalizedConfirmation() {
  byId("openDeleteFinalizedStepTwoButton").disabled = byId("deleteFinalizedInput").value !== "削除";
}

function openDeleteFinalizedStepTwoModal() {
  if (!deletingFinalizedClosing || byId("deleteFinalizedInput").value !== "削除") return;
  byId("deleteFinalizedStepOneModal").close();
  byId("deleteFinalizedStepTwoModal").showModal();
}

function backDeleteFinalizedStepOne() {
  byId("deleteFinalizedStepTwoModal").close();
  byId("deleteFinalizedStepOneModal").showModal();
  byId("deleteFinalizedInput").focus();
}

async function deleteFinalized() {
  if (!deletingFinalizedClosing || byId("deleteFinalizedInput").value !== "削除") return;
  const target = deletingFinalizedClosing;
  const button = byId("confirmDeleteFinalizedButton");
  button.disabled = true;
  try {
    await deleteDoc(doc(db, closingsCollectionName, target.id));
    closeDeleteFinalizedModals();
    await loadData();
    showMessage("successMessage", `${target.businessDate} の確定データを削除しました。`);
  } catch (error) {
    byId("deleteFinalizedStepTwoModal").close();
    byId("deleteFinalizedStepOneModal").showModal();
    showMessage("deleteFinalizedError", `確定データを削除できませんでした。${error.message}`);
    button.disabled = false;
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
          introducerId: row.introducerId,
          introducerName: row.introducerName,
          introducerFeeSystem: row.introducerFeeSystem,
          advisoryFeeEnabled: row.advisoryFeeEnabled === true,
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
    unresolvedCastRewards: 0,
    missingEmployeeSalaries: 0,
    unresolvedIntroducerFees: 0,
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
    if (row.payable === null) {
      result.unresolvedPayments += 1;
      result.unresolvedCastRewards += 1;
    }
    else result.castRewards += row.payable;
  });
  const staffRows = monthsInRange(start, end).flatMap((month) =>
    calculateStaffPayrollRows(items.filter((closing) => closing.businessDate.startsWith(`${month}-`)), month)
  );
  result.missingEmployeeSalaries = staffRows.filter((row) => row.salaryMissing).length;
  result.unresolvedPayments += result.missingEmployeeSalaries;
  result.staffPayroll = staffRows.reduce((sum, row) => sum + row.payable, 0);
  result.trialCastRewards = calculateTrialCastRewardRows(items).reduce((sum, row) => sum + row.payable, 0);
  const introducerRows = rewardRows
    .filter((row) => row.member?.introducerId)
    .map((row) => calculateIntroducerFee(row));
  introducerRows.forEach((row) => {
    if (row.totalExpense === null) {
      result.unresolvedPayments += 1;
      result.unresolvedIntroducerFees += 1;
    }
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
    ["キャスト報酬", summary.unresolvedCastRewards ? `${yenCell(summary.castRewards)}ほか未計算` : yenCell(summary.castRewards)],
    ["体入キャスト報酬", yenCell(summary.trialCastRewards)],
    ["スタッフ給与", summary.missingEmployeeSalaries ? `${yenCell(summary.staffPayroll)} / 月給未設定${summary.missingEmployeeSalaries}名` : yenCell(summary.staffPayroll)],
    ["紹介料・顧問料", summary.unresolvedIntroducerFees ? `${yenCell(summary.introducerExpenses)}ほか未計算` : yenCell(summary.introducerExpenses)],
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
    appendEmptyTableRow(body, 9, "指定期間の確定データはありません。");
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
    const deleteAction = document.createElement("td");
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "danger-button";
    deleteButton.textContent = "削除";
    deleteButton.addEventListener("click", () => openDeleteFinalizedStepOneModal(closing.id));
    action.appendChild(button);
    deleteAction.appendChild(deleteButton);
    tr.appendChild(action);
    tr.appendChild(deleteAction);
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
        ["体入勤務時間（同月入店分）", hoursCell(row.trialHours)],
        ["体入時給報酬（同月入店分）", yenCell(row.trialPay)],
        ["時給分", row.hourlyBase === null ? "計算不可" : yenCell(row.hourlyBase)],
        ["本指名バック", `${row.backs.honCount}回 / ${yenCell(row.backs.hon)}`],
        ["場内指名バック", `${row.backs.banaiCount}回 / ${yenCell(row.backs.banai)}`],
        ["同伴バック", `${row.backs.dohanCount}回 / ${yenCell(row.backs.dohan)}`],
        ["VIP室料バック", yenCell(row.backs.vip)],
        ["キープボトルバック", yenCell(row.backs.keepBottle)],
        ["シャンパン・ワイン販売額", yenCell(row.backs.champagneWineGross)],
        ["シャンパン・ワイン原価", yenCell(row.backs.champagneWineCost)],
        ["シャンパン・ワイン原価引後", yenCell(row.backs.champagneWineNet)],
        ["シャンパン・ワインバック", yenCell(row.backs.champagneWine)],
        ["ドリンクバック", yenCell(row.backs.drink)],
        ["バック合計", yenCell(row.backs.total)],
        ["時給＋バック", row.hourlyAndBack === null ? "計算不可" : yenCell(row.hourlyAndBack)],
        ["時給＋バック＋体入時給", row.hourlyAndBackWithTrial === null ? "計算不可" : yenCell(row.hourlyAndBackWithTrial)],
        ["売上報酬", row.salesRewardRate ? `${Math.round(row.salesRewardRate * 100)}% / ${yenCell(row.salesReward)}` : "対象外"],
        ["売上報酬＋体入時給", yenCell(row.salesRewardWithTrial)],
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
  return closings.flatMap((closing) => closing.trialWork
    .filter((row) => !isTrialConvertedIntoActiveMonth(row, closing.businessDate))
    .map((row) => ({
      ...row,
      businessDate: closing.businessDate,
      payable: Math.round(toNumber(row.hours) * toNumber(row.hourlyRate))
    }))).sort((a, b) => b.businessDate.localeCompare(a.businessDate) || a.name.localeCompare(b.name, "ja"));
}

function calculateCastRewardRows(rewardClosings = rewardMonthClosings()) {
  const salesRows = aggregateCastSales(rewardClosings);
  const workRows = aggregateWork(rewardClosings, "castWork");
  const backRows = aggregateCastBacks(rewardClosings);
  const salesMap = mergeRowsByPersonKey(salesRows, "key");
  const workMap = mergeRowsByPersonKey(workRows, "id");
  const backMap = mergeRowsByPersonKey(
    backRows.filter((row) => !isFormerTrialSource(findMember(castMembers, row.id, row.name), row.id)),
    "id"
  );
  const trialCompMap = aggregateConvertedTrialCompensation(rewardClosings);
  const keys = new Set([...salesMap.keys(), ...workMap.keys(), ...backMap.keys(), ...trialCompMap.keys()]);
  return [...keys].map((key) => {
    const sales = salesMap.get(key) || {};
    const work = workMap.get(key) || {};
    const backs = backMap.get(key) || emptyCastBack(key, sales.name || work.name);
    const trialComp = trialCompMap.get(key) || { hours: 0, pay: 0, shifts: [], names: [], sales: 0 };
    const member = findMember(castMembers, key, sales.name || work.name);
    if (member?.status === "trial") return null;
    const missingLiquorCosts = Array.isArray(backs.missingLiquorCosts)
      ? backs.missingLiquorCosts
      : [...(backs.missingLiquorCosts || [])];
    backs.missingLiquorCosts = missingLiquorCosts;
    const monthlySales = toNumber(sales.totalAttributedSales);
    const rewardSystem = member?.rewardSystem || "";
    const guaranteedHourlyRate = toNumber(member?.guaranteedHourlyRate);
    const hourlyRate = rewardSystem === "slideHourly"
      ? slideHourlyRate(monthlySales)
      : rewardSystem === "guaranteedHourly"
        ? guaranteedHourlyRate
        : 0;
    const rewardError = !rewardSystem
      ? "報酬システム未設定"
      : rewardSystem === "guaranteedHourly" && guaranteedHourlyRate <= 0
        ? "保証時給金額未設定"
        : "";
    const liquorCostError = missingLiquorCosts.length
      ? `酒代原価未設定：${missingLiquorCosts.join("、")}`
      : "";
    const calculationError = [rewardError, liquorCostError].filter(Boolean).join(" / ");
    const hourlyBase = calculationError ? null : Math.round(hourlyRate * toNumber(work.hours));
    const hourlyAndBack = hourlyBase === null ? null : hourlyBase + backs.total;
    const salesRewardRate = castSalesRewardRate(monthlySales);
    const salesRewardBase = salesRewardBaseAfterLiquorCost(monthlySales, backs.champagneWineCost);
    const salesRewardLiquorCostDeduction = monthlySales - salesRewardBase;
    const salesReward = Math.floor(salesRewardBase * salesRewardRate);
    const trialPay = toNumber(trialComp.pay);
    const hourlyAndBackWithTrial = hourlyAndBack === null ? null : hourlyAndBack + trialPay;
    const salesRewardWithTrial = salesReward + trialPay;
    return {
      key,
      name: sales.name || work.name || backs.name || member?.name || "名称未設定",
      member,
      monthlySales,
      monthlyHonShimeiSales: toNumber(sales.honShimeiSales),
      hours: toNumber(work.hours),
      days: work.days?.size || 0,
      shifts: work.shifts || [],
      trialHours: toNumber(trialComp.hours),
      trialPay,
      trialShifts: trialComp.shifts || [],
      trialNames: trialComp.names || [],
      trialSales: toNumber(trialComp.sales),
      hourlyRate,
      hourlyBase,
      backs,
      hourlyAndBack,
      hourlyAndBackWithTrial,
      salesRewardRate,
      salesRewardBase,
      salesRewardLiquorCostDeduction,
      salesReward,
      salesRewardWithTrial,
      payable: hourlyAndBack === null ? null : Math.max(hourlyAndBack, salesReward) + trialPay,
      calculationError
    };
  }).filter(Boolean).sort((a, b) => b.monthlySales - a.monthlySales);
}

function mergeRowsByPersonKey(rows, idField) {
  const map = new Map();
  rows.forEach((row) => {
    const rawId = String(row[idField] || row.id || row.key || row.name || "");
    const member = findMember(castMembers, rawId, row.name);
    const canMap = member && shouldMapMemberForReward(member, rawId);
    const key = canMap ? member.personKey || member.id : rawId || row.name || "unknown";
    const current = map.get(key) || {
      ...row,
      [idField]: key,
      id: key,
      key,
      name: canMap ? member.name : row.name,
      honShimeiSales: 0,
      jonaiExtensionSales: 0,
      totalAttributedSales: 0,
      hours: 0,
      days: new Set(),
      shifts: [],
      total: 0
    };
    current.name = current.name || (canMap ? member.name : row.name);
    current.honShimeiSales += toNumber(row.honShimeiSales);
    current.jonaiExtensionSales += toNumber(row.jonaiExtensionSales);
    current.totalAttributedSales += toNumber(row.totalAttributedSales);
    current.hours += toNumber(row.hours);
    if (row.days instanceof Set) row.days.forEach((day) => current.days.add(day));
    if (Array.isArray(row.shifts)) current.shifts.push(...row.shifts);
    [
      "hon", "honCount", "banai", "banaiCount", "dohan", "dohanCount", "vip",
      "keepBottle", "champagneWine", "champagneWineGross", "champagneWineCost",
      "champagneWineNet", "drink", "total"
    ].forEach((field) => {
      current[field] = toNumber(current[field]) + toNumber(row[field]);
    });
    const missing = new Set(current.missingLiquorCosts || []);
    (Array.isArray(row.missingLiquorCosts) ? row.missingLiquorCosts : []).forEach((label) => missing.add(label));
    current.missingLiquorCosts = [...missing];
    map.set(key, current);
  });
  return map;
}

function shouldMapMemberForReward(member, sourceId) {
  if (!member || member.status === "trial") return false;
  const normalizedSource = String(sourceId || "");
  const isFormerTrialId = isFormerTrialSource(member, normalizedSource);
  if (!isFormerTrialId) return true;
  const month = byId("startDate").value.slice(0, 7);
  return Boolean(member.entryDate && member.entryDate.startsWith(`${month}-`));
}

function isFormerTrialSource(member, sourceId) {
  if (!member) return false;
  const normalizedSource = String(sourceId || "");
  return normalizeAliasList(member.previousPosCastIds).includes(normalizedSource)
    || String(member.sourceTrialCastId || "") === normalizedSource;
}

function aggregateConvertedTrialCompensation(closings) {
  const map = new Map();
  closings.forEach((closing) => {
    closing.trialWork.forEach((row) => {
      const member = convertedTrialMemberFor(row, closing.businessDate);
      if (!member) return;
      const key = member.personKey || member.id;
      const current = map.get(key) || { hours: 0, pay: 0, shifts: [], names: new Set(), sales: 0 };
      current.hours += toNumber(row.hours);
      current.pay += Math.round(toNumber(row.hours) * toNumber(row.hourlyRate));
      current.names.add(row.name);
      current.shifts.push({
        date: closing.businessDate,
        startTime: row.startTime || "",
        endTime: row.endTime || "",
        hours: toNumber(row.hours),
        trial: true,
        name: row.name
      });
      map.set(key, current);
    });
  });
  return new Map([...map.entries()].map(([key, row]) => [key, {
    ...row,
    names: [...row.names].filter(Boolean)
  }]));
}

function convertedTrialMemberFor(row, businessDate) {
  const member = findMember(castMembers, row.id || row.castId, row.name);
  if (!member || member.status !== "active") return null;
  if (!member.entryDate || !businessDate || member.entryDate.slice(0, 7) !== businessDate.slice(0, 7)) return null;
  const id = String(row.id || row.castId || "");
  const aliases = normalizeAliasList(member.previousPosCastIds);
  const nameAliases = normalizeAliasList(member.previousNames);
  const linked = aliases.includes(id)
    || String(member.sourceTrialCastId || "") === String(row.id || "")
    || nameAliases.includes(String(row.name || ""));
  return linked ? member : null;
}

function isTrialConvertedIntoActiveMonth(row, businessDate) {
  return Boolean(convertedTrialMemberFor(row, businessDate));
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
        ["出勤日数", `${row.attendanceDays}日`],
        ["顧問料単価（1出勤）", yenCell(row.advisoryFeeUnit)],
        ["顧問料", `${row.attendanceDays}日 × ${yenCell(row.advisoryFeeUnit)} = ${yenCell(row.advisoryFee)}`],
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
  const attendanceDays = Math.max(0, Math.floor(toNumber(reward.days)));
  const advisoryFeeUnit = member.advisoryFeeEnabled ? toNumber(member.advisoryFeeAmount) : 0;
  const advisoryFee = advisoryFeeUnit * attendanceDays;
  return {
    castName: reward.name,
    introducerName: member.introducerName || introducer?.name || "名称未設定",
    feeSystem,
    honShimeiSales,
    payable: reward.payable,
    sales10,
    pay10,
    introductionFee,
    attendanceDays,
    advisoryFeeUnit,
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

function salesRewardBaseAfterLiquorCost(sales, champagneWineCost) {
  return Math.max(0, toNumber(sales) - Math.floor(toNumber(champagneWineCost) * 0.5));
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

      if (honCasts.length) {
        const champagneItems = transaction.items.filter((item) =>
          ["champagneWine", "champagne", "wine"].includes(item.category)
        );
        let grossTotal = 0;
        let costTotal = 0;
        let netTotal = 0;
        const missingCosts = new Set();
        champagneItems.forEach((item) => {
          const quantity = toNumber(item.quantity);
          const gross = toNumber(item.price) * quantity;
          const costRecord = liquorCostForItem(item);
          grossTotal += gross;
          if (!costRecord) {
            missingCosts.add(item.label || "名称未設定");
            return;
          }
          const cost = costRecord.costAmount * quantity;
          costTotal += cost;
          netTotal += Math.max(0, gross - cost);
        });
        const share = Math.floor(Math.floor(netTotal * 0.20) / honCasts.length);
        honCasts.forEach((item) => {
          const row = ensure(item.castId, castNameForId(item.castId));
          row.champagneWine += share;
          row.champagneWineGross += Math.floor(grossTotal / honCasts.length);
          row.champagneWineCost += Math.floor(costTotal / honCasts.length);
          row.champagneWineNet += Math.floor(netTotal / honCasts.length);
          missingCosts.forEach((label) => row.missingLiquorCosts.add(label));
        });
      }

      transaction.items
        .filter((item) => item.category === "castDrink" && item.castId)
        .forEach((item) => {
          add(item.castId, castNameForId(item.castId), "drink", Math.floor(item.price * item.quantity * 0.10));
        });
    });
  });
  return [...map.values()].map((row) => ({
    ...row,
    missingLiquorCosts: [...row.missingLiquorCosts].sort((a, b) => a.localeCompare(b, "ja")),
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
    champagneWineGross: 0,
    champagneWineCost: 0,
    champagneWineNet: 0,
    missingLiquorCosts: new Set(),
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
  const month = byId("staffSalaryMonth").value || byId("startDate").value.slice(0, 7);
  byId("staffSalaryMonth").value = month;
  const monthClosings = finalizedClosings.filter((closing) => closing.businessDate.startsWith(`${month}-`));
  const rows = calculateStaffPayrollRows(monthClosings, month);
  const root = byId("staffPayrollList");
  root.replaceChildren();
  byId("staffSalaryStatus").textContent = `${month.replace("-", "年")}月の給与を表示しています。社員は月給、アルバイトは勤務実績から計算します。`;
  if (!rows.length) {
    root.appendChild(emptyMessage("指定期間の従業員給与計算対象はありません。"));
    return;
  }
  rows.forEach((row) => {
    const card = createPayrollCard(
      row.name,
      row.isEmployee ? "社員 / 月給" : `${payTypeLabel(row.payType)} ${yenCell(row.payAmount)}`,
      [
        ["勤務日数", `${row.days.size}日`],
        ["勤務時間", hoursCell(row.hours)],
        ["基本給与", yenCell(row.basePay)],
        ["手当", yenCell(row.allowance)],
        ["支給見込", row.salaryMissing ? "月給未設定" : yenCell(row.payable)]
      ]
    );
    if (row.isEmployee) {
      const salaryField = document.createElement("label");
      salaryField.className = "mt-4 block max-w-xs";
      salaryField.innerHTML = `<span class="form-label">月給（円）</span>`;
      const input = document.createElement("input");
      input.type = "number";
      input.min = "1";
      input.step = "1";
      input.className = "form-input employee-monthly-salary";
      input.dataset.staffId = row.id;
      input.dataset.staffName = row.name;
      input.value = row.monthlySalary || "";
      input.placeholder = "月給を入力";
      input.addEventListener("input", () => {
        const value = Number(input.value);
        input.classList.toggle("invalid", input.value !== "" && (!Number.isInteger(value) || value <= 0));
      });
      salaryField.appendChild(input);
      card.appendChild(salaryField);
    }
    root.appendChild(card);
  });
}

function renderCastRewardSystem() {
  const body = byId("castRewardSystemTableBody");
  body.replaceChildren();
  const query = byId("castRewardSystemSearch").value.trim().toLocaleLowerCase("ja");
  const rewardFilter = byId("castRewardSystemFilter").value;
  const statusFilter = byId("castRewardStatusFilter").value;
  const rows = castMembers
    .filter((member) => member.deleted !== true && member.status !== "trial")
    .filter((member) => !query || String(member.name || "").toLocaleLowerCase("ja").includes(query))
    .filter((member) => statusFilter === "all" || member.status === statusFilter)
    .filter((member) => {
      if (rewardFilter === "all") return true;
      if (rewardFilter === "unset") return !member.rewardSystem;
      return member.rewardSystem === rewardFilter;
    })
    .sort((a, b) =>
      Number(a.status === "departed") - Number(b.status === "departed")
      || Number(a.internalNo || Number.MAX_SAFE_INTEGER) - Number(b.internalNo || Number.MAX_SAFE_INTEGER)
      || String(a.name || "").localeCompare(String(b.name || ""), "ja")
    );
  const configuredCount = castMembers.filter((member) =>
    member.deleted !== true
    && member.status !== "trial"
    && Boolean(member.rewardSystem)
  ).length;
  const targetCount = castMembers.filter((member) => member.deleted !== true && member.status !== "trial").length;
  byId("castRewardSystemCount").textContent = `表示 ${rows.length}名 / 設定済み ${configuredCount}名 / 対象 ${targetCount}名`;
  if (!rows.length) {
    appendEmptyTableRow(body, 8, "条件に一致するキャストはいません。");
    return;
  }
  rows.forEach((member) => {
    const tr = document.createElement("tr");
    const status = member.status === "departed" ? "退店済み" : "在籍中";
    const guaranteedRate = member.rewardSystem === "guaranteedHourly"
      ? member.guaranteedHourlyRate > 0 ? yenCell(member.guaranteedHourlyRate) : "未設定"
      : "対象外";
    const guaranteeNote = member.rewardSystem === "guaranteedHourly"
      ? member.guaranteeNote || "未設定"
      : "対象外";
    [
      member.name || "名称未設定",
      status,
      rewardSystemLabel(member.rewardSystem),
      guaranteedRate,
      guaranteeNote,
      member.entryDate || "未設定",
      member.introducerName || "なし",
      member.note || "なし"
    ].forEach((value) => appendCell(tr, value));
    body.appendChild(tr);
  });
}

function calculateStaffPayrollRows(closings, month = closings[0]?.businessDate?.slice(0, 7) || "") {
  const workRows = aggregateWork(closings, "staffWork");
  const workMap = new Map(workRows.map((row) => [String(row.id), row]));
  const employees = staffMembers.filter((member) => member.employmentType === "employee" && member.status !== "departed");
  const keys = new Set([...workMap.keys(), ...employees.map((member) => String(member.id))]);
  return [...keys].map((key) => {
    const row = workMap.get(key) || { id: key, name: "", hours: 0, days: new Set(), shifts: [], payType: "", payAmount: 0 };
    const member = findMember(staffMembers, row.id, row.name);
    const isEmployee = member?.employmentType === "employee";
    const salaryRecord = employeeSalaryRecords.find((item) => item.month === month && String(item.staffId) === String(member?.id || row.id));
    const monthlySalary = toNumber(salaryRecord?.monthlySalary);
    const payType = isEmployee ? "monthly" : row.payType || member?.payType || "";
    const payAmount = isEmployee ? monthlySalary : toNumber(row.payAmount || member?.payAmount);
    const basePay = isEmployee
      ? monthlySalary
      : payType === "hourly" ? Math.round(payAmount * row.hours) : payAmount * row.days.size;
    const allowance = closings.reduce((total, closing) => total + closing.allowances
      .filter((item) => (item.recipientName || item.recipient || "") === (row.name || member?.name))
      .reduce((sum, item) => sum + item.amount, 0), 0);
    return {
      ...row,
      name: row.name || member?.name || "名称未設定",
      isEmployee,
      month,
      monthlySalary,
      salaryMissing: isEmployee && monthlySalary <= 0,
      payType,
      payAmount,
      basePay,
      allowance,
      payable: basePay + allowance
    };
  }).sort((a, b) => Number(b.isEmployee) - Number(a.isEmployee) || a.name.localeCompare(b.name, "ja"));
}

async function saveEmployeeSalaries() {
  const month = byId("staffSalaryMonth").value;
  const button = byId("saveEmployeeSalariesButton");
  if (!/^\d{4}-\d{2}$/.test(month)) {
    showMessage("errorMessage", "月給の対象月を選択してください。");
    return;
  }
  const inputs = [...document.querySelectorAll(".employee-monthly-salary")];
  try {
    const values = inputs.map((input) => {
      const monthlySalary = Number(input.value);
      const valid = Number.isInteger(monthlySalary) && monthlySalary > 0;
      input.classList.toggle("invalid", !valid);
      if (!valid) throw new Error(`${input.dataset.staffName}の月給を1円以上の整数で入力してください。`);
      return {
        staffId: input.dataset.staffId,
        staffName: input.dataset.staffName,
        monthlySalary
      };
    });
    button.disabled = true;
    await Promise.all(values.map((value) => setDoc(
      doc(db, employeeSalaryCollectionName, employeeSalaryRecordId(month, value.staffId)),
      {
        month,
        ...value,
        updatedBy: currentUser.uid,
        updatedAt: serverTimestamp()
      },
      { merge: true }
    )));
    employeeSalaryRecords = [
      ...employeeSalaryRecords.filter((item) => item.month !== month),
      ...values.map((value) => ({ id: employeeSalaryRecordId(month, value.staffId), month, ...value }))
    ];
    renderStaffPayroll();
    renderFinalizedView();
    showMessage("successMessage", `${month.replace("-", "年")}月の社員月給を保存しました。`);
  } catch (error) {
    showMessage("errorMessage", error.message);
  } finally {
    button.disabled = false;
  }
}

async function exportCastRewardsXlsx() {
  const month = byId("startDate").value.slice(0, 7);
  const rows = calculateCastRewardRows();
  await exportStatementWorkbook({
    buttonId: "exportCastRewardsXlsxButton",
    fileName: `cast_rewards_${month.replace("-", "")}.xlsx`,
    subject: "キャスト報酬明細書",
    period: `${month.replace("-", "年")}月`,
    rows,
    nameForRow: (row) => row.name,
    detailsForRow: (row) => [
      ["報酬システム", rewardSystemLabel(row.member?.rewardSystem)],
      ["月間小計売上", row.monthlySales],
      ["本指名小計売上", row.monthlyHonShimeiSales],
      ["適用時給", row.hourlyRate || "未設定"],
      ["勤務日数", `${row.days}日`],
      ["月間勤務時間", `${row.hours}時間`],
      ["体入勤務時間（同月入店分）", `${row.trialHours}時間`],
      ["体入時給報酬（同月入店分）", row.trialPay],
      ["時給分", statementAmount(row.hourlyBase)],
      ["本指名バック", row.backs.hon],
      ["場内指名バック", row.backs.banai],
      ["同伴バック", row.backs.dohan],
      ["VIP室料バック", row.backs.vip],
      ["キープボトルバック", row.backs.keepBottle],
      ["シャンパン・ワイン販売額", row.backs.champagneWineGross],
      ["シャンパン・ワイン原価", row.backs.champagneWineCost],
      ["シャンパン・ワイン原価引後", row.backs.champagneWineNet],
      ["シャンパン・ワインバック", row.backs.champagneWine],
      ["ドリンクバック", row.backs.drink],
      ["バック合計", row.backs.total],
      ["時給＋バック", statementAmount(row.hourlyAndBack)],
      ["時給＋バック＋体入時給", statementAmount(row.hourlyAndBackWithTrial)],
      ["売上報酬率", row.salesRewardRate ? `${Math.round(row.salesRewardRate * 100)}%` : "対象外"],
      ["売上報酬", row.salesReward],
      ["売上報酬＋体入時給", row.salesRewardWithTrial],
      ["支給額（高い方）", statementAmount(row.payable)],
      ...statementShiftRows(row.trialShifts),
      ...statementShiftRows(row.shifts)
    ],
    totalLabel: "支給額",
    totalForRow: (row) => row.payable
  });
}

async function exportStaffPayrollXlsx() {
  const month = byId("staffSalaryMonth").value || byId("startDate").value.slice(0, 7);
  const monthClosings = finalizedClosings.filter((closing) => closing.businessDate.startsWith(`${month}-`));
  const rows = calculateStaffPayrollRows(monthClosings, month);
  await exportStatementWorkbook({
    buttonId: "exportStaffPayrollXlsxButton",
    fileName: `staff_payroll_${month.replace("-", "")}.xlsx`,
    subject: "従業員給与明細書",
    period: `${month.replace("-", "年")}月`,
    rows,
    nameForRow: (row) => row.name,
    detailsForRow: (row) => [
      ["雇用形態", row.isEmployee ? "社員" : "アルバイト"],
      ["給与形態", payTypeLabel(row.payType)],
      [row.isEmployee ? "月給" : "給与単価", row.salaryMissing ? "未設定" : row.payAmount],
      ["勤務日数", `${row.days.size}日`],
      ["勤務時間", `${row.hours}時間`],
      ["基本給与", row.basePay],
      ["手当", row.allowance],
      ["支給額", row.salaryMissing ? "計算不可" : row.payable],
      ...statementShiftRows(row.shifts)
    ],
    totalLabel: "支給額",
    totalForRow: (row) => row.salaryMissing ? null : row.payable
  });
}

async function exportIntroducerFeesXlsx() {
  const month = byId("startDate").value.slice(0, 7);
  const rows = calculateIntroducerFeeRows(calculateCastRewardRows());
  await exportStatementWorkbook({
    buttonId: "exportIntroducerFeesXlsxButton",
    fileName: `introducer_fees_${month.replace("-", "")}.xlsx`,
    subject: "紹介料・顧問料明細書",
    period: `${month.replace("-", "年")}月`,
    rows,
    nameForRow: (row) => `${row.introducerName}（${row.castName}分）`,
    detailsForRow: (row) => [
      ["紹介者", row.introducerName],
      ["対象キャスト", row.castName],
      ["紹介料システム", introducerFeeSystemLabel(row.feeSystem)],
      ["本指名小計売上", row.honShimeiSales],
      ["本指名売上10%", row.sales10],
      ["キャスト総支給額", statementAmount(row.payable)],
      ["総支給額10%", statementAmount(row.pay10)],
      ["採用した紹介料", statementAmount(row.introductionFee)],
      ["出勤日数", `${row.attendanceDays}日`],
      ["顧問料単価（1出勤）", row.advisoryFeeUnit],
      ["顧問料", row.advisoryFee],
      ["紹介関連支出", statementAmount(row.totalExpense)]
    ],
    totalLabel: "紹介料・顧問料 合計",
    totalForRow: (row) => row.totalExpense
  });
}

function statementAmount(value) {
  return value === null ? "計算不可" : toNumber(value);
}

function statementShiftRows(shifts = []) {
  return shifts.map((shift) => [
    `勤務 ${shift.date}`,
    `${shift.startTime || "--:--"} ～ ${shift.endTime || "--:--"} / ${toNumber(shift.hours)}時間`
  ]);
}

async function exportStatementWorkbook(config) {
  const ExcelJS = globalThis.ExcelJS;
  if (!ExcelJS) {
    showMessage("errorMessage", "XLSX出力機能を読み込めませんでした。再読み込みしてください。");
    return;
  }
  if (!config.rows.length) {
    showMessage("errorMessage", "明細書の出力対象データがありません。");
    return;
  }
  const button = byId(config.buttonId);
  button.disabled = true;
  hideMessage("errorMessage");
  try {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "GENESIS Management System";
    workbook.created = new Date();
    const usedNames = new Set();
    config.rows.forEach((row, index) => {
      const displayName = config.nameForRow(row);
      const sheetName = uniqueSheetName(displayName || `明細${index + 1}`, usedNames);
      const worksheet = workbook.addWorksheet(sheetName, {
        pageSetup: {
          paperSize: 9,
          orientation: "portrait",
          fitToPage: true,
          fitToWidth: 1,
          fitToHeight: 0,
          horizontalCentered: true,
          verticalCentered: false,
          margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 }
        }
      });
      buildStatementSheet(worksheet, {
        subject: config.subject,
        period: config.period,
        displayName,
        details: config.detailsForRow(row),
        totalLabel: config.totalLabel,
        total: config.totalForRow(row)
      });
    });
    const buffer = await workbook.xlsx.writeBuffer();
    downloadXlsx(buffer, config.fileName);
    showMessage("successMessage", `${config.rows.length}件の明細書をXLSX出力しました。`);
  } catch (error) {
    showMessage("errorMessage", `XLSX明細書を出力できませんでした。${error.message}`);
  } finally {
    button.disabled = false;
  }
}

function buildStatementSheet(worksheet, statement) {
  worksheet.columns = [
    { key: "label", width: 28 },
    { key: "value", width: 24 },
    { key: "unit", width: 10 }
  ];
  worksheet.mergeCells("A1:C1");
  worksheet.getCell("A1").value = "CLUB GENESIS";
  worksheet.getCell("A1").font = { name: "Yu Gothic", size: 12, bold: true, color: { argb: "FF475569" } };
  worksheet.getCell("A1").alignment = { horizontal: "center" };
  worksheet.mergeCells("A2:C2");
  worksheet.getCell("A2").value = statement.subject;
  worksheet.getCell("A2").font = { name: "Yu Gothic", size: 18, bold: true, color: { argb: "FF0F172A" } };
  worksheet.getCell("A2").alignment = { horizontal: "center", vertical: "middle" };
  worksheet.getRow(2).height = 30;
  worksheet.addRow([]);
  worksheet.addRow(["対象期間", statement.period]);
  worksheet.addRow(["氏名・支払先", statement.displayName]);
  worksheet.addRow([]);
  const header = worksheet.addRow(["項目", "内容・金額", "単位"]);
  header.eachCell((cell) => {
    cell.font = { name: "Yu Gothic", bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF334155" } };
    cell.alignment = { horizontal: "center", vertical: "middle" };
  });
  statement.details.forEach(([label, value]) => {
    const numeric = typeof value === "number" && Number.isFinite(value);
    const row = worksheet.addRow([label, numeric ? value : String(value ?? ""), numeric ? "円" : ""]);
    row.getCell(2).alignment = { horizontal: numeric ? "right" : "left", vertical: "middle" };
    if (numeric) row.getCell(2).numFmt = '#,##0"円"';
  });
  worksheet.addRow([]);
  const totalRow = worksheet.addRow([
    statement.totalLabel,
    statement.total === null ? "計算不可" : toNumber(statement.total),
    statement.total === null ? "" : "円"
  ]);
  totalRow.eachCell((cell) => {
    cell.font = { name: "Yu Gothic", size: 13, bold: true, color: { argb: "FF0F172A" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2E8F0" } };
  });
  if (statement.total !== null) {
    totalRow.getCell(2).numFmt = '#,##0"円"';
    totalRow.getCell(2).alignment = { horizontal: "right" };
  }
  worksheet.addRow([]);
  worksheet.addRow(["備考", "上記金額を明細として確認しました。"]);
  worksheet.addRow([]);
  worksheet.addRow(["受取日", "　　　　　年　　　月　　　日"]);
  worksheet.addRow(["受取署名", "　　　　　　　　　　　　　　　　　"]);
  worksheet.mergeCells(`B${worksheet.rowCount}:C${worksheet.rowCount}`);
  worksheet.eachRow((row, rowNumber) => {
    row.font = row.font || { name: "Yu Gothic", size: 10 };
    if (rowNumber >= 4) row.height = 22;
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.font = { name: "Yu Gothic", size: cell.font?.size || 10, bold: cell.font?.bold || false, color: cell.font?.color };
      cell.alignment = { vertical: "middle", wrapText: true, ...cell.alignment };
      if (rowNumber >= 4 && rowNumber <= worksheet.rowCount - 4) {
        cell.border = {
          top: { style: "thin", color: { argb: "FFCBD5E1" } },
          left: { style: "thin", color: { argb: "FFCBD5E1" } },
          bottom: { style: "thin", color: { argb: "FFCBD5E1" } },
          right: { style: "thin", color: { argb: "FFCBD5E1" } }
        };
      }
    });
  });
  worksheet.headerFooter.oddFooter = "&CGENESIS Management System";
  worksheet.pageSetup.printArea = `A1:C${worksheet.rowCount}`;
  worksheet.pageSetup.printTitlesRow = "1:7";
  worksheet.views = [{ showGridLines: false }];
}

function uniqueSheetName(name, usedNames) {
  const base = String(name).replace(/[\\/*?:[\]]/g, " ").trim().slice(0, 31) || "明細";
  let candidate = base;
  let suffix = 2;
  while (usedNames.has(candidate)) {
    const tail = `_${suffix}`;
    candidate = `${base.slice(0, 31 - tail.length)}${tail}`;
    suffix += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

function downloadXlsx(buffer, fileName) {
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
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
    body.appendChild(createTableBlock(`会計明細 ${transaction.tableLabel || ""}`, ["明細", "分類", "単価", "数量", "金額"], transaction.items, (item) => [
      item.label, transactionItemCategoryLabel(item.category), yenCell(item.price), item.quantity, yenCell(item.price * item.quantity)
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

async function exportCsv() {
  const ExcelJS = globalThis.ExcelJS;
  if (!ExcelJS) {
    showMessage("errorMessage", "XLSX出力機能を読み込めませんでした。ページを再読み込みしてください。");
    return;
  }
  updateVisibleFinalized();
  if (!visibleFinalized.length) {
    showMessage("errorMessage", "XLSX出力対象の確定データがありません。");
    return;
  }
  const button = byId("exportCsvButton");
  button.disabled = true;
  hideMessage("errorMessage");
  try {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "GENESIS Management System";
    workbook.created = new Date();
    const worksheet = workbook.addWorksheet("【ジェネシス収支表】", {
      pageSetup: {
        paperSize: 9,
        orientation: "landscape",
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
        horizontalCentered: true,
        margins: { left: 0.25, right: 0.25, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 }
      }
    });
    buildIncomeStatementSheet(worksheet, visibleFinalized);
    const buffer = await workbook.xlsx.writeBuffer();
    const month = byId("startDate").value.slice(0, 7).replace("-", "");
    downloadXlsx(buffer, `gms_income_statement_${month || todayString().replaceAll("-", "")}.xlsx`);
    showMessage("successMessage", "確定データを収支表XLSXで出力しました。", false);
  } catch (error) {
    showMessage("errorMessage", `XLSX出力に失敗しました。${error.message}`);
  } finally {
    button.disabled = false;
  }
}

function activeCastCountOnDate(date) {
  if (!date) return 0;
  return castMembers.filter((member) => {
    if (member.deleted === true || member.status === "trial") return false;
    if (member.entryDate && member.entryDate > date) return false;
    const exitedDate = member.exitedDate || member.departedDate || "";
    if (exitedDate && exitedDate < date) return false;
    if (member.status === "departed" && !exitedDate) return false;
    return true;
  }).length;
}

function castRewardDecisionMap(monthClosings) {
  const decisions = new Map();
  calculateCastRewardRows(monthClosings).forEach((row) => {
    const hourlyAndBack = toNumber(row.hourlyAndBack);
    const salesReward = toNumber(row.salesReward);
    decisions.set(row.key, {
      hourlyRate: toNumber(row.hourlyRate),
      salesRewardRate: toNumber(row.salesRewardRate),
      mode: salesReward > hourlyAndBack ? "sales" : "hourly",
      calculationError: row.calculationError
    });
  });
  return decisions;
}

function dailyCastRewardAmounts(closing, decisions) {
  const salesMap = mergeRowsByPersonKey(aggregateCastSales([closing]), "key");
  const workMap = mergeRowsByPersonKey(aggregateWork([closing], "castWork"), "id");
  const backMap = mergeRowsByPersonKey(
    aggregateCastBacks([closing]).filter((row) => !isFormerTrialSource(findMember(castMembers, row.id, row.name), row.id)),
    "id"
  );
  const trialCompMap = aggregateConvertedTrialCompensation([closing]);
  const keys = new Set([...salesMap.keys(), ...workMap.keys(), ...backMap.keys(), ...trialCompMap.keys()]);
  let hourlyAndBack = 0;
  let salesReward = 0;

  keys.forEach((key) => {
    const decision = decisions.get(key);
    if (!decision || decision.calculationError) return;
    const sales = salesMap.get(key) || {};
    const work = workMap.get(key) || {};
    const backs = backMap.get(key) || {};
    const trialComp = trialCompMap.get(key) || {};
    const trialPay = toNumber(trialComp.pay);
    if (decision.mode === "sales") {
      const rewardBase = salesRewardBaseAfterLiquorCost(sales.totalAttributedSales, backs.champagneWineCost);
      salesReward += Math.floor(rewardBase * decision.salesRewardRate);
      hourlyAndBack += trialPay;
      return;
    }
    hourlyAndBack += Math.round(decision.hourlyRate * toNumber(work.hours)) + toNumber(backs.total) + trialPay;
  });

  hourlyAndBack += calculateTrialCastRewardRows([closing]).reduce((sum, row) => sum + toNumber(row.payable), 0);
  return { hourlyAndBack, salesReward };
}

function dailyNonEmployeeStaffPay(closing) {
  return closing.staffWork.reduce((total, row) => {
    const member = findMember(staffMembers, row.id, row.name);
    if (member?.employmentType === "employee") return total;
    const payType = row.payType || member?.payType || "";
    const payAmount = toNumber(row.payAmount || member?.payAmount);
    const basePay = payType === "hourly"
      ? Math.round(payAmount * toNumber(row.hours))
      : payType === "daily" ? payAmount : 0;
    return total + basePay;
  }, 0);
}

function averageNumbers(values) {
  const numbers = values.filter((value) => Number.isFinite(value));
  if (!numbers.length) return "";
  return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
}

function buildIncomeStatementSheet(worksheet, closings) {
  const start = byId("startDate").value;
  const targetMonth = start.slice(0, 7);
  const [year, month] = targetMonth.split("-").map(Number);
  const monthClosings = closings.filter((closing) => closing.businessDate.startsWith(`${targetMonth}-`));
  const dayMap = new Map(monthClosings.map((closing) => [Number(closing.businessDate.slice(8, 10)), closing]));
  const maxDay = new Date(year, month, 0).getDate();
  const rewardDecisions = castRewardDecisionMap(monthClosings);
  const dailyRows = [];

  worksheet.columns = [
    { width: 5 }, { width: 2 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 8 },
    { width: 8 }, { width: 10 }, { width: 8 }, { width: 8 }, { width: 8 }, { width: 9 },
    { width: 8 }, { width: 10 }, { width: 10 }, { width: 9 }, { width: 10 }, { width: 10 },
    { width: 10 }, { width: 12 }, { width: 10 }, { width: 12 }, { width: 2 }
  ];
  worksheet.views = [{ showGridLines: false }];

  worksheet.getCell("F1").value = year;
  worksheet.getCell("G1").value = "年";
  worksheet.getCell("H1").value = month;
  worksheet.getCell("I1").value = "月度";
  worksheet.getCell("J1").value = "ジェネシス収支表";
  worksheet.getCell("J1").font = titleFont();

  const headers = {
    A2: "日", C2: "売上", D2: "現金", E2: "カード", F2: "組数", G2: "客数", H2: "客単",
    I2: "本指名", J2: "場内", K2: "同伴", L2: "総出勤", M2: "在籍", N2: "時給",
    O2: "売上給", P2: "派遣数", Q2: "派遣給", R2: "女子給比", S2: "従業員給",
    T2: "経費", U2: "経費比", V2: "収支"
  };
  Object.entries(headers).forEach(([cell, value]) => {
    worksheet.getCell(cell).value = value;
    styleHeader(worksheet.getCell(cell));
  });

  for (let day = 1; day <= 31; day += 1) {
    const rowNumber = day + 2;
    const closing = dayMap.get(day);
    worksheet.getCell(`A${rowNumber}`).value = day;
    if (day <= maxDay && closing) {
      const dailyExpense = sumAmounts(closing.expenses) + sumAmounts(closing.allowances);
      const castRewards = dailyCastRewardAmounts(closing, rewardDecisions);
      const castRewardTotal = castRewards.hourlyAndBack + castRewards.salesReward;
      const staffPay = dailyNonEmployeeStaffPay(closing);
      const rowValues = {
        C: closing.totalSales,
        D: closing.cashSales,
        E: closing.cardSales,
        F: closing.groupCount,
        G: closing.totalCustomers,
        H: closing.totalCustomers ? Math.floor(closing.totalSales / closing.totalCustomers) : "",
        I: closing.honShimei,
        J: closing.jonai,
        K: dohanCountForClosing(closing),
        L: closing.castWork.length + closing.trialWork.length,
        M: activeCastCountOnDate(closing.businessDate),
        N: castRewards.hourlyAndBack,
        O: castRewards.salesReward,
        P: 0,
        Q: 0,
        R: closing.totalSales ? castRewardTotal / closing.totalSales : "",
        S: staffPay,
        T: dailyExpense,
        U: closing.totalSales ? dailyExpense / closing.totalSales : "",
        V: closing.totalSales - castRewardTotal - staffPay - dailyExpense
      };
      Object.entries(rowValues).forEach(([col, value]) => {
        worksheet.getCell(`${col}${rowNumber}`).value = value;
      });
      dailyRows.push(rowValues);
    } else {
      const rowValues = {
        C: 0, D: 0, E: 0, F: 0, G: 0, H: "", I: 0, J: 0, K: 0, L: 0, M: 0,
        N: 0, O: 0, P: 0, Q: 0, R: "", S: 0, T: 0, U: "", V: 0
      };
      Object.entries(rowValues).forEach(([col, value]) => {
        worksheet.getCell(`${col}${rowNumber}`).value = value;
      });
      worksheet.getCell(`H${rowNumber}`).value = "";
      worksheet.getCell(`U${rowNumber}`).value = "";
    }
  }

  worksheet.getCell("A34").value = "平均";
  worksheet.getCell("A35").value = "合計";
  const totalFor = (col) => dailyRows.reduce((sum, row) => sum + (Number.isFinite(row[col]) ? row[col] : 0), 0);
  ["C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V"].forEach((col) => {
    const values = dailyRows.map((row) => row[col]).filter((value) => value !== "");
    worksheet.getCell(`${col}34`).value = averageNumbers(values);
    worksheet.getCell(`${col}35`).value = totalFor(col);
  });
  const totalSales = totalFor("C");
  const totalCustomers = totalFor("G");
  const totalCastRewards = totalFor("N") + totalFor("O");
  const totalStaffPay = totalFor("S");
  const totalExpenses = totalFor("T");
  worksheet.getCell("H35").value = totalCustomers ? Math.floor(totalSales / totalCustomers) : "";
  worksheet.getCell("R35").value = totalSales ? totalCastRewards / totalSales : "";
  worksheet.getCell("U35").value = totalSales ? totalExpenses / totalSales : "";
  worksheet.getCell("V35").value = totalSales - totalCastRewards - totalStaffPay - totalExpenses;
  styleIncomeStatementSheet(worksheet);
}

function styleIncomeStatementSheet(worksheet) {
  for (let rowNumber = 1; rowNumber <= 35; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    row.height = rowNumber === 1 ? 24 : 22;
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      cell.font = { name: "Yu Gothic", size: rowNumber === 1 ? 11 : 9, bold: rowNumber <= 2 };
      cell.alignment = {
        horizontal: colNumber <= 2 ? "center" : "right",
        vertical: "middle",
        wrapText: true,
        shrinkToFit: rowNumber <= 35
      };
      if (rowNumber >= 2 && rowNumber <= 35 && colNumber >= 1 && colNumber <= 22) {
        cell.border = thinBorder();
      }
    });
  }
  ["A2:V2", "A35:V35"].forEach((range) => {
    const [start, end] = range.split(":");
    eachCellInRange(worksheet, start, end, (cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1F5F9" } };
      cell.font = { ...cell.font, bold: true };
    });
  });
  ["C:V"].forEach((range) => {
    const [from, to] = range.split(":").map(columnNumber);
    for (let col = from; col <= to; col += 1) {
      worksheet.getColumn(col).numFmt = '#,##0';
    }
  });
  ["R", "U"].forEach((col) => {
    for (let row = 3; row <= 35; row += 1) {
      worksheet.getCell(`${col}${row}`).numFmt = "0.0%";
    }
  });
  worksheet.getCell("J1").alignment = { horizontal: "left", vertical: "middle" };
  worksheet.pageSetup.printArea = "A1:V35";
  worksheet.headerFooter.oddFooter = "&CGENESIS Management System";
}

function styleHeader(cell) {
  cell.font = { name: "Yu Gothic", size: 9, bold: true, color: { argb: "FFFFFFFF" } };
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF334155" } };
  cell.alignment = { horizontal: "center", vertical: "middle" };
  cell.border = thinBorder();
}

function titleFont() {
  return { name: "Yu Gothic", size: 16, bold: true, color: { argb: "FF0F172A" } };
}

function thinBorder(color = "FFCBD5E1") {
  return {
    top: { style: "thin", color: { argb: color } },
    left: { style: "thin", color: { argb: color } },
    bottom: { style: "thin", color: { argb: color } },
    right: { style: "thin", color: { argb: color } }
  };
}

function eachCellInRange(worksheet, start, end, callback) {
  const startRef = splitCellRef(start);
  const endRef = splitCellRef(end);
  for (let row = startRef.row; row <= endRef.row; row += 1) {
    for (let col = startRef.col; col <= endRef.col; col += 1) {
      callback(worksheet.getRow(row).getCell(col));
    }
  }
}

function splitCellRef(ref) {
  const match = String(ref).match(/^([A-Z]+)(\d+)$/);
  return { col: columnNumber(match[1]), row: Number(match[2]) };
}

function columnNumber(label) {
  return String(label).split("").reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0);
}

function dohanCountForClosing(closing) {
  return closing.transactions.reduce((count, transaction) =>
    count + transaction.items.filter((item) => item.category === "dohan" || item.label === "同伴料").length, 0);
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

function transactionItemCategoryLabel(category) {
  return {
    champagneWine: "シャンパン・ワイン",
    champagne: "シャンパン・ワイン",
    wine: "シャンパン・ワイン",
    keepBottle: "キープボトル",
    castDrink: "キャストドリンク"
  }[category] || "その他";
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
    introducerId: String(row.introducerId || ""),
    introducerName: String(row.introducerName || ""),
    introducerFeeSystem: String(row.introducerFeeSystem || ""),
    advisoryFeeEnabled: row.advisoryFeeEnabled === true,
    hourlyRate: toNumber(row.hourlyRate)
  })).filter((row) => row.name);
}

function findMember(members, id, name) {
  const normalizedId = String(id || "");
  return members.find((member) =>
    String(member.id) === normalizedId
    || String(member.posCastId || "") === normalizedId
    || normalizeAliasList(member.previousPosCastIds).includes(normalizedId)
    || String(member.personKey || "") === normalizedId
    || (name && member.name === name)
    || (name && normalizeAliasList(member.previousNames).includes(String(name)))
  );
}

function normalizeAliasList(value) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
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
  return { daily: "日給", hourly: "時給", monthly: "月給" }[value] || "給与形態未設定";
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

function employeeSalaryRecordId(month, staffId) {
  return `${month}_${String(staffId).replace(/[^a-zA-Z0-9_-]/g, "_")}`;
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
