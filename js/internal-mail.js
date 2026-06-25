import {
  db,
  collection,
  doc,
  getDocs,
  setDoc,
  serverTimestamp,
  internalMailCollectionName
} from "./firebase-config.js";

const roleLabels = {
  shop: "店舗",
  accounting: "経理"
};

const boxLabels = {
  unread: "未読ボックス",
  read: "既読ボックス",
  sent: "送信ボックス"
};

const readFieldByRole = {
  shop: "readByShop",
  accounting: "readByAccounting"
};

const readAtFieldByRole = {
  shop: "readAtShop",
  accounting: "readAtAccounting"
};

export function initInternalMail({ role, currentUser, onError, onSuccess }) {
  const root = document.querySelector(`[data-internal-mail-root][data-mail-role="${role}"]`);
  if (!root) return;
  const state = {
    role,
    currentUser,
    mails: [],
    currentBox: "unread",
    loading: false,
    dialogs: createMailDialogs(role)
  };
  const el = (name) => root.querySelector(`[data-mail="${name}"]`);

  el("date").value = todayString();
  el("reload").addEventListener("click", () => loadMails(root, state, onError));
  el("send").addEventListener("click", () => sendMail(root, state, onError, onSuccess));
  el("dateSearch").addEventListener("input", () => renderMailSummary(root, state));
  el("clearDateSearch").addEventListener("click", () => {
    el("dateSearch").value = "";
    renderMailSummary(root, state);
  });
  root.querySelectorAll("[data-mail-box]").forEach((button) => {
    button.addEventListener("click", () => openMailBox(root, state, button.dataset.mailBox));
  });
  loadMails(root, state, onError);
}

async function loadMails(root, state, onError) {
  if (state.loading) return;
  state.loading = true;
  setStatus(root, "メールを読み込んでいます。");
  try {
    const snapshot = await getDocs(collection(db, internalMailCollectionName));
    state.mails = snapshot.docs
      .map((item) => ({ id: item.id, ...item.data() }))
      .filter((mail) => mail.fromRole === state.role || mail.toRole === state.role)
      .sort(sortMailDesc);
    renderMailSummary(root, state);
  } catch (error) {
    setStatus(root, "メールを読み込めませんでした。", true);
    onError?.(`内部メールの読み込みに失敗しました。${error.message}`);
  } finally {
    state.loading = false;
  }
}

async function sendMail(root, state, onError, onSuccess) {
  const date = value(root, "date");
  const subject = value(root, "subject");
  const body = value(root, "body");
  const toRole = state.role === "shop" ? "accounting" : "shop";
  clearFieldErrors(root);
  if (!isDateString(date)) {
    markInvalid(root, "date", true);
    setStatus(root, "日付を正しく入力してください。", true);
    return;
  }
  if (!subject) {
    markInvalid(root, "subject", true);
    setStatus(root, "件名を入力してください。", true);
    return;
  }
  if (!body) {
    markInvalid(root, "body", true);
    setStatus(root, "本文を入力してください。", true);
    return;
  }
  const button = root.querySelector('[data-mail="send"]');
  button.disabled = true;
  try {
    const id = `mail_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await setDoc(doc(db, internalMailCollectionName, id), {
      sentDate: date,
      subject,
      body,
      fromRole: state.role,
      fromUid: state.currentUser.uid,
      fromEmail: state.currentUser.email || "",
      toRole,
      readByShop: state.role === "shop",
      readByAccounting: state.role === "accounting",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    root.querySelector('[data-mail="subject"]').value = "";
    root.querySelector('[data-mail="body"]').value = "";
    setStatus(root, `${roleLabels[toRole]}へ送信しました。送信ボックスに保管しました。`);
    onSuccess?.("内部メールを送信しました。");
    await loadMails(root, state, onError);
  } catch (error) {
    setStatus(root, "メール送信に失敗しました。", true);
    onError?.(`内部メールの送信に失敗しました。${error.message}`);
  } finally {
    button.disabled = false;
  }
}

function renderMailSummary(root, state) {
  const groups = groupedMails(root, state);
  root.querySelector('[data-mail-box="unread"]').textContent = `未読ボックス（${groups.unread.length}）`;
  root.querySelector('[data-mail-box="read"]').textContent = `既読ボックス（${groups.read.length}）`;
  root.querySelector('[data-mail-box="sent"]').textContent = `送信ボックス（${groups.sent.length}）`;
  setStatus(root, `未読 ${groups.unread.length}件 / 既読 ${groups.read.length}件 / 送信 ${groups.sent.length}件`);
}

function openMailBox(root, state, box) {
  state.currentBox = box;
  renderMailSummary(root, state);
  renderMailBoxModal(root, state);
  state.dialogs.box.showModal();
}

function renderMailBoxModal(root, state) {
  const groups = groupedMails(root, state);
  const rows = groups[state.currentBox] || [];
  state.dialogs.boxTitle.textContent = boxLabels[state.currentBox] || "メールボックス";
  state.dialogs.boxMeta.textContent = `${dateSearchLabel(root)} / ${rows.length}件`;
  state.dialogs.boxList.replaceChildren();
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "notice";
    empty.textContent = `${boxLabels[state.currentBox]}に該当するメールはありません。`;
    state.dialogs.boxList.appendChild(empty);
    return;
  }
  rows.forEach((mail) => {
    const card = document.createElement("article");
    card.className = "pending-item";
    const summary = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = mail.subject || "件名なし";
    const meta = document.createElement("p");
    meta.className = "mt-1 text-sm text-slate-500";
    meta.textContent = `${mail.sentDate || "-"} / ${roleLabels[mail.fromRole] || mail.fromRole} → ${roleLabels[mail.toRole] || mail.toRole}`;
    summary.append(title, meta);

    const action = document.createElement("div");
    action.className = "flex items-center justify-end gap-2";
    const open = document.createElement("button");
    open.type = "button";
    open.className = "secondary-button";
    open.textContent = "内容を確認";
    open.addEventListener("click", () => openMailDetail(root, state, mail));
    action.appendChild(open);
    card.append(summary, action);
    state.dialogs.boxList.appendChild(card);
  });
}

async function openMailDetail(root, state, mail) {
  if (mail.toRole === state.role && mail[readFieldByRole[state.role]] !== true) {
    await markRead(root, state, mail);
  }
  state.dialogs.detailTitle.textContent = mail.subject || "件名なし";
  state.dialogs.detailMeta.textContent = `${mail.sentDate || "-"} / ${roleLabels[mail.fromRole] || mail.fromRole} → ${roleLabels[mail.toRole] || mail.toRole}`;
  state.dialogs.detailBody.textContent = mail.body || "";
  state.dialogs.detail.showModal();
  renderMailSummary(root, state);
  renderMailBoxModal(root, state);
}

async function markRead(root, state, mail) {
  try {
    await setDoc(doc(db, internalMailCollectionName, mail.id), {
      [readFieldByRole[state.role]]: true,
      [readAtFieldByRole[state.role]]: serverTimestamp(),
      updatedAt: serverTimestamp()
    }, { merge: true });
    mail[readFieldByRole[state.role]] = true;
  } catch (error) {
    setStatus(root, `既読処理に失敗しました。${error.message}`, true);
  }
}

function groupedMails(root, state) {
  const readField = readFieldByRole[state.role];
  const queryDate = value(root, "dateSearch");
  const visible = state.mails.filter((mail) => !queryDate || mail.sentDate === queryDate);
  return {
    unread: visible.filter((mail) => mail.toRole === state.role && mail[readField] !== true),
    read: visible.filter((mail) => mail.toRole === state.role && mail[readField] === true),
    sent: visible.filter((mail) => mail.fromRole === state.role)
  };
}

function createMailDialogs(role) {
  const box = document.createElement("dialog");
  box.className = "modal-card modal-wide";
  box.innerHTML = `
    <div>
      <div class="flex items-start justify-between gap-4">
        <div>
          <p class="brand-kicker">MAIL BOX</p>
          <h2 class="mt-2 text-xl font-bold" data-dialog-mail="boxTitle"></h2>
          <p class="mt-1 text-sm text-slate-500" data-dialog-mail="boxMeta"></p>
        </div>
        <button type="button" class="secondary-button" data-dialog-mail="boxClose">閉じる</button>
      </div>
      <div class="pending-list mt-5" data-dialog-mail="boxList"></div>
    </div>
  `;
  const detail = document.createElement("dialog");
  detail.className = "modal-card";
  detail.innerHTML = `
    <div>
      <div class="flex items-start justify-between gap-4">
        <div>
          <p class="brand-kicker">MAIL DETAIL</p>
          <h2 class="mt-2 text-xl font-bold" data-dialog-mail="detailTitle"></h2>
          <p class="mt-1 text-sm text-slate-500" data-dialog-mail="detailMeta"></p>
        </div>
        <button type="button" class="secondary-button" data-dialog-mail="detailClose">閉じる</button>
      </div>
      <div class="mail-detail-body mt-5 whitespace-pre-wrap" data-dialog-mail="detailBody"></div>
    </div>
  `;
  box.dataset.mailDialogRole = role;
  detail.dataset.mailDialogRole = role;
  document.body.append(box, detail);
  box.querySelector('[data-dialog-mail="boxClose"]').addEventListener("click", () => box.close());
  detail.querySelector('[data-dialog-mail="detailClose"]').addEventListener("click", () => detail.close());
  return {
    box,
    detail,
    boxTitle: box.querySelector('[data-dialog-mail="boxTitle"]'),
    boxMeta: box.querySelector('[data-dialog-mail="boxMeta"]'),
    boxList: box.querySelector('[data-dialog-mail="boxList"]'),
    detailTitle: detail.querySelector('[data-dialog-mail="detailTitle"]'),
    detailMeta: detail.querySelector('[data-dialog-mail="detailMeta"]'),
    detailBody: detail.querySelector('[data-dialog-mail="detailBody"]')
  };
}

function setStatus(root, message, isError = false) {
  const status = root.querySelector('[data-mail="status"]');
  status.textContent = message;
  status.classList.toggle("alert", isError);
  status.classList.toggle("alert-error", isError);
  status.classList.toggle("notice", !isError);
}

function value(root, name) {
  const element = root.querySelector(`[data-mail="${name}"]`);
  return element ? element.value.trim() : "";
}

function markInvalid(root, name, invalid) {
  root.querySelector(`[data-mail="${name}"]`)?.classList.toggle("invalid", invalid);
}

function clearFieldErrors(root) {
  ["date", "subject", "body"].forEach((name) => markInvalid(root, name, false));
}

function todayString() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function isDateString(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function dateSearchLabel(root) {
  const date = value(root, "dateSearch");
  return date ? `日付検索：${date}` : "全日付";
}

function sortMailDesc(a, b) {
  return String(b.sentDate || "").localeCompare(String(a.sentDate || ""))
    || timestampMillis(b.createdAt) - timestampMillis(a.createdAt)
    || String(b.id).localeCompare(String(a.id));
}

function timestampMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.seconds === "number") return value.seconds * 1000;
  return 0;
}
