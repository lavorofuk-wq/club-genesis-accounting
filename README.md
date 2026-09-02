# GMS — GENESIS Management System

CLUB GENESISの店舗日次締め、共通マスター、経理承認、月次給与・経費・収支を管理するシステム。

## ローカル起動

1. `.env.example` を `.env.local` にコピーし、Firebase Web Appの値を設定する。
2. `npm ci`
3. `npm run dev`

ローカルとVercelプレビューはRealtime Databaseの `accounting-dev` を使用する。
本番ドメインだけが `accounting` を使用する。

## 検証

- `npm test`
- `npm run build`

Firebase Authenticationでメール／パスワードを有効にし、各ユーザーの
`users/{uid}/role` に `shop`、`accounting`、`op` のいずれかを設定する。
本番運用前に `database.rules.json` を対象Firebaseプロジェクトへ反映する。

