import { describe, expect, it } from "vitest";
import type { CastReward } from "./gms";
import type { IntroducerPaymentRow } from "./month-accounting";
import { groupIntroducerPayments, summarizeExpenseIntroducers } from "./expense-export";

function payment(introducerId: string, castId: string, overrides: Partial<IntroducerPaymentRow> = {}): IntroducerPaymentRow {
  return {
    id: `${introducerId}_${castId}`, introducerId, castId, introducer: "紹介者A", cast: "あかり", feeType: "sales10",
    honShimeiLiquorCost: 100, salesBase: 10000, salesFee: 1000, grossBase: 5000, grossFee: 500,
    adopted: "売上10%", attendanceAdvisory: 100, entryAdvisory: 500, advisory: 600, total: 1600,
    ...overrides,
  };
}

// 旧確定データの人物照合で参照される保存済みフィールドだけのfixture。
function reward(castId: string, introducerId: string): CastReward {
  return { id: castId, name: "現在名で補完しない", introducer: { id: introducerId, name: "名称変更後",
    feeType: "sales10", attendanceAdvisoryFee: 0, entryAdvisoryFee: 0 } } as CastReward;
}

function oldPayment(row: IntroducerPaymentRow): IntroducerPaymentRow {
  const { introducerId: _introducerId, castId: _castId, ...legacy } = row;
  return legacy;
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
  return value;
}

describe("紹介者一覧とキャスト詳細の共通集約", () => {
  it("同一紹介者の2人分を合計し、詳細にはその紹介者の行だけを含める", () => {
    const first = payment("intro-1", "cast-1");
    const second = payment("intro-1", "cast-2", { cast: "いずみ", salesBase: 20000, salesFee: 2000, total: 2600 });
    const other = payment("intro-2", "cast-3", { introducer: "紹介者B", cast: "うみ", total: 3600 });
    const input = { introducerPayments: [other, second, first], castRewards: [] };
    const groups = groupIntroducerPayments(input);
    expect(groups).toEqual([
      { id: "intro-1", name: "紹介者A", total: 4200, rows: [first, second] },
      { id: "intro-2", name: "紹介者B", total: 3600, rows: [other] },
    ]);
    expect(groups.flatMap((group) => group.rows.map((row) => row.id)).sort())
      .toEqual(input.introducerPayments.map((row) => row.id).sort());
    expect(groups.every((group) => group.total === group.rows.reduce((sum, row) => sum + row.total, 0))).toBe(true);
    expect(summarizeExpenseIntroducers(input)).toEqual(groups.map(({ id, name, total }) => ({ id, name, total })));
  });

  it("同名の別IDは別一覧・別詳細とし、同一IDの異なる保存名は併記する", () => {
    const first = payment("intro-1", "cast-1", { introducer: "A紹介者" });
    const second = payment("intro-1", "cast-2", { introducer: "B紹介者", cast: "いずみ" });
    const other = payment("intro-2", "cast-3", { introducer: "A紹介者" });
    const groups = groupIntroducerPayments({ introducerPayments: [first, other, second], castRewards: [] });
    expect(groups.find((group) => group.id === "intro-1"))
      .toEqual({ id: "intro-1", name: "A紹介者／B紹介者", total: 3200, rows: [first, second] });
    expect(groups.find((group) => group.id === "intro-2"))
      .toEqual({ id: "intro-2", name: "A紹介者", total: 1600, rows: [other] });
  });

  it("紹介者・キャストの表示順は入力順によらず、同名キャストをIDで区別する", () => {
    const rows = [
      payment("intro-2", "cast-z", { introducer: "B紹介者", cast: "いずみ" }),
      payment("intro-1", "cast-b", { introducer: "A紹介者", cast: "同名" }),
      payment("intro-1", "cast-a", { introducer: "A紹介者", cast: "同名" }),
      payment("intro-2", "cast-y", { introducer: "B紹介者", cast: "あかり" }),
    ];
    const groups = groupIntroducerPayments({ introducerPayments: rows, castRewards: [] });
    expect(groupIntroducerPayments({ introducerPayments: [...rows].reverse(), castRewards: [] })).toEqual(groups);
    expect(groups.map((group) => group.id)).toEqual(["intro-1", "intro-2"]);
    expect(groups[0].rows.map((row) => row.castId)).toEqual(["cast-a", "cast-b"]);
    expect(groups[1].rows.map((row) => row.cast)).toEqual(["あかり", "いずみ"]);
  });

  it("旧確定snapshotのIDは保存済キャスト報酬と照合し、詳細の名称・金額・欠損IDを変更しない", () => {
    const legacy = oldPayment(payment("intro-1", "cast-1", { introducer: "当時の紹介者", cast: "当時のキャスト", total: 1601 }));
    const input = { introducerPayments: [legacy], castRewards: [reward("cast-1", "intro-1")] };
    expect(groupIntroducerPayments(input)).toEqual([{ id: "intro-1", name: "当時の紹介者", total: 1601, rows: [legacy] }]);
    expect(legacy).not.toHaveProperty("introducerId");
    expect(legacy).not.toHaveProperty("castId");
  });

  it("出勤なし旧入店顧問料はGMS生成IDを厳密に復元し、その支払行を詳細に残す", () => {
    const introducerId = `introducer_${"a".repeat(32)}`;
    const legacy = oldPayment(payment(introducerId, `cast_${"b".repeat(32)}`, {
      salesBase: 0, salesFee: 0, grossBase: 0, grossFee: 0, attendanceAdvisory: 0,
      entryAdvisory: 500, advisory: 500, total: 500,
    }));
    expect(groupIntroducerPayments({ introducerPayments: [legacy], castRewards: [] }))
      .toEqual([{ id: introducerId, name: "紹介者A", total: 500, rows: [legacy] }]);
  });

  it("凍結した新旧の支払行・報酬・配列を改変せず、保存済み1円単位の内訳も保持する", () => {
    const legacy = oldPayment(payment("intro-1", "cast-b", { cast: "いずみ", salesFee: 1001, total: 1601 }));
    const current = payment("intro-1", "cast-a", { salesFee: 1002, total: 1602 });
    const input = freeze({ introducerPayments: [legacy, current], castRewards: [reward("cast-b", "intro-1")] });
    const before = structuredClone(input);
    expect(groupIntroducerPayments(input)).toEqual([{ id: "intro-1", name: "紹介者A", total: 3203, rows: [current, legacy] }]);
    expect(input).toEqual(before);
  });

  it("人物IDが曖昧な旧行は推測してどちらかへ所属させない", () => {
    const legacy = oldPayment(payment("intro_a", "cast-1"));
    expect(() => groupIntroducerPayments({ introducerPayments: [legacy],
      castRewards: [reward("cast-1", "intro_a"), reward("a_cast-1", "intro")] }))
      .toThrow("紹介者IDを一意に確認できません");
  });

  it.each([
    ["複合ID不一致", [{ ...payment("intro-1", "cast-1"), castId: "different" }]],
    ["片方だけの人物ID", [{ ...payment("intro-1", "cast-1"), castId: undefined }]],
    ["人物ID不明", [oldPayment(payment("intro-1", "cast-1"))]],
    ["重複支払行", [payment("intro-1", "cast-1"), payment("intro-1", "cast-1")]],
  ] as const)("%s は誤った一覧・詳細を生成せず停止する", (_label, rows) => {
    expect(() => groupIntroducerPayments({ introducerPayments: [...rows], castRewards: [] })).toThrow();
  });

  it("支払対象がない場合は空一覧を返す", () => {
    expect(groupIntroducerPayments({ introducerPayments: [], castRewards: [] })).toEqual([]);
  });
});
