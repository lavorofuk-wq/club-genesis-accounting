"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { MonthlyAccountingResults } from "@/domain/month-accounting";
import { buildIntroducerExport } from "@/domain/introducer-export";
import { Card } from "./ui";
import { useUpdateDraftBusy } from "./update-drafts";

export function IntroducerStatementExport({ results, month, sourceLabel, disabledReason }: {
  results?: MonthlyAccountingResults;
  month: string;
  sourceLabel: string;
  disabledReason: string;
}) {
  const exportingRef = useRef(false);
  const active = useRef(true);
  const current = useRef({ results, month, sourceLabel, disabledReason });
  current.current = { results, month, sourceLabel, disabledReason };
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<{ month: string; error: boolean; text: string }>();
  useUpdateDraftBusy("accounting.export.introducerStatements", exporting);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  const validationError = useMemo(() => {
    if (disabledReason) return disabledReason;
    if (!results) return "出力する月次データを読み込めません。";
    try { buildIntroducerExport(results, month); return ""; }
    catch (error) { return error instanceof Error ? error.message : "紹介者支払データを確認してください。"; }
  }, [results, month, disabledReason]);

  const exportAll = async () => {
    if (validationError || !results || exportingRef.current) return;
    exportingRef.current = true;
    setExporting(true);
    setNotice(undefined);
    const ensureCurrent = () => {
      if (!active.current) return false;
      const latest = current.current;
      if (latest.results !== results || latest.month !== month || latest.sourceLabel !== sourceLabel || latest.disabledReason) {
        throw new Error("出力中に対象月または紹介者支払データが更新されました。表示内容を確認して再度出力してください。");
      }
      return true;
    };
    try {
      const [{ createIntroducerWorkbook }, { downloadReceiptFile }] = await Promise.all([
        import("@/lib/xlsx/introducers"), import("@/lib/xlsx/receipt-template"),
      ]);
      if (!ensureCurrent()) return;
      const book = createIntroducerWorkbook(results, month);
      const buffer = await book.xlsx.writeBuffer();
      if (!ensureCurrent()) return;
      downloadReceiptFile(new Uint8Array(buffer), `GENESIS紹介者支払明細_${month}.xlsx`);
      setNotice({ month, error: false, text: `${month}の全紹介者の明細を出力しました。` });
    } catch (error) {
      if (active.current) setNotice({ month, error: true, text: `紹介者明細を出力できませんでした。${error instanceof Error ? error.message : "もう一度お試しください。"}` });
    } finally {
      exportingRef.current = false;
      if (active.current) setExporting(false);
    }
  };

  return <Card title="紹介者支払明細XLSX" description={`${month}・${sourceLabel}。全紹介者の明細を1つのファイルにまとめ、紹介者ごとのシートへ対象キャストの明細を出力します。`}
    action={<button type="button" className="button" disabled={Boolean(validationError) || exporting} title={validationError || undefined} onClick={() => void exportAll()}>{exporting ? "紹介者明細出力中…" : "紹介者明細をXLSX出力"}</button>}>
    <p className="muted compact-text">対象月の計算結果を数式なしで出力します。確定済み月は確定時の保存金額を使用します。全員分を印刷するときは、Excelで「ブック全体を印刷」を選択してください。</p>
    {validationError && <p className="muted compact-text">{validationError}</p>}
    {notice?.month === month && <div role="status" className={`notice${notice.error ? " error" : ""}`}>{notice.text}</div>}
  </Card>;
}
