"use client";

import { endAt, get, orderByChild, query, startAt } from "firebase/database";
import { normalizeDailyClosing, type DailyClosing } from "@/domain/gms";
import { rootRef } from "./client";

/**
 * 送迎・美容室の照合に使う日次は対象月だけ取得する。
 * 日付未指定の旧送迎は最終出勤日へ解決するため、対象日だけには狭めない。
 * 差戻し・取下げ済みの元記録も取消し確認に必要なのでstatusでは絞らない。
 */
export async function readWorkAllowanceClosings(month: string): Promise<DailyClosing[]> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("対象月を正しく選択してください。");
  const snapshot = await get(query(rootRef("history"), orderByChild("businessDate"), startAt(month + "-01"), endAt(month + "-31")));
  const value: unknown = snapshot.val();
  if (!value || typeof value !== "object") return [];
  // 旧形式の任意IDも読み、保存内容よりFirebaseパスのIDを正とする。
  return Object.entries(value as Record<string, Omit<DailyClosing, "id">>)
    .map(([id, row]) => normalizeDailyClosing({ ...row, id }));
}
