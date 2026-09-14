import { describe, expect, it } from "vitest";
import type { CastReward } from "./gms";
import { buildCastReceiptSheets } from "./cast-receipt";

const reward: CastReward = {
  id: "cast-1", name: "花子", days: 1, advisoryDays: 1, hours: 4.25, trialOnly: false,
  hourlyPay: 12750, honShimeiSales: 40000, jonaiExtensionSales: 10000,
  liquorCost: 15000, honShimeiLiquorCost: 10000,
  honShimeiBack: 2000, banaiShimeiBack: 500, dohanBack: 4000, bottleBack: 1999, drinkBack: 333,
  hourlyAndBack: 21582, rewardRate: 0, salesRewardBase: 42500, salesReward: 0,
  adoptedSystem: "hourlyAndBack", adoptedReward: 21582, beautyAllowance: 500, grossPay: 22082,
  dailyPayment: 1000, advancePayment: 2000, transportFee: 500, withholding: 1000, netPay: 17582,
};

describe("キャスト報酬から受領書への転記", () => {
  it("時給・全5種類のバック・美容室・日払立替送迎・源泉・差引を指定欄へ出す", () => {
    expect(buildCastReceiptSheets([reward], "2026-09")).toMatchObject([{ template: "hourlyAndBack", name: "花子", cells: {
      G1: "9月報酬分", G2: 12750, G3: 8832, G4: 500, G5: 22082, G6: 3500, G7: 1000, G8: 17582, G10: "花子",
    } }]);
  });
  it("売上報酬採用時は専用様式の6項目へ転記し、保存された採用率を見出しに記載する", () => {
    const saved = { ...reward, adoptedSystem: "salesReward" as const, rewardRate: .65, salesReward: 100000, adoptedReward: 100000, grossPay: 100500, netPay: 96000 };
    const sheet = buildCastReceiptSheets([saved], "2026-12")[0];
    expect(sheet).toMatchObject({ template: "salesReward", name: "花子", cells: {
      B2: "①　日売上－酒代（50％）×65％", G1: "12月報酬分", G2: 100000, G3: 500, G4: 100500, G5: 3500, G6: 1000, G7: 96000, G9: "花子",
    } });
    expect(saved.hourlyPay).toBe(12750);
    expect(saved.bottleBack).toBe(1999);
  });
  it.each([.5, .6, .7, .8, .655])("旧確定を含む保存率%sを表示し、現在の基準率で再計算しない", (rewardRate) => {
    const saved = { ...reward, id: "sales-cast", adoptedSystem: "salesReward" as const, rewardRate, salesReward: 123456, adoptedReward: 123456, grossPay: 123956, netPay: 119456 };
    const sheets = buildCastReceiptSheets([saved, reward], "2026-09");
    expect(sheets[0].template).toBe("salesReward");
    expect(sheets[1].template).toBe("hourlyAndBack");
    expect(sheets[0].cells.B2).toBe(`①　日売上－酒代（50％）×${rewardRate * 100}％`);
    expect(sheets[0].cells.G2).toBe(123456);
    expect(sheets[0].cells.G7).toBe(119456);
  });
  it.each([undefined, NaN, 0, -1, 1.01])("売上報酬の保存率%sが不正なら50％等で補完せず停止する", (rewardRate) => {
    expect(() => buildCastReceiptSheets([{ ...reward, adoptedSystem: "salesReward", rewardRate } as CastReward], "2026-09")).toThrow("不一致");
  });
  it("旧確定の1円・小数端数や0円・マイナスの保存金額を丸め直さない", () => {
    const saved = { ...reward, hourlyPay: 12750.5, hourlyAndBack: 21582.5, adoptedReward: 21582.5, grossPay: 22082.5, netPay: 17582.5 };
    expect(buildCastReceiptSheets([saved], "2026-09")[0].cells.G8).toBe(17582.5);
    for (const netPay of [0, -1000]) {
      expect(buildCastReceiptSheets([{ ...reward, netPay, withholding: 18582 - netPay }], "2026-09")[0].cells.G8).toBe(netPay);
    }
  });
  it("キャストごとに保存された名前・方式・金額を使い、入力を変更しない", () => {
    const rows = [reward, { ...reward, id: "trial", name: "体入キャスト", trialOnly: true }];
    const before = structuredClone(rows);
    const sheets = buildCastReceiptSheets(rows, "2026-09");
    expect(sheets.map((sheet) => sheet.cells.G10)).toEqual(["花子", "体入キャスト"]);
    expect(rows).toEqual(before);
  });
  it.each(["grossPay", "netPay", "hourlyAndBack", "adoptedReward", "bottleBack", "dailyPayment"] as const)("%sが内訳と不一致なら停止する", (key) => {
    expect(() => buildCastReceiptSheets([{ ...reward, [key]: reward[key] + 1 }], "2026-09")).toThrow("不一致");
  });
  it("対象月・識別情報・金額の欠損・重複を0で補完しない", () => {
    expect(() => buildCastReceiptSheets([reward], "2026-13")).toThrow("対象月");
    expect(() => buildCastReceiptSheets([], "2026-09")).toThrow("ありません");
    expect(() => buildCastReceiptSheets([reward, reward], "2026-09")).toThrow("識別情報");
    for (const change of [{ name: "" }, { id: "" }, { withholding: NaN }, { grossPay: Infinity }, { beautyAllowance: undefined }, { dailyPayment: -1 }]) {
      expect(() => buildCastReceiptSheets([{ ...reward, ...change } as CastReward], "2026-09")).toThrow();
    }
  });
  it("時給明細の内訳と受領書の支給・控除・差引が一致し、本名と未保存時給を表示する", () => {
    const sheet = buildCastReceiptSheets([reward], "2026-09", { "cast-1": "山田花子" })[0];
    expect(sheet.statementCells).toEqual({
      D3: "2026年9月分", F4: "花子", E5: "山田花子", F6: 1, F7: 4.25, F8: "未保存",
      F9: 12750, F10: 2000, F11: 500, F12: 4000, F13: 1999, F14: 333, F15: 500,
      F18: 22082, F19: 1000, F20: 1000, F21: 500, F22: 2000, F25: 4500, F26: 17582,
    });
    expect(sheet.statementCells.F26).toBe(sheet.cells.G8);
    expect(sheet.statementCells).not.toHaveProperty("F16");
    expect(sheet.statementCells).not.toHaveProperty("F23");
    expect(buildCastReceiptSheets([reward], "2026-09")[0].statementCells.E5).toBe("");
  });
  it("売上明細に保存された売上・酒代50％・採用率・採用額を使う", () => {
    const sheet = buildCastReceiptSheets([{ ...reward, adoptedSystem: "salesReward", rewardRate: .65,
      salesReward: 100000, adoptedReward: 100000, grossPay: 100500, netPay: 96000 }], "2026-09")[0];
    expect(sheet.statementCells).toMatchObject({ F9: 50000, F10: 7500, B11: "報酬率", F11: 65, F12: 100000, F18: 100500, F26: 96000 });
    expect(sheet.statementCells).not.toHaveProperty("F13");
    expect(sheet.statementCells).not.toHaveProperty("F14");
    expect(sheet.statementCells.F26).toBe(sheet.cells.G7);
  });
  it("単一時給は数値、複数時給は重複を除き併記し、未保存を平均額で推定しない", () => {
    expect(buildCastReceiptSheets([{ ...reward, appliedHourlyRates: [3000] }], "2026-09")[0].statementCells.F8).toBe(3000);
    expect(buildCastReceiptSheets([{ ...reward, appliedHourlyRates: [4000, 3000, 4000] }], "2026-09")[0].statementCells.F8).toBe("3,000 / 4,000");
    expect(buildCastReceiptSheets([reward], "2026-09")[0].statementCells.F8).toBe("未保存");
    for (const appliedHourlyRates of [[], [NaN], [-1], [Infinity]]) {
      expect(() => buildCastReceiptSheets([{ ...reward, appliedHourlyRates }], "2026-09")).toThrow("不一致");
    }
  });
});
