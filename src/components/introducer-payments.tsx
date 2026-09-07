"use client";

import { Fragment, useId, useMemo, useState } from "react";
import type { CastReward } from "@/domain/gms";
import type { IntroducerPaymentRow } from "@/domain/month-accounting";
import { groupIntroducerPayments } from "@/domain/expense-export";
import { Card, Table, yen } from "./ui";

type Props = { rows: IntroducerPaymentRow[]; castRewards: CastReward[] };

function CastPaymentDetails({ rows }: Pick<Props, "rows">) {
  return <Table headers={["紹介者", "対象キャスト", "本指名酒代原価", "売上算定額", "売上10%", "総支給額", "総支給10%", "採用タイプ", "出勤顧問料", "入店顧問料", "支払合計"]}>
    {rows.map((row, index) => <tr key={`${row.id}:${index}`}>
      <td>{row.introducer}</td><td>{row.cast}</td>
      <td>{yen.format(row.honShimeiLiquorCost)}</td><td>{yen.format(row.salesBase)}</td>
      <td>{yen.format(row.salesFee)}</td><td>{yen.format(row.grossBase)}</td>
      <td>{yen.format(row.grossFee)}</td><td>{row.adopted}</td>
      <td>{yen.format(row.attendanceAdvisory)}</td><td>{yen.format(row.entryAdvisory)}</td>
      <td><strong>{yen.format(row.total)}</strong></td>
    </tr>)}
  </Table>;
}

export function IntroducerPayments({ rows, castRewards }: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const componentId = useId();
  const grouped = useMemo(() => {
    try { return { groups: groupIntroducerPayments({ introducerPayments: rows, castRewards }), error: "" }; }
    catch (cause) { return { groups: [], error: cause instanceof Error ? cause.message : "紹介者を一意に確認できません。" }; }
  }, [rows, castRewards]);
  const names = new Map<string, number>();
  grouped.groups.forEach((group) => names.set(group.name, (names.get(group.name) || 0) + 1));

  return <Card title="紹介者支払データ" description="紹介者ごとの支払合計です。「詳細」で各キャストの内訳を確認できます。売上基準は本指名売上のみで、場内延長売上は含みません。">
    {grouped.error ? <>
      <div className="notice error" role="alert">紹介者別に集約できないため、保存済みのキャスト別明細を表示しています。<br />{grouped.error}</div>
      <CastPaymentDetails rows={rows} />
    </> : <>
      <Table headers={["紹介者", "対象キャスト数", "支払合計", "操作"]} empty="この月の紹介者支払データはありません。">
        {grouped.groups.map((group, index) => {
          const open = expanded === group.id;
          const detailId = `${componentId}-detail-${index}`;
          return <Fragment key={group.id}>
            <tr>
              <td><strong>{group.name}</strong>{(names.get(group.name) || 0) > 1 && <><br /><small>同名の別紹介者 · ID: {group.id}</small></>}</td>
              <td>{group.rows.length}人</td><td><strong>{yen.format(group.total)}</strong></td>
              <td><button type="button" className="button secondary mini" aria-label={`${group.name}の${open ? "詳細を閉じる" : "詳細"}`} aria-expanded={open} aria-controls={open ? detailId : undefined} onClick={() => setExpanded(open ? null : group.id)}>{open ? "閉じる" : "詳細"}</button></td>
            </tr>
            {open && <tr><td colSpan={4} className="introducer-detail-cell"><section id={detailId} aria-label={`${group.name}のキャスト別明細`}>
              <h3>{group.name} — キャスト別明細</h3>
              <CastPaymentDetails rows={group.rows} />
              <div className="right-total">{group.name} 支払合計<strong>{yen.format(group.total)}</strong></div>
            </section></td></tr>}
          </Fragment>;
        })}
      </Table>
      {grouped.groups.length > 0 && <div className="right-total">紹介者支払 総合計<strong>{yen.format(grouped.groups.reduce((sum, group) => sum + group.total, 0))}</strong></div>}
    </>}
  </Card>;
}
