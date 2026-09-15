import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrintPreview } from "./print-preview";

const harness = vi.hoisted(() => ({
  state: "",
  effects: [] as Array<() => void | (() => void)>,
  dialog: { focus: vi.fn(), querySelector: vi.fn(), querySelectorAll: vi.fn() },
  portalTarget: null as unknown,
}));

// DOM互換ライブラリを追加せず、ブラウザー副作用の境界とReactのイベントを検証する。
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useState: () => [harness.state, (value: string) => { harness.state = value; }],
  useRef: () => ({ current: harness.dialog }),
  useEffect: (effect: () => void | (() => void)) => { harness.effects.push(effect); },
}));
vi.mock("react-dom", async (importOriginal) => ({
  ...await importOriginal<typeof import("react-dom")>(),
  createPortal: (children: ReactNode, target: unknown) => { harness.portalTarget = target; return children; },
}));

class FocusTarget {
  isConnected = true;
  inert = false;
  focus = vi.fn();
}
const firstButton = new FocusTarget();
const closeButton = new FocusTarget();
const scrollRegion = new FocusTarget();
const background = new FocusTarget();
const alreadyInert = new FocusTarget();
const documentStub = {
  title: "GMS 開発環境",
  activeElement: new FocusTarget(),
  body: { children: [background, alreadyInert, harness.dialog], style: { overflow: "auto" }, classList: { add: vi.fn(), remove: vi.fn() } },
};
const windowStub = { print: vi.fn() };
const close = vi.fn();
function render() {
  return PrintPreview({ title: "2026-09-02 営業日次データ", children: createElement("p", null, "保存済みの帳票内容"), onClose: close });
}
function findButton(tree: ReactNode, label: string): (() => void) | undefined {
  if (Array.isArray(tree)) return tree.map((node) => findButton(node, label)).find(Boolean);
  if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(tree)) return undefined;
  if (tree.type === "button" && tree.props.children === label) return tree.props.onClick;
  return findButton(tree.props.children, label);
}
function keyDown(tree: ReactNode, key: string, shiftKey = false) {
  const element = tree as unknown as { props: { onKeyDown: (event: { key: string; shiftKey: boolean; preventDefault: () => void; stopPropagation: () => void; currentTarget: typeof harness.dialog }) => void } };
  const event = { key, shiftKey, preventDefault: vi.fn(), stopPropagation: vi.fn(), currentTarget: harness.dialog };
  element.props.onKeyDown(event);
  return event;
}

beforeEach(() => {
  vi.clearAllMocks();
  harness.state = ""; harness.effects = []; harness.portalTarget = null;
  documentStub.title = "GMS 開発環境";
  documentStub.activeElement = new FocusTarget();
  documentStub.body.style.overflow = "auto";
  background.inert = false; alreadyInert.inert = true;
  harness.dialog.querySelector.mockReturnValue(firstButton);
  harness.dialog.querySelectorAll.mockReturnValue([firstButton, closeButton, scrollRegion]);
  windowStub.print.mockReset();
  vi.stubGlobal("document", documentStub);
  vi.stubGlobal("window", windowStub);
  vi.stubGlobal("HTMLElement", FocusTarget);
});
afterEach(() => vi.unstubAllGlobals());

describe("印刷プレビューのブラウザー操作", () => {
  it("documentのないSSRではブラウザーAPIに触れず空表示にする", () => {
    vi.stubGlobal("document", undefined);
    expect(render()).toBeNull();
    expect(harness.portalTarget).toBeNull();
    expect(windowStub.print).not.toHaveBeenCalled();
    expect(harness.dialog.querySelector).not.toHaveBeenCalled();
  });

  it("本文直下に表示し、開閉時にタイトル・スクロール・フォーカスを元へ戻す", () => {
    const markup = renderToStaticMarkup(render());
    expect(harness.portalTarget).toBe(documentStub.body);
    expect(markup).toContain("保存済みの帳票内容");
    expect(markup).toContain("印刷・PDF保存");
    expect(markup).toContain("PDFに保存");
    expect(markup).toContain("A4");
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('class="print-preview-scroll" tabindex="0" role="region" aria-label="日次帳票・スクロールして全体を確認"');
    expect(markup).not.toContain("<dialog");
    const cleanup = harness.effects[0]();
    expect(firstButton.focus).toHaveBeenCalled();
    expect(background.inert).toBe(true);
    expect(alreadyInert.inert).toBe(true);
    expect(documentStub.title).toBe("2026-09-02 営業日次データ");
    expect(documentStub.body.style.overflow).toBe("hidden");
    expect(documentStub.body.classList.add).toHaveBeenCalledWith("daily-print-preview-open");
    expect(cleanup).toBeTypeOf("function");
    cleanup!();
    expect(background.inert).toBe(false);
    expect(alreadyInert.inert).toBe(true);
    expect(documentStub.title).toBe("GMS 開発環境");
    expect(documentStub.body.style.overflow).toBe("auto");
    expect(documentStub.body.classList.remove).toHaveBeenCalledWith("daily-print-preview-open");
    expect(documentStub.activeElement.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("印刷は明示的なボタン操作だけで開始し、画面を自動で閉じない", () => {
    const tree = render();
    harness.effects[0]();
    expect(windowStub.print).not.toHaveBeenCalled();
    findButton(tree, "印刷・PDF保存")!();
    expect(windowStub.print).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    expect(renderToStaticMarkup(render())).not.toContain('role="alert"');
  });

  it("印刷機能が例外を返しても入力を保ち、再試行でエラーを解除する", () => {
    windowStub.print.mockImplementationOnce(() => { throw new Error("print unavailable"); });
    findButton(render(), "印刷・PDF保存")!();
    const failed = render();
    const markup = renderToStaticMarkup(failed);
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("印刷画面を開けませんでした");
    expect(markup).toContain("入力内容は変更していません");
    expect(markup).toContain("保存済みの帳票内容");
    expect(close).not.toHaveBeenCalled();
    findButton(failed, "印刷・PDF保存")!();
    expect(windowStub.print).toHaveBeenCalledTimes(2);
    expect(renderToStaticMarkup(render())).not.toContain('role="alert"');
  });

  it("閉じるボタンは印刷せず親の閉じる処理だけを呼ぶ", () => {
    findButton(render(), "閉じる")!();
    expect(close).toHaveBeenCalledOnce();
    expect(windowStub.print).not.toHaveBeenCalled();
  });

  it("Escapeでも親状態と同期して閉じる", () => {
    const event = keyDown(render(), "Escape");
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(windowStub.print).not.toHaveBeenCalled();
  });

  it("Tabは末尾の帳票スクロール領域から印刷へ、Shift+Tabは印刷から帳票へ循環する", () => {
    const tree = render();
    documentStub.activeElement = scrollRegion;
    expect(keyDown(tree, "Tab").preventDefault).toHaveBeenCalledOnce();
    expect(firstButton.focus).toHaveBeenCalled();
    expect(harness.dialog.querySelectorAll).toHaveBeenCalledWith('button:not(:disabled), [tabindex="0"]');
    documentStub.activeElement = firstButton;
    expect(keyDown(tree, "Tab", true).preventDefault).toHaveBeenCalledOnce();
    expect(scrollRegion.focus).toHaveBeenCalled();
    expect(closeButton.focus).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it("循環端以外のTabと通常キーではブラウザーの移動を妨げない", () => {
    const tree = render();
    documentStub.activeElement = firstButton;
    expect(keyDown(tree, "Tab").preventDefault).not.toHaveBeenCalled();
    documentStub.activeElement = closeButton;
    expect(keyDown(tree, "Tab").preventDefault).not.toHaveBeenCalled();
    expect(keyDown(tree, "Tab", true).preventDefault).not.toHaveBeenCalled();
    documentStub.activeElement = scrollRegion;
    expect(keyDown(tree, "Tab", true).preventDefault).not.toHaveBeenCalled();
    expect(keyDown(tree, "Enter").preventDefault).not.toHaveBeenCalled();
    expect(keyDown(tree, "ArrowDown").preventDefault).not.toHaveBeenCalled();
    expect(keyDown(tree, "PageDown").preventDefault).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it("元の操作ボタンが画面から消えた場合はフォーカスを戻さない", () => {
    render();
    const cleanup = harness.effects[0]();
    documentStub.activeElement.isConnected = false;
    cleanup!();
    expect(documentStub.activeElement.focus).not.toHaveBeenCalled();
    expect(documentStub.title).toBe("GMS 開発環境");
  });
});
