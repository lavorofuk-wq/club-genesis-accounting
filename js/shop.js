import {
  db,
  posDb,
  collection,
  doc,
  getDocs,
  getDoc,
  setDoc,
  query,
  where,
  ref,
  get,
  serverTimestamp,
  closingsCollectionName,
  staffCollectionName,
  castCollectionName,
  introducerCollectionName,
  trialCastCollectionName,
  posCastPath
} from "./firebase-config.js";
import { requireRole, logout, showMessage, hideMessage } from "./auth.js";
import { initInternalMail } from "./internal-mail.js";

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
let posCastLinkCandidates = [];

document.getElementById("logoutButton").addEventListener("click", logout);
document.getElementById("openRegistrationButton").addEventListener("click", () => showWorkspace("registration"));
document.getElementById("openClosingButton").addEventListener("click", openPendingClosingModal);
document.getElementById("openSentClosingsButton").addEventListener("click", openSentClosingModal);
document.querySelectorAll("[data-mail-open]").forEach((button) => {
  button.addEventListener("click", () => showWorkspace("mail"));
});
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
document.getElementById("importClosingJsonButton").addEventListener("click", () => {
  document.getElementById("closingJsonFileInput").click();
});
document.getElementById("closingJsonFileInput").addEventListener("change", handleClosingJsonFile);
document.getElementById("sentClosingDateSearch").addEventListener("input", renderSentClosings);
document.getElementById("clearSentClosingDateButton").addEventListener("click", () => {
  document.getElementById("sentClosingDateSearch").value = "";
  renderSentClosings();
});
document.getElementById("registerStaffButton").addEventListener("click", registerStaff);
document.getElementById("cancelStaffEditButton").addEventListener("click", resetStaffForm);
document.getElementById("newStaffEmploymentType").addEventListener("change", updateStaffEmploymentFields);
updateStaffEmploymentFields();
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
document.getElementById("castProfileName").addEventListener("input", (event) => {
  markInvalid(event.target, !event.target.value.trim());
});
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
document.getElementById("posCastLinkSearch").addEventListener("input", renderPosCastLinkOptions);
document.getElementById("posCastLinkSelect").addEventListener("change", renderPosCastLinkPreview);
document.getElementById("savePosCastLinkButton").addEventListener("click", savePosCastLink);
document.getElementById("addCastWorkButton").addEventListener("click", () => addCastWorkRow());
document.getElementById("addExpenseButton").addEventListener("click", () => addExpenseRow());
document.getElementById("addAllowanceButton").addEventListener("click", () => addAllowanceRow());
document.getElementById("openTransportDeductionButton").addEventListener("click", openTransportDeductionModal);
document.getElementById("saveTransportDeductionButton").addEventListener("click", saveTransportDeductionsFromModal);
document.getElementById("openPayrollDeductionButton").addEventListener("click", openPayrollDeductionModal);
document.getElementById("savePayrollDeductionButton").addEventListener("click", savePayrollDeductionsFromModal);
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
  initInternalMail({
    role: "shop",
    currentUser: user,
    onError: (message) => showMessage("errorMessage", message),
    onSuccess: (message) => showMessage("successMessage", message, false)
  });
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

async function handleClosingJsonFile(event) {
  hideMessage("errorMessage");
  hideMessage("successMessage");
  const input = event.target;
  const status = document.getElementById("closingJsonImportStatus");
  const file = input.files?.[0];
  if (!file) return;
  status.textContent = "JSONを読み込んでいます。";
  try {
    const text = await file.text();
    const parsed = JSON.parse(stripBom(text));
    const closing = normalizeImportedClosingJson(parsed, file.name);
    pendingClosings = [
      closing,
      ...pendingClosings.filter((item) => item.id !== closing.id)
    ];
    renderPendingClosings();
    loadClosingIntoForm(closing);
    status.textContent = `${closing.businessDate} のPOS JSONを読み込みました。内容を確認して経理へ送信してください。`;
    showMessage("successMessage", `${closing.businessDate} のPOS JSONを店舗作業フォームに読み込みました。`, false);
  } catch (error) {
    status.textContent = "JSONを読み込めませんでした。ファイル形式を確認してください。";
    showMessage("errorMessage", `POS JSONの読み込みに失敗しました。${error.message}`);
  } finally {
    input.value = "";
  }
}

function stripBom(text) {
  return String(text || "").replace(/^\uFEFF/, "");
}

function normalizeImportedClosingJson(data, fileName) {
  const errors = validateImportedClosingJson(data);
  if (errors.length) throw new Error(errors.join(" / "));
  const businessDate = String(data.businessDate || data.date || "");
  const checksum = String(data.checksum || "");
  if (checksum && checksum !== closingChecksum(data)) {
    throw new Error("チェックサムが一致しません。POSからJSONを再出力してください。");
  }
  const importId = String(data.source?.submissionId || `pos_json_${businessDate}_${checksum || Date.now()}`);
  return {
    ...data,
    id: importId,
    businessDate,
    date: businessDate,
    status: "submitted",
    sourceCollection: "pos-json-file",
    source: {
      ...(data.source || {}),
      submissionId: importId,
      sourceDocumentId: importId,
      importMethod: "jsonFile",
      importedFileName: String(fileName || ""),
      importedAt: new Date().toISOString()
    },
    transactions: normalizeTransactions(data.transactions),
    castSales: Array.isArray(data.castSales) ? data.castSales : [],
    castWork: normalizeCastWork(data.castWork || data.castHours),
    staffWork: normalizeStaffWork(data.staffWork || data.staffHours),
    enteredCasts: Array.isArray(data.enteredCasts) ? data.enteredCasts : [],
    exitedCasts: Array.isArray(data.exitedCasts) ? data.exitedCasts : [],
    trialCasts: Array.isArray(data.trialCasts) ? data.trialCasts : []
  };
}

function validateImportedClosingJson(data) {
  const errors = [];
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return ["JSONの中身が締めデータ形式ではありません。"];
  }
  if (data.schema !== "club-genesis-pos-closing") {
    errors.push("schemaがclub-genesis-pos-closingではありません。");
  }
  if (Number(data.schemaVersion || 0) !== 1) {
    errors.push("schemaVersion 1のJSONを選択してください。");
  }
  const businessDate = String(data.businessDate || data.date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
    errors.push("businessDateがYYYY-MM-DD形式ではありません。");
  }
  if (!data.sales || typeof data.sales !== "object") {
    errors.push("salesがありません。");
  }
  if (!data.customers || typeof data.customers !== "object") {
    errors.push("customersがありません。");
  }
  if (!data.nominations || typeof data.nominations !== "object") {
    errors.push("nominationsがありません。");
  }
  if (!Array.isArray(data.transactions)) {
    errors.push("各テーブルの会計データ transactions がありません。");
  }
  if (!Array.isArray(data.castWork)) {
    errors.push("キャスト勤務情報 castWork がありません。");
  }
  if (!Array.isArray(data.castSales)) {
    errors.push("本指名売上・場内延長売上データ castSales がありません。");
  }
  return errors;
}

function closingChecksum(payload) {
  const copy = { ...payload };
  delete copy.checksum;
  const text = JSON.stringify(copy);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (`00000000${(hash >>> 0).toString(16)}`).slice(-8);
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

function requiresStaffTimeInput(member) {
  return member?.employmentType !== "employee" && member?.payType === "hourly" && member?.jobType !== "driver";
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
    const posCasts = await loadPosCastCandidates();
    if (!posCasts.length) {
      throw new Error("POSに通常キャストの名簿データがありません。");
    }
    const localByPosId = new Map(allCastMembers
      .filter((cast) => cast.deleted !== true && cast.posCastId)
      .map((cast) => [String(cast.posCastId), cast]));
    await Promise.all(posCasts.map((posCast) => {
      const existing = localByPosId.get(posCast.posCastId);
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

async function loadPosCastCandidates() {
  const snapshot = await get(ref(posDb, posCastPath));
  const rawCasts = snapshot.val();
  return (Array.isArray(rawCasts) ? rawCasts : Object.values(rawCasts || {}))
    .filter((cast) => cast && cast.castType !== "trial" && cast.id != null && String(cast.name || "").trim())
    .map(normalizePosCast)
    .sort((a, b) =>
      Number(a.internalNo || Number.MAX_SAFE_INTEGER) - Number(b.internalNo || Number.MAX_SAFE_INTEGER)
      || String(a.name || "").localeCompare(String(b.name || ""), "ja")
    );
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

function findCastMemberByPosId(posCastId) {
  return allCastMembers.find((member) =>
    member.deleted !== true && String(member.posCastId || member.id || "") === String(posCastId || "")
  );
}

function trialCastMemberPayload(row) {
  const existing = findCastMemberByPosId(row.castId);
  const posCastId = String(row.castId || existing?.posCastId || "");
  const name = String(row.castName || existing?.name || "");
  return {
    posCastId,
    name,
    internalNo: Number(row.internalNo || existing?.internalNo || 0),
    status: existing?.status || "trial",
    source: existing?.source || "pos",
    personKey: existing?.personKey || `person_${existing?.id || castDocumentId(posCastId)}`,
    introducerId: row.introducerId || existing?.introducerId || "",
    introducerName: row.introducerName || existing?.introducerName || "",
    introducerFeeSystem: row.introducerFeeSystem || existing?.introducerFeeSystem || "",
    advisoryFeeEnabled: row.advisoryFeeEnabled === true || existing?.advisoryFeeEnabled === true,
    advisoryFeeAmount: Number(existing?.advisoryFeeAmount || 0),
    updatedBy: currentUser.uid,
    updatedAt: serverTimestamp()
  };
}

function castNumberLabel(value) {
  const number = Number(value || 0);
  return number ? `No.${String(number).padStart(3, "0")}` : "No.-";
}

function castDisplayName(member) {
  return `${castNumberLabel(member?.internalNo)} ${member?.name || ""}`.trim();
}

function personKeyFor(member) {
  return member?.personKey || `person_${member?.id || member?.posCastId || Date.now()}`;
}

function normalizeAliasList(value) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
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
    const closingSnap = await getDocs(collection(db, closingsCollectionName));
    const closingItems = closingSnap.docs.map((docSnap) => ({
      sourceCollection: closingsCollectionName,
      id: docSnap.id,
      ...docSnap.data()
    }));
    const items = [...closingItems];
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
    const processedSourceIds = new Set(sentClosings
      .map((item) => String(item.source?.sourceDocumentId || item.source?.submissionId || ""))
      .filter(Boolean));
    const legacySentDates = new Set(sentClosings
      .filter((item) => !item.source?.sourceDocumentId && !item.source?.submissionId)
      .map((item) => item.businessDate));
    pendingClosings = closingItems.flatMap((item) => {
      const date = item.businessDate || item.date || item.id;
      if (!date || item.status !== "submitted" || processedSourceIds.has(item.id)) return [];
      if (item.id === date && legacySentDates.has(date)) return [];
      return [{ ...item, businessDate: date }];
    }).sort((a, b) =>
      b.businessDate.localeCompare(a.businessDate)
      || closingSubmittedMillis(b) - closingSubmittedMillis(a)
      || b.id.localeCompare(a.id)
    );
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
  const mergeLifecycleUpdate = (update) => {
    const key = String(update.posCastId || "");
    const current = updates.get(key) || {};
    updates.set(key, {
      ...current,
      ...update,
      entryDate: current.entryDate || update.entryDate || "",
      posEnteredAt: current.posEnteredAt || update.posEnteredAt || 0,
      exitedDate: update.exitedDate || current.exitedDate || "",
      posExitedAt: update.posExitedAt || current.posExitedAt || 0
    });
  };
  [...closings]
    .sort((a, b) => String(a.businessDate || a.date || "").localeCompare(String(b.businessDate || b.date || "")))
    .forEach((closing) => {
    const eventDate = closing.businessDate || closing.date || "";
    (closing.enteredCasts || []).forEach((cast) => {
      if (cast.castId == null || !String(cast.castName || "").trim()) return;
      mergeLifecycleUpdate({
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
      mergeLifecycleUpdate({
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
      mergeLifecycleUpdate({
        posCastId: String(cast.castId),
        name: String(cast.castName).trim(),
        internalNo: Number(cast.internalNo || 0),
        status: "trial",
        entryDate: cast.trialBizDay || eventDate,
        trialBizDay: cast.trialBizDay || eventDate,
        posEnteredAt: Number(cast.trialRegisteredAt || 0),
        posExitedAt: Number(cast.trialEndedAt || 0)
      });
    });
  });
  if (!updates.size) return;
  const byPosId = new Map(allCastMembers
    .filter((cast) => cast.deleted !== true)
    .map((cast) => [String(cast.posCastId || ""), cast]));
  await Promise.all([...updates.values()].map((update) => {
    const existing = byPosId.get(update.posCastId);
    const previousPosCastIds = new Set(normalizeAliasList(existing?.previousPosCastIds));
    if (existing?.posCastId && existing.posCastId !== update.posCastId) previousPosCastIds.add(String(existing.posCastId));
    const changed = !existing
      || existing.name !== update.name
      || existing.status !== update.status
      || Number(existing.internalNo || 0) !== update.internalNo
      || (update.entryDate && existing.entryDate !== update.entryDate)
      || (update.exitedDate && existing.exitedDate !== update.exitedDate)
      || (update.trialBizDay && existing.trialBizDay !== update.trialBizDay)
      || (update.posEnteredAt && existing.posEnteredAt !== update.posEnteredAt)
      || (update.posExitedAt && existing.posExitedAt !== update.posExitedAt)
      || previousPosCastIds.size !== normalizeAliasList(existing?.previousPosCastIds).length;
    if (!changed) return Promise.resolve();
    return setDoc(doc(db, castCollectionName, existing?.id || castDocumentId(update.posCastId)), {
      ...update,
      personKey: existing?.personKey || `person_${existing?.id || castDocumentId(update.posCastId)}`,
      previousPosCastIds: [...previousPosCastIds],
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
    const duplicateCount = pendingClosings.filter((item) => item.businessDate === closing.businessDate).length;
    const duplicateLabel = duplicateCount > 1 ? ` / 重複受信 ${duplicateCount}件` : "";
    const info = document.createElement("div");
    info.innerHTML = `
      <div class="font-bold text-slate-900">${closing.businessDate}</div>
      <div class="mt-1 text-sm text-slate-600">総売上 ${yen.format(total)}円 / 会計 ${transactionCount}件 / 受信 ${closingSubmissionLabel(closing)}${duplicateLabel}</div>
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
  const isEmployee = employmentType === "employee";
  const jobType = isEmployee ? "" : document.getElementById("newStaffJobType").value;
  const payType = isEmployee ? "" : document.getElementById("newStaffPayType").value;
  const payAmountInput = document.getElementById("newStaffPayAmount");
  const payAmount = isEmployee ? 0 : Number(payAmountInput.value);
  if (!name) {
    showMessage("errorMessage", "スタッフ名を入力してください。");
    return;
  }
  if (staffMembers.some((member) => member.name === name && member.id !== editingStaffId)) {
    showMessage("errorMessage", "同じ名前のスタッフが登録済みです。退店済みの場合は一覧の「再入店」を使用してください。");
    return;
  }
  if (!employmentTypeLabels[employmentType] || (!isEmployee && (!jobTypeLabels[jobType] || !payTypeLabels[payType]))) {
    showMessage("errorMessage", "雇用形態、業務区分、給与形態を確認してください。");
    return;
  }
  if (!isEmployee && (!Number.isInteger(payAmount) || payAmount <= 0)) {
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
    meta.textContent = member.employmentType === "employee"
      ? "社員 / 月給は経理で設定"
      : [
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
  updateStaffEmploymentFields();
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
  updateStaffEmploymentFields();
}

function updateStaffEmploymentFields() {
  const isEmployee = document.getElementById("newStaffEmploymentType").value === "employee";
  ["newStaffJobType", "newStaffPayType", "newStaffPayAmount"].forEach((id) => {
    const input = document.getElementById(id);
    input.disabled = isEmployee;
    if (isEmployee) {
      if (id === "newStaffPayAmount") input.value = "";
      input.classList.remove("invalid");
    }
  });
  ["staffJobTypeField", "staffPayTypeField", "staffPayAmountField"].forEach((id) => {
    document.getElementById(id).classList.toggle("opacity-50", isEmployee);
  });
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

function fillIntroducerSelect(select, selectedId = "", selectedName = "") {
  const matched = selectedId
    ? introducers.find((introducer) => introducer.id === selectedId)
    : introducers.find((introducer) => introducer.name === selectedName);
  select.replaceChildren(makeOption("", "紹介者を選択してください"));
  introducers.forEach((introducer) => {
    select.appendChild(makeOption(introducer.id, introducer.name));
  });
  if (matched) select.value = matched.id;
}

function selectedIntroducerData(select) {
  const introducer = introducers.find((item) => item.id === select?.value);
  return {
    introducerId: introducer?.id || "",
    introducerName: introducer?.name || "",
    introducerFeeSystem: introducer?.feeSystem || "",
    advisoryFeeEnabled: Boolean(introducer?.advisoryFeeEnabled)
  };
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
      ? `紹介者：${member.introducerName || introducers.find((item) => item.id === member.introducerId)?.name || "未設定"}${Number(member.advisoryFeeAmount || 0) > 0 ? ` / 顧問料：1出勤 ${yen.format(member.advisoryFeeAmount)}円` : ""}`
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
    const linkPos = document.createElement("button");
    linkPos.type = "button";
    linkPos.className = "secondary-button";
    linkPos.textContent = "POS紐づけ";
    linkPos.addEventListener("click", () => openPosCastLink(member));
    const convert = document.createElement("button");
    convert.type = "button";
    convert.className = "primary-button";
    convert.textContent = "在籍化";
    convert.addEventListener("click", () => openCastEdit(member, true));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger-button";
    remove.textContent = "削除";
    remove.addEventListener("click", () => deleteCastData(member));
    if (member.status === "trial") actions.append(convert);
    if (member.status === "active") actions.append(linkPos);
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

function openCastEdit(member, convertTrial = false) {
  document.getElementById("editingCastId").value = member.id;
  document.getElementById("convertingTrialCastId").value = convertTrial && member.status === "trial" ? member.id : "";
  document.getElementById("castEditTitle").textContent = convertTrial
    ? `${member.name}を在籍キャストに登録`
    : `${member.name}のキャスト情報`;
  document.getElementById("castProfileName").value = member.name || "";
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

async function openPosCastLink(member) {
  document.getElementById("linkingCastId").value = member.id;
  document.getElementById("posCastLinkTitle").textContent = `${member.name}のPOS正式キャスト紐づけ`;
  document.getElementById("posCastLinkCurrent").textContent =
    `現在のGMS情報：No.${member.internalNo || "-"} / POS ID ${member.posCastId || "未設定"} / 名前 ${member.name || "-"}`;
  document.getElementById("posCastLinkSearch").value = "";
  document.getElementById("posCastLinkSelect").replaceChildren(makeOption("", "POS名簿を読み込み中..."));
  document.getElementById("posCastLinkPreview").textContent = "";
  hideMessage("posCastLinkError");
  document.getElementById("posCastLinkModal").showModal();
  try {
    posCastLinkCandidates = (await loadPosCastCandidates()).filter((cast) => cast.status === "active");
    renderPosCastLinkOptions();
    if (member.posCastId && posCastLinkCandidates.some((cast) => cast.posCastId === String(member.posCastId))) {
      document.getElementById("posCastLinkSelect").value = String(member.posCastId);
    }
    renderPosCastLinkPreview();
  } catch (error) {
    posCastLinkCandidates = [];
    document.getElementById("posCastLinkSelect").replaceChildren(makeOption("", "POS名簿を読み込めませんでした"));
    showMessage("posCastLinkError", `POSキャスト名簿の取得に失敗しました。${error.message}`);
  }
}

function renderPosCastLinkOptions() {
  const select = document.getElementById("posCastLinkSelect");
  const currentValue = select.value;
  const queryText = document.getElementById("posCastLinkSearch").value.trim().toLocaleLowerCase("ja");
  const linkingId = document.getElementById("linkingCastId").value;
  const options = posCastLinkCandidates.filter((cast) => {
    if (!queryText) return true;
    return String(cast.name || "").toLocaleLowerCase("ja").includes(queryText)
      || String(cast.internalNo || "").includes(queryText)
      || String(cast.posCastId || "").toLocaleLowerCase("ja").includes(queryText);
  });
  select.replaceChildren(makeOption("", options.length ? "選択してください" : "該当するPOSキャストがありません"));
  options.forEach((cast) => {
    const linked = allCastMembers.find((member) =>
      member.id !== linkingId
      && member.deleted !== true
      && String(member.posCastId || "") === String(cast.posCastId)
    );
    const label = `No.${cast.internalNo || "-"} ${cast.name} / POS ID ${cast.posCastId}${linked ? ` / GMS登録済み:${linked.name}` : ""}`;
    select.appendChild(makeOption(cast.posCastId, label));
  });
  if (currentValue && options.some((cast) => String(cast.posCastId) === currentValue)) select.value = currentValue;
  renderPosCastLinkPreview();
}

function renderPosCastLinkPreview() {
  const cast = posCastLinkCandidates.find((item) => String(item.posCastId) === document.getElementById("posCastLinkSelect").value);
  const preview = document.getElementById("posCastLinkPreview");
  if (!cast) {
    preview.textContent = "POS正式キャストを選択してください。";
    return;
  }
  const linked = allCastMembers.find((member) =>
    member.id !== document.getElementById("linkingCastId").value
    && member.deleted !== true
    && String(member.posCastId || "") === String(cast.posCastId)
  );
  preview.textContent = `選択中：No.${cast.internalNo || "-"} / ${cast.name} / POS ID ${cast.posCastId}`
    + (linked ? `。既存のGMSデータ「${linked.name}」は統合済みとして非表示にします。` : "");
}

async function savePosCastLink() {
  const member = castMembers.find((cast) => cast.id === document.getElementById("linkingCastId").value);
  const selected = posCastLinkCandidates.find((cast) => String(cast.posCastId) === document.getElementById("posCastLinkSelect").value);
  if (!member) {
    showMessage("posCastLinkError", "GMSキャスト情報が見つかりません。");
    return;
  }
  if (!selected) {
    markInvalid(document.getElementById("posCastLinkSelect"), true);
    showMessage("posCastLinkError", "紐づけるPOS正式キャストを選択してください。");
    return;
  }
  markInvalid(document.getElementById("posCastLinkSelect"), false);
  const duplicate = allCastMembers.find((cast) =>
    cast.id !== member.id
    && cast.deleted !== true
    && String(cast.posCastId || "") === String(selected.posCastId)
  );
  const previousPosCastIds = new Set(normalizeAliasList(member.previousPosCastIds));
  if (member.posCastId && String(member.posCastId) !== String(selected.posCastId)) previousPosCastIds.add(String(member.posCastId));
  const previousNames = new Set(normalizeAliasList(member.previousNames));
  if (member.name && member.name !== selected.name) previousNames.add(member.name);
  const button = document.getElementById("savePosCastLinkButton");
  button.disabled = true;
  hideMessage("posCastLinkError");
  try {
    await setDoc(doc(db, castCollectionName, member.id), {
      posCastId: selected.posCastId,
      name: selected.name,
      internalNo: selected.internalNo,
      status: selected.status,
      entryDate: selected.entryDate || member.entryDate || "",
      exitedDate: selected.exitedDate || "",
      posEnteredAt: selected.posEnteredAt,
      posExitedAt: selected.posExitedAt,
      personKey: personKeyFor(member),
      previousNames: [...previousNames],
      previousPosCastIds: [...previousPosCastIds],
      linkedPosCastAt: serverTimestamp(),
      linkedPosCastBy: currentUser.uid,
      source: "pos",
      updatedAt: serverTimestamp()
    }, { merge: true });
    if (duplicate) {
      await setDoc(doc(db, castCollectionName, duplicate.id), {
        deleted: true,
        mergedIntoCastId: member.id,
        mergedIntoPersonKey: personKeyFor(member),
        mergedAt: serverTimestamp(),
        mergedBy: currentUser.uid,
        updatedAt: serverTimestamp()
      }, { merge: true });
    }
    document.getElementById("posCastLinkModal").close();
    await loadCastMembers();
    renderCastDetailList();
    showMessage("successMessage", `${member.name}をPOS正式キャスト「${selected.name}」へ紐づけました。`, false);
  } catch (error) {
    showMessage("posCastLinkError", `POS正式キャストとの紐づけに失敗しました。${error.message}`);
  } finally {
    button.disabled = false;
  }
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
  const convertingTrial = Boolean(document.getElementById("convertingTrialCastId").value) && member?.status === "trial";
  const castProfileName = document.getElementById("castProfileName").value.trim();
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
  if (!castProfileName) {
    markInvalid(document.getElementById("castProfileName"), true);
    showMessage("castEditError", "キャスト名を入力してください。");
    return;
  }
  markInvalid(document.getElementById("castProfileName"), false);
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
    showMessage("castEditError", "顧問料が発生する紹介者の場合は、1出勤あたり1円以上の顧問料金額を入力してください。");
    return;
  }
  markInvalid(document.getElementById("castAdvisoryFeeAmount"), false);
  const button = document.getElementById("saveCastProfileButton");
  button.disabled = true;
  try {
    const previousNames = new Set(normalizeAliasList(member.previousNames));
    if (convertingTrial && member.name && member.name !== castProfileName) previousNames.add(member.name);
    const previousPosCastIds = new Set(normalizeAliasList(member.previousPosCastIds));
    if (convertingTrial && member.posCastId) previousPosCastIds.add(String(member.posCastId));
    const conversionData = convertingTrial ? {
      status: "active",
      personKey: personKeyFor(member),
      sourceTrialCastId: member.id,
      convertedFromTrial: true,
      convertedTrialName: member.name || "",
      convertedAt: serverTimestamp(),
      convertedBy: currentUser.uid,
      previousNames: [...previousNames],
      previousPosCastIds: [...previousPosCastIds]
    } : {};
    await setDoc(doc(db, castCollectionName, id), {
      name: castProfileName,
      personKey: personKeyFor(member),
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
      ...conversionData,
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
    select.appendChild(makeOption(member.id, castDisplayName(member)));
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
      ? member.employmentType === "employee" ? "社員" : jobTypeLabels[member.jobType]
      : "スタッフ情報を編集してから選択してください";
    text.innerHTML = `<strong>${escapeHtml(member.name)}</strong><span class="block text-xs text-slate-500">${escapeHtml(detail)}</span>`;
    label.append(checkbox, text);
    root.appendChild(label);
  });
}

function isStaffProfileComplete(member) {
  if (member.employmentType === "employee") return true;
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
  const timeRequired = requiresStaffTimeInput(member);
  const name = document.createElement("div");
  name.className = "staff-work-name";
  const detail = member.employmentType === "employee"
    ? "社員 / 時間入力なし"
    : `${jobTypeLabels[member.jobType] || "業務区分未設定"} / ${payTypeLabels[member.payType] || "給与形態未設定"}${timeRequired ? "" : " / 時間入力なし"}`;
  name.innerHTML = `<strong>${escapeHtml(member.name)}</strong><span class="block text-xs text-slate-500">${escapeHtml(detail)}</span>`;
  const startLabel = createTimeField("開始時刻", "staff-work-start", timeRequired ? data.startTime || "" : "", !timeRequired);
  const endLabel = createTimeField("終了時刻", "staff-work-end", timeRequired ? data.endTime || "" : "", !timeRequired);
  const hours = document.createElement("input");
  hours.type = "text";
  hours.readOnly = true;
  hours.className = "form-input staff-work-hours";
  hours.value = timeRequired && data.startTime && data.endTime ? formatHours(calculateWorkHours(data.startTime, data.endTime)) : "";
  hours.placeholder = timeRequired ? "自動計算" : "対象外";
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
  if (disabled) input.placeholder = "入力不要";
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
  if (start.disabled || end.disabled) {
    markInvalid(start, false);
    markInvalid(end, false);
    hoursInput.value = "";
    return;
  }
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
  note.placeholder = "備考（任意）";
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
  note.placeholder = "備考（任意）";
  note.className = "form-input allowance-note";
  note.value = data.note || "";
  const refreshRecipient = () => {
    const savedId = data.recipientId || recipient.value;
    const savedName = data.recipientName || data.recipient || recipient.dataset.savedName || "";
    const members = type.value === "美容室"
      ? [...currentCastWorkers(), ...currentTrialWorkers()]
      : currentStaffWorkers();
    recipient.replaceChildren(makeOption("", "支給対象者を選択"));
    members.forEach((member) => {
      const option = makeOption(member.personId, `${member.personName} / ${personTypeLabel(member.personType)}`);
      option.dataset.name = member.personName;
      option.dataset.posCastId = member.posCastId || "";
      option.dataset.personType = member.personType;
      recipient.appendChild(option);
    });
    const matched = members.find((member) =>
      member.personId === savedId
      || member.personName === savedName
      || (type.value === "美容室" && String(member.posCastId || "") === String(savedId || ""))
    );
    if (matched) {
      recipient.value = matched.personId;
      recipient.dataset.savedName = matched.personName;
    } else if (savedName) {
      const option = makeOption(savedId || `legacy:${savedName}`, `${savedName}（旧データ）`);
      option.dataset.name = savedName;
      recipient.appendChild(option);
      recipient.value = option.value;
      recipient.dataset.savedName = savedName;
    }
  };
  type.addEventListener("change", () => {
    recipient.dataset.savedName = "";
    data.recipientId = "";
    data.recipientName = "";
    data.recipient = "";
    refreshRecipient();
  });
  recipient.addEventListener("change", () => {
    recipient.dataset.savedName = recipient.selectedOptions[0]?.dataset.name || "";
  });
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "danger-button";
  remove.textContent = "削除";
  remove.addEventListener("click", () => row.remove());
  row.append(type, amount, recipient, note, remove);
  document.getElementById("allowanceRows").appendChild(row);
  refreshRecipient();
}

function currentCastWorkers() {
  return [...document.querySelectorAll(".cast-work-row")].map((row) => {
    const select = row.querySelector(".cast-member-select");
    const member = castMembers.find((item) => item.id === select.value);
    return member ? {
      personType: "cast",
      personId: member.id,
      posCastId: member.posCastId || "",
      personName: member.name
    } : null;
  }).filter(Boolean);
}

function currentStaffWorkers() {
  return [...document.querySelectorAll(".staff-work-row")].map((row) => {
    const member = staffMembers.find((item) => item.id === row.dataset.staffId);
    return member ? {
      personType: "staff",
      personId: member.id,
      personName: member.name
    } : null;
  }).filter(Boolean);
}

function currentTrialWorkers() {
  return [...document.querySelectorAll(".trial-cast-work-row")].map((row) => ({
    personType: "trial",
    personId: row.dataset.castId || "",
    posCastId: row.dataset.castId || "",
    personName: row.dataset.castName || ""
  })).filter((row) => row.personId || row.personName);
}

function existingTransportDeductions() {
  return [...document.querySelectorAll(".transport-deduction-row")].map((row) => ({
    personType: row.dataset.personType || "cast",
    personId: row.dataset.personId || "",
    posCastId: row.dataset.posCastId || "",
    personName: row.dataset.personName || "",
    amount: Number(row.dataset.amount || 0)
  }));
}

function existingPayrollDeductions() {
  return [...document.querySelectorAll(".payroll-deduction-row")].map((row) => ({
    personType: row.dataset.personType || "",
    personId: row.dataset.personId || "",
    posCastId: row.dataset.posCastId || "",
    personName: row.dataset.personName || "",
    dailyPayment: Number(row.dataset.dailyPayment || 0),
    advancePayment: Number(row.dataset.advancePayment || 0)
  }));
}

function renderTransportDeductions(rows = []) {
  const root = document.getElementById("transportDeductionRows");
  root.replaceChildren();
  rows.filter((row) => Number(row.amount) > 0).forEach((data) => {
    const row = document.createElement("div");
    row.className = "dynamic-row transport-deduction-row";
    row.dataset.personType = data.personType || "cast";
    row.dataset.personId = data.personId || "";
    row.dataset.posCastId = data.posCastId || "";
    row.dataset.personName = data.personName || "";
    row.dataset.amount = String(Number(data.amount || 0));
    const label = document.createElement("strong");
    label.textContent = `${data.personName || "未設定"} / ${personTypeLabel(data.personType || "cast")}`;
    const amount = document.createElement("span");
    amount.textContent = `送迎代 ${yen.format(Number(data.amount || 0))}円`;
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "secondary-button";
    edit.textContent = "編集";
    edit.addEventListener("click", () => openTransportDeductionModal(data));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger-button";
    remove.textContent = "削除";
    remove.addEventListener("click", () => row.remove());
    row.append(label, amount, edit, remove);
    root.appendChild(row);
  });
}

function renderPayrollDeductions(rows = []) {
  const root = document.getElementById("payrollDeductionRows");
  root.replaceChildren();
  rows.filter((row) => Number(row.dailyPayment) > 0 || Number(row.advancePayment) > 0).forEach((data) => {
    const row = document.createElement("div");
    row.className = "dynamic-row payroll-deduction-row";
    row.dataset.personType = data.personType || "";
    row.dataset.personId = data.personId || "";
    row.dataset.posCastId = data.posCastId || "";
    row.dataset.personName = data.personName || "";
    row.dataset.dailyPayment = String(Number(data.dailyPayment || 0));
    row.dataset.advancePayment = String(Number(data.advancePayment || 0));
    const label = document.createElement("strong");
    label.textContent = `${data.personName || "未設定"} / ${personTypeLabel(data.personType)}`;
    const amount = document.createElement("span");
    amount.textContent = `日払い ${yen.format(Number(data.dailyPayment || 0))}円 / 立替金 ${yen.format(Number(data.advancePayment || 0))}円`;
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "secondary-button";
    edit.textContent = "編集";
    edit.addEventListener("click", () => openPayrollDeductionModal(data));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger-button";
    remove.textContent = "削除";
    remove.addEventListener("click", () => row.remove());
    row.append(label, amount, edit, remove);
    root.appendChild(row);
  });
}

function makePersonSelect(people, selectedKey = "") {
  const select = document.createElement("select");
  select.className = "form-select deduction-person-select";
  select.appendChild(makeOption("", "対象者を選択"));
  people.forEach((person) => {
    const key = person.personId || person.posCastId || person.personName;
    const option = makeOption(key, `${person.personName} / ${personTypeLabel(person.personType)}`);
    option.dataset.personType = person.personType;
    option.dataset.personId = person.personId;
    option.dataset.posCastId = person.posCastId || "";
    option.dataset.personName = person.personName;
    select.appendChild(option);
  });
  select.value = selectedKey;
  return select;
}

function selectedPersonFromSelect(select) {
  const option = select.selectedOptions[0];
  if (!option || !option.value) return null;
  return {
    personType: option.dataset.personType || "",
    personId: option.dataset.personId || "",
    posCastId: option.dataset.posCastId || "",
    personName: option.dataset.personName || ""
  };
}

function personTypeLabel(type) {
  if (type === "staff") return "従業員";
  if (type === "trial") return "体入キャスト";
  return "キャスト";
}

function replaceTransportDeduction(data, originalKey = "") {
  const key = `${data.personType || "cast"}:${data.personId || data.posCastId || data.personName}`;
  const rows = existingTransportDeductions().filter((row) => {
    const rowKey = `${row.personType || "cast"}:${row.personId || row.posCastId || row.personName}`;
    return rowKey !== key && (!originalKey || rowKey !== originalKey);
  });
  renderTransportDeductions([...rows, data]);
}

function replacePayrollDeduction(data, originalKey = "") {
  const key = `${data.personType}:${data.personId || data.posCastId || data.personName}`;
  const rows = existingPayrollDeductions().filter((row) => {
    const rowKey = `${row.personType}:${row.personId || row.posCastId || row.personName}`;
    return rowKey !== key && (!originalKey || rowKey !== originalKey);
  });
  renderPayrollDeductions([...rows, data]);
}

function openTransportDeductionModal(editData = null) {
  const root = document.getElementById("transportDeductionModalRows");
  root.replaceChildren();
  const workers = [...currentCastWorkers(), ...currentTrialWorkers()];
  if (!workers.length) {
    root.appendChild(emptyNotice("当日出勤しているキャスト・体入キャストがいません。先に勤務を登録してください。"));
  } else {
    const selectedKey = editData ? editData.personId || editData.posCastId || editData.personName : "";
    const form = document.createElement("div");
    form.className = "dynamic-row";
    const personLabel = document.createElement("label");
    personLabel.className = "work-field-label";
    const personSelect = makePersonSelect(workers, selectedKey);
    personLabel.append("送迎利用者", personSelect);
    const amountLabel = document.createElement("label");
    amountLabel.className = "work-field-label";
    const amount = document.createElement("input");
    amount.type = "number";
    amount.min = "0";
    amount.step = "1";
    amount.className = "form-input transport-deduction-amount";
    amount.placeholder = "送迎代";
    amount.value = editData?.amount || "";
    amountLabel.append("送迎代", amount);
    form.dataset.originalKey = editData ? `${editData.personType || "cast"}:${selectedKey}` : "";
    form.append(personLabel, amountLabel);
    root.appendChild(form);
  }
  document.getElementById("transportDeductionModal").showModal();
}

function saveTransportDeductionsFromModal() {
  const row = document.querySelector("#transportDeductionModalRows .dynamic-row");
  const select = row?.querySelector(".deduction-person-select");
  const person = select ? selectedPersonFromSelect(select) : null;
  const amount = Number(row?.querySelector(".transport-deduction-amount")?.value || 0);
  if (!person || !isNonNegativeInteger(amount) || amount <= 0) {
    showMessage("errorMessage", "送迎利用者と送迎代を正しく入力してください。");
    return;
  }
  replaceTransportDeduction({ ...person, amount }, row.dataset.originalKey || "");
  document.getElementById("transportDeductionModal").close();
}

function openPayrollDeductionModal(editData = null) {
  const root = document.getElementById("payrollDeductionModalRows");
  root.replaceChildren();
  const casts = currentCastWorkers();
  const trials = currentTrialWorkers();
  const staff = currentStaffWorkers();
  if (!casts.length && !trials.length && !staff.length) {
    root.appendChild(emptyNotice("当日出勤しているキャスト・体入キャスト・従業員がいません。先に勤務を登録してください。"));
  } else {
    const form = document.createElement("div");
    form.className = "dynamic-row";
    const personTypeLabel = document.createElement("label");
    personTypeLabel.className = "work-field-label";
    const personType = document.createElement("select");
    personType.className = "form-select payroll-person-type";
    personType.append(makeOption("cast", "キャスト"), makeOption("trial", "体入キャスト"), makeOption("staff", "従業員"));
    personType.value = ["cast", "trial", "staff"].includes(editData?.personType) ? editData.personType : "cast";
    personTypeLabel.append("対象区分", personType);

    const personLabel = document.createElement("label");
    personLabel.className = "work-field-label";
    const selectedKey = editData ? editData.personId || editData.posCastId || editData.personName : "";
    const mountPersonSelect = () => {
      const people = personType.value === "staff" ? staff : personType.value === "trial" ? trials : casts;
      const next = makePersonSelect(people, selectedKey);
      const old = personLabel.querySelector(".deduction-person-select");
      if (old) old.replaceWith(next);
      else personLabel.append("対象者", next);
    };
    mountPersonSelect();
    personType.addEventListener("change", mountPersonSelect);

    const dailyLabel = document.createElement("label");
    dailyLabel.className = "work-field-label";
    const daily = document.createElement("input");
    daily.type = "number";
    daily.min = "0";
    daily.step = "1";
    daily.className = "form-input payroll-deduction-daily";
    daily.placeholder = "日払い";
    daily.value = editData?.dailyPayment || "";
    dailyLabel.append("日払い", daily);

    const advanceLabel = document.createElement("label");
    advanceLabel.className = "work-field-label";
    const advance = document.createElement("input");
    advance.type = "number";
    advance.min = "0";
    advance.step = "1";
    advance.className = "form-input payroll-deduction-advance";
    advance.placeholder = "立替金";
    advance.value = editData?.advancePayment || "";
    advanceLabel.append("立替金", advance);
    form.dataset.originalKey = editData ? `${editData.personType}:${selectedKey}` : "";
    form.append(personTypeLabel, personLabel, dailyLabel, advanceLabel);
    root.appendChild(form);
  }
  document.getElementById("payrollDeductionModal").showModal();
}

function savePayrollDeductionsFromModal() {
  const row = document.querySelector("#payrollDeductionModalRows .dynamic-row");
  const personType = row?.querySelector(".payroll-person-type")?.value || "";
  const select = row?.querySelector(".deduction-person-select");
  const person = select ? selectedPersonFromSelect(select) : null;
  const dailyPayment = Number(row?.querySelector(".payroll-deduction-daily")?.value || 0);
  const advancePayment = Number(row?.querySelector(".payroll-deduction-advance")?.value || 0);
  if (!person || !isNonNegativeInteger(dailyPayment) || !isNonNegativeInteger(advancePayment) || (dailyPayment <= 0 && advancePayment <= 0)) {
    showMessage("errorMessage", "対象者を選択し、日払いまたは立替金を1円以上で入力してください。");
    return;
  }
  replacePayrollDeduction({ ...person, personType, dailyPayment, advancePayment }, row.dataset.originalKey || "");
  document.getElementById("payrollDeductionModal").close();
}

function emptyNotice(text) {
  const notice = document.createElement("div");
  notice.className = "notice";
  notice.textContent = text;
  return notice;
}

function resetRows() {
  document.getElementById("staffWorkRows").replaceChildren();
  document.getElementById("castWorkRows").replaceChildren();
  document.getElementById("trialCastWorkRows").replaceChildren();
  document.getElementById("trialCastWorkSection").classList.add("hidden");
  document.getElementById("expenseRows").replaceChildren();
  document.getElementById("allowanceRows").replaceChildren();
  document.getElementById("transportDeductionRows").replaceChildren();
  document.getElementById("payrollDeductionRows").replaceChildren();
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
      const timeRequired = requiresStaffTimeInput(member);
      const startTime = timeRequired ? row.querySelector(".staff-work-start").value : "";
      const endTime = timeRequired ? row.querySelector(".staff-work-end").value : "";
      return {
        staffId: member?.id || row.dataset.staffId || "",
        staffName: member?.name || "",
        employmentType: member?.employmentType || "",
        jobType: member?.employmentType === "employee" ? "" : member?.jobType || "",
        payType: member?.employmentType === "employee" ? "" : member?.payType || "",
        payAmount: member?.employmentType === "employee" ? 0 : Number(member?.payAmount || 0),
        startTime,
        endTime,
        hours: timeRequired ? calculateWorkHours(startTime, endTime) : 0
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
    internalNo: Number(row.dataset.internalNo || 0),
    trialBizDay: row.dataset.trialBizDay || businessDate,
    startTime: row.dataset.startTime || "",
    endTime: row.dataset.endTime || "",
    hours: Number(row.dataset.hours || 0),
    ...selectedIntroducerData(row.querySelector(".trial-introducer-id")),
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
      const recipientType = recipient.selectedOptions[0]?.dataset.personType || "";
      return {
        type: row.querySelector(".allowance-type").value,
        amount: Number(row.querySelector(".allowance-amount").value || 0),
        recipientId: recipient.value,
        recipientType,
        recipient: recipientName,
        recipientName,
        note: row.querySelector(".allowance-note").value.trim()
      };
    })
    .filter((row) => row.amount > 0 || row.recipient || row.note || row.type === "その他");

  return {
    staffWork,
    castWork,
    trialWork,
    expenses,
    allowances,
    transportDeductions: existingTransportDeductions(),
    payrollDeductions: existingPayrollDeductions()
  };
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
    transportDeductions: rows.transportDeductions,
    payrollDeductions: rows.payrollDeductions,
    cashReconciliation: selectedPending?.cashReconciliation || {
      expectedCash: numberValue("cashSales"),
      actualCash: numberValue("cashSales"),
      difference: 0,
      note: ""
    },
    source: {
      ...(selectedPending?.source || {}),
      sourceDocumentId: selectedPending?.source?.sourceDocumentId || selectedPending?.id || "",
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
    const member = staffMembers.find((item) => item.id === row.staffId);
    if (requiresStaffTimeInput(member)) {
      if (!isQuarterTime(row.startTime) || !isQuarterTime(row.endTime)) {
        errors.push("時給スタッフの開始・終了時刻は15分単位で入力してください。");
      }
      if (!isQuarterHour(row.hours)) {
        errors.push("時給スタッフの稼働時間は0時間超〜24時間以内で入力してください。");
      }
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
  });
  payload.allowances.forEach((row) => {
    if (!row.type || !isNonNegativeInteger(row.amount) || !row.recipient) errors.push("手当の種類、金額、支給対象者を確認してください。");
    const isCastRecipient = [...currentCastWorkers(), ...currentTrialWorkers()].some((member) => member.personId === row.recipientId);
    const isStaffRecipient = currentStaffWorkers().some((member) => member.personId === row.recipientId);
    if (row.type === "美容室" && !isCastRecipient && !String(row.recipientId).startsWith("legacy:")) {
      errors.push("美容室手当の対象者は当日出勤しているキャスト・体入キャストから選択してください。");
    }
    if (row.type !== "美容室" && !isStaffRecipient && !String(row.recipientId).startsWith("legacy:")) {
      errors.push(`${row.type}の対象者は当日出勤している従業員から選択してください。`);
    }
  });
  payload.transportDeductions.forEach((row) => {
    if (!["cast", "trial"].includes(row.personType) || (!row.personId && !row.posCastId && !row.personName)) errors.push("送迎代控除の対象者を確認してください。");
    if (!isNonNegativeInteger(row.amount) || row.amount <= 0) errors.push("送迎代控除の金額は1円以上の整数で入力してください。");
  });
  payload.payrollDeductions.forEach((row) => {
    if (!["cast", "trial", "staff"].includes(row.personType) || (!row.personId && !row.posCastId && !row.personName)) {
      errors.push("報酬・給与引きの対象者を確認してください。");
    }
    if (!isNonNegativeInteger(row.dailyPayment) || !isNonNegativeInteger(row.advancePayment)) {
      errors.push("日払い・立替金は0円以上の整数で入力してください。");
    }
    if (row.dailyPayment <= 0 && row.advancePayment <= 0) {
      errors.push("報酬・給与引きは日払いまたは立替金を1円以上入力してください。");
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
  const transportDeductionTotal = pendingPayload.transportDeductions.reduce((sum, row) => sum + row.amount, 0);
  const payrollDeductionTotal = pendingPayload.payrollDeductions.reduce((sum, row) =>
    sum + row.dailyPayment + row.advancePayment, 0);
  const summary = document.getElementById("confirmSummary");
  summary.replaceChildren();
  [
    `日付：${pendingPayload.businessDate}`,
    `総売上：${yen.format(pendingPayload.sales.totalSales)}円`,
    `現金：${yen.format(pendingPayload.sales.cashSales)}円 / カード：${yen.format(pendingPayload.sales.cardSales)}円`,
    `総客数：${pendingPayload.customers.totalCustomers}名 / 客単価：${yen.format(pendingPayload.customers.customerUnitPrice)}円`,
    `会計データ：${pendingPayload.transactions.length}件`,
    `体入キャスト：${pendingPayload.trialWork.length}名`,
    `経費合計：${yen.format(expenseTotal)}円 / 手当合計：${yen.format(allowanceTotal)}円`,
    `控除合計：${yen.format(transportDeductionTotal + payrollDeductionTotal)}円`
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
    const targetClosingId = selectedPending?.id || pendingPayload.businessDate;
    await setDoc(doc(db, closingsCollectionName, targetClosingId), pendingPayload, { merge: true });
    await Promise.all(pendingPayload.trialWork.map((row) => setDoc(
      doc(db, trialCastCollectionName, trialCastRecordId(targetClosingId, row.castId)),
      {
        ...row,
        businessDate: pendingPayload.businessDate,
        sourceClosingId: targetClosingId,
        updatedBy: currentUser.uid,
        updatedAt: serverTimestamp()
      },
      { merge: true }
    )));
    await Promise.all(pendingPayload.trialWork.map((row) => setDoc(
      doc(db, castCollectionName, castDocumentId(row.castId)),
      trialCastMemberPayload(row),
      { merge: true }
    )));
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
    const previousDate = previousDateString(date);
    const snapshot = await getDocs(query(
      collection(db, closingsCollectionName),
      where("businessDate", "==", previousDate)
    ));
    const previous = snapshot.docs
      .map((item) => ({ id: item.id, ...item.data() }))
      .sort((a, b) => closingSubmittedMillis(b) - closingSubmittedMillis(a))[0];
    if (!previous) {
      showMessage("errorMessage", "前日のデータが見つかりません。");
      return;
    }
    const staffWork = normalizeStaffWork(previous.staffWork || previous.staffHours);
    if (!staffWork.length) {
      showMessage("errorMessage", "前日のスタッフ勤務データが見つかりません。");
      return;
    }
    document.getElementById("staffWorkRows").replaceChildren();
    staffWork.forEach(addStaffWorkRow);
    renderStaffAttendancePicker();
    showMessage("successMessage", "前日のスタッフ勤務のみコピーしました。売上・キャスト勤務・経費・手当は変更していません。", false);
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
  renderTransportDeductions(data.transportDeductions || []);
  renderPayrollDeductions(data.payrollDeductions || []);
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
    table.innerHTML = "<thead><tr><th>明細</th><th>分類</th><th>単価</th><th>数量</th><th>金額</th></tr></thead>";
    const tbody = document.createElement("tbody");
    transaction.items.forEach((item) => {
      const row = document.createElement("tr");
      [item.label, transactionItemCategoryLabel(item.category), `${yen.format(item.price)}円`, item.quantity, `${yen.format(item.price * item.quantity)}円`].forEach((value) => {
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

function closingSubmittedMillis(closing) {
  const value = closing?.source?.closedAt || closing?.source?.updatedAt || closing?.reviewedAt || closing?.updatedAt;
  if (typeof value?.toMillis === "function") return value.toMillis();
  if (typeof value?.seconds === "number") return value.seconds * 1000;
  const parsed = new Date(value || 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function closingSubmissionLabel(closing) {
  const millis = closingSubmittedMillis(closing);
  const time = millis
    ? new Date(millis).toLocaleString("ja-JP", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    : "時刻不明";
  return `${time} / ${String(closing.id || "").slice(-8)}`;
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
      internalNo: Number(row.internalNo || member?.internalNo || 0),
      trialBizDay: row.trialBizDay || "",
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
    item.dataset.internalNo = String(row.internalNo || trial.internalNo || "");
    item.dataset.trialBizDay = row.trialBizDay || trial.trialBizDay || "";
    item.dataset.startTime = row.startTime || "";
    item.dataset.endTime = row.endTime || "";
    item.dataset.hours = String(row.hours || calculateWorkHours(row.startTime, row.endTime) || 0);
    const identity = document.createElement("div");
    const meta = `${castNumberLabel(item.dataset.internalNo)}${item.dataset.trialBizDay ? ` / ${item.dataset.trialBizDay}` : ""}`;
    identity.innerHTML = `<strong>体入 ${escapeHtml(meta)} ${escapeHtml(item.dataset.castName)}</strong><span class="block text-xs text-slate-500">${escapeHtml(item.dataset.startTime)}-${escapeHtml(item.dataset.endTime)} / ${escapeHtml(formatHours(Number(item.dataset.hours)))}</span>`;
    const introducer = document.createElement("select");
    introducer.className = "form-select trial-introducer-id";
    const castMember = castMembers.find((member) =>
      String(member.posCastId || member.id || "") === String(item.dataset.castId)
      || String(member.name || "") === String(item.dataset.castName)
    );
    fillIntroducerSelect(
      introducer,
      row.introducerId || trial.introducerId || castMember?.introducerId || "",
      row.introducerName || trial.introducerName || castMember?.introducerName || ""
    );
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
