# CLUB GENESIS POS締め連携仕様

この仕様はPOS側で「締め作業モード」を実装し、経理システムへ自動連携するための保存形式です。

## 保存先

- 本番: `dailyClosings/{businessDate}`
- 開発: `dailyClosings-dev/{businessDate}`

`businessDate` は `YYYY-MM-DD` 形式です。

## 締めステータス

- `draft`: 下書き
- `submitted`: 店舗締め済み
- `approved`: 経理承認済み
- `rejected`: 経理差戻し

初期実装ではPOSが `submitted` で保存し、経理は読み取り専用にします。

## Firestoreデータ形式

```js
{
  businessDate: "2026-06-16",
  status: "submitted",

  sales: {
    totalSales: 0,
    cashSales: 0,
    cardSales: 0,
    discountTotal: 0,
    taxServiceTotal: 0
  },

  customers: {
    groupCount: 0,
    totalCustomers: 0,
    customerUnitPrice: 0
  },

  nominations: {
    honShimeiCount: 0,
    jonaiCount: 0
  },

  castSales: [
    {
      castId: "castDocumentId",
      castName: "キャスト名",
      honShimeiSales: 0,
      jonaiExtensionSales: 0,
      drinkSales: 0,
      totalAttributedSales: 0
    }
  ],

  staffWork: [
    {
      staffId: "staffDocumentId",
      staffName: "スタッフ名",
      role: "manager",
      startTime: "20:00",
      endTime: "02:00",
      breakMinutes: 0,
      hours: 6
    }
  ],

  castWork: [
    {
      castId: "castDocumentId",
      castName: "キャスト名",
      startTime: "20:00",
      endTime: "01:00",
      breakMinutes: 0,
      hours: 5
    }
  ],

  expenses: [
    {
      category: "酒代",
      amount: 0,
      note: ""
    }
  ],

  allowances: [
    {
      type: "交通費",
      amount: 0,
      recipientId: "staffOrCastId",
      recipientName: "支給対象者"
    }
  ],

  cashReconciliation: {
    expectedCash: 0,
    actualCash: 0,
    difference: 0,
    note: ""
  },

  source: {
    posVersion: "POS側バージョン",
    closedBy: "締め担当者UIDまたは名前",
    closedAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  }
}
```

## 経理システム側の読み取り

経理システムは以下だけを読み取ります。

- 売上
- 客数
- 指名数
- スタッフ勤務時間
- キャスト勤務時間
- 経費
- 手当
- 現金差異
- 締め状態

経理システム側では原則編集しません。

## 注意

POS側で締め確定後は、同じ営業日のデータを安易に上書きしないでください。
修正が必要な場合は、将来的に `rejected` / `submitted` のワークフローで管理します。
