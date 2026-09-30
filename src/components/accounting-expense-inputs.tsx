"use client";

import type { AccountingExpenseInput, DailyClosing, ExpenseCategory } from "@/domain/gms";
import { EXPENSE_LABELS } from "@/domain/accounting-expenses";
import { secureRandomUUID } from "@/lib/crypto-compat";
import { Card, Field, MoneyInput, Table, yen } from "./ui";

type Props = {
  month: string;
  rows: AccountingExpenseInput[];
  closings: DailyClosing[];
  total?: number;
  consumptionTax?: number;
  disabled: boolean;
  saveDisabled: boolean;
  onSave: () => Promise<boolean>;
  onChange: (update: (rows: AccountingExpenseInput[]) => AccountingExpenseInput[]) => void;
};

export function AccountingExpenseInputs({ month, rows, closings, total, consumptionTax, disabled, saveDisabled, onSave, onChange }: Props) {
  const days = [...new Set(closings.filter((row) => row.status === "approved" && row.businessDate.startsWith(`${month}-`)).map((row) => row.businessDate))].sort();
  const patch = (id: string, change: Partial<AccountingExpenseInput>) => {
    if (disabled) return;
    onChange((current) => current.map((row) => row.id === id ? { ...row, ...change } : row));
  };
  const add = () => {
    if (disabled) return;
    onChange((current) => [...current, { id: secureRandomUUID(), category: "transportOther", payee: "", amount: 0 }]);
  };
  const remove = (id: string) => {
    if (disabled) return;
    onChange((current) => current.filter((row) => row.id !== id));
  };
  return <Card title="経費入力" description="営業日を指定すると経費表の指定日に、未指定の場合は月末の日付行の下にある、日付がない行に表示します。各行の「保存」で、編集中の経理入力をまとめて保存します。行を削除した後は、残っている行か上部の保存ボタンで保存してください。"
    action={<button type="button" className="button secondary" disabled={disabled} onClick={add}>経費を追加</button>}>
    <div className="stack">{rows.map((row, index) => <div className="detail-panel" key={row.id}>
      <fieldset className="cast-input-fields" disabled={disabled} aria-label={`追加経費 ${index + 1}`}>
        <div className="grid two">
          <Field label="勘定科目"><select className="input" value={row.category} onChange={(event) => patch(row.id, { category: event.target.value as ExpenseCategory })}>
            {Object.entries(EXPENSE_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
          </select></Field>
          <Field label="支払先・内容"><input className="input" value={row.payee} maxLength={200} onChange={(event) => patch(row.id, { payee: event.target.value })} /></Field>
          <Field label="金額"><MoneyInput value={row.amount} disabled={disabled} onChange={(amount) => patch(row.id, { amount })} /></Field>
          <Field label="営業日（任意）" hint="対象月の承認済み営業日から選択"><select className="input" value={row.businessDate || ""} onChange={(event) => patch(row.id, { businessDate: event.target.value || undefined })}>
            <option value="">未指定（日付がない行に表示）</option>
            {days.map((day) => <option value={day} key={day}>{day}</option>)}
            {row.businessDate && !days.includes(row.businessDate) && <option value={row.businessDate}>{row.businessDate}{disabled ? "" : "（現在は対象外）"}</option>}
          </select></Field>
        </div>
        <div className="actions top-gap">
          <button type="button" className="button danger mini" aria-label={`追加経費 ${index + 1} を削除`} onClick={() => remove(row.id)}>削除</button>
          <button type="button" className="button mini" aria-label={`追加経費 ${index + 1} の保存`} disabled={disabled || saveDisabled} onClick={() => { if (!disabled && !saveDisabled) void onSave(); }}>保存</button>
        </div>
      </fieldset>
    </div>)}</div>
    {!rows.length && <p className="muted">追加で入力した経費はありません。</p>}
    {total !== undefined && <div className="right-total">追加入力経費計 <strong>{yen.format(total)}</strong></div>}
    {consumptionTax !== undefined && <div className="top-gap">
      <Table headers={["勘定科目", "自動計上", "金額"]}><tr><td>その他</td><td>預かり消費税<br /><small>合計売上 × 3％（1円未満切り捨て）</small></td><td>{yen.format(consumptionTax)}</td></tr></Table>
      <p className="muted compact-text">預かり消費税は経費表の月末の日付行の下にある、日付がない行に表示します。</p>
    </div>}
  </Card>;
}
