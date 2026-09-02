"use client";

import { getApps, initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getDatabase, ref } from "firebase/database";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY || "AIzaSyBX0LqE5XKywU8ERzJl738SQq2QUuCsDQ8",
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || "club-genesis-accountin.firebaseapp.com",
  databaseURL: process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL
    || "https://club-genesis-accountin-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "club-genesis-accountin",
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || "club-genesis-accountin.firebasestorage.app",
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || "1086890949782",
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID || "1:1086890949782:web:d9425cd2157adea94a16b7"
};

export const firebaseApp = getApps()[0] || initializeApp(firebaseConfig);
export const auth = getAuth(firebaseApp);
export const database = getDatabase(firebaseApp);

const productionHosts = new Set([
  "club-genesis-accounting.vercel.app",
  "club-genesis-accountin.web.app",
  "club-genesis-accountin.firebaseapp.com"
]);

export function isProductionEnvironment() {
  return typeof window !== "undefined" && productionHosts.has(window.location.hostname);
}

export function environmentRoot() {
  return isProductionEnvironment() ? "accounting" : "accounting-dev";
}

export function rootRef(path = "") {
  return ref(database, [environmentRoot(), path].filter(Boolean).join("/"));
}
