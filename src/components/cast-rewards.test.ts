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

describe("キャスト報酬の給率表示", () => {
  it.each([
    { adoptedReward: 0, sales: 10_000, label: "0.0%", tone: "blue" },
    { adoptedReward: 9_999, sales: 10_000, label: "99.9%", tone: "blue" },
    { adoptedReward: 10_000, sales: 10_000, label: "100.0%", tone: "yellow" },
    { adoptedReward: 10_999, sales: 10_000, label: "109.9%", tone: "yellow" },
    { adoptedReward: 11_000, sales: 10_000, label: "110.0%", tone: "red" },
    { adoptedReward: 234_567, sales: 10_000, label: "2345.6%", tone: "red" },
    { adoptedReward: 2.9, sales: 10, label: "29.0%", tone: "blue" },
    { adoptedReward: 32.3, sales: 100, label: "32.3%", tone: "blue" },
    { adoptedReward: 1.21, sales: 1.1, label: "110.0%", tone: "red" },
    { adoptedReward: 29, sales: 10_000, label: "0.2%", tone: "blue" },
    { adoptedReward: 1, sales: 3, label: "33.3%", tone: "blue" },
    { adoptedReward: 1.23456, sales: 7.89, label: "15.6%", tone: "blue" },
    { adoptedReward: 1.1e-7, sales: 1e-7, label: "110.0%", tone: "red" },
    { adoptedReward: 1e22, sales: 1e22, label: "100.0%", tone: "yellow" },
    { adoptedReward: Number.MAX_SAFE_INTEGER, sales: 10, label: "90071992547409910.0%", tone: "red" },
  ])("両区分で小数1桁へ切り捨て、実際の給率で色を分ける（$label / $tone）", ({ adoptedReward, sales, label, tone }) => {
    const rows = [false, true].map((trialOnly, index) => ({
      ...reward(`c${index}`, `キャスト${index}`, trialOnly), adoptedReward, honShimeiSales: sales,
    }));
    for (const group of groups(render(rows))) {
      expect(group.match(/class="cast-pay-ratio cast-pay-ratio--([^"]+)"[^>]*>([^<]*)</)?.slice(1)).toEqual([tone, label]);
    }
  });

  it.each([0, 9_753])("売上が0円なら報酬額にかかわらず赤い売上0円を表示する（報酬=%s）", (adoptedReward) => {
    for (const group of groups(render([false, true].map((trialOnly, index) => ({
      ...reward(`c${index}`, `キャスト${index}`, trialOnly), adoptedReward,
    }))))) {
      expect(group.match(/class="cast-pay-ratio cast-pay-ratio--([^"]+)"[^>]*>([^<]*)</)?.slice(1)).toEqual(["red", "売上0円"]);
      expect(group).not.toMatch(/(?:NaN|Infinity)%/);
    }
  });

  it.each([
    { additionalSales: 0, label: "110.0%", tone: "red" },
    { additionalSales: 1_000, label: "100.0%", tone: "yellow" },
    { additionalSales: 2_000, label: "91.6%", tone: "blue" },
  ])("追加売上を本指名・場内延長売上へ加え、色の境界にも反映する（追加売上=$additionalSales）", ({ additionalSales, label, tone }) => {
    const markup = render([{
      ...reward("r", "在籍", false), adoptedReward: 11_000,
      honShimeiSales: 6_000, jonaiExtensionSales: 4_000, additionalSales,
    }]);
    expect(markup.match(/class="cast-pay-ratio cast-pay-ratio--([^"]+)"[^>]*>([^<]*)</)?.slice(1)).toEqual([tone, label]);
  });

  it.each([
    { adoptedReward: 0.3, tone: "yellow", label: "100.0%" },
    { adoptedReward: 0.33, tone: "red", label: "110.0%" },
  ])("小数の売上を合算しても色の境界と表示を維持する（$label）", ({ adoptedReward, tone, label }) => {
    const markup = render([{
      ...reward("r", "在籍", false), adoptedReward,
      honShimeiSales: 0.1, jonaiExtensionSales: 0.2,
    }]);
    expect(markup.match(/class="cast-pay-ratio cast-pay-ratio--([^"]+)"[^>]*>([^<]*)</)?.slice(1)).toEqual([tone, label]);
  });

  it("追加売上未保存の確定月は0円として扱い、保存済みの報酬・入力を変更しない", () => {
    const rows = [false, true].map((trialOnly, index) => ({
      ...reward(`c${index}`, `キャスト${index}`, trialOnly),
      honShimeiSales: 10_000, jonaiExtensionSales: 5_000,
    }));
    const before = structuredClone(rows);
    for (const group of groups(render(rows, true))) {
      expect(group.match(/class="cast-pay-ratio cast-pay-ratio--([^"]+)"[^>]*>([^<]*)</)?.slice(1)).toEqual(["blue", "65.0%"]);
      expect(group).toContain("￥9,753");
      expect(group).toContain("￥10,253");
      expect(group).toContain("￥8,330");
      expect(group).toContain('value="123"');
      expect(group.match(/<input /g)).toHaveLength(1);
      expect(group).toMatch(/<input[^>]*disabled/);
    }
    expect(rows).toEqual(before);
    for (const row of rows) expect(row).not.toHaveProperty("additionalSales");
  });

  it("美容室・追加手当・控除を給率へ含めず、売上から酒代原価を引かない", () => {
    const row: CastReward = {
      ...reward("r", "在籍", false), adoptedReward: 10_000,
      hourlyAndBack: 8_000, salesReward: 10_000, adoptedSystem: "salesReward",
      honShimeiSales: 5_000, jonaiExtensionSales: 5_000, additionalSales: 10_000,
      liquorCost: 8_000, honShimeiLiquorCost: 6_000, salesRewardBase: 16_000,
      beautyAllowance: 3_000, additionalAllowance: 7_000, grossPay: 20_000,
      dailyPayment: 1_000, advancePayment: 2_000, transportFee: 3_000,
      additionalTransportFee: 500, withholding: 4_000, netPay: 10_000,
    };
    const before = structuredClone(row);
    const markup = render([row]);
    expect(markup.match(/class="cast-pay-ratio cast-pay-ratio--([^"]+)"[^>]*>([^<]*)</)?.slice(1)).toEqual(["blue", "50.0%"]);
    expect(row).toEqual(before);
  });

  it("在籍・体入とも採用と美容室の間へ給率列を追加し、全16列の対応を保つ", () => {
    for (const group of groups(render([reward("r", "在籍", false), reward("t", "体入", true)]))) {
      const headers = [...group.matchAll(/<th\b[^>]*>(.*?)<\/th>/g)].map((match) => match[1]);
      const cells = [...group.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((match) => match[1]);
      expect(headers).toEqual(["キャスト", "勤務", "基本報酬", "指名・同伴内訳", "ボトル", "ドリンク", "酒代原価", "売上報酬", "採用", "給率", "美容室", "追加手当", "総支給", "日払・立替・送迎内訳", "源泉所得税", "差引支給"]);
      expect(cells).toHaveLength(16);
      expect(cells[8]).toContain("￥9,753");
      expect(cells[9]).toContain("cast-pay-ratio");
      expect(cells[10]).toBe("￥500");
      expect(cells[14]).toContain('value="123"');
      expect(cells[15]).toContain("￥8,330");
    }
  });

  it.each([
    { label: "採用報酬NaN", override: { adoptedReward: Number.NaN } },
    { label: "本指名売上Infinity", override: { honShimeiSales: Number.POSITIVE_INFINITY } },
    { label: "場内延長売上NaN", override: { jonaiExtensionSales: Number.NaN } },
    { label: "追加売上Infinity", override: { additionalSales: Number.POSITIVE_INFINITY } },
    { label: "採用報酬負数", override: { adoptedReward: -1 } },
    { label: "本指名売上負数", override: { honShimeiSales: -1 } },
    { label: "場内延長売上負数", override: { jonaiExtensionSales: -1 } },
    { label: "追加売上負数", override: { additionalSales: -1 } },
    // 型では必須でも、旧保存データの破損で欠落している場合を再現する。
    { label: "採用報酬未保存", override: { adoptedReward: undefined as unknown as number } },
    { label: "本指名売上未保存", override: { honShimeiSales: undefined as unknown as number } },
    { label: "場内延長売上未保存", override: { jonaiExtensionSales: undefined as unknown as number } },
  ])("計算元の異常値を赤い計算不可で示す（$label）", ({ override }) => {
    const row = { ...reward("r", "在籍", false), honShimeiSales: 10_000, ...override };
    const before = structuredClone(row);
    const markup = render([row], true);
    expect(markup.match(/class="cast-pay-ratio cast-pay-ratio--([^"]+)"[^>]*>([^<]*)</)?.slice(1)).toEqual(["red", "計算不可"]);
    expect(markup).not.toMatch(/(?:NaN|Infinity)%/);
    expect(row).toEqual(before);
  });
});
