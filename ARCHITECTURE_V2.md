# GMS Ver2.3 アーキテクチャ

## 実行環境

- Next.js 16 / React 19 / TypeScript
- Firebase Authentication（メールアドレス＋パスワード）
- Firebase Realtime Database
- Vercel（`main` は本番、`dev` はプレビュー）

Firebaseの保存ルートはホスト名で切り替える。本番の
`club-genesis-accounting.vercel.app` だけが `accounting`、それ以外は
`accounting-dev` を使用する。

## 権限

- `shop`: 店舗作業、共通フォーム
- `accounting`: 経理作業、共通フォーム
- `op`: 店舗作業、経理作業、共通フォーム

権限はFirebaseのカスタムクレーム `role`、または
`users/{uid}/role` で管理する。Realtime Databaseルールでも同じ権限を検査する。

## 主要データ

- `casts`: 在籍・体入・退店キャスト、月度時給、紹介者、顧問料
- `staff`: 在籍・体入・退店スタッフ、月度時給
- `drivers`: 在籍・退店ドライバー、日給
- `introducers`: 紹介者と報酬条件
- `liquorCosts`: シャンパン・ワイン／キープボトル原価
- `config/cashFloat`: つり銭（初期値200,000円）
- `history`: POS原本、店舗入力、計算結果、承認履歴を含む日次スナップショット
- `accountingAdjustments`: 月次の源泉所得税・各種手当・固定経費

マスターを完全削除しても `history` 内の名称・時給・原価・金額のスナップショットは変更しない。

## 日次状態

`submitted`（店舗送信）→ `approved`（経理承認）または `returned`（差戻し）。
店舗は承認前のデータを `withdrawn` にして再編集できる。

