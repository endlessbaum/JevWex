# Web画面とHTTP APIサーバー

このリポジトリから、Chrome拡張と同じ判定・一括判定・モデル管理・ハードウェア設定の画面をHTTPで配信できます。HTTP APIの推論はサーバーが管理する専用の非表示Chromiumで実行するため、**操作用のブラウザを開かなくても、閉じても利用できます**。公開版wllama・既存のvalidator・候補トークンのlogprobs計算を再利用し、fork・patch・独自WASMは使用しません。

## 起動

Node.js 22と、Playwrightが使用するChromiumを用意します。初回だけ：

```powershell
npm ci
npx playwright install chromium
```

以後は次のコマンドでWeb画面のビルドとサーバー起動を行います。

```powershell
npm start
```

ターミナルに表示される「画面を開く」のURLをブラウザで開くと、API用モデルの準備状態を確認できます。既定のURLは `http://127.0.0.1:39281/` です。URLに含まれるトークンを読み取った後、ページはURLからトークンを取り除き、タブのsessionStorageに保持します。APIトークンなしでも通常の画面判定は利用できます。

API用モデルの初期値は **`unsloth/Qwen3-0.6B-GGUF` のQ4_K_M版**です。初回は約400 MBをHugging Faceからダウンロードし、サーバーのブラウザプロファイル内へキャッシュします。モデルの準備中や準備失敗時はAPI判定がHTTP 503になります。状態確認は起動中から使えます。モデルの意味判断の正確性を保証する初期値ではありません。

停止はターミナルでCtrl+Cです。HTTP待ち行列を中止し、サーバーが起動したChromium・Workerも終了します。

## API用モデルと設定

`server.config.example.json` を `server.config.json` にコピーして変更します。設定ファイルはGit管理対象外です。変更後はサーバーを再起動してください。

```json
{
  "model": "unsloth/Qwen3-0.6B-GGUF",
  "projector": "",
  "hardware": {
    "device": "cpu",
    "threads": "auto",
    "gpuLayers": "all",
    "context": 4096
  }
}
```

- `model`: Hugging Faceの公開リポジトリ名、公開GGUF直接URL、またはローカルの単一GGUFパス。相対パスはリポジトリのルート基準です。
- `projector`: 画像用mmproj。ローカルモデルならローカルパス、URL・リポジトリ指定なら公開HF直接URLです。リポジトリ指定では既存のダウンロード処理が画像用ファイルも探します。
- `hardware`: 既存のハードウェア設定と同じ形式。`device` は `cpu` / `webgpu`、`threads` は `auto` または1〜32、`gpuLayers` は `all` または1〜128、`context` は1024 / 2048 / 4096 / 8192。実機・ブラウザの対応状況による制限も適用します。APIのWebGPU実推論は今回未検証です。

例：すでにあるモデルを使う場合、`model` を `.models/Qwen3-0.6B-Q4_K_M.gguf` にするとダウンロードしません。画像モデルは本体と対応するmmprojを両方指定してください。API設定での分割GGUFの指定には未対応です。

環境変数も利用できます。

| 変数 | 内容 |
| --- | --- |
| `JEVWEX_MODEL` | 設定ファイルのmodelを上書き |
| `JEVWEX_PORT` | ポート（既定39281、1024〜65535） |
| `JEVWEX_TOKEN` | 固定APIトークン。英数字・`_`・`-`の32〜128文字。省略時は起動ごとに暗号学的乱数から生成 |

APIの判定処理は特定モデルに固定していません。各リクエストの `model` は読み込み済みIDとの一致確認に使い、自動的なモデル取得・切り替えには使いません。

## 画面側との関係

**画面のモデルとAPI用モデルは独立しています。** 通常の「判定」「一括判定」は操作用ブラウザ内のモデルを使い、「モデル管理」「ハードウェア設定」もそのモデルを操作します。「HTTP API」ページはサーバー側のモデル名・スレッド数・context・GPU層数・準備状態を表示します。

この分離により、画面でのモデル変更・タブ終了がAPI推論を中断しません。両方にモデルを読み込むと、その分のメモリを使用します。APIだけ使うなら画面側でモデルを読み込む必要はありません。

Web画面のキャッシュ・最後のモデル・ハードウェア設定は操作用ブラウザのオリジンに保存します。Chrome拡張版の保存領域とは別です。API用モデルのダウンロードキャッシュは `.cache/server-browser/` の専用Chromiumプロファイル内です。同じプロファイルを複数のサーバープロセスで同時利用しないでください。ポートを変えるとブラウザのオリジンも変わります。

## HTTP API

すべてのAPI要求に `Authorization: Bearer <APIトークン>` が必要です。POSTは `Content-Type: application/json` を指定します。APIは127.0.0.1だけで待ち受けます。LAN・インターネットへの公開サーバーとしての運用は対象外です。

### GET /api/v1/status

`phase`（starting / loading / ready / running / stopping / error）、`loaded`（実際のモデルID・世代・ハードウェア設定など）、`detail`、`pending`（実行中を含む受付数）を返します。準備失敗時は `detail` を確認してください。内部ブラウザがクラッシュした場合の自動再起動はなく、サーバー再起動が必要です。

### POST /api/v1/evaluate

```json
{
  "state": "荷物がまだ届きません。配送状況を教えてください。",
  "questions": {
    "department": {
      "type": "choice",
      "instructions": "問い合わせの担当窓口を選んでください。",
      "criteria": { "shipping": "配送や未着の問い合わせ", "billing": "請求・支払い", "other": "その他" }
    },
    "specificity": {
      "type": "score",
      "instructions": "求める対応の具体性を評価してください。",
      "criteria": ["求める対応が不明", "対応の方向性がわかる", "具体的な対応が明示されている"]
    },
    "asks_reply": { "type": "noul", "instructions": "相手に回答を求めている。" }
  }
}
```

画面の「判定基準」はAPIの `questions` です。`model` を省略するとAPI用モデルを使い、指定する場合は状態APIの `loaded.model` と同じIDを使います。成功時はHTTP 200で `{ "response": { "model": "...", "answers": { ... } }, "diagnostics": { ... } }` を返します。API推論の `diagnostics.runtime` は `wllama server browser` です。

画像は任意の `images` 配列で渡します。各要素は `name`、`mime_type`（`image/png` / `image/jpeg`）、`data_base64`（画像バイト列のBase64。data URL接頭辞なし）を持ちます。画像URLや呼び出し元のファイルパスをAPIが取得することはありません。1件あたり4枚、1枚10 MiB・2,000万画素まで。画像のみの場合も `state` に「添付画像を判定してください」などの指示を入れてください。

### サンプル

サーバー起動とは別のターミナルで：

```powershell
$env:JEVWEX_TOKEN = "起動時に表示されたトークン"
python examples/server/evaluate.py
node examples/server/evaluate.mjs
```

画像対応モデルを設定した場合は、末尾に画像パスを付けます。

```powershell
python examples/server/evaluate.py "C:\pictures\sample.png"
node examples/server/evaluate.mjs "C:\pictures\sample.jpg"
```

呼び出し用の追加Pythonパッケージ・Node.jsパッケージは不要です。ポート変更時はクライアントにも `JEVWEX_PORT` を設定してください。

## 待ち行列・中止・エラー

- 1モデル・1実行ずつ処理します。最大8件（実行中を含む）、受付本文の合計64 MiBまで。1件の本文はBase64を含め56 MiBまでです。
- 文章・判定基準は既存の最大65,536文字・16基準などの制限を使います。
- 待ち時間を含め5分でタイムアウトします。クライアントは310秒などを指定してください。HTTP接続が切れた場合も、その依頼を中止します。
- 推論の中止完了を待ってから次の依頼を実行します。失敗した依頼を自動再送・再実行しません。待ち行列はメモリだけで保持し、サーバー再起動では復元しません。
- エラー形式は `{ "error": { "code": "...", "message": "...", "question": "任意の基準ID" } }`。主なHTTPコードは400（入力不正）、401/403（認証・呼び出し元制限）、409（競合・中止）、413/415（サイズ・形式）、422（非対応モデル・文脈超過・不正出力）、429（満杯）、503（モデル未準備・終了）、504（期限超過）、500（実行時エラー）です。
- APIによる一括集計専用エンドポイントはありません。必要な件数を順次送信し、Python等で集計してください。画面の一括判定・集計・保存は従来どおり使えます。

## 実装・データ・依存関係

Node.js標準HTTPサーバーが静的ファイルとAPIを配信します。COOP/COEPを付け、共有メモリとWASMの複数スレッドを有効にします。静的ファイルは許可したビルド成果物だけを配信し、設定・ソース・任意ファイルを公開しません。設定したローカルGGUFを内部推論ブラウザへ渡す経路もトークン認証が必要です。

Playwright 1.58.2 / playwright-core 1.58.2（Apache-2.0）でサーバー専用の非表示Chromiumを管理します。ブラウザの実行環境を使うため、Node.jsのプロセスだけでWASMを直接動かす方式ではありません。Chromiumは別途インストールし、拡張のdistやリポジトリには同梱しません。ライセンスは [README](../README.md#依存ライブラリ参照実装の権利表記)・各パッケージのLICENSE/NOTICE・ブラウザ付属の通知を参照してください。

APIの入力・画像・結果はこのPCのNode.jsと専用ブラウザを通り、呼び出し元へ返します。アプリはこれらを自動でファイル保存しません。既存の未加工応答ログは推論を実行するブラウザのConsoleに出力します。ブラウザプロファイルにはモデルのキャッシュ等が保存されます。起動時のURLとターミナルにはAPIトークンが含まれます。

Chrome拡張版は引き続き `npm run build` → `dist` で使えます。Web版は `dist-web` へ別に生成し、拡張版にlocalhost権限・サーバーAPI機能を追加しません。
