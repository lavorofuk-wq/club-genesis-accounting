import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CastReward } from "@/domain/gms";
import { CastRewards } from "./accounting-forms";

function reward(id: string, name: string, trialOnly: boolean): CastReward {
  return {
    id, name, trialOnly, days: 1, advisoryDays: 1, hours: 3.25,
    hourlyPay: 9_753, honShimeiSales: 0, jonaiExtensionSales: 0,
    liquorCost: 0, honShimeiLiquorCost: 0, honShimeiBack: 0, banaiShimeiBack: 0,
    dohanBack: 0, bottleBack: 0, drinkBack: 0, hourlyAndBack: 9_753,
    rewardRate: 0, salesRewardBase: 0, salesReward: 0, adoptedSystem: "hourlyAndBack",
    adoptedReward: 9_753, beautyAllowance: 500, grossPay: 10_253,
    dailyPayment: 1_000, advancePayment: 300, transportFee: 500,
    withholding: 123, netPay: 8_330,
  };
}
function render(rows: CastReward[], disabled = false) {
  return renderToStaticMarkup(createElement(CastRewards, { rows, disabled, onWithholding: () => {} }));
}
function groups(markup: string) {
  const sections = markup.match(/<section\b[\s\S]*?<\/section>/g) || [];
  expect(sections).toHaveLength(2);
  return sections as [string, string];
}

describe("キャスト報酬の在籍・体入別表示", () => {
  it("月次結果の区分で1人1行へ分け、各区分内の元の順序を保持する", () => {
    const rows = [reward("t1", "体入一", true), reward("r1", "在籍一", false),
      reward("t2", "体入二", true), reward("r2", "在籍二", false)];
    const before = structuredClone(rows);
    const [regular, trial] = groups(render(rows));
    expect(regular).toContain("在籍キャスト報酬（2名）");
    expect(trial).toContain("体入キャスト報酬（2名）");
    expect(regular).not.toContain("体入一");
    expect(trial).not.toContain("在籍一");
    expect(regular).toMatch(/在籍一[\s\S]*在籍二/);
    expect(trial).toMatch(/体入一[\s\S]*体入二/);
    for (const row of rows) expect((regular + trial).split(`<strong>${row.name}</strong>`)).toHaveLength(2);
    expect(rows).toEqual(before);
  });

  it.each([[], [false], [true], [false, true]].map((flags) => ({ flags })))("空の区分も明示する（$flags）", ({ flags }) => {
    const rows = flags.map((trialOnly, index) => reward(`c${index}`, `キャスト${index}`, trialOnly));
    const [regular, trial] = groups(render(rows));
    expect(regular.includes("当月の在籍キャスト報酬データはありません。")).toBe(!flags.includes(false));
    expect(trial.includes("当月の体入キャスト報酬データはありません。")).toBe(!flags.includes(true));
  });

  it("同名別IDの体入キャストを統合せず、それぞれの金額を表示する", () => {
    const rows = [reward("r", "同名", false), reward("t1", "同名", true),
      { ...reward("t2", "同名", true), withholding: 456, netPay: 7_997 }];
    const [regular, trial] = groups(render(rows));
    expect(regular.match(/<input /g)).toHaveLength(1);
    expect(trial.match(/<input /g)).toHaveLength(2);
    expect(trial.match(/<strong>同名<\/strong>/g)).toHaveLength(2);
    expect(trial).toContain('value="123"');
    expect(trial).toContain('value="456"');
    expect(trial).toContain("￥8,330");
    expect(trial).toContain("￥7,997");
  });

  it.each([false, true])("両区分とも金額・入力禁止状態をそのまま引き継ぐ（disabled=%s）", (disabled) => {
    for (const group of groups(render([reward("r", "在籍", false), reward("t", "体入", true)], disabled))) {
      expect(group).toContain("￥9,753");
      expect(group).toContain("￥10,253");
      expect(group).toContain("￥8,330");
      expect(group).toContain("1日 / 3.25時間");
      expect(group).toContain('value="123"');
      expect(/<input[^>]*disabled/.test(group)).toBe(disabled);
    }
  });
});
