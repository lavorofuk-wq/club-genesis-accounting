import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { User } from "firebase/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountingWorkspaceData } from "@/domain/month-accounting";
import type { CastRecord, DailyCast, IntroducerRecord } from "@/domain/gms";

const drafts = vi.hoisted(() => new Map<string, unknown>());
type IntroducerSelect = { value: string; onChange: (event: { target: { value: string } }) => void };
const castForm = vi.hoisted(() => ({
  buttons: new Map<string, () => void>(),
  submit: undefined as undefined | ((event: { preventDefault: () => void }) => Promise<void>),
  introducer: undefined as IntroducerSelect | undefined,
}));
vi.mock("./update-drafts", () => ({
  useRecoverableState<T>(key: string, initial: T | (() => T)) {
    if (!drafts.has(key)) drafts.set(key, typeof initial === "function" ? (initial as () => T)() : initial);
    return [drafts.get(key) as T, (next: T) => drafts.set(key, next)];
  },
  useUpdateDraftBusy: () => undefined,
}));
vi.mock("@/lib/firebase/repository", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/firebase/repository")>(), saveCast: vi.fn(async () => "saved"),
}));
vi.mock("./ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ui")>();
  const collectButtons = (node: ReactNode) => {
    if (Array.isArray(node)) { node.forEach(collectButtons); return; }
    if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(node)) return;
    if (node.type === "button" && node.props.onClick && typeof node.props.children === "string") {
      castForm.buttons.set(node.props.children, node.props.onClick);
    }
    collectButtons(node.props.children);
  };
  return {
    ...actual,
    Table(props: Parameters<typeof actual.Table>[0]) {
      collectButtons(props.children);
      return createElement(actual.Table, props);
    },
    Modal(props: Parameters<typeof actual.Modal>[0]) {
      if (isValidElement<{ onSubmit?: typeof castForm.submit }>(props.children)) castForm.submit = props.children.props.onSubmit;
      return createElement(actual.Modal, props);
    },
    Field(props: Parameters<typeof actual.Field>[0]) {
      if (props.label.endsWith("月度の紹介者") && isValidElement<IntroducerSelect>(props.children) && props.children.type === "select") {
        castForm.introducer = props.children.props;
      }
      return createElement(actual.Field, props);
    },
  };
});
import { CommonForms } from "./common-forms";
import { AccountingForms } from "./accounting-forms";
import { saveCast } from "@/lib/firebase/repository";

const user = { uid: "test-user" } as User;
const data: AccountingWorkspaceData = {
  casts: [], staff: [], drivers: [], introducers: [], liquor: [], closings: [], adjustments: [], cashFloat: 200_000,
  archivedCasts: [], archivedStaff: [], introducerEntryEvents: [], introducerDeletionCommits: [], introducerMonthEvents: [], monthStates: [], monthSnapshots: [],
};
const run = vi.fn(async () => true);
beforeEach(() => { drafts.clear(); vi.clearAllMocks(); });

describe("common/accounting form recovery", () => {
  it("restores cast edit, original revision, selected pay month and rate without saving", () => {
    drafts.set("common.casts.editing", { id: "cast-1", updatedAt: "original-revision", status: "active", name: "退避キャスト", legalName: "本名", hourlyRates: {} });
    drafts.set("common.casts.month", "2026-08");
    drafts.set("common.casts.rate", 3470);
    const markup = renderToStaticMarkup(createElement(CommonForms, { section: "casts", data, user, busy: false, run }));
    expect(markup).toContain("退避キャスト");
    expect(markup).toContain("2026-08");
    expect(markup).toContain('value="3470"');
    expect(drafts.get("common.casts.editing")).toMatchObject({ updatedAt: "original-revision" });
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    ["staff", { status: "trial", name: "退避スタッフ", trialHourlyRate: 1570, trialDate: "2026-09-02" }, "退避スタッフ"],
    ["drivers", { status: "active", name: "退避ドライバー", dailyRate: 9070 }, "退避ドライバー"],
    ["introducers", { name: "退避紹介者", feeType: "sales10", attendanceAdvisoryEnabled: true }, "退避紹介者"],
    ["liquor", { kind: "keepBottle", name: "退避ボトル", salePrice: 12000, costPrice: 4500 }, "退避ボトル"],
  ] as const)("restores %s input without mutating Firebase", (section, editing, expected) => {
    drafts.set(`common.${section}.editing`, editing);
    const markup = renderToStaticMarkup(createElement(CommonForms, { section, data, user, busy: false, run }));
    expect(markup).toContain(expected);
    expect(run).not.toHaveBeenCalled();
  });

  it("restores unsaved cash float instead of using the server's initial value", () => {
    drafts.set("common.cash.amount", 256000);
    const markup = renderToStaticMarkup(createElement(CommonForms, { section: "cash", data, user, busy: false, run }));
    expect(markup).toContain('value="256000"');
    expect(run).not.toHaveBeenCalled();
  });

  it("restores the selected month, expense inputs and original monthly revision", () => {
    drafts.set("accounting.monthly.month", "2026-08");
    drafts.set("accounting.monthly.adjustments", {
      month: "2026-08", revision: 3, withholdingByCast: {}, staffSalesAllowance: {}, staffBottleAllowance: {}, driverRemoteAllowance: {},
      fixedExpenses: [{ id: "expense", account: "退避固定費", amount: 21700 }], cardFee: 3890, legacyBottleClassifications: {},
    });
    const markup = renderToStaticMarkup(createElement(AccountingForms, { section: "expenses", data, user, busy: false, run }));
    expect(markup).toContain('value="2026-08"');
    expect(markup).toContain("退避固定費");
    expect(markup).toContain('value="21700"');
    expect(markup).toContain('value="3890"');
    expect(drafts.get("accounting.monthly.adjustments")).toMatchObject({ revision: 3 });
    expect(run).not.toHaveBeenCalled();
  });
});


it("入店顧問料を0にした編集欄は空欄にせず0を表示する", () => {
  drafts.set("common.casts.editing", { id: "cast-1", status: "active", name: "花子", legalName: "山田花子",
    hiredAt: "2026-09-01", introducerId: "intro-1", entryAdvisoryFee: 0, hourlyRates: { "2026-09": 3000 } });
  drafts.set("common.casts.month", "2026-09");
  const introducer = { id: "intro-1", name: "紹介者", feeType: "sales10" as const, attendanceAdvisoryEnabled: false,
    entryAdvisoryEnabled: true, note: "", createdAt: "2026-09-01", updatedAt: "2026-09-01" };
  const markup = renderToStaticMarkup(createElement(CommonForms, { section: "casts", data: { ...data, introducers: [introducer] }, user, busy: false, run }));
  expect(markup).toMatch(/入店顧問料<[^>]*><input[^>]*value="0"/);
});

it("退店者を過去の在籍月にその月の時給と紹介者で表示する", () => {
  const cast = {
    id: "cast-1", status: "departed" as const, name: "花子", legalName: "山田花子", hiredAt: "2026-10-01", departedAt: "2026-11-01",
    hourlyRates: { "2026-10": 3500, "2026-11": 4400 }, note: "", createdAt: "2026-10-01", updatedAt: "2026-11-01",
    monthlyIntroducers: { "2026-10": { id: "intro-1", name: "10月の紹介者", feeType: "sales10" as const, attendanceAdvisoryFee: 0, entryAdvisoryFee: 0 } },
  };
  drafts.set("common.casts.month", "2026-10");
  const props = { section: "casts" as const, data: { ...data, casts: [cast] }, user, busy: false, run };
  const october = renderToStaticMarkup(createElement(CommonForms, props));
  expect(october).toContain("在籍キャスト<b>1</b>");
  expect(october).toContain("退店キャスト<b>0</b>");
  expect(october).toContain("3,500");
  expect(october).toContain("10月の紹介者");
  expect(october).not.toContain(">退店</button>");

  drafts.set("common.casts.month", "2026-11");
  drafts.set("common.casts.tab", "departed");
  const november = renderToStaticMarkup(createElement(CommonForms, props));
  expect(november).toContain("在籍キャスト<b>0</b>");
  expect(november).toContain("退店キャスト<b>1</b>");
  expect(november).toContain("4,400");

  drafts.set("common.casts.month", "2026-12");
  const december = renderToStaticMarkup(createElement(CommonForms, props));
  expect(december).toContain("退店キャスト<b>0</b>");
  expect(december).not.toContain("花子");
});

describe("体入と在籍で共有する月度紹介者", () => {
  const month = "2026-10";
  const intro = (id: string, name: string): IntroducerRecord => ({
    id, name, feeType: "sales10", attendanceAdvisoryEnabled: false, entryAdvisoryEnabled: false,
    note: "", createdAt: "2026-10-01", updatedAt: "2026-10-01",
  });
  const terms = (record: IntroducerRecord): NonNullable<DailyCast["introducer"]> => ({
    id: record.id, name: record.name, feeType: record.feeType, attendanceAdvisoryFee: 0, entryAdvisoryFee: 0,
  });
  const first = intro("intro-a", "在籍側の紹介者");
  const next = intro("intro-b", "変更先の紹介者");
  const old = intro("intro-trial", "体入時の紹介者");
  const trial: CastRecord = {
    id: "trial-cast", status: "trial", name: "花子", legalName: "山田花子", trialDate: `${month}-01`, convertedToCastId: "member-cast",
    hourlyRates: {}, trialHourlyRate: 3000, monthlyIntroducers: { [month]: terms(old) }, note: "", createdAt: `${month}-01`, updatedAt: `${month}-01`,
  };
  const member: CastRecord = {
    id: "member-cast", status: "departed", name: trial.name, legalName: trial.legalName, hiredAt: `${month}-02`, departedAt: `${month}-12`,
    convertedFromTrialId: trial.id, hourlyRates: { [month]: 4000 }, monthlyIntroducers: { [month]: terms(first) },
    note: "在籍の備考", createdAt: `${month}-02`, updatedAt: `${month}-12`,
  };
  const render = (active = member) => {
    castForm.buttons.clear(); castForm.submit = undefined; castForm.introducer = undefined;
    return renderToStaticMarkup(createElement(CommonForms, {
      section: "casts", data: { ...data, casts: [trial, active], introducers: [first, next, old] }, user, busy: false,
      run: async (action) => { await action(); return true; },
    }));
  };

  beforeEach(() => { drafts.set("common.casts.month", month); drafts.set("common.casts.tab", "trial"); });

  it.each([next.id, ""])("体入側の紹介者変更を在籍IDへ1回だけ保存する（%s）", async (selected) => {
    const listing = render();
    expect(listing).toContain(first.name);
    expect(listing).not.toContain(old.name);
    expect(castForm.buttons.has("紹介者変更")).toBe(true);
    castForm.buttons.get("紹介者変更")!();
    const form = render();
    expect(castForm.introducer?.value).toBe(first.id);
    expect(form).toContain("未確定月は対象月全体に選択した紹介者を適用します。");
    expect(form).not.toContain("月度の体入時給");
    castForm.introducer!.onChange({ target: { value: selected } });
    render();
    await castForm.submit!({ preventDefault() {} });
    expect(saveCast).toHaveBeenCalledTimes(1);
    expect(saveCast).toHaveBeenCalledWith(expect.objectContaining({
      id: member.id, status: "departed", note: member.note, updatedAt: member.updatedAt,
    }), user, month);
    const saved = vi.mocked(saveCast).mock.calls[0][0];
    expect(saved).toHaveProperty("introducerId", selected || undefined);
    expect(saved).not.toHaveProperty("hourlyRates");
  });

  it("体入の通常編集では共有中の紹介者を表示し、体入の紹介者を別に保存しない", async () => {
    render();
    castForm.buttons.get("編集")!();
    const form = render();
    expect(form).toContain(`<output>${first.name}</output>`);
    expect(castForm.introducer).toBeUndefined();
    await castForm.submit!({ preventDefault() {} });
    expect(saveCast).toHaveBeenCalledTimes(1);
    expect(saveCast).toHaveBeenCalledWith(expect.objectContaining({ id: trial.id, trialHourlyRate: 3000 }), user, month);
    expect(vi.mocked(saveCast).mock.calls[0][0]).not.toHaveProperty("introducerId");
  });

  it("翌月に入店した体入記録は体入月の紹介者を独立して編集できる", () => {
    const laterMember = { ...member, hiredAt: "2026-11-02", departedAt: "2026-11-12" };
    const listing = render(laterMember);
    expect(listing).toContain(old.name);
    expect(castForm.buttons.has("紹介者変更")).toBe(false);
    castForm.buttons.get("編集")!();
    render(laterMember);
    expect(castForm.introducer?.value).toBe(old.id);
  });
});
