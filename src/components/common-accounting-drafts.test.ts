import { createElement, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { User } from "firebase/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountingWorkspaceData } from "@/domain/month-accounting";

const drafts = vi.hoisted(() => new Map<string, unknown>());
vi.mock("./update-drafts", () => ({
  useRecoverableState: <T,>(key: string, initial: T | (() => T)) => useState<T>(() => drafts.has(key) ? drafts.get(key) as T : typeof initial === "function" ? (initial as () => T)() : initial),
  useUpdateDraftBusy: () => undefined,
}));
import { CommonForms } from "./common-forms";
import { AccountingForms } from "./accounting-forms";

const user = { uid: "test-user" } as User;
const data: AccountingWorkspaceData = {
  casts: [], staff: [], drivers: [], introducers: [], liquor: [], closings: [], adjustments: [], cashFloat: 200_000,
  archivedCasts: [], archivedStaff: [], introducerEntryEvents: [], introducerDeletionCommits: [], introducerMonthEvents: [], monthStates: [], monthSnapshots: [],
};
const run = vi.fn(async () => true);
beforeEach(() => { drafts.clear(); run.mockClear(); });

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
