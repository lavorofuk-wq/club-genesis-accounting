# CLUB GENESIS POS締め連携仕様

GENESIS Management System（GMS）は、POS締めデータをいったん店舗作業フォームで確認し、店舗側が訂正・承認したデータだけを経理ダッシュボードへ表示します。

## 保存先

POSからの未確認データ:

- 本番: `shopClosings/{businessDate}`
- 開発: `shopClosings-dev/{businessDate}`

店舗作業フォームで確認後、経理側へ送信する確定データ:

- 本番: `dailyClosings/{businessDate}`
- 開発: `dailyClosings-dev/{businessDate}`

`businessDate` は `YYYY-MM-DD` 形式です。

## ステータス

- `submitted`: POS送信済み、店舗確認待ち
- `approved`: 店舗確認済み、経理側表示対象
- `rejected`: 差戻し

## POS送信データ形式

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
  castSales: [],
  staffWork: [],
  castWork: [],
  cashReconciliation: {
    expectedCash: 0,
    actualCash: 0,
    difference: 0,
    note: ""
  },
  source: {
    posVersion: "POS側バージョン",
    closedBy: "締め担当者",
    closedAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  }
}
```

## GMS側の流れ

1. POSが `shopClosings(-dev)` に締めデータを保存します。
2. 店舗ユーザーがGMSの店舗作業フォームでデータを確認します。
3. 店舗ユーザーが必要に応じて売上、勤務時間、経費、手当を訂正します。
4. 店舗ユーザーが「経理へ送信」を押すと、`dailyClosings(-dev)` に `status: "approved"` として保存されます。
5. 経理ユーザーのダッシュボードは `status: "approved"` のデータだけを表示します。

互換性のため、旧POSが `dailyClosings(-dev)` に `status: "submitted"` で保存したデータも店舗作業フォームでは確認待ちとして拾います。
