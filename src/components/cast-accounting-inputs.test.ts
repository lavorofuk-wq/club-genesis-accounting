import { createElement, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CastAccountingInput, DailyClosing } from "@/domain/gms";
import type { AccountingWorkspaceData } from "@/domain/month-accounting";

const drafts = vi.hoisted(() => new Map<string, unknown>());
const production = vi.hoisted(() => ({ value: false }));
vi.mock("./update-drafts", () => ({
  useRecoverableState: <T,>(key: string, initial: T | (() => T)) => useState<T>(() => drafts.has(key) ? drafts.get(key) as T : typeof initial === "function" ? (initial as () => T)() : initial),
}));
vi.mock("@/lib/firebase/client", () => ({ isProductionEnvironment: () => production.value }));
vi.mock("@/lib/firebase/repository", () => ({ saveCastAccountingInputs: vi.fn() }));
import { CastAccountingInputs, castInputSourceKey } from "./cast-accounting-inputs";

const month = "2026-09";
function fixture(): AccountingWorkspaceData {
  const cast = (id: string, name: string, status: "active" | "departed" | "trial") => ({
    id, name, legalName: "", status, hiredAt: month + "-01", hourlyRates: { [month]: 3000 }, note: "", createdAt: "", updatedAt: "",
  });
  const day = (day: string, status: DailyClosing["status"]): DailyClosing => ({
    id: "day_" + day, businessDate: month + "-" + day, status, updatedAt: "initial",
    checksum: "a".repeat(64), submissionId: "submission_" + day,
    posSnapshot: {
      schema: "club-genesis-pos-closing", schemaVersion: 3, businessDate: month + "-" + day, status: "closed",
      sales: { cashSales: 0, cardSales: 0, totalSales: 0 }, customers: { groupCount: 0, totalCustomers: 0 },
      nominations: { honShimeiCount: 0, jonaiCount: 0 }, transactions: [], castSales: [], castWork: [],
      enteredCasts: [], exitedCasts: [], trialCasts: [], lifecycleEvents: [],
      rosterSnapshot: { complete: false, capturedAt: "", casts: [] }, submissionId: "submission_" + day,
      generatedAt: "", checksumAlgorithm: "sha256", checksumCanonicalization: "recursive-key-sort-v1", checksum: "a".repeat(64),
    },
    casts: ["cast1", "retired"].map((id) => ({
      masterId: id, posCastId: "pos_" + id, name: id === "cast1" ? "在籍花子" : "退店ゆり", kind: "regular",
      startTime: "20:00", endTime: "00:00", hours: 4, hourlyRate: 3000, honShimeiSales: 0, jonaiExtensionSales: 0,
      honShimeiCount: 0, banaiShimeiCount: 0, dohanCount: 0, dohanBack: 0, drinkSales: 0, bottles: [], liquorCost: 0,
      beautyAllowance: 0, dailyPayment: 0, advancePayment: 0, transportFee: 0,
    })),
    staffWork: [], drivers: [], expenses: [], staffDailyPaymentTotal: 0, dispatchCastPayment: 0, dispatchStaffPayment: 0, dispatchFee: 0, liquorDeliveryAmount: 0,
    sales: { cashSales: 0, cardSales: 0, totalSales: 0 }, customers: { groupCount: 0, totalCustomers: 0 }, nominations: { honShimeiCount: 0, jonaiCount: 0 },
    cash: { cashFloat: 200000, cashSales: 0, cardSales: 0, totalSales: 0, expenseAndPaymentTotal: 0, cashProfit: 0, expectedClosingCash: 200000, actualClosingCash: 200000, difference: 0 },
  });
  return {
    casts: [cast("cast1", "在籍花子", "active"), cast("no_work", "出勤なし", "active"), cast("retired", "退店ゆり", "departed"), cast("trial", "体入のみ", "trial")],
    staff: [], drivers: [], introducers: [], liquor: [], closings: [day("01", "approved"), day("03", "approved"), day("05", "returned")],
    cashFloat: 200000, archivedCasts: [], archivedStaff: [], introducerEntryEvents: [], introducerDeletionCommits: [], introducerMonthEvents: [], monthStates: [], monthSnapshots: [],
    adjustments: [{ month, revision: 2, withholdingByCast: {}, staffSalesAllowance: {}, staffBottleAllowance: {}, driverRemoteAllowance: {}, fixedExpenses: [], cardFee: 0 }],
  };
}
const input: CastAccountingInput = { id: "entry1", castId: "cast1", castName: "在籍花子", kind: "sales", label: "イベント売上", amount: 35000, businessDate: month + "-01" };
const render = (data = fixture()) => renderToStaticMarkup(createElement(CastAccountingInputs, { data, user: { uid: "accountant" } as never, busy: false, run: vi.fn(async () => true) }));
function recover(data: AccountingWorkspaceData, row = input, amountText = String(row.amount)) {
  drafts.set("accounting.castInputs.selected", row.castId);
  drafts.set("accounting.castInputs.editing", { input: row, amountText, revision: 2, context: castInputSourceKey(data, month) });
}
beforeEach(() => { drafts.clear(); drafts.set("accounting.castInputs.month", month); production.value = false; });

describe("キャストデータ入力の表示・入力保護", () => {
  it("常設の全員ボタンを描画せず選択モーダルへの入口を表示する", () => {
    const html = render();
    expect(html).not.toContain("在籍花子");
    expect(html).not.toContain("出勤なし");
    expect(html).toContain("キャストを選ぶ");
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).not.toContain("体入のみ");
    expect(html).not.toContain("退店ゆり");
    expect(html).toContain("入力済みキャスト一覧");
  });
  it("キャスト選択後に売上・手当・送迎の入力を分けて表示する", () => {
    drafts.set("accounting.castInputs.selected", "cast1");
    const html = render();
    for (const label of ["売上入力", "手当入力", "送迎入力"]) expect(html).toContain(label);
    expect(html).not.toContain('type="time"');
  });
  it("売上は10円未満切捨の反映額と本人の承認済み日付を表示する", () => {
    const data = fixture(); recover(data, input, "35007");
    const html = render(data);
    expect(html).toContain('value="35007"');
    expect(html).toContain("￥35,000");
    expect(html).toContain('value="2026-09-03"');
    expect(html).not.toContain('value="2026-09-05"');
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>この入力を保存/);
  });
  it.each([["allowance", "100.5", "1円未満"], ["transport", "1200", "500円単位"]] as const)("不正な%sの単位を勝手に丸めず保存不可にする", (kind, amount, error) => {
    const data = fixture(); recover(data, { ...input, kind, businessDate: undefined }, amount);
    const html = render(data);
    expect(html).toContain(error);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>この入力を保存/);
  });
  it("手当の日付未指定は本人の最終承認済み出勤日を表示する", () => {
    const data = fixture(); recover(data, { ...input, kind: "allowance", businessDate: undefined }, "1001");
    const html = render(data);
    expect(html).toContain("計上日 2026-09-03");
    expect(html).toContain("￥1,001");
  });
  it("差戻し中の日付を指定した入力は理由を示して保存を停止する", () => {
    const data = fixture(); recover(data, { ...input, businessDate: month + "-05" });
    const html = render(data);
    expect(html).toContain("本人の当月承認済み出勤日ではありません");
    expect(html).toContain("現在は対象外");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>この入力を保存/);
  });
  it("差戻しで複数の日付が無効になっても他行を保持しながら1件ずつ修復できる", () => {
    const data = fixture();
    const first = { ...input, label: "先に直す売上", businessDate: month + "-05" };
    const second = { ...input, id: "entry2", label: "次に直す売上", businessDate: month + "-05" };
    data.adjustments[0].castInputs = [first, second];
    recover(data, { ...first, businessDate: month + "-01" });
    const firstMarkup = render(data);
    expect(firstMarkup).toContain("次に直す売上");
    expect(firstMarkup).toContain("本人の当月承認済み出勤日ではありません");
    expect(firstMarkup).toContain("計上日 2026-09-01");
    expect(firstMarkup).not.toMatch(/<button[^>]*disabled[^>]*>この入力を保存/);
    expect(data.adjustments[0].castInputs[1]).toEqual(second);

    data.adjustments[0].castInputs[0] = { ...first, businessDate: month + "-01" };
    recover(data, { ...second, businessDate: month + "-03" });
    const secondMarkup = render(data);
    expect(secondMarkup).toContain("計上日 2026-09-03");
    expect(secondMarkup).not.toMatch(/<button[^>]*disabled[^>]*>この入力を保存/);
    expect(data.adjustments[0].castInputs[0].businessDate).toBe(month + "-01");
  });
  it("他行の出勤警告を許容しても全件合計の安全範囲超過は保存できない", () => {
    const data = fixture();
    data.adjustments[0].castInputs = [{ ...input, id: "existing", kind: "allowance", amount: Number.MAX_SAFE_INTEGER }];
    recover(data, { ...input, kind: "allowance", amount: 1 }, "1");
    const html = render(data);
    expect(html).toContain("合計金額が処理可能な範囲を超えています");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>この入力を保存/);
  });
  it("別操作で月次版が変わっても未保存の名目・金額を消さず警告する", () => {
    const data = fixture(); recover(data, { ...input, label: "退避中の名目" }, "99999");
    data.adjustments[0].revision = 3;
    const html = render(data);
    expect(html).toContain("参照データが更新されています");
    expect(html).toContain('value="退避中の名目"');
    expect(html).toContain('value="99999"');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>この入力を保存/);
  });
  it("退店後も保存名と明細を残し、変更を禁止して削除だけ可能にする", () => {
    const data = fixture();
    data.adjustments[0].castInputs = [{ ...input, castId: "retired", castName: "保存時ゆり" }];
    drafts.set("accounting.castInputs.selected", "retired");
    const html = render(data);
    expect(html).toContain("保存時ゆり（在籍外）");
    expect(html).toContain("イベント売上");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>編集/);
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>削除/);
  });
  it.each(["closing", "closed"] as const)("月次%sでは編集・削除を止めて明細を表示する", (status) => {
    const data = fixture(); data.adjustments[0].castInputs = [input];
    drafts.set("accounting.castInputs.selected", "cast1");
    data.monthStates = [{ month, status, revision: 1, updatedAt: "", updatedBy: "" }];
    if (status === "closed") {
      data.monthStates[0].currentSnapshotRevision = 1;
      data.monthSnapshots = [{ month, revision: 1, castSalesReports: [{ totals: { accountingInputs: [input] } }] } as unknown as AccountingWorkspaceData["monthSnapshots"][number]];
    }
    const html = render(data);
    expect(html).toContain("イベント売上");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>編集/);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>削除/);
  });
  it("確定月は現在の出勤・マスタを失っても確定時の名目と計上日を表示する", () => {
    const data = fixture();
    data.monthStates = [{ month, status: "closed", revision: 1, currentSnapshotRevision: 1, updatedAt: "", updatedBy: "" }];
    data.monthSnapshots = [{ month, revision: 1, castSalesReports: [{ totals: { accountingInputs: [{ ...input, kind: "allowance", label: "確定時手当", businessDate: month + "-03" }] } }] } as unknown as AccountingWorkspaceData["monthSnapshots"][number]];
    data.casts = []; data.closings = [];
    drafts.set("accounting.castInputs.selected", "cast1");
    const html = render(data);
    expect(html).toContain("確定時手当");
    expect(html).toContain("2026-09-03");
    expect(html).not.toContain("承認済み出勤がありません");
    expect(html).toContain("￥35,000");
  });
  it("本番では入力画面を描画しない", () => {
    production.value = true;
    const html = render();
    expect(html).toContain("開発環境で確認中");
    expect(html).not.toContain('type="month"');
    expect(html).not.toContain("在籍花子");
  });
});
