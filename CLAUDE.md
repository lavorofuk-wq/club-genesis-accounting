# CLUB GENESIS 経理システム 開発ルール

返答はすべて日本語で行う。
変更後は常にgit add && git commitとgit pushまで自動実行する。
システム内のバージョンを毎回更新する（index.html の Ver番号）。
このプロジェクトはキャバクラ経理システム（index.html）。

# ブランチ戦略
- main: 本番ブランチ（Vercelが自動デプロイ）
- dev: 開発ブランチ（作業はここで行い、確認後mainにマージ）
- 開発はdevブランチで行い、動作確認後にmainへマージしてpush

# バージョン管理
- 機能追加: マイナーバージョン +1（例: Ver1.0 → Ver1.1）
- バグ修正: パッチ（例: Ver1.0 → Ver1.0.1）
- バージョン番号はindex.html の Ver番号を更新

# コミットメッセージ規則
- feat: 新機能追加
- fix: バグ修正
- ui: UI/デザイン変更
- refactor: リファクタリング
例: "feat: Ver1.1 給与計算機能追加"

# システム構成・開発体制
- このワークスペースは経理システム専用
- POSシステムは別のVS Code / Claude Codeインスタンスで独立して開発する
- 基本的にこのワークスペースからPOSシステムへのアクセス・開発は行わない
- 両システムを同時に変更する必要がある場合のみ、POSシステム側の対応も考慮する

# Firebase 接続
- 経理システム専用のFirebaseプロジェクト（POSとは完全に別）
- projectId: club-genesis-accountin
- databaseURL: https://club-genesis-accountin-default-rtdb.asia-southeast1.firebasedatabase.app
- 本番(club-genesis-accounting.vercel.app): FB_ROOT = 'accounting'
- 開発(ローカル等): FB_ROOT = 'accounting-dev'
- 切り替えはホスト名で自動判定

# Firebase データ構造
accounting/  ← 本番 / accounting-dev/  ← 開発
  history/              ← POSから同期した会計済みセッション（売上データ）
  casts/                ← キャスト一覧
  shifts/               ← 出勤記録
  bizDays/              ← 営業日管理
  config/
    accountingPassword  ← 経理システムパスワード

# 主要な仕様メモ
- 本指名売上: テーブル小計 ÷ 本指名キャスト数（均等分配）
- 場内延長: オールフリー（本指名なし）のテーブルのみ対象
- 場内延長売上: 延長アイテム金額 ÷ 場内延長選択キャスト数（均等分配）
- 本指名テーブルで場内指名が入っても売上分配は本指名キャストのみ
- アイテムフラグ: isSet / isHonShimei / isBanaiShimei / isExtension / isBanaiExtension / isVipCharge / isDiscount

# 開発フェーズ
- Phase 1（完了）: 日次売上確認
- Phase 2（未着手）: キャスト給与計算・給与明細出力
- Phase 3（未着手）: 日次精算（現金実在高照合）
- Phase 4（未着手）: 経費管理・損益計算
- Phase 5（未着手）: 月次レポート・CSV出力
