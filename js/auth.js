import {
  auth,
  db,
  doc,
  getDoc,
  environmentName,
  isProduction
} from "./firebase-config.js";
import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  getIdTokenResult
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";

const ROLE_ROUTES = {
  shop: "shop.html",
  accounting: "accounting.html"
};
const AUTH_TIMEOUT_MS = 15000;
const APP_VERSION = "1.53.1";
const VERSION_CHECK_INTERVAL_MS = 60000;

cleanupLegacyPwa();
showEnvironment();
initForceUpdateMonitor();

function showEnvironment() {
  const badge = document.getElementById("environmentBadge");
  if (!badge) return;
  badge.textContent = environmentName;
  badge.classList.add(isProduction ? "env-production" : "env-development");
}

async function cleanupLegacyPwa() {
  try {
    if ("serviceWorker" in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
    }
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
  } catch (error) {
    console.warn("Legacy cache cleanup skipped.", error);
  }
}

function initForceUpdateMonitor() {
  if (location.protocol === "file:") return;
  let showingOverlay = false;
  const checkVersion = async () => {
    try {
      const response = await fetch(`version.json?t=${Date.now()}`, {
        cache: "no-store",
        headers: { "Cache-Control": "no-cache" }
      });
      if (!response.ok) return;
      const data = await response.json();
      const latestVersion = String(data.version || "");
      if (latestVersion && compareVersions(latestVersion, APP_VERSION) > 0) {
        showingOverlay = true;
        showForceUpdateOverlay(latestVersion);
      }
    } catch (error) {
      console.warn("Version check skipped.", error);
    }
  };
  checkVersion();
  window.setInterval(() => {
    if (!showingOverlay) checkVersion();
  }, VERSION_CHECK_INTERVAL_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !showingOverlay) checkVersion();
  });
}

function compareVersions(a, b) {
  const left = String(a).split(".").map((part) => Number(part) || 0);
  const right = String(b).split(".").map((part) => Number(part) || 0);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function showForceUpdateOverlay(latestVersion) {
  if (document.getElementById("forceUpdateOverlay")) return;
  const overlay = document.createElement("div");
  overlay.id = "forceUpdateOverlay";
  overlay.className = "force-update-overlay";
  overlay.innerHTML = `
    <div class="force-update-panel">
      <p class="brand-kicker">SYSTEM UPDATE</p>
      <h2>アップデートがあります</h2>
      <p>新しいバージョン Ver${latestVersion} が配信されました。<br>再読み込みしてから操作を続けてください。</p>
      <button type="button" class="primary-button">再読み込み</button>
    </div>
  `;
  overlay.querySelector("button").addEventListener("click", () => {
    location.reload();
  });
  document.body.appendChild(overlay);
}

export function showMessage(elementId, message, isError = true) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.textContent = message;
  el.classList.remove("hidden", "alert-error", "alert-success");
  el.classList.add(isError ? "alert-error" : "alert-success");
}

export function hideMessage(elementId) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.textContent = "";
  el.classList.add("hidden");
}

export async function getUserRole(uid) {
  const claimRole = await getIdTokenResult(auth.currentUser)
    .then((token) => token.claims.role)
    .catch(() => null);
  if (claimRole === "shop" || claimRole === "accounting") return claimRole;

  const userSnap = await getDoc(doc(db, "users", uid));
  if (!userSnap.exists()) {
    throw new Error("usersコレクションにユーザー情報がありません。FirebaseのusersにUIDとroleを登録してください。");
  }
  const role = userSnap.data().role;
  if (role !== "shop" && role !== "accounting") {
    throw new Error("ユーザーのroleが不正です。shopまたはaccountingを設定してください。");
  }
  localStorage.setItem("genesisRole", role);
  return role;
}

function loginErrorMessage(error) {
  const messages = {
    "auth/invalid-email": "メールアドレスの形式が正しくありません。",
    "auth/invalid-credential": "メールアドレスまたはパスワードが違います。",
    "auth/user-not-found": "このメールアドレスのユーザーがFirebase Authenticationに登録されていません。",
    "auth/wrong-password": "パスワードが違います。",
    "auth/user-disabled": "このユーザーはFirebase Authenticationで無効になっています。",
    "auth/too-many-requests": "ログイン試行が多すぎます。少し時間を置いてから再度お試しください。",
    "auth/operation-not-allowed": "Firebase Authenticationでメール/パスワード認証が有効になっていません。",
    "auth/unauthorized-domain": `このURLはFirebaseで許可されていません。Authenticationの承認済みドメインに「${location.hostname}」を追加してください。`,
    "permission-denied": "Firestoreのusers設定またはセキュリティルールを確認してください。"
  };
  return messages[error.code] || error.message || "原因不明のエラーです。";
}

export function requireRole(expectedRole, onReady) {
  const loadingEl = document.getElementById("authLoading");
  const loadingTextEl = document.getElementById("authLoadingText");
  const retryButton = document.getElementById("authRetryButton");
  let completed = false;
  const timeoutId = window.setTimeout(() => {
    if (completed) return;
    if (loadingTextEl) {
      loadingTextEl.textContent = "認証確認に時間がかかっています。通信状態を確認して再読み込みしてください。";
    } else if (loadingEl) {
      loadingEl.textContent = "認証確認に時間がかかっています。ページを再読み込みしてください。";
    }
    retryButton?.classList.remove("hidden");
  }, AUTH_TIMEOUT_MS);

  retryButton?.addEventListener("click", () => location.reload());

  onAuthStateChanged(auth, async (user) => {
    try {
      if (!user) {
        completed = true;
        window.clearTimeout(timeoutId);
        location.href = "index.html";
        return;
      }
      const role = await withTimeout(
        getUserRole(user.uid),
        AUTH_TIMEOUT_MS,
        "Firebaseの認証情報を取得できませんでした。通信状態を確認して再読み込みしてください。"
      );
      if (role !== expectedRole) {
        completed = true;
        window.clearTimeout(timeoutId);
        location.href = ROLE_ROUTES[role] || "index.html";
        return;
      }
      completed = true;
      window.clearTimeout(timeoutId);
      const emailEl = document.getElementById("userEmail");
      if (emailEl) emailEl.textContent = user.email || "";
      if (loadingEl) loadingEl.classList.add("hidden");
      onReady(user);
    } catch (error) {
      completed = true;
      window.clearTimeout(timeoutId);
      if (loadingTextEl) {
        loadingTextEl.textContent = error.message;
      } else if (loadingEl) {
        loadingEl.textContent = error.message;
      }
      retryButton?.classList.remove("hidden");
    }
  });
}

function withTimeout(promise, timeoutMs, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      window.setTimeout(() => reject(new Error(message)), timeoutMs);
    })
  ]);
}

export async function logout() {
  await signOut(auth);
  localStorage.removeItem("genesisRole");
  location.href = "index.html";
}

const loginForm = document.getElementById("loginForm");
if (loginForm) {
  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    hideMessage("errorMessage");
    const loginButton = document.getElementById("loginButton");
    loginButton.disabled = true;

    try {
      const email = document.getElementById("email").value.trim();
      const password = document.getElementById("password").value;
      if (!email || !password) throw new Error("メールアドレスとパスワードを入力してください。");
      const credential = await signInWithEmailAndPassword(auth, email, password);
      const role = await getUserRole(credential.user.uid);
      location.href = ROLE_ROUTES[role];
    } catch (error) {
      showMessage("errorMessage", `ログインできませんでした。${loginErrorMessage(error)}`);
      loginButton.disabled = false;
    }
  });
}
