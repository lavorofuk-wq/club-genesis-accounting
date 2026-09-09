import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { User } from "firebase/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DailyCast, DailyClosing, DailyStaffWork, PosClosingV3 } from "@/domain/gms";
import type { AccountingWorkspaceData } from "@/domain/month-accounting";
import { StoreWork } from "./store-work";

const draft = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
  buttons: [] as Array<{ label: string; click: () => void }>,
}));

// 店舗画面の実イベントをSSR間で再描画する。Firebaseへの通信・書込みは行わない。
vi.mock("./update-drafts", () => ({
  useRecoverableState<T>(key: string, initial: T | (() => T)) {
    if (!Object.hasOwn(draft.values, key)) draft.values[key] = typeof initial === "function" ? (initial as () => T)() : initial;
    return [draft.values[key] as T, (next: T | ((value: T) => T)) => {
      draft.values[key] = typeof next === "function" ? (next as (value: T) => T)(draft.values[key] as T) : next;
    }];
  },
  useUpdateDraftBusy() {},
}));

vi.mock("./ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ui")>();
  const react = await import("react");
  const collect = (value: import("react").ReactNode) => {
    if (Array.isArray(value)) { value.forEach(collect); return; }
    if (!react.isValidElement<{ children?: import("react").ReactNode; onClick?: () => void }>(value)) return;
    if (value.type === "button" && value.props.onClick && typeof value.props.children === "string") {
      draft.buttons.push({ label: value.props.children, click: value.props.onClick });
    }
    collect(value.props.children);
  };
  return {
    ...actual,
    Card(props: Parameters<typeof actual.Card>[0]) {
      collect(props.children);
      return react.createElement(actual.Card, props);
    },
  };
});

const user = { uid: "hourly-payment-ui-test" } as User;
const businessDate = "2026-09-09";
const pos: PosClosingV3 = {
  schema: "club-genesis-pos-closing", schemaVersion: 3, businessDate, status: "closed",
  sales: { cashSales: 60000, cardSales: 0, totalSales: 60000 },
  customers: { groupCount: 0, totalCustomers: 0 }, nominations: { honShimeiCount: 0, jonaiCount: 0 },
  transactions: [], castSales: [], castWork: [], enteredCasts: [], exitedCasts: [], trialCasts: [],
  rosterSnapshot: { complete: true, capturedAt: `${businessDate}T19:00:00+09:00`, casts: [] },
  lifecycleEvents: [], submissionId: "hourly-submission", generatedAt: `${businessDate}T18:00:00.000Z`,
  checksumAlgorithm: "sha256", checksumCanonicalization: "recursive-key-sort-v1", checksum: "a".repeat(64),
};
const staff: DailyStaffWork = {
  staffId: "trial-staff", name: "体入スタッフ", kind: "trial", startTime: "20:00", endTime: "00:15",
  hours: 4.25, hourlyRate: 1507, dailyPayment: 6400,
};
const trialCast: DailyCast = {
  masterId: "trial-cast", posCastId: "pos-cast", name: "体入キャスト", kind: "trial",
  startTime: "20:00", endTime: "00:15", hours: 4.25, hourlyRate: 2007,
  honShimeiCount: 0, banaiShimeiCount: 0, dohanCount: 0, dohanBack: 0,
  honShimeiSales: 123450, jonaiExtensionSales: 45670, bottles: [],
  drinkSales: 0, drinkAllocations: [], liquorCost: 0, beautyAllowance: 0,
  dailyPayment: 8520, advancePayment: 321, transportFee: 500,
};
const data: AccountingWorkspaceData = {
  casts: [{ id: trialCast.masterId, name: trialCast.name, legalName: "", status: "trial", trialDate: businessDate,
    trialHourlyRate: 2007, hourlyRates: {}, note: "", createdAt: "", updatedAt: "" }],
  staff: [{ id: staff.staffId, name: staff.name, status: "trial", trialDate: businessDate,
    trialHourlyRate: staff.hourlyRate, note: "", createdAt: "", updatedAt: "" }],
  drivers: [], introducers: [], liquor: [], closings: [], adjustments: [],
  archivedCasts: [], archivedStaff: [], introducerEntryEvents: [], introducerDeletionCommits: [],
  introducerMonthEvents: [], monthStates: [], monthSnapshots: [], cashFloat: 200000,
};

function closing(patch: Partial<DailyClosing> = {}): DailyClosing {
  return {
    id: "daily_20260909", businessDate, status: "returned", submissionId: pos.submissionId,
    checksum: pos.checksum, sales: pos.sales, customers: pos.customers, nominations: pos.nominations,
    casts: [], staffWork: [staff], drivers: [], expenses: [], staffDailyPaymentTotal: staff.dailyPayment,
    dispatchStaffPayment: 0, dispatchCastPayment: 0, dispatchFee: 0, liquorDeliveryAmount: 0,
    cash: { ...pos.sales, cashFloat: 200000, expenseAndPaymentTotal: staff.dailyPayment,
      expectedClosingCash: 253600, cashProfit: 53600, actualClosingCash: 253600, difference: 0 },
    posSnapshot: pos, updatedAt: "2026-09-09T18:00:00.000Z", ...patch,
  };
}

function workflow(values: Record<string, unknown>, source?: DailyClosing) {
  if (source) draft.values["store.editing"] = source;
  const prefix = `store.workflow.${source?.id || "new"}`;
  Object.entries(values).forEach(([key, value]) => { draft.values[`${prefix}.${key}`] = value; });
  return prefix;
}

function render(source = data) {
  draft.buttons = [];
  const run = vi.fn(async () => true);
  const markup = renderToStaticMarkup(createElement(StoreWork, { data: source, user, busy: false, run }));
  expect(run).not.toHaveBeenCalled();
  return markup;
}

function click(label: string, index = 0) {
  const target = draft.buttons.filter((button) => button.label === label)[index];
  expect(target, `「${label}」ボタンがある`).toBeDefined();
  target.click();
}

function trialPos(): PosClosingV3 {
  return { ...pos, castWork: [{ castId: trialCast.posCastId, castName: trialCast.name, castType: "trial", isTrial: true,
    startTime: "20:00", endTime: "00:15", hours: 4.25, breakMinutes: 0 }] };
}

beforeEach(() => { draft.values = {}; draft.buttons = []; });

describe("店舗の時給1円単位と支払実績保全", () => {
  it("新規の体入スタッフ即日額は日別時給額の1円未満を切り捨てる", () => {
    const prefix = workflow({ stage: "details", pos, staffId: staff.staffId, staffStart: "20:00", staffEnd: "00:15" });
    render();
    click("追加");
    expect(draft.values[`${prefix}.staffWork`]).toEqual([{ ...staff, dailyPayment: 6404 }]);
  });

  it("再編集中でも元の記録にいない体入スタッフは1円単位で初期計算する", () => {
    const source = closing({ staffWork: [] });
    const prefix = workflow({ staffId: staff.staffId, staffStart: "20:00", staffEnd: "00:15" }, source);
    render();
    click("追加");
    expect(draft.values[`${prefix}.staffWork`]).toEqual([{ ...staff, dailyPayment: 6404 }]);
  });

  it.each([6400, 6404])("体入スタッフの再編集で保存済み日払い%d円を丸め直さない", (dailyPayment) => {
    const source = closing({ staffWork: [{ ...staff, dailyPayment }] });
    const before = structuredClone(source);
    const prefix = workflow({}, source);
    const markup = render();
    expect((draft.values[`${prefix}.staffWork`] as DailyStaffWork[])[0].dailyPayment).toBe(dailyPayment);
    expect(markup).toContain("保存済みの日払い額を保持");
    expect(draft.values[`${prefix}.actualCash`]).toBe(0);
    expect(source).toEqual(before);
  });

  it("保存済みスタッフの勤務を追加し直しても、現在入力中の日払い修正額を保持する", () => {
    const source = closing();
    const prefix = workflow({ staffId: staff.staffId, staffStart: "20:00", staffEnd: "01:15",
      staffWork: [{ ...staff, dailyPayment: 6001 }] }, source);
    render();
    click("追加");
    expect((draft.values[`${prefix}.staffWork`] as DailyStaffWork[])[0]).toMatchObject({ hours: 5.25, dailyPayment: 6001 });
  });

  it("保存済みスタッフを削除して再追加しても、元の記録済み日払いへ戻せる", () => {
    const source = closing();
    const prefix = workflow({ staffId: staff.staffId, staffStart: "20:00", staffEnd: "01:15", staffWork: [] }, source);
    render();
    click("追加");
    expect((draft.values[`${prefix}.staffWork`] as DailyStaffWork[])[0]).toMatchObject({ hours: 5.25, dailyPayment: 6400 });
  });

  it("体入キャスト日払いは1円入力を許容し、現金照合へ進んでも既存整数額を変えない", () => {
    const prefix = workflow({ stage: "details", pos: trialPos(), mapping: { "pos-cast": "trial-cast" },
      castRows: [{ ...trialCast, dailyPayment: 8529 }], actualCash: 251471 });
    const markup = render();
    expect(markup).toMatch(/<input[^>]*step="1"[^>]*value="8529"/);
    click("店舗データを確認して現金照合へ");
    expect((draft.values[`${prefix}.castRows`] as DailyCast[])[0]).toMatchObject({ dailyPayment: 8529, honShimeiSales: 123450, jonaiExtensionSales: 45670, advancePayment: 321, transportFee: 500 });
    expect(draft.values[`${prefix}.actualCash`]).toBe(251471);
    expect(draft.values[`${prefix}.stage`]).toBe("cash");
  });

  it("再編集JSON照合は体入キャストの旧10円支払額を新しい1円初期額へ置換しない", () => {
    const source = closing({ casts: [trialCast], staffWork: [], posSnapshot: trialPos() });
    const prefix = workflow({ stage: "json" }, source);
    render();
    click("照合を確定して店舗データ作成へ");
    expect((draft.values[`${prefix}.castRows`] as DailyCast[])[0].dailyPayment).toBe(8520);
    expect(draft.values[`${prefix}.actualCash`]).toBe(0);
  });

  it("新規未送信の体入キャスト自動初期額は、照合時に最新時給で1円単位へ再算出する", () => {
    const prefix = workflow({ stage: "json", pos: trialPos(), mapping: { "pos-cast": "trial-cast" },
      castRows: [{ ...trialCast, hourlyRate: 2000, dailyPayment: 8500 }], castRowsSourcePos: trialPos() });
    render();
    click("照合を確定して店舗データ作成へ");
    expect((draft.values[`${prefix}.castRows`] as DailyCast[])[0].dailyPayment).toBe(8529);
  });
});
