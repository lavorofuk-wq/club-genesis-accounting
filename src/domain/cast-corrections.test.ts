import { describe, expect, it } from "vitest";
import { applyCastCorrections, castCorrectionDohanBack, createCastCorrectionDraft, normalizeCastDailyCorrectionDocument,
  normalizeCorrectedDailyCast, sealCastCorrectionDraft, validateCastCorrectionDraft, type CastCorrectionWorkspace } from "./cast-corrections";
import { calculateCastRewards, calculateCastSalesReports, normalizeDailyClosing, posItemOccurrenceKey, type CastCorrectionDraft,
  type CastDailyCorrectionDocument, type CastRecord, type DailyCast, type DailyClosing, type PosClosingV3, type PosItem } from "./gms";

const month = "2026-09";
const cast = (id = "cast-1"): DailyCast => ({ masterId: id, posCastId: `pos-${id}`, name: id, kind: "regular", startTime: "20:00", endTime: "00:00",
  hours: 4, hourlyRate: 3000, honShimeiCount: 1, banaiShimeiCount: 0, dohanCount: 0, dohanBack: 0,
  honShimeiSales: 35000, jonaiExtensionSales: 0, drinkSales: 0, drinkAllocations: [], bottles: [], liquorCost: 0,
  beautyAllowance: 0, dailyPayment: 0, advancePayment: 0, transportFee: 0 });
const master = (id = "cast-1"): CastRecord => ({ id, name: id, legalName: "", status: "active", hiredAt: "2026-09-01",
  hourlyRates: { [month]: 3000 }, note: "", createdAt: "", updatedAt: "" });
function closing(day = 1, casts = [cast()]): DailyClosing {
  const businessDate = `${month}-${String(day).padStart(2, "0")}`;
  return { id: `day-${day}`, businessDate, status: "approved", submissionId: `submission-${day}`, checksum: "a".repeat(64),
    updatedAt: "2026-09-17T01:00:00.000Z", submittedAt: `2026-09-${String(day).padStart(2, "0")}T15:00:00.000Z`, submittedAtMs: day * 1000,
    sales: { cashSales: 50000, cardSales: 0, totalSales: 50000 }, customers: { groupCount: 1, totalCustomers: 1 },
    nominations: { honShimeiCount: casts.length, jonaiCount: 0 }, casts, staffWork: [], drivers: [], expenses: [],
    staffDailyPaymentTotal: 0, dispatchStaffPayment: 0, dispatchCastPayment: 0, dispatchFee: 0, liquorDeliveryAmount: 0,
    cash: { cashSales: 50000, cardSales: 0, totalSales: 50000, cashFloat: 200000, expenseAndPaymentTotal: 0,
      expectedClosingCash: 250000, cashProfit: 50000, actualClosingCash: 250000, difference: 0 },
    posSnapshot: { businessDate, transactions: [], castWork: casts.map((row) => ({ castId: row.posCastId, castName: row.name, castType: row.kind,
      isTrial: false, startTime: row.startTime, endTime: row.endTime, hours: row.hours, breakMinutes: 0 })) } as unknown as PosClosingV3 };
}
function document(draft: CastCorrectionDraft): CastDailyCorrectionDocument {
  return { sourceClosingId: draft.sourceClosingId, revision: 1, active: true, current: draft,
    history: { "1": { revision: 1, active: true, draft, reason: "原本確認による訂正", createdAt: "2026-09-17T01:00:00.000Z", createdBy: "accountant" } } };
}
function workspace(closings = [closing()]): CastCorrectionWorkspace {
  return { closings, casts: [master(), master("cast-2"), master("cast-3")], staff: [], drivers: [], introducers: [], liquor: [], adjustments: [], cashFloat: 200000 };
}
function item(overrides: Partial<PosItem> = {}): PosItem {
  return { itemId: "item", label: "シャンパン", category: "champagneWine", price: 35000, quantity: 1,
    backTargetCastIds: ["pos-cast-1", "pos-cast-2"], backTargetCastNames: ["cast-1", "cast-2"], banaiExtCastIds: [],
    isSet: false, isHonShimei: false, isBanaiShimei: false, isExtension: false, isBanaiExtension: false, isDiscount: false, ...overrides };
}
function sharedSource() {
  const source = closing(1, [cast(), cast("cast-2")]);
  const transaction = { transactionId: "transaction", items: [item({ itemId: "hon1", category: "hon", isHonShimei: true, castId: "pos-cast-1" }),
    item({ itemId: "hon2", category: "hon", isHonShimei: true, castId: "pos-cast-2" }), item()], startTime: Date.parse("2026-09-01T20:00:00+09:00") };
  source.posSnapshot!.transactions = [transaction as PosClosingV3["transactions"][number]];
  const sourceKey = posItemOccurrenceKey(source.posSnapshot!.transactions[0], 2);
  source.casts.forEach((row) => { row.bottles = [{ itemId: "item", sourceKey, name: "シャンパン", kind: "champagneWine", quantity: 1,
    salesAmount: 17500, costAmount: 6250, backAmount: 2810, specialCost: false }]; row.liquorCost = 6250; });
  return source;
}

describe("経理キャスト訂正の原本分離", () => {
  it("勤務・売上訂正は計算へ反映し、原本・現金・POS・送信順を変更しない", () => {
    const data = workspace(); const before = structuredClone(data); const draft = createCastCorrectionDraft(data.closings[0]);
    draft.entries[0].endTime = "00:15"; draft.entries[0].honShimeiSales = 50000;
    draft.entries[0].honShimeiCount = 2; draft.entries[0].beautyAllowance = 500;
    data.castCorrections = [document(draft)];
    validateCastCorrectionDraft(draft, data);
    const result = applyCastCorrections(data);
    expect(result.issues).toEqual([]); expect(data.closings).toEqual(before.closings);
    expect(result.closings[0].cash).toEqual(before.closings[0].cash);
    expect(result.closings[0].posSnapshot).toEqual(before.closings[0].posSnapshot);
    expect(calculateCastRewards(result.closings, data.casts, month)[0]).toMatchObject({ hourlyPay: 12750, honShimeiSales: 50000,
      honShimeiBack: 2000, beautyAllowance: 500, grossPay: 15250 });
  });
  it("全削除を明示指定し、原本復元で元の勤務へ戻る", () => {
    const data = workspace(); const draft = createCastCorrectionDraft(data.closings[0]); draft.entries[0].deleted = true;
    data.castCorrections = [document(draft)]; expect(applyCastCorrections(data).closings[0].casts).toEqual([]);
    data.castCorrections[0].active = false; data.castCorrections[0].current = null;
    expect(applyCastCorrections(data).closings[0].casts).toEqual(data.closings[0].casts);
  });
  it.each(["dailyPayment", "advancePayment", "transportFee"] as const)("%sのある行は削除・人物・営業日変更を拒否し金額修正だけは許可", (key) => {
    const data = workspace([closing(), closing(2, [])]); data.closings[0].casts[0][key] = 1000;
    const draft = createCastCorrectionDraft(data.closings[0]); draft.entries[0].honShimeiSales = 70000;
    expect(() => validateCastCorrectionDraft(draft, data)).not.toThrow();
    for (const patch of [{ deleted: true }, { masterId: "cast-2", name: "cast-2" }, { targetClosingId: "day-2", businessDate: "2026-09-02" }]) {
      const changed = structuredClone(draft); Object.assign(changed.entries[0], patch);
      expect(() => validateCastCorrectionDraft(changed, data)).toThrow("支払記録");
    }
    data.castCorrections = [document(draft)]; expect(applyCastCorrections(data).closings[0].casts[0][key]).toBe(1000);
  });
  it("即日美容室支払のある体入も移動・削除しない", () => {
    const data = workspace(); data.closings[0].expenses = [{ id: "beauty", category: "beautyTrial", personId: "cast-1", payee: "cast-1", amount: 500 }];
    const draft = createCastCorrectionDraft(data.closings[0]); draft.entries[0].deleted = true;
    expect(() => validateCastCorrectionDraft(draft, data)).toThrow("支払記録");
  });
  it("支払のない行だけ他の承認済み営業日へ移動し、元月確定済みは拒否", () => {
    const target = closing(2, []); target.businessDate = "2026-10-01";
    const data = workspace([closing(), target]); const draft = createCastCorrectionDraft(data.closings[0]);
    Object.assign(draft.entries[0], { targetClosingId: target.id, businessDate: target.businessDate });
    validateCastCorrectionDraft(draft, data); data.castCorrections = [document(sealCastCorrectionDraft(draft, data))];
    const result = applyCastCorrections(data); expect(result.issues).toEqual([]);
    expect(result.closings[0].casts).toEqual([]); expect(result.closings[1].casts[0].hours).toBe(4);
    data.monthStates = [{ month, status: "closed" }];
    expect(() => validateCastCorrectionDraft(draft, data)).toThrow("確定");
    expect(applyCastCorrections(data).issues).toEqual([]);
  });
  it("未承認営業日と原本世代違いを拒否", () => {
    const data = workspace([closing(), closing(2, [])]); const draft = createCastCorrectionDraft(data.closings[0]);
    draft.entries[0].targetClosingId = "day-2"; draft.entries[0].businessDate = "2026-09-02"; data.closings[1].status = "returned";
    expect(() => validateCastCorrectionDraft(draft, data)).toThrow("承認済み営業日");
    data.closings[1].status = "approved"; data.closings[0].updatedAt = "2026-09-18T00:00:00Z"; data.castCorrections = [document(draft)];
    expect(applyCastCorrections(data)).toMatchObject({ closings: data.closings, issues: [expect.stringContaining("変更されています")] });
  });
  it("本人の同日重複と欠落原本行を拒否", () => {
    const data = workspace([closing(), closing(2)]); const draft = createCastCorrectionDraft(data.closings[0]);
    draft.entries[0].targetClosingId = "day-2"; draft.entries[0].businessDate = "2026-09-02";
    expect(() => validateCastCorrectionDraft(draft, data)).toThrow("既に出勤");
    draft.entries = []; expect(() => validateCastCorrectionDraft(draft, data)).toThrow("欠落");
  });
  it("追加行は現在マスタを照合し日払いを勝手に生成しない", () => {
    const data = workspace(); const draft = createCastCorrectionDraft(data.closings[0]);
    const added = { ...draft.entries[0], id: "new", originalPosCastId: undefined, masterId: "cast-2", name: "cast-2" }; draft.entries.push(added);
    validateCastCorrectionDraft(draft, data); data.castCorrections = [document(sealCastCorrectionDraft(draft, data))];
    expect(applyCastCorrections(data).closings[0].casts[1]).toMatchObject({ masterId: "cast-2", dailyPayment: 0, advancePayment: 0, transportFee: 0 });
    added.name = "別名"; expect(() => validateCastCorrectionDraft(draft, data)).toThrow("保存済み氏名");
  });
  it("他日へ移しても紹介者条件の店舗保存順は変更しない", () => {
    const first = closing(); first.casts[0].introducer = { id: "old", name: "old", feeType: "sales10", attendanceAdvisoryFee: 0, entryAdvisoryFee: 0 };
    const second = closing(2); second.casts[0].introducer = { ...first.casts[0].introducer, id: "new", name: "new" };
    const data = workspace([first, second, closing(3, [])]); const draft = createCastCorrectionDraft(first);
    draft.entries[0].targetClosingId = "day-3"; draft.entries[0].businessDate = "2026-09-03"; data.castCorrections = [document(draft)];
    expect(calculateCastRewards(applyCastCorrections(data).closings, data.casts, month)[0].introducer?.id).toBe("new");
  });
  it("原本時給の勝手な変更を拒否し、移動先月の月度時給を適用する", () => {
    const next = closing(2, []); next.businessDate = "2026-10-01";
    const data = workspace([closing(), next]); data.casts[0].hourlyRates["2026-10"] = 4000;
    const draft = createCastCorrectionDraft(data.closings[0]); draft.entries[0].hourlyRate = 1;
    expect(() => validateCastCorrectionDraft(draft, data)).toThrow("原本のまま");
    Object.assign(draft.entries[0], { hourlyRate: 3000, targetClosingId: next.id, businessDate: next.businessDate });
    validateCastCorrectionDraft(draft, data); data.castCorrections = [document(draft)];
    expect(calculateCastRewards(applyCastCorrections(data).closings, data.casts, "2026-10")[0].hourlyPay).toBe(16000);
  });
  it("人物追加時の適用時給不一致と採用前の移動は拒否する", () => {
    const data = workspace([closing(), closing(2, [])]); const draft = createCastCorrectionDraft(data.closings[0]);
    draft.entries.push({ ...draft.entries[0], id: "new", originalPosCastId: undefined, masterId: "cast-2", name: "cast-2", hourlyRate: 99 });
    expect(() => validateCastCorrectionDraft(draft, data)).toThrow("適用時給");
    draft.entries.pop(); data.casts[0].hiredAt = "2026-09-03";
    Object.assign(draft.entries[0], { targetClosingId: "day-2", businessDate: "2026-09-02" });
    expect(() => validateCastCorrectionDraft(draft, data)).toThrow("採用日");
  });
  it("別人物の条件を固定し、後日の名称・時給・紹介者マスタ変更でも訂正が壊れない", () => {
    const data = workspace(); data.casts[1].introducerId = "intro";
    data.introducers = [{ id: "intro", name: "紹介者", feeType: "sales10", attendanceAdvisoryEnabled: false, entryAdvisoryEnabled: false, note: "", createdAt: "", updatedAt: "" }];
    const draft = createCastCorrectionDraft(data.closings[0]); Object.assign(draft.entries[0], { masterId: "cast-2", name: "cast-2" });
    const sealed = sealCastCorrectionDraft(draft, data); expect(sealed.entries[0].termsSnapshot?.introducer?.feeType).toBe("sales10");
    data.castCorrections = [document(sealed)];
    data.casts[1].name = "改名"; data.casts[1].hourlyRates[month] = 4000; data.introducers[0].feeType = "gross10";
    const result = applyCastCorrections(data); expect(result.issues).toEqual([]);
    const reward = calculateCastRewards(result.closings, data.casts, month)[0];
    expect(reward.hourlyPay).toBe(16000); expect(reward.introducer?.feeType).toBe("sales10");
    expect(sealCastCorrectionDraft(sealed, data).entries[0].termsSnapshot?.introducer?.feeType).toBe("sales10");
  });
  it("追加人物の対象月最新日次から条件を固定し、後に店舗保存された日次の条件は月全体へ適用", () => {
    const first = closing(); const other = closing(2, [cast("cast-2")]);
    other.casts[0].introducer = { id: "intro", name: "旧", feeType: "sales10", attendanceAdvisoryFee: 0, entryAdvisoryFee: 0 };
    const data = workspace([first, other]); const draft = createCastCorrectionDraft(first); Object.assign(draft.entries[0], { masterId: "cast-2", name: "cast-2" });
    const sealed = sealCastCorrectionDraft(draft, data); expect(sealed.entries[0].termsSnapshot).toMatchObject({ source: "daily", sourceClosingId: "day-2", submittedAtMs: 2000 });
    data.castCorrections = [document(sealed)];
    const latest = closing(3, [cast("cast-2")]); latest.casts[0].introducer = { ...other.casts[0].introducer, name: "新", feeType: "gross10" };
    data.closings.push(latest);
    expect(calculateCastRewards(applyCastCorrections(data).closings, data.casts, month)[0].introducer?.feeType).toBe("gross10");
  });
  it("クライアントが注入した紹介者条件は保存時に信用しない", () => {
    const data = workspace(); const draft = createCastCorrectionDraft(data.closings[0]); Object.assign(draft.entries[0], { masterId: "cast-2", name: "cast-2" });
    draft.entries[0].termsSnapshot = { masterId: "cast-2", month, source: "master", introducer: { id: "fake", name: "fake", feeType: "gross10", attendanceAdvisoryFee: 99999, entryAdvisoryFee: 99999 } };
    expect(sealCastCorrectionDraft(draft, data).entries[0].termsSnapshot?.introducer).toBeUndefined();
  });
});

describe("共有商品と同伴バック", () => {
  it("変更なしで作成・適用しても報酬と売上明細の金額は変わらない", () => {
    const source = sharedSource(); const data = workspace([source]);
    const rewards = calculateCastRewards(data.closings, data.casts, month);
    const sales = calculateCastSalesReports(data.closings, data.casts, month);
    data.castCorrections = [document(createCastCorrectionDraft(source))]; const projected = applyCastCorrections(data);
    expect(calculateCastRewards(projected.closings, data.casts, month)).toEqual(rewards);
    expect(calculateCastSalesReports(projected.closings, data.casts, month)).toEqual(sales);
  });
  it("POS商品から全対象共有原価を復元し、商品全体→個人の10円切捨てを守る", () => {
    const source = sharedSource(); const data = workspace([source]); const draft = createCastCorrectionDraft(source);
    expect(draft.products[0]).toMatchObject({ unitPrice: 35000, unitCost: 12500, quantity: 1, targets: ["pos-cast-1", "pos-cast-2"] });
    data.castCorrections = [document(draft)]; const projected = applyCastCorrections(data);
    expect(projected.issues).toEqual([]);
    expect(calculateCastRewards(projected.closings, data.casts, month).map((row) => row.bottleBack)).toEqual([2810, 2810]);
    draft.products[0].unitPrice = 4000; draft.products[0].unitCost = 0; draft.products[0].externalTargetCount = 1;
    const castRows = applyCastCorrections(data).closings[0].casts;
    expect(castRows.map((row) => row.bottles[0].backAmount)).toEqual([330, 330]);
    expect(castRows[0].bottles[0].salesAmount).toBe(4000 / 3);
  });
  it("手動区分はPOS旧区分より優先し売上種類別原価へ反映", () => {
    const source = sharedSource(); const data = workspace([source]); const draft = createCastCorrectionDraft(source); data.castCorrections = [document(draft)];
    draft.products[0].classification = "jonaiExtension";
    expect(calculateCastSalesReports(applyCastCorrections(data).closings, data.casts, month)[0].days[0]).toMatchObject({ honShimeiLiquorCost: 0, jonaiExtensionLiquorCost: 6250 });
    draft.products[0].classification = "excluded";
    expect(calculateCastRewards(applyCastCorrections(data).closings, data.casts, month)[0]).toMatchObject({ liquorCost: 0, bottleBack: 0 });
  });
  it("商品編集によるドリンク杯数・バック変更がPOS原本で上書きされない", () => {
    const data = workspace(); const draft = createCastCorrectionDraft(data.closings[0]);
    draft.products.push({ id: "drink", name: "ドリンク", kind: "castDrink", unitPrice: 2000, unitCost: 0, quantity: 4,
      classification: "excluded", targets: [draft.entries[0].id], externalTargetCount: 0 });
    data.castCorrections = [document(draft)];
    expect(calculateCastRewards(applyCastCorrections(data).closings, data.casts, month)[0].drinkBack).toBe(800);
  });
  it("共有対象や原価を復元できない場合に推定せず停止", () => {
    const source = sharedSource(); delete source.casts[0].bottles[0].sourceKey;
    expect(() => createCastCorrectionDraft(source)).toThrow("復元できません");
  });
  it.each([["20:30", true, 5000], ["20:30", false, 3000], ["20:31", true, 2000], ["21:00", true, 2000], ["21:01", true, 0]] as const)("同伴%s延長%sは%d円", (arrivalTime, extended, expected) => {
    expect(castCorrectionDohanBack([{ arrivalTime, extended, quantity: 1 }])).toBe(expected);
  });
  it("削除された対象への商品配賦を拒否", () => {
    const source = sharedSource(); const data = workspace([source]); const draft = createCastCorrectionDraft(source); draft.entries[0].deleted = true;
    expect(() => validateCastCorrectionDraft(draft, data)).toThrow("対象キャスト");
  });
});

describe("Firebase訂正履歴と確定明細", () => {
  it("店舗原本から計算専用メタデータを注入できない", () => {
    const source = closing(); source.casts[0].accountingCorrection = { sourceClosingId: source.id, sourceEntryId: "fake", productClassifications: {} };
    const normalized = normalizeDailyClosing(source);
    expect(normalized.casts[0].accountingCorrection).toBeUndefined();
    expect(normalized.integrityIssues?.some((issue) => issue.includes("経理訂正専用"))).toBe(true);
  });
  it("Firebaseの数値キー・空配列欠落・キー順の違いを正常化", () => {
    const draft = createCastCorrectionDraft(closing()); const record = document(draft);
    const firebase = JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
    firebase.history = [null, record.history["1"]];
    const current = firebase.current as CastCorrectionDraft; delete (current as Partial<CastCorrectionDraft>).products;
    expect(normalizeCastDailyCorrectionDocument(firebase, "day-1").current?.products).toEqual([]);
  });
  it("履歴欠落・現行と履歴不一致・他原本を拒否", () => {
    const record = document(createCastCorrectionDraft(closing())); record.revision = 2;
    expect(() => normalizeCastDailyCorrectionDocument(record, "day-1")).toThrow("欠落");
    record.revision = 1; record.current = structuredClone(record.current!); record.current.entries[0].honShimeiSales = 99990;
    expect(() => normalizeCastDailyCorrectionDocument(record, "day-1")).toThrow("一致しません");
    expect(() => normalizeCastDailyCorrectionDocument(record, "wrong")).toThrow("不正");
  });
  it("原本復元も履歴として保持", () => {
    const record = document(createCastCorrectionDraft(closing())); record.revision = 2; record.active = false; record.current = null;
    record.history["2"] = { revision: 2, active: false, reason: "原本へ復元", createdAt: "2026-09-18T00:00:00Z", createdBy: "op" };
    expect(normalizeCastDailyCorrectionDocument(record, "day-1")).toMatchObject({ active: false, revision: 2 });
  });
  it("確定明細の空商品一覧を復元し、改ざんされた商品合計は拒否", () => {
    const data = workspace(); data.castCorrections = [document(createCastCorrectionDraft(data.closings[0]))];
    const row = applyCastCorrections(data).closings[0].casts[0]; const stored = JSON.parse(JSON.stringify(row));
    delete stored.bottles; delete stored.drinkAllocations; delete stored.accountingCorrection.productClassifications;
    expect(normalizeCorrectedDailyCast(stored)).toMatchObject({ bottles: [], drinkAllocations: [] });
    stored.drinkSales = 1; expect(() => normalizeCorrectedDailyCast(stored)).toThrow("一致しません");
  });
  it("訂正していない旧明細の333円バック・1円売上は勝手に切り捨てない", () => {
    const source = sharedSource(); const row = source.casts[0]; row.bottles[0].backAmount = 333; row.honShimeiSales = 35001;
    expect(normalizeCorrectedDailyCast(row)).toMatchObject({ honShimeiSales: 35001, bottles: [{ backAmount: 333 }] });
  });
});
