import { createElement, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountingWorkspaceData } from "@/domain/month-accounting";
import type { CastCorrectionDraft, DailyCast, DailyClosing } from "@/domain/gms";
const drafts = vi.hoisted(() => new Map<string, unknown>());
const save = vi.hoisted(() => vi.fn());
vi.mock("@/lib/firebase/repository", () => ({ saveCastCorrection: save }));
vi.mock("./update-drafts", () => ({ useRecoverableState: <T,>(key: string, initial: T | (() => T)) => useState<T>(() => drafts.has(key) ? drafts.get(key) as T : typeof initial === "function" ? (initial as () => T)() : initial) }));
import { CastDailyEditor, castCorrectionCashReason, castCorrectionPersonValues } from "./cast-daily-editor";

const cast: DailyCast = { masterId: "cast", posCastId: "pos", name: "確認キャスト", kind: "regular", startTime: "20:00", endTime: "00:00", hours: 4, hourlyRate: 3000, honShimeiCount: 1, banaiShimeiCount: 0, dohanCount: 0, dohanBack: 0, honShimeiSales: 10000, jonaiExtensionSales: 0, drinkSales: 0, bottles: [], liquorCost: 0, beautyAllowance: 0, dailyPayment: 10000, advancePayment: 0, transportFee: 0 };
const day = { id: "day", businessDate: "2026-09-01", updatedAt: "2026-09-17T00:00:00.000Z", checksum: "a".repeat(64), submissionId: "submission", status: "approved", casts: [cast], expenses: [], staffWork: [], drivers: [], sales: { cashSales: 100000, cardSales: 0, totalSales: 100000 }, cash: { cashFloat: 200000, cashProfit: 90000, expectedClosingCash: 290000, actualClosingCash: 290000, difference: 0 }, dispatchCastPayment: 0, dispatchStaffPayment: 0, dispatchFee: 0, liquorDeliveryAmount: 0 } as unknown as DailyClosing;
const draft: CastCorrectionDraft = { sourceClosingId: day.id, sourceUpdatedAt: day.updatedAt, sourceChecksum: day.checksum, sourceSubmissionId: day.submissionId, entries: [{ id: "entry", originalPosCastId: "pos", targetClosingId: day.id, businessDate: day.businessDate, masterId: cast.masterId, name: cast.name, kind: "regular", startTime: "20:00", endTime: "00:00", breakMinutes: 0, hourlyRate: 3000, honShimeiCount: 1, banaiShimeiCount: 0, honShimeiSales: 10000, jonaiExtensionSales: 0, beautyAllowance: 0, dohan: [], deleted: false }], products: [] };
const data: AccountingWorkspaceData = { casts: [], staff: [], drivers: [], introducers: [], liquor: [], closings: [day], adjustments: [], cashFloat: 200000, archivedCasts: [], archivedStaff: [], introducerEntryEvents: [], introducerDeletionCommits: [], introducerMonthEvents: [], monthStates: [], monthSnapshots: [] };
beforeEach(() => { drafts.clear(); save.mockClear(); });
const render = (overrides: Partial<Parameters<typeof CastDailyEditor>[0]> = {}) => renderToStaticMarkup(createElement(CastDailyEditor, { data, user: { uid: "accountant" } as never, month: "2026-09", busy: false, locked: false, run: vi.fn(async () => true), onDirtyChange: vi.fn(), ...overrides }));
const recover = (value = draft, reason = "") => drafts.set("accounting.castDaily.editing", { draft: value, revision: 0, initial: JSON.stringify(draft), reason });

describe("キャスト日次編集の入力保護", () => {
  it("表示だけで保存せず、承認済み営業日と現金訂正の案内を表示する", () => {
    const html = render(); expect(html).toContain("2026-09-01"); expect(html).toContain("支払訂正は差戻し"); expect(save).not.toHaveBeenCalled();
  });
  it("退避した修正・理由・元の版を保持して表示する", () => {
    const edited = structuredClone(draft); edited.entries[0].honShimeiSales = 56780;
    recover(edited, "売上を訂正"); const html = render(); expect(html).toContain('value="56780"'); expect(html).toContain("売上を訂正"); expect(save).not.toHaveBeenCalled();
  });
  it("支払済み行の削除・人物・日付変更を無効にする", () => {
    recover(); const html = render(); expect(html).toMatch(/<select[^>]*disabled=""[^>]*><option value="day"/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="支払・控除実績[^>]*>出勤行を削除/);
    expect(html).toContain("日払い ￥10,000");
  });
  it("確定済みでは入力fieldsetを無効にする", () => {
    recover(); expect(render({ locked: true })).toContain('<fieldset disabled="" class="correction-fields">');
  });
  it.each(["dailyPayment", "advancePayment", "transportFee"] as const)("%sの実績を理由として返す", (key) => {
    const source = { ...day, casts: [{ ...cast, dailyPayment: 0, [key]: 500 }] };
    expect(castCorrectionCashReason(source, draft.entries[0])).toContain("差し戻して");
  });
  it("体入美容室の支払を落とさず、現金のない行は制限しない", () => {
    const source = { ...day, casts: [{ ...cast, dailyPayment: 0 }], expenses: [{ id: "beauty", category: "beautyTrial" as const, personId: cast.masterId, payee: cast.name, amount: 500 }] };
    expect(castCorrectionCashReason(source, draft.entries[0])).toContain("支払");
    expect(castCorrectionCashReason({ ...source, expenses: [] }, draft.entries[0])).toBe("");
  });
  it("原本の人物へ戻す際は氏名と登録時時給を保持する", () => {
    const changed = { ...data, casts: [{ id: "cast", name: "現在の名前", hourlyRates: { "2026-09": 4000 } }] } as unknown as AccountingWorkspaceData;
    expect(castCorrectionPersonValues({ ...draft.entries[0], businessDate: "2026-10-01" }, day, changed)).toEqual({ name: "確認キャスト", hourlyRate: 3000 });
  });
  it("追加・別人への変更後に月を移すと移動先の月度時給になる", () => {
    const changed = { ...data, casts: [{ id: "new", name: "新しい人", hourlyRates: { "2026-09": 4000, "2026-10": 4500 } }] } as unknown as AccountingWorkspaceData;
    const entry = { ...draft.entries[0], masterId: "new", businessDate: "2026-10-01" };
    expect(castCorrectionPersonValues(entry, day, changed)).toEqual({ name: "新しい人", hourlyRate: 4500 });
  });
  it("追加した人物の保存済み氏名・時給は同じ月の再編集で保持する", () => {
    const entry = { ...draft.entries[0], masterId: "new", name: "保存時の名前", hourlyRate: 3500 };
    const changed = { ...data, casts: [{ id: "new", name: "現在の名前", hourlyRates: { "2026-09": 4000 } }], castCorrections: [{ sourceClosingId: "day", active: true, current: { ...draft, entries: [entry] } }] } as unknown as AccountingWorkspaceData;
    expect(castCorrectionPersonValues({ ...entry, businessDate: "2026-09-02" }, day, changed)).toEqual({ name: "保存時の名前", hourlyRate: 3500 });
  });
});
