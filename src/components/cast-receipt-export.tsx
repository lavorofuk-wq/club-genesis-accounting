"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CastReward } from "@/domain/gms";
import { buildCastReceiptSheets } from "@/domain/cast-receipt";
import { Card } from "./ui";
import { useUpdateDraftBusy } from "./update-drafts";

export function CastReceiptExport({ rows, month, sourceLabel, disabledReason }: {
  rows?: CastReward[];
  month: string;
  sourceLabel: string;
  disabledReason: string;
}) {
  const exportingRef = useRef(false);
  const active = useRef(true);
  const fetchController = useRef<AbortController | null>(null);
  const current = useRef({ rows, month, sourceLabel, disabledReason });
  current.current = { rows, month, sourceLabel, disabledReason };
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<{ month: string; error: boolean; text: string }>();
  useUpdateDraftBusy("accounting.export.castReceipts", exporting);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; fetchController.current?.abort(); };
  }, []);
  const validation = useMemo(() => {
    if (disabledReason) return { error: disabledReason };
    try { return { sheets: buildCastReceiptSheets(rows || [], month), error: "" }; }
    catch (error) { return { error: error instanceof Error ? error.message : "報酬データを確認してください。" }; }
  }, [rows, month, disabledReason]);

  const exportAll = async () => {
    if (validation.error || !validation.sheets || exportingRef.current) return;
    exportingRef.current = true;
    setExporting(true);
    setNotice(undefined);
    const controller = new AbortController();
    fetchController.current = controller;
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const { RECEIPT_TEMPLATE_URL, fillReceiptTemplate, downloadReceiptFile } = await import("@/lib/xlsx/receipt-template");
      const response = await fetch(RECEIPT_TEMPLATE_URL, { signal: controller.signal });
      if (!response.ok) throw new Error("受領書テンプレートを取得できません。通信状態を確認して再度お試しください。");
      const bytes = await fillReceiptTemplate(await response.arrayBuffer(), validation.sheets);
      const latest = current.current;
      if (!active.current) return;
      if (latest.rows !== rows || latest.month !== month || latest.sourceLabel !== sourceLabel || latest.disabledReason) {
        throw new Error("出力中に対象月または報酬データが更新されました。表示内容を確認して再度出力してください。");
      }
      downloadReceiptFile(bytes, `GENESIS受領書_${month}.xlsx`);
      setNotice({ month, error: false, text: `${month}の受領書を${validation.sheets.length}名分出力しました。` });
    } catch (error) {
      if (active.current) setNotice({ month, error: true, text: `受領書を出力できませんでした。${controller.signal.aborted
        ? "取得がタイムアウトしました。通信状態を確認して再度お試しください。"
        : error instanceof Error ? error.message : "もう一度お試しください。"}` });
    } finally {
      clearTimeout(timeout);
      fetchController.current = null;
      exportingRef.current = false;
      if (active.current) setExporting(false);
    }
  };

  return <Card title="受領書XLSX" description={`${month}・${sourceLabel}。全員分をキャスト別シートにまとめます。金額・キャスト名を記入し、受領日・氏名の署名欄は空欄にします。`}
    action={<button className="button" disabled={Boolean(validation.error) || exporting} title={validation.error || undefined} onClick={() => void exportAll()}>{exporting ? "受領書出力中…" : "全員分の受領書をXLSX出力"}</button>}>
    <p className="muted compact-text">採用された報酬方式に応じて、時給用・売上報酬用の受領書を使います。各様式のセルサイズ・用紙設定を保持します。全員分を印刷するときは、Excelで「ブック全体を印刷」を選択してください。</p>
    {validation.error && <p className="muted compact-text">{validation.error}</p>}
    {notice?.month === month && <div role="status" className={`notice${notice.error ? " error" : ""}`}>{notice.text}</div>}
  </Card>;
}
