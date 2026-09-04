import type { ReactNode } from "react";

export const yen = new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", maximumFractionDigits: 0 });
export const currentMonth = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit" });
export const today = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}
export function Card({ title, description, action, children }: { title?: string; description?: string; action?: ReactNode; children: ReactNode }) {
  return <section className="card">{(title || action) && <div className="section-head"><div>{title && <h2>{title}</h2>}{description && <p className="muted compact-text">{description}</p>}</div>{action}</div>}{children}</section>;
}
export function Table({ headers, children, empty = "データがありません。" }: { headers: string[]; children: ReactNode; empty?: string }) {
  const rows = Array.isArray(children) ? children.filter(Boolean) : children ? [children] : [];
  return <div className="table-wrap"><table><thead><tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>{rows.length ? children : <tr><td colSpan={headers.length}>{empty}</td></tr>}</tbody></table></div>;
}
export function MoneyInput({ value, onChange, step = 1, min = 0, disabled = false }: { value: number; onChange: (value: number) => void; step?: number; min?: number; disabled?: boolean }) {
  return <input className="input money-input" type="number" min={min} step={step} disabled={disabled} value={value || ""} onChange={(event) => {
    const next = Number(event.target.value);
    onChange(Number.isFinite(next) ? Math.floor(Math.max(0, next)) : 0);
  }} />;
}
export function Modal({ title, children, onClose, disabled = false }: { title: string; children: ReactNode; onClose: () => void; disabled?: boolean }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (!disabled && event.target === event.currentTarget) onClose(); }}><section className="modal" role="dialog" aria-modal="true" aria-label={title} aria-busy={disabled}><div className="section-head"><h2>{title}</h2><button className="icon-button" type="button" aria-label="閉じる" disabled={disabled} onClick={onClose}>×</button></div><fieldset className="modal-body" disabled={disabled}>{children}</fieldset></section></div>;
}
export function StatusPill({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "good" | "warn" | "danger" }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}
