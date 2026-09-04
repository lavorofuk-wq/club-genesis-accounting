# GMS Ver2.7.0 アーキテクチャ

## 実行環境

- Next.js 16 / React 19 / TypeScript
- Firebase Authentication（メールアドレス＋パスワード）
- Firebase Realtime Database
- Vercel（`main` は本番、`dev` はプレビュー）

FirebaseプロジェクトはGMS専用の `club-genesis-gms` を使用する。

Firebaseの保存ルートはホスト名で切り替える。本番の
`club-genesis-accounting.vercel.app` だけが `accounting`、それ以外は
`accounting-dev` を使用する。

## 権限

- `shop`: 店舗作業、共通フォーム
- `accounting`: 経理作業、共通フォーム
- `op`: 店舗作業、経理作業、共通フォーム

権限はFirebase Realtime Databaseの `users/{uid}/role` で一元管理する。
Realtime Databaseルールでも同じ値を検査し、古い権限が残らないようにする。

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
送迎ドライバーの日払いは `history` の日次勤務へ保存し、当日現金残額から控除する。
経理側では月次の総支給額から日払い合計を控除して差引支給額を算出する。
経理側のキャスト売上画面は、承認済み `history` をキャスト・出勤日単位に展開し、
本指名／場内延長の売上と酒代原価、指名・同伴本数、各種バック、ボトル、美容室手当を表示する。

## 日次状態

`submitted`（店舗送信）→ `approved`（経理承認）または `returned`（差戻し）。
`approved` からも `returned` へ戻せる。差戻し時は実行者・直前状態・理由を記録し、
店舗で再編集・再送してから再承認する。`returned` の期間は月次集計から除外する。
店舗は承認前または差戻し後のデータを `withdrawn` にして再編集できる。

Realtime Databaseが空配列を省略して保存するため、日次・POS原本・月次調整は
読込境界で配列と必須オブジェクトを正規化する。構造欠損は画面上で警告する。
