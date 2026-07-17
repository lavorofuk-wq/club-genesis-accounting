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
const castNumberLabel = (value) => {
  const number = Number(value || 0);
  return number ? `No.${String(number).padStart(3, "0")}` : "No.-";
};
const trialCastDisplayName = (row) => {
  const dateValue = row.trialBizDay || row.businessDate || "";
  const date = dateValue ? ` / ${dateValue}` : "";
  return `体入 ${castNumberLabel(row.internalNo)} ${row.name || ""}${date}`.trim();
};

byId("logoutButton").addEventListener("click", logout);
byId("reloadReceivedButton").addEventListener("click", loadData);
byId("loadButton").addEventListener("click", renderFinalizedView);
byId("exportCsvButton").addEventListener("click", exportCsv);
byId("closeReceivedEditButton").addEventListener("click", () => byId("receivedEditModal").close());
byId("closeClosingDetailButton").addEventListener("click", () => byId("closingDetailModal").close());
byId("finalizeReceivedButton").addEventListener("click", finalizeReceived);
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
byId("exportExpenseSheetXlsxButton").addEventListener("click", exportExpenseSheetXlsx);
byId("exportCastRewardsXlsxButton").addEventListener("click", exportCastRewardsXlsx);
byId("exportCastRewardMonthlySheetXlsxButton").addEventListener("click", exportCastRewardMonthlySheetXlsx);
byId("exportStaffPayrollXlsxButton").addEventListener("click", exportStaffPayrollXlsx);
byId("exportIntroducerFeesXlsxButton").addEventListener("click", exportIntroducerFeesXlsx);
byId("loadStaffSalaryButton").addEventListener("click", renderStaffPayroll);
byId("staffSalaryMonth").addEventListener("change", renderStaffPayroll);
byId("castRewardSearch").addEventListener("input", renderCastRewards);
byId("trialCastRewardSearch").addEventListener("input", renderTrialCastRewards);
byId("staffPayrollSearch").addEventListener("input", renderStaffPayroll);
byId("introducerFeeSearch").addEventListener("input", renderIntroducerFees);
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
      loadCollectionSnapshot("締めデータ", closingsCollectionName),
      loadCollectionSnapshot("キャスト一覧", castCollectionName),
      loadCollectionSnapshot("スタッフ一覧", staffCollectionName),
      loadCollectionSnapshot("紹介者一覧", introducerCollectionName),
      loadCollectionSnapshot("固定費", fixedExpenseCollectionName, true),
      loadCollectionSnapshot("体入キャスト記録", trialCastCollectionName, true),
      loadCollectionSnapshot("従業員月給", employeeSalaryCollectionName, true),
      loadCollectionSnapshot("酒代原価", liquorCostCollectionName, true)
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

async function loadCollectionSnapshot(label, collectionName, optional = false) {
  try {
    return await getDocs(collection(db, collectionName));
  } catch (error) {
    const wrapped = new Error(`${label}（${collectionName}）の取得に失敗しました。${error.message}`);
    wrapped.code = error.code;
    if (optional) return { docs: [], error: wrapped };
    throw wrapped;
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
    transportDeductions: normalizeTransportDeductions(raw.transportDeductions),
    payrollDeductions: normalizePayrollDeductions(raw.payrollDeductions),
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

function normalizeTransportDeductions(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => ({
    personType: normalizePersonType(row.personType, "cast"),
    personId: String(row.personId || ""),
    posCastId: String(row.posCastId || ""),
    personName: String(row.personName || row.castName || row.name || ""),
    amount: toNumber(row.amount)
  })).filter((row) => row.amount > 0);
}

function normalizePayrollDeductions(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => ({
    personType: normalizePersonType(row.personType, "cast"),
    personId: String(row.personId || ""),
    posCastId: String(row.posCastId || ""),
    personName: String(row.personName || row.name || ""),
    dailyPayment: toNumber(row.dailyPayment),
    advancePayment: toNumber(row.advancePayment)
  })).filter((row) => row.dailyPayment > 0 || row.advancePayment > 0);
}

function normalizePersonType(value, fallback = "cast") {
  return ["cast", "trial", "staff"].includes(value) ? value : fallback;
}

function personTypeLabel(type) {
  if (type === "staff") return "従業員";
  if (type === "trial") return "体入キャスト";
  return "キャスト";
}

function searchQuery(id) {
  return String(byId(id)?.value || "").trim().toLocaleLowerCase("ja");
}

function nameMatches(query, ...values) {
  if (!query) return true;
  return values.some((value) => String(value || "").toLocaleLowerCase("ja").includes(query));
}

function normalizeTrialWork(trialWork, castWork, trialCasts) {
  if (Array.isArray(trialWork) && trialWork.length) {
    return trialWork.map((row) => ({
      id: String(row.castId || row.id || row.castName || ""),
      name: String(row.castName || row.name || ""),
      internalNo: toNumber(row.internalNo),
      trialBizDay: String(row.trialBizDay || ""),
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
  const trialMap = new Map((trialCasts || []).map((cast) => [String(cast.castId || ""), cast]));
  return normalizeWorkRows(castWork, false)
    .filter((row) => row.isTrial || trialIds.has(String(row.id)))
    .map((row) => {
      const trial = trialMap.get(String(row.id)) || {};
      return {
        ...row,
        internalNo: row.internalNo || toNumber(trial.internalNo),
        trialBizDay: row.trialBizDay || String(trial.trialBizDay || "")
      };
    });
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
  renderReceivedReadonlySummary(editingClosing);
  renderReceivedTransactions(editingClosing);
  hideMessage("receivedEditError");
  byId("receivedEditModal").showModal();
}

function renderReceivedReadonlySummary(closing) {
  const root = byId("receivedReadonlySummary");
  root.replaceChildren();
  root.appendChild(createTableBlock("売上・客数・指名", ["項目", "内容"], [
    ["総売上", yenCell(closing.totalSales)],
    ["現金売上", yenCell(closing.cashSales)],
    ["カード売上", yenCell(closing.cardSales)],
    ["来店組数", `${closing.groupCount}組`],
    ["総客数", `${closing.totalCustomers}名`],
    ["客単価", yenCell(closing.customerUnitPrice)],
    ["本指名", `${closing.honShimei}件`],
    ["場内指名", `${closing.jonai}件`]
  ], (row) => row));
  root.appendChild(createTableBlock("経費", ["カテゴリ", "金額", "備考"], closing.expenses, (row) => [
    row.category, yenCell(row.amount), row.note || ""
  ]));
  root.appendChild(createTableBlock("手当", ["種類", "金額", "対象者", "備考"], closing.allowances, (row) => [
    row.type, yenCell(row.amount), row.recipientName || row.recipient || "", row.note || ""
  ]));
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
    (row) => [trialCastDisplayName(row), row.startTime, row.endTime, hoursCell(row.hours), row.introducerName, yenCell(row.hourlyRate)]
  ));
  root.appendChild(createTableBlock("送迎代控除", ["対象者", "区分", "金額"], closing.transportDeductions, (row) => [
    row.personName, personTypeLabel(row.personType), yenCell(row.amount)
  ]));
  root.appendChild(createTableBlock("報酬・給与引き", ["対象者", "区分", "日払い", "立替金"], closing.payrollDeductions, (row) => [
    row.personName, personTypeLabel(row.personType), yenCell(row.dailyPayment), yenCell(row.advancePayment)
  ]));
  root.appendChild(createTableBlock("従業員勤務時間", ["従業員", "開始", "終了", "勤務時間"], closing.staffWork, (row) => [
    row.name, row.startTime || "入力対象外", row.endTime || "入力対象外", row.hours > 0 ? hoursCell(row.hours) : "入力対象外"
  ]));
  root.appendChild(createTableBlock("キャスト勤務時間", ["キャスト", "開始", "終了", "勤務時間"], closing.castWork, (row) => [
    row.name, row.startTime || "", row.endTime || "", hoursCell(row.hours)
  ]));
}

async function finalizeReceived() {
  if (!editingClosing) return;
  hideMessage("receivedEditError");
  const finalizeButton = byId("finalizeReceivedButton");
  finalizeButton.disabled = true;
  try {
    const update = {
      status: "finalized",
      finalizedBy: currentUser.uid,
      finalizedEmail: currentUser.email || "",
      finalizedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    };
    await setDoc(doc(db, closingsCollectionName, editingClosing.id), update, { merge: true });
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
    byId("receivedEditModal").close();
    editingClosing = null;
    await loadData();
    showMessage("successMessage", "受信データをそのまま経理確定しました。");
  } catch (error) {
    showMessage("receivedEditError", error.message);
  } finally {
    finalizeButton.disabled = false;
  }
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
  const query = searchQuery("castRewardSearch");
  const rewardRows = calculateCastRewardRows().filter((row) => nameMatches(query, row.name, row.member?.name, row.trialNames?.join(" ")));
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
  const query = searchQuery("trialCastRewardSearch");
  const rows = calculateTrialCastRewardRows(visibleFinalized).filter((row) =>
    nameMatches(query, row.name, trialCastDisplayName(row), row.introducerName)
  );
  if (!rows.length) {
    root.appendChild(emptyMessage("指定期間の体入キャスト勤務データはありません。"));
    return;
  }
  rows.forEach((row) => {
    root.appendChild(createPayrollCard(
      trialCastDisplayName(row),
      `${row.businessDate} / 紹介者：${row.introducerName || "未入力"}`,
      [
        ["勤務時間", hoursCell(row.hours)],
        ["当日時給", yenCell(row.hourlyRate)],
        ["控除前報酬", yenCell(row.grossPayable)],
        ["送迎代控除", yenCell(row.deductions.transport)],
        ["日払い", yenCell(row.deductions.dailyPayment)],
        ["立替金", yenCell(row.deductions.advancePayment)],
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
    .map((row) => {
      const deductions = trialRowDeductions(closing, row);
      const grossPayable = Math.round(toNumber(row.hours) * toNumber(row.hourlyRate));
      return {
        ...row,
        businessDate: closing.businessDate,
        deductions,
        grossPayable,
        payable: Math.max(0, grossPayable - deductions.total)
      };
    })).sort((a, b) => b.businessDate.localeCompare(a.businessDate) || a.name.localeCompare(b.name, "ja"));
}

function trialRowDeductions(closing, trialRow) {
  const matches = (row) => {
    const id = String(trialRow.id || trialRow.castId || "");
    return row.personType === "trial"
      && (String(row.personId || row.posCastId || "") === id || row.personName === trialRow.name);
  };
  const result = { transport: 0, dailyPayment: 0, advancePayment: 0, total: 0 };
  closing.transportDeductions.filter(matches).forEach((row) => {
    result.transport += toNumber(row.amount);
    result.total += deductionAmount(row);
  });
  closing.payrollDeductions.filter(matches).forEach((row) => {
    result.dailyPayment += toNumber(row.dailyPayment);
    result.advancePayment += toNumber(row.advancePayment);
    result.total += deductionAmount(row);
  });
  return result;
}

function deductionAmount(row) {
  return toNumber(row.amount) + toNumber(row.dailyPayment) + toNumber(row.advancePayment);
}

function aggregatePersonDeductions(closings, members, personType) {
  const map = new Map();
  const add = (raw) => {
    const id = raw.personId || raw.posCastId || "";
    const member = findMember(members, id, raw.personName);
    const key = member?.personKey || member?.id || id || raw.personName || "unknown";
    const current = map.get(key) || {
      key,
      name: member?.name || raw.personName || "",
      transport: 0,
      dailyPayment: 0,
      advancePayment: 0,
      total: 0
    };
    current.transport += toNumber(raw.amount);
    current.dailyPayment += toNumber(raw.dailyPayment);
    current.advancePayment += toNumber(raw.advancePayment);
    current.total += deductionAmount(raw);
    map.set(key, current);
  };
  closings.forEach((closing) => {
    if (personType === "cast" || personType === "trial") {
      closing.transportDeductions
        .filter((row) => (row.personType || "cast") === personType)
        .forEach(add);
    }
    closing.payrollDeductions
      .filter((row) => row.personType === personType)
      .forEach(add);
  });
  return map;
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
  const deductionMap = aggregatePersonDeductions(rewardClosings, castMembers, "cast");
  const keys = new Set([...salesMap.keys(), ...workMap.keys(), ...backMap.keys(), ...trialCompMap.keys(), ...deductionMap.keys()]);
  return [...keys].map((key) => {
    const sales = salesMap.get(key) || {};
    const work = workMap.get(key) || {};
    const backs = backMap.get(key) || emptyCastBack(key, sales.name || work.name);
    const trialComp = trialCompMap.get(key) || { hours: 0, pay: 0, shifts: [], names: [], sales: 0 };
    const deductions = deductionMap.get(key) || { transport: 0, dailyPayment: 0, advancePayment: 0, total: 0 };
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
    const grossPayable = hourlyAndBack === null ? null : Math.max(hourlyAndBack, salesReward) + trialPay;
    const payable = grossPayable === null ? null : Math.max(0, grossPayable - deductions.total);
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
      deductions,
      grossPayable,
      payable,
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
  const findTrialRow = (closing, raw) => closing.trialWork.find((row) => {
    const id = String(row.id || row.castId || "");
    return id === String(raw.personId || raw.posCastId || "")
      || row.name === raw.personName;
  });
  closings.forEach((closing) => {
    closing.trialWork.forEach((row) => {
      const member = convertedTrialMemberFor(row, closing.businessDate);
      if (!member) return;
      const key = member.personKey || member.id;
      const current = map.get(key) || { hours: 0, grossPay: 0, deductions: 0, pay: 0, shifts: [], names: new Set(), sales: 0 };
      current.hours += toNumber(row.hours);
      current.grossPay += Math.round(toNumber(row.hours) * toNumber(row.hourlyRate));
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
    [...closing.transportDeductions, ...closing.payrollDeductions]
      .filter((row) => row.personType === "trial")
      .forEach((deduction) => {
        const trialRow = findTrialRow(closing, deduction);
        if (!trialRow) return;
        const member = convertedTrialMemberFor(trialRow, closing.businessDate);
        if (!member) return;
        const key = member.personKey || member.id;
        const current = map.get(key);
        if (!current) return;
        current.deductions += deductionAmount(deduction);
        map.set(key, current);
      });
  });
  return new Map([...map.entries()].map(([key, row]) => [key, {
    ...row,
    pay: Math.max(0, row.grossPay - row.deductions),
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
  const query = searchQuery("staffPayrollSearch");
  const rows = calculateStaffPayrollRows(monthClosings, month).filter((row) =>
    nameMatches(query, row.name, row.member?.name)
  );
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
  const deductionMap = aggregatePersonDeductions(closings, staffMembers, "staff");
  const employees = staffMembers.filter((member) => member.employmentType === "employee" && member.status !== "departed");
  const keys = new Set([...workMap.keys(), ...employees.map((member) => String(member.id)), ...deductionMap.keys()]);
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
    const deductions = deductionMap.get(key) || { dailyPayment: 0, advancePayment: 0, total: 0 };
    const grossPayable = basePay + allowance;
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
      deductions,
      grossPayable,
      payable: Math.max(0, grossPayable - deductions.total)
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

async function exportCastRewardMonthlySheetXlsx() {
  const ExcelJS = globalThis.ExcelJS;
  if (!ExcelJS) {
    showMessage("errorMessage", "XLSX出力機能を読み込めませんでした。画面を再読み込みしてください。");
    return;
  }
  const month = accountingTargetMonth();
  const monthClosings = finalizedClosings.filter((closing) => closing.businessDate.startsWith(`${month}-`));
  const rows = calculateCastRewardRows(monthClosings);
  if (!rows.length) {
    showMessage("errorMessage", "月次報酬表の出力対象データがありません。");
    return;
  }
  const button = byId("exportCastRewardMonthlySheetXlsxButton");
  button.disabled = true;
  hideMessage("errorMessage");
  try {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "GENESIS Management System";
    workbook.created = new Date();
    const usedNames = new Set();
    const indexSheet = workbook.addWorksheet("目次", {
      pageSetup: { paperSize: 9, orientation: "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
    });
    buildCastRewardIndexSheet(indexSheet, rows, usedNames, month);
    rows.forEach((row, index) => {
      const sheetName = uniqueSheetName(row.name || `キャスト${index + 1}`, usedNames);
      const worksheet = workbook.addWorksheet(sheetName, {
        pageSetup: {
          paperSize: 9,
          orientation: "landscape",
          fitToPage: true,
          fitToWidth: 1,
          fitToHeight: 0,
          horizontalCentered: true,
          margins: { left: 0.25, right: 0.25, top: 0.35, bottom: 0.35, header: 0.15, footer: 0.15 }
        }
      });
      buildCastRewardMonthlySheet(worksheet, row, month, monthClosings);
      indexSheet.getCell(`A${index + 3}`).value = { text: row.name, hyperlink: `#'${sheetName}'!A1` };
      indexSheet.getCell(`B${index + 3}`).value = row.payable === null ? "計算不可" : row.payable;
      indexSheet.getCell(`B${index + 3}`).numFmt = '#,##0"円"';
    });
    const buffer = await workbook.xlsx.writeBuffer();
    downloadXlsx(buffer, `cast_reward_monthly_${month.replace("-", "")}.xlsx`);
    showMessage("successMessage", `${rows.length}名分の月次報酬表をXLSX出力しました。`);
  } catch (error) {
    showMessage("errorMessage", `月次報酬表をXLSX出力できませんでした。${error.message}`);
  } finally {
    button.disabled = false;
  }
}

function accountingTargetMonth() {
  const source = byId("startDate").value || currentMonthRange().start;
  return source.slice(0, 7);
}

function buildCastRewardIndexSheet(worksheet, rows, usedNames, month) {
  usedNames.add("目次");
  worksheet.columns = [{ width: 28 }, { width: 16 }, { width: 18 }];
  worksheet.views = [{ showGridLines: false }];
  worksheet.mergeCells("A1:C1");
  worksheet.getCell("A1").value = "キャスト月次報酬表 目次";
  worksheet.getCell("A1").font = { name: "Yu Gothic", size: 16, bold: true };
  worksheet.getCell("A1").alignment = { horizontal: "center", vertical: "middle" };
  worksheet.getRow(1).height = 28;
  worksheet.getCell("A2").value = `${month.replace("-", "年")}月分`;
  worksheet.getCell("B2").value = "差引支給額";
  worksheet.getCell("C2").value = "対象人数";
  worksheet.getCell("C3").value = rows.length;
  ["A2", "B2", "C2"].forEach((address) => styleCastRewardHeaderCell(worksheet.getCell(address)));
}

function buildCastRewardMonthlySheet(worksheet, rewardRow, month, monthClosings) {
  const [year, monthNumber] = month.split("-").map(Number);
  const maxDay = new Date(year, monthNumber, 0).getDate();
  const dayMap = new Map(monthClosings.map((closing) => [Number(closing.businessDate.slice(8, 10)), closing]));
  const dailyRows = [];

  applyCastRewardSheetLayout(worksheet);
  writeCastRewardHeader(worksheet, rewardRow, year, monthNumber);
  writeCastRewardColumnHeaders(worksheet);

  for (let day = 1; day <= 31; day += 1) {
    const rowNumber = day + 2;
    const closing = day <= maxDay ? dayMap.get(day) : null;
    const values = closing ? castRewardDailySheetValues(rewardRow, closing) : emptyCastRewardDailySheetValues(day);
    dailyRows.push(values);
    writeCastRewardDailyRow(worksheet, rowNumber, values);
  }

  writeCastRewardTotals(worksheet, dailyRows);
  writeCastRewardSummary(worksheet, rewardRow, dailyRows);
  mergeCastRewardMonthlyCells(worksheet);
  styleCastRewardMonthlySheet(worksheet);
}

function applyCastRewardSheetLayout(worksheet) {
  const widths = {
    B: 3.375, C: 5.6875, D: 5.1875, E: 5.6875, F: 3.8125, G: excelWidthFromPixels(58),
    H: 6.375, I: 3.1875, J: 8.5, K: excelWidthFromPixels(58), L: 6.375, M: excelWidthFromPixels(58),
    N: 7.125, O: excelWidthFromPixels(52), P: 6.3125, Q: 6.6875, R: excelWidthFromPixels(100), S: 6.8125,
    T: 8.3125, U: 13.6875, V: 8.1875, W: 8.8125, X: 6.6875,
    Y: 3.6875, Z: 4, AA: 9.3125, AB: 6.1875, AC: 8.8125,
    AD: 8.875, AE: 7.1875, AF: 5.1875, AG: 5, AH: 6, AI: 13,
    AJ: 13, AK: 6, AL: 2.6875, AM: 6, AN: 2.6875, AO: 6
  };
  worksheet.columns = Array.from({ length: 41 }, (_, index) => {
    const letter = columnLetter(index + 1);
    return { width: widths[letter] || 3 };
  });
  worksheet.getRow(1).height = 16.8;
  for (let row = 2; row <= 35; row += 1) worksheet.getRow(row).height = 13.25;
  for (let row = 36; row <= 42; row += 1) worksheet.getRow(row).height = 14.45;
  worksheet.views = [{ showGridLines: false }];
}

function writeCastRewardHeader(worksheet, rewardRow, year, monthNumber) {
  worksheet.getCell("B1").value = `${year}年　${monthNumber}月分`;
  worksheet.getCell("G1").value = `【　${rewardRow.name}　】`;
  worksheet.getCell("J1").value = rewardRow.member?.entryDate ? `${shortDateSlash(rewardRow.member.entryDate)}～` : "";
  worksheet.getCell("O1").value = "出勤日数";
  worksheet.getCell("S1").value = rewardRow.days;
  worksheet.getCell("T1").value = "C/W\n料金-原価×(20%)";
  worksheet.getCell("U1").value = "【A】勤務時間";
  worksheet.getCell("X1").value = rewardRow.hours;
  worksheet.getCell("Z1").value = "時間";
  worksheet.getCell("AB1").value = "【B】時給";
  worksheet.getCell("AC1").value = rewardRow.hourlyRate || 0;
  worksheet.getCell("AD1").value = rewardRow.member?.introducerName || "";
  worksheet.getCell("AE1").value = castRewardSystemShortLabel(rewardRow.member?.rewardSystem);
  worksheet.getCell("AG1").value = { text: "目次へ戻る", hyperlink: "#'目次'!A1" };
}

function writeCastRewardColumnHeaders(worksheet) {
  const headers = {
    C2: "出勤", D2: "退勤", E2: "勤時間", F2: "組数", G2: "本指", H2: "バック",
    I2: "本🅿", J2: "本指売上", K2: "場内", L2: "バック", M2: "延長", N2: "場延売上",
    O2: "同伴", P2: "バック", Q2: "本指酒代", R2: "場内酒代", S2: "B(10%)",
    U2: "ボトル名", V2: "酒代計", W2: "日売上", X2: "ドリンク", Y2: "杯",
    Z2: "美容室", AA2: "売上給", AB2: "ｈ", AC2: "時給", AD2: "女子給",
    AE2: "日払い", AF2: "送迎", AG2: "立替", AH2: "減給", AI2: "欠勤",
    AJ2: "ポケパラ減給", AK2: "ポケパラ手当", AL2: "D", AM2: 500, AN2: "D", AO2: 300
  };
  Object.entries(headers).forEach(([address, value]) => {
    worksheet.getCell(address).value = value;
  });
}

function castRewardDailySheetValues(rewardRow, closing) {
  const sales = personRowFromMergedMap(mergeRowsByPersonKey(aggregateCastSales([closing]), "key"), rewardRow.key);
  const work = personRowFromMergedMap(mergeRowsByPersonKey(aggregateWork([closing], "castWork"), "id"), rewardRow.key);
  const backs = personRowFromMergedMap(
    mergeRowsByPersonKey(
      aggregateCastBacks([closing]).filter((row) => !isFormerTrialSource(findMember(castMembers, row.id, row.name), row.id)),
      "id"
    ),
    rewardRow.key
  ) || emptyCastBack(rewardRow.key, rewardRow.name);
  const deductions = personRowFromMergedMap(aggregatePersonDeductions([closing], castMembers, "cast"), rewardRow.key)
    || { transport: 0, dailyPayment: 0, advancePayment: 0, total: 0 };
  const shift = work?.shifts?.[0] || {};
  const hours = toNumber(work?.hours);
  const hourlyPay = rewardRow.calculationError ? 0 : Math.round(toNumber(rewardRow.hourlyRate) * hours);
  const beautyAllowance = castAllowanceAmount(closing, rewardRow, "美容室");
  const liquorCost = castLiquorCostBreakdown(closing, rewardRow);
  const salesReward = dailySalesRewardForCast(rewardRow, sales, liquorCost.total);
  const girlPay = hourlyPay + toNumber(backs.total) + beautyAllowance;
  return {
    day: Number(closing.businessDate.slice(8, 10)),
    startTime: shift.startTime || "",
    endTime: shift.endTime || "",
    timeText: hoursToClockText(hours),
    groupCount: countCastGroups(closing, rewardRow),
    honCount: toNumber(backs.honCount) || "",
    honBack: toNumber(backs.hon),
    honPoint: "",
    honSales: toNumber(sales?.honShimeiSales) || "",
    banaiCount: toNumber(backs.banaiCount) || "",
    banaiBack: toNumber(backs.banai),
    extensionCount: countBanaiExtensionGroups(closing, rewardRow) || "",
    extensionSales: toNumber(sales?.jonaiExtensionSales) || "",
    dohanCount: toNumber(backs.dohanCount) || "",
    dohanBack: toNumber(backs.dohan) || "",
    honLiquorCost: liquorCost.hon || "",
    banaiLiquorCost: liquorCost.banai || "",
    bottleBack: toNumber(backs.keepBottle) || "",
    bottleNames: castBottleNames(closing, rewardRow).join("、"),
    liquorCostTotal: liquorCost.total,
    dailySales: toNumber(sales?.totalAttributedSales),
    drinkBack: toNumber(backs.drink),
    drinkCount: countCastDrinkQuantity(closing, rewardRow) || "",
    beautyAllowance: beautyAllowance || "",
    salesReward,
    hours,
    hourlyRate: hours ? toNumber(rewardRow.hourlyRate) : 0,
    girlPay,
    dailyPayment: toNumber(deductions.dailyPayment) || "",
    transport: toNumber(deductions.transport) || "",
    advancePayment: toNumber(deductions.advancePayment) || "",
    payCut: "",
    absence: "",
    pokepalaPenalty: "",
    pokepalaAllowance: "",
    drinkLabel500: "",
    drinkAmount500: 0,
    drinkLabel300: "",
    drinkAmount300: 0
  };
}

function emptyCastRewardDailySheetValues(day) {
  return {
    day,
    startTime: "",
    endTime: "",
    timeText: "00:00",
    groupCount: "",
    honCount: "",
    honBack: 0,
    honPoint: "",
    honSales: "",
    banaiCount: "",
    banaiBack: 0,
    extensionCount: "",
    extensionSales: "",
    dohanCount: "",
    dohanBack: "",
    honLiquorCost: "",
    banaiLiquorCost: "",
    bottleBack: "",
    bottleNames: "",
    liquorCostTotal: 0,
    dailySales: 0,
    drinkBack: 0,
    drinkCount: "",
    beautyAllowance: "",
    salesReward: 0,
    hours: 0,
    hourlyRate: 0,
    girlPay: 0,
    dailyPayment: "",
    transport: "",
    advancePayment: "",
    payCut: "",
    absence: "",
    pokepalaPenalty: "",
    pokepalaAllowance: "",
    drinkLabel500: "",
    drinkAmount500: 0,
    drinkLabel300: "",
    drinkAmount300: 0
  };
}

function writeCastRewardDailyRow(worksheet, rowNumber, values) {
  const cells = {
    B: values.day, C: values.startTime, D: values.endTime, E: values.timeText, F: values.groupCount,
    G: values.honCount, H: values.honBack, I: values.honPoint, J: values.honSales,
    K: values.banaiCount, L: values.banaiBack, M: values.extensionCount, N: values.extensionSales,
    O: values.dohanCount, P: values.dohanBack, Q: values.honLiquorCost, R: values.banaiLiquorCost,
    S: values.bottleBack, U: values.bottleNames, V: values.liquorCostTotal, W: values.dailySales,
    X: values.drinkBack, Y: values.drinkCount, Z: values.beautyAllowance, AA: values.salesReward,
    AB: values.hours, AC: values.hourlyRate, AD: values.girlPay, AE: values.dailyPayment,
    AF: values.transport, AG: values.advancePayment, AH: values.payCut, AI: values.absence,
    AJ: values.pokepalaPenalty, AK: values.pokepalaAllowance, AL: values.drinkLabel500,
    AM: values.drinkAmount500, AN: values.drinkLabel300, AO: values.drinkAmount300
  };
  Object.entries(cells).forEach(([column, value]) => {
    worksheet.getCell(`${column}${rowNumber}`).value = value;
  });
}

function writeCastRewardTotals(worksheet, dailyRows) {
  worksheet.getCell("B34").value = "合計";
  const sum = (key) => dailyRows.reduce((total, row) => total + toNumber(row[key]), 0);
  const totals = {
    C: dailyRows.filter((row) => row.startTime).length,
    E: hoursToClockText(sum("hours")),
    G: sum("honCount"),
    H: sum("honBack"),
    I: 0,
    J: sum("honSales"),
    K: sum("banaiCount"),
    L: sum("banaiBack"),
    N: sum("extensionSales"),
    O: sum("dohanCount"),
    P: sum("dohanBack"),
    Q: sum("honLiquorCost"),
    R: sum("banaiLiquorCost"),
    S: sum("bottleBack"),
    T: 0,
    V: sum("liquorCostTotal"),
    W: sum("dailySales"),
    X: sum("drinkBack"),
    Y: sum("drinkCount"),
    Z: sum("beautyAllowance"),
    AA: sum("salesReward"),
    AB: sum("hours"),
    AC: 0,
    AD: sum("girlPay"),
    AE: sum("dailyPayment"),
    AG: sum("advancePayment"),
    AH: sum("payCut"),
    AI: sum("absence"),
    AJ: sum("pokepalaPenalty"),
    AK: sum("pokepalaAllowance"),
    AL: 0,
    AM: sum("drinkAmount500"),
    AN: 0,
    AO: sum("drinkAmount300")
  };
  Object.entries(totals).forEach(([column, value]) => {
    worksheet.getCell(`${column}34`).value = value;
  });
}

function writeCastRewardSummary(worksheet, rewardRow, dailyRows) {
  const sum = (key) => dailyRows.reduce((total, row) => total + toNumber(row[key]), 0);
  const hourlyTotal = sum("girlPay");
  const backTotal = sum("honBack") + sum("banaiBack") + sum("dohanBack") + sum("bottleBack") + sum("drinkBack");
  const allowanceTotal = sum("beautyAllowance") + sum("pokepalaAllowance");
  const deductionTotal = sum("dailyPayment") + sum("transport") + sum("advancePayment") + sum("payCut") + sum("pokepalaPenalty");
  const salesPayTotal = sum("salesReward");

  worksheet.getCell("D36").value = "①　時給　計";
  worksheet.getCell("J36").value = hourlyTotal;
  worksheet.getCell("T36").value = "①　 日売上　－　酒代（50％）　×　50％";
  worksheet.getCell("X36").value = salesPayTotal;
  worksheet.getCell("D37").value = "②　総バック　計";
  worksheet.getCell("J37").value = backTotal;
  worksheet.getCell("T37").value = "②　 美容室・手当て等";
  worksheet.getCell("X37").value = allowanceTotal;
  worksheet.getCell("AB37").value = "本指売上-本指酒代";
  worksheet.getCell("AD37").value = Math.max(0, toNumber(rewardRow.monthlyHonShimeiSales) - toNumber(rewardRow.backs?.champagneWineCost));
  worksheet.getCell("D38").value = "③　美容室・手当て等　";
  worksheet.getCell("J38").value = allowanceTotal;
  worksheet.getCell("T38").value = "③　　総支給額";
  worksheet.getCell("X38").value = salesPayTotal + allowanceTotal;
  worksheet.getCell("D39").value = "④　総支給額";
  worksheet.getCell("J39").value = hourlyTotal + allowanceTotal;
  worksheet.getCell("T39").value = "④　 日払い・その他";
  worksheet.getCell("X39").value = deductionTotal;
  worksheet.getCell("D40").value = "⑤　日払い・その他";
  worksheet.getCell("J40").value = deductionTotal;
  worksheet.getCell("T40").value = "（5）　源泉所得税";
  worksheet.getCell("D41").value = "（６）　源泉所得税";
  worksheet.getCell("T41").value = "③－④－(5)　＝  差引支給額";
  worksheet.getCell("W41").value = Math.max(0, salesPayTotal + allowanceTotal - deductionTotal);
  worksheet.getCell("D42").value = "④－⑤－（６）＝差引支給額";
  worksheet.getCell("J42").value = rewardRow.payable === null ? 0 : rewardRow.payable;
}

function mergeCastRewardMonthlyCells(worksheet) {
  [
    "B1:D1", "G1:I1", "T1:T2",
    "O1:P1",
    "AB37:AB38",
    "T36:V36", "T37:V37", "T38:V38", "T39:V39", "T40:V40", "T41:V41",
    "D36:I36", "D37:I37", "D38:I38", "D39:I39", "D40:I40", "D41:I41", "D42:I42",
    "J36:L36", "J37:L37", "J38:L38", "J39:L39", "J40:L40", "J41:L41", "J42:L42"
  ].forEach((range) => worksheet.mergeCells(range));
}

function styleCastRewardMonthlySheet(worksheet) {
  const headerFill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE5E7EB" } };
  const summaryFill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFC" } };
  for (let rowNumber = 1; rowNumber <= 42; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    row.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
      if (columnNumber < 2 || columnNumber > 41) return;
      cell.font = { name: "Yu Gothic", size: rowNumber === 1 ? 9 : 8 };
      cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
      cell.border = {
        top: { style: "thin", color: { argb: "FFD1D5DB" } },
        left: { style: "thin", color: { argb: "FFD1D5DB" } },
        bottom: { style: "thin", color: { argb: "FFD1D5DB" } },
        right: { style: "thin", color: { argb: "FFD1D5DB" } }
      };
      if (rowNumber <= 2 || rowNumber === 34) cell.fill = headerFill;
      if (rowNumber >= 35) cell.fill = summaryFill;
      if (typeof cell.value === "number") cell.numFmt = '#,##0';
    });
  }
  ["B1", "G1", "U1", "AB1"].forEach((address) => {
    worksheet.getCell(address).font = { name: "Yu Gothic", size: 10, bold: true };
  });
  worksheet.getCell("AG1").font = { name: "Yu Gothic", size: 8, color: { argb: "FF2563EB" }, underline: true };
  worksheet.getCell("T1").font = { name: "Yu Gothic", size: 7 };
  worksheet.pageSetup.printArea = "B1:AO42";
}

function styleCastRewardHeaderCell(cell) {
  cell.font = { name: "Yu Gothic", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF334155" } };
  cell.alignment = { horizontal: "center", vertical: "middle" };
}

function personRowFromMergedMap(map, key) {
  return map.get(String(key)) || null;
}

function dailySalesRewardForCast(rewardRow, sales, champagneWineCost) {
  if (!rewardRow.salesRewardRate || rewardRow.salesReward <= toNumber(rewardRow.hourlyAndBack)) return 0;
  const base = salesRewardBaseAfterLiquorCost(toNumber(sales?.totalAttributedSales), toNumber(champagneWineCost));
  return Math.floor(base * rewardRow.salesRewardRate);
}

function castAllowanceAmount(closing, rewardRow, type) {
  return closing.allowances
    .filter((row) => row.type === type)
    .filter((row) => castRewardPersonMatches(rewardRow, row.recipientId || row.personId || row.posCastId, row.recipientName || row.recipient || row.name))
    .reduce((sum, row) => sum + toNumber(row.amount), 0);
}

function countCastGroups(closing, rewardRow) {
  return closing.transactions.filter((transaction) =>
    transaction.items.some((item) =>
      castRewardPersonMatches(rewardRow, item.castId, item.castName || item.name)
      || castRewardPersonMatches(rewardRow, item.banaiExtCastId, item.banaiExtCastName)
      || item.banaiExtCastIds.some((id) => castRewardPersonMatches(rewardRow, id, castNameForId(id)))
    )
  ).length;
}

function countBanaiExtensionGroups(closing, rewardRow) {
  return closing.transactions.filter((transaction) =>
    transaction.items.some((item) =>
      castRewardPersonMatches(rewardRow, item.banaiExtCastId, item.banaiExtCastName)
      || item.banaiExtCastIds.some((id) => castRewardPersonMatches(rewardRow, id, castNameForId(id)))
    )
  ).length;
}

function castBottleNames(closing, rewardRow) {
  const names = new Set();
  closing.transactions.forEach((transaction) => {
    const honCastIds = honCastIdsForTransaction(transaction);
    if (honCastIds.length) {
      if (!honCastIds.some((id) => castRewardPersonMatches(rewardRow, id, castNameForId(id)))) return;
      transaction.items
        .filter((item) => ["keepBottle", "champagneWine", "champagne", "wine"].includes(item.category))
        .forEach((item) => names.add(item.label || item.name || transactionItemCategoryLabel(item.category)));
      return;
    }
    let currentCastIds = [];
    transaction.items.forEach((item) => {
      if (item.isBanaiExtension) currentCastIds = banaiExtensionCastIdsForItem(item);
      if (!currentCastIds.some((id) => castRewardPersonMatches(rewardRow, id, castNameForId(id)))) return;
      if (!["keepBottle", "champagneWine", "champagne", "wine"].includes(item.category)) return;
      names.add(item.label || item.name || transactionItemCategoryLabel(item.category));
    });
  });
  return [...names];
}

function castLiquorCostBreakdown(closing, rewardRow) {
  const result = { hon: 0, banai: 0, total: 0 };
  closing.transactions.forEach((transaction) => {
    const honCastIds = honCastIdsForTransaction(transaction);
    if (honCastIds.length) {
      if (!honCastIds.some((id) => castRewardPersonMatches(rewardRow, id, castNameForId(id)))) return;
      const costTotal = transaction.items.reduce((sum, item) => sum + champagneWineItemCost(item), 0);
      result.hon += Math.floor(costTotal / honCastIds.length);
      return;
    }
    let currentCastIds = [];
    transaction.items.forEach((item) => {
      if (item.isBanaiExtension) currentCastIds = banaiExtensionCastIdsForItem(item);
      if (!currentCastIds.length || item.isDiscount) return;
      const cost = champagneWineItemCost(item);
      if (!cost) return;
      if (!currentCastIds.some((id) => castRewardPersonMatches(rewardRow, id, castNameForId(id)))) return;
      result.banai += Math.floor(cost / currentCastIds.length);
    });
  });
  result.total = result.hon + result.banai;
  return result;
}

function champagneWineItemCost(item) {
  if (!["champagneWine", "champagne", "wine"].includes(item.category)) return 0;
  const costRecord = liquorCostForItem(item);
  return costRecord ? toNumber(costRecord.costAmount) * toNumber(item.quantity) : 0;
}

function banaiExtensionCastIdsForItem(item) {
  return [...new Set([
    ...item.banaiExtCastIds,
    item.banaiExtCastId,
    item.castId
  ].filter(Boolean).map(String))];
}

function countCastDrinkQuantity(closing, rewardRow) {
  return closing.transactions.reduce((total, transaction) => total + transaction.items
    .filter((item) => item.category === "castDrink")
    .filter((item) => castRewardPersonMatches(rewardRow, item.castId, item.castName || item.name))
    .reduce((sum, item) => sum + toNumber(item.quantity), 0), 0);
}

function honCastIdsForTransaction(transaction) {
  return [...new Set(transaction.items.filter((item) => item.isHonShimei && item.castId).map((item) => String(item.castId)))];
}

function castRewardPersonMatches(rewardRow, rawId, rawName) {
  const member = findMember(castMembers, rawId, rawName);
  const key = member && shouldMapMemberForReward(member, rawId)
    ? member.personKey || member.id
    : String(rawId || rawName || "");
  return String(rewardRow.key) === String(key)
    || String(rewardRow.member?.id || "") === String(rawId || "")
    || String(rewardRow.member?.posCastId || "") === String(rawId || "")
    || (rawName && (rawName === rewardRow.name || rawName === rewardRow.member?.name));
}

function castRewardSystemShortLabel(value) {
  return value === "guaranteedHourly" ? "保証" : value === "slideHourly" ? "スライド" : "";
}

function shortDateSlash(value) {
  const text = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  return `${text.slice(2, 4)}/${text.slice(5, 7)}/${text.slice(8, 10)}`;
}

function hoursToClockText(hours) {
  const totalMinutes = Math.round(toNumber(hours) * 60);
  const hour = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function columnLetter(columnNumber) {
  let number = columnNumber;
  let letter = "";
  while (number > 0) {
    const remainder = (number - 1) % 26;
    letter = String.fromCharCode(65 + remainder) + letter;
    number = Math.floor((number - 1) / 26);
  }
  return letter;
}

function excelWidthFromPixels(pixels) {
  return Math.round(((toNumber(pixels) - 5) / 7) * 100) / 100;
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
  const query = searchQuery("introducerFeeSearch");
  const rows = calculateIntroducerFeeRows(calculateCastRewardRows()).filter((row) =>
    nameMatches(query, row.castName, row.introducerName)
  );
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
  body.appendChild(createTableBlock("送迎代控除", ["対象者", "区分", "金額"], closing.transportDeductions, (row) => [
    row.personName, personTypeLabel(row.personType), yenCell(row.amount)
  ]));
  body.appendChild(createTableBlock("報酬・給与引き", ["対象者", "区分", "日払い", "立替金"], closing.payrollDeductions, (row) => [
    row.personName, personTypeLabel(row.personType), yenCell(row.dailyPayment), yenCell(row.advancePayment)
  ]));
  body.appendChild(createTableBlock("スタッフ勤務", ["スタッフ", "開始", "終了", "勤務時間"], closing.staffWork, (row) => [
    row.name, row.startTime || "", row.endTime || "", hoursCell(row.hours)
  ]));
  body.appendChild(createTableBlock("キャスト勤務", ["キャスト", "開始", "終了", "勤務時間"], closing.castWork, (row) => [
    row.name, row.startTime || "", row.endTime || "", hoursCell(row.hours)
  ]));
  body.appendChild(createTableBlock("体入キャスト勤務", ["体入キャスト", "開始", "終了", "勤務時間", "紹介者", "当日時給", "報酬"], closing.trialWork, (row) => [
    trialCastDisplayName(row), row.startTime || "", row.endTime || "", hoursCell(row.hours), row.introducerName || "", yenCell(row.hourlyRate), yenCell(row.hours * row.hourlyRate)
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

async function exportExpenseSheetXlsx() {
  const ExcelJS = globalThis.ExcelJS;
  if (!ExcelJS) {
    showMessage("errorMessage", "XLSX出力機能を読み込めませんでした。ページを再読み込みしてください。");
    return;
  }
  const month = byId("fixedExpenseMonth").value;
  if (!/^\d{4}-\d{2}$/.test(month)) {
    showMessage("errorMessage", "経費表の対象月を選択してください。");
    return;
  }
  const button = byId("exportExpenseSheetXlsxButton");
  button.disabled = true;
  hideMessage("errorMessage");
  hideMessage("successMessage");
  try {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "GENESIS Management System";
    workbook.created = new Date();
    const worksheet = workbook.addWorksheet("ジェネシス経費表", {
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
    buildExpenseSheet(worksheet, month);
    const buffer = await workbook.xlsx.writeBuffer();
    downloadXlsx(buffer, `genesis_expenses_${month.replace("-", "")}.xlsx`);
    showMessage("successMessage", "経費表XLSXを出力しました。", false);
  } catch (error) {
    showMessage("errorMessage", `経費表XLSXを出力できませんでした。${error.message}`);
  } finally {
    button.disabled = false;
  }
}

function buildExpenseSheet(worksheet, month) {
  const [year, monthNumber] = month.split("-").map(Number);
  const monthClosings = finalizedClosings.filter((closing) => closing.businessDate.startsWith(`${month}-`));
  const fixed = fixedExpenseForMonth(month);
  const rewardRows = calculateCastRewardRows(monthClosings);
  const staffRows = calculateStaffPayrollRows(monthClosings, month);
  const introducerRows = calculateIntroducerFeeRows(rewardRows);
  const categories = [
    ["B", "C", "酒代"],
    ["D", "E", "広告宣伝①"],
    ["F", "G", "広告宣伝②"],
    ["H", "I", "消耗品/備品"],
    ["J", "K", "交際費"],
    ["L", "M", "交通費"],
    ["N", "O", "その他"],
    ["P", "Q", "美容室"]
  ];
  const maxDay = new Date(year, monthNumber, 0).getDate();
  const dailyExpenseMap = new Map();
  monthClosings.forEach((closing) => {
    const day = Number(closing.businessDate.slice(8, 10));
    if (!dailyExpenseMap.has(day)) dailyExpenseMap.set(day, {});
    const bucket = dailyExpenseMap.get(day);
    closing.expenses.forEach((expense) => {
      const category = expense.category || "その他";
      bucket[category] = (bucket[category] || 0) + toNumber(expense.amount);
    });
  });

  worksheet.columns = [
    { width: 6 }, { width: 16 }, { width: 12 }, { width: 16 }, { width: 12 }, { width: 16 }, { width: 12 },
    { width: 16 }, { width: 12 }, { width: 16 }, { width: 12 }, { width: 16 }, { width: 12 }, { width: 16 },
    { width: 12 }, { width: 16 }, { width: 12 }, { width: 14 }
  ];
  worksheet.views = [{ showGridLines: false }];
  worksheet.getCell("A1").value = "ジェネシス経費表";
  worksheet.getCell("A1").font = { name: "Yu Gothic", size: 16, bold: true };
  worksheet.getCell("G1").value = `${year}年`;
  worksheet.getCell("H1").value = `${monthNumber}月度`;
  worksheet.getCell("J1").value = "";
  worksheet.getCell("A2").value = "日";
  categories.forEach(([labelCol, amountCol, label]) => {
    worksheet.getCell(`${labelCol}2`).value = label;
    worksheet.getCell(`${amountCol}2`).value = "金額";
  });
  worksheet.getCell("R2").value = "合計";

  for (let day = 1; day <= 31; day += 1) {
    const rowNumber = day + 2;
    const bucket = dailyExpenseMap.get(day) || {};
    worksheet.getCell(`A${rowNumber}`).value = day;
    categories.forEach(([labelCol, amountCol, label]) => {
      const amount = day <= maxDay ? toNumber(bucket[label]) : 0;
      worksheet.getCell(`${labelCol}${rowNumber}`).value = amount > 0 ? label : "";
      worksheet.getCell(`${amountCol}${rowNumber}`).value = amount;
    });
    worksheet.getCell(`R${rowNumber}`).value = { formula: `SUM(C${rowNumber},E${rowNumber},G${rowNumber},I${rowNumber},K${rowNumber},M${rowNumber},O${rowNumber},Q${rowNumber})` };
  }

  categories.forEach(([labelCol, amountCol]) => {
    worksheet.getCell(`${labelCol}34`).value = "合計";
    worksheet.getCell(`${amountCol}34`).value = { formula: `SUM(${amountCol}3:${amountCol}33)` };
  });
  worksheet.getCell("P34").value = "変動費合計";
  worksheet.getCell("R34").value = { formula: "C34+E34+G34+I34+K34+M34+O34+Q34" };
  worksheet.getCell("A35").value = "日";
  worksheet.getCell("B35").value = "固定費";
  worksheet.getCell("C35").value = "金額";
  const fixedRows = [
    [36, "賃料", toNumber(fixed.rent)],
    [37, "カラオケ", toNumber(fixed.karaoke)],
    [38, "おしぼり", toNumber(fixed.towel)],
    [39, "リースキン", toNumber(fixed.leasekin)],
    [40, "固定電話", toNumber(fixed.landline)],
    [41, "西部ガス", toNumber(fixed.saibuGas)],
    [42, "USEN", toNumber(fixed.usen)],
    [43, "酒代", alcoholExpenseForMonth(month, monthClosings)],
    [44, "カード決済手数料", cardSettlementFeeForMonth(monthClosings)]
  ];
  fixedRows.forEach(([row, label, amount]) => {
    worksheet.getCell(`B${row}`).value = label;
    worksheet.getCell(`C${row}`).value = amount;
  });
  worksheet.getCell("B45").value = "固定費合計";
  worksheet.getCell("C45").value = { formula: "SUM(C36:C44)" };

  const castHourlyTotal = rewardRows.reduce((sum, row) => sum + (row.salesReward > row.hourlyAndBack ? 0 : toNumber(row.hourlyAndBackWithTrial ?? row.hourlyAndBack)), 0);
  const castSalesRewardTotal = rewardRows.reduce((sum, row) => sum + (row.salesReward > row.hourlyAndBack ? toNumber(row.salesRewardWithTrial) : 0), 0);
  const dispatchPayTotal = 0;
  worksheet.getCell("F35").value = "人件費";
  worksheet.getCell("G35").value = "金額";
  worksheet.mergeCells("F36:G36");
  worksheet.getCell("F36").value = "女子総支給額";
  worksheet.getCell("F37").value = "時給";
  worksheet.getCell("G37").value = castHourlyTotal;
  worksheet.getCell("F38").value = "売上報酬";
  worksheet.getCell("G38").value = castSalesRewardTotal;
  worksheet.getCell("F40").value = "派遣給与";
  worksheet.getCell("G40").value = dispatchPayTotal;
  worksheet.getCell("F45").value = "女子給合計";
  worksheet.getCell("G45").value = { formula: "SUM(G37:G44)" };

  const staffPayrollTotal = staffRows.reduce((sum, row) => sum + (row.isEmployee ? 0 : toNumber(row.payable)), 0);
  worksheet.getCell("H35").value = "人件費";
  worksheet.getCell("I35").value = "金額";
  worksheet.mergeCells("H36:K36");
  worksheet.getCell("H36").value = "従業員給与";
  worksheet.mergeCells("H45:I45");
  worksheet.getCell("H45").value = "従業員給合計";
  worksheet.getCell("J45").value = staffPayrollTotal;

  const introductionFeeTotal = introducerRows.reduce((sum, row) => sum + toNumber(row.introductionFee), 0);
  const advisoryFeeTotal = introducerRows.reduce((sum, row) => sum + toNumber(row.advisoryFee), 0);
  const transportAllowanceTotal = monthClosings.reduce((total, closing) => total + closing.allowances
    .filter((row) => row.type === "送迎手当")
    .reduce((sum, row) => sum + toNumber(row.amount), 0), 0);
  worksheet.mergeCells("L35:O35");
  worksheet.getCell("L35").value = "スカウト報酬";
  worksheet.getCell("L36").value = "紹介料";
  worksheet.getCell("M36").value = introductionFeeTotal;
  worksheet.getCell("N36").value = "顧問料";
  worksheet.getCell("O36").value = advisoryFeeTotal;
  worksheet.mergeCells("L41:O41");
  worksheet.getCell("L41").value = "送迎";
  worksheet.getCell("L42").value = "送迎手当";
  worksheet.getCell("M42").value = transportAllowanceTotal;
  worksheet.getCell("R35").value = { formula: "R34+M36+O36+M42" };

  worksheet.mergeCells("P43:R44");
  worksheet.getCell("P43").value = "総支出合計";
  worksheet.mergeCells("P45:R45");
  worksheet.getCell("P45").value = { formula: "SUM(R35+C45+G45+J45)" };

  styleExpenseSheet(worksheet);
}

function cardSettlementFeeForMonth(closings) {
  return closings.reduce((total, closing) => total + closing.expenses
    .filter((expense) => ["カード決済手数料", "カード手数料", "決済手数料"].includes(expense.category))
    .reduce((sum, expense) => sum + toNumber(expense.amount), 0), 0);
}

function styleExpenseSheet(worksheet) {
  const headerFill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2E8F0" } };
  const sectionFill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFC" } };
  const border = {
    top: { style: "thin", color: { argb: "FFCBD5E1" } },
    left: { style: "thin", color: { argb: "FFCBD5E1" } },
    bottom: { style: "thin", color: { argb: "FFCBD5E1" } },
    right: { style: "thin", color: { argb: "FFCBD5E1" } }
  };
  for (let row = 1; row <= 45; row += 1) {
    worksheet.getRow(row).height = row === 1 ? 24 : 21;
    for (let col = 1; col <= 18; col += 1) {
      const cell = worksheet.getRow(row).getCell(col);
      cell.font = { name: "Yu Gothic", size: row === 1 ? 12 : 10, bold: row <= 2 || row === 34 || row === 35 || row === 45 };
      cell.alignment = { horizontal: col === 1 || col % 2 === 0 ? "center" : "right", vertical: "middle", wrapText: true };
      cell.border = border;
      if ([2, 35].includes(row)) cell.fill = headerFill;
      if ([34, 36, 41, 43, 44, 45].includes(row)) cell.fill = sectionFill;
      if ([3, 5, 7, 9, 11, 13, 15, 17, 18].includes(col)) cell.numFmt = '#,##0';
    }
  }
  ["F36", "H36", "L35", "L41", "P34", "P43", "P45"].forEach((cellRef) => {
    worksheet.getCell(cellRef).alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    worksheet.getCell(cellRef).font = { name: "Yu Gothic", size: 10, bold: true };
  });
  worksheet.getCell("A1").alignment = { horizontal: "left", vertical: "middle" };
  worksheet.pageSetup.printArea = "A1:R45";
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
  const deductionMap = aggregatePersonDeductions([closing], castMembers, "cast");
  const keys = new Set([...salesMap.keys(), ...workMap.keys(), ...backMap.keys(), ...trialCompMap.keys(), ...deductionMap.keys()]);
  let hourlyAndBack = 0;
  let salesReward = 0;

  keys.forEach((key) => {
    const decision = decisions.get(key);
    if (!decision || decision.calculationError) return;
    const sales = salesMap.get(key) || {};
    const work = workMap.get(key) || {};
    const backs = backMap.get(key) || {};
    const trialComp = trialCompMap.get(key) || {};
    const deductions = deductionMap.get(key) || { total: 0 };
    const trialPay = toNumber(trialComp.pay);
    if (decision.mode === "sales") {
      const rewardBase = salesRewardBaseAfterLiquorCost(sales.totalAttributedSales, backs.champagneWineCost);
      salesReward += Math.max(0, Math.floor(rewardBase * decision.salesRewardRate) - deductions.total);
      hourlyAndBack += trialPay;
      return;
    }
    hourlyAndBack += Math.max(0, Math.round(decision.hourlyRate * toNumber(work.hours)) + toNumber(backs.total) + trialPay - deductions.total);
  });

  hourlyAndBack += calculateTrialCastRewardRows([closing]).reduce((sum, row) => sum + toNumber(row.payable), 0);
  return { hourlyAndBack, salesReward };
}

function dailyNonEmployeeStaffPay(closing) {
  const deductionMap = aggregatePersonDeductions([closing], staffMembers, "staff");
  return closing.staffWork.reduce((total, row) => {
    const member = findMember(staffMembers, row.id, row.name);
    if (member?.employmentType === "employee") return total;
    const payType = row.payType || member?.payType || "";
    const payAmount = toNumber(row.payAmount || member?.payAmount);
    const basePay = payType === "hourly"
      ? Math.round(payAmount * toNumber(row.hours))
      : payType === "daily" ? payAmount : 0;
    const deductions = deductionMap.get(member?.id || row.id) || { total: 0 };
    return total + Math.max(0, basePay - deductions.total);
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
    tax: toNumber(row.tax),
    total: toNumber(row.total),
    items: Array.isArray(row.items) ? row.items.map((item) => ({
      itemId: String(item.itemId || item.id || ""),
      label: String(item.label || ""),
      category: transactionItemCategory(item),
      price: toNumber(item.price),
      quantity: toNumber(item.quantity ?? item.qty),
      castId: String(item.castId || ""),
      castName: String(item.castName || ""),
      banaiExtCastIds: Array.isArray(item.banaiExtCastIds) ? item.banaiExtCastIds.map(String) : [],
      banaiExtCastId: String(item.banaiExtCastId || ""),
      backTargetCastIds: Array.isArray(item.backTargetCastIds) ? item.backTargetCastIds.map(String) : [],
      backTargetCastNames: Array.isArray(item.backTargetCastNames) ? item.backTargetCastNames.map(String) : [],
      backType: String(item.backType || ""),
      backAllocation: String(item.backAllocation || ""),
      isSet: Boolean(item.isSet),
      isHonShimei: Boolean(item.isHonShimei),
      isBanaiShimei: Boolean(item.isBanaiShimei),
      isExtension: Boolean(item.isExtension),
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
    internalNo: toNumber(row.internalNo),
    trialBizDay: String(row.trialBizDay || ""),
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
