import type { CastReward, CastSalesDay, CastSalesReport, DailyClosing, DailyStaffWork, StaffRecord } from "./gms";
import type { MonthlyAccountingResults } from "./month-accounting";

export type BalancePayrollAllocationInput = {
  results: MonthlyAccountingResults;
  closings: DailyClosing[];
  month: string;
  staff?: StaffRecord[];
  archivedStaff?: StaffRecord[];
};

export type BalancePayrollDay = {
  businessDate: string;
  castHourly: number;
  castSalesReward: number;
  /** 通常・体入スタッフとドライバーのみ。派遣スタッフ支払は出力側で別途加算する。 */
  employeeGross: number;
};

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function amount(value: unknown, label: string, allowNegative = false): number {
  requireValue(typeof value === "number" && Number.isFinite(value)
    && Math.abs(value) <= Number.MAX_SAFE_INTEGER && (allowNegative || value >= 0), `${label}が不正です。`);
  return value;
}

function same(actual: number, expected: number, label: string) {
  amount(actual, label, true);
  amount(expected, label, true);
  requireValue(Math.abs(actual - expected) <= Number.EPSILON * Math.max(1, Math.abs(actual), Math.abs(expected)) * 8,
    `${label}が保存済み月額と一致しません。日次データと確定データを確認してください。`);
}

function rows<T>(value: T[], label: string): T[] {
  requireValue(Array.isArray(value), `${label}を読み込めません。`);
  return value;
}

function indexed<T extends { id: string }>(values: T[], label: string) {
  const result = new Map<string, T>();
  for (const value of rows(values, label)) {
    requireValue(value && typeof value.id === "string" && value.id.length > 0, `${label}の人物IDがありません。`);
    requireValue(!result.has(value.id), `${label}の人物IDが重複しています。`);
    result.set(value.id, value);
  }
  return result;
}

const backKeys = ["honShimei", "banaiShimei", "dohan", "bottle", "drink"] as const;
const backRewardKeys = ["honShimeiBack", "banaiShimeiBack", "dohanBack", "bottleBack", "drinkBack"] as const;

function backAmounts(day: Pick<CastSalesDay, "backs" | "backTotal">, label: string) {
  const values = Object.fromEntries(backKeys.map((key) => [key, 0])) as Record<typeof backKeys[number], number>;
  const seen = new Set<string>();
  for (const back of rows(day.backs, `${label}のバック`)) {
    requireValue(back && backKeys.includes(back.key) && !seen.has(back.key), `${label}のバック名目が不正または重複しています。`);
    seen.add(back.key);
    values[back.key] = amount(back.amount, `${label}のバック`);
  }
  same(day.backTotal, Object.values(values).reduce((sum, value) => sum + value, 0), `${label}のバック合計`);
  return values;
}

/** 月額は丸め直さず、途中日のみ10円単位へ配分し、最終出勤日へ残差を置く。 */
function weightedTenYen(total: number, weights: number[], label: string): number[] {
  amount(total, label);
  requireValue(weights.length > 0, `${label}の最終出勤日を確認できません。`);
  const weightTotal = weights.reduce((sum, value) => sum + amount(value, `${label}の配分基準`), 0);
  requireValue(weightTotal > 0 || total === 0, `${label}の配分基準が0のため日別に配分できません。`);
  let remaining = total;
  return weights.map((weight, index) => {
    if (index === weights.length - 1) return remaining;
    const proportional = weightTotal > 0 ? total * (weight / weightTotal) : 0;
    // 四則演算の浮動小数誤差だけを補正し、ちょうど10円の配分が0円にならないようにする。
    const value = Math.floor((proportional + Number.EPSILON * Math.max(1, proportional) * 8) / 10) * 10;
    remaining -= value;
    return value;
  });
}

function castDays(report: CastSalesReport, reward: CastReward, approved: Map<string, DailyClosing>) {
  requireValue(rows(report.days, `${reward.name}の出勤日`).length > 0, `${reward.name}の最終出勤日を確認できません。`);
  const grouped = new Map<string, { businessDate: string; hours: number; sales: number; backs: number; beauty: number }>();
  const monthlyBacks = Object.fromEntries(backKeys.map((key) => [key, 0])) as Record<typeof backKeys[number], number>;
  let honShimeiSales = 0;
  let jonaiSales = 0;
  let liquorCost = 0;
  let honShimeiLiquorCost = 0;
  for (const day of report.days) {
    requireValue(day && approved.has(day.businessDate), `${reward.name}の出勤日に対応する承認済み日次がありません。`);
    const label = `${reward.name} ${day.businessDate}`;
    const hours = amount(day.hours, `${label}の勤務時間`);
    const hon = amount(day.honShimeiSales, `${label}の本指名売上`);
    const jonai = amount(day.jonaiExtensionSales, `${label}の場内延長売上`);
    same(day.totalSales, hon + jonai, `${label}の売上合計`);
    honShimeiSales += hon;
    jonaiSales += jonai;
    liquorCost += amount(day.totalLiquorCost, `${label}の酒代原価`);
    honShimeiLiquorCost += amount(day.honShimeiLiquorCost, `${label}の本指名酒代原価`);
    same(day.totalLiquorCost, day.honShimeiLiquorCost + amount(day.jonaiExtensionLiquorCost, `${label}の場内延長酒代原価`), `${label}の酒代原価合計`);
    const backs = backAmounts(day, label);
    backKeys.forEach((key) => { monthlyBacks[key] += backs[key]; });
    const entry = grouped.get(day.businessDate) || { businessDate: day.businessDate, hours: 0, sales: 0, backs: 0, beauty: 0 };
    entry.hours += hours;
    entry.sales += day.totalSales;
    entry.backs += day.backTotal;
    entry.beauty += amount(day.beautyAllowance, `${label}の美容室手当表示`);
    grouped.set(day.businessDate, entry);
  }
  const result = [...grouped.values()].sort((left, right) => left.businessDate.localeCompare(right.businessDate));
  same(reward.hours, result.reduce((sum, day) => sum + day.hours, 0), `${reward.name}の勤務時間`);
  same(reward.days, result.length, `${reward.name}の出勤日数`);
  same(report.attendanceDays, result.length, `${reward.name}の売上明細の出勤日数`);
  same(reward.honShimeiSales, honShimeiSales, `${reward.name}の本指名売上`);
  same(reward.jonaiExtensionSales, jonaiSales, `${reward.name}の場内延長売上`);
  same(reward.liquorCost, liquorCost, `${reward.name}の酒代原価`);
  same(reward.honShimeiLiquorCost, honShimeiLiquorCost, `${reward.name}の本指名酒代原価`);
  requireValue(report.totals, `${reward.name}の売上明細の月合計がありません。`);
  const totalBacks = backAmounts(report.totals, `${reward.name}の月合計`);
  backKeys.forEach((key, index) => {
    same(totalBacks[key], monthlyBacks[key], `${reward.name}の${key}バック明細合計`);
    same(reward[backRewardKeys[index]], monthlyBacks[key], `${reward.name}の${key}バック`);
  });
  same(report.totals.hours, reward.hours, `${reward.name}の売上明細の月間勤務時間`);
  same(report.totals.attendanceDays, result.length, `${reward.name}の売上明細の月間出勤日数`);
  same(report.totals.honShimeiSales, honShimeiSales, `${reward.name}の売上明細の月間本指名売上`);
  same(report.totals.jonaiExtensionSales, jonaiSales, `${reward.name}の売上明細の月間場内売上`);
  same(report.totals.totalSales, honShimeiSales + jonaiSales, `${reward.name}の売上明細の月間売上`);
  same(report.totals.totalLiquorCost, liquorCost, `${reward.name}の売上明細の月間酒代原価`);
  same(report.totals.honShimeiLiquorCost, honShimeiLiquorCost, `${reward.name}の売上明細の月間本指名酒代原価`);
  same(report.totals.beautyAllowance, result.reduce((sum, day) => sum + day.beauty, 0), `${reward.name}の美容室手当表示合計`);
  return result;
}

function allocateCast(reward: CastReward, report: CastSalesReport, approved: Map<string, DailyClosing>, output: Map<string, BalancePayrollDay>) {
  const days = castDays(report, reward, approved);
  const beauties = new Map<string, number>();
  const trialBase = new Map<string, number>();
  const trialHours = new Map<string, number>();
  let trialRawTotal = 0;
  let trialLegacyDailyTotal = 0;
  // 氏名や現在マスタで結び直さない。月次IDと保存日次IDが一致する通常手当だけを使う。
  // 体入即日美容室経費はキャスト売上明細に表示されるが、報酬には再加算しない。
  for (const closing of approved.values()) {
    for (const cast of rows(closing.casts, `${closing.businessDate}のキャスト勤務`)) {
      if (cast.masterId !== reward.id) continue;
      const beauty = amount(cast.beautyAllowance, `${reward.name}の給与分美容室手当`);
      if (beauty > 0) {
        requireValue(days.some((day) => day.businessDate === closing.businessDate), `${reward.name}の美容室手当の出勤日を確認できません。`);
        beauties.set(closing.businessDate, (beauties.get(closing.businessDate) || 0) + beauty);
      }
      if (reward.trialOnly) {
        requireValue(cast.kind === "trial", `${reward.name}の体入報酬と保存済み勤務区分が一致しません。`);
        const raw = amount(cast.hourlyRate, `${reward.name}の体入時給`) * amount(cast.hours, `${reward.name}の体入勤務時間`);
        amount(raw, `${reward.name}の体入基本報酬`);
        trialRawTotal += raw;
        trialLegacyDailyTotal += Math.floor(raw / 100) * 100;
        trialHours.set(closing.businessDate, (trialHours.get(closing.businessDate) || 0) + cast.hours);
        trialBase.set(closing.businessDate, (trialBase.get(closing.businessDate) || 0) + Math.floor(raw / 10) * 10);
      }
    }
  }
  same([...beauties.values()].reduce((sum, value) => sum + value, 0), reward.beautyAllowance,
    `${reward.name}の給与分美容室手当（体入・在籍の保存ID確認が必要です）`);
  days.forEach((day) => requireValue((beauties.get(day.businessDate) || 0) <= day.beauty,
    `${reward.name}の給与分美容室手当が日別表示額を超えています。`));
  const backTotal = days.reduce((sum, day) => sum + day.backs, 0);
  same(reward.hourlyAndBack, amount(reward.hourlyPay, `${reward.name}の月間時給報酬`) + backTotal, `${reward.name}の時給・バック合計`);
  same(reward.grossPay, reward.adoptedReward + reward.beautyAllowance, `${reward.name}の総支給額`);
  requireValue(reward.adoptedSystem === "hourlyAndBack" || reward.adoptedSystem === "salesReward", `${reward.name}の採用報酬方式を確認できません。`);
  same(reward.adoptedReward, reward.adoptedSystem === "hourlyAndBack" ? reward.hourlyAndBack : reward.salesReward, `${reward.name}の採用報酬`);
  let base: number[];
  if (reward.trialOnly) {
    requireValue(reward.adoptedSystem === "hourlyAndBack" && backTotal === 0, `${reward.name}の体入報酬に対象外の報酬が含まれています。`);
    requireValue(trialBase.size === days.length && days.every((day) => trialBase.has(day.businessDate)),
      `${reward.name}の体入日別時給を保存IDから復元できません。`);
    days.forEach((day) => same(trialHours.get(day.businessDate)!, day.hours, `${reward.name} ${day.businessDate}の体入勤務時間`));
    base = days.map((day) => trialBase.get(day.businessDate)!);
    // 過去の100円単位・日別丸めも検査候補に含めるが、保存金額自体は変更しない。
    // 時給の改変や別人の勤務を「端数差」として最終日に押し込まない。
    const knownRoundedTotals = [Math.floor(trialRawTotal / 10) * 10, Math.floor(trialRawTotal / 100) * 100,
      base.reduce((sum, value) => sum + value, 0), trialLegacyDailyTotal];
    requireValue(knownRoundedTotals.includes(reward.hourlyPay), `${reward.name}の体入時給と保存済み月額が一致せず、端数差として配分できません。`);
    // 旧確定月にも対応し、日別即日額を基本としながら月額との端数差だけを最終日へ寄せる。
    base[base.length - 1] += reward.hourlyPay - base.reduce((sum, value) => sum + value, 0);
  } else {
    base = reward.adoptedSystem === "hourlyAndBack"
      ? weightedTenYen(reward.hourlyPay, days.map((day) => day.hours), `${reward.name}の時給報酬`)
      : weightedTenYen(reward.salesReward, days.map((day) => day.sales), `${reward.name}の売上報酬`);
  }
  days.forEach((day, index) => {
    const value = base[index] + (reward.adoptedSystem === "hourlyAndBack" ? day.backs : 0) + (beauties.get(day.businessDate) || 0);
    amount(value, `${reward.name}の日別報酬`, true);
    const target = output.get(day.businessDate)!;
    if (reward.adoptedSystem === "hourlyAndBack") target.castHourly += value;
    else target.castSalesReward += value;
  });
}

function staffSourceId(work: DailyStaffWork, payrollIds: ReadonlySet<string>, masters: StaffRecord[], regularIds: ReadonlySet<string>, month: string) {
  // 保存月額の人物IDに直接一致する場合は、後日の在籍化で別人へ組み替えない。
  if (payrollIds.has(work.staffId)) return work.staffId;
  requireValue(work.kind === "trial", `${work.name}の保存済みスタッフ給与IDと勤務IDが一致しません。`);
  const candidates = new Set<string>();
  for (const master of masters) {
    if (master.convertedFromTrialId === work.staffId && master.hiredAt?.startsWith(month) && payrollIds.has(master.id)) candidates.add(master.id);
    if (master.id === work.staffId && master.convertedToStaffId && payrollIds.has(master.convertedToStaffId)) {
      const target = masters.find((candidate) => candidate.id === master.convertedToStaffId);
      if (target?.hiredAt?.startsWith(month) || (!target && regularIds.has(master.convertedToStaffId))) candidates.add(master.convertedToStaffId);
    }
  }
  requireValue(candidates.size === 1,
    `${work.name}の体入・在籍スタッフIDの対応を一意に確認できません。保存済みの在籍化履歴を確認してください。`);
  return [...candidates][0];
}

/** 保存済み月次給与を日次へ配分する。給与再計算・現在の時給への置換は行わない。 */
export function allocateBalancePayroll({ results, closings, month, staff = [], archivedStaff = [] }: BalancePayrollAllocationInput): { byDate: BalancePayrollDay[] } {
  requireValue(/^\d{4}-(0[1-9]|1[0-2])$/.test(month), "給与配分の対象月が不正です。");
  const approved = new Map<string, DailyClosing>();
  for (const closing of rows(closings, "日次データ")) {
    if (closing?.status !== "approved" || !closing.businessDate?.startsWith(`${month}-`)) continue;
    const calendarDate = new Date(`${closing.businessDate}T00:00:00.000Z`);
    requireValue(/^\d{4}-\d{2}-\d{2}$/.test(closing.businessDate) && Number.isFinite(calendarDate.getTime())
      && calendarDate.toISOString().slice(0, 10) === closing.businessDate, "給与配分元の営業日が不正です。");
    requireValue(!approved.has(closing.businessDate), `${closing.businessDate}の承認済み日次が重複しています。`);
    approved.set(closing.businessDate, closing);
  }
  const output = new Map<string, BalancePayrollDay>([...approved.keys()].sort().map((businessDate) => [businessDate, {
    businessDate, castHourly: 0, castSalesReward: 0, employeeGross: 0,
  }]));
  const rewards = indexed(results.castRewards, "キャスト報酬");
  const reports = indexed(results.castSalesReports, "キャスト売上明細");
  requireValue(rewards.size === reports.size && [...reports.keys()].every((id) => rewards.has(id)), "キャスト報酬と売上明細の人物IDが一致しません。");
  rewards.forEach((reward) => allocateCast(reward, reports.get(reward.id)!, approved, output));

  const staffPayroll = indexed(results.staffPayroll, "スタッフ給与");
  const payrollIds = new Set(staffPayroll.keys());
  const masters = new Map<string, StaffRecord>();
  rows(archivedStaff, "退店・削除済みスタッフ").forEach((member) => masters.set(member.id, member));
  rows(staff, "スタッフ").forEach((member) => masters.set(member.id, member));
  const regularIds = new Set([...approved.values()].flatMap((closing) => rows(closing.staffWork, `${closing.businessDate}のスタッフ勤務`)
    .filter((work) => work.kind === "regular").map((work) => work.staffId)));
  const staffWork = new Map<string, Array<{ businessDate: string; work: DailyStaffWork }>>();
  for (const closing of approved.values()) {
    const dailyIds = new Set<string>();
    for (const work of closing.staffWork) {
      requireValue(work && typeof work.staffId === "string" && work.staffId.length > 0 && !dailyIds.has(work.staffId),
        `${closing.businessDate}のスタッフ勤務IDが不正または重複しています。`);
      dailyIds.add(work.staffId);
      const id = staffSourceId(work, payrollIds, [...masters.values()], regularIds, month);
      const entries = staffWork.get(id) || [];
      entries.push({ businessDate: closing.businessDate, work });
      staffWork.set(id, entries);
    }
  }
  for (const payroll of staffPayroll.values()) {
    const entries = (staffWork.get(payroll.id) || []).sort((left, right) => left.businessDate.localeCompare(right.businessDate));
    requireValue(entries.length > 0, `${payroll.name}のスタッフ給与を計上する最終出勤日がありません。`);
    const hours = entries.reduce((sum, { work }) => sum + amount(work.hours, `${payroll.name}の勤務時間`), 0);
    const raw = entries.map(({ work }) => amount(work.hourlyRate, `${payroll.name}の保存時給`) * work.hours);
    const rawTotal = raw.reduce((sum, value) => sum + amount(value, `${payroll.name}の日別基本給与`), 0);
    same(payroll.hours, hours, `${payroll.name}の月間勤務時間`);
    same(payroll.daily, entries.reduce((sum, { work }) => sum + amount(work.dailyPayment, `${payroll.name}の日払い`), 0), `${payroll.name}の日払い合計`);
    same(payroll.hourly, Math.floor(rawTotal / 100) * 100, `${payroll.name}の月間基本給与`);
    same(payroll.gross, payroll.hourly + amount(payroll.sales, `${payroll.name}の売上手当`) + amount(payroll.bottle, `${payroll.name}のボトル手当`), `${payroll.name}のスタッフ総支給額`);
    entries.forEach(({ businessDate }, index) => {
      output.get(businessDate)!.employeeGross += raw[index]
        + (index === entries.length - 1 ? payroll.hourly - rawTotal + payroll.sales + payroll.bottle : 0);
    });
  }

  const driverPayroll = indexed(results.driverPayroll, "ドライバー給与");
  const driverWork = new Map<string, Array<{ businessDate: string; dailyRate: number; dailyPayment: number }>>();
  for (const closing of approved.values()) {
    const dailyIds = new Set<string>();
    for (const work of rows(closing.drivers, `${closing.businessDate}のドライバー勤務`)) {
      requireValue(work && typeof work.driverId === "string" && work.driverId.length > 0 && !dailyIds.has(work.driverId),
        `${closing.businessDate}のドライバー勤務IDが不正または重複しています。`);
      dailyIds.add(work.driverId);
      requireValue(driverPayroll.has(work.driverId), `${work.name}のドライバー給与と勤務IDが一致しません。`);
      const entries = driverWork.get(work.driverId) || [];
      entries.push({ businessDate: closing.businessDate, dailyRate: amount(work.dailyRate, `${work.name}の保存日給`), dailyPayment: amount(work.dailyPayment, `${work.name}の日払い`) });
      driverWork.set(work.driverId, entries);
    }
  }
  for (const payroll of driverPayroll.values()) {
    const entries = (driverWork.get(payroll.id) || []).sort((left, right) => left.businessDate.localeCompare(right.businessDate));
    requireValue(entries.length > 0, `${payroll.name}のドライバー給与を計上する最終出勤日がありません。`);
    same(payroll.days, entries.length, `${payroll.name}のドライバー出勤日数`);
    same(payroll.basic, entries.reduce((sum, work) => sum + work.dailyRate, 0), `${payroll.name}のドライバー基本給与`);
    same(payroll.dailyPayment, entries.reduce((sum, work) => sum + work.dailyPayment, 0), `${payroll.name}のドライバー日払い`);
    same(payroll.gross, payroll.basic + amount(payroll.remote, `${payroll.name}の遠方手当`), `${payroll.name}のドライバー総支給額`);
    entries.forEach((work, index) => {
      output.get(work.businessDate)!.employeeGross += work.dailyRate + (index === entries.length - 1 ? payroll.remote : 0);
    });
  }
  const byDate = [...output.values()];
  same(byDate.reduce((sum, day) => sum + day.castHourly + day.castSalesReward, 0), results.castRewards.reduce((sum, reward) => sum + reward.grossPay, 0), "日別キャスト報酬総計");
  same(byDate.reduce((sum, day) => sum + day.employeeGross, 0), results.staffPayroll.reduce((sum, payroll) => sum + payroll.gross, 0)
    + results.driverPayroll.reduce((sum, payroll) => sum + payroll.gross, 0), "日別従業員給与総計");
  return { byDate };
}
