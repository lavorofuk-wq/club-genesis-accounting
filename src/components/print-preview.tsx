"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** 表示時点の保存済み日次を印刷する。業務入力や保存処理とは独立させる。 */
export function PrintPreview({ title, children, onClose }: {
  title: string; children: ReactNode; onClose: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const [printError, setPrintError] = useState("");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousTitle = document.title;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    const background = Array.from(document.body.children)
      .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== dialog)
      .map((element) => ({ element, inert: element.inert }));
    background.forEach(({ element }) => { element.inert = true; });
    document.title = title;
    document.body.style.overflow = "hidden";
    document.body.classList.add("daily-print-preview-open");
    dialog.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      background.forEach(({ element, inert }) => { element.inert = inert; });
      document.title = previousTitle;
      document.body.style.overflow = previousOverflow;
      document.body.classList.remove("daily-print-preview-open");
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [title]);

  const print = () => {
    setPrintError("");
    try { window.print(); }
    catch { setPrintError("印刷画面を開けませんでした。ブラウザーの印刷機能から再度お試しください。入力内容は変更していません。"); }
  };

  if (typeof document === "undefined") return null;
  return createPortal(<section ref={dialogRef} className="daily-print-preview" role="dialog" aria-modal="true" aria-label={title}
    onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
      if (event.key !== "Tab") return;
      const targets = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]'));
      const first = targets[0], last = targets[targets.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
    <div className="print-preview-toolbar">
      <div><h2>{title}</h2><p>表示時点の保存済みデータ / A4横・複数ページ対応</p></div>
      <div className="actions"><button type="button" className="button" onClick={print}>印刷・PDF保存</button>
        <button type="button" className="button secondary" onClick={onClose}>閉じる</button></div>
      <p className="print-preview-help">PDFにする場合は、印刷画面の送信先で「PDFに保存」を選択してください。用紙はA4・横向き、倍率は100%を推奨します。</p>
      {printError && <p className="notice error" role="alert">{printError}</p>}
    </div>
    <div className="print-preview-scroll" tabIndex={0} role="region" aria-label="日次帳票・スクロールして全体を確認"><div className="print-preview-paper">{children}</div></div>
  </section>, document.body);
}
