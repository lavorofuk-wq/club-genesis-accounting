import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";
import {
  getDatabase,
  ref,
  get
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js";
import {
  getFirestore,
  serverTimestamp,
  collection,
  doc,
  getDoc,
  setDoc,
  query,
  where,
  orderBy,
  getDocs
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js";

const fallbackConfig = {
  apiKey: "AIzaSyBX0LqE5XKywU8ERzJl738SQq2QUuCsDQ8",
  authDomain: "club-genesis-accountin.firebaseapp.com",
  projectId: "club-genesis-accountin",
  storageBucket: "club-genesis-accountin.firebasestorage.app",
  messagingSenderId: "1086890949782",
  appId: "1:1086890949782:web:d9425cd2157adea94a16b7"
};

const firebaseConfig = window.FIREBASE_CONFIG || fallbackConfig;
const posFirebaseConfig = {
  apiKey: "AIzaSyD_7XgXow1D-cp-TNsbqitjMzJCGD5DE64",
  authDomain: "club-genesis-5cba7.firebaseapp.com",
  databaseURL: "https://club-genesis-5cba7-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "club-genesis-5cba7",
  storageBucket: "club-genesis-5cba7.firebasestorage.app",
  messagingSenderId: "591051426146",
  appId: "1:591051426146:web:08a486510b89d6be0e443b"
};
const productionHosts = new Set([
  "club-genesis-accounting.vercel.app",
  "club-genesis-accountin.web.app",
  "club-genesis-accountin.firebaseapp.com"
]);

export const app = initializeApp(firebaseConfig);
export const posApp = initializeApp(posFirebaseConfig, "pos");
export const auth = getAuth(app);
export const db = getFirestore(app);
export const posDb = getDatabase(posApp);
export const firebaseProjectId = firebaseConfig.projectId;
export const isProduction = productionHosts.has(window.location.hostname);
export const environmentName = isProduction ? "本番" : "開発";
export const reportsCollectionName = isProduction ? "dailyReports" : "dailyReports-dev";
export const closingsCollectionName = isProduction ? "dailyClosings" : "dailyClosings-dev";
export const shopClosingsCollectionName = isProduction ? "shopClosings" : "shopClosings-dev";
export const staffCollectionName = isProduction ? "staffMembers" : "staffMembers-dev";
export const castCollectionName = isProduction ? "castMembers" : "castMembers-dev";
export const introducerCollectionName = isProduction ? "introducers" : "introducers-dev";
export const posCastPath = isProduction ? "pos/casts" : "pos-dev/casts";

export {
  serverTimestamp,
  collection,
  doc,
  getDoc,
  setDoc,
  query,
  where,
  orderBy,
  getDocs,
  ref,
  get
};
