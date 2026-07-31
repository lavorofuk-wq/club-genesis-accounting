# GMS Ver2.0 基盤設計

## 境界

- POSとGMSはFirebaseを共有しない。
- GMSはPOS Firebaseを参照しない。
- POSからGMSへ渡す唯一の経路は、利用者が選択した
  `club-genesis-pos-closing` JSONファイルとする。
- GMSの認証、人物台帳、取込履歴、営業日データは
  `club-genesis-accountin` のFirestoreに保存する。
- 本番は既存コレクション、ローカル・プレビュー環境は
  `-dev` 接尾辞付きコレクションを使用する。

## 取込トランザクション

1. JSON構造、営業日、schemaVersion、チェックサムを検証する。
2. `submissionId` とチェックサムで二重取込・改変を検出する。
3. 同一営業日の再取込は `supersedesSubmissionId` がなければ拒否する。
4. POS IDとGMS人物IDを照合する。名前だけでは同一人物と判定しない。
5. 完全在籍スナップショットにGMS在籍者がいない場合、自動退店せず確認を要求する。
6. 名称差分があっても、過去JSONからGMS表示名を上書きしない。
7. 取込履歴を `processing` として確保してから、営業日データ・新規人物・
   紐付け・ライフサイクルイベント・完了記録を一括保存する。
8. 保存失敗時は履歴を `failed` とし、同じチェックサムの再試行を可能にする。

## データの責任

- `dailyClosings(-dev)`: POS JSON原本に取込・確定監査情報を加えた営業日データ
- `castMembers(-dev)`: GMSが管理する人物と報酬設定
- `castSourceLinks(-dev)`: POS IDからGMS人物IDへの明示的な紐付け
- `castLifecycleEvents(-dev)`: 入店・退店・体入イベントの追記専用履歴
- `jsonImports(-dev)`: 取込の冪等性、訂正関係、失敗履歴
- `fixedExpenses(-dev)`: 月別固定費

## XLSX

帳票は画面・Firebaseアクセスから分離し、確定データと人物台帳を入力にする。

- 経費表XLSX
- キャスト報酬明細書XLSX
- キャスト月次報酬表XLSX
- 確定データ収支表XLSX

帳票モジュールはワークブックのシート名、主要セル、金額、合計式を自動テストする。

## 切替

Ver2.0は既存コレクションを互換読込するため、初回切替時の一括データ移行を行わない。
旧HTML/JavaScriptはロールバック確認用としてリポジトリに残すが、Next.js画面からは使用しない。
