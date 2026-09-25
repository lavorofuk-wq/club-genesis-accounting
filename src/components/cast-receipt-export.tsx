"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CastRecord, CastReward } from "@/domain/gms";
import { buildCastReceiptSheets } from "@/domain/cast-receipt";
import type { ReceiptDocument } from "@/lib/xlsx/receipt-template";
import { Card } from "./ui";
import { useUpdateDraftBusy } from "./update-drafts";

export function CastReceiptExport({ rows, casts, month, sourceLabel, disabledReason }: {
  rows?: CastReward[];
  casts?: Pick<CastRecord, "id" | "legalName">[];
  month: string;
  sourceLabel: string;
  disabledReason: string;
}) {
  const exportingRef = useRef(false);
  const active = useRef(true);
  const fetchController = useRef<AbortController | null>(null);
  const current = useRef({ rows, casts, month, sourceLabel, disabledReason });
  current.current = { rows, casts, month, sourceLabel, disabledReason };
  const [exporting, setExporting] = useState<ReceiptDocument | null>(null);
  const [notice, setNotice] = useState<{ month: string; error: boolean; text: string }>();
  useUpdateDraftBusy("accounting.export.castReceipts", Boolean(exporting));
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; fetchController.current?.abort(); };
  }, []);
  const validation = useMemo(() => {
    if (disabledReason) return { error: disabledReason };
    try { return { sheets: buildCastReceiptSheets(rows || [], month, Object.fromEntries((casts || []).map((cast) => [cast.id, cast.legalName || ""]))), error: "" }; }
    catch (error) { return { error: error instanceof Error ? error.message : "報酬データを確認してください。" }; }
  }, [rows, casts, month, disabledReason]);

  const exportAll = async (document: ReceiptDocument) => {
    if (validation.error || !validation.sheets || exportingRef.current) return;
    const documentName = document === "receipt" ? "受領書" : "明細書";
    exportingRef.current = true;
    setExporting(document);
    setNotice(undefined);
    const controller = new AbortController();
    fetchController.current = controller;
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const { RECEIPT_TEMPLATE_URL, fillReceiptTemplate, downloadReceiptFile } = await import("@/lib/xlsx/receipt-template");
      const response = await fetch(RECEIPT_TEMPLATE_URL, { signal: controller.signal });
      if (!response.ok) throw new Error(`${documentName}テンプレートを取得できません。通信状態を確認して再度お試しください。`);
      const bytes = await fillReceiptTemplate(await response.arrayBuffer(), validation.sheets, document);
      const latest = current.current;
      if (!active.current) return;
      if (latest.rows !== rows || latest.casts !== casts || latest.month !== month || latest.sourceLabel !== sourceLabel || latest.disabledReason) {
        throw new Error("出力中に対象月または報酬データが更新されました。表示内容を確認して再度出力してください。");
      }
      downloadReceiptFile(bytes, `GENESIS${documentName}_${month}.xlsx`);
      setNotice({ month, error: false, text: `${month}の${documentName}を在籍キャスト${validation.sheets.length}名分出力しました。` });
    } catch (error) {
      if (active.current) setNotice({ month, error: true, text: `${documentName}を出力できませんでした。${controller.signal.aborted
        ? "取得がタイムアウトしました。通信状態を確認して再度お試しください。"
        : error instanceof Error ? error.message : "もう一度お試しください。"}` });
    } finally {
      clearTimeout(timeout);
      fetchController.current = null;
      exportingRef.current = false;
      if (active.current) setExporting(null);
    }
  };

  return <Card title="受領書・明細書XLSX" description={`${month}・${sourceLabel}。「在籍キャスト報酬」の対象者のみをキャスト別シートにまとめます。体入のみのキャストは除外し、同月に入店したキャストは体入分も含めて出力します。受領書と採用報酬方式の明細書を別々のファイルに出力し、それぞれ1名につき1シート・1ページで印刷します。受領日・氏名の署名欄は空欄です。`}
    action={<div className="actions">{(["receipt", "statement"] as const).map((document) => {
      const documentName = document === "receipt" ? "受領書" : "明細書";
      return <button key={document} type="button" className="button" disabled={Boolean(validation.error) || Boolean(exporting)} title={validation.error || undefined} onClick={() => void exportAll(document)}>{exporting === document ? `${documentName}出力中…` : `${documentName}をXLSX出力`}</button>;
    })}</div>}>
    <p className="muted compact-text">明細書の本名は登録情報から記入し、未登録なら空欄にします。適用時給が保存されていない過去の確定分は「未保存」と記載します。出力対象全員分を印刷するときは、Excelで「ブック全体を印刷」を選択してください。</p>
    {validation.error && <p className="muted compact-text">{validation.error}</p>}
    {notice?.month === month && <div role="status" className={`notice${notice.error ? " error" : ""}`}>{notice.text}</div>}
  </Card>;
}
