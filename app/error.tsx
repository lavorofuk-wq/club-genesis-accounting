"use client";

import { useEffect } from "react";

export default function PageError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("GMS route error", error);
  }, [error]);

  return (
    <main className="login">
      <section className="login-card">
        <div className="login-brand">
          <span>CLUB GENESIS</span>
          <strong>GMS</strong>
          <p>画面を表示できませんでした</p>
        </div>
        <div className="stack">
          <div className="notice error">
            一時的な読込エラーが発生しました。再読み込みしても直らない場合は、表示していた営業日をお知らせください。
          </div>
          <button className="button login-button" onClick={reset}>
            もう一度読み込む
          </button>
        </div>
      </section>
    </main>
  );
}
