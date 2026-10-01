import { describe, expect, it } from "vitest";
import type { CastRecord, CastReward, CastSalesDay, CastSalesReport } from "./gms";
import { buildCastSalesRanking, buildCastSalesRankingRoster, normalizeCastSalesRankingRoster, type CastSalesRankingRoster } from "./cast-sales-ranking";

const month = "2026-09";

function day(overrides: Partial<CastSalesDay> = {}): CastSalesDay {
  return {
    businessDate: "2026-09-01", startTime: "20:00", endTime: "02:00", hours: 6,
    honShimeiSales: 100_000, jonaiExtensionSales: 20_000, totalSales: 120_000,
    honShimeiLiquorCost: 10_000, jonaiExtensionLiquorCost: 2_000, totalLiquorCost: 12_000,
    honShimeiCount: 2, banaiShimeiCount: 1, nominationCount: 3, dohanCount: 1,
    backs: [], backTotal: 0, bottles: [], beautyAllowance: 500, ...overrides,
  };
}

function report(id = "cast-1", days = [day()]): CastSalesReport {
  const sum = (key: keyof CastSalesDay) => days.reduce((total, row) => total + Number(row[key] ?? 0), 0);
  return { id, name: `保存名${id}`, attendanceDays: new Set(days.map((row) => row.businessDate)).size, days,
    totals: { hours: sum("hours"), attendanceDays: new Set(days.map((row) => row.businessDate)).size,
      honShimeiSales: sum("honShimeiSales"), jonaiExtensionSales: sum("jonaiExtensionSales"), totalSales: sum("totalSales"),
      ...(days.some((row) => row.additionalSales !== undefined) ? { additionalSales: sum("additionalSales") } : {}),
      honShimeiLiquorCost: sum("honShimeiLiquorCost"), jonaiExtensionLiquorCost: sum("jonaiExtensionLiquorCost"), totalLiquorCost: sum("totalLiquorCost"),
      honShimeiCount: sum("honShimeiCount"), banaiShimeiCount: sum("banaiShimeiCount"), nominationCount: sum("nominationCount"), dohanCount: sum("dohanCount"),
      backs: [], backTotal: 0, bottles: [], beautyAllowance: sum("beautyAllowance") } };
}

function reward(row: CastSalesReport, overrides: Partial<CastReward> = {}): CastReward {
  return { id: row.id, name: row.name, days: row.attendanceDays, advisoryDays: row.attendanceDays, hours: row.totals.hours, trialOnly: false,
    honShimeiSales: row.totals.honShimeiSales, jonaiExtensionSales: row.totals.jonaiExtensionSales,
    ...(row.totals.additionalSales !== undefined ? { additionalSales: row.totals.additionalSales } : {}),
    hourlyPay: 0, liquorCost: 0, honShimeiLiquorCost: 0, honShimeiBack: 0, banaiShimeiBack: 0, dohanBack: 0, bottleBack: 0, drinkBack: 0,
    hourlyAndBack: 0, rewardRate: 0, salesRewardBase: 0, salesReward: 0, adoptedSystem: "hourlyAndBack", adoptedReward: 0,
    beautyAllowance: 0, grossPay: 0, dailyPayment: 0, advancePayment: 0, transportFee: 0, withholding: 0, netPay: 0, ...overrides };
}

function results(reports = [report()]) {
  return { castSalesReports: reports, castRewards: reports.map((row) => reward(row)) };
}

function cast(overrides: Partial<CastRecord> = {}): CastRecord {
  return { id: "cast-1", name: "現行名", legalName: "個人名", status: "active", hiredAt: "2026-09-01", hourlyRates: { [month]: 3_000 },
    note: "", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z", ...overrides };
}

describe("売上順位表の保存名簿", () => {
  it.each([undefined, null])("未保存 %s と保存済み空名簿を区別する", (value) => {
    expect(normalizeCastSalesRankingRoster(value)).toBeUndefined();
    expect(normalizeCastSalesRankingRoster({ schemaVersion: 1 })).toEqual({ schemaVersion: 1, entries: [] });
  });

  it.each([undefined, null, [], {}])("Firebaseの空entries %s を復元する", (entries) => {
    expect(normalizeCastSalesRankingRoster({ schemaVersion: 1, entries })).toEqual({ schemaVersion: 1, entries: [] });
  });

  it("Firebase数値キーの配列を新しいオブジェクトとして復元する", () => {
    const input = { schemaVersion: 1, entries: { 0: { id: "a", name: "あい" }, 1: { id: "b", name: "あい" } } };
    const value = normalizeCastSalesRankingRoster(input)!;
    expect(value).toEqual({ schemaVersion: 1, entries: [{ id: "a", name: "あい" }, { id: "b", name: "あい" }] });
    expect(value.entries[0]).not.toBe(input.entries[0]);
  });

  it.each([
    1, false, "1", [], {}, { schemaVersion: "1" }, { schemaVersion: 2 }, { schemaVersion: 1, extra: 1 },
    { schemaVersion: 1, entries: "bad" }, { schemaVersion: 1, entries: { named: { id: "a", name: "あい" } } },
    { schemaVersion: 1, entries: [null] }, { schemaVersion: 1, entries: [{ id: "", name: "あい" }] },
    { schemaVersion: 1, entries: [{ id: "a", name: " " }] }, { schemaVersion: 1, entries: [{ id: 1, name: "あい" }] },
    { schemaVersion: 1, entries: [{ id: "a", name: "あい", extra: true }] },
    { schemaVersion: 1, entries: [{ id: "a", name: "あい" }, { id: "a", name: "別名" }] },
  ])("不正な名簿を黙って空名簿にしない %#", (value) => {
    expect(() => normalizeCastSalesRankingRoster(value)).toThrow();
  });

  it("入力を変更せず、対象月に在籍する未出勤者を追加する", () => {
    const input = results();
    const masters = [cast(), cast({ id: "zero", name: "未出勤", hiredAt: "2026-09-30" }), cast({ id: "future", hiredAt: "2026-10-01" })];
    const before = structuredClone({ input, masters });
    expect(buildCastSalesRankingRoster(input, masters, month)).toEqual({ schemaVersion: 1,
      entries: [{ id: "cast-1", name: "保存名cast-1" }, { id: "zero", name: "未出勤" }] });
    expect({ input, masters }).toEqual(before);
  });

  it("月初退店・月末採用を含め、前月退店・翌月採用を含めない", () => {
    const roster = buildCastSalesRankingRoster(results([]), [
      cast({ id: "start", status: "departed", hiredAt: "2026-08-01", departedAt: "2026-09-01" }),
      cast({ id: "end", hiredAt: "2026-09-30" }),
      cast({ id: "before", status: "departed", hiredAt: "2026-08-01", departedAt: "2026-08-31" }),
      cast({ id: "after", hiredAt: "2026-10-01" }),
    ], month);
    expect(roster.entries.map((row) => row.id)).toEqual(["end", "start"]);
  });

  it("体入・完全削除・移行元を0円名簿から除き、売上保存済みの退店・マスタ消失者は維持する", () => {
    const input = results([report("departed"), report("deleted"), report("missing"), report("trial-result")]);
    input.castRewards.find((row) => row.id === "trial-result")!.trialOnly = true;
    const roster = buildCastSalesRankingRoster(input, [
      cast({ id: "departed", status: "departed", departedAt: "2026-09-10" }),
      cast({ id: "deleted", deletedAt: "2026-09-10" }),
      cast({ id: "zero-deleted", deletedAt: "2026-09-10" }),
      cast({ id: "trial-result" }),
      cast({ id: "trial", status: "trial", hiredAt: undefined }),
      cast({ id: "converted", convertedToCastId: "departed" }),
    ], month);
    expect(roster.entries.map((row) => row.id)).toEqual(["deleted", "departed", "missing"]);
  });

  it.each([
    { hiredAt: undefined }, { hiredAt: "2026-09-31" }, { status: "departed", departedAt: undefined },
    { departedAt: "2026-08-31" }, { departedAt: "2026-09-31" }, { status: "unknown" },
  ])("月内在籍が判断不能なら推定しない %#", (overrides) => {
    expect(() => buildCastSalesRankingRoster(results([]), [cast(overrides as Partial<CastRecord>)], month)).toThrow();
  });

  it("キャストマスタのID重複を拒否する", () => {
    expect(() => buildCastSalesRankingRoster(results([]), [cast(), cast()], month)).toThrow("重複");
  });
});

describe("売上順位表の集計", () => {
  it("本指名＋場内延長＋追加売上の原価控除前で順位を付け、同額なら1・1・3とする", () => {
    const reports = [report("b", [day({ additionalSales: 30_000, totalSales: 150_000 })]), report("c"),
      report("a", [day({ honShimeiSales: 130_000, totalSales: 150_000, totalLiquorCost: 140_000 })])];
    const input = results(reports);
    const ranking = buildCastSalesRanking(input, month);
    expect(ranking.rosterMissing).toBe(true);
    expect(ranking.rows.map((row) => [row.rank, row.id, row.totalSales])).toEqual([[1, "a", 150_000], [1, "b", 150_000], [3, "c", 120_000]]);
    expect(ranking.rows[1]).toMatchObject({ additionalSales: 30_000, honShimeiCount: 2, banaiShimeiCount: 1, dohanCount: 1, hours: 6 });
  });

  it("体入を除外し、同月入店者の統合済み売上を再集計せず使う", () => {
    const input = results([report("regular", [day(), day({ businessDate: "2026-09-02" })]), report("trial")]);
    input.castRewards[1].trialOnly = true;
    expect(buildCastSalesRanking(input, month).rows).toHaveLength(1);
    expect(buildCastSalesRanking(input, month).rows[0]).toMatchObject({ id: "regular", totalSales: 240_000, hours: 12 });
  });

  it("出勤0回・売上0円の保存名簿を掲載し、同名別IDを保持する", () => {
    const roster: CastSalesRankingRoster = { schemaVersion: 1, entries: [{ id: "b", name: "あい" }, { id: "a", name: "あい" }] };
    const ranking = buildCastSalesRanking(results([]), month, roster);
    expect(ranking.rosterMissing).toBe(false);
    expect(ranking.rows.map((row) => [row.id, row.rank, row.totalSales, row.hours])).toEqual([["a", 1, 0, 0], ["b", 1, 0, 0]]);
  });

  it("確定後の現在マスタを参照せず、保存名簿と保存名・保存値で出力する", () => {
    const input = results();
    const roster = buildCastSalesRankingRoster(input, [cast(), cast({ id: "zero", name: "確定時の名前" })], month);
    roster.entries.find((row) => row.id === "cast-1")!.name = "名簿側旧名";
    input.castRewards[0].name = "報酬側旧名";
    const ranking = buildCastSalesRanking(input, month, roster);
    expect(ranking.rows.map((row) => row.name)).toEqual(["保存名cast-1", "確定時の名前"]);
  });

  it("過去確定月の名簿未保存を注記し、保存済みの在籍勤務者だけを返す", () => {
    const ranking = buildCastSalesRanking(results(), month);
    expect(ranking.rosterMissing).toBe(true);
    expect(ranking.rows.map((row) => row.id)).toEqual(["cast-1"]);
  });

  it("0人の保存済み名簿と未保存を区別する", () => {
    expect(buildCastSalesRanking(results([]), month)).toEqual({ rows: [], rosterMissing: true });
    expect(buildCastSalesRanking(results([]), month, { schemaVersion: 1, entries: [] })).toEqual({ rows: [], rosterMissing: false });
  });

  it("同日複数勤務は出勤日数を重複させず、各保存明細はそのまま加算する", () => {
    const input = results([report("a", [day(), day()])]);
    expect(buildCastSalesRanking(input, month).rows[0]).toMatchObject({ totalSales: 240_000, hours: 12, honShimeiCount: 4 });
  });

  it("旧確定売上に追加売上が無くても0円だけを補完し、保存済みの小数は丸めない", () => {
    const input = results([report("a", [day({ honShimeiSales: 123.45, jonaiExtensionSales: 67.89, totalSales: 191.34, hours: 0.25 })])]);
    expect(buildCastSalesRanking(input, month).rows[0]).toMatchObject({ additionalSales: 0, honShimeiSales: 123.45, totalSales: 191.34, hours: 0.25 });
  });

  it("深夜勤務も保存された営業月・時間を変更しない", () => {
    const input = results([report("a", [day({ businessDate: "2026-09-30", startTime: "23:00", endTime: "02:30", hours: 3.5 })])]);
    expect(buildCastSalesRanking(input, month).rows[0].hours).toBe(3.5);
  });

  it("元データ・入力順・名簿を変更しない", () => {
    const input = results([report("b"), report("a")]);
    const roster = buildCastSalesRankingRoster(input, [], month);
    const before = structuredClone({ input, roster });
    buildCastSalesRanking(input, month, roster);
    expect({ input, roster }).toEqual(before);
  });

  it.each(["2026-9", "2026-00", "2026-13", "", "2026-09-01"])("対象月 %s を拒否する", (value) => {
    expect(() => buildCastSalesRanking(results(), value)).toThrow("対象月");
  });

  it.each(["2026-08-31", "2026-09-31", "2026-10-01", "invalid"])("営業日 %s を拒否する", (date) => {
    expect(() => buildCastSalesRanking(results([report("a", [day({ businessDate: date })])]), month)).toThrow("営業日");
  });

  it("対象月が違う確定snapshotを拒否する", () => {
    expect(() => buildCastSalesRanking({ ...results(), month: "2026-08" }, month)).toThrow("対象月");
  });

  it.each([undefined, null, 1, "false"])("在籍区分 %s を推測しない", (trialOnly) => {
    const input = results();
    input.castRewards[0].trialOnly = trialOnly as unknown as boolean;
    expect(() => buildCastSalesRanking(input, month)).toThrow("在籍・体入区分");
  });

  it.each([undefined, null, NaN, Infinity, -1, "100"])("必須売上 %s の欠損・不正を0円にしない", (value) => {
    const input = results();
    input.castSalesReports[0].totals.honShimeiSales = value as number;
    expect(() => buildCastSalesRanking(input, month)).toThrow("保存名cast-1");
  });

  it.each([null, NaN, -1, "0"])("追加売上の不正値 %s は未保存として補完しない", (value) => {
    const input = results();
    input.castSalesReports[0].totals.additionalSales = value as number;
    expect(() => buildCastSalesRanking(input, month)).toThrow();
  });

  it.each(["totalSales", "honShimeiCount", "banaiShimeiCount", "dohanCount", "hours"] as const)("%s 月合計の不一致を拒否する", (key) => {
    const input = results();
    input.castSalesReports[0].totals[key]++;
    expect(() => buildCastSalesRanking(input, month)).toThrow("一致しません");
  });

  it.each(["days", "hours", "honShimeiSales", "jonaiExtensionSales", "additionalSales"] as const)("報酬%sとの不一致を拒否する", (key) => {
    const input = results();
    input.castRewards[0][key] = (input.castRewards[0][key] || 0) + 1;
    expect(() => buildCastSalesRanking(input, month)).toThrow("一致しません");
  });

  it.each(["castSalesReports", "castRewards"] as const)("%s のID重複を拒否する", (key) => {
    const input = results();
    input[key].push(input[key][0] as CastSalesReport & CastReward);
    expect(() => buildCastSalesRanking(input, month)).toThrow("重複");
  });

  it("報酬と売上のID不一致を明示する", () => {
    const input = results();
    input.castSalesReports[0].id = "別ID";
    expect(() => buildCastSalesRanking(input, month)).toThrow("別ID");
  });

  it("必須明細欠損を推定しない", () => {
    const input = results();
    input.castSalesReports = [];
    expect(() => buildCastSalesRanking(input, month)).toThrow("キャスト売上が保存されていません");
  });

  it("regularが抜けた保存名簿と体入が混入した保存名簿を拒否する", () => {
    const input = results();
    expect(() => buildCastSalesRanking(input, month, { schemaVersion: 1, entries: [] })).toThrow("見つかりません");
    input.castRewards[0].trialOnly = true;
    expect(() => buildCastSalesRanking(input, month, { schemaVersion: 1, entries: [{ id: "cast-1", name: "体入" }] })).toThrow("体入区分");
  });
});
