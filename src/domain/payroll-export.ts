import { calculateDailyHourlyPay, hoursBetweenQuarter, type DailyClosing, type DailyHourlyPay, type DailyStaffWork, type StaffRecord } from "./gms";
import { supportsMonthlyStaffRatesSnapshot, type MonthlyAccountingResults, type MonthlyAccountingSnapshot, type StaffHourlySource, type StaffPayrollRow } from "./month-accounting";
import { STAFF_MONTHLY_RATES_START_MONTH, staffMonthlyRateForMonth } from "./staff-rates";

export type PayrollExportInput = {
  results: MonthlyAccountingResults; closings: DailyClosing[]; month: string;
  snapshot?: MonthlyAccountingSnapshot; staff?: StaffRecord[]; archivedStaff?: StaffRecord[];
};
export type StaffPaymentExportRow = Pick<StaffPayrollRow, "id" | "name" | "hours" | "hourly" | "sales" | "bottle" | "gross" | "daily" | "net"> & {
  group: "regular" | "trial" | "unknown"; appliedHourlyRates?: number[];
  days?: Array<{ businessDate: string; hours: number; amount?: number; dailyPayment?: number }>;
  missingDetails: string[];
};
export type StaffPaymentExport = { month: string; rows: StaffPaymentExportRow[] };
export type DriverPaymentExportRow = {
  id: string; name: string; daysCount: number; basic: number; remote: number; gross: number; dailyPayment: number; net: number;
  days?: Array<{ businessDate: string; amount: number }>; missingDetails: string[];
};
export type DriverPaymentExport = { month: string; rows: DriverPaymentExportRow[] };

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function list<T>(value: T[], label: string): T[] {
  requireValue(Array.isArray(value) && Array.from(value).every((item) => item !== undefined && item !== null), `${label}の保存形式が不正です。`);
  return value;
}
function text(value: unknown, label: string): asserts value is string {
  requireValue(typeof value === "string" && value.trim().length > 0, `${label}がありません。`);
}
function amount(value: unknown, label: string, negative = false): number {
  requireValue(typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER
    && (negative || value >= 0), `${label}が不正です。`);
  return value;
}
function hours(value: unknown, label: string): number {
  const result = amount(value, label);
  requireValue(Number.isSafeInteger(result * 4), `${label}が15分単位ではありません。`);
  return result;
}
function same(actual: number, expected: number, label: string) {
  amount(actual, label, true); amount(expected, label, true);
  requireValue(Math.abs(actual - expected) <= Number.EPSILON * Math.max(1, Math.abs(actual), Math.abs(expected)) * 8,
    `${label}が保存済み月額・日別内訳と一致しません。`);
}
function date(value: unknown, month: string): asserts value is string {
  requireValue(typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && value.startsWith(`${month}-`), "給与の営業日が対象月と一致しません。");
  const parsed = new Date(`${value}T00:00:00.000Z`);
  requireValue(Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value, "給与の営業日が不正です。");
}
function unique(value: unknown, seen: Set<string>, label: string): asserts value is string {
  text(value, label); requireValue(!seen.has(value), `${label}が重複しています。`); seen.add(value);
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

/** 給与に必要な範囲だけ検証する。他の経費・キャスト報酬の警告を持ち込まない。 */
function sources(input: PayrollExportInput, field: "staffPayroll" | "driverPayroll") {
  const { month, results, snapshot } = input;
  requireValue(/^\d{4}-(0[1-9]|1[0-2])$/.test(month), "給与出力の対象月が不正です。");
  requireValue(results && Number.isSafeInteger(results.approvedDays) && results.approvedDays >= 0, "月次給与データを読み込めません。");
  requireValue(list<unknown>(results[field], "月次給与").length > 0, "出力対象の給与データがありません。");
  const approved = new Map<string, DailyClosing>();
  const dates = new Set<string>();
  for (const closing of list(input.closings, "日次データ")) {
    if (closing.status !== "approved" || !closing.businessDate?.startsWith(`${month}-`)) continue;
    date(closing.businessDate, month); text(closing.id, "承認済み日次ID");
    requireValue(!approved.has(closing.id), "承認済み日次IDが重複しています。");
    unique(closing.businessDate, dates, "承認済み営業日"); approved.set(closing.id, closing);
  }
  if (!snapshot) {
    same(results.approvedDays, approved.size, "承認済み営業日数");
    return { approved: [...approved.values()], complete: true };
  }
  requireValue(snapshot.month === month && Number.isSafeInteger(snapshot.revision) && snapshot.revision > 0
    && [1, 2, 3].includes(snapshot.schemaVersion) && /^\d+\.\d+\.\d+$/.test(snapshot.calculationVersion), "給与の確定データが不正です。");
  requireValue(JSON.stringify(canonical(results[field])) === JSON.stringify(canonical(snapshot[field])), "出力する給与が確定時の保存データと一致しません。");
  const references = list(snapshot.approvedClosings, "確定時の日次参照");
  same(results.approvedDays, snapshot.approvedDays, "確定済み承認日数"); same(snapshot.approvedDays, references.length, "確定時の日次参照件数");
  const ids = new Set<string>(); const verified: DailyClosing[] = [];
  for (const reference of references) {
    unique(reference.id, ids, "確定時の日次ID"); text(reference.checksum, "確定時の日次チェックサム"); text(reference.updatedAt, "確定時の日次更新日時");
    const original = approved.get(reference.id);
    // 世代違いの原本では確定済み支払内訳を作り直さない。保存済みの月額・日額を維持する。
    if (original && original.checksum === reference.checksum && original.updatedAt === reference.updatedAt) verified.push(original);
  }
  return { approved: verified, complete: verified.length === references.length };
}

function savedDays(payroll: StaffPayrollRow, input: PayrollExportInput): DailyHourlyPay[] | undefined {
  if (payroll.hourlyByDay === undefined) {
    requireValue(input.snapshot && input.snapshot.schemaVersion < 3, `${payroll.name}の日別基本給与の保存内訳がありません。`);
    return undefined;
  }
  const seen = new Set<string>();
  const days = list(payroll.hourlyByDay, `${payroll.name}の日別基本給与`).map((day) => {
    date(day.businessDate, input.month); unique(day.businessDate, seen, `${payroll.name}の日別基本給与の営業日`);
    hours(day.hours, `${payroll.name}の日別勤務時間`); amount(day.amount, `${payroll.name}の日別基本給与`);
    requireValue(Number.isSafeInteger(day.amount) && (day.hours > 0 || day.amount === 0), `${payroll.name}の日別基本給与が不正です。`);
    return { ...day };
  });
  requireValue(days.length > 0, `${payroll.name}の日別基本給与が空です。`);
  same(days.reduce((sum, day) => sum + day.hours, 0), payroll.hours, `${payroll.name}の勤務時間合計`);
  same(days.reduce((sum, day) => sum + day.amount, 0), payroll.hourly, `${payroll.name}の基本給与合計`);
  return days.sort((a, b) => a.businessDate.localeCompare(b.businessDate));
}

function savedSources(payroll: StaffPayrollRow, input: PayrollExportInput, byDay?: DailyHourlyPay[]): StaffHourlySource[] | undefined {
  if (payroll.hourlySources === undefined) {
    requireValue(input.snapshot && (input.snapshot.schemaVersion < 3 || !supportsMonthlyStaffRatesSnapshot(input.snapshot.calculationVersion)), `${payroll.name}の時給計算基準がありません。`);
    return undefined;
  }
  const seen = new Set<string>();
  const entries = list(payroll.hourlySources, `${payroll.name}の時給計算基準`).map((source) => {
    date(source.businessDate, input.month); text(source.staffId, `${payroll.name}の勤務ID`);
    unique(`${source.businessDate}/${source.staffId}`, seen, `${payroll.name}の時給計算基準`);
    requireValue(source.kind === "regular" || source.kind === "trial", `${payroll.name}の勤務区分が不正です。`);
    hours(source.hours, `${payroll.name}の時給計算基準の時間`);
    requireValue(Number.isSafeInteger(source.hourlyRate) && source.hourlyRate > 0, `${payroll.name}の適用時給が不正です。`);
    amount(source.hours * source.hourlyRate, `${payroll.name}の日別時給計算額`); return { ...source };
  });
  requireValue(entries.length > 0, `${payroll.name}の時給計算基準が空です。`);
  same(entries.reduce((sum, source) => sum + source.hours, 0), payroll.hours, `${payroll.name}の計算基準の勤務時間合計`);
  if (byDay) {
    const calculated = calculateDailyHourlyPay(entries);
    requireValue(calculated.length === byDay.length, `${payroll.name}の基本給与と計算基準の日付が一致しません。`);
    calculated.forEach((day) => {
      const saved = byDay.find((item) => item.businessDate === day.businessDate);
      requireValue(saved, `${payroll.name}の基本給与と計算基準の日付が一致しません。`);
      same(day.hours, saved.hours, `${payroll.name} ${day.businessDate}の勤務時間`); same(day.amount, saved.amount, `${payroll.name} ${day.businessDate}の基本給与`);
    });
  }
  return entries;
}

export function buildStaffPaymentExport(input: PayrollExportInput): StaffPaymentExport {
  const verified = sources(input, "staffPayroll"); const payrollIds = new Set<string>();
  const prepared = input.results.staffPayroll.map((payroll) => {
    unique(payroll.id, payrollIds, "スタッフ給与ID"); text(payroll.name, "スタッフ名"); hours(payroll.hours, `${payroll.name}の月間勤務時間`);
    for (const key of ["hourly", "sales", "bottle", "gross", "daily"] as const) amount(payroll[key], `${payroll.name}の${key}`);
    same(payroll.gross, payroll.hourly + payroll.sales + payroll.bottle, `${payroll.name}の総支給額`); same(payroll.net, payroll.gross - payroll.daily, `${payroll.name}の差引支給額`);
    const byDay = savedDays(payroll, input); return { payroll, byDay, hourlySources: savedSources(payroll, input, byDay) };
  });
  const sourceOwners = new Map<string, { id: string; source: StaffHourlySource }>();
  for (const { payroll, hourlySources } of prepared) for (const source of hourlySources || []) {
    const key = `${source.businessDate}/${source.staffId}`;
    requireValue(!sourceOwners.has(key), "同じ勤務が複数のスタッフ給与に含まれています。"); sourceOwners.set(key, { id: payroll.id, source });
  }
  const legacyIds = new Set(prepared.filter((row) => !row.hourlySources).map((row) => row.payroll.id));
  const originals = new Map<string, DailyStaffWork>();
  const legacyEntries = new Map<string, Array<{ businessDate: string; work: DailyStaffWork }>>(); let unresolvedLegacy = false;
  for (const closing of verified.approved) {
    const ids = new Set<string>(); let paymentTotal = 0;
    for (const work of list(closing.staffWork, `${closing.businessDate}のスタッフ勤務`)) {
      unique(work.staffId, ids, `${closing.businessDate}のスタッフ勤務ID`); text(work.name, "スタッフ勤務の氏名");
      requireValue(work.kind === "regular" || work.kind === "trial", `${work.name}の勤務区分が不正です。`);
      hours(work.hours, `${work.name}の勤務時間`);
      requireValue(/^([01]\d|2[0-3]):[0-5]\d$/.test(work.startTime) && /^([01]\d|2[0-3]):[0-5]\d$/.test(work.endTime)
        && hoursBetweenQuarter(work.startTime, work.endTime) === work.hours, `${work.name} ${closing.businessDate}の勤務時間が出退勤時刻と一致しません。`);
      amount(work.hourlyRate, `${work.name}の保存時給`); paymentTotal += amount(work.dailyPayment, `${work.name}の日払い`);
      const key = `${closing.businessDate}/${work.staffId}`; originals.set(key, work);
      if (!sourceOwners.has(key)) {
        if (legacyIds.has(work.staffId)) {
          const entries = legacyEntries.get(work.staffId) || []; entries.push({ businessDate: closing.businessDate, work }); legacyEntries.set(work.staffId, entries);
        } else {
          // 旧確定で在籍化の紐付け記録がない場合は、現在マスタから人物を推測しない。
          requireValue(input.snapshot && legacyIds.size > 0, `${work.name}の勤務が保存済みスタッフ給与に対応していません。`); unresolvedLegacy = true;
        }
      }
    }
    same(paymentTotal, closing.staffDailyPaymentTotal, `${closing.businessDate}のスタッフ日払い合計`);
  }
  const verifiedDates = new Set(verified.approved.map((closing) => closing.businessDate)); const masters = new Map<string, StaffRecord>();
  if (!input.snapshot) {
    list(input.archivedStaff || [], "退店スタッフ").forEach((master) => masters.set(master.id, master)); list(input.staff || [], "スタッフ").forEach((master) => masters.set(master.id, master));
  }
  const result = prepared.map(({ payroll, byDay, hourlySources }): StaffPaymentExportRow => {
    const { id, name, hours: monthlyHours, hourly, sales, bottle, gross, daily, net } = payroll; const missingDetails: string[] = [];
    const group = hourlySources ? (hourlySources.some((source) => source.kind === "regular" || source.staffId !== id) ? "regular" : "trial") : "unknown";
    const days = new Map<string, { businessDate: string; hours: number; amount?: number; dailyPayment?: number }>(); byDay?.forEach((day) => days.set(day.businessDate, { ...day }));
    let originalComplete = false;
    if (hourlySources) {
      originalComplete = true; const payments = new Map<string, number>(); const missingDates = new Set<string>(); const sourceHours = new Map<string, number>();
      for (const source of hourlySources) {
        sourceHours.set(source.businessDate, (sourceHours.get(source.businessDate) || 0) + source.hours);
        const work = originals.get(`${source.businessDate}/${source.staffId}`);
        if (!work) {
          requireValue(input.snapshot && !verified.complete && !verifiedDates.has(source.businessDate), `${name} ${source.businessDate}の計算基準に対応する勤務がありません。`);
          originalComplete = false; missingDates.add(source.businessDate); continue;
        }
        requireValue(work.kind === source.kind, `${name} ${source.businessDate}の勤務区分が計算基準と一致しません。`); same(work.hours, source.hours, `${name} ${source.businessDate}の勤務時間`);
        if (!input.snapshot || work.kind === "trial" || input.month < STAFF_MONTHLY_RATES_START_MONTH) {
          const master = masters.get(work.staffId);
          const expected = work.kind === "regular" && input.month >= STAFF_MONTHLY_RATES_START_MONTH && master ? staffMonthlyRateForMonth(master, input.month) : work.hourlyRate;
          same(source.hourlyRate, expected, `${name} ${source.businessDate}の適用時給`);
        }
        payments.set(source.businessDate, (payments.get(source.businessDate) || 0) + work.dailyPayment);
      }
      sourceHours.forEach((workHours, businessDate) => {
        const day = days.get(businessDate) || { businessDate, hours: workHours }; if (!missingDates.has(businessDate)) day.dailyPayment = payments.get(businessDate) || 0; days.set(businessDate, day);
      });
    } else if (verified.complete && !unresolvedLegacy) {
      const entries = legacyEntries.get(id) || []; requireValue(entries.length > 0, `${name}の保存済み勤務がありません。`);
      same(entries.reduce((sum, entry) => sum + entry.work.hours, 0), monthlyHours, `${name}の勤務時間合計`);
      const calculated = calculateDailyHourlyPay(entries.map(({ businessDate, work }) => ({ businessDate, hours: work.hours, hourlyRate: work.hourlyRate })));
      if (byDay) {
        requireValue(entries.length === byDay.length, `${name}の日別勤務と給与内訳の日付が一致しません。`);
        calculated.forEach((day) => {
          const saved = days.get(day.businessDate); requireValue(saved, `${name}の日別勤務と給与内訳の日付が一致しません。`);
          same(day.hours, saved.hours, `${name} ${day.businessDate}の勤務時間`); same(day.amount, saved.amount!, `${name} ${day.businessDate}の基本給与`);
        });
      }
      entries.forEach(({ businessDate, work }) => days.set(businessDate, { ...(days.get(businessDate) || { businessDate, hours: work.hours }), dailyPayment: work.dailyPayment })); originalComplete = true;
    }
    const verifiedPayments = [...days.values()].reduce((sum, day) => sum + (day.dailyPayment || 0), 0);
    if (originalComplete) same(verifiedPayments, daily, `${name}の日払い合計`);
    else {
      requireValue(verifiedPayments <= daily, `${name}の確認済み日払い内訳が月額を超えています。`);
      missingDetails.push("日払い");
    }
    if (!byDay) missingDetails.push("基本給与"); if (days.size === 0) missingDetails.push("勤務時間");
    if (!hourlySources) missingDetails.push("区分・時給");
    return { id, name, group, hours: monthlyHours, hourly, sales, bottle, gross, daily, net,
      ...(hourlySources ? { appliedHourlyRates: [...new Set(hourlySources.map((source) => source.hourlyRate))].sort((a, b) => a - b) } : {}),
      ...(days.size ? { days: [...days.values()].sort((a, b) => a.businessDate.localeCompare(b.businessDate)) } : {}), missingDetails };
  });
  return { month: input.month, rows: result };
}

export function buildDriverPaymentExport(input: PayrollExportInput): DriverPaymentExport {
  const verified = sources(input, "driverPayroll"); const ids = new Set<string>();
  const payroll = input.results.driverPayroll.map((row) => {
    unique(row.id, ids, "ドライバー給与ID"); text(row.name, "ドライバー名"); requireValue(Number.isSafeInteger(row.days) && row.days >= 0, `${row.name}の出勤日数が不正です。`);
    for (const key of ["basic", "remote", "gross", "dailyPayment"] as const) amount(row[key], `${row.name}の${key}`);
    same(row.gross, row.basic + row.remote, `${row.name}の総支給額`); same(row.net, row.gross - row.dailyPayment, `${row.name}の差引支給額`); return row;
  });
  const entries = new Map<string, Array<{ businessDate: string; amount: number; dailyPayment: number }>>();
  for (const closing of verified.approved) {
    const dailyIds = new Set<string>();
    for (const work of list(closing.drivers, `${closing.businessDate}のドライバー勤務`)) {
      unique(work.driverId, dailyIds, `${closing.businessDate}のドライバーID`); text(work.name, "ドライバー勤務の氏名");
      requireValue(ids.has(work.driverId), `${work.name}の勤務が保存済みドライバー給与に対応していません。`);
      const days = entries.get(work.driverId) || []; days.push({ businessDate: closing.businessDate, amount: amount(work.dailyRate, `${work.name}の日給`), dailyPayment: amount(work.dailyPayment, `${work.name}の日払い`) }); entries.set(work.driverId, days);
    }
  }
  return { month: input.month, rows: payroll.map((row) => {
    const { id, name, days: daysCount, basic, remote, gross, dailyPayment, net } = row; const days = entries.get(id) || [];
    if (verified.complete) {
      same(days.length, daysCount, `${name}の出勤日数`); same(days.reduce((sum, day) => sum + day.amount, 0), basic, `${name}の基本給与合計`); same(days.reduce((sum, day) => sum + day.dailyPayment, 0), dailyPayment, `${name}の日払い合計`);
    } else {
      requireValue(days.length <= daysCount && days.reduce((sum, day) => sum + day.amount, 0) <= basic
        && days.reduce((sum, day) => sum + day.dailyPayment, 0) <= dailyPayment, `${name}の確認済み日別内訳が保存済み月額・日数を超えています。`);
    }
    return { id, name, daysCount, basic, remote, gross, dailyPayment, net,
      ...(verified.complete ? { days: days.map(({ businessDate, amount: value }) => ({ businessDate, amount: value })).sort((a, b) => a.businessDate.localeCompare(b.businessDate)) } : {}),
      missingDetails: verified.complete ? [] : ["基本給与"] };
  }) };
}
