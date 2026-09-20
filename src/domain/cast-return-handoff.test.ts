import { describe, expect, it } from "vitest";
import { calculateCastRewards, calculateCastSalesReports, findUnclassifiedLegacyBottles, normalizeDailyClosing, type CastDailyCorrectionDocument, type CastRecord, type DailyClosing, type PosClosingV3 } from "./gms";
import { applyCastCorrections, createCastCorrectionDraft, sealCastCorrectionDraft, type CastCorrectionWorkspace } from "./cast-corrections";
import { createCastReturnHandoff, materializeCastReturnHandoff, normalizeCastReturnHandoff, prepareCastReturnReedit, validateCastReturnSubmission } from "./cast-return-handoff";

function fixture() {
  const masters: CastRecord[] = ["a", "b", "c"].map((id) => ({ id, name: id, legalName: "", status: "active", hiredAt: "2026-09-01",
    hourlyRates: { "2026-09": 3000 }, note: "", createdAt: "", updatedAt: "" }));
  const casts = masters.slice(0, 2).map((cast) => ({ masterId: cast.id, posCastId: `pos-${cast.id}`, name: cast.name, kind: "regular" as const,
    startTime: "20:00", endTime: "00:00", hours: 4, hourlyRate: 3000, honShimeiCount: 0, banaiShimeiCount: 0,
    dohanCount: 0, dohanBack: 0, honShimeiSales: 50000, jonaiExtensionSales: 0, drinkSales: 0, drinkAllocations: [],
    bottles: [], liquorCost: 0, beautyAllowance: 0, dailyPayment: 0, advancePayment: 0, transportFee: 0 }));
  const source: DailyClosing = { id: "daily_20260901", businessDate: "2026-09-01", status: "approved", submissionId: "pos-submission", checksum: "a".repeat(64),
    sales: { cashSales: 100000, cardSales: 200000, totalSales: 300000 }, customers: { groupCount: 1, totalCustomers: 2 },
    nominations: { honShimeiCount: 0, jonaiCount: 0 }, casts, staffWork: [], drivers: [], expenses: [],
    staffDailyPaymentTotal: 0, dispatchStaffPayment: 0, dispatchCastPayment: 0, dispatchFee: 0, liquorDeliveryAmount: 0,
    cash: { cashSales: 100000, cardSales: 200000, totalSales: 300000, cashFloat: 200000, expenseAndPaymentTotal: 0,
      expectedClosingCash: 300000, cashProfit: 100000, actualClosingCash: 300000, difference: 0 },
    updatedAt: "2026-09-02T00:00:00.000Z", submittedAt: "2026-09-01T16:00:00.000Z", submittedAtMs: 1000,
    posSnapshot: { businessDate: "2026-09-01", castWork: casts.map((row) => ({ castId: row.posCastId, castName: row.name, castType: row.kind,
      startTime: row.startTime, endTime: row.endTime, hours: row.hours, breakMinutes: 0 })), transactions: [], castSales: [], sales: {}, customers: {}, nominations: {} } as unknown as PosClosingV3 };
  const data: CastCorrectionWorkspace = { casts: masters, staff: [], drivers: [], introducers: [], liquor: [], adjustments: [], cashFloat: 200000, closings: [source] };
  const draft = createCastCorrectionDraft(source);
  draft.entries[0].endTime = "01:15";
  draft.entries[0].honShimeiSales = 120000;
  draft.entries[0].honShimeiCount = 3;
  draft.entries[0].banaiShimeiCount = 2;
  draft.entries[0].dohan = [{ arrivalTime: "20:30", extended: true, quantity: 2 }];
  draft.products = [{ id: "bottle", name: "修正ボトル", kind: "champagneWine", unitPrice: 35000, unitCost: 12500, quantity: 1,
    classification: "honShimei", targets: draft.entries.map((entry) => entry.id), externalTargetCount: 0 },
  { id: "drink", name: "ドリンク", kind: "castDrink", unitPrice: 3000, unitCost: 0, quantity: 4,
    classification: "excluded", targets: draft.entries.map((entry) => entry.id), externalTargetCount: 0 }];
  const correction: CastDailyCorrectionDocument = { sourceClosingId: source.id, revision: 1, active: true, current: draft,
    history: { "1": { revision: 1, active: true, draft, reason: "訂正", createdAt: "2026-09-03T00:00:00.000Z", createdBy: "op" } } };
  data.castCorrections = [correction];
  const meta = { id: "handoff-1", returnedAt: "2026-09-04T00:00:00.000Z", reason: "現金の再確認", createdAt: "2026-09-04T00:00:00.000Z", createdBy: "op" };
  const build = () => {
    const handoff = createCastReturnHandoff(source, correction, data, meta);
    const returned: DailyClosing = { ...source, status: "returned", castReturnHandoffId: handoff.id, returnedAt: handoff.returnedAt, updatedAt: handoff.returnedAt };
    return { handoff, returned, edited: materializeCastReturnHandoff(returned, handoff) };
  };
  return { data, source, draft, correction, meta, build };
}

describe("キャスト経理修正から店舗への引継ぎ", () => {
  it("原本POSと全現金項目を保持し、修正済み勤務・本数・商品だけ実体化する", () => {
    const f = fixture(); f.source.casts[0].dailyPayment = 10000; f.source.casts[0].advancePayment = 1000; f.source.casts[0].transportFee = 500;
    const untouched = structuredClone(f.source); const { edited, returned, handoff } = f.build();
    expect(f.source).toEqual(untouched); expect(edited.cash).toEqual(untouched.cash); expect(edited.posSnapshot).toEqual(untouched.posSnapshot);
    expect(edited.casts[0]).toMatchObject({ posCastId: "pos-a", hours: 5.25, honShimeiCount: 3, banaiShimeiCount: 2,
      dohanCount: 2, dohanBack: 10000, dailyPayment: 10000, advancePayment: 1000, transportFee: 500 });
    expect(edited.casts.every((row) => row.accountingCorrection === undefined)).toBe(true);
    expect(() => validateCastReturnSubmission(edited, returned, handoff)).not.toThrow();
  });
  it("再承認後にバック・原価・紹介者計算が訂正時と一致し二重適用しない", () => {
    const f = fixture(); const projected = applyCastCorrections(f.data).closings;
    const { edited } = f.build(); edited.status = "approved";
    const wanted = calculateCastRewards(projected, f.data.casts, "2026-09");
    const actual = calculateCastRewards([edited], f.data.casts, "2026-09");
    expect(findUnclassifiedLegacyBottles(projected, "2026-09")).toEqual([]);
    expect(findUnclassifiedLegacyBottles([edited], "2026-09")).toEqual([]);
    expect(actual).toEqual(wanted);
    expect(actual[0]).toMatchObject({ bottleBack: 2810, drinkBack: 600, honShimeiLiquorCost: 6250 });
    expect(calculateCastSalesReports([edited], f.data.casts, "2026-09")[0].days[0]).toMatchObject({ honShimeiCount: 3, dohanCount: 2 });
  });
  it("対象外ボトルはバックと原価計上から除外する", () => {
    const f = fixture(); f.draft.products[0].classification = "excluded";
    const { edited } = f.build(); edited.status = "approved";
    expect(calculateCastRewards([edited], f.data.casts, "2026-09")[0]).toMatchObject({ bottleBack: 0, honShimeiLiquorCost: 0 });
  });
  it("店舗が日払い等と手入力売上を訂正できるが勤務・商品値の無断差替えは拒否", () => {
    const { edited, returned, handoff } = fixture().build();
    edited.casts[0].dailyPayment = 1234; edited.casts[0].advancePayment = 500; edited.casts[0].honShimeiSales = 90000;
    expect(() => validateCastReturnSubmission(edited, returned, handoff)).not.toThrow();
    edited.casts[0].bottles[0].costAmount++;
    expect(() => validateCastReturnSubmission(edited, returned, handoff)).toThrow("勤務・本数・商品");
  });
  it("引継ぎ参照の欠落・改竄・新規への注入を拒否", () => {
    const { edited, returned, handoff } = fixture().build();
    expect(() => validateCastReturnSubmission(edited, returned)).toThrow("引継ぎ記録がありません");
    expect(() => validateCastReturnSubmission(edited, null)).toThrow("新規");
    const missing = { ...edited, castInputRevision: undefined };
    expect(() => validateCastReturnSubmission(missing, returned, handoff)).toThrow("変更・欠落");
    edited.castInputRevision!.draft.products[0].unitPrice++;
    expect(() => validateCastReturnSubmission(edited, returned, handoff)).toThrow("変更・欠落");
  });
  it("新POS原本へ再照合する場合だけ引継ぎ入力を解除できる", () => {
    const { edited, returned, handoff } = fixture().build(); edited.checksum = "b".repeat(64);
    expect(() => validateCastReturnSubmission(edited, returned, handoff)).toThrow("混在");
    delete edited.castInputRevision;
    expect(() => validateCastReturnSubmission(edited, returned, handoff)).not.toThrow();
  });
  it("同日の追加・削除・別人変更を保持する", () => {
    const f = fixture(); f.draft.entries[0].deleted = true;
    Object.assign(f.draft.entries[1], { masterId: "c", name: "c" });
    f.draft.entries.push({ ...f.draft.entries[0], deleted: false, id: "added", originalPosCastId: undefined, masterId: "a", name: "a" });
    f.draft.products.forEach((product) => { product.targets = [f.draft.entries[1].id, "added"]; });
    f.correction.current = sealCastCorrectionDraft(f.draft, f.data);
    const { edited } = f.build();
    expect(edited.casts.map((row) => [row.masterId, row.posCastId])).toEqual([["c", "pos-b"], ["a", "handoff_added"]]);
  });
  it("支払済み行の削除を引継ぎで自動実行しない", () => {
    const f = fixture(); f.source.casts[0].dailyPayment = 10000; f.draft.entries[0].deleted = true;
    f.draft.products.forEach((product) => { product.targets = [f.draft.entries[1].id]; });
    expect(f.build).toThrow("支払記録");
  });
  it("別日移動がある場合は関連営業日を示して原本を保持する", () => {
    const f = fixture(); f.draft.entries[0].targetClosingId = "day-2"; f.draft.entries[0].businessDate = "2026-09-02";
    expect(f.build).toThrow("2026-09-02"); expect(f.source.status).toBe("approved");
  });
  it("受入後の再編集・再訂正の初期値を原本POSへ戻さない", () => {
    const f = fixture(); const { edited } = f.build(); edited.status = "approved"; delete edited.castReturnHandoffId;
    edited.casts[0].honShimeiSales = 99990;
    const draft = createCastCorrectionDraft(edited);
    expect(draft.entries[0]).toMatchObject({ endTime: "01:15", originalPosCastId: "pos-a", honShimeiSales: 99990 });
    expect(draft.products).toEqual(f.draft.products);
    expect(prepareCastReturnReedit(edited)).toBe(edited);
  });
  it("二回目の訂正受入でも原本全体本数と商品計算を保持する", () => {
    const f = fixture(); const first = f.build().edited; first.status = "approved"; delete first.castReturnHandoffId;
    first.updatedAt = "2026-09-06T00:00:00.000Z";
    const originalCasts = structuredClone(first.castInputRevision!.originalCasts);
    const draft = createCastCorrectionDraft(first); draft.entries[0].honShimeiCount = 4; draft.products[0].unitPrice = 40000;
    const correction = { ...f.correction, current: draft };
    const data = { ...f.data, closings: [first], castCorrections: [correction] };
    const handoff = createCastReturnHandoff(first, correction, data,
      { ...f.meta, id: "handoff-2", returnedAt: "2026-09-07T00:00:00.000Z" });
    const returned: DailyClosing = { ...first, status: "returned", castReturnHandoffId: handoff.id, returnedAt: handoff.returnedAt, updatedAt: handoff.returnedAt };
    const second = materializeCastReturnHandoff(returned, handoff);
    expect(second.castInputRevision!.originalCasts).toEqual(originalCasts);
    expect(second.casts[0].honShimeiCount).toBe(4); expect(second.casts[0].bottles[0].backAmount).toBe(3430);
    expect(() => validateCastReturnSubmission(second, returned, handoff)).not.toThrow();
    expect(normalizeDailyClosing(second).integrityIssues).toEqual([]);
  });
  it("受入済入力の保存勤務・商品値が破損した場合は整合性警告を返す", () => {
    const { edited } = fixture().build(); edited.casts[0].hours = 1;
    expect(normalizeDailyClosing(edited).integrityIssues).toContain("受入済みキャスト入力の勤務・本数・商品明細が保存内容と一致しません。");
  });
  it("Firebase空配列の欠落を正規化して再計算を維持する", () => {
    const { handoff, returned, edited } = fixture().build();
    const raw = structuredClone(handoff); delete (raw.draft.entries[1] as Partial<typeof raw.draft.entries[1]>).dohan;
    expect(normalizeCastReturnHandoff(raw, returned.id, handoff.id).draft.entries[1].dohan).toEqual([]);
    expect(normalizeDailyClosing(edited).castInputRevision).toEqual(edited.castInputRevision);
  });
});
