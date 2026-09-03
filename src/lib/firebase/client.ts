"use client";

import { getApps, initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getDatabase, ref } from "firebase/database";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY || "AIzaSyDtDjWlBAix2iUfjTB28Q7pLAZYHtscJiA",
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || "club-genesis-gms.firebaseapp.com",
  databaseURL: process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL
    || "https://club-genesis-gms-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "club-genesis-gms",
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || "club-genesis-gms.firebasestorage.app",
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || "390370906544",
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID || "1:390370906544:web:58db8a7b5627b9e97ec675"
};

export const firebaseApp = getApps()[0] || initializeApp(firebaseConfig);
export const auth = getAuth(firebaseApp);
export const database = getDatabase(firebaseApp);

const productionHosts = new Set([
  "club-genesis-accounting.vercel.app",
  "club-genesis-gms.web.app",
  "club-genesis-gms.firebaseapp.com"
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
