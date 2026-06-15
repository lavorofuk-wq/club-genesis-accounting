import { auth, db, doc, getDoc } from "./firebase-config.js";
import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";

const ROLE_ROUTES = {
  shop: "shop.html",
  accounting: "accounting.html"
};

cleanupLegacyPwa();

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
  const claimRole = await auth.currentUser?.getIdTokenResult()
    .then((token) => token.claims.role)
    .catch(() => null);
  if (claimRole === "shop" || claimRole === "accounting") return claimRole;

  const userSnap = await getDoc(doc(db, "users", uid));
  if (!userSnap.exists()) throw new Error("usersコレクションにユーザー情報がありません。");
  const role = userSnap.data().role;
  if (role !== "shop" && role !== "accounting") {
    throw new Error("ユーザーのroleが不正です。shopまたはaccountingを設定してください。");
  }
  localStorage.setItem("genesisRole", role);
  return role;
}

export function requireRole(expectedRole, onReady) {
  onAuthStateChanged(auth, async (user) => {
    try {
      if (!user) {
        location.href = "index.html";
        return;
      }
      const role = await getUserRole(user.uid);
      if (role !== expectedRole) {
        location.href = ROLE_ROUTES[role] || "index.html";
        return;
      }
      const emailEl = document.getElementById("userEmail");
      if (emailEl) emailEl.textContent = user.email || "";
      const loadingEl = document.getElementById("authLoading");
      if (loadingEl) loadingEl.classList.add("hidden");
      onReady(user);
    } catch (error) {
      const loadingEl = document.getElementById("authLoading");
      if (loadingEl) loadingEl.textContent = error.message;
    }
  });
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
      showMessage("errorMessage", `ログインに失敗しました。${error.message}`);
      loginButton.disabled = false;
    }
  });
}
