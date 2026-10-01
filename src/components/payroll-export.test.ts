import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  values: [] as unknown[], cursor: 0, cleanups: [] as (() => void)[],
  buildStaff: vi.fn(), buildDriver: vi.fn(), createStaff: vi.fn(), createDriver: vi.fn(),
  serialize: vi.fn(), download: vi.fn(), busy: vi.fn(),
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
vi.mock("@/domain/payroll-export", () => ({ buildStaffPaymentExport: harness.buildStaff, buildDriverPaymentExport: harness.buildDriver }));
vi.mock("@/lib/xlsx/payroll", () => ({ createStaffPaymentWorkbook: harness.createStaff, createDriverPaymentWorkbook: harness.createDriver }));
vi.mock("@/lib/xlsx/receipt-template", () => ({ downloadReceiptFile: harness.download }));
import { PayrollExport } from "./payroll-export";

type Props = Parameters<typeof PayrollExport>[0];
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
const props = (kind: Props["kind"] = "staff"): Props => ({
  kind, input: { results: {} as never, closings: [], month: "2026-09", staff: [], archivedStaff: [] },
  month: "2026-09", sourceLabel: "未確定", disabledReason: "",
});
function render(value = props()) { harness.cursor = 0; return PayrollExport(value); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const book = () => ({ xlsx: { writeBuffer: harness.serialize } });
beforeEach(() => {
  vi.clearAllMocks(); harness.values = []; harness.cursor = 0; harness.cleanups = [];
  harness.buildStaff.mockReturnValue({}); harness.buildDriver.mockReturnValue({});
  harness.createStaff.mockResolvedValue(book()); harness.createDriver.mockResolvedValue(book());
  harness.serialize.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
});

describe("スタッフ・ドライバー支払XLSXの出力", () => {
  it.each(["staff", "driver"] as const)("%sは対応する帳票だけを別名で出力する", async (kind) => {
    const value = props(kind); const label = kind === "staff" ? "スタッフ支払" : "ドライバー支払";
    const build = kind === "staff" ? harness.buildStaff : harness.buildDriver;
    const create = kind === "staff" ? harness.createStaff : harness.createDriver;
    const other = kind === "staff" ? harness.createDriver : harness.createStaff;
    button(render(value)).props.onClick();
    await vi.waitFor(() => expect(harness.download).toHaveBeenCalledOnce());
    expect(build).toHaveBeenCalledWith(value.input);
    expect(create).toHaveBeenCalledWith(value.input);
    expect(other).not.toHaveBeenCalled();
    expect(harness.download).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]), `GENESIS${label}_2026-09.xlsx`);
    expect(notice(render(value))).toBe(`2026-09の${label}XLSXを出力しました。`);
  });

  it("印刷と確定済み金額の扱いを説明し、スタッフだけ区分別シートを案内する", () => {
    const content = text(render(props()));
    expect(content).toContain("在籍・体入を別シート");
    expect(content).toContain("A4横向き");
    expect(content).toContain("人数に応じて複数ページ");
    expect(content).toContain("日別内訳が未保存の欄は空欄・注記付き");
    expect(text(render(props("driver")))).not.toContain("在籍・体入を別シート");
  });

  it("旧確定月の内訳欠損がdomainで許可されれば現行マスタで補完せず出力する", async () => {
    const value = props(); value.sourceLabel = "月次確定済み 第1版";
    value.input = { ...value.input!, snapshot: {} as never };
    expect(button(render(value)).props.disabled).toBe(false);
    button(render(value)).props.onClick();
    await vi.waitFor(() => expect(harness.download).toHaveBeenCalledOnce());
    expect(harness.createStaff).toHaveBeenCalledWith(value.input);
  });

  it.each(["未保存の経理入力を保存してください。", "処理中です。", "月次確定処理中です。", "データの警告を解消してから出力してください。", "最新データを確認してください。"])("停止理由：%sなら出力と検証を開始しない", (disabledReason) => {
    const tree = render({ ...props(), disabledReason });
    expect(button(tree).props.disabled).toBe(true);
    expect(text(tree)).toContain(disabledReason);
    button(tree).props.onClick();
    expect(harness.buildStaff).not.toHaveBeenCalled();
    expect(harness.createStaff).not.toHaveBeenCalled();
  });

  it("月次データ未読込を0円と誤認せず停止する", () => {
    const tree = render({ ...props(), input: undefined });
    expect(button(tree).props.disabled).toBe(true);
    expect(text(tree)).toContain("出力する月次データを読み込めません。");
    expect(harness.buildStaff).not.toHaveBeenCalled();
  });

  it("帳票の月と入力の月が不一致なら保存名だけ異なる帳票を作らない", () => {
    const tree = render({ ...props(), month: "2026-10" });
    expect(button(tree).props.disabled).toBe(true);
    expect(text(tree)).toContain("出力対象月と給与データの月が一致しません。");
    expect(harness.buildStaff).not.toHaveBeenCalled();
  });

  it.each(["staff", "driver"] as const)("%sの検証エラーは具体的な理由を表示する", (kind) => {
    const build = kind === "staff" ? harness.buildStaff : harness.buildDriver;
    build.mockImplementationOnce(() => { throw new Error("保存金額と日別内訳が一致しません。"); });
    const tree = render(props(kind));
    expect(button(tree).props.disabled).toBe(true);
    expect(text(tree)).toContain("保存金額と日別内訳が一致しません。");
    button(tree).props.onClick();
    expect(harness.createStaff).not.toHaveBeenCalled(); expect(harness.createDriver).not.toHaveBeenCalled();
  });

  it("同時クリックは1回だけ実行し、処理中は更新待機とボタンを制御する", async () => {
    const value = props(); const pending = deferred<ReturnType<typeof book>>();
    harness.createStaff.mockReturnValueOnce(pending.promise);
    const start = button(render(value)).props.onClick;
    start(); start();
    await vi.waitFor(() => expect(harness.createStaff).toHaveBeenCalledOnce());
    expect(button(render(value)).props.disabled).toBe(true);
    expect(harness.busy).toHaveBeenLastCalledWith("accounting.export.staffPayment", true);
    pending.resolve(book());
    await vi.waitFor(() => expect(harness.download).toHaveBeenCalledOnce());
    expect(button(render(value)).props.disabled).toBe(false);
    expect(harness.busy).toHaveBeenLastCalledWith("accounting.export.staffPayment", false);
  });

  it.each(["month", "kind", "results", "closings", "snapshot", "staff", "archivedStaff", "sourceLabel", "disabledReason"] as const)("生成中に%sが変われば古い出力を止める", async (field) => {
    const value = props(); const pending = deferred<ReturnType<typeof book>>();
    harness.createStaff.mockReturnValueOnce(pending.promise);
    button(render(value)).props.onClick();
    await vi.waitFor(() => expect(harness.createStaff).toHaveBeenCalledOnce());
    const latest: Props = { ...value, input: { ...value.input! } };
    if (field === "month") latest.month = "2026-10";
    else if (field === "kind") latest.kind = "driver";
    else if (field === "sourceLabel") latest.sourceLabel = "確定済み";
    else if (field === "disabledReason") latest.disabledReason = "未保存";
    else if (field === "results" || field === "snapshot") latest.input![field] = {} as never;
    else latest.input![field] = [];
    render(latest); pending.resolve(book());
    await vi.waitFor(() => expect(button(render(latest)).props.children).not.toContain("出力中"));
    expect(harness.serialize).not.toHaveBeenCalled(); expect(harness.download).not.toHaveBeenCalled();
    if (field === "month" || field === "kind") expect(notice(render(latest))).toBeUndefined();
    else expect(notice(render(latest))).toContain("出力中に対象月または給与データが更新");
  });

  it("生成中に入力のラッパーだけ再生成されても中断しない", async () => {
    const value = props(); const pending = deferred<ArrayBuffer>();
    harness.serialize.mockReturnValueOnce(pending.promise);
    button(render(value)).props.onClick();
    await vi.waitFor(() => expect(harness.serialize).toHaveBeenCalledOnce());
    render({ ...value, input: { ...value.input! } }); pending.resolve(new ArrayBuffer(1));
    await vi.waitFor(() => expect(harness.download).toHaveBeenCalledOnce());
  });

  it("月変更後に元の月に戻っても古い出力を再開しない", async () => {
    const value = props(); const pending = deferred<ArrayBuffer>();
    harness.serialize.mockReturnValueOnce(pending.promise);
    button(render(value)).props.onClick();
    await vi.waitFor(() => expect(harness.serialize).toHaveBeenCalledOnce());
    render({ ...value, month: "2026-10" }); render(value); pending.resolve(new ArrayBuffer(1));
    await vi.waitFor(() => expect(notice(render(value))).toContain("出力中に対象月または給与データが更新"));
    expect(harness.download).not.toHaveBeenCalled();
  });

  it("シリアライズ中の給与データ更新でも保存を中止する", async () => {
    const value = props(); const pending = deferred<ArrayBuffer>();
    harness.serialize.mockReturnValueOnce(pending.promise);
    button(render(value)).props.onClick();
    await vi.waitFor(() => expect(harness.serialize).toHaveBeenCalledOnce());
    const latest = { ...value, input: { ...value.input!, results: {} as never } };
    render(latest); pending.resolve(new ArrayBuffer(1));
    await vi.waitFor(() => expect(notice(render(latest))).toContain("出力中に対象月または給与データが更新"));
    expect(harness.download).not.toHaveBeenCalled();
  });

  it.each(["createStaff", "serialize"] as const)("%s中に画面を離れた場合は保存・通知しない", async (stage) => {
    const value = props(); const pending = deferred<any>();
    harness[stage].mockReturnValueOnce(pending.promise);
    button(render(value)).props.onClick();
    await vi.waitFor(() => expect(harness[stage]).toHaveBeenCalledOnce());
    harness.cleanups.forEach((cleanup) => cleanup());
    pending.resolve(stage === "createStaff" ? book() : new ArrayBuffer(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.download).not.toHaveBeenCalled(); expect(notice(render(value))).toBeUndefined();
  });

  it.each(["createStaff", "serialize", "download"] as const)("%s失敗後に理由を表示して再試行できる", async (stage) => {
    const value = props();
    if (stage === "download") harness.download.mockImplementationOnce(() => { throw new Error("保存できません"); });
    else harness[stage].mockRejectedValueOnce(new Error("保存できません"));
    button(render(value)).props.onClick();
    await vi.waitFor(() => expect(notice(render(value))).toContain("保存できません"));
    expect(button(render(value)).props.disabled).toBe(false);
    const count = harness.download.mock.calls.length;
    button(render(value)).props.onClick();
    await vi.waitFor(() => expect(harness.download).toHaveBeenCalledTimes(count + 1));
    expect(notice(render(value))).toContain("XLSXを出力しました");
  });
});
