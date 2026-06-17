import {
  db,
  collection,
  doc,
  deleteDoc,
  getDocs,
  getDoc,
  setDoc,
  serverTimestamp,
  closingsCollectionName,
  shopClosingsCollectionName,
  staffCollectionName,
  castCollectionName
} from "./firebase-config.js";
import { requireRole, logout, showMessage, hideMessage } from "./auth.js";

const yen = new Intl.NumberFormat("ja-JP");
const staffRoleLabels = {
  manager: "店長/マネージャー",
  bartender: "バーテンダー",
  kitchen: "厨房",
  cleaning: "清掃",
  other: "その他"
};

let currentUser = null;
let pendingPayload = null;
let isSaving = false;
let staffMembers = [];
let castMembers = [];
let pendingClosings = [];
let selectedPending = null;

document.getElementById("logoutButton").addEventListener("click", logout);
document.getElementById("reloadPendingButton").addEventListener("click", loadPendingClosings);
document.getElementById("registerStaffButton").addEventListener("click", registerStaff);
document.getElementById("registerCastButton").addEventListener("click", registerCast);
document.getElementById("addStaffWorkButton").addEventListener("click", () => addStaffWorkRow());
document.getElementById("addCastWorkButton").addEventListener("click", () => addCastWorkRow());
document.getElementById("addExpenseButton").addEventListener("click", () => addExpenseRow());
document.getElementById("addAllowanceButton").addEventListener("click", () => addAllowanceRow());
document.getElementById("copyPreviousButton").addEventListener("click", copyPreviousDay);
document.getElementById("saveButton").addEventListener("click", openConfirm);
document.getElementById("confirmSaveButton").addEventListener("click", saveReport);

requireRole("shop", async (user) => {
  currentUser = user;
  document.getElementById("reportForm").classList.remove("hidden");
  document.getElementById("date").value = todayString();
  await loadMasters();
  await loadPendingClosings();
  resetRows();
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

async function loadMasters() {
  try {
    const [staffSnapshot, castSnapshot] = await Promise.all([
      getDocs(collection(db, staffCollectionName)),
      getDocs(collection(db, castCollectionName))
    ]);
    staffMembers = staffSnapshot.docs.map((item) => ({ id: item.id, ...item.data() })).sort(sortByName);
    castMembers = castSnapshot.docs.map((item) => ({ id: item.id, ...item.data() })).sort(sortByName);
    renderMasterLists();
    refreshWorkSelects();
  } catch (error) {
    showMessage("errorMessage", `登録名簿を読み込めませんでした。Firestoreルールを確認してください。${error.message}`);
  }
}

function sortByName(a, b) {
  return String(a.name || "").localeCompare(String(b.name || ""), "ja");
}

async function loadPendingClosings() {
  hideMessage("errorMessage");
  try {
    const [shopSnap, closingSnap] = await Promise.all([
      getDocs(collection(db, shopClosingsCollectionName)),
      getDocs(collection(db, closingsCollectionName))
    ]);
    const items = [
      ...shopSnap.docs.map((docSnap) => ({ sourceCollection: shopClosingsCollectionName, id: docSnap.id, ...docSnap.data() })),
      ...closingSnap.docs.map((docSnap) => ({ sourceCollection: closingsCollectionName, id: docSnap.id, ...docSnap.data() }))
    ];
    const map = new Map();
    items.forEach((item) => {
      const date = item.businessDate || item.date || item.id;
      if (!date || item.status === "approved") return;
      const key = `${date}:${item.sourceCollection}`;
      map.set(key, { ...item, businessDate: date });
    });
    pendingClosings = [...map.values()].sort((a, b) => b.businessDate.localeCompare(a.businessDate));
    renderPendingClosings();
  } catch (error) {
    showMessage("errorMessage", `POS締めデータを読み込めませんでした。${error.message}`);
  }
}

function renderPendingClosings() {
  const root = document.getElementById("pendingClosings");
  root.replaceChildren();
  if (!pendingClosings.length) {
    const empty = document.createElement("div");
    empty.className = "notice";
    empty.textContent = "確認待ちのPOS締めデータはありません。手入力で経理へ送信することもできます。";
    root.appendChild(empty);
    return;
  }

  pendingClosings.forEach((closing) => {
    const row = document.createElement("article");
    row.className = "pending-item";
    const total = Number(closing.sales?.totalSales ?? closing.totalSales ?? 0);
    const info = document.createElement("div");
    info.innerHTML = `
      <div class="font-bold text-slate-900">${closing.businessDate}</div>
      <div class="mt-1 text-sm text-slate-600">総売上 ${yen.format(total)}円 / 送信元 ${closing.sourceCollection}</div>
    `;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "primary-button";
    button.textContent = "確認する";
    button.addEventListener("click", () => loadClosingIntoForm(closing));
    row.append(info, button);
    root.appendChild(row);
  });
}

async function registerStaff() {
  const nameInput = document.getElementById("newStaffName");
  const name = nameInput.value.trim();
  const role = document.getElementById("newStaffRole").value;
  if (!name) {
    showMessage("errorMessage", "スタッフ名を入力してください。");
    return;
  }
  if (staffMembers.some((member) => member.name === name)) {
    showMessage("errorMessage", "同じ名前のスタッフがすでに登録されています。");
    return;
  }
  try {
    const memberRef = doc(collection(db, staffCollectionName));
    await setDoc(memberRef, { name, role, createdAt: serverTimestamp(), createdBy: currentUser.uid });
    nameInput.value = "";
    hideMessage("errorMessage");
    showMessage("successMessage", `${name}をスタッフ登録しました。`, false);
    await loadMasters();
  } catch (error) {
    showMessage("errorMessage", `スタッフ登録に失敗しました。${error.message}`);
  }
}

async function registerCast() {
  const nameInput = document.getElementById("newCastName");
  const name = nameInput.value.trim();
  if (!name) {
    showMessage("errorMessage", "キャスト名を入力してください。");
    return;
  }
  if (castMembers.some((member) => member.name === name)) {
    showMessage("errorMessage", "同じ名前のキャストがすでに登録されています。");
    return;
  }
  try {
    const memberRef = doc(collection(db, castCollectionName));
    await setDoc(memberRef, { name, createdAt: serverTimestamp(), createdBy: currentUser.uid });
    nameInput.value = "";
    hideMessage("errorMessage");
    showMessage("successMessage", `${name}をキャスト登録しました。`, false);
    await loadMasters();
  } catch (error) {
    showMessage("errorMessage", `キャスト登録に失敗しました。${error.message}`);
  }
}

function renderMasterLists() {
  renderMasterList("staffMasterList", staffMembers, staffCollectionName, true);
  renderMasterList("castMasterList", castMembers, castCollectionName, false);
}

function renderMasterList(elementId, members, collectionName, showRole) {
  const root = document.getElementById(elementId);
  root.replaceChildren();
  if (!members.length) {
    const empty = document.createElement("p");
    empty.className = "text-sm text-slate-500";
    empty.textContent = "まだ登録されていません。";
    root.appendChild(empty);
    return;
  }
  members.forEach((member) => {
    const row = document.createElement("div");
    row.className = "master-item";
    const label = document.createElement("div");
    const name = document.createElement("span");
    name.className = "master-item-name";
    name.textContent = member.name;
    label.appendChild(name);
    if (showRole) {
      const role = document.createElement("span");
      role.className = "master-item-role";
      role.textContent = staffRoleLabels[member.role] || "その他";
      label.appendChild(role);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger-button";
    remove.textContent = "削除";
    remove.addEventListener("click", () => deleteMember(collectionName, member));
    row.append(label, remove);
    root.appendChild(row);
  });
}

async function deleteMember(collectionName, member) {
  if (!confirm(`${member.name}を登録一覧から削除しますか？`)) return;
  try {
    await deleteDoc(doc(db, collectionName, member.id));
    showMessage("successMessage", `${member.name}を削除しました。`, false);
    await loadMasters();
  } catch (error) {
    showMessage("errorMessage", `削除に失敗しました。${error.message}`);
  }
}

function refreshWorkSelects() {
  document.querySelectorAll(".staff-member-select").forEach((select) => {
    fillMemberSelect(select, staffMembers, true, select.value, select.dataset.savedName || "", select.dataset.savedRole || "other");
  });
  document.querySelectorAll(".cast-member-select").forEach((select) => {
    fillMemberSelect(select, castMembers, false, select.value, select.dataset.savedName || "");
  });
}

function fillMemberSelect(select, members, showRole, selectedId = "", savedName = "", savedRole = "other") {
  select.replaceChildren(makeOption("", "選択してください"));
  members.forEach((member) => {
    const label = showRole ? `${member.name}（${staffRoleLabels[member.role] || "その他"}）` : member.name;
    select.appendChild(makeOption(member.id, label));
  });
  if (selectedId && !members.some((member) => member.id === selectedId) && savedName) {
    select.appendChild(makeOption(selectedId, `${savedName}（登録削除済み）`));
  }
  select.dataset.savedName = savedName;
  select.dataset.savedRole = savedRole;
  select.value = selectedId;
  select.onchange = () => {
    const selected = members.find((member) => member.id === select.value);
    select.dataset.savedName = selected?.name || "";
    select.dataset.savedRole = selected?.role || "other";
  };
}

function addStaffWorkRow(data = {}) {
  const row = document.createElement("div");
  row.className = "dynamic-row work-row staff-work-row";
  const member = document.createElement("select");
  member.className = "form-select staff-member-select";
  fillMemberSelect(member, staffMembers, true, data.staffId || "", data.staffName || data.name || "", data.role || "other");
  const hours = document.createElement("input");
  hours.type = "number";
  hours.min = "0";
  hours.max = "24";
  hours.step = "0.5";
  hours.placeholder = "時間";
  hours.className = "form-input staff-work-hours";
  hours.value = data.hours ?? 0;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "danger-button";
  remove.textContent = "削除";
  remove.addEventListener("click", () => row.remove());
  row.append(member, hours, remove);
  document.getElementById("staffWorkRows").appendChild(row);
}

function addCastWorkRow(data = {}) {
  const row = document.createElement("div");
  row.className = "dynamic-row work-row cast-work-row";
  const member = document.createElement("select");
  member.className = "form-select cast-member-select";
  fillMemberSelect(member, castMembers, false, data.castId || "", data.castName || data.name || "");
  const hours = document.createElement("input");
  hours.type = "number";
  hours.min = "0";
  hours.max = "24";
  hours.step = "0.5";
  hours.placeholder = "勤務時間";
  hours.className = "form-input cast-work-hours";
  hours.value = data.hours ?? 0;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "danger-button";
  remove.textContent = "削除";
  remove.addEventListener("click", () => row.remove());
  row.append(member, hours, remove);
  document.getElementById("castWorkRows").appendChild(row);
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
  recipient.value = data.recipientName || data.recipient || "";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "danger-button";
  remove.textContent = "削除";
  remove.addEventListener("click", () => row.remove());
  row.append(type, amount, recipient, remove);
  document.getElementById("allowanceRows").appendChild(row);
}

function resetRows() {
  document.getElementById("staffWorkRows").replaceChildren();
  document.getElementById("castWorkRows").replaceChildren();
  document.getElementById("expenseRows").replaceChildren();
  document.getElementById("allowanceRows").replaceChildren();
  addStaffWorkRow();
  addCastWorkRow();
  addExpenseRow();
  addAllowanceRow();
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
  const isHour = el.matches(".staff-work-hours, .cast-work-hours");
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
    warning.textContent = "現金会計売上＋カード会計売上が総売上を超過しています。保存はできますが、内容を確認してください。";
    warning.classList.remove("hidden");
  } else {
    warning.classList.add("hidden");
  }
}

function collectRows() {
  const staffWork = [...document.querySelectorAll(".staff-work-row")]
    .map((row) => {
      const select = row.querySelector(".staff-member-select");
      const member = staffMembers.find((item) => item.id === select.value);
      return {
        staffId: select.value,
        staffName: member?.name || select.dataset.savedName || "",
        role: member?.role || select.dataset.savedRole || "other",
        hours: Number(row.querySelector(".staff-work-hours").value || 0)
      };
    })
    .filter((row) => row.staffId || row.staffName || row.hours > 0);

  const castWork = [...document.querySelectorAll(".cast-work-row")]
    .map((row) => {
      const select = row.querySelector(".cast-member-select");
      const member = castMembers.find((item) => item.id === select.value);
      return {
        castId: select.value,
        castName: member?.name || select.dataset.savedName || "",
        hours: Number(row.querySelector(".cast-work-hours").value || 0)
      };
    })
    .filter((row) => row.castId || row.castName || row.hours > 0);

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

  return { staffWork, castWork, expenses, allowances };
}

function buildPayload() {
  const businessDate = textValue("date");
  const totalSales = numberValue("totalSales");
  const totalCustomers = numberValue("totalCustomers");
  const rows = collectRows();
  const payload = {
    businessDate,
    date: businessDate,
    status: "approved",
    sales: {
      totalSales,
      cashSales: numberValue("cashSales"),
      cardSales: numberValue("cardSales")
    },
    customers: {
      groupCount: numberValue("groupCount"),
      totalCustomers,
      customerUnitPrice: totalCustomers > 0 ? Math.floor(totalSales / totalCustomers) : 0
    },
    nominations: {
      honShimeiCount: numberValue("honShimei"),
      jonaiCount: numberValue("jonai")
    },
    castSales: selectedPending?.castSales || [],
    staffWork: rows.staffWork,
    castWork: rows.castWork,
    staffHours: rows.staffWork,
    castHours: rows.castWork,
    expenses: rows.expenses,
    allowances: rows.allowances,
    cashReconciliation: selectedPending?.cashReconciliation || {
      expectedCash: numberValue("cashSales"),
      actualCash: numberValue("cashSales"),
      difference: 0,
      note: ""
    },
    source: {
      ...(selectedPending?.source || {}),
      reviewedBy: currentUser.uid,
      reviewedEmail: currentUser.email || "",
      reviewedAt: serverTimestamp(),
      sourceCollection: selectedPending?.sourceCollection || "manual"
    },
    reviewedBy: currentUser.uid,
    reviewedEmail: currentUser.email || "",
    reviewedAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  };
  payload.shimeiInfo = {
    honShimei: payload.nominations.honShimeiCount,
    jonai: payload.nominations.jonaiCount
  };
  payload["指名情報"] = { ...payload.shimeiInfo };
  return payload;
}

function validatePayload(payload) {
  const errors = [];
  if (!payload.businessDate) errors.push("日付を入力してください。");
  if (payload.businessDate > todayString()) errors.push("未来の日付は送信できません。");
  payload.staffWork.forEach((row) => {
    if (!row.staffId && !row.staffName) errors.push("勤務するスタッフを登録一覧から選択してください。");
    if (!isHalfHour(row.hours)) errors.push("スタッフ勤務時間は0〜24時間、0.5単位で入力してください。");
  });
  payload.castWork.forEach((row) => {
    if (!row.castId && !row.castName) errors.push("勤務するキャストを登録一覧から選択してください。");
    if (!isHalfHour(row.hours)) errors.push("キャスト勤務時間は0〜24時間、0.5単位で入力してください。");
  });
  ["totalSales", "cashSales", "cardSales"].forEach((key) => {
    if (!isNonNegativeInteger(payload.sales[key])) errors.push("売上は0以上の整数で入力してください。");
  });
  ["groupCount", "totalCustomers"].forEach((key) => {
    if (!isNonNegativeInteger(payload.customers[key])) errors.push("客数は0以上の整数で入力してください。");
  });
  ["honShimeiCount", "jonaiCount"].forEach((key) => {
    if (!isNonNegativeInteger(payload.nominations[key])) errors.push("指名件数は0以上の整数で入力してください。");
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
    `日付：${pendingPayload.businessDate}`,
    `総売上：${yen.format(pendingPayload.sales.totalSales)}円`,
    `現金：${yen.format(pendingPayload.sales.cashSales)}円 / カード：${yen.format(pendingPayload.sales.cardSales)}円`,
    `総客数：${pendingPayload.customers.totalCustomers}名 / 客単価：${yen.format(pendingPayload.customers.customerUnitPrice)}円`,
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
    await setDoc(doc(db, closingsCollectionName, pendingPayload.businessDate), pendingPayload, { merge: true });
    if (selectedPending?.sourceCollection === shopClosingsCollectionName) {
      await setDoc(doc(db, shopClosingsCollectionName, selectedPending.businessDate), {
        status: "approved",
        reviewedBy: currentUser.uid,
        reviewedAt: serverTimestamp()
      }, { merge: true });
    }
    document.getElementById("confirmModal").close();
    selectedPending = null;
    await loadPendingClosings();
    showMessage("successMessage", "経理側へ送信しました。", false);
  } catch (error) {
    showMessage("errorMessage", `経理送信に失敗しました。${error.message}`);
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
    const snap = await getDoc(doc(db, closingsCollectionName, previousDateString(date)));
    if (!snap.exists()) {
      showMessage("errorMessage", "前日のデータが見つかりません。");
      return;
    }
    applyClosingToForm({ ...snap.data(), businessDate: date });
    showMessage("successMessage", "前日のデータをコピーしました。送信するまで経理側には反映されません。", false);
  } catch (error) {
    showMessage("errorMessage", `前日データの取得に失敗しました。${error.message}`);
  }
}

function loadClosingIntoForm(closing) {
  selectedPending = closing;
  applyClosingToForm(closing);
  hideMessage("errorMessage");
  showMessage("successMessage", `${closing.businessDate} のPOS締めデータをフォームへ読み込みました。確認後、経理へ送信してください。`, false);
}

function applyClosingToForm(data) {
  document.getElementById("date").value = data.businessDate || data.date || data.id;
  document.getElementById("totalSales").value = data.sales?.totalSales ?? data.totalSales ?? 0;
  document.getElementById("cashSales").value = data.sales?.cashSales ?? data.cashSales ?? 0;
  document.getElementById("cardSales").value = data.sales?.cardSales ?? data.cardSales ?? 0;
  document.getElementById("groupCount").value = data.customers?.groupCount ?? data.groupCount ?? 0;
  document.getElementById("totalCustomers").value = data.customers?.totalCustomers ?? data.totalCustomers ?? 0;
  const nominations = data.nominations || data.shimeiInfo || data["指名情報"] || {};
  document.getElementById("honShimei").value = nominations.honShimeiCount ?? nominations.honShimei ?? 0;
  document.getElementById("jonai").value = nominations.jonaiCount ?? nominations.jonai ?? 0;
  document.getElementById("staffWorkRows").replaceChildren();
  normalizeStaffWork(data.staffWork || data.staffHours).forEach(addStaffWorkRow);
  if (!document.getElementById("staffWorkRows").children.length) addStaffWorkRow();
  document.getElementById("castWorkRows").replaceChildren();
  normalizeCastWork(data.castWork || data.castHours).forEach(addCastWorkRow);
  if (!document.getElementById("castWorkRows").children.length) addCastWorkRow();
  document.getElementById("expenseRows").replaceChildren();
  (data.expenses?.length ? data.expenses : [{}]).forEach(addExpenseRow);
  document.getElementById("allowanceRows").replaceChildren();
  (data.allowances?.length ? data.allowances : [{}]).forEach(addAllowanceRow);
  calculateUnitPrice();
  checkSalesWarning();
}

function normalizeStaffWork(work) {
  if (Array.isArray(work)) return work.map((row) => ({ ...row, hours: Number(row.hours || 0) }));
  if (!work || typeof work !== "object") return [];
  return Object.entries(staffRoleLabels)
    .map(([role, label]) => ({ staffName: label, role, hours: Number(work[role] || 0) }))
    .filter((row) => row.hours > 0);
}

function normalizeCastWork(work) {
  if (!Array.isArray(work)) return [];
  return work.map((row) => ({ ...row, hours: Number(row.hours || 0) }));
}
