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
export function MoneyInput({ value, onChange, step = 100 }: { value: number; onChange: (value: number) => void; step?: number }) {
  return <input className="input money-input" type="number" min="0" step={step} value={value || ""} onChange={(event) => onChange(Number(event.target.value))} />;
}
export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="modal" role="dialog" aria-modal="true" aria-label={title}><div className="section-head"><h2>{title}</h2><button className="icon-button" type="button" aria-label="閉じる" onClick={onClose}>×</button></div>{children}</section></div>;
}
export function StatusPill({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "good" | "warn" | "danger" }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}
