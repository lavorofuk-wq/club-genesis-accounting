import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CastReward } from "@/domain/gms";
import type { IntroducerPaymentRow } from "@/domain/month-accounting";
import { IntroducerPayments } from "./introducer-payments";

const harness = vi.hoisted(() => ({
  values: [] as unknown[],
  cursor: 0,
  buttons: [] as Array<{ label: string; click: () => void }>,
}));

// ブラウザの代用ではなく、公開されたクリック処理と次回描画の対応を検証する。
// DOM依存を追加せず、1回ごとのSSRの間でこのコンポーネントのstateだけを保持する。
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState<T>(initial: T | (() => T)) {
      const index = harness.cursor++;
      if (!(index in harness.values)) harness.values[index] = typeof initial === "function" ? (initial as () => T)() : initial;
      return [harness.values[index] as T, (next: T | ((previous: T) => T)) => {
        harness.values[index] = typeof next === "function" ? (next as (previous: T) => T)(harness.values[index] as T) : next;
      }];
    },
  };
});

vi.mock("./ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ui")>();
  const react = await import("react");
  const collect = (value: import("react").ReactNode) => {
    if (Array.isArray(value)) { value.forEach(collect); return; }
    if (!react.isValidElement<{ children?: import("react").ReactNode; onClick?: () => void }>(value)) return;
    if (value.type === "button" && value.props.onClick && typeof value.props.children === "string") {
      harness.buttons.push({ label: value.props.children, click: value.props.onClick });
    }
    collect(value.props.children);
  };
  return {
    ...actual,
    Table(props: Parameters<typeof actual.Table>[0]) {
      collect(props.children);
      return react.createElement(actual.Table, props);
    },
  };
});

function payment(introducerId: string, castId: string, patch: Partial<IntroducerPaymentRow> = {}): IntroducerPaymentRow {
  return {
    id: `${introducerId}_${castId}`, introducerId, castId,
    introducer: "紹介者A", cast: castId === "cast-1" ? "花子" : "美咲",
    feeType: "netSales10", honShimeiLiquorCost: 12500,
    salesBase: 112500, salesFee: 11250, grossBase: 88000, grossFee: 8800,
    adopted: "原価引き売上10%", attendanceAdvisory: 2000, entryAdvisory: 3000, advisory: 5000, total: 16250,
    ...patch,
  };
}

function reward(castId: string, introducerId: string): CastReward {
  return {
    id: castId, name: "保存時のキャスト名", days: 1, advisoryDays: 1, hours: 6, trialOnly: false,
    hourlyPay: 18000, honShimeiSales: 125000, jonaiExtensionSales: 0, liquorCost: 12500,
    honShimeiLiquorCost: 12500, honShimeiBack: 0, banaiShimeiBack: 0, dohanBack: 0,
    bottleBack: 0, drinkBack: 0, hourlyAndBack: 18000, rewardRate: 0, salesRewardBase: 0,
    salesReward: 0, adoptedSystem: "hourlyAndBack", adoptedReward: 18000, beautyAllowance: 0,
    grossPay: 18000, dailyPayment: 0, advancePayment: 0, transportFee: 0, withholding: 0, netPay: 18000,
    introducer: { id: introducerId, name: "現在名とは違う保存名", feeType: "netSales10", attendanceAdvisoryFee: 0, entryAdvisoryFee: 0 },
  };
}

function render(rows: IntroducerPaymentRow[], castRewards: CastReward[] = []) {
  harness.cursor = 0;
  harness.buttons = [];
  return renderToStaticMarkup(createElement(IntroducerPayments, { rows, castRewards }));
}

function click(label: string, index = 0) {
  const target = harness.buttons.filter((button) => button.label === label)[index];
  expect(target, `「${label}」ボタンがある`).toBeDefined();
  target.click();
}

beforeEach(() => { harness.values = []; harness.cursor = 0; harness.buttons = []; });

describe("紹介者支払の合計一覧と詳細", () => {
  it("初期表示は紹介者単位の4列一覧で、キャスト内訳を展開しない", () => {
    const rows = [payment("intro-a", "cast-1"), payment("intro-a", "cast-2", { total: 7000 })];
    const markup = render(rows);
    expect([...markup.matchAll(/<th>(.*?)<\/th>/g)].map((match) => match[1])).toEqual(["紹介者", "対象キャスト数", "支払合計", "操作"]);
    expect(markup).toContain("紹介者A");
    expect(markup).toContain("23,250");
    expect(markup).toContain("<td>2人</td>");
    expect(markup).toContain("総合計");
    expect(markup).not.toContain("花子");
    expect(markup).not.toContain("美咲");
    expect(harness.buttons.filter((button) => button.label === "詳細")).toHaveLength(1);
  });

  it("詳細を押すと同じ紹介者行の直下に全項目を表示し、閉じると一覧に戻る", () => {
    const rows = [payment("intro-a", "cast-1")];
    render(rows);
    click("詳細");
    const expanded = render(rows);
    for (const header of ["紹介者", "対象キャスト", "本指名酒代原価", "売上算定額", "売上10%", "総支給額", "総支給10%", "採用タイプ", "出勤顧問料", "入店顧問料", "支払合計"]) {
      expect(expanded).toContain(`<th>${header}</th>`);
    }
    for (const text of ["花子", "12,500", "112,500", "11,250", "88,000", "8,800", "原価引き売上10%", "2,000", "3,000", "16,250"]) {
      expect(expanded).toContain(text);
    }
    expect(expanded).toMatch(/<\/tr><tr[^>]*><td colSpan="4"/);
    expect(expanded).toContain('aria-expanded="true"');
    click("閉じる");
    expect(render(rows)).not.toContain("花子");
  });

  it("別の紹介者を開くと前の詳細を閉じ、選択した紹介者だけを表示する", () => {
    const rows = [payment("intro-a", "cast-1"), payment("intro-b", "cast-2", { introducer: "紹介者B" })];
    render(rows);
    click("詳細", 0);
    const first = render(rows);
    expect(first).toContain("花子");
    expect(first).not.toContain("美咲");
    click("詳細");
    const second = render(rows);
    expect(second).not.toContain("花子");
    expect(second).toContain("美咲");
    expect(harness.buttons.filter((button) => button.label === "閉じる")).toHaveLength(1);
  });

  it("同名の別紹介者IDを別々の一覧・詳細として表示する", () => {
    const rows = [payment("intro-a", "cast-1", { total: 1234 }), payment("intro-b", "cast-2", { total: 5678 })];
    const markup = render(rows);
    expect(harness.buttons.filter((button) => button.label === "詳細")).toHaveLength(2);
    expect(markup).toContain("1,234");
    expect(markup).toContain("5,678");
    expect(markup).toContain("6,912");
    expect(markup).toContain("ID: intro-a");
    expect(markup).toContain("ID: intro-b");
    click("詳細", 1);
    const expanded = render(rows);
    expect(expanded).toContain("美咲");
    expect(expanded).not.toContain("花子");
  });

  it("人物IDを保存済み報酬から厳密に確認できる旧形式を紹介者単位に表示する", () => {
    const legacy = payment("intro-a", "cast-1");
    delete legacy.introducerId;
    delete legacy.castId;
    const markup = render([legacy], [reward("cast-1", "intro-a")]);
    expect(harness.buttons.filter((button) => button.label === "詳細")).toHaveLength(1);
    expect(markup).toContain("紹介者A");
    expect(markup).not.toContain("花子");
    expect(markup).not.toContain('role="alert"');
  });

  it("集約できない旧形式ではページを壊さず、警告と元のキャスト別明細を表示する", () => {
    const legacy = payment("unknown", "cast-1");
    delete legacy.introducerId;
    delete legacy.castId;
    const markup = render([legacy]);
    expect(markup).toContain("紹介者IDを一意に確認できません");
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("保存済みのキャスト別明細を表示しています");
    expect(markup).toContain("花子");
    expect(markup).toContain("16,250");
    expect(markup).toContain("本指名酒代原価");
    expect(harness.buttons.filter((button) => button.label === "詳細")).toHaveLength(0);
  });

  it("空データも表示でき、元の金額や人物情報を変更しない", () => {
    expect(render([])).toContain("この月の紹介者支払データはありません。");
    const rows = [payment("intro-a", "cast-1"), payment("intro-a", "cast-2")];
    const rewards = [reward("cast-1", "intro-a")];
    const before = structuredClone({ rows, rewards });
    render(rows, rewards);
    click("詳細");
    render(rows, rewards);
    expect({ rows, rewards }).toEqual(before);
  });
});
