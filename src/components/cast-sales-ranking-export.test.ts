import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  values: [] as unknown[], cursor: 0, cleanups: [] as (() => void)[],
  ranking: { rows: [{ castId: "cast", name: "花子", totalSales: 0 }], rosterMissing: false },
  build: vi.fn(), create: vi.fn(), serialize: vi.fn(), download: vi.fn(), busy: vi.fn(),
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: <T,>(initial: T) => {
      const index = harness.cursor++;
      if (!(index in harness.values)) harness.values[index] = initial;
      return [harness.values[index], (value: T) => { harness.values[index] = value; }];
    },
    useRef: <T,>(initial: T) => {
      const index = harness.cursor++;
      if (!(index in harness.values)) harness.values[index] = { current: initial };
      return harness.values[index];
    },
    useEffect: (effect: () => (() => void) | void) => {
      const index = harness.cursor++;
      if (!(index in harness.values)) {
        harness.values[index] = true;
        const cleanup = effect();
        if (cleanup) harness.cleanups.push(cleanup);
      }
    },
    useMemo: <T,>(factory: () => T) => factory(),
  };
});
vi.mock("./update-drafts", () => ({ useUpdateDraftBusy: harness.busy }));
vi.mock("@/domain/cast-sales-ranking", () => ({ buildCastSalesRanking: harness.build }));
vi.mock("@/lib/xlsx/cast-sales-ranking", () => ({ createCastSalesRankingWorkbook: harness.create }));
vi.mock("@/lib/xlsx/receipt-template", () => ({ downloadReceiptFile: harness.download }));
import { CastSalesRankingExport } from "./cast-sales-ranking-export";

type Props = Parameters<typeof CastSalesRankingExport>[0];
type Element = ReactElement<Record<string, any>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.action as ReactNode), ...elements(element.props.children as ReactNode)];
}
function button(node: ReactNode) {
  const result = elements(node).find((element) => element.type === "button");
  if (!result) throw new Error("出力ボタンが見つかりません。");
  return result;
}
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join("");
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!node || typeof node !== "object" || !("props" in node)) return "";
  const element = node as Element;
  return [element.props.title, element.props.description, text(element.props.children)].filter(Boolean).join(" ");
}
function notice(node: ReactNode) {
  return elements(node).find((element) => element.props.role === "status")?.props.children as string | undefined;
}
const props = (): Props => ({
  results: { castSalesReports: [], castRewards: [] },
  roster: { schemaVersion: 1, entries: [{ id: "cast", name: "花子" }] },
  month: "2026-09", sourceLabel: "未確定", disabledReason: "",
});
function render(value = props()) { harness.cursor = 0; return CastSalesRankingExport(value); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const book = () => ({ xlsx: { writeBuffer: harness.serialize } });
beforeEach(() => {
  vi.clearAllMocks(); harness.values = []; harness.cursor = 0; harness.cleanups = [];
  harness.ranking = { rows: [{ castId: "cast", name: "花子", totalSales: 0 }], rosterMissing: false };
  harness.build.mockImplementation(() => harness.ranking);
  harness.create.mockResolvedValue(book());
  harness.serialize.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
});

describe("キャスト売上順位表の非同期出力", () => {
  it("売上0円の在籍者も出力し、XLSX生成処理には確定区分の説明を渡さない", async () => {
    const value = props();
    button(render(value)).props.onClick();
    await vi.waitFor(() => expect(harness.download).toHaveBeenCalledOnce());
    expect(harness.build).toHaveBeenCalledWith(value.results, value.month, value.roster);
    expect(harness.create).toHaveBeenCalledWith(harness.ranking, value.month);
    expect(harness.download).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]), "GENESIS売上順位表_2026-09.xlsx");
    expect(notice(render(value))).toBe("2026-09の売上順位表を1名分出力しました。");
  });

  it("対象・原価控除前の計算式・同順位の扱いを説明する", () => {
    const content = text(render(props()));
    expect(content).toContain("本指名売上＋場内延長売上＋追加売上（酒代原価控除前）");
    expect(content).toContain("1位・1位・3位");
    expect(content).toContain("出勤0回・売上0円");
    expect(content).toContain("退店キャストも対象月に在籍していれば売上0円で掲載");
    expect(content).toContain("体入のみのキャストは含めません");
  });

  it("旧確定月の名簿未保存を警告し、保存済み出勤者の出力は許可する", async () => {
    const value = { ...props(), roster: undefined, sourceLabel: "確定済み" };
    harness.ranking.rosterMissing = true;
    const tree = render(value);
    expect(text(tree)).toContain("出勤0回の在籍者名簿は未保存です。保存済みの出勤者のみを出力します。");
    expect(button(tree).props.disabled).toBe(false);
    button(tree).props.onClick();
    await vi.waitFor(() => expect(harness.download).toHaveBeenCalledOnce());
    expect(harness.create).toHaveBeenCalledWith(harness.ranking, "2026-09");
  });

  it("名簿が保存されている場合は旧確定月の警告を出さない", () => {
    expect(text(render(props()))).not.toContain("在籍者名簿は未保存");
  });

  it("未保存・処理中等の停止理由がある場合は計算と出力を実行しない", () => {
    const tree = render({ ...props(), disabledReason: "未保存の経理入力を保存してください。" });
    expect(button(tree).props.disabled).toBe(true);
    expect(text(tree)).toContain("未保存の経理入力を保存してください。");
    button(tree).props.onClick();
    expect(harness.build).not.toHaveBeenCalled();
    expect(harness.create).not.toHaveBeenCalled();
  });

  it("月次データ未読込ならゼロ売上と誤認せず出力を止める", () => {
    const tree = render({ ...props(), results: undefined });
    expect(button(tree).props.disabled).toBe(true);
    expect(text(tree)).toContain("出力する月次データを読み込めません。");
    expect(harness.build).not.toHaveBeenCalled();
  });

  it("在籍対象者が0名なら空の順位表を出力しない", () => {
    harness.ranking.rows = [];
    const tree = render(props());
    expect(button(tree).props.disabled).toBe(true);
    expect(text(tree)).toContain("売上順位表に出力する在籍キャストがいません。");
    button(tree).props.onClick();
    expect(harness.create).not.toHaveBeenCalled();
  });

  it("不正な売上・名簿は計算側の具体的な理由を表示して出力を止める", () => {
    harness.build.mockImplementation(() => { throw new Error("対象月と在籍者名簿の月が一致しません。"); });
    const tree = render(props());
    expect(button(tree).props.disabled).toBe(true);
    expect(text(tree)).toContain("対象月と在籍者名簿の月が一致しません。");
  });

  it("同時クリックは1回だけ実行し、生成中はボタンと更新待機を処理中にする", async () => {
    const value = props(); const pending = deferred<ReturnType<typeof book>>();
    harness.create.mockReturnValueOnce(pending.promise);
    const start = button(render(value)).props.onClick;
    start(); start();
    await vi.waitFor(() => expect(harness.create).toHaveBeenCalledOnce());
    const busyTree = render(value);
    expect(button(busyTree).props.disabled).toBe(true);
    expect(button(busyTree).props.children).toBe("売上順位表出力中…");
    expect(harness.busy).toHaveBeenLastCalledWith("accounting.export.castSalesRanking", true);
    pending.resolve(book());
    await vi.waitFor(() => expect(harness.download).toHaveBeenCalledOnce());
    expect(button(render(value)).props.disabled).toBe(false);
    expect(harness.busy).toHaveBeenLastCalledWith("accounting.export.castSalesRanking", false);
  });

  it.each(["month", "results", "roster", "sourceLabel", "disabledReason"] as const)("生成中に%sが変われば旧データをダウンロードしない", async (field) => {
    const value = props(); const pending = deferred<ReturnType<typeof book>>();
    harness.create.mockReturnValueOnce(pending.promise);
    button(render(value)).props.onClick();
    await vi.waitFor(() => expect(harness.create).toHaveBeenCalledOnce());
    const latest: Props = { ...value };
    if (field === "month") latest.month = "2026-10";
    if (field === "results") latest.results = { castRewards: [], castSalesReports: [] };
    if (field === "roster") latest.roster = { ...value.roster } as never;
    if (field === "sourceLabel") latest.sourceLabel = "確定済み";
    if (field === "disabledReason") latest.disabledReason = "入力内容を保存してください。";
    render(latest);
    pending.resolve(book());
    await vi.waitFor(() => expect(button(render(latest)).props.children).toBe("売上順位表をXLSX出力"));
    expect(harness.serialize).not.toHaveBeenCalled();
    expect(harness.download).not.toHaveBeenCalled();
    if (field === "month") expect(notice(render(latest))).toBeUndefined();
    else expect(notice(render(latest))).toContain("出力中に対象月・売上データまたは名簿が更新");
  });

  it("月を変更後に元の月へ戻っても処理中だった古い出力は取り消す", async () => {
    const value = props(); const pending = deferred<ArrayBuffer>();
    harness.serialize.mockReturnValueOnce(pending.promise);
    button(render(value)).props.onClick();
    await vi.waitFor(() => expect(harness.serialize).toHaveBeenCalledOnce());
    render({ ...value, month: "2026-10" }); render(value);
    pending.resolve(new ArrayBuffer(1));
    await vi.waitFor(() => expect(notice(render(value))).toContain("出力中に対象月・売上データまたは名簿が更新"));
    expect(harness.download).not.toHaveBeenCalled();
  });

  it("ファイル生成後のシリアライズ中の更新も検出する", async () => {
    const value = props(); const pending = deferred<ArrayBuffer>();
    harness.serialize.mockReturnValueOnce(pending.promise);
    button(render(value)).props.onClick();
    await vi.waitFor(() => expect(harness.serialize).toHaveBeenCalledOnce());
    const latest = { ...value, results: { castSalesReports: [], castRewards: [] } };
    render(latest); pending.resolve(new ArrayBuffer(1));
    await vi.waitFor(() => expect(notice(render(latest))).toContain("出力中に対象月・売上データまたは名簿が更新"));
    expect(harness.download).not.toHaveBeenCalled();
  });

  it.each(["create", "serialize"] as const)("%s中のアンマウントではダウンロード・完了通知を出さない", async (stage) => {
    const value = props(); const pending = deferred<any>();
    harness[stage].mockReturnValueOnce(pending.promise);
    button(render(value)).props.onClick();
    await vi.waitFor(() => expect(harness[stage]).toHaveBeenCalledOnce());
    harness.cleanups.forEach((cleanup) => cleanup());
    pending.resolve(stage === "create" ? book() : new ArrayBuffer(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.download).not.toHaveBeenCalled();
    expect(notice(render(value))).toBeUndefined();
  });

  it.each(["create", "serialize", "download"] as const)("%s失敗後は理由を表示し、再試行できる", async (stage) => {
    const value = props();
    if (stage === "download") harness.download.mockImplementationOnce(() => { throw new Error("保存できません"); });
    else harness[stage].mockRejectedValueOnce(new Error("保存できません"));
    button(render(value)).props.onClick();
    await vi.waitFor(() => expect(notice(render(value))).toContain("保存できません"));
    expect(button(render(value)).props.disabled).toBe(false);
    const beforeRetry = harness.download.mock.calls.length;
    button(render(value)).props.onClick();
    await vi.waitFor(() => expect(harness.download).toHaveBeenCalledTimes(beforeRetry + 1));
    expect(notice(render(value))).toContain("1名分出力しました");
  });
});
