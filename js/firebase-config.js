import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";
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

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

export {
  serverTimestamp,
  collection,
  doc,
  getDoc,
  setDoc,
  query,
  where,
  orderBy,
  getDocs
};
