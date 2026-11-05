import { describe, expect, it } from "vitest";
import type { CastAccountingInput, CastRecord, DailyCast, DailyClosing, MonthlyAdjustments, WorkspaceData } from "./gms";
import { projectDailyWorkAllowances } from "./daily-work-allowance-preview";

const month = "2026-09", date = `${month}-02`;
function fixture(): WorkspaceData & { archivedCasts?: CastRecord[] } {
  const cast: CastRecord = { id: "cast-1", name: "花子", legalName: "", status: "active", hourlyRates: { [month]: 3000 }, note: "", createdAt: "", updatedAt: "", hiredAt: `${month}-01` };
  const row: DailyCast = { masterId: cast.id, posCastId: "pos-1", name: cast.name, kind: "regular", startTime: "20:00", endTime: "00:00", hours: 4, hourlyRate: 3000,
    honShimeiCount: 0, banaiShimeiCount: 0, dohanCount: 0, dohanBack: 0, honShimeiSales: 0, jonaiExtensionSales: 0, drinkSales: 0, drinkAllocations: [], bottles: [], liquorCost: 0,
    beautyAllowance: 500, transportFee: 500, dailyPayment: 12000, advancePayment: 0 };
  const closing: DailyClosing = { id: "closing-2", businessDate: date, status: "submitted", submissionId: "submission-2", checksum: "a".repeat(64), updatedAt: `${date}T00:00:00Z`,
    sales: { cashSales: 1000, cardSales: 2000, totalSales: 3000 }, customers: { groupCount: 0, totalCustomers: 0 }, nominations: { honShimeiCount: 0, jonaiCount: 0 },
    casts: [row], staffWork: [], drivers: [{ driverId: "driver-1", name: "太郎", dailyRate: 10000, dailyPayment: 0 }], expenses: [],
    staffDailyPaymentTotal: 0, dispatchStaffPayment: 0, dispatchCastPayment: 0, dispatchFee: 0, liquorDeliveryAmount: 0,
    cash: { cashSales: 1000, cardSales: 2000, totalSales: 3000, cashFloat: 200000, expenseAndPaymentTotal: 12000, expectedClosingCash: 189000, cashProfit: -11000, actualClosingCash: 189000, difference: 0 },
    posSnapshot: { transactions: [] } as unknown as DailyClosing["posSnapshot"] };
  const adjustment: MonthlyAdjustments = { month, castInputs: [], withholdingByCast: {}, staffSalesAllowance: {}, staffBottleAllowance: {}, driverRemoteAllowance: {}, fixedExpenses: [], cardFee: 0 };
  return { casts: [cast], staff: [], drivers: [], introducers: [], liquor: [], closings: [closing], adjustments: [adjustment], cashFloat: 200000,
    beautyMonths: { [month]: { revision: 1, casts: { "cast-1": { [date]: { eligible: true, attendanceClosingId: closing.id, attendanceIndex: 0, attendancePosCastId: "pos-1" } } } } },
    transportMonths: { [month]: { revision: 1, casts: { "cast-1": { [date]: { amount: 1500, legacyInputIds: [], attendanceClosingId: closing.id, attendanceIndex: 0 } } }, drivers: {} } } };
}
function legacy(id = "legacy", businessDate: string | undefined = date): CastAccountingInput {
  return { id, castId: "cast-1", castName: "花子", kind: "transport", label: "旧送迎", amount: 1000, ...(businessDate === undefined ? {} : { businessDate }) };
}
function preview(data: ReturnType<typeof fixture>, closing = data.closings[0]) { return projectDailyWorkAllowances(data, closing); }
function nextDay(data: ReturnType<typeof fixture>, status: DailyClosing["status"] = "submitted") {
  const next = structuredClone(data.closings[0]); next.id = "closing-3"; next.businessDate = `${month}-03`; next.status = status;
  next.submissionId = "submission-3"; next.casts[0].transportFee = 0; data.closings.push(next); return next;
}

describe("日次表示専用の美容室手当・キャスト送迎", () => {
  it.each(["submitted", "approved"] as const)("%sの新登録を旧額へ加算せず表示し、原本・現金を変えない", (status) => {
    const data = fixture(); data.closings[0].status = status; data.closings[0].casts[0].beautyAllowance = 0;
    const before = structuredClone(data);
    expect(preview(data)).toEqual({ casts: [{ index: 0, posCastId: "pos-1", beautyAllowance: 500, transportFee: 1500 }], issues: [] });
    expect(data).toEqual(before);
  });

  it("新登録がなければ元の日次値を保持し、遠方手当を扱わない", () => {
    const data = fixture(); data.beautyMonths = undefined;
    data.transportMonths![month] = { revision: 2, casts: {}, drivers: { "driver-1": { [date]: { entries: { first: 2000 }, attendanceClosingId: "closing-2", attendanceIndex: 0 } } } };
    data.transportLegacyRemote = { [month]: { "driver-1": 7500 } };
    expect(preview(data)).toEqual({ casts: [{ index: 0, posCastId: "pos-1", beautyAllowance: 500, transportFee: 500 }], issues: [] });
  });

  it.each(["submitted", "approved", "returned", "withdrawn"] as const)("%sでも明示的な否・0円と消費済み旧入力の取消を維持する", (status) => {
    const data = fixture(); data.closings[0].status = status;
    data.beautyMonths![month].casts["cast-1"][date].eligible = false;
    data.transportMonths![month].casts["cast-1"][date].amount = 0;
    data.transportMonths![month].casts["cast-1"][date].legacyInputIds = ["legacy"];
    data.adjustments[0].castInputs = [legacy()];
    expect(preview(data)).toEqual({ casts: [{ index: 0, posCastId: "pos-1", beautyAllowance: 0, transportFee: 0 }], issues: [] });
  });

  it("取消が消費していない後追加の旧送迎だけを加える", () => {
    const data = fixture(); data.transportMonths![month].casts["cast-1"][date].amount = 0;
    data.transportMonths![month].casts["cast-1"][date].legacyInputIds = ["old"];
    data.adjustments[0].castInputs = [legacy("old"), { ...legacy("new"), amount: 500 }];
    expect(preview(data).casts[0].transportFee).toBe(500);
    expect(preview(data).issues).toEqual([]);
  });

  it("店舗向け旧送迎だけの読取データでも同じ額になり、経理正本があれば優先する", () => {
    const data = fixture(); data.adjustments = []; data.transportLegacyInputs = { [month]: [legacy()] };
    expect(preview(data).casts[0].transportFee).toBe(2500);
    data.adjustments = [{ ...fixture().adjustments[0], castInputs: [{ ...legacy(), amount: 500 }] }];
    expect(preview(data).casts[0].transportFee).toBe(2000);
  });

  it("同月在籍化した体入日に送迎を表示し、美容室・体入経費を混同しない", () => {
    const data = fixture(); data.casts[0].convertedFromTrialId = "trial-1";
    data.closings[0].casts[0] = { ...data.closings[0].casts[0], masterId: "trial-1", kind: "trial", beautyAllowance: 0 };
    data.closings[0].expenses = [{ id: "trial-beauty", category: "beautyTrial", personId: "trial-1", payee: "花子", amount: 500 }];
    delete data.beautyMonths![month].casts["cast-1"][date];
    const before = structuredClone(data);
    expect(preview(data)).toEqual({ casts: [{ index: 0, posCastId: "pos-1", beautyAllowance: 0, transportFee: 1500 }], issues: [] });
    expect(data).toEqual(before);
  });

  it("削除済み体入マスタの同月変換先も月次同様に参照する", () => {
    const data = fixture();
    data.archivedCasts = [{ ...data.casts[0], id: "trial-1", status: "trial", convertedToCastId: "cast-1" }];
    data.closings[0].casts[0] = { ...data.closings[0].casts[0], masterId: "trial-1", kind: "trial", beautyAllowance: 0 };
    data.beautyMonths = undefined;
    expect(preview(data).casts[0]).toMatchObject({ beautyAllowance: 0, transportFee: 1500 });
  });

  it("体入出勤へ在籍美容室登録が残っていても500円を表示しない", () => {
    const data = fixture(); data.closings[0].casts[0].kind = "trial"; data.closings[0].casts[0].beautyAllowance = 0;
    expect(preview(data).casts[0].beautyAllowance).toBe(0);
    expect(preview(data).issues.join()).toContain("在籍出勤が一致しません");
  });

  it("照合変更前のfalseで旧500円を抑え、新しい本人のtrueを最後に適用する", () => {
    const data = fixture(); data.transportMonths = undefined;
    data.beautyMonths![month].casts["cast-1"][date].eligible = false;
    data.closings[0].casts[0].masterId = "cast-2";
    expect(preview(data).casts[0].beautyAllowance).toBe(0);
    data.beautyMonths![month].casts["cast-2"] = { [date]: { ...data.beautyMonths![month].casts["cast-1"][date], eligible: true } };
    expect(preview(data).casts[0].beautyAllowance).toBe(500);
    expect(preview(data).issues).toEqual([]);
  });

  it("同じ本人の出勤行が複数でも登録の根拠行へ一度だけ表示する", () => {
    const data = fixture(); data.closings[0].casts.push({ ...data.closings[0].casts[0], posCastId: "pos-2" });
    expect(preview(data).casts.map((row) => [row.beautyAllowance, row.transportFee])).toEqual([[500, 1500], [0, 0]]);
  });
});

describe("送信元の不一致を0円や旧額で隠さない", () => {
  it.each(["returned", "withdrawn"] as const)("保存済み%sをプレビューの仮submittedで有効化しない", (status) => {
    const data = fixture(); data.closings[0].status = status;
    const candidate = { ...data.closings[0], status: "submitted" as const };
    expect(preview(data, candidate).casts[0]).toMatchObject({ beautyAllowance: null, transportFee: null });
    expect(preview(data, candidate).issues).toHaveLength(2);
  });

  it("未保存previewへ同日・同名の別登録を適用しない", () => {
    const data = fixture(); const candidate = { ...data.closings[0], id: "preview" };
    expect(preview(data, candidate).casts[0]).toMatchObject({ beautyAllowance: null, transportFee: null });
    expect(preview(data, candidate).issues.join()).toContain("保存済みの送信元");
  });

  it("登録がない未保存previewは入力中の元金額をそのまま表示する", () => {
    const data = fixture(); data.beautyMonths = undefined; data.transportMonths = undefined;
    const candidate = { ...data.closings[0], id: "preview" };
    expect(preview(data, candidate)).toEqual({ casts: [{ index: 0, posCastId: "pos-1", beautyAllowance: 500, transportFee: 500 }], issues: [] });
  });

  it.each(["submissionId", "checksum"] as const)("保存中の%sが変わっても古いプレビューへ新登録を混ぜない", (key) => {
    const data = fixture(), candidate = structuredClone(data.closings[0]); data.closings[0][key] = "changed";
    expect(preview(data, candidate).casts[0]).toMatchObject({ beautyAllowance: null, transportFee: null });
  });

  it("現在出勤が別人へ変更された場合は古い画面へ手当を転記しない", () => {
    const data = fixture(), candidate = structuredClone(data.closings[0]); data.closings[0].casts[0].masterId = "another";
    expect(preview(data, candidate).casts[0]).toMatchObject({ beautyAllowance: null, transportFee: null });
  });

  it("再送で出勤位置が移動した記録は根拠位置の修復まで要確認にする", () => {
    const data = fixture(); data.closings[0].casts.unshift({ ...data.closings[0].casts[0], masterId: "other", posCastId: "other-pos", beautyAllowance: 0, transportFee: 0 });
    expect(preview(data).casts[1]).toMatchObject({ beautyAllowance: null, transportFee: null });
    data.beautyMonths![month].casts["cast-1"][date].attendanceIndex = 1;
    data.transportMonths![month].casts["cast-1"][date].attendanceIndex = 1;
    expect(preview(data).casts[1]).toMatchObject({ beautyAllowance: 500, transportFee: 1500 });
    expect(preview(data).issues).toEqual([]);
  });

  it("日次から本人が消えた孤立した正額登録も警告する", () => {
    const data = fixture(); data.closings[0].casts = [];
    expect(preview(data).casts).toEqual([]);
    expect(preview(data).issues).toHaveLength(2);
  });

  it("美容室POS根拠が違う場合は本人IDだけで500円を表示しない", () => {
    const data = fixture(); data.beautyMonths![month].casts["cast-1"][date].attendancePosCastId = "other-pos";
    expect(preview(data).casts[0].beautyAllowance).toBeNull();
    expect(preview(data).casts[0].transportFee).toBe(1500);
  });
});

describe("旧送迎の出勤日と消費履歴", () => {
  it("無日付旧月額を新しいsubmitted日へ移さず、既存の最終承認日だけへ表示する", () => {
    const data = fixture(); data.closings[0].status = "approved"; data.transportMonths = undefined;
    data.adjustments[0].castInputs = [{ ...legacy(), businessDate: undefined }];
    const pending = nextDay(data);
    expect(preview(data).casts[0].transportFee).toBe(1500);
    expect(preview(data, pending).casts[0].transportFee).toBe(0);
    pending.status = "approved";
    expect(preview(data).casts[0].transportFee).toBe(500);
    expect(preview(data, pending).casts[0].transportFee).toBe(1000);
  });

  it("旧無日付入力の根拠日は承認日への解決後に戻さず、取消後にも復活しない", () => {
    const data = fixture(); data.closings[0].status = "approved";
    data.adjustments[0].castInputs = [{ ...legacy(), businessDate: undefined, attendanceClosingId: "closing-2", attendanceIndex: 0 }];
    const next = nextDay(data, "approved");
    expect(preview(data, next).casts[0].transportFee).toBe(1000);
    data.transportMonths![month].casts["cast-1"][date].amount = 0;
    data.transportMonths![month].casts["cast-1"][date].legacyInputIds = ["legacy"];
    expect(preview(data, next).casts[0].transportFee).toBe(0);
    expect(preview(data).casts[0].transportFee).toBe(0);
  });

  it("承認日ゼロでも旧無日付入力の保存根拠日が送信済みならその日に表示できる", () => {
    const data = fixture(); data.transportMonths = undefined;
    data.adjustments[0].castInputs = [{ ...legacy(), businessDate: undefined, attendanceClosingId: "closing-2", attendanceIndex: 0 }];
    expect(preview(data).casts[0].transportFee).toBe(1500);
    expect(preview(data).issues).toEqual([]);
  });

  it("承認日も保存根拠もない旧月額を現在の出勤日に推測して載せない", () => {
    const data = fixture(); data.adjustments[0].castInputs = [{ ...legacy(), businessDate: undefined }];
    expect(preview(data).casts[0].transportFee).toBeNull();
    expect(preview(data).issues.join()).toContain("日付を確認できません");
  });

  it("旧入力の根拠位置が別人を指す場合に日付だけで加えない", () => {
    const data = fixture(); data.adjustments[0].castInputs = [{ ...legacy(), attendanceClosingId: "closing-2", attendanceIndex: 1 }];
    expect(preview(data).casts[0].transportFee).toBeNull();
    expect(preview(data).issues.join()).toContain("出勤元を一意に確認できません");
  });

  it("旧入力の日付に同じ本人の出勤が複数ある場合は二重表示せず要確認にする", () => {
    const data = fixture(); data.closings[0].casts.push({ ...data.closings[0].casts[0], posCastId: "pos-2" });
    data.adjustments[0].castInputs = [legacy()];
    expect(preview(data).casts.map((row) => row.transportFee)).toEqual([null, null]);
  });

  it("別人の旧入力を消費した記録と重複消費を黙って採用しない", () => {
    const data = fixture(); data.adjustments[0].castInputs = [{ ...legacy(), castId: "other" }];
    data.transportMonths![month].casts["cast-1"][date].legacyInputIds = ["legacy"];
    expect(preview(data).casts[0].transportFee).toBeNull();
    data.adjustments[0].castInputs = [legacy()];
    data.transportMonths![month].casts["cast-1"][`${month}-03`] = { ...data.transportMonths![month].casts["cast-1"][date] };
    expect(preview(data).casts[0].transportFee).toBeNull();
  });

  it("対象外の遠方手当の不整合をキャスト送迎の表示へ波及させない", () => {
    const data = fixture();
    data.transportMonths![month].drivers = { "driver-1": { [date]: { entries: { invalid: 999 }, attendanceClosingId: "", attendanceIndex: -1 } } };
    expect(preview(data).casts[0].transportFee).toBe(1500);
    expect(preview(data).issues).toEqual([]);
  });

  it("日付指定の旧送迎を別日の記録で消費した不整合を警告する", () => {
    const data = fixture(); data.adjustments[0].castInputs = [legacy("legacy", `${month}-03`)];
    data.transportMonths![month].casts["cast-1"][date].legacyInputIds = ["legacy"];
    expect(preview(data).casts[0].transportFee).toBeNull();
    expect(preview(data).issues.join()).toContain("旧送迎入力の対応が一致しません");
  });
  it("不正な登録額や加算オーバーフローを元の金額へ戻して隠さない", () => {
    const data = fixture(); data.transportMonths![month].casts["cast-1"][date].amount = 999;
    expect(preview(data).casts[0].transportFee).toBeNull();
    data.transportMonths = undefined; data.closings[0].casts[0].transportFee = Number.MAX_SAFE_INTEGER;
    data.adjustments[0].castInputs = [legacy()];
    expect(preview(data).casts[0].transportFee).toBeNull();
  });
});
