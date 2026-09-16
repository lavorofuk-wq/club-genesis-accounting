# GMS — GENESIS Management System

CLUB GENESISの店舗日次締め、共通マスター、経理承認、月次給与・経費・収支を管理するシステム。

Firebaseプロジェクト: `club-genesis-gms`

## ローカル起動

1. `.env.example` を `.env.local` にコピーし、Firebase Web Appの値を設定する。
2. `npm ci`
3. `npm run dev`

ローカルとVercelプレビューはRealtime Databaseの `accounting-dev` を使用する。
本番ドメインだけが `accounting` を使用する。

## PCからファイルで起動

PCで `開発環境を起動.cmd` をダブルクリックする。
開発サーバーを `127.0.0.1:3000` で起動し、起動完了を確認してからブラウザーで `http://localhost:3000` を自動的に開く。
IPアドレスの入力は不要。PC外からは接続できず、Realtime Databaseの `accounting-dev` のみを使用する。
開発中は起動したコマンド画面を閉じない。終了時はその画面を閉じる。

## 検証

- `npm test`
- `npm run build`

Firebase Authenticationでメール／パスワードを有効にし、各ユーザーの
`users/{uid}/role` に `shop`、`accounting`、`op` のいずれかを設定する。
本番運用前に `database.rules.json` を対象Firebaseプロジェクトへ反映する。
