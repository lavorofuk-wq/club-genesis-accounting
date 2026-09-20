import { createElement, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountingWorkspaceData } from "@/domain/month-accounting";
import type { CastCorrectionDraft, CastCorrectionProduct, DailyCast, DailyClosing } from "@/domain/gms";
const drafts = vi.hoisted(() => new Map<string, unknown>());
const save = vi.hoisted(() => vi.fn());
const monthly = vi.hoisted(() => vi.fn());
vi.mock("@/lib/firebase/repository", () => ({ saveCastCorrection: save }));
vi.mock("@/domain/month-accounting", async (load) => ({ ...await load<typeof import("@/domain/month-accounting")>(), calculateMonthlyAccounting: monthly }));
vi.mock("./update-drafts", () => ({ useRecoverableState: <T,>(key: string, initial: T | (() => T)) => useState<T>(() => drafts.has(key) ? drafts.get(key) as T : typeof initial === "function" ? (initial as () => T)() : initial) }));
import { CastDailyEditor, castCorrectionProductBack } from "./cast-daily-editor";

const cast: DailyCast = { masterId: "cast", posCastId: "pos", name: "確認キャスト", kind: "regular", startTime: "20:00", endTime: "00:00", hours: 4, hourlyRate: 3000, honShimeiCount: 1, banaiShimeiCount: 0, dohanCount: 0, dohanBack: 0, honShimeiSales: 10000, jonaiExtensionSales: 0, drinkSales: 0, bottles: [], liquorCost: 0, beautyAllowance: 0, dailyPayment: 10000, advancePayment: 0, transportFee: 0 };
const day = { id: "day", businessDate: "2026-09-01", updatedAt: "2026-09-17T00:00:00.000Z", checksum: "a".repeat(64), submissionId: "submission", status: "approved", casts: [cast], expenses: [], staffWork: [], drivers: [], sales: { cashSales: 100000, cardSales: 0, totalSales: 100000 }, cash: { cashFloat: 200000, cashProfit: 90000, expectedClosingCash: 290000, actualClosingCash: 290000, difference: 0 }, dispatchCastPayment: 0, dispatchStaffPayment: 0, dispatchFee: 0, liquorDeliveryAmount: 0 } as unknown as DailyClosing;
const product: CastCorrectionProduct = { id: "shared", name: "共有シャンパン", kind: "champagneWine", unitPrice: 35000, unitCost: 12500, quantity: 1, classification: "honShimei", targets: ["entry", "other"], externalTargetCount: 0 };
const draft: CastCorrectionDraft = { sourceClosingId: day.id, sourceUpdatedAt: day.updatedAt, sourceChecksum: day.checksum, sourceSubmissionId: day.submissionId, entries: [{ id: "entry", originalPosCastId: "pos", targetClosingId: day.id, businessDate: day.businessDate, masterId: cast.masterId, name: cast.name, kind: "regular", startTime: "20:00", endTime: "00:00", breakMinutes: 0, hourlyRate: 3000, honShimeiCount: 1, banaiShimeiCount: 0, honShimeiSales: 10000, jonaiExtensionSales: 0, beautyAllowance: 0, dohan: [], deleted: false }], products: [] };
const data: AccountingWorkspaceData = { casts: [], staff: [], drivers: [], introducers: [], liquor: [], closings: [day], adjustments: [], cashFloat: 200000, archivedCasts: [], archivedStaff: [], introducerEntryEvents: [], introducerDeletionCommits: [], introducerMonthEvents: [], monthStates: [], monthSnapshots: [] };
beforeEach(() => { drafts.clear(); save.mockClear(); monthly.mockClear(); });
const render = (overrides: Partial<Parameters<typeof CastDailyEditor>[0]> = {}) => renderToStaticMarkup(createElement(CastDailyEditor, { data, user: { uid: "accountant" } as never, month: "2026-09", busy: false, locked: false, run: vi.fn(async () => true), onDirtyChange: vi.fn(), ...overrides }));
const recover = (value = draft, reason = "", initial = value) => drafts.set("accounting.castDaily.editing", { draft: value, entryId: "entry", changed: true, revision: 0, initial: JSON.stringify(initial), reason, visibleProductIds: initial.products.filter((row) => row.targets.includes("entry")).map((row) => row.id) });

describe("1人1日だけのキャスト編集", () => {
  it("閉じている間は編集フォーム・履歴のDOMや月次試算を生成しない", () => {
    expect(render()).toBe(""); expect(save).not.toHaveBeenCalled(); expect(monthly).not.toHaveBeenCalled();
  });
  it("対象の人と営業日をモーダルに表示し、退避入力・理由を保持する", () => {
    const edited = structuredClone(draft); edited.entries[0].honShimeiSales = 56780;
    recover(edited, "売上を訂正"); const html = render(); expect(html).toContain('role="dialog"'); expect(html).toContain("確認キャスト・2026-09-01 の日次編集"); expect(html).toContain('value="56780"'); expect(html).toContain("売上を訂正"); expect(save).not.toHaveBeenCalled(); expect(monthly).not.toHaveBeenCalled();
  });
  it("他の人の勤務・売上や無関係の商品を描画しない", () => {
    const edited = structuredClone(draft); edited.entries.push({ ...edited.entries[0], id: "other", masterId: "other", name: "他の人", honShimeiSales: 876540 }); edited.products.push({ ...product, name: "対象外の商品名", targets: ["other"] });
    recover(edited); const html = render(); expect(html).not.toContain("他の人"); expect(html).not.toContain("876540"); expect(html).not.toContain("対象外の商品名"); expect(html.match(/<input[^>]*type="time"/g)).toHaveLength(2);
  });
  it("出勤追加・削除・人物変更・日付変更・全体復元をUIから除去する", () => {
    recover(); const html = render(); expect(html).not.toContain("出勤行を追加"); expect(html).not.toContain("出勤行を削除"); expect(html).not.toContain('aria-label="出勤日"'); expect(html).not.toContain('aria-label="キャスト"'); expect(html).not.toContain("原本へ戻す</button>"); expect(html).toContain("保持する実績：日払い ￥10,000"); expect(html).toContain("支払実績の訂正は店舗への差戻し");
  });
  it("入力中や理由入力だけでは月次試算せず、確認前保存を禁止する", () => {
    recover(draft, "理由あり"); const html = render(); expect(monthly).not.toHaveBeenCalled(); expect(html).toContain("変更内容を確認"); expect(html).toMatch(/<button[^>]*disabled=""[^>]*>経理修正を保存/); expect(html).not.toContain("保存後の月次計算プレビュー");
  });
  it("共有商品だけ相手とバック変動を表示し、相手の勤務入力は出さない", () => {
    const original = structuredClone(draft); original.entries.push({ ...original.entries[0], id: "other", masterId: "other", name: "共有相手", honShimeiSales: 987650 }); original.products.push(product);
    const edited = structuredClone(original); edited.products[0].unitPrice = 40000; recover(edited, "共有単価訂正", original);
    const html = render(); expect(html).toContain("共有相手"); expect(html).toContain("￥2,810 → ￥3,430"); expect(html).not.toContain("987650"); expect(html).toContain("配賦先の選択を開く"); expect(html).not.toContain('class="check-row"><input type="checkbox" checked=""/>共有相手');
  });
  it("この人に未配賦の既存商品を選ぶ入口を残す", () => {
    recover(); const html = render(); expect(html).toContain("未配賦の既存商品を選ぶ"); expect(html).toContain("この人の商品を追加"); expect(html).not.toContain('aria-label="この人に未配賦の既存商品"');
  });
  it("確定済みでは入力fieldsetを無効にする", () => {
    recover(); expect(render({ locked: true })).toContain('<fieldset disabled="" class="correction-fields">');
  });
  it("旧形式の退避データは勝手に保存せず、内容確認と破棄確認の対象として保持する", () => {
    drafts.set("accounting.castDaily.editing", { draft, revision: 0, initial: JSON.stringify(draft), reason: "以前の入力" });
    const html = render(); expect(html).toContain("以前の全員編集画面の退避入力"); expect(html).not.toContain("経理修正を保存"); expect(html).not.toContain("以前の入力"); expect(save).not.toHaveBeenCalled();
  });
  it("履歴はボタンを押すまで内容を描画しない", () => {
    recover(); const modified = { ...data, castCorrections: [{ sourceClosingId: day.id, revision: 1, active: true, current: draft, history: { "1": { revision: 1, active: true, draft, reason: "表示していない履歴の理由", createdBy: "user", createdAt: "2026-09-18T00:00:00Z" } } }] };
    const html = render({ data: modified }); expect(html).toContain("修正履歴を表示"); expect(html).not.toContain("表示していない履歴の理由");
  });
  it("旧版の移動済み・追加済み出勤行でも現在のID・日付のまま編集できる", () => {
    const moved = structuredClone(draft); moved.entries[0] = { ...moved.entries[0], originalPosCastId: undefined, businessDate: "2026-09-02", targetClosingId: "moved-day", name: "以前追加した人" };
    recover(moved); const html = render(); expect(html).toContain("以前追加した人・2026-09-02 の日次編集"); expect(html).toContain("経理修正を保存"); expect(html).not.toContain("以前の全員編集画面の退避入力");
  });
});

describe("入力中の軽量な商品バック表示", () => {
  it("商品全体と人数配分の双方を10円未満切捨てする", () => expect(castCorrectionProductBack(product)).toBe(2810));
  it("対象外のボトルは0円、ドリンクは分類にかかわらず10％にする", () => {
    expect(castCorrectionProductBack({ ...product, classification: "excluded" })).toBe(0);
    expect(castCorrectionProductBack({ ...product, kind: "castDrink", classification: "excluded", unitPrice: 2000, unitCost: 0, quantity: 4 })).toBe(400);
  });
  it("派遣も配分人数に含み、対象者なしは0円にする", () => {
    expect(castCorrectionProductBack({ ...product, externalTargetCount: 1 })).toBe(1870);
    expect(castCorrectionProductBack({ ...product, targets: [] })).toBe(0);
  });
});
