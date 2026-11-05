import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { User } from "firebase/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DailyCast, DailyClosing } from "@/domain/gms";
import type { AccountingWorkspaceData } from "@/domain/month-accounting";
import { DailyPreview, StoreWork } from "./store-work";
import { projectDailyWorkAllowances } from "@/domain/daily-work-allowance-preview";

const harness = vi.hoisted(() => ({
  drafts: {} as Record<string, unknown>,
  states: [] as unknown[], stateIndex: 0,
  buttons: [] as Array<{ label: string; click: () => unknown }>,
  checks: [] as Array<{ disabled?: boolean; checked?: boolean; change: (event: { target: { checked: boolean } }) => unknown }>,
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
    if (!react.isValidElement<{ children?: import("react").ReactNode; onClick?: () => unknown; type?: string; disabled?: boolean; checked?: boolean; onChange?: (event: { target: { checked: boolean } }) => unknown }>(node)) return;
    if (node.type === "button" && typeof node.props.children === "string" && node.props.onClick) {
      harness.buttons.push({ label: node.props.children, click: node.props.onClick });
    }
    if (node.type === "input" && node.props.type === "checkbox" && node.props.onChange) {
      harness.checks.push({ disabled: node.props.disabled, checked: node.props.checked, change: node.props.onChange });
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
  harness.checks = [];
  harness.preview = null;
  return renderToStaticMarkup(createElement(StoreWork, { data, user: { uid: "print-preview-test" } as User, busy: false, run }));
}
function open(index: number) {
  const button = harness.buttons.filter((item) => item.label === "プレビュー")[index];
  expect(button).toBeDefined();
  button.click();
}
function selectedClosing() {
  const node = harness.preview?.children as import("react").ReactElement<Parameters<typeof DailyPreview>[0]> | undefined;
  return node?.props.closing;
}
function previewMarkup() {
  expect(harness.preview).not.toBeNull();
  return renderToStaticMarkup(harness.preview!.children);
}
function castCells(markup: string) {
  const table = markup.split("<h3>キャスト</h3>")[1].split("<h3>スタッフ</h3>")[0];
  const row = table.match(/<tbody><tr>([\s\S]*?)<\/tr>/)?.[1];
  expect(row).toBeDefined();
  return [...row!.matchAll(/<td(?: [^>]*)?>([\s\S]*?)<\/td>/g)].map((cell) => cell[1]);
}
function allowanceFixture(beautyAllowance = 0, transportFee = 0): AccountingWorkspaceData {
  const data = structuredClone(source);
  const day = closing("2026-09-03", "submitted");
  const cast: DailyCast = {
    masterId: "cast-preview", posCastId: "pos-preview", name: "表示キャスト", kind: "regular",
    startTime: "20:00", endTime: "02:00", hours: 6, hourlyRate: 3000,
    honShimeiCount: 1, banaiShimeiCount: 2, dohanCount: 0, dohanBack: 0,
    honShimeiSales: 10000, jonaiExtensionSales: 2000, drinkSales: 0, drinkAllocations: [], bottles: [], liquorCost: 0,
    beautyAllowance, transportFee, dailyPayment: 1111, advancePayment: 2222,
  };
  day.casts = [cast];
  data.closings = [day];
  data.casts = [{ id: cast.masterId, name: cast.name, legalName: "", status: "active", hiredAt: "2026-09-01", hourlyRates: { "2026-09": 3000 }, note: "", createdAt: "", updatedAt: "" }];
  return data;
}
function registerAllowances(data: AccountingWorkspaceData, eligible: boolean, amount: number) {
  const day = data.closings[0], cast = day.casts[0], month = day.businessDate.slice(0, 7);
  data.beautyMonths = { [month]: { revision: (data.beautyMonths?.[month]?.revision || 0) + 1, casts: {
    [cast.masterId]: { [day.businessDate]: { eligible, attendanceClosingId: day.id, attendanceIndex: 0, attendancePosCastId: cast.posCastId } },
  } } };
  data.transportMonths = { [month]: { revision: (data.transportMonths?.[month]?.revision || 0) + 1, casts: {
    [cast.masterId]: { [day.businessDate]: { amount, attendanceClosingId: day.id, attendanceIndex: 0, legacyInputIds: [] } },
  }, drivers: {} } };
}

beforeEach(() => {
  harness.drafts = { "store.workflowDirty": true, "store.workflow.new.cashRevisionReason": "入力途中の確認内容" };
  harness.states = []; harness.stateIndex = 0; harness.buttons = []; harness.checks = []; harness.preview = null;
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

describe("店舗プレビューの美容室手当・送迎代", () => {
  it("未承認の日次にも別登録額を表示し、現金・経費・日払い・元データ・下書きを変更しない", () => {
    const data = allowanceFixture();
    registerAllowances(data, true, 1500);
    const original = structuredClone(data);
    render(data);
    const drafts = structuredClone(harness.drafts);
    open(0); render(data);
    const markup = previewMarkup();
    const cells = castCells(markup);
    const baseline = renderToStaticMarkup(createElement(DailyPreview, { closing: data.closings[0] }));
    const baselineCells = castCells(baseline);
    expect(cells[9]).toBe("￥500");
    expect(cells[12]).toBe("￥1,500");
    cells.forEach((value, index) => { if (index !== 9 && index !== 12) expect(value).toBe(baselineCells[index]); });
    expect(markup.match(/<tr class="total-row">([\s\S]*?)<\/tr>/)?.[1]).toContain("<td>1人</td>");
    expect(markup.slice(markup.indexOf("<h3>スタッフ</h3>"))).toBe(baseline.slice(baseline.indexOf("<h3>スタッフ</h3>")));
    expect(selectedClosing()).toBe(data.closings[0]);
    expect(harness.drafts).toEqual(drafts);
    expect(data).toEqual(original);
    expect(run).not.toHaveBeenCalled();
    expect(harness.submit).not.toHaveBeenCalled();
    expect(harness.withdraw).not.toHaveBeenCalled();
    expect(harness.deleteClosing).not.toHaveBeenCalled();
  });

  it("閲覧中の金額だけは最新登録へ追従し、日次原本と下書きは選択時のまま保持する", () => {
    const data = allowanceFixture();
    render(data); open(0); render(data);
    const drafts = structuredClone(harness.drafts);
    const original = structuredClone(data);
    expect(castCells(previewMarkup())[9]).toBe("￥0");
    const updated = structuredClone(data);
    registerAllowances(updated, true, 2000);
    updated.closings[0].expenses[0].payee = "後から更新した支払先";
    updated.closings[0].cash.expectedClosingCash = 201234;
    updated.closings[0].updatedAt = "2026-09-15T00:00:00.000Z";
    render(updated);
    expect(castCells(previewMarkup())[9]).toBe("￥500");
    expect(castCells(previewMarkup())[12]).toBe("￥2,000");
    expect(selectedClosing()).toBe(data.closings[0]);
    expect(previewMarkup()).toContain("保存された支払先 2026-09-03");
    expect(previewMarkup()).not.toContain("後から更新した支払先");
    expect(selectedClosing()?.cash).toEqual(original.closings[0].cash);
    registerAllowances(updated, false, 0);
    render(updated);
    expect(castCells(previewMarkup())[9]).toBe("￥0");
    expect(castCells(previewMarkup())[12]).toBe("￥0");
    expect(harness.drafts).toEqual(drafts);
    expect(data).toEqual(original);
    expect(run).not.toHaveBeenCalled();
  });

  it("否・送迎0円を旧日次の金額より優先し、美容室人数も表示額と一致させる", () => {
    const data = allowanceFixture(500, 1500);
    registerAllowances(data, false, 0);
    render(data); open(0); render(data);
    const markup = previewMarkup();
    expect(castCells(markup)[9]).toBe("￥0");
    expect(castCells(markup)[12]).toBe("￥0");
    expect(markup.match(/<tr class="total-row">([\s\S]*?)<\/tr>/)?.[1]).toContain("<td>0人</td>");
    expect(selectedClosing()?.casts[0]).toMatchObject({ beautyAllowance: 500, transportFee: 1500 });
  });

  it("人物・出勤根拠の不一致は金額0円と区別して要確認を表示する", () => {
    const data = allowanceFixture(500, 1000);
    registerAllowances(data, true, 1500);
    data.beautyMonths!["2026-09"].casts["cast-preview"]["2026-09-03"].attendancePosCastId = "different-pos-person";
    data.transportMonths!["2026-09"].casts["cast-preview"]["2026-09-03"].attendanceIndex = 9;
    render(data); open(0); render(data);
    const markup = previewMarkup();
    expect(castCells(markup)[9]).toBe("要確認");
    expect(castCells(markup)[12]).toBe("要確認");
    expect(markup).toContain("美容室手当・送迎代の要確認事項");
    expect(markup).toContain('role="alert"');
    expect(markup.match(/<tr class="total-row">([\s\S]*?)<\/tr>/)?.[1]).toContain("<td>要確認</td>");
    expect(selectedClosing()?.casts[0]).toMatchObject({ beautyAllowance: 500, transportFee: 1000 });
  });

  it("送信前の新規プレビューへ既存出勤の登録額を推測で転記しない", () => {
    const data = allowanceFixture();
    registerAllowances(data, true, 1500);
    const draft = { ...structuredClone(data.closings[0]), id: "preview", submissionId: "new-submission", checksum: "b".repeat(64) };
    const original = structuredClone(draft);
    const allowancePreview = projectDailyWorkAllowances(data, draft);
    const markup = renderToStaticMarkup(createElement(DailyPreview, { closing: draft, allowancePreview }));
    expect(castCells(markup)[9]).toBe("要確認");
    expect(castCells(markup)[12]).toBe("要確認");
    expect(markup).toContain("美容室手当・送迎代の要確認事項");
    expect(draft).toEqual(original);
  });

  it("送信前プレビューにも表示用データを適用し、別登録更新だけでは現金確認と下書きを戻さない", () => {
    const data = allowanceFixture(500, 1000);
    data.closings[0].status = "returned";
    registerAllowances(data, true, 1500);
    const day = data.closings[0];
    harness.drafts["store.editing"] = day;
    const draftKey = "store.workflow." + day.id + ".";
    for (const [key, value] of Object.entries({
      stage: "cash",
      "cashFunding2.companyReplenishment": 0,
      "cashFunding2.personalReplenishment": 0,
      "cashFunding2.companyTransfer": 0,
      personalRepayment: 0, openingPersonalDebt: 0,
      cashRevisionReason: "当時の実績を確認",
    })) harness.drafts[draftKey + key] = value;
    render(data);
    const cashCheck = harness.checks.find((check) => !check.disabled);
    expect(cashCheck).toBeDefined();
    cashCheck!.change({ target: { checked: true } });
    render(data);
    const next = harness.buttons.find((button) => button.label === "現金照合内容を確認して送信確認へ");
    expect(next).toBeDefined();
    next!.click();
    const markup = render(data);
    expect(markup).toContain('class="preview-sheet"');
    expect(castCells(markup)[9]).toBe("要確認");
    expect(castCells(markup)[12]).toBe("要確認");
    const drafts = structuredClone(harness.drafts);
    const updated = structuredClone(data);
    registerAllowances(updated, false, 0);
    const latestMarkup = render(updated);
    expect(latestMarkup).toContain('class="preview-sheet"');
    expect(latestMarkup).toContain("確認済み・経理へ送信");
    expect(castCells(latestMarkup)[9]).toBe("￥0");
    expect(castCells(latestMarkup)[12]).toBe("￥0");
    expect(harness.drafts).toEqual(drafts);
    expect(harness.drafts[draftKey + "castRows"]).toEqual(day.casts);
    expect(run).not.toHaveBeenCalled();
    expect(harness.submit).not.toHaveBeenCalled();
  });

  it("表示用データを渡さない従来呼出しでは旧日次の保存額を維持する", () => {
    const data = allowanceFixture(500, 1500);
    const markup = renderToStaticMarkup(createElement(DailyPreview, { closing: data.closings[0] }));
    expect(castCells(markup)[9]).toBe("￥500");
    expect(castCells(markup)[12]).toBe("￥1,500");
    expect(markup).not.toContain("美容室手当・送迎代の要確認事項");
  });
});
