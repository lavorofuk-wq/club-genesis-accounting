import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { User } from "firebase/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DailyCast, DailyClosing, PosClosingV3 } from "@/domain/gms";
import type { AccountingWorkspaceData } from "@/domain/month-accounting";
import { StoreWork } from "./store-work";

const drafts = vi.hoisted(() => ({ values: {} as Record<string, unknown>, keys: [] as string[], busyKeys: [] as string[] }));

// 保存媒体・消費タイミングはprovider側で検証し、ここでは店舗の登録と復元後の描画を検証する。
vi.mock("./update-drafts", async () => {
  const { useState } = await import("react");
  return {
    useRecoverableState<T>(key: string, initial: T | (() => T)) {
      drafts.keys.push(key);
      return useState<T>(() => Object.hasOwn(drafts.values, key)
        ? drafts.values[key] as T
        : typeof initial === "function" ? (initial as () => T)() : initial);
    },
    useUpdateDraftBusy(key: string) { drafts.busyKeys.push(key); },
  };
});

const user = { uid: "draft-test-user" } as User;
const businessDate = "2026-09-02";
const cast: DailyCast = {
  masterId: "cast-1", posCastId: "pos-1", name: "復元キャスト", kind: "regular",
  startTime: "20:00", endTime: "02:00", hours: 6, hourlyRate: 3000,
  honShimeiCount: 2, banaiShimeiCount: 1, dohanCount: 1, dohanBack: 3000,
  honShimeiSales: 123450, jonaiExtensionSales: 45670, bottles: [],
  drinkSales: 0, drinkAllocations: [], liquorCost: 0, beautyAllowance: 500,
  dailyPayment: 1234, advancePayment: 2345, transportFee: 1500,
};
const pos: PosClosingV3 = {
  schema: "club-genesis-pos-closing", schemaVersion: 3, businessDate, status: "closed",
  sales: { cashSales: 60000, cardSales: 40000, totalSales: 100000 },
  customers: { groupCount: 2, totalCustomers: 3 }, nominations: { honShimeiCount: 2, jonaiCount: 1 },
  transactions: [], castSales: [],
  castWork: [{ castId: "pos-1", castName: cast.name, castType: "regular", isTrial: false,
    startTime: "20:00", endTime: "02:00", hours: 6, breakMinutes: 0 }],
  enteredCasts: [], exitedCasts: [], trialCasts: [],
  rosterSnapshot: { complete: true, capturedAt: `${businessDate}T19:00:00+09:00`, casts: [] },
  lifecycleEvents: [], submissionId: "pos-submission", generatedAt: `${businessDate}T18:00:00.000Z`,
  checksumAlgorithm: "sha256", checksumCanonicalization: "recursive-key-sort-v1", checksum: "a".repeat(64),
};
const closing: DailyClosing = {
  id: "daily_20260902", businessDate, status: "returned", submissionId: pos.submissionId,
  checksum: pos.checksum, sales: pos.sales, customers: pos.customers, nominations: pos.nominations,
  casts: [cast], staffWork: [], drivers: [], expenses: [], staffDailyPaymentTotal: 0,
  dispatchStaffPayment: 0, dispatchCastPayment: 0, dispatchFee: 0, liquorDeliveryAmount: 0,
  cash: { ...pos.sales, cashFloat: 200000, expenseAndPaymentTotal: 1234,
    expectedClosingCash: 258766, cashProfit: 58766, actualClosingCash: 258766, difference: 0 },
  posSnapshot: pos, updatedAt: "2026-09-03T01:23:45.000Z",
};
const data: AccountingWorkspaceData = {
  casts: [{ id: cast.masterId, name: cast.name, legalName: "", status: "active", hiredAt: "2026-09-01",
    hourlyRates: { "2026-09": 3000 }, note: "", createdAt: "", updatedAt: "" }],
  staff: [], drivers: [], introducers: [], liquor: [], closings: [], adjustments: [],
  archivedCasts: [], archivedStaff: [], introducerEntryEvents: [], introducerDeletionCommits: [],
  introducerMonthEvents: [], monthStates: [], monthSnapshots: [], cashFloat: 200000,
};

function render(source = data) {
  const run = vi.fn(async () => true);
  const markup = renderToStaticMarkup(createElement(StoreWork, { data: source, user, busy: false, run }));
  expect(run).not.toHaveBeenCalled();
  return markup;
}

function restoreWorkflow(id: string, values: Record<string, unknown>) {
  Object.entries(values).forEach(([key, value]) => { drafts.values[`store.workflow.${id}.${key}`] = value; });
}

beforeEach(() => { drafts.values = {}; drafts.keys = []; drafts.busyKeys = []; });

describe("店舗フォームの更新時入力退避", () => {
  it("親の再編集対象と全入力を登録し、読込中・エラーは退避しない", () => {
    render();
    expect(drafts.keys).toEqual([
      "store.editing", "store.workflowDirty",
      ...["stage", "pos", "mapping", "allowInitialSnapshotMapping", "specialCosts", "castRows",
        "castRowsSourcePos", "unmatchedCastDrafts", "staffWork", "staffId", "staffStart", "staffEnd",
        "driverWork", "expenses", "expenseCategory", "expensePayee", "expensePersonId", "expenseAmount",
        "dispatchStaffPayment", "dispatchCastPayment", "dispatchFee", "liquorDeliveryAmount", "cashFloat", "actualCash"]
        .map((field) => `store.workflow.new.${field}`),
    ]);
    expect(drafts.busyKeys).toEqual(["store.workflow.new.jsonReading"]);
  });

  it("POS原本と手入力を復元してJSONファイルの再選択なしに店舗データを表示する", () => {
    restoreWorkflow("new", {
      stage: "details", pos, mapping: { "pos-1": "cast-1" }, castRows: [cast], castRowsSourcePos: pos,
      staffWork: [{ staffId: "staff-1", name: "復元スタッフ", kind: "regular", startTime: "21:00", endTime: "03:00", hours: 6, hourlyRate: 2000, dailyPayment: 3456 }],
      driverWork: [{ driverId: "driver-1", name: "復元ドライバー", dailyRate: 8000, dailyPayment: 4567 }],
      expenses: [{ id: "expense-1", category: "supplies", payee: "復元支払先", amount: 5678 }],
      staffStart: "21:15", staffEnd: "03:30", expensePayee: "追加前の支払先", expenseAmount: 6789,
      dispatchStaffPayment: 1111, dispatchCastPayment: 2222, dispatchFee: 3333, liquorDeliveryAmount: 4444,
    });
    const markup = render();
    expect(markup).not.toContain('type="file"');
    for (const text of [cast.name, "復元スタッフ", "復元ドライバー", "復元支払先", "追加前の支払先"]) {
      expect(markup).toContain(text);
    }
    for (const value of ["123450", "45670", "1234", "2345", "1500", "3456", "4567", "6789", "1111", "2222", "3333", "4444", "21:15", "03:30"]) {
      expect(markup).toContain(`value="${value}"`);
    }
  });

  it("再編集対象と同じキーのプレビューを復元し、新規下書きの金額を混ぜない", () => {
    drafts.values["store.editing"] = closing;
    drafts.values["store.workflowDirty"] = true;
    restoreWorkflow("new", { stage: "details", actualCash: 999999 });
    restoreWorkflow(closing.id, { stage: "preview", actualCash: 234567, cashFloat: 210000 });
    const markup = render();
    expect(markup).toContain(`${businessDate} 再編集`);
    expect(markup).toContain("234,567");
    expect(markup).toContain("確認済み・経理へ送信");
    expect(markup).not.toContain("999,999");
    expect(drafts.keys).not.toContain("store.workflow.new.stage");
    expect(drafts.values["store.editing"]).toMatchObject({ updatedAt: closing.updatedAt });
  });

  it("復元後も最新マスタとの照合を維持し、削除された新規キャストを送信可能にしない", () => {
    restoreWorkflow("new", { stage: "json", pos, mapping: { "pos-1": "deleted-cast" }, castRows: [cast] });
    const markup = render();
    expect(markup).toContain("選択済みデータが現在の営業日・名前・区分と一致しません");
    expect(markup).toMatch(/<button[^>]*disabled[^>]*>照合を確定して店舗データ作成へ/);
  });

  it("復元前に月次確定された営業日は再編集せず入力を保持する", () => {
    drafts.values["store.editing"] = closing;
    restoreWorkflow(closing.id, { stage: "details", castRows: [cast] });
    const markup = render({ ...data, monthStates: [{ month: "2026-09", status: "closed", revision: 1, updatedAt: "", updatedBy: "accounting" }] });
    expect(markup).toContain("この営業日は編集できません");
    expect(markup).not.toContain("キャスト出勤・売上・手当控除");
    expect(drafts.values[`store.workflow.${closing.id}.castRows`]).toEqual([cast]);
  });
});
