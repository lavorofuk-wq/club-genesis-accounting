# GMS JSONキャスト取込仕様

## 分離方針

- GMSはPOS Firebaseへ接続しない。
- POSはGMS取込JSONだけを出力する。
- JSONのPOS IDは`castSourceLinks`を介してGMS人物へ紐づける。
- 名前だけによる人物の自動統合は禁止する。

## 対応JSON

- schemaVersion 1: 過去ファイル互換。入退店日時がない場合は営業日の開始・終了時刻を補完する。
- schemaVersion 2: `submissionId`、`generatedAt`、`rosterSnapshot`、`lifecycleEvents`を必須とする。

## 取込処理

1. ファイル選択時は構文・スキーマ・checksum・重複だけを検証し、Firestoreを更新しない。
2. 未登録POS IDは、既存GMS人物への紐づけまたは新規人物登録を必須とする。
3. 確定時に`jsonImports`をトランザクションで処理中にし、同時取込を防止する。
4. 締めデータ、人物リンク、ライフサイクル履歴、体入記録、取込完了記録を単一バッチで保存する。
5. 失敗時は`jsonImports.status = failed`として再試行可能にする。

## 在籍状態

- `statusEffectiveAt`より古いイベントは履歴だけ保存する。
- 同一`eventId`は再適用しない。
- 削除済み人物はJSONから自動復元しない。
- 在籍化済み人物を古い体入イベントで体入へ戻さない。
- 完全名簿に存在しないGMS在籍者を自動退店にしない。

## Firestore

- `castMembers(-dev)`: GMS人物マスター
- `castSourceLinks(-dev)`: POS IDとGMS人物の対応
- `castLifecycleEvents(-dev)`: 変更不可の入店・退店・体入履歴
- `jsonImports(-dev)`: checksum、処理状態、取込履歴

## POS側JSON v2必須項目

```json
{
  "schema": "club-genesis-pos-closing",
  "schemaVersion": 2,
  "submissionId": "一意なID",
  "generatedAt": "ISO 8601",
  "businessDate": "YYYY-MM-DD",
  "rosterSnapshot": {
    "complete": true,
    "capturedAt": "ISO 8601",
    "casts": []
  },
  "lifecycleEvents": [],
  "transactions": [],
  "castSales": [],
  "castWork": [],
  "checksum": "..."
}
```
