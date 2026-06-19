import {
  db,
  posDb,
  collection,
  doc,
  getDocs,
  getDoc,
  setDoc,
  ref,
  get,
  serverTimestamp,
  closingsCollectionName,
  shopClosingsCollectionName,
  staffCollectionName,
  castCollectionName,
  introducerCollectionName,
  trialCastCollectionName,
  posCastPath
} from "./firebase-config.js";
import { requireRole, logout, showMessage, hideMessage } from "./auth.js";

const yen = new Intl.NumberFormat("ja-JP");
const employmentTypeLabels = {
  employee: "社員",
  partTime: "アルバイト"
};
const jobTypeLabels = {
  kitchen: "キッチンスタッフ",
  hall: "ホールスタッフ",
  driver: "ドライバースタッフ"
};
const payTypeLabels = {
  daily: "日給",
  hourly: "時給"
};
const castRewardLabels = {
  slideHourly: "スライド時給",
  guaranteedHourly: "保証時給"
};
const expenseCategories = ["酒代", "広告宣伝①", "広告宣伝②", "消耗品/備品", "交際費", "交通費", "その他", "美容室"];
const allowanceTypes = ["美容室", "遠方手当", "送迎手当", "その他"];
const introducerFeeSystemLabels = {
  sales10: "売上10%",
  pay10: "総支給額10%",
  higher10: "売上10%か総支給額10%の高い方"
};

let currentUser = null;
let pendingPayload = null;
let isSaving = false;
let staffMembers = [];
let allCastMembers = [];
let castMembers = [];
let introducers = [];
let pendingClosings = [];
let sentClosings = [];
let selectedPending = null;
let editingStaffId = null;
let editingIntroducerId = null;
let currentCastDetailType = "active";

document.getElementById("logoutButton").addEventListener("click", logout);
document.getElementById("openRegistrationButton").addEventListener("click", () => showWorkspace("registration"));
document.getElementById("openClosingButton").addEventListener("click", openPendingClosingModal);
document.getElementById("openSentClosingsButton").addEventListener("click", openSentClosingModal);
document.querySelectorAll("[data-home-button]").forEach((button) => {
  button.addEventListener("click", () => showWorkspace("home"));
});
document.getElementById("closePendingClosingButton").addEventListener("click", () => {
  document.getElementById("pendingClosingModal").close();
});
document.getElementById("closeSentClosingButton").addEventListener("click", () => {
  document.getElementById("sentClosingModal").close();
});
document.getElementById("reloadPendingButton").addEventListener("click", loadClosingLists);
document.getElementById("sentClosingDateSearch").addEventListener("input", renderSentClosings);
document.getElementById("clearSentClosingDateButton").addEventListener("click", () => {
  document.getElementById("sentClosingDateSearch").value = "";
  renderSentClosings();
});
document.getElementById("registerStaffButton").addEventListener("click", registerStaff);
document.getElementById("cancelStaffEditButton").addEventListener("click", resetStaffForm);
document.getElementById("openStaffListButton").addEventListener("click", () => {
  renderStaffMasterList();
  document.getElementById("staffListModal").showModal();
});
document.getElementById("closeStaffListButton").addEventListener("click", () => {
  document.getElementById("staffListModal").close();
});
document.getElementById("saveIntroducerButton").addEventListener("click", saveIntroducer);
document.getElementById("cancelIntroducerEditButton").addEventListener("click", resetIntroducerForm);
document.getElementById("syncCastsButton").addEventListener("click", () => syncPosCasts(true));
document.querySelectorAll("[data-cast-detail]").forEach((button) => {
  button.addEventListener("click", () => openCastDetail(button.dataset.castDetail));
});
document.getElementById("closeCastDetailButton").addEventListener("click", () => {
  document.getElementById("castDetailModal").close();
});
document.getElementById("castSearchInput").addEventListener("input", renderCastDetailList);
document.getElementById("castRewardSystem").addEventListener("change", updateGuaranteeNoteVisibility);
document.getElementById("castIntroducerId").addEventListener("change", updateCastAdvisoryFeeVisibility);
document.getElementById("castGuaranteedHourlyRate").addEventListener("input", (event) => {
  const value = Number(event.target.value);
  const invalid = event.target.value !== "" && (!Number.isInteger(value) || value <= 0);
  markInvalid(event.target, invalid);
});
document.getElementById("castAdvisoryFeeAmount").addEventListener("input", (event) => {
  const value = Number(event.target.value);
  const invalid = event.target.value !== "" && (!Number.isInteger(value) || value <= 0);
  markInvalid(event.target, invalid);
});
document.getElementById("saveCastProfileButton").addEventListener("click", saveCastProfile);
document.getElementById("addCastWorkButton").addEventListener("click", () => addCastWorkRow());
document.getElementById("addExpenseButton").addEventListener("click", () => addExpenseRow());
document.getElementById("addAllowanceButton").addEventListener("click", () => addAllowanceRow());
document.getElementById("copyPreviousButton").addEventListener("click", copyPreviousDay);
document.getElementById("saveButton").addEventListener("click", openConfirm);
document.getElementById("confirmSaveButton").addEventListener("click", saveReport);
document.getElementById("cancelConfirmSaveButton").addEventListener("click", () => {
  document.getElementById("confirmModal").close();
});

requireRole("shop", async (user) => {
  currentUser = user;
  document.getElementById("reportForm").classList.remove("hidden");
  showWorkspace("home");
  document.getElementById("date").value = todayString();
  await loadMasters();
  await syncPosCasts(false);
  await loadClosingLists();
  resetRows();
  wireRealtimeValidation();
  calculateUnitPrice();
});

function showWorkspace(workspace) {
  document.getElementById("shopHome").classList.toggle("hidden", workspace !== "home");
  document.querySelectorAll("[data-workspace]").forEach((element) => {
    element.classList.toggle("hidden", element.dataset.workspace !== workspace);
  });
  if (workspace === "home") {
    document.querySelectorAll("dialog[open]").forEach((dialog) => dialog.close());
  }
  window.scrollTo(0, 0);
}

function openPendingClosingModal() {
  renderPendingClosings();
  document.getElementById("pendingClosingModal").showModal();
}

function openSentClosingModal() {
  document.getElementById("sentClosingDateSearch").value = "";
  renderSentClosings();
  document.getElementById("sentClosingModal").showModal();
}

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

function isWorkHour(value) {
  return Number.isFinite(value) && value >= 0 && value <= 24;
}

function isQuarterHour(value) {
  return Number.isFinite(value) && value > 0 && value <= 24 && Math.round(value * 4) === value * 4;
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
    const [staffSnapshot, castSnapshot, introducerSnapshot] = await Promise.all([
      getDocs(collection(db, staffCollectionName)),
      getDocs(collection(db, castCollectionName)),
      getDocs(collection(db, introducerCollectionName))
    ]);
    staffMembers = staffSnapshot.docs.map((item) => ({ id: item.id, ...item.data() })).sort(sortByName);
    allCastMembers = castSnapshot.docs.map((item) => ({ id: item.id, ...item.data() })).sort(sortByName);
    castMembers = allCastMembers.filter((cast) => cast.deleted !== true);
    introducers = introducerSnapshot.docs
      .map((item) => ({ id: item.id, ...item.data() }))
      .sort(sortByName);
    renderMasterLists();
    renderIntroducerList();
    refreshCastIntroducerSelect();
    refreshWorkSelects();
  } catch (error) {
    showMessage("errorMessage", `登録名簿を読み込めませんでした。Firestoreルールを確認してください。${error.message}`);
  }
}

async function syncPosCasts(showSuccess) {
  const button = document.getElementById("syncCastsButton");
  button.disabled = true;
  setCastSyncStatus("POSのキャスト名簿を同期しています。");
  try {
    const snapshot = await get(ref(posDb, posCastPath));
    const rawCasts = snapshot.val();
    const posCasts = (Array.isArray(rawCasts) ? rawCasts : Object.values(rawCasts || {}))
      .filter((cast) => cast && cast.castType !== "trial" && cast.id != null && String(cast.name || "").trim())
      .map(normalizePosCast);
    if (!posCasts.length) {
      throw new Error("POSに通常キャストの名簿データがありません。");
    }
    const localByPosId = new Map(allCastMembers.filter((cast) => cast.posCastId).map((cast) => [String(cast.posCastId), cast]));
    const localByName = new Map(
      allCastMembers
        .filter((cast) => !cast.posCastId)
        .map((cast) => [String(cast.name || ""), cast])
    );
    await Promise.all(posCasts.map((posCast) => {
      const existing = localByPosId.get(posCast.posCastId) || localByName.get(posCast.name);
      const changed = !existing
        || existing.name !== posCast.name
        || existing.status !== posCast.status
        || Number(existing.internalNo || 0) !== posCast.internalNo
        || (posCast.entryDate && existing.entryDate !== posCast.entryDate)
        || (posCast.exitedDate && existing.exitedDate !== posCast.exitedDate)
        || existing.posEnteredAt !== posCast.posEnteredAt
        || existing.posExitedAt !== posCast.posExitedAt;
      if (!changed) return Promise.resolve();
      const sourceData = { ...posCast };
      if (!sourceData.entryDate) delete sourceData.entryDate;
      if (!sourceData.exitedDate) delete sourceData.exitedDate;
      return setDoc(doc(db, castCollectionName, existing?.id || castDocumentId(posCast.posCastId)), {
        ...sourceData,
        source: "pos",
        syncedAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      }, { merge: true });
    }));
    await loadCastMembers();
    const activeCount = castMembers.filter((cast) => cast.status === "active").length;
    const departedCount = castMembers.filter((cast) => cast.status === "departed").length;
    setCastSyncStatus(`POS名簿と同期済み：在籍中 ${activeCount}名 / 退店済み ${departedCount}名`);
    if (showSuccess) showMessage("successMessage", "POSのキャスト名簿を再同期しました。", false);
  } catch (error) {
    setCastSyncStatus(`POS名簿の同期に失敗しました。${error.message}`, true);
    showMessage("errorMessage", `POS名簿の同期に失敗しました。${error.message}`);
  } finally {
    button.disabled = false;
  }
}

function normalizePosCast(cast) {
  const posCastId = String(cast.id);
  return {
    posCastId,
    name: String(cast.name).trim(),
    internalNo: Number(cast.internalNo || 0),
    status: cast.active === false ? "departed" : "active",
    entryDate: cast.enteredBizDay || timestampToDate(cast.enteredAt || cast.registeredAt),
    posEnteredAt: Number(cast.enteredAt || cast.registeredAt || 0),
    posExitedAt: Number(cast.exitedAt || 0),
    exitedDate: cast.exitedBizDay || timestampToDate(cast.exitedAt)
  };
}

function timestampToDate(value) {
  const timestamp = Number(value || 0);
  if (!timestamp) return "";
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function castDocumentId(posCastId) {
  return `pos_${String(posCastId).replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function setCastSyncStatus(message, isError = false) {
  const status = document.getElementById("castSyncStatus");
  status.textContent = message;
  status.classList.toggle("alert", isError);
  status.classList.toggle("alert-error", isError);
  status.classList.toggle("notice", !isError);
}

async function loadCastMembers() {
  const snapshot = await getDocs(collection(db, castCollectionName));
  allCastMembers = snapshot.docs
    .map((item) => ({ id: item.id, ...item.data() }))
    .filter((cast) => cast.source === "pos" || cast.posCastId)
    .sort(sortCasts);
  castMembers = allCastMembers.filter((cast) => cast.deleted !== true);
  renderCastMasterList();
  refreshWorkSelects();
}

function sortByName(a, b) {
  return String(a.name || "").localeCompare(String(b.name || ""), "ja");
}

function sortCasts(a, b) {
  if ((a.status === "departed") !== (b.status === "departed")) return a.status === "departed" ? 1 : -1;
  return Number(a.internalNo || Number.MAX_SAFE_INTEGER) - Number(b.internalNo || Number.MAX_SAFE_INTEGER)
    || sortByName(a, b);
}

async function loadClosingLists() {
  hideMessage("errorMessage");
  try {
    const [shopSnap, closingSnap] = await Promise.all([
      getDocs(collection(db, shopClosingsCollectionName)),
      getDocs(collection(db, closingsCollectionName))
    ]);
    const shopItems = shopSnap.docs.map((docSnap) => ({
      sourceCollection: shopClosingsCollectionName,
      id: docSnap.id,
      ...docSnap.data()
    }));
    const closingItems = closingSnap.docs.map((docSnap) => ({
      sourceCollection: closingsCollectionName,
      id: docSnap.id,
      ...docSnap.data()
    }));
    const items = [...shopItems, ...closingItems];
    let lifecycleSyncError = null;
    try {
      await syncCastLifecycle(items);
    } catch (error) {
      lifecycleSyncError = error;
      console.warn("POSキャスト入退店同期に失敗しました。", error);
    }
    sentClosings = closingItems
      .filter((item) => ["submitted", "approved", "finalized"].includes(item.status))
      .map((item) => ({ ...item, businessDate: item.businessDate || item.date || item.id }))
      .filter((item) => item.businessDate)
      .sort((a, b) => b.businessDate.localeCompare(a.businessDate));
    const sentDates = new Set(sentClosings.map((item) => item.businessDate));
    const map = new Map();
    shopItems.forEach((item) => {
      const date = item.businessDate || item.date || item.id;
      if (!date || sentDates.has(date)) return;
      map.set(date, { ...item, businessDate: date });
    });
    pendingClosings = [...map.values()].sort((a, b) => b.businessDate.localeCompare(a.businessDate));
    renderPendingClosings();
    renderSentClosings();
    if (lifecycleSyncError) {
      showMessage(
        "errorMessage",
        `POS締めデータは読み込みましたが、キャスト入退店同期に失敗しました。${lifecycleSyncError.message}`
      );
    }
  } catch (error) {
    showMessage("errorMessage", `POS締めデータを読み込めませんでした。${error.message}`);
  }
}

async function syncCastLifecycle(closings) {
  const updates = new Map();
  [...closings]
    .sort((a, b) => String(a.businessDate || a.date || "").localeCompare(String(b.businessDate || b.date || "")))
    .forEach((closing) => {
    const eventDate = closing.businessDate || closing.date || "";
    (closing.enteredCasts || []).forEach((cast) => {
      if (cast.castId == null || !String(cast.castName || "").trim()) return;
      updates.set(String(cast.castId), {
        posCastId: String(cast.castId),
        name: String(cast.castName).trim(),
        internalNo: Number(cast.internalNo || 0),
        status: "active",
        entryDate: eventDate,
        posEnteredAt: Number(cast.enteredAt || 0)
      });
    });
    (closing.exitedCasts || []).forEach((cast) => {
      if (cast.castId == null || !String(cast.castName || "").trim()) return;
      updates.set(String(cast.castId), {
        posCastId: String(cast.castId),
        name: String(cast.castName).trim(),
        internalNo: Number(cast.internalNo || 0),
        status: "departed",
        exitedDate: eventDate,
        posExitedAt: Number(cast.exitedAt || 0)
      });
    });
    (closing.trialCasts || []).forEach((cast) => {
      if (cast.castId == null || !String(cast.castName || "").trim()) return;
      updates.set(String(cast.castId), {
        posCastId: String(cast.castId),
        name: String(cast.castName).trim(),
        internalNo: Number(cast.internalNo || 0),
        status: "trial",
        entryDate: cast.trialBizDay || eventDate,
        posEnteredAt: Number(cast.trialRegisteredAt || 0),
        posExitedAt: Number(cast.trialEndedAt || 0)
      });
    });
  });
  if (!updates.size) return;
  const byPosId = new Map(allCastMembers.map((cast) => [String(cast.posCastId || ""), cast]));
  await Promise.all([...updates.values()].map((update) => {
    const existing = byPosId.get(update.posCastId);
    const changed = !existing
      || existing.name !== update.name
      || existing.status !== update.status
      || Number(existing.internalNo || 0) !== update.internalNo
      || (update.entryDate && existing.entryDate !== update.entryDate)
      || (update.exitedDate && existing.exitedDate !== update.exitedDate)
      || (update.posEnteredAt && existing.posEnteredAt !== update.posEnteredAt)
      || (update.posExitedAt && existing.posExitedAt !== update.posExitedAt);
    if (!changed) return Promise.resolve();
    return setDoc(doc(db, castCollectionName, existing?.id || castDocumentId(update.posCastId)), {
      ...update,
      source: "pos",
      lifecycleSyncedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }, { merge: true });
  }));
  await loadCastMembers();
}

function renderPendingClosings() {
  const root = document.getElementById("pendingClosings");
  root.replaceChildren();
  if (!pendingClosings.length) {
    const empty = document.createElement("div");
    empty.className = "notice";
    empty.textContent = "経理へ未送信のPOS締めデータはありません。";
    root.appendChild(empty);
    return;
  }

  pendingClosings.forEach((closing) => {
    const row = document.createElement("article");
    row.className = "pending-item";
    const total = Number(closing.sales?.totalSales ?? closing.totalSales ?? 0);
    const transactionCount = Array.isArray(closing.transactions) ? closing.transactions.length : 0;
    const info = document.createElement("div");
    info.innerHTML = `
      <div class="font-bold text-slate-900">${closing.businessDate}</div>
      <div class="mt-1 text-sm text-slate-600">総売上 ${yen.format(total)}円 / 会計 ${transactionCount}件</div>
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

function renderSentClosings() {
  const root = document.getElementById("sentClosings");
  const searchDate = document.getElementById("sentClosingDateSearch").value;
  const items = sentClosings.filter((closing) => !searchDate || closing.businessDate === searchDate);
  root.replaceChildren();
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "notice";
    empty.textContent = searchDate ? "指定した日付の送信済データはありません。" : "送信済データはありません。";
    root.appendChild(empty);
    return;
  }
  items.forEach((closing) => {
    const row = document.createElement("article");
    row.className = "pending-item";
    const total = Number(closing.sales?.totalSales ?? closing.totalSales ?? 0);
    const info = document.createElement("div");
    info.innerHTML = `
      <div class="font-bold text-slate-900">${closing.businessDate}</div>
      <div class="mt-1 text-sm text-slate-600">総売上 ${yen.format(total)}円 / 経理送信済み</div>
    `;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary-button";
    button.textContent = "再確認・編集";
    button.addEventListener("click", () => loadClosingIntoForm(closing, true));
    row.append(info, button);
    root.appendChild(row);
  });
}

async function registerStaff() {
  const nameInput = document.getElementById("newStaffName");
  const name = nameInput.value.trim();
  const employmentType = document.getElementById("newStaffEmploymentType").value;
  const jobType = document.getElementById("newStaffJobType").value;
  const payType = document.getElementById("newStaffPayType").value;
  const payAmountInput = document.getElementById("newStaffPayAmount");
  const payAmount = Number(payAmountInput.value);
  if (!name) {
    showMessage("errorMessage", "スタッフ名を入力してください。");
    return;
  }
  if (staffMembers.some((member) => member.name === name && member.id !== editingStaffId)) {
    showMessage("errorMessage", "同じ名前のスタッフが登録済みです。退店済みの場合は一覧の「再入店」を使用してください。");
    return;
  }
  if (!employmentTypeLabels[employmentType] || !jobTypeLabels[jobType] || !payTypeLabels[payType]) {
    showMessage("errorMessage", "雇用形態、業務区分、給与形態を確認してください。");
    return;
  }
  if (!Number.isInteger(payAmount) || payAmount <= 0) {
    markInvalid(payAmountInput, true);
    showMessage("errorMessage", "給与金額は1円以上の整数で入力してください。");
    return;
  }
  try {
    const memberRef = editingStaffId
      ? doc(db, staffCollectionName, editingStaffId)
      : doc(collection(db, staffCollectionName));
    const staffData = {
      name,
      employmentType,
      jobType,
      payType,
      payAmount,
      updatedAt: serverTimestamp(),
      updatedBy: currentUser.uid
    };
    if (!editingStaffId) {
      Object.assign(staffData, {
        status: "active",
        joinedAt: serverTimestamp(),
        createdAt: serverTimestamp(),
        createdBy: currentUser.uid
      });
    }
    await setDoc(memberRef, staffData, { merge: Boolean(editingStaffId) });
    hideMessage("errorMessage");
    showMessage("successMessage", `${name}のスタッフ情報を${editingStaffId ? "更新" : "入店登録"}しました。`, false);
    resetStaffForm();
    await loadMasters();
  } catch (error) {
    showMessage("errorMessage", `スタッフの入店登録に失敗しました。${error.message}`);
  }
}

function renderMasterLists() {
  renderStaffMasterList();
  renderCastMasterList();
  renderStaffAttendancePicker();
}

function renderStaffMasterList() {
  const root = document.getElementById("staffMasterList");
  root.replaceChildren();
  if (!staffMembers.length) {
    const empty = document.createElement("p");
    empty.className = "text-sm text-slate-500";
    empty.textContent = "スタッフはまだ登録されていません。";
    root.appendChild(empty);
    return;
  }
  staffMembers.forEach((member) => {
    const row = document.createElement("div");
    row.className = "master-item";
    const info = document.createElement("div");
    info.className = "staff-master-info";
    const name = document.createElement("span");
    name.className = "master-item-name";
    name.textContent = member.name;
    const status = document.createElement("span");
    const isActive = member.status !== "departed";
    status.className = `staff-status ${isActive ? "staff-status-active" : "staff-status-departed"}`;
    status.textContent = isActive ? "在籍中" : "退店済み";
    const meta = document.createElement("span");
    meta.className = "staff-master-meta";
    meta.textContent = [
      employmentTypeLabels[member.employmentType] || "雇用形態未設定",
      jobTypeLabels[member.jobType] || legacyJobTypeLabel(member.role),
      `${payTypeLabels[member.payType] || "給与形態未設定"} ${member.payAmount ? `${yen.format(member.payAmount)}円` : "金額未設定"}`
    ].join(" / ");
    info.append(name, status, meta);
    const actions = document.createElement("div");
    actions.className = "staff-master-actions";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "secondary-button";
    edit.textContent = "編集";
    edit.addEventListener("click", () => startStaffEdit(member));
    const statusAction = document.createElement("button");
    statusAction.type = "button";
    statusAction.className = isActive ? "danger-button" : "secondary-button";
    statusAction.textContent = isActive ? "退店" : "再入店";
    statusAction.addEventListener("click", () => updateStaffStatus(member, isActive ? "departed" : "active"));
    actions.append(edit, statusAction);
    row.append(info, actions);
    root.appendChild(row);
  });
}

function startStaffEdit(member) {
  document.getElementById("staffListModal").close();
  editingStaffId = member.id;
  document.getElementById("newStaffName").value = member.name || "";
  document.getElementById("newStaffEmploymentType").value = member.employmentType || "employee";
  document.getElementById("newStaffJobType").value = member.jobType || legacyJobTypeValue(member.role);
  document.getElementById("newStaffPayType").value = member.payType || "daily";
  document.getElementById("newStaffPayAmount").value = member.payAmount || "";
  document.getElementById("registerStaffButton").textContent = "情報を更新";
  document.getElementById("cancelStaffEditButton").classList.remove("hidden");
  document.getElementById("newStaffName").focus();
  document.getElementById("newStaffName").scrollIntoView({ behavior: "smooth", block: "center" });
}

function resetStaffForm() {
  editingStaffId = null;
  document.getElementById("newStaffName").value = "";
  document.getElementById("newStaffEmploymentType").value = "employee";
  document.getElementById("newStaffJobType").value = "kitchen";
  document.getElementById("newStaffPayType").value = "daily";
  document.getElementById("newStaffPayAmount").value = "";
  document.getElementById("registerStaffButton").textContent = "入店登録";
  document.getElementById("cancelStaffEditButton").classList.add("hidden");
  markInvalid(document.getElementById("newStaffPayAmount"), false);
}

async function saveIntroducer() {
  const name = document.getElementById("introducerName").value.trim();
  const feeSystem = document.getElementById("introducerFeeSystem").value;
  const advisoryFeeEnabled = document.getElementById("introducerAdvisoryFeeEnabled").value === "true";
  const note = document.getElementById("introducerNote").value.trim();
  if (!name) {
    markInvalid(document.getElementById("introducerName"), true);
    showMessage("errorMessage", "紹介者名を入力してください。");
    return;
  }
  markInvalid(document.getElementById("introducerName"), false);
  if (!introducerFeeSystemLabels[feeSystem]) {
    markInvalid(document.getElementById("introducerFeeSystem"), true);
    showMessage("errorMessage", "紹介料システムを選択してください。");
    return;
  }
  markInvalid(document.getElementById("introducerFeeSystem"), false);
  if (introducers.some((item) => item.name === name && item.id !== editingIntroducerId)) {
    showMessage("errorMessage", "同じ名前の紹介者が登録済みです。");
    return;
  }
  const button = document.getElementById("saveIntroducerButton");
  button.disabled = true;
  try {
    const target = editingIntroducerId
      ? doc(db, introducerCollectionName, editingIntroducerId)
      : doc(collection(db, introducerCollectionName));
    await setDoc(target, {
      name,
      feeSystem,
      advisoryFeeEnabled,
      note,
      updatedAt: serverTimestamp(),
      updatedBy: currentUser.uid,
      ...(editingIntroducerId ? {} : {
        createdAt: serverTimestamp(),
        createdBy: currentUser.uid
      })
    }, { merge: Boolean(editingIntroducerId) });
    showMessage("successMessage", `${name}の紹介者情報を${editingIntroducerId ? "更新" : "登録"}しました。`, false);
    resetIntroducerForm();
    await loadMasters();
  } catch (error) {
    showMessage("errorMessage", `紹介者情報を保存できませんでした。${error.message}`);
  } finally {
    button.disabled = false;
  }
}

function renderIntroducerList() {
  const root = document.getElementById("introducerList");
  root.replaceChildren();
  if (!introducers.length) {
    const empty = document.createElement("div");
    empty.className = "notice";
    empty.textContent = "紹介者はまだ登録されていません。";
    root.appendChild(empty);
    return;
  }
  introducers.forEach((introducer) => {
    const row = document.createElement("article");
    row.className = "master-item";
    const info = document.createElement("div");
    info.className = "staff-master-info";
    const name = document.createElement("strong");
    name.textContent = introducer.name;
    const meta = document.createElement("span");
    meta.className = "staff-master-meta";
    meta.textContent = [
      introducerFeeSystemLabels[introducer.feeSystem] || "紹介料未設定",
      `顧問料：${introducer.advisoryFeeEnabled ? "発生" : "無し"}`,
      `備考：${introducer.note || "なし"}`
    ].join(" / ");
    info.append(name, meta);
    const actions = document.createElement("div");
    actions.className = "staff-master-actions";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "secondary-button";
    edit.textContent = "編集";
    edit.addEventListener("click", () => startIntroducerEdit(introducer));
    actions.appendChild(edit);
    row.append(info, actions);
    root.appendChild(row);
  });
}

function startIntroducerEdit(introducer) {
  editingIntroducerId = introducer.id;
  document.getElementById("editingIntroducerId").value = introducer.id;
  document.getElementById("introducerName").value = introducer.name || "";
  document.getElementById("introducerFeeSystem").value = introducer.feeSystem || "sales10";
  document.getElementById("introducerAdvisoryFeeEnabled").value = introducer.advisoryFeeEnabled ? "true" : "false";
  document.getElementById("introducerNote").value = introducer.note || "";
  document.getElementById("saveIntroducerButton").textContent = "更新";
  document.getElementById("cancelIntroducerEditButton").classList.remove("hidden");
  document.getElementById("introducerName").focus();
}

function resetIntroducerForm() {
  editingIntroducerId = null;
  document.getElementById("editingIntroducerId").value = "";
  document.getElementById("introducerName").value = "";
  document.getElementById("introducerFeeSystem").value = "sales10";
  document.getElementById("introducerAdvisoryFeeEnabled").value = "false";
  document.getElementById("introducerNote").value = "";
  document.getElementById("saveIntroducerButton").textContent = "登録";
  document.getElementById("cancelIntroducerEditButton").classList.add("hidden");
  markInvalid(document.getElementById("introducerName"), false);
}

function refreshCastIntroducerSelect(selectedId = "") {
  const select = document.getElementById("castIntroducerId");
  const value = selectedId || select.value;
  select.replaceChildren(makeOption("", "紹介者なし"));
  introducers.forEach((introducer) => {
    select.appendChild(makeOption(introducer.id, introducer.name));
  });
  if (value && introducers.some((introducer) => introducer.id === value)) select.value = value;
}

function renderCastMasterList() {
  document.getElementById("activeCastCount").textContent = `${castMembers.filter((cast) => cast.status === "active").length}名`;
  document.getElementById("departedCastCount").textContent = `${castMembers.filter((cast) => cast.status === "departed").length}名`;
  document.getElementById("trialCastCount").textContent = `${castMembers.filter((cast) => cast.status === "trial").length}名`;
  if (document.getElementById("castDetailModal").open) renderCastDetailList();
}

function openCastDetail(type) {
  currentCastDetailType = type;
  document.getElementById("castSearchInput").value = "";
  document.getElementById("castDetailTitle").textContent = {
    active: "在籍キャスト詳細",
    departed: "退店キャスト詳細",
    trial: "体入キャスト詳細"
  }[type] || "キャスト詳細";
  renderCastDetailList();
  document.getElementById("castDetailModal").showModal();
}

function renderCastDetailList() {
  const root = document.getElementById("castDetailList");
  const queryText = document.getElementById("castSearchInput").value.trim().toLocaleLowerCase("ja");
  const members = castMembers.filter((cast) =>
    cast.status === currentCastDetailType
    && (!queryText || String(cast.name || "").toLocaleLowerCase("ja").includes(queryText))
  );
  document.getElementById("castDetailCount").textContent = `${members.length}名を表示`;
  root.replaceChildren();
  if (!members.length) {
    const empty = document.createElement("div");
    empty.className = "notice";
    empty.textContent = queryText ? "検索条件に一致するキャストはいません。" : "対象のキャストはいません。";
    root.appendChild(empty);
    return;
  }
  members.forEach((member) => {
    const row = document.createElement("article");
    row.className = `cast-master-item ${member.status === "departed" ? "cast-departed" : ""}`;
    const identity = document.createElement("div");
    identity.className = "cast-master-name";
    const number = document.createElement("span");
    number.className = "text-xs font-bold text-blue-700";
    number.textContent = member.internalNo ? `No.${String(member.internalNo).padStart(3, "0")}` : "No.-";
    const name = document.createElement("strong");
    name.textContent = member.name;
    const status = document.createElement("span");
    status.className = `staff-status ${member.status === "departed" ? "staff-status-departed" : member.status === "trial" ? "staff-status-trial" : "staff-status-active"}`;
    status.textContent = member.status === "departed" ? "退店済み" : member.status === "trial" ? "体入" : "在籍中";
    identity.append(number, name, status);

    const detail = document.createElement("div");
    detail.className = "cast-master-detail";
    const complete = isCastProfileComplete(member);
    const profileStatus = document.createElement("span");
    profileStatus.className = `profile-status ${complete ? "profile-complete" : "profile-incomplete"}`;
    profileStatus.textContent = complete ? "報酬設定済み" : "報酬設定が必要";
    const reward = document.createElement("span");
    reward.textContent = `報酬：${castRewardLabels[member.rewardSystem] || "未設定"}`;
    const dates = document.createElement("span");
    dates.textContent = `入店日：${member.entryDate || "未設定"}${member.exitedDate ? ` / 退店日：${member.exitedDate}` : ""}`;
    const guarantee = document.createElement("span");
    guarantee.textContent = member.rewardSystem === "guaranteedHourly"
      ? `保証時給：${yen.format(Number(member.guaranteedHourlyRate || 0))}円 / 保証期限：${member.guaranteeNote || "未設定"}`
      : "保証期限：対象外";
    const introducer = document.createElement("span");
    introducer.textContent = member.introducerId
      ? `紹介者：${member.introducerName || introducers.find((item) => item.id === member.introducerId)?.name || "未設定"}${Number(member.advisoryFeeAmount || 0) > 0 ? ` / 顧問料：${yen.format(member.advisoryFeeAmount)}円` : ""}`
      : "紹介者：なし";
    const note = document.createElement("span");
    note.textContent = `備考：${member.note || "なし"}`;
    detail.append(profileStatus, reward, dates, guarantee, introducer, note);

    const actions = document.createElement("div");
    actions.className = "cast-master-actions";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "secondary-button";
    edit.textContent = "報酬・情報を編集";
    edit.addEventListener("click", () => openCastEdit(member));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger-button";
    remove.textContent = "削除";
    remove.addEventListener("click", () => deleteCastData(member));
    actions.append(edit, remove);
    row.append(identity, detail, actions);
    root.appendChild(row);
  });
}

async function deleteCastData(member) {
  if (!confirm(`${member.name}のGMSキャストデータを削除しますか？\n削除後はPOS再同期でも自動復元されません。`)) return;
  try {
    await setDoc(doc(db, castCollectionName, member.id), {
      deleted: true,
      deletedAt: serverTimestamp(),
      deletedBy: currentUser.uid,
      updatedAt: serverTimestamp()
    }, { merge: true });
    await loadCastMembers();
    showMessage("successMessage", `${member.name}のキャストデータを削除しました。`, false);
  } catch (error) {
    showMessage("errorMessage", `キャストデータの削除に失敗しました。${error.message}`);
  }
}

function isCastProfileComplete(member) {
  if (!castRewardLabels[member.rewardSystem]) return false;
  const rewardComplete = member.rewardSystem !== "guaranteedHourly"
    || (
      Boolean(String(member.guaranteeNote || "").trim())
      && Number.isInteger(Number(member.guaranteedHourlyRate))
      && Number(member.guaranteedHourlyRate) > 0
    );
  const advisoryComplete = !member.advisoryFeeEnabled
    || (Number.isInteger(Number(member.advisoryFeeAmount)) && Number(member.advisoryFeeAmount) > 0);
  return rewardComplete && advisoryComplete;
}

function openCastEdit(member) {
  document.getElementById("editingCastId").value = member.id;
  document.getElementById("castEditTitle").textContent = `${member.name}のキャスト情報`;
  document.getElementById("castRewardSystem").value = member.rewardSystem || "";
  document.getElementById("castGuaranteeNote").value = member.guaranteeNote || "";
  document.getElementById("castGuaranteedHourlyRate").value = member.guaranteedHourlyRate || "";
  document.getElementById("castEntryDate").value = member.entryDate || "";
  refreshCastIntroducerSelect(member.introducerId || "");
  document.getElementById("castAdvisoryFeeAmount").value = member.advisoryFeeAmount || "";
  document.getElementById("castNote").value = member.note || "";
  hideMessage("castEditError");
  updateGuaranteeNoteVisibility();
  updateCastAdvisoryFeeVisibility();
  document.getElementById("castEditModal").showModal();
}

function updateGuaranteeNoteVisibility() {
  const isGuaranteed = document.getElementById("castRewardSystem").value === "guaranteedHourly";
  document.getElementById("castGuaranteeNoteField").classList.toggle("hidden", !isGuaranteed);
  document.getElementById("castGuaranteedHourlyRateField").classList.toggle("hidden", !isGuaranteed);
  if (!isGuaranteed) {
    markInvalid(document.getElementById("castGuaranteeNote"), false);
    markInvalid(document.getElementById("castGuaranteedHourlyRate"), false);
  }
}

function updateCastAdvisoryFeeVisibility() {
  const introducer = introducers.find((item) => item.id === document.getElementById("castIntroducerId").value);
  const required = Boolean(introducer?.advisoryFeeEnabled);
  document.getElementById("castAdvisoryFeeField").classList.toggle("hidden", !required);
  if (!required) markInvalid(document.getElementById("castAdvisoryFeeAmount"), false);
}

async function saveCastProfile() {
  const id = document.getElementById("editingCastId").value;
  const member = castMembers.find((cast) => cast.id === id);
  const rewardSystem = document.getElementById("castRewardSystem").value;
  const guaranteeNote = document.getElementById("castGuaranteeNote").value.trim();
  const guaranteedHourlyRate = Number(document.getElementById("castGuaranteedHourlyRate").value);
  const entryDate = document.getElementById("castEntryDate").value;
  const introducerId = document.getElementById("castIntroducerId").value;
  const introducer = introducers.find((item) => item.id === introducerId);
  const advisoryFeeAmount = Number(document.getElementById("castAdvisoryFeeAmount").value);
  const note = document.getElementById("castNote").value.trim();
  if (!member) {
    showMessage("castEditError", "キャスト情報が見つかりません。");
    return;
  }
  if (!castRewardLabels[rewardSystem]) {
    markInvalid(document.getElementById("castRewardSystem"), true);
    showMessage("castEditError", "報酬システムを選択してください。");
    return;
  }
  markInvalid(document.getElementById("castRewardSystem"), false);
  if (rewardSystem === "guaranteedHourly" && !guaranteeNote) {
    markInvalid(document.getElementById("castGuaranteeNote"), true);
    showMessage("castEditError", "保証時給の場合は、何月分まで保証するかを備考へ記載してください。");
    return;
  }
  markInvalid(document.getElementById("castGuaranteeNote"), false);
  if (
    rewardSystem === "guaranteedHourly"
    && (!Number.isInteger(guaranteedHourlyRate) || guaranteedHourlyRate <= 0)
  ) {
    markInvalid(document.getElementById("castGuaranteedHourlyRate"), true);
    showMessage("castEditError", "保証時給の場合は、1円以上の保証時給金額を入力してください。");
    return;
  }
  markInvalid(document.getElementById("castGuaranteedHourlyRate"), false);
  if (introducerId && !introducer) {
    markInvalid(document.getElementById("castIntroducerId"), true);
    showMessage("castEditError", "選択した紹介者情報が見つかりません。紹介者一覧を再読み込みしてください。");
    return;
  }
  markInvalid(document.getElementById("castIntroducerId"), false);
  if (
    introducer?.advisoryFeeEnabled
    && (!Number.isInteger(advisoryFeeAmount) || advisoryFeeAmount <= 0)
  ) {
    markInvalid(document.getElementById("castAdvisoryFeeAmount"), true);
    showMessage("castEditError", "顧問料が発生する紹介者の場合は、1円以上の顧問料金額を入力してください。");
    return;
  }
  markInvalid(document.getElementById("castAdvisoryFeeAmount"), false);
  const button = document.getElementById("saveCastProfileButton");
  button.disabled = true;
  try {
    await setDoc(doc(db, castCollectionName, id), {
      rewardSystem,
      guaranteeNote: rewardSystem === "guaranteedHourly" ? guaranteeNote : "",
      guaranteedHourlyRate: rewardSystem === "guaranteedHourly" ? guaranteedHourlyRate : 0,
      entryDate,
      introducerId: introducer?.id || "",
      introducerName: introducer?.name || "",
      introducerFeeSystem: introducer?.feeSystem || "",
      advisoryFeeEnabled: Boolean(introducer?.advisoryFeeEnabled),
      advisoryFeeAmount: introducer?.advisoryFeeEnabled ? advisoryFeeAmount : 0,
      note,
      profileUpdatedAt: serverTimestamp(),
      profileUpdatedBy: currentUser.uid,
      updatedAt: serverTimestamp()
    }, { merge: true });
    document.getElementById("castEditModal").close();
    await loadCastMembers();
    renderCastDetailList();
    hideMessage("errorMessage");
    showMessage("successMessage", `${member.name}の報酬・キャスト情報を保存しました。`, false);
  } catch (error) {
    showMessage("castEditError", `キャスト情報の保存に失敗しました。${error.message}`);
  } finally {
    button.disabled = false;
  }
}

function legacyJobTypeLabel(role) {
  return {
    manager: "ホールスタッフ",
    bartender: "ホールスタッフ",
    kitchen: "キッチンスタッフ",
    cleaning: "業務区分未設定",
    other: "業務区分未設定"
  }[role] || "業務区分未設定";
}

function legacyJobTypeValue(role) {
  if (role === "kitchen") return "kitchen";
  return "hall";
}

async function updateStaffStatus(member, status) {
  const actionLabel = status === "departed" ? "退店" : "再入店";
  if (!confirm(`${member.name}を${actionLabel}として登録しますか？`)) return;
  try {
    await setDoc(doc(db, staffCollectionName, member.id), {
      status,
      updatedAt: serverTimestamp(),
      updatedBy: currentUser.uid,
      ...(status === "departed"
        ? { departedAt: serverTimestamp() }
        : { joinedAt: serverTimestamp(), departedAt: null })
    }, { merge: true });
    if (status === "departed") {
      document.querySelector(`.staff-work-row[data-staff-id="${CSS.escape(member.id)}"]`)?.remove();
    }
    showMessage("successMessage", `${member.name}を${actionLabel}登録しました。`, false);
    await loadMasters();
  } catch (error) {
    showMessage("errorMessage", `${actionLabel}登録に失敗しました。${error.message}`);
  }
}

function refreshWorkSelects() {
  document.querySelectorAll(".cast-member-select").forEach((select) => {
    fillCastMemberSelect(select, select.value, select.dataset.savedName || "");
  });
}

function fillCastMemberSelect(select, selectedId = "", savedName = "") {
  select.replaceChildren(makeOption("", "選択してください"));
  castMembers.filter((member) => member.status === "active").forEach((member) => {
    select.appendChild(makeOption(member.id, member.name));
  });
  if (selectedId && !castMembers.some((member) => member.id === selectedId && member.status === "active") && savedName) {
    select.appendChild(makeOption(selectedId, `${savedName}（現在は利用不可）`));
  }
  select.dataset.savedName = savedName;
  select.value = selectedId;
  select.onchange = () => {
    const selected = castMembers.find((member) => member.id === select.value);
    select.dataset.savedName = selected?.name || "";
  };
}

function renderStaffAttendancePicker() {
  const root = document.getElementById("staffAttendancePicker");
  const selectedIds = new Set([...document.querySelectorAll(".staff-work-row")].map((row) => row.dataset.staffId));
  root.replaceChildren();
  const activeStaff = staffMembers.filter((member) => member.status !== "departed");
  if (!activeStaff.length) {
    const empty = document.createElement("div");
    empty.className = "notice";
    empty.textContent = "在籍中のスタッフがいません。先にスタッフ管理から入店登録してください。";
    root.appendChild(empty);
    return;
  }
  activeStaff.forEach((member) => {
    const label = document.createElement("label");
    label.className = "attendance-option";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = member.id;
    checkbox.disabled = !isStaffProfileComplete(member);
    checkbox.checked = selectedIds.has(member.id);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        addStaffWorkRow({ staffId: member.id });
        document.querySelector(`.staff-work-unavailable[data-staff-name="${CSS.escape(member.name)}"]`)?.remove();
      } else {
        document.querySelector(`.staff-work-row[data-staff-id="${CSS.escape(member.id)}"]`)?.remove();
      }
    });
    const text = document.createElement("span");
    const detail = isStaffProfileComplete(member)
      ? jobTypeLabels[member.jobType]
      : "スタッフ情報を編集してから選択してください";
    text.innerHTML = `<strong>${escapeHtml(member.name)}</strong><span class="block text-xs text-slate-500">${escapeHtml(detail)}</span>`;
    label.append(checkbox, text);
    root.appendChild(label);
  });
}

function isStaffProfileComplete(member) {
  return Boolean(
    employmentTypeLabels[member.employmentType]
    && jobTypeLabels[member.jobType]
    && payTypeLabels[member.payType]
    && Number.isInteger(Number(member.payAmount))
    && Number(member.payAmount) > 0
  );
}

function escapeHtml(value) {
  const span = document.createElement("span");
  span.textContent = String(value ?? "");
  return span.innerHTML;
}

function addStaffWorkRow(data = {}) {
  const savedName = data.staffName || data.name || "";
  const staffId = data.staffId || matchStaffIdByName(savedName);
  const member = staffMembers.find((item) => item.id === staffId);
  if (!member || !isStaffProfileComplete(member)) {
    addUnavailableStaffNotice(savedName || member?.name || "未登録スタッフ");
    return;
  }
  if (document.querySelector(`.staff-work-row[data-staff-id="${CSS.escape(staffId)}"]`)) return;
  const row = document.createElement("div");
  row.className = "dynamic-row work-row staff-work-row";
  row.dataset.staffId = member.id;
  const name = document.createElement("div");
  name.className = "staff-work-name";
  name.innerHTML = `<strong>${escapeHtml(member.name)}</strong><span class="block text-xs text-slate-500">${escapeHtml(payTypeLabels[member.payType] || "給与形態未設定")}</span>`;
  const startLabel = createTimeField("開始時刻", "staff-work-start", data.startTime || "");
  const endLabel = createTimeField("終了時刻", "staff-work-end", data.endTime || "");
  const hours = document.createElement("input");
  hours.type = "text";
  hours.readOnly = true;
  hours.className = "form-input staff-work-hours";
  hours.value = data.startTime && data.endTime ? formatHours(calculateWorkHours(data.startTime, data.endTime)) : "";
  hours.placeholder = "自動計算";
  const hoursLabel = document.createElement("label");
  hoursLabel.className = "work-field-label";
  hoursLabel.append("稼働時間", hours);
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "danger-button";
  remove.textContent = "選択解除";
  remove.addEventListener("click", () => {
    row.remove();
    const checkbox = document.querySelector(`#staffAttendancePicker input[value="${CSS.escape(member.id)}"]`);
    if (checkbox) checkbox.checked = false;
  });
  [startLabel.querySelector("input"), endLabel.querySelector("input")].forEach((input) => {
    input.addEventListener("input", () => updateStaffWorkHours(row));
  });
  row.append(name, startLabel, endLabel, hoursLabel, remove);
  document.getElementById("staffWorkRows").appendChild(row);
  const checkbox = document.querySelector(`#staffAttendancePicker input[value="${CSS.escape(member.id)}"]`);
  if (checkbox) checkbox.checked = true;
}

function addUnavailableStaffNotice(name) {
  if (document.querySelector(`.staff-work-unavailable[data-staff-name="${CSS.escape(name)}"]`)) return;
  const notice = document.createElement("div");
  notice.className = "notice staff-work-unavailable";
  notice.dataset.staffName = name;
  notice.textContent = `${name}のスタッフ情報が不足しています。スタッフ管理で情報を編集してから、出勤者として選択してください。`;
  document.getElementById("staffWorkRows").appendChild(notice);
}

function createTimeField(labelText, className, value, disabled = false) {
  const label = document.createElement("label");
  label.className = "work-field-label";
  const input = document.createElement("input");
  input.type = "time";
  input.step = "900";
  input.className = `form-input ${className}`;
  input.value = value;
  input.disabled = disabled;
  if (disabled) input.placeholder = "日給は入力不要";
  label.append(labelText, input);
  return label;
}

function matchStaffIdByName(name) {
  return staffMembers.find((member) => member.name === name)?.id || "";
}

function calculateWorkHours(startTime, endTime) {
  if (!startTime || !endTime) return Number.NaN;
  const [startHour, startMinute] = startTime.split(":").map(Number);
  const [endHour, endMinute] = endTime.split(":").map(Number);
  let minutes = endHour * 60 + endMinute - (startHour * 60 + startMinute);
  if (minutes <= 0) minutes += 24 * 60;
  return minutes / 60;
}

function isQuarterTime(time) {
  if (!/^\d{2}:\d{2}$/.test(time)) return false;
  const [hour, minute] = time.split(":").map(Number);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 && minute % 15 === 0;
}

function formatHours(hours) {
  return Number.isFinite(hours) ? `${hours.toFixed(2).replace(/\.00$/, "").replace(/0$/, "")}時間` : "";
}

function updateStaffWorkHours(row) {
  const start = row.querySelector(".staff-work-start");
  const end = row.querySelector(".staff-work-end");
  const hoursInput = row.querySelector(".staff-work-hours");
  const hours = calculateWorkHours(start.value, end.value);
  const valid = isQuarterTime(start.value) && isQuarterTime(end.value) && isQuarterHour(hours);
  markInvalid(start, start.value !== "" && !isQuarterTime(start.value));
  markInvalid(end, end.value !== "" && !isQuarterTime(end.value));
  hoursInput.value = valid ? formatHours(hours) : "";
}

function addCastWorkRow(data = {}) {
  const row = document.createElement("div");
  row.className = "dynamic-row work-row cast-work-row";
  const member = document.createElement("select");
  member.className = "form-select cast-member-select";
  fillCastMemberSelect(member, data.castId || "", data.castName || data.name || "");
  const memberLabel = document.createElement("label");
  memberLabel.className = "work-field-label";
  memberLabel.append("キャスト", member);
  const startLabel = createTimeField("開始時刻", "cast-work-start", data.startTime || "");
  const endLabel = createTimeField("終了時刻", "cast-work-end", data.endTime || "");
  const hours = document.createElement("input");
  hours.type = "text";
  hours.readOnly = true;
  hours.placeholder = "自動計算";
  hours.className = "form-input cast-work-hours";
  hours.value = data.startTime && data.endTime
    ? formatHours(calculateWorkHours(data.startTime, data.endTime))
    : data.hours ? formatHours(Number(data.hours)) : "";
  const hoursLabel = document.createElement("label");
  hoursLabel.className = "work-field-label";
  hoursLabel.append("勤務時間", hours);
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "danger-button";
  remove.textContent = "削除";
  remove.addEventListener("click", () => row.remove());
  [startLabel.querySelector("input"), endLabel.querySelector("input")].forEach((input) => {
    input.addEventListener("input", () => updateCastWorkHours(row));
  });
  row.append(memberLabel, startLabel, endLabel, hoursLabel, remove);
  document.getElementById("castWorkRows").appendChild(row);
}

function updateCastWorkHours(row) {
  const start = row.querySelector(".cast-work-start");
  const end = row.querySelector(".cast-work-end");
  const hoursInput = row.querySelector(".cast-work-hours");
  const hours = calculateWorkHours(start.value, end.value);
  const valid = isQuarterTime(start.value) && isQuarterTime(end.value) && isQuarterHour(hours);
  markInvalid(start, start.value !== "" && !isQuarterTime(start.value));
  markInvalid(end, end.value !== "" && !isQuarterTime(end.value));
  hoursInput.value = valid ? formatHours(hours) : "";
}

function addExpenseRow(data = {}) {
  const row = document.createElement("div");
  row.className = "dynamic-row expense-row";
  const category = document.createElement("select");
  category.className = "form-select expense-category";
  expenseCategories.forEach((item) => category.appendChild(makeOption(item, item)));
  if (data.category && !expenseCategories.includes(data.category)) {
    category.appendChild(makeOption(data.category, `${data.category}（旧データ）`));
  }
  category.value = data.category || "酒代";
  const amount = document.createElement("input");
  amount.type = "number";
  amount.min = "0";
  amount.step = "1";
  amount.className = "form-input expense-amount";
  amount.value = data.amount ?? 0;
  const note = document.createElement("input");
  note.type = "text";
  note.maxLength = 120;
  note.placeholder = "その他の備考（必須）";
  note.className = "form-input expense-note";
  note.value = data.note || "";
  const updateNote = () => {
    const required = category.value === "その他";
    note.classList.toggle("hidden", !required);
    note.required = required;
    if (!required) markInvalid(note, false);
  };
  category.addEventListener("change", updateNote);
  note.addEventListener("input", () => markInvalid(note, category.value === "その他" && !note.value.trim()));
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "danger-button";
  remove.textContent = "削除";
  remove.addEventListener("click", () => row.remove());
  row.append(category, amount, note, remove);
  document.getElementById("expenseRows").appendChild(row);
  updateNote();
}

function addAllowanceRow(data = {}) {
  const row = document.createElement("div");
  row.className = "dynamic-row allowance-row";
  const type = document.createElement("select");
  type.className = "form-select allowance-type";
  allowanceTypes.forEach((item) => type.appendChild(makeOption(item, item)));
  if (data.type && !allowanceTypes.includes(data.type)) {
    type.appendChild(makeOption(data.type, `${data.type}（旧データ）`));
  }
  type.value = data.type || "美容室";
  const amount = document.createElement("input");
  amount.type = "number";
  amount.min = "0";
  amount.step = "1";
  amount.className = "form-input allowance-amount";
  amount.value = data.amount ?? 0;
  const recipient = document.createElement("select");
  recipient.className = "form-select allowance-recipient";
  const note = document.createElement("input");
  note.type = "text";
  note.maxLength = 120;
  note.placeholder = "その他の備考（必須）";
  note.className = "form-input allowance-note";
  note.value = data.note || "";
  const refreshRecipient = () => {
    const savedId = data.recipientId || recipient.value;
    const savedName = data.recipientName || data.recipient || recipient.dataset.savedName || "";
    const members = type.value === "美容室"
      ? castMembers.filter((member) => member.status === "active")
      : staffMembers.filter((member) => member.status !== "departed");
    recipient.replaceChildren(makeOption("", "支給対象者を選択"));
    members.forEach((member) => {
      const option = makeOption(member.id, member.name);
      option.dataset.name = member.name;
      recipient.appendChild(option);
    });
    const matched = members.find((member) =>
      member.id === savedId
      || member.name === savedName
      || (type.value === "美容室" && String(member.posCastId || "") === String(savedId || ""))
    );
    if (matched) {
      recipient.value = matched.id;
      recipient.dataset.savedName = matched.name;
    } else if (savedName) {
      const option = makeOption(savedId || `legacy:${savedName}`, `${savedName}（旧データ）`);
      option.dataset.name = savedName;
      recipient.appendChild(option);
      recipient.value = option.value;
      recipient.dataset.savedName = savedName;
    }
  };
  const updateNote = () => {
    const required = type.value === "その他";
    note.classList.toggle("hidden", !required);
    note.required = required;
    if (!required) markInvalid(note, false);
  };
  type.addEventListener("change", () => {
    recipient.dataset.savedName = "";
    data.recipientId = "";
    data.recipientName = "";
    data.recipient = "";
    refreshRecipient();
    updateNote();
  });
  recipient.addEventListener("change", () => {
    recipient.dataset.savedName = recipient.selectedOptions[0]?.dataset.name || "";
  });
  note.addEventListener("input", () => markInvalid(note, type.value === "その他" && !note.value.trim()));
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "danger-button";
  remove.textContent = "削除";
  remove.addEventListener("click", () => row.remove());
  row.append(type, amount, recipient, note, remove);
  document.getElementById("allowanceRows").appendChild(row);
  refreshRecipient();
  updateNote();
}

function resetRows() {
  document.getElementById("staffWorkRows").replaceChildren();
  document.getElementById("castWorkRows").replaceChildren();
  document.getElementById("trialCastWorkRows").replaceChildren();
  document.getElementById("trialCastWorkSection").classList.add("hidden");
  document.getElementById("expenseRows").replaceChildren();
  document.getElementById("allowanceRows").replaceChildren();
  renderStaffAttendancePicker();
  addCastWorkRow();
  addExpenseRow();
  addAllowanceRow();
}

function wireRealtimeValidation() {
  document.getElementById("reportForm").addEventListener("input", (event) => {
    if (event.target.matches("input[type='number']")) validateNumberInput(event.target);
    if (event.target.matches(".staff-work-start, .staff-work-end")) {
      updateStaffWorkHours(event.target.closest(".staff-work-row"));
    }
    if (event.target.matches(".cast-work-start, .cast-work-end")) {
      updateCastWorkHours(event.target.closest(".cast-work-row"));
    }
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
  const isHour = el.matches(".cast-work-hours");
  const invalid = isHour ? !isWorkHour(value) : value < 0 || !Number.isInteger(value);
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
      const member = staffMembers.find((item) => item.id === row.dataset.staffId);
      const startTime = row.querySelector(".staff-work-start").value;
      const endTime = row.querySelector(".staff-work-end").value;
      return {
        staffId: member?.id || row.dataset.staffId || "",
        staffName: member?.name || "",
        employmentType: member?.employmentType || "",
        jobType: member?.jobType || "",
        payType: member?.payType || "",
        payAmount: Number(member?.payAmount || 0),
        startTime,
        endTime,
        hours: calculateWorkHours(startTime, endTime)
      };
    })
    .filter((row) => row.staffId || row.staffName);

  const castWork = [...document.querySelectorAll(".cast-work-row")]
    .map((row) => {
      const select = row.querySelector(".cast-member-select");
      const member = castMembers.find((item) => item.id === select.value);
      const startTime = row.querySelector(".cast-work-start").value;
      const endTime = row.querySelector(".cast-work-end").value;
      return {
        castId: member?.posCastId || select.value,
        castName: member?.name || select.dataset.savedName || "",
        startTime,
        endTime,
        hours: calculateWorkHours(startTime, endTime)
      };
    })
    .filter((row) => row.castId || row.castName || row.hours > 0);

  const trialWork = [...document.querySelectorAll(".trial-cast-work-row")].map((row) => ({
    castId: row.dataset.castId || "",
    castName: row.dataset.castName || "",
    startTime: row.dataset.startTime || "",
    endTime: row.dataset.endTime || "",
    hours: Number(row.dataset.hours || 0),
    introducerName: row.querySelector(".trial-introducer-name").value.trim(),
    hourlyRate: Number(row.querySelector(".trial-hourly-rate").value || 0)
  }));

  const expenses = [...document.querySelectorAll(".expense-row")]
    .map((row) => ({
      category: row.querySelector(".expense-category").value,
      amount: Number(row.querySelector(".expense-amount").value || 0),
      note: row.querySelector(".expense-note").value.trim()
    }))
    .filter((row) => row.amount > 0 || row.note || row.category === "その他");

  const allowances = [...document.querySelectorAll(".allowance-row")]
    .map((row) => {
      const recipient = row.querySelector(".allowance-recipient");
      const recipientName = recipient.selectedOptions[0]?.dataset.name || recipient.dataset.savedName || "";
      return {
        type: row.querySelector(".allowance-type").value,
        amount: Number(row.querySelector(".allowance-amount").value || 0),
        recipientId: recipient.value,
        recipient: recipientName,
        recipientName,
        note: row.querySelector(".allowance-note").value.trim()
      };
    })
    .filter((row) => row.amount > 0 || row.recipient || row.note || row.type === "その他");

  return { staffWork, castWork, trialWork, expenses, allowances };
}

function buildPayload() {
  const businessDate = textValue("date");
  const totalSales = numberValue("totalSales");
  const totalCustomers = numberValue("totalCustomers");
  const rows = collectRows();
  const payload = {
    businessDate,
    date: businessDate,
    status: "submitted",
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
    transactions: normalizeTransactions(selectedPending?.transactions),
    castSales: selectedPending?.castSales || [],
    staffWork: rows.staffWork,
    castWork: rows.castWork,
    trialWork: rows.trialWork,
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
    if (!isQuarterTime(row.startTime) || !isQuarterTime(row.endTime)) {
      errors.push("スタッフの開始・終了時刻は15分単位で入力してください。");
    }
    if (!isQuarterHour(row.hours)) {
      errors.push("スタッフの稼働時間は0時間超〜24時間以内で入力してください。");
    }
  });
  payload.castWork.forEach((row) => {
    if (!row.castId && !row.castName) errors.push("勤務するキャストを登録一覧から選択してください。");
    if (!isQuarterTime(row.startTime) || !isQuarterTime(row.endTime)) {
      errors.push("キャストの開始・終了時刻は15分単位で入力してください。");
    }
    if (!isQuarterHour(row.hours)) errors.push("キャスト勤務時間は0時間超〜24時間以内で入力してください。");
  });
  payload.trialWork.forEach((row) => {
    if (!row.castId || !row.castName) errors.push("体入キャスト情報を確認してください。");
    if (!isQuarterTime(row.startTime) || !isQuarterTime(row.endTime) || !isQuarterHour(row.hours)) {
      errors.push(`${row.castName || "体入キャスト"}の勤務時間を確認してください。`);
    }
    if (!row.introducerName) errors.push(`${row.castName || "体入キャスト"}の紹介者を入力してください。`);
    if (!Number.isInteger(row.hourlyRate) || row.hourlyRate <= 0) errors.push(`${row.castName || "体入キャスト"}の当日時給を1円以上で入力してください。`);
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
    if (row.category === "その他" && !row.note) errors.push("経費「その他」の備考を入力してください。");
  });
  payload.allowances.forEach((row) => {
    if (!row.type || !isNonNegativeInteger(row.amount) || !row.recipient) errors.push("手当の種類、金額、支給対象者を確認してください。");
    if (row.type === "その他" && !row.note) errors.push("手当「その他」の備考を入力してください。");
    const isCastRecipient = castMembers.some((member) => member.id === row.recipientId && member.status === "active");
    const isStaffRecipient = staffMembers.some((member) => member.id === row.recipientId && member.status !== "departed");
    if (row.type === "美容室" && !isCastRecipient && !String(row.recipientId).startsWith("legacy:")) {
      errors.push("美容室手当の対象者は在籍キャストから選択してください。");
    }
    if (row.type !== "美容室" && !isStaffRecipient && !String(row.recipientId).startsWith("legacy:")) {
      errors.push(`${row.type}の対象者は在籍スタッフから選択してください。`);
    }
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
    document.getElementById("errorMessage").scrollIntoView();
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
    `会計データ：${pendingPayload.transactions.length}件`,
    `体入キャスト：${pendingPayload.trialWork.length}名`,
    `経費合計：${yen.format(expenseTotal)}円 / 手当合計：${yen.format(allowanceTotal)}円`
  ].forEach((text) => {
    const p = document.createElement("p");
    p.textContent = text;
    summary.appendChild(p);
  });
  hideMessage("confirmSaveError");
  document.getElementById("confirmModal").showModal();
}

async function saveReport() {
  if (isSaving || !pendingPayload) return;
  isSaving = true;
  document.getElementById("saveButton").disabled = true;
  document.getElementById("confirmSaveButton").disabled = true;
  hideMessage("confirmSaveError");

  try {
    await setDoc(doc(db, closingsCollectionName, pendingPayload.businessDate), pendingPayload, { merge: true });
    await Promise.all(pendingPayload.trialWork.map((row) => setDoc(
      doc(db, trialCastCollectionName, trialCastRecordId(pendingPayload.businessDate, row.castId)),
      {
        ...row,
        businessDate: pendingPayload.businessDate,
        sourceClosingId: pendingPayload.businessDate,
        updatedBy: currentUser.uid,
        updatedAt: serverTimestamp()
      },
      { merge: true }
    )));
    if (selectedPending?.sourceCollection === shopClosingsCollectionName) {
      try {
        await setDoc(doc(db, shopClosingsCollectionName, selectedPending.businessDate), {
          status: "submitted",
          reviewedBy: currentUser.uid,
          reviewedAt: serverTimestamp()
        }, { merge: true });
      } catch (sourceError) {
        console.warn("POS締め状態の更新に失敗しました。", sourceError);
      }
    }
    document.getElementById("confirmModal").close();
    selectedPending = null;
    await loadClosingLists();
    showMessage("successMessage", "経理側へ送信しました。", false);
  } catch (error) {
    const message = `経理送信に失敗しました。${firestoreErrorMessage(error)}`;
    showMessage("confirmSaveError", message);
    showMessage("errorMessage", message);
  } finally {
    isSaving = false;
    document.getElementById("saveButton").disabled = false;
    document.getElementById("confirmSaveButton").disabled = false;
  }
}

function firestoreErrorMessage(error) {
  if (error?.code === "permission-denied") {
    return "ログインユーザーのroleまたはFirestoreルールを確認してください。";
  }
  if (error?.code === "unavailable") {
    return "Firebaseへ接続できません。通信状態を確認して再度お試しください。";
  }
  return error?.message || "原因不明のエラーです。";
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

function loadClosingIntoForm(closing, isSent = false) {
  selectedPending = closing;
  applyClosingToForm(closing);
  document.getElementById(isSent ? "sentClosingModal" : "pendingClosingModal").close();
  showWorkspace("closing");
  hideMessage("errorMessage");
  showMessage(
    "successMessage",
    isSent
      ? `${closing.businessDate} の送信済データを読み込みました。編集後、経理へ再送信できます。`
      : `${closing.businessDate} のPOS締めデータを読み込みました。確認後、経理へ送信してください。`,
    false
  );
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
  renderTransactions(data.transactions);
  document.getElementById("staffWorkRows").replaceChildren();
  normalizeStaffWork(data.staffWork || data.staffHours).forEach(addStaffWorkRow);
  renderStaffAttendancePicker();
  const normalizedWork = normalizeCastWork(data.castWork || data.castHours);
  const trialIds = new Set((data.trialCasts || []).map((cast) => String(cast.castId || "")));
  const trialWork = Array.isArray(data.trialWork) && data.trialWork.length
    ? data.trialWork
    : normalizedWork.filter((row) => row.isTrial || trialIds.has(String(row.posCastId || row.castId || "")));
  const regularWork = normalizedWork.filter((row) => !trialWork.some((trial) =>
    String(trial.posCastId || trial.castId) === String(row.posCastId || row.castId)
  ));
  document.getElementById("castWorkRows").replaceChildren();
  regularWork.forEach(addCastWorkRow);
  if (!document.getElementById("castWorkRows").children.length) addCastWorkRow();
  renderTrialCastWork(trialWork, data.trialCasts || []);
  document.getElementById("expenseRows").replaceChildren();
  (data.expenses?.length ? data.expenses : [{}]).forEach(addExpenseRow);
  document.getElementById("allowanceRows").replaceChildren();
  (data.allowances?.length ? data.allowances : [{}]).forEach(addAllowanceRow);
  calculateUnitPrice();
  checkSalesWarning();
}

function normalizeTransactions(transactions) {
  if (!Array.isArray(transactions)) return [];
  return transactions.map((transaction) => ({
    transactionId: String(transaction.transactionId || transaction.id || ""),
    tableId: String(transaction.tableId || ""),
    tableLabel: String(transaction.tableLabel || ""),
    startTime: Number(transaction.startTime || 0),
    endTime: Number(transaction.endTime || 0),
    guests: Number(transaction.guests || 0),
    note: String(transaction.note || ""),
    payMethod: transaction.payMethod === "card" ? "card" : "cash",
    splits: Array.isArray(transaction.splits)
      ? transaction.splits.map((split) => ({
        method: split.method === "card" ? "card" : "cash",
        amount: Number(split.amount || 0)
      }))
      : [],
    subtotal: Number(transaction.subtotal || 0),
    discount: Number(transaction.discount || 0),
    tax: Number(transaction.tax || 0),
    total: Number(transaction.total || 0),
    items: Array.isArray(transaction.items)
      ? transaction.items.map((item) => ({
        itemId: String(item.itemId || item.id || ""),
        label: String(item.label || ""),
        category: String(item.category || ""),
        price: Number(item.price || 0),
        quantity: Number(item.quantity ?? item.qty ?? 0),
        castId: String(item.castId || ""),
        banaiExtCastIds: Array.isArray(item.banaiExtCastIds) ? item.banaiExtCastIds.map(String) : [],
        banaiExtCastId: String(item.banaiExtCastId || ""),
        isSet: Boolean(item.isSet),
        isHonShimei: Boolean(item.isHonShimei),
        isBanaiShimei: Boolean(item.isBanaiShimei),
        isExtension: Boolean(item.isExtension),
        isBanaiExtension: Boolean(item.isBanaiExtension),
        isVipCharge: Boolean(item.isVipCharge),
        isDiscount: Boolean(item.isDiscount)
      }))
      : []
  }));
}

function renderTransactions(transactions) {
  const root = document.getElementById("transactionDetails");
  const normalized = normalizeTransactions(transactions);
  root.replaceChildren();
  if (!normalized.length) {
    const empty = document.createElement("div");
    empty.className = "notice";
    empty.textContent = "この締めデータには会計明細がありません。POS Ver6.52以降の締めデータから連携されます。";
    root.appendChild(empty);
    return;
  }
  normalized.forEach((transaction) => {
    const block = document.createElement("article");
    block.className = "transaction-block";
    const heading = document.createElement("div");
    heading.className = "transaction-heading";
    const title = document.createElement("strong");
    title.textContent = `${transaction.tableLabel || "テーブル未設定"} / ${transaction.guests}名`;
    const meta = document.createElement("span");
    meta.className = "transaction-meta";
    meta.textContent = `会計ID ${transaction.transactionId || "-"} / ${formatTransactionTime(transaction.startTime)} - ${formatTransactionTime(transaction.endTime)} / ${paymentLabel(transaction)}`;
    heading.append(title, meta);
    const summary = document.createElement("div");
    summary.className = "transaction-meta mb-2";
    summary.textContent = `小計 ${yen.format(transaction.subtotal)}円 / 割引 ${yen.format(transaction.discount)}円 / 税・SC ${yen.format(transaction.tax)}円 / 合計 ${yen.format(transaction.total)}円`;
    if (transaction.note) summary.textContent += ` / 備考 ${transaction.note}`;
    const wrap = document.createElement("div");
    wrap.className = "transaction-table-wrap";
    const table = document.createElement("table");
    table.className = "detail-mini-table";
    table.innerHTML = "<thead><tr><th>明細</th><th>単価</th><th>数量</th><th>金額</th></tr></thead>";
    const tbody = document.createElement("tbody");
    transaction.items.forEach((item) => {
      const row = document.createElement("tr");
      [item.label, `${yen.format(item.price)}円`, item.quantity, `${yen.format(item.price * item.quantity)}円`].forEach((value) => {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.appendChild(cell);
      });
      tbody.appendChild(row);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    block.append(heading, summary, wrap);
    root.appendChild(block);
  });
}

function formatTransactionTime(value) {
  const timestamp = Number(value || 0);
  if (!timestamp) return "--:--";
  return new Date(timestamp).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
}

function paymentLabel(transaction) {
  if (transaction.splits.length) {
    return transaction.splits
      .map((split) => `${split.method === "card" ? "カード" : "現金"} ${yen.format(split.amount)}円`)
      .join(" / ");
  }
  return transaction.payMethod === "card" ? "カード" : "現金";
}

function normalizeStaffWork(work) {
  if (Array.isArray(work)) {
    return work.map((row) => ({
      ...row,
      staffId: row.staffId || matchStaffIdByName(row.staffName || row.name || ""),
      hours: Number(row.hours || 0)
    }));
  }
  if (!work || typeof work !== "object") return [];
  return [];
}

function normalizeCastWork(work) {
  if (!Array.isArray(work)) return [];
  return work.map((row) => {
    const member = castMembers.find((cast) =>
      String(cast.posCastId || "") === String(row.castId || "")
      || cast.id === row.castId
      || cast.name === (row.castName || row.name)
    );
    return {
      ...row,
      castId: member?.id || row.castId || "",
      posCastId: member?.posCastId || row.castId || "",
      isTrial: row.isTrial === true || row.castType === "trial" || member?.status === "trial",
      hours: Number(row.hours || 0)
    };
  });
}

function renderTrialCastWork(work, trialCasts) {
  const section = document.getElementById("trialCastWorkSection");
  const root = document.getElementById("trialCastWorkRows");
  root.replaceChildren();
  const trialMap = new Map(trialCasts.map((cast) => [String(cast.castId || ""), cast]));
  work.forEach((row) => {
    const trial = trialMap.get(String(row.posCastId || row.castId || "")) || {};
    const item = document.createElement("article");
    item.className = "dynamic-row trial-cast-work-row";
    item.dataset.castId = String(row.posCastId || row.castId || trial.castId || "");
    item.dataset.castName = row.castName || row.name || trial.castName || "";
    item.dataset.startTime = row.startTime || "";
    item.dataset.endTime = row.endTime || "";
    item.dataset.hours = String(row.hours || calculateWorkHours(row.startTime, row.endTime) || 0);
    const identity = document.createElement("div");
    identity.innerHTML = `<strong>${escapeHtml(item.dataset.castName)}</strong><span class="block text-xs text-slate-500">${escapeHtml(item.dataset.startTime)}-${escapeHtml(item.dataset.endTime)} / ${escapeHtml(formatHours(Number(item.dataset.hours)))}</span>`;
    const introducer = document.createElement("input");
    introducer.type = "text";
    introducer.maxLength = 40;
    introducer.placeholder = "紹介者（必須）";
    introducer.className = "form-input trial-introducer-name";
    introducer.value = row.introducerName || "";
    const hourlyRate = document.createElement("input");
    hourlyRate.type = "number";
    hourlyRate.min = "1";
    hourlyRate.step = "1";
    hourlyRate.placeholder = "当日時給（必須）";
    hourlyRate.className = "form-input trial-hourly-rate";
    hourlyRate.value = row.hourlyRate || "";
    hourlyRate.addEventListener("input", () => {
      const amount = Number(hourlyRate.value);
      markInvalid(hourlyRate, hourlyRate.value !== "" && (!Number.isInteger(amount) || amount <= 0));
    });
    item.append(identity, introducer, hourlyRate);
    root.appendChild(item);
  });
  section.classList.toggle("hidden", !work.length);
}

function trialCastRecordId(date, castId) {
  return `${date}_${String(castId).replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}
