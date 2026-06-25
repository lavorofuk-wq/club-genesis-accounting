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
    activeBox: "unread",
    loading: false
  };
  const el = (name) => root.querySelector(`[data-mail="${name}"]`);

  el("date").value = todayString();
  el("reload").addEventListener("click", () => loadMails(root, state, onError));
  el("send").addEventListener("click", () => sendMail(root, state, onError, onSuccess));
  el("dateSearch").addEventListener("input", () => renderMailBoxes(root, state));
  el("clearDateSearch").addEventListener("click", () => {
    el("dateSearch").value = "";
    renderMailBoxes(root, state);
  });
  root.querySelectorAll("[data-mail-box]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeBox = button.dataset.mailBox;
      renderMailBoxes(root, state);
    });
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
      .sort((a, b) =>
        String(b.sentDate || "").localeCompare(String(a.sentDate || ""))
        || timestampMillis(b.createdAt) - timestampMillis(a.createdAt)
        || String(b.id).localeCompare(String(a.id))
      );
    renderMailBoxes(root, state);
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
    setStatus(root, `${roleLabels[toRole]}へ送信しました。`);
    onSuccess?.("内部メールを送信しました。");
    await loadMails(root, state, onError);
  } catch (error) {
    setStatus(root, "メール送信に失敗しました。", true);
    onError?.(`内部メールの送信に失敗しました。${error.message}`);
  } finally {
    button.disabled = false;
  }
}

function renderMailBoxes(root, state) {
  const readField = readFieldByRole[state.role];
  const queryDate = value(root, "dateSearch");
  const visible = state.mails.filter((mail) => !queryDate || mail.sentDate === queryDate);
  const unread = visible.filter((mail) => mail.toRole === state.role && mail[readField] !== true);
  const read = visible.filter((mail) =>
    (mail.toRole === state.role && mail[readField] === true)
    || mail.fromRole === state.role
  );
  root.querySelector('[data-mail-box="unread"]').textContent = `未読ボックス（${unread.length}）`;
  root.querySelector('[data-mail-box="read"]').textContent = `既読ボックス（${read.length}）`;
  root.querySelectorAll("[data-mail-box]").forEach((button) => {
    button.classList.toggle("primary-button", button.dataset.mailBox === state.activeBox);
    button.classList.toggle("secondary-button", button.dataset.mailBox !== state.activeBox);
  });
  renderMailList(root, state, state.activeBox === "unread" ? unread : read);
  setStatus(root, `未読 ${unread.length}件 / 既読・送信済み ${read.length}件`);
}

function renderMailList(root, state, rows) {
  const list = root.querySelector('[data-mail="list"]');
  list.replaceChildren();
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "notice";
    empty.textContent = state.activeBox === "unread" ? "未読メールはありません。" : "既読メールはありません。";
    list.appendChild(empty);
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
    const body = document.createElement("p");
    body.className = "mt-2 whitespace-pre-wrap text-sm text-slate-700";
    body.textContent = mail.body || "";
    body.hidden = true;
    summary.append(title, meta, body);

    const action = document.createElement("div");
    action.className = "flex items-center justify-end gap-2";
    const open = document.createElement("button");
    open.type = "button";
    open.className = "secondary-button";
    open.textContent = "開く";
    open.addEventListener("click", async () => {
      body.hidden = !body.hidden;
      if (!body.hidden && mail.toRole === state.role && mail[readFieldByRole[state.role]] !== true) {
        await markRead(root, state, mail);
      }
    });
    action.appendChild(open);
    card.append(summary, action);
    list.appendChild(card);
  });
}

async function markRead(root, state, mail) {
  try {
    await setDoc(doc(db, internalMailCollectionName, mail.id), {
      [readFieldByRole[state.role]]: true,
      [readAtFieldByRole[state.role]]: serverTimestamp(),
      updatedAt: serverTimestamp()
    }, { merge: true });
    mail[readFieldByRole[state.role]] = true;
    state.activeBox = "read";
    await loadMails(root, state);
  } catch (error) {
    setStatus(root, `既読処理に失敗しました。${error.message}`, true);
  }
}

function setStatus(root, message, isError = false) {
  const status = root.querySelector('[data-mail="status"]');
  status.textContent = message;
  status.classList.toggle("alert", isError);
  status.classList.toggle("alert-error", isError);
  status.classList.toggle("notice", !isError);
}

function value(root, name) {
  return root.querySelector(`[data-mail="${name}"]`).value.trim();
}

function markInvalid(root, name, invalid) {
  root.querySelector(`[data-mail="${name}"]`).classList.toggle("invalid", invalid);
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

function timestampMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.seconds === "number") return value.seconds * 1000;
  return 0;
}
