# CLUB GENESIS POS締めファイル取込仕様

POSからGMSへFirebaseで直接データ共有・送信する方式は廃止します。
POSは営業終了済みデータをUTF-8 JSONファイルとして出力し、GMS側でファイルを選択して取り込みます。

## 保存先

GMSで取り込んだ後の保存先:

- 本番: `dailyClosings/{importId}`
- 開発: `dailyClosings-dev/{importId}`

`shopClosings` / `shopClosings-dev` はPOS直接受信用だったため使用しません。

## 取込フロー

1. POSの過去営業履歴から対象営業日の「GMS取込JSON」を出力します。
2. GMSの「POSファイル取込」でJSONファイルを選択します。
3. GMSがschemaVersion、営業日、明細配列、チェックサムを検証します。
4. 問題なければ `dailyClosings(-dev)` に `status: "submitted"` として保存します。
5. GMS上で内容を確認し、確定処理で `status: "finalized"` に更新します。

## ファイル形式

- 文字コード: UTF-8
- 拡張子: `.json`
- schema: `club-genesis-pos-closing`
- schemaVersion: `1`

必須主要項目:

- `businessDate`
- `sales`
- `customers`
- `nominations`
- `transactions`
- `castSales`
- `castWork`
- `enteredCasts`
- `exitedCasts`
- `trialCasts`
- `checksum`

CSVは閲覧・確認用としてのみ扱い、正式取込には使用しません。

## Firebaseルール方針

POS端末からGMS Firestoreへ直接書き込ませません。
`dailyClosings(-dev)` への作成・更新はGMSにログインした `accounting` または `shop` ロールのユーザー操作に限定します。
