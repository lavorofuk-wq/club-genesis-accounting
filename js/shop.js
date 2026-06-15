import {
  db,
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
  reportsCollectionName
} from "./firebase-config.js";
import { requireRole, logout, showMessage, hideMessage } from "./auth.js";

const yen = new Intl.NumberFormat("ja-JP");
const staffKeys = ["manager", "bartender", "kitchen", "cleaning", "other"];
let currentUser = null;
let pendingPayload = null;
let isSaving = false;

document.getElementById("logoutButton").addEventListener("click", logout);
document.getElementById("addCastButton").addEventListener("click", () => addCastRow());
document.getElementById("addExpenseButton").addEventListener("click", () => addExpenseRow());
document.getElementById("addAllowanceButton").addEventListener("click", () => addAllowanceRow());
document.getElementById("copyPreviousButton").addEventListener("click", copyPreviousDay);
document.getElementById("saveButton").addEventListener("click", openConfirm);
document.getElementById("confirmSaveButton").addEventListener("click", saveReport);

requireRole("shop", (user) => {
  currentUser = user;
  document.getElementById("reportForm").classList.remove("hidden");
  document.getElementById("date").value = todayString();
  addCastRow();
  addExpenseRow();
  addAllowanceRow();
  wireRealtimeValidation();
  calculateUnitPrice();
});

function todayString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function previousDateString(dateString) {
  const d = new Date(`${dateString}T12:00:00`);
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function numberValue(id) {
  return Number(document.getElementById(id).value || 0);
}

function textValue(id) {
  return document.getElementById(id).value.trim();
}

function isHalfHour(value) {
  return Number.isFinite(value) && value >= 0 && value <= 24 && Math.round(value * 2) === value * 2;
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function markInvalid(el, invalid) {
  el.classList.toggle("invalid", invalid);
}

function makeOption(value, label) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  return option;
}

function addCastRow(data = {}) {
  const row = document.createElement("div");
  row.className = "dynamic-row cast-row";

  const name = document.createElement("input");
  name.type = "text";
  name.maxLength = 40;
  name.placeholder = "キャスト名";
  name.className = "form-input cast-name";
  name.value = data.castName || "";

  const hours = document.createElement("input");
  hours.type = "number";
  hours.min = "0";
  hours.max = "24";
  hours.step = "0.5";
  hours.placeholder = "時間";
  hours.className = "form-input cast-hours";
  hours.value = data.hours ?? 0;

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "danger-button";
  remove.textContent = "削除";
  remove.addEventListener("click", () => row.remove());

  row.append(name, hours, remove);
  document.getElementById("castRows").appendChild(row);
}

function addExpenseRow(data = {}) {
  const row = document.createElement("div");
  row.className = "dynamic-row expense-row";

  const category = document.createElement("select");
  category.className = "form-select expense-category";
  ["家賃", "水光熱", "酒代", "広告", "人件費", "雑費"].forEach((item) => category.appendChild(makeOption(item, item)));
  category.value = data.category || "雑費";

  const amount = document.createElement("input");
  amount.type = "number";
  amount.min = "0";
  amount.step = "1";
  amount.className = "form-input expense-amount";
  amount.value = data.amount ?? 0;

  const note = document.createElement("input");
  note.type = "text";
  note.maxLength = 120;
  note.placeholder = "メモ";
  note.className = "form-input expense-note";
  note.value = data.note || "";

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "danger-button";
  remove.textContent = "削除";
  remove.addEventListener("click", () => row.remove());

  row.append(category, amount, note, remove);
  document.getElementById("expenseRows").appendChild(row);
}

function addAllowanceRow(data = {}) {
  const row = document.createElement("div");
  row.className = "dynamic-row allowance-row";

  const type = document.createElement("select");
  type.className = "form-select allowance-type";
  ["夜手当", "役職手当", "交通費", "その他"].forEach((item) => type.appendChild(makeOption(item, item)));
  type.value = data.type || "夜手当";

  const amount = document.createElement("input");
  amount.type = "number";
  amount.min = "0";
  amount.step = "1";
  amount.className = "form-input allowance-amount";
  amount.value = data.amount ?? 0;

  const recipient = document.createElement("input");
  recipient.type = "text";
  recipient.maxLength = 60;
  recipient.placeholder = "支給対象者";
  recipient.className = "form-input allowance-recipient";
  recipient.value = data.recipient || "";

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "danger-button";
  remove.textContent = "削除";
  remove.addEventListener("click", () => row.remove());

  row.append(type, amount, recipient, remove);
  document.getElementById("allowanceRows").appendChild(row);
}

function wireRealtimeValidation() {
  document.getElementById("reportForm").addEventListener("input", (event) => {
    if (event.target.matches("input[type='number']")) validateNumberInput(event.target);
    if (["totalSales", "cashSales", "cardSales", "totalCustomers"].includes(event.target.id)) {
      calculateUnitPrice();
      checkSalesWarning();
    }
  });
  document.getElementById("date").addEventListener("change", () => {
    const date = textValue("date");
    markInvalid(document.getElementById("date"), !date || date > todayString());
  });
}

function validateNumberInput(el) {
  const value = Number(el.value || 0);
  const isHour = el.matches("[data-staff], .cast-hours");
  const invalid = isHour ? !isHalfHour(value) : value < 0 || !Number.isInteger(value);
  markInvalid(el, invalid);
}

function calculateUnitPrice() {
  const totalSales = numberValue("totalSales");
  const customers = numberValue("totalCustomers");
  const unitPrice = customers > 0 ? Math.floor(totalSales / customers) : 0;
  document.getElementById("customerUnitPrice").value = yen.format(unitPrice);
}

function checkSalesWarning() {
  const totalSales = numberValue("totalSales");
  const paymentTotal = numberValue("cashSales") + numberValue("cardSales");
  const warning = document.getElementById("warningBanner");
  if (paymentTotal > totalSales) {
    warning.textContent = "現金会計売上＋カード会計売上が総売上を超過しています。保存は可能ですが、内容を確認してください。";
    warning.classList.remove("hidden");
  } else {
    warning.classList.add("hidden");
  }
}

function collectRows() {
  const castHours = [...document.querySelectorAll(".cast-row")]
    .map((row) => ({
      castName: row.querySelector(".cast-name").value.trim(),
      hours: Number(row.querySelector(".cast-hours").value || 0)
    }))
    .filter((row) => row.castName || row.hours > 0);

  const expenses = [...document.querySelectorAll(".expense-row")]
    .map((row) => ({
      category: row.querySelector(".expense-category").value,
      amount: Number(row.querySelector(".expense-amount").value || 0),
      note: row.querySelector(".expense-note").value.trim()
    }))
    .filter((row) => row.amount > 0 || row.note);

  const allowances = [...document.querySelectorAll(".allowance-row")]
    .map((row) => ({
      type: row.querySelector(".allowance-type").value,
      amount: Number(row.querySelector(".allowance-amount").value || 0),
      recipient: row.querySelector(".allowance-recipient").value.trim()
    }))
    .filter((row) => row.amount > 0 || row.recipient);

  return { castHours, expenses, allowances };
}

function buildPayload() {
  const date = textValue("date");
  const totalSales = numberValue("totalSales");
  const totalCustomers = numberValue("totalCustomers");
  const rows = collectRows();

  const payload = {
    reportId: date,
    date,
    staffHours: {
      manager: numberFromStaff("manager"),
      bartender: numberFromStaff("bartender"),
      kitchen: numberFromStaff("kitchen"),
      cleaning: numberFromStaff("cleaning"),
      other: numberFromStaff("other"),
      otherDetail: textValue("otherDetail")
    },
    castHours: rows.castHours,
    totalSales,
    cashSales: numberValue("cashSales"),
    cardSales: numberValue("cardSales"),
    groupCount: numberValue("groupCount"),
    totalCustomers,
    customerUnitPrice: totalCustomers > 0 ? Math.floor(totalSales / totalCustomers) : 0,
    shimeiInfo: {
      honShimei: numberValue("honShimei"),
      jonai: numberValue("jonai")
    },
    expenses: rows.expenses,
    allowances: rows.allowances,
    submittedBy: currentUser.uid,
    submittedEmail: currentUser.email || "",
    updatedAt: serverTimestamp()
  };
  payload["指名情報"] = { ...payload.shimeiInfo };
  return payload;
}

function numberFromStaff(key) {
  return Number(document.querySelector(`[data-staff="${key}"]`).value || 0);
}

function validatePayload(payload) {
  const errors = [];
  if (!payload.date) errors.push("日付を入力してください。");
  if (payload.date > todayString()) errors.push("未来の日付は保存できません。");
  staffKeys.forEach((key) => {
    if (!isHalfHour(payload.staffHours[key])) errors.push("スタッフ労働時間は0〜24時間、0.5単位で入力してください。");
  });
  payload.castHours.forEach((row) => {
    if (!row.castName) errors.push("キャスト名を入力してください。");
    if (!isHalfHour(row.hours)) errors.push("キャスト労働時間は0〜24時間、0.5単位で入力してください。");
  });
  ["totalSales", "cashSales", "cardSales", "groupCount", "totalCustomers"].forEach((key) => {
    if (!isNonNegativeInteger(payload[key])) errors.push("売上・客数は0以上の整数で入力してください。");
  });
  ["honShimei", "jonai"].forEach((key) => {
    if (!isNonNegativeInteger(payload.shimeiInfo[key])) errors.push("指名件数は0以上の整数で入力してください。");
  });
  payload.expenses.forEach((row) => {
    if (!row.category || !isNonNegativeInteger(row.amount)) errors.push("経費のカテゴリと金額を確認してください。");
  });
  payload.allowances.forEach((row) => {
    if (!row.type || !isNonNegativeInteger(row.amount) || !row.recipient) errors.push("手当の種類、金額、支給対象者を確認してください。");
  });
  return [...new Set(errors)];
}

function openConfirm() {
  hideMessage("errorMessage");
  hideMessage("successMessage");
  checkSalesWarning();
  pendingPayload = buildPayload();
  const errors = validatePayload(pendingPayload);
  if (errors.length) {
    showMessage("errorMessage", errors.join("\n"));
    return;
  }

  const expenseTotal = pendingPayload.expenses.reduce((sum, row) => sum + row.amount, 0);
  const allowanceTotal = pendingPayload.allowances.reduce((sum, row) => sum + row.amount, 0);
  const summary = document.getElementById("confirmSummary");
  summary.replaceChildren();
  [
    `日付：${pendingPayload.date}`,
    `総売上：${yen.format(pendingPayload.totalSales)}円`,
    `現金：${yen.format(pendingPayload.cashSales)}円 / カード：${yen.format(pendingPayload.cardSales)}円`,
    `総客数：${pendingPayload.totalCustomers}名 / 客単価：${yen.format(pendingPayload.customerUnitPrice)}円`,
    `経費合計：${yen.format(expenseTotal)}円 / 手当合計：${yen.format(allowanceTotal)}円`
  ].forEach((text) => {
    const p = document.createElement("p");
    p.textContent = text;
    summary.appendChild(p);
  });
  document.getElementById("confirmModal").showModal();
}

async function saveReport(event) {
  event.preventDefault();
  if (isSaving || !pendingPayload) return;
  isSaving = true;
  document.getElementById("saveButton").disabled = true;
  document.getElementById("confirmSaveButton").disabled = true;

  try {
    const reportRef = doc(db, reportsCollectionName, pendingPayload.reportId);
    const existing = await getDoc(reportRef);
    const payload = {
      ...pendingPayload,
      submittedAt: existing.exists() ? existing.data().submittedAt : serverTimestamp()
    };
    await setDoc(reportRef, payload, { merge: true });
    document.getElementById("confirmModal").close();
    showMessage("successMessage", "保存しました。", false);
  } catch (error) {
    showMessage("errorMessage", `保存に失敗しました。${error.message}`);
  } finally {
    isSaving = false;
    document.getElementById("saveButton").disabled = false;
    document.getElementById("confirmSaveButton").disabled = false;
  }
}

async function copyPreviousDay() {
  hideMessage("errorMessage");
  hideMessage("successMessage");
  const date = textValue("date");
  if (!date) {
    showMessage("errorMessage", "先に日付を入力してください。");
    return;
  }

  try {
    const snap = await getDoc(doc(db, reportsCollectionName, previousDateString(date)));
    if (!snap.exists()) {
      showMessage("errorMessage", "前日のデータが見つかりません。");
      return;
    }
    applyReportToForm({ ...snap.data(), date });
    showMessage("successMessage", "前日のデータをコピーしました。保存するまでFirestoreには反映されません。", false);
  } catch (error) {
    showMessage("errorMessage", `前日データの取得に失敗しました。${error.message}`);
  }
}

function applyReportToForm(data) {
  document.getElementById("date").value = data.date;
  staffKeys.forEach((key) => {
    document.querySelector(`[data-staff="${key}"]`).value = data.staffHours?.[key] ?? 0;
  });
  document.getElementById("otherDetail").value = data.staffHours?.otherDetail || "";
  ["totalSales", "cashSales", "cardSales", "groupCount", "totalCustomers"].forEach((id) => {
    document.getElementById(id).value = data[id] ?? 0;
  });
  const shimei = data.shimeiInfo || data["指名情報"] || {};
  document.getElementById("honShimei").value = shimei.honShimei ?? 0;
  document.getElementById("jonai").value = shimei.jonai ?? 0;

  document.getElementById("castRows").replaceChildren();
  (data.castHours?.length ? data.castHours : [{}]).forEach(addCastRow);
  document.getElementById("expenseRows").replaceChildren();
  (data.expenses?.length ? data.expenses : [{}]).forEach(addExpenseRow);
  document.getElementById("allowanceRows").replaceChildren();
  (data.allowances?.length ? data.allowances : [{}]).forEach(addAllowanceRow);
  calculateUnitPrice();
  checkSalesWarning();
}
