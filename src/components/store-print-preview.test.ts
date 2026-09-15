import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { User } from "firebase/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DailyClosing } from "@/domain/gms";
import type { AccountingWorkspaceData } from "@/domain/month-accounting";
import { StoreWork } from "./store-work";

const harness = vi.hoisted(() => ({
  drafts: {} as Record<string, unknown>,
  states: [] as unknown[], stateIndex: 0,
  buttons: [] as Array<{ label: string; click: () => unknown }>,
  preview: null as null | { title: string; children: import("react").ReactNode; onClose: () => void },
  submit: vi.fn(), withdraw: vi.fn(), deleteClosing: vi.fn(),
}));

// DOMやFirebaseを使わず、実際の店舗ボタンによる状態変更をSSR間で検証する。
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useState<T>(initial: T | (() => T)) {
    const index = harness.stateIndex++;
    if (!(index in harness.states)) harness.states[index] = typeof initial === "function" ? (initial as () => T)() : initial;
    return [harness.states[index] as T, (next: T | ((previous: T) => T)) => {
      harness.states[index] = typeof next === "function" ? (next as (previous: T) => T)(harness.states[index] as T) : next;
    }];
  } };
});
vi.mock("./update-drafts", () => ({
  useRecoverableState<T>(key: string, initial: T | (() => T)) {
    if (!Object.hasOwn(harness.drafts, key)) harness.drafts[key] = typeof initial === "function" ? (initial as () => T)() : initial;
    return [harness.drafts[key] as T, (next: T | ((previous: T) => T)) => {
      harness.drafts[key] = typeof next === "function" ? (next as (previous: T) => T)(harness.drafts[key] as T) : next;
    }];
  },
  useUpdateDraftBusy() {},
}));
vi.mock("@/lib/firebase/repository", () => ({
  submitClosing: (...args: unknown[]) => harness.submit(...args),
  withdrawClosing: (...args: unknown[]) => harness.withdraw(...args),
  deleteUnapprovedClosing: (...args: unknown[]) => harness.deleteClosing(...args),
}));
vi.mock("./print-preview", async () => {
  const react = await import("react");
  return { PrintPreview(props: NonNullable<typeof harness.preview>) {
    harness.preview = props;
    return react.createElement("section", { "data-test-print-preview": true }, props.children);
  } };
});
vi.mock("./ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ui")>();
  const react = await import("react");
  const collect = (node: import("react").ReactNode) => {
    if (Array.isArray(node)) { node.forEach(collect); return; }
    if (!react.isValidElement<{ children?: import("react").ReactNode; onClick?: () => unknown }>(node)) return;
    if (node.type === "button" && typeof node.props.children === "string" && node.props.onClick) {
      harness.buttons.push({ label: node.props.children, click: node.props.onClick });
    }
    collect(node.props.children);
  };
  return { ...actual, Card(props: Parameters<typeof actual.Card>[0]) {
    collect(props.children);
    return react.createElement(actual.Card, props);
  } };
});

function closing(day: string, status: DailyClosing["status"] = "approved"): DailyClosing {
  return {
    id: `daily_${day.replaceAll("-", "")}`, businessDate: day, status,
    submissionId: `source-${day}`, checksum: "a".repeat(64), updatedAt: `${day}T20:00:00.000Z`,
    sales: { cashSales: 10000, cardSales: 5000, totalSales: 15000 },
    customers: { groupCount: 1, totalCustomers: 2 }, nominations: { honShimeiCount: 0, jonaiCount: 0 },
    casts: [], staffWork: [], drivers: [],
    expenses: [{ id: `expense-${day}`, category: "supplies", payee: `保存された支払先 ${day}`, amount: 1234 }],
    staffDailyPaymentTotal: 0, dispatchStaffPayment: 0, dispatchCastPayment: 0, dispatchFee: 0, liquorDeliveryAmount: 0,
    cash: { cashSales: 10000, cardSales: 5000, totalSales: 15000, cashFloat: 200000,
      expenseAndPaymentTotal: 1234, expectedClosingCash: 208766, actualClosingCash: 208766, cashProfit: 8766, difference: 0 },
    posSnapshot: {
      schema: "club-genesis-pos-closing", schemaVersion: 3, businessDate: day, status: "closed",
      sales: { cashSales: 10000, cardSales: 5000, totalSales: 15000 },
      customers: { groupCount: 1, totalCustomers: 2 }, nominations: { honShimeiCount: 0, jonaiCount: 0 },
      transactions: [], castSales: [], castWork: [], enteredCasts: [], exitedCasts: [], trialCasts: [],
      rosterSnapshot: { complete: true, capturedAt: `${day}T19:00:00+09:00`, casts: [] },
      lifecycleEvents: [], submissionId: `source-${day}`, generatedAt: `${day}T20:00:00.000Z`,
      checksumAlgorithm: "sha256", checksumCanonicalization: "recursive-key-sort-v1", checksum: "a".repeat(64),
    },
  };
}

const source: AccountingWorkspaceData = {
  casts: [], staff: [], drivers: [], introducers: [], liquor: [],
  closings: [closing("2026-09-02", "returned"), closing("2026-09-03")],
  adjustments: [], archivedCasts: [], archivedStaff: [], introducerEntryEvents: [], introducerDeletionCommits: [],
  introducerMonthEvents: [], monthStates: [], monthSnapshots: [], cashFloat: 200000,
};
const run = vi.fn(async () => true);
function render(data = source) {
  harness.stateIndex = 0;
  harness.buttons = [];
  harness.preview = null;
  return renderToStaticMarkup(createElement(StoreWork, { data, user: { uid: "print-preview-test" } as User, busy: false, run }));
}
function open(index: number) {
  const button = harness.buttons.filter((item) => item.label === "プレビュー")[index];
  expect(button).toBeDefined();
  button.click();
}
function selectedClosing() {
  const node = harness.preview?.children as import("react").ReactElement<{ closing: DailyClosing }> | undefined;
  return node?.props.closing;
}

beforeEach(() => {
  harness.drafts = { "store.workflowDirty": true, "store.workflow.new.cashRevisionReason": "入力途中の確認内容" };
  harness.states = []; harness.stateIndex = 0; harness.buttons = []; harness.preview = null;
  vi.clearAllMocks();
});

describe("店舗送信済みデータの印刷プレビュー操作", () => {
  it("各営業日のプレビューボタンを表示し、押す前は帳票を開かない", () => {
    const markup = render();
    expect(harness.buttons.filter((item) => item.label === "プレビュー")).toHaveLength(2);
    expect(harness.preview).toBeNull();
    expect(markup).not.toContain("popover-preview");
    expect(markup).not.toContain("data-test-print-preview");
  });

  it("押した営業日の保存済みデータだけを選択し、保存・状態変更は実行しない", () => {
    const original = structuredClone(source);
    render();
    const drafts = structuredClone(harness.drafts);
    open(1);
    const markup = render();
    expect(harness.preview?.title).toContain("2026-09-03");
    expect(selectedClosing()).toEqual(source.closings[1]);
    expect(markup).toContain("保存された支払先 2026-09-03");
    expect(harness.drafts).toEqual(drafts);
    expect(source).toEqual(original);
    expect(run).not.toHaveBeenCalled();
    expect(harness.submit).not.toHaveBeenCalled();
    expect(harness.withdraw).not.toHaveBeenCalled();
    expect(harness.deleteClosing).not.toHaveBeenCalled();
  });

  it("プレビューを閉じても新規入力の下書きを保持し、別の日付を開き直せる", () => {
    render();
    const drafts = structuredClone(harness.drafts);
    open(0); render();
    expect(selectedClosing()?.businessDate).toBe("2026-09-02");
    harness.preview!.onClose();
    render();
    expect(harness.preview).toBeNull();
    expect(harness.drafts).toEqual(drafts);
    open(1); render();
    expect(selectedClosing()?.businessDate).toBe("2026-09-03");
    expect(harness.drafts).toEqual(drafts);
    expect(run).not.toHaveBeenCalled();
  });

  it("再編集途中の入力もプレビューの開閉では破棄しない", () => {
    const editing = closing("2026-09-05", "returned");
    harness.drafts["store.editing"] = editing;
    harness.drafts[`store.workflow.${editing.id}.expenses`] = [{ id: "unsaved", category: "supplies", payee: "入力途中の経費", amount: 2468 }];
    render();
    const drafts = structuredClone(harness.drafts);
    open(0); render(); harness.preview!.onClose(); render();
    expect(harness.drafts).toEqual(drafts);
    expect(harness.drafts["store.editing"]).toEqual(editing);
  });

  it("閲覧中は選択時のスナップショットを保持し、再度開いた時に最新保存値へ切り替える", () => {
    render(); open(0); render();
    const updated = structuredClone(source);
    updated.closings[0].expenses[0].payee = "更新後の支払先";
    updated.closings[0].updatedAt = "2026-09-15T00:00:00.000Z";
    render(updated);
    expect(selectedClosing()?.expenses[0].payee).toBe("保存された支払先 2026-09-02");
    harness.preview!.onClose(); render(updated); open(0); render(updated);
    expect(selectedClosing()?.expenses[0].payee).toBe("更新後の支払先");
  });
});
