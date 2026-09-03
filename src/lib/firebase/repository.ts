"use client";

import { get, remove, set, update, ref } from "firebase/database";
import type { User } from "firebase/auth";
import { database, rootRef } from "./client";
import type {
  CastRecord,
  DailyClosing,
  DriverRecord,
  IntroducerRecord,
  LiquorRecord,
  MonthlyAdjustments,
  Role,
  StaffRecord,
  WorkspaceData
} from "@/domain/gms";

export type { WorkspaceData } from "@/domain/gms";

const emptyData: WorkspaceData = {
  casts: [], staff: [], drivers: [], introducers: [], liquor: [], closings: [], adjustments: [], cashFloat: 200000
};

const asArray = <T extends { id: string }>(value: unknown): T[] => {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, Omit<T, "id">>).map(([id, row]) => ({ id, ...row } as T));
};
const clean = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const now = () => new Date().toISOString();
const entityId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

async function requireUser(user: User, roles?: Role[]) {
  const role = await userRole(user);
  if (roles && !roles.includes(role)) throw new Error("この操作を実行する権限がありません。");
  return role;
}

export async function userRole(user: User): Promise<Role> {
  const snapshot = await get(ref(database, `users/${user.uid}/role`));
  const role = String(snapshot.val() || "");
  if (role === "shop" || role === "accounting" || role === "op") return role;
  throw new Error("Firebaseのusers/{uid}/roleにshop、accounting、opのいずれかを設定してください。");
}

export async function loadWorkspaceData(role?: Role): Promise<WorkspaceData> {
  const [casts, staff, drivers, introducers, liquor, closings, config, adjustments] = await Promise.all([
    get(rootRef("casts")), get(rootRef("staff")), get(rootRef("drivers")), get(rootRef("introducers")),
    get(rootRef("liquorCosts")), get(rootRef("history")), get(rootRef("config")),
    role === "accounting" || role === "op" ? get(rootRef("accountingAdjustments")) : Promise.resolve(null)
  ]);
  const configValue = (config.val() || {}) as Record<string, unknown>;
  return {
    casts: asArray<CastRecord>(casts.val()).sort((a, b) => a.name.localeCompare(b.name, "ja")),
    staff: asArray<StaffRecord>(staff.val()).sort((a, b) => a.name.localeCompare(b.name, "ja")),
    drivers: asArray<DriverRecord>(drivers.val()).sort((a, b) => a.name.localeCompare(b.name, "ja")),
    introducers: asArray<IntroducerRecord>(introducers.val()).sort((a, b) => a.name.localeCompare(b.name, "ja")),
    liquor: asArray<LiquorRecord>(liquor.val()).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name, "ja")),
    closings: asArray<DailyClosing>(closings.val()).sort((a, b) => b.businessDate.localeCompare(a.businessDate)),
    adjustments: Object.entries((adjustments?.val() || {}) as Record<string, Omit<MonthlyAdjustments, "month">>)
      .map(([month, row]) => ({ month, ...row })),
    cashFloat: Number(configValue.cashFloat ?? 200000)
  };
}

export async function saveCast(value: Partial<CastRecord> & Pick<CastRecord, "name" | "legalName" | "status">, user: User) {
  await requireUser(user);
  const id = value.id || entityId("cast");
  const existing = value.id ? (await get(rootRef(`casts/${id}`))).val() as CastRecord | null : null;
  if (value.status === "active") {
    const all = await get(rootRef("casts"));
    const duplicate = asArray<CastRecord>(all.val()).some((row) => row.id !== id && row.status === "active" && row.name.trim() === value.name.trim());
    if (duplicate) throw new Error("同じキャスト名の在籍キャストは登録できません。");
  }
  await set(rootRef(`casts/${id}`), clean({
    ...existing, ...value, id: undefined, name: value.name.trim(), legalName: value.legalName.trim(),
    hourlyRates: value.hourlyRates || existing?.hourlyRates || {}, note: value.note || "",
    createdAt: existing?.createdAt || now(), updatedAt: now()
  }));
  return id;
}

export async function convertTrialCast(trialId: string, value: Partial<CastRecord> & Pick<CastRecord, "hiredAt">, user: User) {
  await requireUser(user);
  const trial = (await get(rootRef(`casts/${trialId}`))).val() as CastRecord | null;
  if (!trial || trial.status !== "trial") throw new Error("体入キャストが見つかりません。");
  const activeId = entityId("cast");
  await update(rootRef(), clean({
    [`casts/${activeId}`]: { ...trial, ...value, status: "active", hourlyRates: value.hourlyRates || {}, convertedFromTrialId: trialId, convertedToCastId: undefined, departedAt: undefined, createdAt: now(), updatedAt: now() },
    [`casts/${trialId}/convertedToCastId`]: activeId,
    [`casts/${trialId}/updatedAt`]: now()
  }));
  return activeId;
}

export async function departCast(id: string, date: string, user: User) {
  await requireUser(user); await update(rootRef(`casts/${id}`), { status: "departed", departedAt: date, updatedAt: now() });
}
export async function restoreCast(id: string, user: User) {
  await requireUser(user); await update(rootRef(`casts/${id}`), { status: "active", departedAt: null, updatedAt: now() });
}
export async function deleteCast(id: string, user: User) {
  await requireUser(user); await remove(rootRef(`casts/${id}`));
}

export async function saveStaff(value: Partial<StaffRecord> & Pick<StaffRecord, "name" | "status">, user: User) {
  await requireUser(user);
  const id = value.id || entityId("staff");
  const existing = value.id ? (await get(rootRef(`staff/${id}`))).val() as StaffRecord | null : null;
  await set(rootRef(`staff/${id}`), clean({ ...existing, ...value, id: undefined, name: value.name.trim(), note: value.note || "", createdAt: existing?.createdAt || now(), updatedAt: now() }));
  return id;
}

export async function convertTrialStaff(trialId: string, value: Partial<StaffRecord> & Pick<StaffRecord, "hiredAt" | "hourlyRate">, user: User) {
  await requireUser(user);
  const trial = (await get(rootRef(`staff/${trialId}`))).val() as StaffRecord | null;
  if (!trial || trial.status !== "trial") throw new Error("体入スタッフが見つかりません。");
  const activeId = entityId("staff");
  await update(rootRef(), clean({
    [`staff/${activeId}`]: { ...trial, ...value, status: "active", convertedFromTrialId: trialId, convertedToStaffId: undefined, departedAt: undefined, createdAt: now(), updatedAt: now() },
    [`staff/${trialId}/convertedToStaffId`]: activeId,
    [`staff/${trialId}/updatedAt`]: now()
  }));
}

export async function departStaff(id: string, date: string, user: User) {
  await requireUser(user); await update(rootRef(`staff/${id}`), { status: "departed", departedAt: date, updatedAt: now() });
}
export async function restoreStaff(id: string, user: User) {
  await requireUser(user); await update(rootRef(`staff/${id}`), { status: "active", departedAt: null, updatedAt: now() });
}
export async function deleteStaff(id: string, user: User) {
  await requireUser(user); await remove(rootRef(`staff/${id}`));
}

export async function saveDriver(value: Partial<DriverRecord> & Pick<DriverRecord, "name" | "hiredAt" | "dailyRate" | "status">, user: User) {
  await requireUser(user);
  const id = value.id || entityId("driver");
  const existing = value.id ? (await get(rootRef(`drivers/${id}`))).val() as DriverRecord | null : null;
  await set(rootRef(`drivers/${id}`), clean({ ...existing, ...value, id: undefined, name: value.name.trim(), note: value.note || "", createdAt: existing?.createdAt || now(), updatedAt: now() }));
  return id;
}
export async function deleteDriver(id: string, user: User) {
  await requireUser(user); await remove(rootRef(`drivers/${id}`));
}

export async function saveIntroducer(value: Partial<IntroducerRecord> & Pick<IntroducerRecord, "name" | "feeType">, user: User) {
  await requireUser(user);
  const id = value.id || entityId("introducer");
  const existing = value.id ? (await get(rootRef(`introducers/${id}`))).val() as IntroducerRecord | null : null;
  await set(rootRef(`introducers/${id}`), clean({ ...existing, ...value, id: undefined, name: value.name.trim(), note: value.note || "", attendanceAdvisoryEnabled: Boolean(value.attendanceAdvisoryEnabled), entryAdvisoryEnabled: Boolean(value.entryAdvisoryEnabled), createdAt: existing?.createdAt || now(), updatedAt: now() }));
  return id;
}
export async function deleteIntroducer(id: string, user: User) {
  await requireUser(user); await remove(rootRef(`introducers/${id}`));
}

export async function saveLiquor(value: Partial<LiquorRecord> & Pick<LiquorRecord, "name" | "kind" | "salePrice" | "costPrice">, user: User) {
  await requireUser(user);
  const id = value.id || entityId("liquor");
  const existing = value.id ? (await get(rootRef(`liquorCosts/${id}`))).val() as LiquorRecord | null : null;
  await set(rootRef(`liquorCosts/${id}`), clean({ ...existing, ...value, id: undefined, name: value.name.trim(), createdAt: existing?.createdAt || now(), updatedAt: now() }));
  return id;
}
export async function deleteLiquor(id: string, user: User) {
  await requireUser(user); await remove(rootRef(`liquorCosts/${id}`));
}

export async function saveCashFloat(amount: number, user: User) {
  await requireUser(user); await set(rootRef("config/cashFloat"), amount);
}

export async function submitClosing(value: DailyClosing, user: User) {
  await requireUser(user, ["shop", "op"]);
  const all = asArray<DailyClosing>((await get(rootRef("history"))).val());
  const duplicate = all.find((row) => row.id !== value.id && row.submissionId === value.submissionId && row.checksum === value.checksum);
  if (duplicate) throw new Error(`${duplicate.businessDate}に同じPOS JSONが送信済みです。`);
  const existing = (await get(rootRef(`history/${value.id}`))).val() as DailyClosing | null;
  if (existing?.status === "approved") throw new Error("承認済みデータは店舗側から変更できません。");
  await set(rootRef(`history/${value.id}`), clean({ ...value, status: "submitted", returnReason: null, submittedAt: now(), submittedBy: user.uid, updatedAt: now() }));
}
export async function withdrawClosing(id: string, user: User) {
  await requireUser(user, ["shop", "op"]);
  const existing = (await get(rootRef(`history/${id}`))).val() as DailyClosing | null;
  if (!existing || !["submitted", "returned"].includes(existing.status)) throw new Error("このデータは取り下げできません。");
  await update(rootRef(`history/${id}`), { status: "withdrawn", withdrawnAt: now(), updatedAt: now() });
}
export async function approveClosing(id: string, user: User) {
  await requireUser(user, ["accounting", "op"]);
  const existing = (await get(rootRef(`history/${id}`))).val() as DailyClosing | null;
  if (!existing || existing.status !== "submitted") throw new Error("経理確認待ちのデータだけ承認できます。");
  await update(rootRef(`history/${id}`), { status: "approved", approvedAt: now(), approvedBy: user.uid, returnReason: null, updatedAt: now() });
}
export async function returnClosing(id: string, reason: string, user: User) {
  await requireUser(user, ["accounting", "op"]);
  if (!reason.trim()) throw new Error("差戻し理由を入力してください。");
  const existing = (await get(rootRef(`history/${id}`))).val() as DailyClosing | null;
  if (!existing || existing.status !== "submitted") throw new Error("経理確認待ちのデータだけ差し戻せます。");
  await update(rootRef(`history/${id}`), { status: "returned", returnedAt: now(), returnReason: reason.trim(), updatedAt: now() });
}

export async function saveMonthlyAdjustments(value: MonthlyAdjustments, user: User) {
  await requireUser(user, ["accounting", "op"]);
  await set(rootRef(`accountingAdjustments/${value.month}`), clean({ ...value, month: undefined, updatedAt: now(), updatedBy: user.uid }));
}
