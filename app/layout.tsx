import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "GMS | GENESIS Management System",
  description: "CLUB GENESIS 店舗・経理管理システム"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
