"use client";

import type { StaffPayrollRow } from "@/domain/month-accounting";
import { Card, MoneyInput, Table, yen } from "./ui";

const businessDateLabel = (value: string) => { const [, month, day] = value.split("-").map(Number); return Number.isFinite(month) && Number.isFinite(day) ? `${month}月${day}日` : value; };

type Props = { rows: StaffPayrollRow[]; disabled: boolean; onSales: (id: string, value: number) => void; onBottle: (id: string, value: number) => void };

export function StaffPayroll({ rows, ...controls }: Props) {
  const groups: Record<"regular" | "trial" | "unknown", StaffPayrollRow[]> = { regular: [], trial: [], unknown: [] };
  for (const row of rows) {
    const sources = row.hourlySources;
    if (!Array.isArray(sources) || !sources.length || sources.some((source) => !source
      || (source.kind !== "regular" && source.kind !== "trial") || typeof source.staffId !== "string" || !source.staffId)) {
      groups.unknown.push(row);
      continue;
    }
    // 対象月の計算基準で分類する。同月入店で在籍IDへ統合済みの体入分も在籍側に置く。
    const kind = sources.some((source) => source.kind === "regular" || source.staffId !== row.id) ? "regular" : "trial";
    groups[kind].push(row);
  }
  return <div className="grid">
    <Card title={`在籍スタッフ給与（${groups.regular.length}名）`} description="同月に入店したスタッフの体入分も、こちらにまとめています。日別内訳で計算に使った時給を確認できます。">
      <StaffPayrollTable rows={groups.regular} {...controls} empty="当月の在籍スタッフ給与データはありません。" />
    </Card>
    <Card title={`体入スタッフ給与（${groups.trial.length}名）`} description="対象月の体入スタッフ給与です。日払いは支払済みの記録を保持し、給与との差額は差引支給額に反映します。">
      <StaffPayrollTable rows={groups.trial} {...controls} empty="当月の体入スタッフ給与データはありません。" />
    </Card>
    {groups.unknown.length > 0 && <Card title={`区分記録なし（${groups.unknown.length}名）`}>
      <p className="notice" role="alert">給与計算時の在籍・体入区分が保存されていないため、推測で振り分けず表示しています。保存済みの給与額は変更していません。</p>
      <StaffPayrollTable rows={groups.unknown} {...controls} empty="" />
    </Card>}
  </div>;
}

function StaffPayrollTable({ rows, disabled, onSales, onBottle, empty }: Props & { empty: string }) {
  const totals = rows.reduce((sum, row) => ({ hours: sum.hours + row.hours, hourly: sum.hourly + row.hourly,
    sales: sum.sales + row.sales, bottle: sum.bottle + row.bottle, gross: sum.gross + row.gross,
    daily: sum.daily + row.daily, net: sum.net + row.net }), { hours: 0, hourly: 0, sales: 0, bottle: 0, gross: 0, daily: 0, net: 0 });
  return <>
    <Table empty={empty} headers={["スタッフ", "勤務時間", "基本給与", "売上手当", "ボトル手当", "総支給", "日払い", "差引支給"]}>
      {rows.length ? [...rows.map((row) => <tr key={row.id}><td>{row.name}</td><td>{row.hours}時間</td><td>{yen.format(row.hourly)}</td><td><MoneyInput value={row.sales} disabled={disabled} onChange={(value) => onSales(row.id, value)} /></td><td><MoneyInput value={row.bottle} disabled={disabled} onChange={(value) => onBottle(row.id, value)} /></td><td>{yen.format(row.gross)}</td><td>{yen.format(row.daily)}</td><td><strong>{yen.format(row.net)}</strong></td></tr>),
        <tr className="total-row" key="staff-payroll-total"><td><strong>合計（{rows.length}名）</strong></td><td>{totals.hours}時間</td><td>{yen.format(totals.hourly)}</td><td>{yen.format(totals.sales)}</td><td>{yen.format(totals.bottle)}</td><td><strong>{yen.format(totals.gross)}</strong></td><td>{yen.format(totals.daily)}</td><td><strong>{yen.format(totals.net)}</strong></td></tr>] : null}
    </Table>
    {rows.map((row) => <details key={row.id} className="cast-sales-card">
      <summary className="cast-sales-summary"><strong>{row.name}</strong><span>日別内訳</span><span>基本給与 {yen.format(row.hourly)}</span></summary>
      <div className="cast-sales-content">
        {row.hourlyByDay ? <Table headers={["営業日", "勤務時間", "適用時給（区分・時間）", "基本給与"]}>
          {row.hourlyByDay.map((day) => {
            const sources = Array.isArray(row.hourlySources) ? row.hourlySources.filter((source) => source
              && source.businessDate === day.businessDate && (source.kind === "regular" || source.kind === "trial")
              && typeof source.staffId === "string" && source.staffId && Number.isFinite(source.hours) && Number.isFinite(source.hourlyRate)) : undefined;
            return <tr key={day.businessDate}><td>{businessDateLabel(day.businessDate)}</td><td>{day.hours}時間</td>
              <td>{sources?.length ? sources.map((source) => <div key={`${source.staffId}-${source.kind}`}>{yen.format(source.hourlyRate)}（{source.kind === "trial" ? "体入" : "在籍"}・{source.hours}時間）</div>) : "確定時の単価記録なし"}</td>
              <td>{yen.format(day.amount)}</td></tr>;
          })}
        </Table> : <p className="muted">この確定データには日別内訳が保存されていません。確定時の月額を表示しています。</p>}
      </div>
    </details>)}
  </>;
}
