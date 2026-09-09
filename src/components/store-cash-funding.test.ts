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
  money: [] as Array<{ label: string; value: number; change: (amount: number) => void }>,
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
    type?: string; value?: number; onClick?: () => unknown; onChange?: (value: unknown) => void };
  const collect = (node: import("react").ReactNode, label = "") => {
    if (Array.isArray(node)) { node.forEach((value) => collect(value, label)); return; }
    if (!react.isValidElement<Props>(node)) return;
    if (node.type === "button" && node.props.onClick && typeof node.props.children === "string") {
      harness.buttons.push({ label: node.props.children, disabled: Boolean(node.props.disabled), click: node.props.onClick });
    }
    if (node.type === "input" && node.props.type === "checkbox" && node.props.onChange) {
      harness.checks.push({ disabled: Boolean(node.props.disabled), checked: Boolean(node.props.checked), change: (checked) => node.props.onChange!({ target: { checked } }) });
    }
    if (node.type === actual.MoneyInput) harness.money.push({ label, value: node.props.value!, change: (amount) => node.props.onChange!(amount) });
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
function restore(values: Record<string, unknown>, key = prefix) {
  for (const [field, value] of Object.entries(values)) harness.drafts[`${key}.${field}`] = value;
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
  restore({ pos, stage: "cash" });
});

describe("現金補充・返済の店舗確認", () => {
  it("実在高金額入力を廃止し、初回は未確認で次画面へ進めない", () => {
    const markup = render();
    expect(markup).not.toContain("営業終了時点の現金実在高");
    expect(markup).toContain("個人への返済額も確認済み");
    expect(button(nextLabel).disabled).toBe(true);
    expect(harness.checks).toEqual([expect.objectContaining({ checked: false, disabled: false })]);
    expect(harness.keys.some((key) => /confirm/i.test(key))).toBe(false);
  });

  it("旧退避実在高と旧プレビューを復元しても一致確認済みにはせず金額も使わない", () => {
    restore({ stage: "preview", actualCash: 987654 });
    const markup = render();
    expect(markup).not.toContain("987,654");
    expect(markup).not.toContain("確認済み・経理へ送信");
    expect(markup).toContain("当日現金照合");
    expect(harness.drafts[`${prefix}.actualCash`]).toBe(0);
    expect(button(nextLabel).disabled).toBe(true);
  });

  it("開店不足を会社または個人に勝手に割り当てず、合計不足の間は確認を禁止する", () => {
    const markup = render({ ...data, closings: [previous()] });
    expect(markup).toContain("20,000");
    expect(input("開店前の会社補充（返済不要）").value).toBe(0);
    expect(input("開店前の個人立替補充").value).toBe(0);
    expect(harness.checks[0].disabled).toBe(true);
    expect(button(nextLabel).disabled).toBe(true);
  });

  it("個人補充2万円に対して利益1万円のみを返済し、未返済1万円とつり銭20万円を表示する", () => {
    restore({ personalReplenishment: 20000 });
    const markup = render({ ...data, closings: [previous()] });
    expect(markup).toContain("翌営業日へ繰り越す個人立替未返済額");
    expect(markup).toMatch(/個人への返済額（自動計算）<\/td><td>￥10,000/);
    expect(markup).toMatch(/翌営業日へ繰り越す個人立替未返済額<\/td><td>￥10,000/);
    expect(markup).toContain("￥200,000");
    expect(harness.checks[0].disabled).toBe(false);
  });

  it("利益1万円と会社入金1万円で個人補充2万円を完済し、利益を減らさず確認後に送信する", async () => {
    const source = { ...data, closings: [previous()] };
    restore({ personalReplenishment: 20000, companyTransfer: 10000 });
    render(source);
    harness.checks[0].change(true);
    render(source);
    expect(button(nextLabel).disabled).toBe(false);
    button(nextLabel).click();
    render(source);
    expect(button("確認済み・経理へ送信").disabled).toBe(false);
    button("確認済み・経理へ送信").click();
    await vi.waitFor(() => expect(harness.submit).toHaveBeenCalledTimes(1));
    const sent = harness.submit.mock.calls[0][0] as unknown as DailyClosing;
    expect(sent.cash).toMatchObject({ cashProfit: 10000, expectedClosingCash: 200000, actualClosingCash: 200000,
      difference: 0, funding: { companyTransfer: 10000, personalRepayment: 20000, closingPersonalDebt: 0, confirmed: true } });
  });

  it("確認後に入金を変更すると即座に送信確認へ進めず、同額へ戻しても再確認が必要", () => {
    render(); harness.checks[0].change(true); render();
    expect(button(nextLabel).disabled).toBe(false);
    input("会社入金（個人返済の原資）").change(1000);
    render();
    expect(button(nextLabel).disabled).toBe(true);
    input("会社入金（個人返済の原資）").change(0);
    render();
    expect(button(nextLabel).disabled).toBe(true);
  });

  it("確認後の前営業日変更で即時未確認へ戻し、入力した補充額を保持する", () => {
    const earlier = previous();
    const source = { ...data, closings: [earlier] };
    restore({ personalReplenishment: 20000 });
    render(source); harness.checks[0].change(true); render(source);
    expect(button(nextLabel).disabled).toBe(false);
    const changed = { ...earlier, cash: { ...earlier.cash, expectedClosingCash: 190000, cashProfit: -10000 } };
    const markup = render({ ...data, closings: [changed] });
    expect(markup).toContain("合計を、開店前のつり銭不足額に合わせて");
    expect(input("開店前の個人立替補充").value).toBe(20000);
    expect(button(nextLabel).disabled).toBe(true);
  });

  it("前営業日が計算不能なら画面を落とさず警告し、保存入力を保持する", () => {
    const earlier = previous(); earlier.cash.expectedClosingCash = -1;
    restore({ personalReplenishment: 1234 });
    const markup = render({ ...data, closings: [earlier] });
    expect(markup).toContain("計算上現金残額を確認できません");
    expect(input("開店前の個人立替補充").value).toBe(1234);
    expect(button(nextLabel).disabled).toBe(true);
  });

  it("計算上残額が負なら一致確認も送信も禁止する", () => {
    restore({ dispatchCastPayment: 220000 });
    const markup = render();
    expect(markup).toContain("0円未満");
    expect(harness.checks[0].disabled).toBe(true);
    expect(button(nextLabel).disabled).toBe(true);
  });

  it("保存済みの補充・返済額を再編集へ復元しても、以前の確認済み状態は復元しない", () => {
    const recorded = recordedManagedClosing(); const before = structuredClone(recorded);
    harness.drafts["store.editing"] = recorded;
    restore({ stage: "cash" }, `store.workflow.${recorded.id}`);
    const markup = render({ ...data, closings: [previous(), recorded] });
    expect(input("開店前の個人立替補充").value).toBe(20000);
    expect(markup).toMatch(/個人への返済額（自動計算）<\/td><td>￥10,000/);
    expect(harness.checks[0].checked).toBe(false);
    expect(button(nextLabel).disabled).toBe(true);
    expect(recorded).toEqual(before);
  });

  it("保存fundingの前営業日前提が変わっていたら補充・返済を自動修正せず警告する", () => {
    const recorded = recordedManagedClosing(); const before = structuredClone(recorded);
    const earlier = previous(); earlier.cash.expectedClosingCash = 190000;
    harness.drafts["store.editing"] = recorded;
    restore({ stage: "cash" }, `store.workflow.${recorded.id}`);
    const markup = render({ ...data, closings: [earlier, recorded] });
    expect(markup).toContain("保存時と変わっています");
    expect(input("開店前の個人立替補充").value).toBe(20000);
    expect(harness.checks[0].disabled).toBe(true);
    expect(button(nextLabel).disabled).toBe(true);
    expect(recorded).toEqual(before);
  });

  it("保存済み返済額に不整合があっても自動修正して送信可能にしない", () => {
    const recorded = recordedManagedClosing();
    recorded.cash.funding!.personalRepayment = 9000;
    recorded.cash.funding!.closingPersonalDebt = 11000;
    recorded.cash.expectedClosingCash = 201000;
    recorded.cash.actualClosingCash = 201000;
    const before = structuredClone(recorded);
    harness.drafts["store.editing"] = recorded;
    restore({ stage: "cash" }, `store.workflow.${recorded.id}`);
    const markup = render({ ...data, closings: [previous(), recorded] });
    expect(markup).toContain("個人立替の返済額・未返済残高が一致しません");
    expect(markup).toMatch(/個人への返済額（自動計算）<\/td><td>￥9,000/);
    expect(button(nextLabel).disabled).toBe(true);
    expect(recorded).toEqual(before);
  });

  it("確認済みの状態で別営業日へ切り替わったら再確認が必要になる", () => {
    render(); harness.checks[0].change(true); render();
    expect(button(nextLabel).disabled).toBe(false);
    restore({ pos: { ...pos, businessDate: "2026-09-11" } });
    render();
    expect(button(nextLabel).disabled).toBe(true);
    expect(harness.checks[0].checked).toBe(false);
  });

  it("保存済み旧日次プレビューは当時の実在高と照合差額を変更しない", () => {
    const source = previous(); const before = structuredClone(source);
    const markup = renderToStaticMarkup(createElement(DailyPreview, { closing: source }));
    expect(markup).toContain("旧実在高");
    expect(markup).toContain("￥179,000");
    expect(markup).toContain("旧照合差額");
    expect(source).toEqual(before);
  });
});
