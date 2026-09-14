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
    expect(buildCastReceiptSheets([reward], "2026-09")).toEqual([{ name: "花子", cells: {
      G1: "9月報酬分", G2: 12750, G3: 8832, G4: 500, G5: 22082, G6: 3500, G7: 1000, G8: 17582, G10: "花子",
    } }]);
  });
  it("売上報酬採用時は①の見出しと金額を変更し、②を0円とする", () => {
    const saved = { ...reward, adoptedSystem: "salesReward" as const, salesReward: 100000, adoptedReward: 100000, grossPay: 100500, netPay: 96000 };
    const sheet = buildCastReceiptSheets([saved], "2026-12")[0];
    expect(sheet.cells).toMatchObject({ B2: "①　売上報酬　計", G1: "12月報酬分", G2: 100000, G3: 0, G5: 100500, G8: 96000 });
    expect(saved.hourlyPay).toBe(12750);
    expect(saved.bottleBack).toBe(1999);
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
});
