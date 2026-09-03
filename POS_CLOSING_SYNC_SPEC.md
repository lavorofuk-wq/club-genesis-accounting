# GMS POS締めJSON取込仕様

POSとGMSはFirebaseを共有しない。営業終了後にPOSがUTF-8 JSONを出力し、
店舗担当者がGMSへ添付する。CSVおよびschemaVersion 1・2は正式取込対象外とする。

## 識別・改変検知

- `schema`: `club-genesis-pos-closing`
- `schemaVersion`: `3`
- `submissionId`: 出力ごとに一意なID
- `businessDate`: `YYYY-MM-DD`
- `generatedAt`: ISO 8601
- `checksumAlgorithm`: `sha256`
- `checksumCanonicalization`: `recursive-key-sort-v1`
- `checksum`: 小文字16進64文字

チェックサムはルートの `checksum` だけを除外し、オブジェクトのキーを全階層で
Unicodeコードポイント順に並べ、配列順は維持したJSON文字列のUTF-8バイト列から算出する。

## 必須データ

`transactions`、`castSales`、`castWork`、`sales` を必須とする。
決済内訳合計と会計合計、現金＋カードと総売上、出退勤時刻から15分未満を切り捨てた
勤務時間が一致しないファイルは取り込まない。

## キャスト対象

キャストはPOS IDと名前を出力する。在籍・体入はGMSマスターへの明示的な紐付けを必須とし、
同名の体入キャストが複数いる場合は店舗担当者が選択する。派遣はマスターを作成しない。

同伴明細は `backTargetCastIds` に1名を指定する。
有償のシャンパン・ワイン／キープボトルはバック対象を必須とし、対象が1名なら
`backAllocation: "single"`、複数名なら `backAllocation: "equal"` とする。
複数対象の売上・酒代原価・ボトルバックはGMSが人数で均等分配する。

酒代原価マスターは種別・名称・販売金額で照合し、不一致時は取込を停止する。
店舗担当者が「今回のみの特別原価」を明示入力した場合だけ続行できる。

