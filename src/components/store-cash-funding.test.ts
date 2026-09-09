import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { User } from "firebase/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DailyClosing, PosClosingV3 } from "@/domain/gms";
import type { AccountingWorkspaceData } from "@/domain/month-accounting";
import { StoreWork, DailyPreview } from "./store-work";

const harness = vi.hoisted(() => ({
  drafts: {} as Record<string, unknown>, keys: [] as string[],
  state: [] as unknown[], stateIndex: 0,
  effects: [] as Array<readonly unknown[] | undefined>, effectIndex: 0, pending: [] as Array<() => unknown>,
  buttons: [] as Array<{ label: string; disabled: boolean; click: () => unknown }>,
  checks: [] as Array<{ disabled: boolean; checked: boolean; change: (checked: boolean) => void }>,
  money: [] as Array<{ label: string; value: number | null; change: (amount: number | null) => void }>,
  submit: vi.fn(async (..._args: unknown[]) => undefined),
}));

// 確認チェックだけをメモリー状態として再描画する。DOM・Firebaseへの書込みは行わない。
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual,
    useState<T>(initial: T | (() => T)) {
      const index = harness.stateIndex++;
      if (!(index in harness.state)) harness.state[index] = typeof initial === "function" ? (initial as () => T)() : initial;
      return [harness.state[index] as T, (next: T | ((value: T) => T)) => {
        harness.state[index] = typeof next === "function" ? (next as (value: T) => T)(harness.state[index] as T) : next;
      }];
    },
    useEffect(effect: () => unknown, dependencies?: readonly unknown[]) {
      const index = harness.effectIndex++;
      const previous = harness.effects[index];
      if (!previous || !dependencies || dependencies.some((item, i) => !Object.is(item, previous[i]))) {
        harness.pending.push(effect);
      }
      harness.effects[index] = dependencies;
    },
  };
});
vi.mock("./update-drafts", () => ({
  useRecoverableState<T>(key: string, initial: T | (() => T)) {
    harness.keys.push(key);
    if (!Object.hasOwn(harness.drafts, key)) harness.drafts[key] = typeof initial === "function" ? (initial as () => T)() : initial;
    return [harness.drafts[key] as T, (next: T | ((value: T) => T)) => {
      harness.drafts[key] = typeof next === "function" ? (next as (value: T) => T)(harness.drafts[key] as T) : next;
    }];
  },
  useUpdateDraftBusy() {},
}));
vi.mock("@/lib/firebase/repository", () => ({
  submitClosing: (...args: unknown[]) => harness.submit(...args),
  deleteUnapprovedClosing: vi.fn(), withdrawClosing: vi.fn(),
}));
vi.mock("./ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ui")>();
  const react = await import("react");
  type Props = { children?: import("react").ReactNode; label?: string; disabled?: boolean; checked?: boolean;
    type?: string; value?: number | null; onClick?: () => unknown; onChange?: (value: unknown) => void };
  const collect = (node: import("react").ReactNode, label = "") => {
    if (Array.isArray(node)) { node.forEach((value) => collect(value, label)); return; }
    if (!react.isValidElement<Props>(node)) return;
    if (node.type === "button" && node.props.onClick && typeof node.props.children === "string") {
      harness.buttons.push({ label: node.props.children, disabled: Boolean(node.props.disabled), click: node.props.onClick });
    }
    if (node.type === "input" && node.props.type === "checkbox" && node.props.onChange) {
      harness.checks.push({ disabled: Boolean(node.props.disabled), checked: Boolean(node.props.checked), change: (checked) => node.props.onChange!({ target: { checked } }) });
    }
    if (node.type === actual.MoneyInput || (typeof node.type === "function" && node.type.name === "CashAmountInput")) harness.money.push({ label, value: node.props.value!, change: (amount) => node.props.onChange!(amount) });
    collect(node.props.children, node.props.label || label);
  };
  return { ...actual, Card(props: Parameters<typeof actual.Card>[0]) {
    collect(props.children);
    return react.createElement(actual.Card, props);
  } };
});

const date = "2026-09-10";
const prefix = "store.workflow.new";
const pos: PosClosingV3 = {
  schema: "club-genesis-pos-closing", schemaVersion: 3, businessDate: date, status: "closed",
  sales: { cashSales: 10000, cardSales: 0, totalSales: 10000 },
  customers: { groupCount: 0, totalCustomers: 0 }, nominations: { honShimeiCount: 0, jonaiCount: 0 },
  transactions: [], castSales: [], castWork: [], enteredCasts: [], exitedCasts: [], trialCasts: [],
  rosterSnapshot: { complete: true, capturedAt: `${date}T19:00:00+09:00`, casts: [] },
  lifecycleEvents: [], submissionId: "cash-test", generatedAt: `${date}T18:00:00.000Z`,
  checksumAlgorithm: "sha256", checksumCanonicalization: "recursive-key-sort-v1", checksum: "a".repeat(64),
};
const data: AccountingWorkspaceData = {
  casts: [], staff: [], drivers: [], introducers: [], liquor: [], closings: [], adjustments: [],
  archivedCasts: [], archivedStaff: [], introducerEntryEvents: [], introducerDeletionCommits: [],
  introducerMonthEvents: [], monthStates: [], monthSnapshots: [], cashFloat: 200000,
};
const user = { uid: "cash-ui-test" } as User;
function previous(): DailyClosing {
  return {
    id: "daily_20260909", businessDate: "2026-09-09", status: "approved", updatedAt: "2026-09-10T01:00:00.000Z",
    submissionId: "previous", checksum: "b".repeat(64), sales: pos.sales, customers: pos.customers, nominations: pos.nominations,
    casts: [], staffWork: [], drivers: [], expenses: [], staffDailyPaymentTotal: 0,
    dispatchCastPayment: 0, dispatchStaffPayment: 0, dispatchFee: 0, liquorDeliveryAmount: 0,
    posSnapshot: { ...pos, businessDate: "2026-09-09" },
    cash: { ...pos.sales, cashFloat: 200000, expenseAndPaymentTotal: 30000,
      cashProfit: -20000, expectedClosingCash: 180000, actualClosingCash: 179000, difference: -1000 },
  };
}
function recordedManagedClosing(): DailyClosing {
  return {
    ...previous(), id: "daily_20260910", businessDate: date, status: "returned", posSnapshot: pos,
    submissionId: pos.submissionId, checksum: pos.checksum,
    cash: { ...pos.sales, cashFloat: 200000, expenseAndPaymentTotal: 0, cashProfit: 10000,
      expectedClosingCash: 200000, actualClosingCash: 200000, difference: 0,
      funding: { schema: 1, previousClosingId: "daily_20260909", previousBusinessDate: "2026-09-09",
        previousClosingCash: 180000, openingShortfall: 20000, openingPersonalDebt: 0,
        companyReplenishment: 0, personalReplenishment: 20000, companyTransfer: 0,
        personalRepayment: 10000, closingPersonalDebt: 10000, confirmed: true } },
  };
}
function legacyClosing(businessDate = "2026-09-07"): DailyClosing {
  return { ...previous(), id: `daily_${businessDate.replaceAll("-", "")}`, businessDate, status: "returned",
    expenses: [{ id: "old-expense", category: "supplies", payee: "保存済み支払先", amount: 30000 }],
    posSnapshot: { ...pos, businessDate }, submissionId: pos.submissionId, checksum: pos.checksum };
}
function restore(values: Record<string, unknown>, key = prefix) {
  for (const [field, value] of Object.entries(values)) {
    const savedField = ["companyReplenishment", "personalReplenishment", "companyTransfer"].includes(field) ? "cashFunding2." + field : field;
    harness.drafts[`${key}.${savedField}`] = value;
  }
}
function render(source = data) {
  harness.stateIndex = 0; harness.effectIndex = 0;
  harness.buttons = []; harness.checks = []; harness.money = []; harness.keys = [];
  const markup = renderToStaticMarkup(createElement(StoreWork, {
    data: source, user, busy: false, run: async (action) => { await action(); return true; },
  }));
  harness.pending.splice(0).forEach((effect) => effect());
  return markup;
}
function button(label: string) {
  const result = harness.buttons.find((item) => item.label === label);
  expect(result, `${label}がある`).toBeDefined();
  return result!;
}
function input(label: string) {
  const result = harness.money.find((item) => item.label === label);
  expect(result, `${label}がある`).toBeDefined();
  return result!;
}
const nextLabel = "現金照合内容を確認して送信確認へ";

beforeEach(() => {
  harness.drafts = {}; harness.keys = []; harness.state = []; harness.effects = []; harness.pending = [];
  harness.submit.mockClear();
  restore({ pos, stage: "cash", openingPersonalDebt: 0, personalRepayment: 0 });
});

describe("全営業日の現金実績入力", () => {
  it("新規は補充3項目が0円、開始未返済と実返済は未入力で推定しない", () => {
    delete harness.drafts[prefix + ".openingPersonalDebt"]; delete harness.drafts[prefix + ".personalRepayment"];
    const markup = render();
    for (const label of ["開店前の会社補充（返済不要）", "開店前の個人立替補充", "会社入金（個人返済の原資）"]) expect(input(label).value).toBe(0);
    expect(input("営業開始時の個人未返済額").value).toBeNull();
    expect(input("実際に個人へ返済した金額").value).toBeNull();
    expect(markup).not.toContain("旧方式"); expect(button(nextLabel).disabled).toBe(true);
  });
  it("既存の未入力営業日も同じフォームで補充・返済・開始残高を入力する", () => {
    const recorded = legacyClosing(); harness.drafts["store.editing"] = recorded;
    restore({ stage: "cash" }, "store.workflow." + recorded.id);
    const markup = render({ ...data, closings: [recorded] });
    for (const label of ["開店前の会社補充（返済不要）", "開店前の個人立替補充", "会社入金（個人返済の原資）", "実際に個人へ返済した金額", "営業開始時の個人未返済額"]) expect(input(label).value).toBeNull();
    expect(markup).toContain("入力した補充・返済実績と当時の記録");
    expect(markup).not.toContain("旧方式"); expect(button(nextLabel).disabled).toBe(true);
  });
  it("以前の未記録日次から退避した初期0円は実績0円として自動適用しない", () => {
    const recorded = legacyClosing(); harness.drafts["store.editing"] = recorded;
    const key = "store.workflow." + recorded.id;
    restore({ stage: "cash" }, key);
    harness.drafts[key + ".companyReplenishment"] = 0;
    harness.drafts[key + ".personalReplenishment"] = 0;
    harness.drafts[key + ".companyTransfer"] = 12345;
    expect(render({ ...data, closings: [recorded] })).toContain("自動では適用していません");
    expect(input("開店前の会社補充（返済不要）").value).toBeNull();
    expect(input("会社入金（個人返済の原資）").value).toBeNull();
    button("退避金額を実績と確認して適用").click(); render({ ...data, closings: [recorded] });
    expect(input("開店前の会社補充（返済不要）").value).toBe(0);
    expect(input("会社入金（個人返済の原資）").value).toBe(12345);
    expect(harness.checks.at(-1)!.checked).toBe(false);
  });
  it("新規の以前の退避金額も失わず、明示適用まで現行入力を上書きしない", () => {
    harness.drafts[prefix + ".personalReplenishment"] = 20000;
    expect(render()).toContain("￥20,000");
    expect(input("開店前の個人立替補充").value).toBe(0);
    button("退避金額を実績と確認して適用").click(); render();
    expect(input("開店前の個人立替補充").value).toBe(20000);
  });
  it("推奨返済額はボタンを押した場合だけ反映し、その後の入金変更で実績を変えない", () => {
    restore({ openingPersonalDebt: 20000, personalRepayment: null }); render();
    expect(input("実際に個人へ返済した金額").value).toBeNull();
    button("推奨返済額を入力").click(); render();
    expect(input("実際に個人へ返済した金額").value).toBe(10000);
    input("会社入金（個人返済の原資）").change(5000); render();
    expect(input("実際に個人へ返済した金額").value).toBe(10000);
  });
  it("未返済2万円から実返済5千円だけを差し引いて保存する", async () => {
    restore({ openingPersonalDebt: 20000, personalRepayment: 5000 }); render();
    harness.checks.at(-1)!.change(true); render(); button(nextLabel).click(); render();
    button("確認済み・経理へ送信").click();
    await vi.waitFor(() => expect(harness.submit).toHaveBeenCalledTimes(1));
    const sent = harness.submit.mock.calls[0][0] as DailyClosing;
    expect(sent.cash).toMatchObject({ cashProfit: 10000, expectedClosingCash: 205000, funding: { schema: 2, openingPersonalDebt: 20000, personalRepayment: 5000, closingPersonalDebt: 15000, confirmed: true } });
    expect(sent.legacyCashConfirmed).toBeUndefined();
  });
  it("開店不足を会社・個人へ割り当てず、不足合計が一致するまで確認できない", () => {
    render({ ...data, closings: [previous()] });
    expect(input("開店前の会社補充（返済不要）").value).toBe(0);
    expect(input("開店前の個人立替補充").value).toBe(0);
    expect(harness.checks.at(-1)!.disabled).toBe(true);
  });
  it("会社入金を原資に返済しても利益は減らさない", async () => {
    const source = { ...data, closings: [previous()] };
    restore({ personalReplenishment: 20000, companyTransfer: 10000, personalRepayment: 20000 });
    render(source); harness.checks.at(-1)!.change(true); render(source); button(nextLabel).click(); render(source);
    button("確認済み・経理へ送信").click();
    await vi.waitFor(() => expect(harness.submit).toHaveBeenCalledTimes(1));
    const sent = harness.submit.mock.calls[0][0] as DailyClosing;
    expect(sent.cash).toMatchObject({ cashProfit: 10000, expectedClosingCash: 200000, funding: { personalRepayment: 20000, closingPersonalDebt: 0 } });
  });
  it("入力を変更して戻しても確認を復元せず、画面復元後も未確認にする", () => {
    render(); harness.checks.at(-1)!.change(true); render(); expect(button(nextLabel).disabled).toBe(false);
    input("会社入金（個人返済の原資）").change(1000); render();
    input("会社入金（個人返済の原資）").change(0); render(); expect(button(nextLabel).disabled).toBe(true);
    restore({ stage: "preview", actualCash: 987654 }); harness.state = []; harness.effects = [];
    const markup = render(); expect(markup).not.toContain("987,654");
    expect(markup).not.toContain("確認済み・経理へ送信"); expect(harness.drafts[prefix + ".actualCash"]).toBe(0);
    expect(harness.keys.some((key) => /confirmed/i.test(key))).toBe(false);
  });
  it("既存の実返済は前提変更時も保持し、保存時と最新を比較する", () => {
    const recorded = recordedManagedClosing(); harness.drafts["store.editing"] = recorded;
    restore({ stage: "cash", cashRevisionReason: "前提を確認" }, "store.workflow." + recorded.id);
    const earlier = previous(); earlier.cash.expectedClosingCash = 190000;
    const markup = render({ ...data, closings: [earlier, recorded] });
    expect(input("実際に個人へ返済した金額").value).toBe(10000);
    expect(input("開店前の個人立替補充").value).toBe(20000);
    expect(markup).toContain("前営業日の前提が保存時から変わっています");
    expect(markup).toContain("保存時"); expect(markup).toContain("最新");
    expect(harness.checks[0].checked).toBe(false); expect(button(nextLabel).disabled).toBe(true);
  });
  it("過去の現金実績補完は根拠理由が未入力なら確認できない", () => {
    const recorded = legacyClosing(); harness.drafts["store.editing"] = recorded;
    restore({ stage: "cash", companyReplenishment: 0, personalReplenishment: 0, companyTransfer: 0, personalRepayment: 0, openingPersonalDebt: 0 }, "store.workflow." + recorded.id);
    const source = { ...data, closings: [recorded, legacyClosing("2026-09-08")] };
    expect(render(source)).toContain("現金記録の追加・変更理由（必須）"); expect(harness.checks.at(-1)!.disabled).toBe(true);
    restore({ cashRevisionReason: "当日の現金記録を確認して補完" }, "store.workflow." + recorded.id);
    render(source); expect(harness.checks.at(-1)!.disabled).toBe(false);
  });
  it("過去日次を二回連続で再送しても実績を保持し、毎回確認を要求する", async () => {
    let recorded = legacyClosing(); const original = structuredClone(recorded);
    for (let count = 1; count <= 2; count++) {
      harness.state = []; harness.effects = []; harness.pending = []; harness.drafts = {};
      harness.drafts["store.editing"] = recorded;
      restore({ stage: "cash", companyReplenishment: 0, personalReplenishment: 0, companyTransfer: 0, personalRepayment: 0, openingPersonalDebt: 15000, cashRevisionReason: "当日の実績を記録" }, "store.workflow." + recorded.id);
      const source = { ...data, closings: [recorded, legacyClosing("2026-09-08")] };
      render(source); expect(harness.checks.at(-1)!.checked).toBe(false); expect(button(nextLabel).disabled).toBe(true);
      if (harness.checks.length > 1) { harness.checks[0].change(true); render(source); }
      harness.checks.at(-1)!.change(true); render(source); button(nextLabel).click(); render(source);
      button("確認済み・経理へ送信").click();
      await vi.waitFor(() => expect(harness.submit).toHaveBeenCalledTimes(count));
      const sent = harness.submit.mock.calls[count - 1][0] as DailyClosing;
      expect(sent.cash.funding).toMatchObject({ schema: 2, openingPersonalDebt: 15000, personalRepayment: 0, closingPersonalDebt: 15000 });
      expect(sent.legacyCashConfirmed).toBeUndefined(); recorded = { ...sent, status: "returned", updatedAt: "return-" + count };
    }
    expect(original.cash).toMatchObject({ actualClosingCash: 179000, difference: -1000 });
  });
  it("後続営業日の要確認理由と保存時・最新の前提を表示し、実績は変えない", () => {
    const recorded = recordedManagedClosing();
    const later: DailyClosing = { ...recorded, id: "daily_20260911", businessDate: "2026-09-11", cash: { ...recorded.cash, cashProfit: 0, expenseAndPaymentTotal: 10000, expectedClosingCash: 200000, funding: { ...recorded.cash.funding!, previousClosingId: recorded.id, previousBusinessDate: date, previousClosingCash: 200000, openingShortfall: 0, openingPersonalDebt: 10000, personalReplenishment: 0, personalRepayment: 0, closingPersonalDebt: 10000 } } };
    harness.drafts["store.editing"] = recorded;
    restore({ stage: "cash", personalRepayment: 5000, cashRevisionReason: "実返済を訂正" }, "store.workflow." + recorded.id);
    const markup = render({ ...data, closings: [previous(), recorded, later] });
    expect(markup).toContain("保存後に確認が必要となる後続営業日"); expect(markup).toContain("2026-09-11");
    expect(markup).toContain("保存時"); expect(later.cash.funding!.openingPersonalDebt).toBe(10000);
  });
  it.each(["closed", "closing"] as const)("月次%sの欠落日へ編集ボタンを出さない", (status) => {
    const recorded = legacyClosing();
    const markup = render({ ...data, closings: [recorded], monthStates: [{ month: "2026-09", status, revision: 1, updatedAt: "", updatedBy: "accounting" }] });
    expect(markup).toContain("現金管理の未入力・要確認営業日");
    expect(harness.buttons.some((row) => row.label === "この営業日の入力を確認")).toBe(false);
  });
  it.each(["closed", "closing"] as const)("後続の営業日がない%s月も繰越への影響を送信前に停止する", (status) => {
    const recorded = legacyClosing(); harness.drafts["store.editing"] = recorded;
    restore({ stage: "cash", companyReplenishment: 0, personalReplenishment: 0, companyTransfer: 0, personalRepayment: 0, openingPersonalDebt: 0, cashRevisionReason: "当日の実績を記録" }, "store.workflow." + recorded.id);
    const markup = render({ ...data, closings: [recorded], monthStates: [{ month: "2026-10", status, revision: 1, updatedAt: "", updatedBy: "accounting" }] });
    expect(markup).toContain("2026-10の確定済みまたは確定処理中の月へ現金繰越が影響します");
    expect(harness.checks.at(-1)!.disabled).toBe(true); expect(button(nextLabel).disabled).toBe(true);
  });
  it("未入力の差戻し日には日別入力ボタン、承認済みには差戻し案内を表示する", () => {
    const first = legacyClosing(); const second = { ...legacyClosing("2026-09-08"), status: "approved" as const };
    const markup = render({ ...data, closings: [first, second] });
    expect(button("この営業日の入力を確認").disabled).toBe(false); expect(markup).toContain("経理またはOPが差し戻した後");
    button("この営業日の入力を確認").click(); expect(harness.drafts["store.editing"]).toEqual(first);
  });
  it("残額が負または前日破損なら入力を保持して送信を停止する", () => {
    restore({ dispatchCastPayment: 220000 }); expect(render()).toContain("0円未満"); expect(harness.checks.at(-1)!.disabled).toBe(true);
    const earlier = previous(); earlier.cash.expectedClosingCash = -1; restore({ personalReplenishment: 1234 });
    expect(render({ ...data, closings: [earlier] })).toContain("計算上現金残額を確認できません");
    expect(input("開店前の個人立替補充").value).toBe(1234); expect(button(nextLabel).disabled).toBe(true);
  });
  it("記録済みプレビューは当時の実在高・差額を変更せず方式ラベルを出さない", () => {
    const source = previous(); const before = structuredClone(source);
    const markup = renderToStaticMarkup(createElement(DailyPreview, { closing: source }));
    expect(markup).toContain("保存済み現金記録・差額"); expect(markup).toContain("￥179,000");
    expect(markup).not.toContain("旧実在高"); expect(markup).not.toContain("旧方式"); expect(source).toEqual(before);
  });
});
