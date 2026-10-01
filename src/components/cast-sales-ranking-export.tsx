"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { MonthlyAccountingResults } from "@/domain/month-accounting";
import { buildCastSalesRanking, type CastSalesRankingRoster } from "@/domain/cast-sales-ranking";
import { Card } from "./ui";
import { useUpdateDraftBusy } from "./update-drafts";

export function CastSalesRankingExport({ results, roster, month, sourceLabel, disabledReason }: {
  results?: Pick<MonthlyAccountingResults, "castSalesReports" | "castRewards">;
  roster?: CastSalesRankingRoster;
  month: string;
  sourceLabel: string;
  disabledReason: string;
}) {
  const exportingRef = useRef(false);
  const active = useRef(true);
  const revision = useRef(0);
  const current = useRef({ results, roster, month, sourceLabel, disabledReason });
  const previous = current.current;
  if (previous.results !== results || previous.roster !== roster || previous.month !== month
    || previous.sourceLabel !== sourceLabel || previous.disabledReason !== disabledReason) revision.current += 1;
  current.current = { results, roster, month, sourceLabel, disabledReason };
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<{ month: string; error: boolean; text: string }>();
  useUpdateDraftBusy("accounting.export.castSalesRanking", exporting);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; revision.current += 1; };
  }, []);
  const validation = useMemo(() => {
    if (disabledReason) return { error: disabledReason };
    if (!results) return { error: "出力する月次データを読み込めません。" };
    try {
      const ranking = buildCastSalesRanking(results, month, roster);
      if (!ranking.rows.length) return { ranking, error: "売上順位表に出力する在籍キャストがいません。" };
      return { ranking, error: "" };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "売上データ・在籍者名簿を確認してください。" };
    }
  }, [results, roster, month, disabledReason]);

  const exportRanking = async () => {
    if (validation.error || !validation.ranking || exportingRef.current) return;
    exportingRef.current = true;
    setExporting(true);
    setNotice(undefined);
    const exportRevision = revision.current;
    const ensureCurrent = () => {
      if (!active.current) throw new Error("画面を閉じたため出力を中止しました。");
      if (revision.current !== exportRevision) {
        throw new Error("出力中に対象月・売上データまたは名簿が更新されました。表示内容を確認して再度出力してください。");
      }
    };
    try {
      const [{ createCastSalesRankingWorkbook }, { downloadReceiptFile }] = await Promise.all([
        import("@/lib/xlsx/cast-sales-ranking"), import("@/lib/xlsx/receipt-template"),
      ]);
      ensureCurrent();
      const book = await createCastSalesRankingWorkbook(validation.ranking, month, sourceLabel);
      ensureCurrent();
      const buffer = await book.xlsx.writeBuffer();
      ensureCurrent();
      downloadReceiptFile(new Uint8Array(buffer), `GENESIS売上順位表_${month}.xlsx`);
      if (active.current) setNotice({ month, error: false, text: `${month}の売上順位表を${validation.ranking.rows.length}名分出力しました。` });
    } catch (error) {
      if (active.current) setNotice({ month, error: true, text: `売上順位表を出力できませんでした。${error instanceof Error ? error.message : "もう一度お試しください。"}` });
    } finally {
      exportingRef.current = false;
      if (active.current) setExporting(false);
    }
  };

  return <Card title="売上順位表XLSX" description={`${month}・${sourceLabel}。本指名売上＋場内延長売上＋追加売上（酒代原価控除前）の高い順に出力します。同額は同順位とし、次の順位を飛ばします（1位・1位・3位）。`}
    action={<button type="button" className="button" disabled={Boolean(validation.error) || exporting} title={validation.error || undefined} onClick={() => void exportRanking()}>{exporting ? "売上順位表出力中…" : "売上順位表をXLSX出力"}</button>}>
    <p className="muted compact-text">対象月に在籍していたキャストを対象に、出勤0回・売上0円の人も掲載します。退店キャストも対象月に在籍していれば売上0円で掲載し、体入のみのキャストは含めません。確定済み月は確定時の保存データを使用します。</p>
    {validation.ranking?.rosterMissing && <p className="notice">出勤0回の在籍者名簿は未保存です。保存済みの出勤者のみを出力します。</p>}
    {validation.error && <p className="muted compact-text">{validation.error}</p>}
    {notice?.month === month && <div role="status" className={`notice${notice.error ? " error" : ""}`}>{notice.text}</div>}
  </Card>;
}
