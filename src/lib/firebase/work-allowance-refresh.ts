"use client";

import { equalTo, get, orderByChild, query } from "firebase/database";
import type { CastRecord, DriverRecord, MonthlyAdjustments, Role } from "@/domain/gms";
import { normalizeMonthlyAdjustments } from "@/domain/gms";
import type { AccountingMonthState } from "@/domain/month-accounting";
import { normalizeCastAccountingInputs } from "@/domain/cast-accounting-inputs";
import { normalizeBeautyMonth } from "@/domain/beauty-allowance";
import { normalizeTransportMonth, normalizeTransportSettings } from "@/domain/transport";
import type { WorkAllowanceRefresh } from "@/domain/work-allowance-refresh";
import { rootRef } from "./client";
import { readWorkAllowanceClosings } from "./work-allowance-sources";

const rows = <T extends { id: string }>(value: unknown): T[] => Object.entries((value || {}) as Record<string, T>)
  .map(([id, row]) => ({ ...row, id }));

/** 書込確定後に再取得する。権限の再確認は呼出元で行い、権限が変わった場合は全体再読込へ戻す。 */
export async function loadWorkAllowanceMonth(month: string, role: Role): Promise<WorkAllowanceRefresh> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("対象月を正しく選択してください。");
  if (role !== "shop" && role !== "op") throw new Error("送迎・美容室の操作権限がありません。");
  const [casts, drivers, closings, state, settings, transport, beauty, adjustment, inputs, remote] = await Promise.all([
    get(rootRef("casts")), get(rootRef("drivers")), readWorkAllowanceClosings(month),
    get(rootRef(`accountingMonthStates/${month}`)), get(rootRef("config/transportSettings")),
    get(rootRef(`transportMonths/${month}`)), get(rootRef(`beautyMonths/${month}`)),
    role === "op" ? get(rootRef(`accountingAdjustments/${month}`)) : Promise.resolve(null),
    role === "shop" ? get(query(rootRef(`accountingAdjustments/${month}/castInputs`), orderByChild("kind"), equalTo("transport"))) : Promise.resolve(null),
    role === "shop" ? get(rootRef(`accountingAdjustments/${month}/driverRemoteAllowance`)) : Promise.resolve(null),
  ]);
  const castRows = rows<CastRecord>(casts.val());
  const adjusted = adjustment?.exists() ? normalizeMonthlyAdjustments({ ...adjustment.val(), month } as MonthlyAdjustments) : undefined;
  return {
    month,
    casts: castRows.filter((row) => !row.deletedAt).sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "ja")),
    archivedCasts: castRows.filter((row) => row.deletedAt && (role === "op" || row.entryCancelledAt)),
    drivers: rows<DriverRecord>(drivers.val()).sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "ja")),
    closings,
    monthState: state.exists() ? { ...state.val(), month } as AccountingMonthState : undefined,
    transportSettings: normalizeTransportSettings(settings.val()), transportMonth: normalizeTransportMonth(transport.val()),
    beautyMonth: normalizeBeautyMonth(beauty.val()), adjustment: adjusted,
    legacyInputs: normalizeCastAccountingInputs(role === "op" ? adjusted?.castInputs : inputs?.val()),
    legacyRemote: role === "op" ? adjusted?.driverRemoteAllowance || {} : remote?.val() || {},
  };
}
