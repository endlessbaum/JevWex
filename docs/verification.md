# 検証記録

この文書は変更ごとの履歴です。各項目の実行済み・未実行、件数、速度、権限はその時点のものです。旧方式（モデルに数値JSONを生成させる方式）と現行方式（候補トークンのlogprobs）を混同せず、現行の判定結果は `token-readout-test-results.json` の `readout_method: candidate_token_logprobs_v1` を確認してください。過去のJSON記録は書き換えずに残しています。

## 最新: 公開向けドキュメント点検（2026-09-28）

README・THIRD_PARTY_NOTICES・docs内のMarkdownの計11文書を実装・保存済み検証記録・出典と照合しました。元の実装指示書と過去の機械可読テスト結果は変更していません。

- JEV / TypeSafe AIの公式製品との誤認を避ける表記、対応形式と精度の限界、名称検索が商標調査ではないことを明記。
- 古いJSON生成方式の出力・速度・未実行項目を履歴として区別し、現行方式の検証記録へ案内。4画面構成、モデル復元の条件、保存対象の説明を修正。
- Consoleの未加工応答と、手動保存ファイルに含む入力・診断の扱いを明記。データを一切保存しないと読める表現を修正。
- 上流の許諾文を `public/licenses/WASM-UPSTREAM-NOTICES.txt` に追加。通常ビルドのpublicコピーにより、拡張にも同梱。ライブラリ・WASM・推論処理は変更していません。

実行済み: 11文書の相対リンク・見出しリンク61件、実在する外部URL39件の到達確認（GitHub/Hugging Faceのファイルは対応するraw URLでも確認、説明用のプレースホルダーURL1件は除外）、npmビルド、通知3ファイルのコピー一致、著作権者表記、distにGGUFがないこと、npm配布WASMとのバイト一致。開発端末の絶対パスを本文から除去し、文書・保存済みJSONを対象に既知の認証キー形式や個人ディレクトリ名も検索しました。この検索は秘密情報の完全な不在保証ではありません。

未実行: 今回の文書変更後のChrome実行・実モデル推論・単体テストの再実行。未確定事項: JevWex自身の配布ライセンス、配布済みWASMの全構成物と通知の網羅的な確認、商標の権利調査。ドキュメント点検の完了を、これらの完了や公開許可の取得とは扱いません。commit・push・PR・公開は行っていません。

## 前回: 依存ライブラリ・検証モデルの権利表記（2026-09-28）

READMEに、同梱ライブラリ、参照実装、開発用の直接・間接依存、および動作検証に使用した4モデルのライセンスと配布元を追記しました。モデル本体・画像用ファイルは同梱せず、利用者が別途取得する前提を明記しています。llama.cppのMIT通知をTHIRD_PARTY_NOTICES.mdにも追加しました。アプリの処理・依存バージョン・モデル取得処理は変更していません。

実行済み: npmロックファイルと配布元のライセンス照合、主要ライセンスの固定版URL取得確認、README内の相対リンク確認、ビルド成功、distへの通知ファイルの同一コピー、distにGGUFがないこと、npm配布WASMとdist内WASMのバイト一致確認。

未実行: 今回の文書変更後のChrome実行・実モデル推論・単体テストの再実行。配布済みWASMの全リンク構成物・全通知の網羅監査も未実施です。過去の実行結果は以下に残しています。commit・push・PR・公開は行っていません。

## 前回: JevWexへの名称変更

拡張名、タブ名、画面ロゴ、結果ファイル名、npmプロジェクト名、READMEをJevWexに変更。起動先は `index.html`、旧 `jev.html` は同じ画面の互換入口として維持します。モデルキャッシュ・保存設定のキーは維持しています。

ユーザーの希望に合わせ、Jev + WebAssembly + Extensionの名称と「Chrome × WebAssembly」の表記を採用しました。名称選定時の完全一致Web検索・GitHub／Chrome Web Storeのドメイン指定検索ではJevWexの同名結果を確認できませんでした。これは限定的な検索結果であり、商標調査・名称の独占利用や権利上の安全性の確認ではありません。

実行済み: 型チェック、ビルド、実Chrome拡張の画面テスト7項目、デスクトップ画面の目視確認、互換入口のHTML一致確認。未実行: 名称変更後の実モデル推論と大量処理の再試験。推論方式・依存ライブラリは変更していません。公開・commit・push・PR作成は行っていません。

## 前回: SemIfを参考にした候補トークン確率方式

型チェック、単体テスト91件、ビルドが成功。旧方式の数値JSON生成テストを置き換え、語彙読取、logprobsの完全性、安定化softmax、3種類の結果計算、未加工ログ、欠損時にフォールバックしないことを検証しました。

ビルド済みChrome MV3（Chrome for Testing 145.0.7632.6）で実行済み:

- `npm run test:extension:readout`: 6項目。unsloth Qwen3-0.6B Q4_K_MでCPU判定、32候補の確率取得、GPU 29層・CPU 12スレッド・context 4096、利用者が報告した配送状況の文章、SmolLM2への切替、オフライン実行。各結果をlogprobsから再計算して一致を確認。
- `npm run test:extension:vision`: 8項目。LFM2.5-VL-3B Q4_K_Mと対応projector、キャッシュ再読込、赤青PNGの画像のみ判定、2画像、画像非対応モデルの拒否。LFMの候補AのIDは41、QwenのAは32で、モデル固定IDを使っていません。
- `JEV_BATCH_VISION=1 npm run test:extension:batch`: 7項目。CSVの混在判定、個別結果と集計、中止・再開、55件の文章とページ送り、画像10件（9件正常・1件破損）、11画像の上限拒否。外部HTTP通信なし。
- `npm run test:extension`: 7項目。基準編集、alias、画面分離、モバイル表示、権限とCSP。別途Qwen2.5 0.5Bで実score・結果保存を含む11項目も成功。
- ビルド済みWASMとnpm配布元のSHA256一致: `6ca9fdd1b6c03206cd3a04e359b52c8f539896d6c5fb5d36243dded4a689f0ad`。

実測例: Qwen3 GPU 29層・12スレッドで初期3基準は約0.57秒、報告された配送状況の文章の3基準は約0.59秒。いずれもモデル読込を除く1回の測定であり、旧方式との条件を統一した速度比較ではありません。全基準の生成トークン数は各1です。

形式・計算が正しくても意味判断には誤りがありました。配送状況の文に対する返金要求の当てはまり約0.96、32候補問題の誤分類を記録しています。これを精度テスト合格とは扱いません。

未実行: 全GGUF・全tokenizerでの互換確認、大規模な精度・校正評価、10,000件実推論と長時間耐久、実写真/OCRの評価、条件を統一した旧方式との速度比較。

[判定方式・制限](token-readout.md)、[実入力・分布・機械可読検証記録](token-readout-test-results.json)。既存指示書は変更せず、commit・push・PR・公開は行っていません。

## 前回: 一括判定

型チェック・単体テスト100件・ビルドが成功。実Chrome拡張で既存UI7項目と一括判定7項目が成功しました。CSV取込、個別内訳、3種の集計、実推論の中止・再開、55件の文章判定とページ送り、画像10件（正常9件＋不正1件）の処理を確認しています。10,000件を最後まで実モデルで判定する耐久試験は未実行です。[一括判定の操作・実行済み／未実行](batch.md)、[機械可読記録](batch-test-results.json)

## 前回: 前回のモデルとハードウェア設定の復元

型チェック・単体テスト93件・ビルドが成功。実Chrome拡張で既存UI7項目と復元テスト7項目が成功しました。ブラウザ終了・再起動後のオフラインCPUモデル復元、GPU設定の復元と実推論、壊れたモデル・保存ファイル不在・利用不能設定からの復旧を確認しました。実行済みと未実行は [startup.md](startup.md)、記録は [startup-test-results.json](startup-test-results.json) にまとめています。

## 前回: 画像入力

型チェック・91件の単体テスト・ビルド、既存UIの7項目が成功しました。実Chrome拡張でLFM2.5-VL-3B本体と画像用ファイルの取得・再読込後のオフライン利用・PNG画像による3種判定・複数画像・非対応モデルの拒否など8項目を確認しました。赤青のchoiceとnoulは画像に応じて変わりましたが、scoreにはモデルの誤判定があり、精度成功とは扱っていません。

実行済み／未実行と精度上の観察は [vision.md](vision.md)、実測の入力・生出力は [vision-test-results.json](vision-test-results.json) に分けて記録しています。

## 前回: ハードウェア設定

ハードウェア設定画面、CPUスレッド数・WebGPU・文章量の選択、保存と明示的なモデル再ロードを追加しました。84件の単体テスト・型チェック・ビルド成功。実Chrome拡張でCPU 1スレッド→4スレッド→GPUへの切替と各実推論、GPU25層の配置、設定の保存・再適用を確認しました。[設定と実測値](hardware.md)、[機械可読記録](hardware-test-results.json)

既存UIのモデルなしテストも再実行し、編集・画面移動・モバイル幅等の7項目が成功しました。実行済みと未実行の範囲はhardware.mdに分けて記載しています。

Qwen3-0.6B Q4_K_MでもGPU全29層への配置と初期問い合わせサンプルの3種混在判定が成功（約18.11秒）。新しいCOEP/COOPでモデル取得、キャッシュ再利用、オフラインGPU読込と実推論、結果ダウンロードの6項目が成功しました。[Qwen3記録](hardware-qwen3-test-results.json)、[UI再確認記録](hardware-ui-test-results.json)

## 前回: モデル管理・判定画面の分離

画面を `#models` と `#judge` に分け、JSON入力・内部ID編集を廃止しました。基準名alias、ラベルと説明の行編集、段階順の並べ替え、結果JSONのファイル保存に対応しています。型チェック・81件の単体テスト・ビルドが成功しました。

Chrome for Testing 145.0.7632.6のビルド済み拡張で11項目成功。画面移動／戻るでの入力保持、内部IDを変えないalias編集、ラベル追加・削除、段階の並べ替えと種類切替時の保持、1440px・390px幅、Qwen2.5-0.5B Q4_K_Mの実ロード・画面移動後の実score判定、ラベル・alias・入力・生出力を含む実ファイルダウンロード、編集後の旧結果維持、モデル解放、外部通信なしを確認しました。[ui-test-results.json](ui-test-results.json)

新しいモデル管理画面で `npm run test:extension:repo` も実行し、Qwen3の実ダウンロード・キャッシュ再利用・オフライン読込等の5項目が成功しました。[ui-model-download-test-results.json](ui-model-download-test-results.json)

未実行：今回のUIでの全3種混在の実推論、更新した異常系テスト、中止完了タイミングの再検証、意味的な精度ベンチマーク。過去のテスト結果を今回の実行済み件数へ合算していません。

### 前の数値表示調査

UI変更前に、指定されたQwen3-0.6B Q4_K_Mと問い合わせサンプルの3つ目の質問を単独実行して確認しました。初期文は生出力 `[0,0,1]` → score 2 / confidence 1、返金要求を削った文は `[0.5,0.5,0]` → score 0.5 / confidence 0.25、「なんとかしてください」は `[0,0.5,1]` → score 約1.667 / confidence 0.5でした。生出力からの再計算・メーターの値・表示値は一致しています。曖昧な文でも高い段階に重みを置くモデルの判定傾向はありますが、画面が数値を捏造しているわけではありません。confidenceは正答率ではありません。[score-investigation-results.json](score-investigation-results.json)

## 前回: choice・scoreの重みを正規化

departmentでも合計2を受理するよう、choiceの合計チェックも撤去しました。choice・scoreとも各値が有限の0〜1で合計が正なら正規化します。75件の単体テスト、型チェック、ビルドが成功しました。departmentの合計2、request_specificityの合計1.2、noulを一度に処理するモック回帰テストで、全質問の結果と元の和の診断記録を確認しています。

モデルなしの実Chrome拡張テストは6項目成功しました。記録は [choice-normalization-ui-test-results.json](choice-normalization-ui-test-results.json)。今回変更後の実モデル推論と、前回タイムアウトした中止テストは再実行していません。

## 前回: score合計チェックの緩和

ユーザー指定により、scoreの段階別出力を相対的な重みとして扱い、和が1.2などでもエラーにせず正規化して計算します。choiceの合計チェックは維持します。元の和はdiagnosticsに記録します。型チェック、75件の単体テスト、ビルドが成功しました。合計1.2のrequest_specificityが最後まで評価される回帰テストはモック出力を使用しています。

ビルド済み拡張でQwen2.5-0.5B-Instruct Q4_K_Mによるchoice・score・noul単独と複数質問の実判定が成功しました。ユーザーが使った入力そのものとQwen3による同じ出力の再現、意味的な精度評価は未実行です。

今回の `test:extension` 全体は成功していません。判定成功後の中止完了待ちが30秒でタイムアウトしたため、中止後の再実行とそれ以降の検査は今回未完了です。結果は [score-normalization-test-results.json](score-normalization-test-results.json) を参照してください。

**更新:** 拡張内ダウンロードを追加しました。現在の取得権限・キャッシュ再利用テストは [model-download.md](model-download.md) とその機械可読記録を参照してください。以下は初回実装時の検証記録であり、権限なし・キャッシュ読込未実行の記述は当時の状態です。

## 初回実装時の記録（旧方式・旧UI）

以下の全項目は初回実装当時の記録です。最大生成1024トークン、JSON入力、host permissionsなし、GPU未提供などの記述は現在の仕様には当てはまりません。

実施日: 2026-09-28。元のディレクトリは指示書のみ（Gitリポジトリなし）。元の指示書は変更していません。

### 環境・依存

- Windows、Node.js 22.20.0、npm 10.9.3
- Chrome for Testing **145.0.7632.6** / Playwright 1.58.2、ヘッドレスの隔離プロファイル
- `@wllama/wllama` **3.6.1**（npm公開配布版・package.json完全固定・package-lock.json）
- 同じ3.6.1のJS/Workerと `src/wasm/wllama.wasm` を使用。WASM SHA256: `6ca9fdd1b6c03206cd3a04e359b52c8f539896d6c5fb5d36243dded4a689f0ad`
- CPU/WASM、1スレッド、context 4096、最大生成1024トークン

`chrome-extension://njffakcbeheenofiiodpdffhangefbmk/jev.html` で実行しました（IDはパス・環境依存）。localhost/dev serverの結果ではありません。テストの `--enable-unsafe-extension-debugging` はCDPのunpackedロードを有効にするためだけのフラグです。CSPやWeb Securityを無効化するフラグは使用していません。

### 実行コマンド

```powershell
npm ci --no-audit --no-fund
npm run typecheck
npm test
npm run build
npx playwright install chromium
$env:JEV_TEST_MODEL = (Resolve-Path '.models/qwen2.5-0.5b-instruct-q4_k_m.gguf').Path
$env:JEV_TEST_SECOND_MODEL = (Resolve-Path '.models/SmolLM2-135M-Instruct.Q4_K_M.gguf').Path
npm run test:extension
npm run test:extension:errors
```

モデルは拡張がダウンロードしたものではなく、検証作業で取得したローカルファイルをfile inputから選択しました。`JEV_TEST_MODEL`未設定の `test:extension` はUI/CSPのモデルなしテストのみを実行し、実モデルテストをnotRunへ明示します。モデル・ブラウザのダウンロードはテスト準備でのみネットワークを使用します。判定時にはブラウザコンテキストをオフラインにしています。

### 実行済み: モデルなし自動テスト

型検査成功。`npm test` **53件成功、0失敗**。

- 3種類の入力、構造化state/instructions/criteria、null choice説明
- 空質問、不明型・フィールド、段階・候補数、巨大入力・深いJSON、非有限数
- フォーム/JSON共通経路、重複ID・重複JSONキー（エスケープ表現も検出）
- 日本語・引用符・改行ラベル、`__proto__` / `constructor` の安全な保持
- schema必須キー、余分なキー拒否、全段階の網羅
- 欠損・負数・1超過・数値文字列・ゼロ和・許容範囲外の和・不完全出力
- 正規化許容値0.01、元の和の診断記録、argmax・同率規則・score期待値・legend
- 公式confidence例と境界、noulの数値保持
- モックによるモデル切替、中止完了待ち、連打拒否、再実行、テンプレート欠如、未登録model、古い結果破棄
- 生成上限・異常終了・質問途中失敗を全体成功にしないこと
- 入力snapshot、不正context/templateエラーの分類

この層のモック成功は実推論成功には数えていません。

### 実行済み: production拡張の主要テスト

`test:extension` **20項目成功**。詳細は [extension-test-results.json](extension-test-results.json) に保存しています。

- MV3ロード、フォーム/JSON往復、UIでの重複JSONキー拒否
- オフラインのローカルGGUF読込、公開版Worker/WASM初期化
- 実モデルのchoice / noul / score単独、3種類混在の直列判定
- 再実行でロード世代維持（モデル再ロード・再取得なし）
- state内の余分なキー要求に対しschema範囲内だけを受理
- 実推論の中止完了、中止後の再実行
- 入力・結果・診断JSONのクリップボード書込
- 判定中の入力編集、古い到着結果の破棄
- 解放・再読込・再実行、ページ再読込後のローカルファイル再選択要求
- 別の実GGUFへのUI選択・ランタイム切替
- ページ/Workerから観測された外部HTTP(S)要求0件、ブラウザconsole/pageエラー0件
- 閲覧ページ権限・host permissions・content scriptなし

型検査・入力エラーコード・経過表示の最終調整後にもクリーン依存でproduction buildを再実行しました。最終ビルドに対するモデルなしUI/CSPテスト6項目も成功し、[final-ui-test-results.json](final-ui-test-results.json) に保存しています。

`test:extension:errors` **8項目成功**。最終ビルドの [error-recovery-test-results.json](error-recovery-test-results.json) に保存しています。

- 空GGUF入力を `INVALID_REQUEST` として拒否
- 壊れたGGUFを利用不可として拒否（本版ではチャットテンプレート欠如として `MODEL_UNSUPPORTED`。ロード済み表示にはならない）
- 読込失敗後の正しいモデル読込、読込中の入力編集
- 未登録の入力model `jev-latest` を拒否
- 実モデルに6,000回のcatを含む入力を与え、切り捨てず `CONTEXT_LIMIT` として拒否
- contextエラー後に短い入力で実推論を再実行
- タブ終了後に所有Workerが終了し、評価できなくなること
- 外部HTTP(S)要求0件

スクリーンショットでフォーム・JSON入力・結果表示を目視確認しました。画像は `.test-artifacts/jev-form.png`、`.test-artifacts/jev-page.png`、`.test-artifacts/jev-final.png`。配布物とnpm版WASMのSHA256一致も確認済みです。

### 検証モデルと精度上の観察

| モデル | 取得元 | ファイルサイズ / SHA256 |
|---|---|---|
| Qwen2.5-0.5B-Instruct Q4_K_M | [Qwen公式GGUF](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF) | 491,400,032 bytes / `74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db` |
| SmolLM2-135M-Instruct Q4_K_M | [QuantFactory GGUF](https://huggingface.co/QuantFactory/SmolLM2-135M-Instruct-GGUF) | 105,454,144 bytes / `8030f04528538d47bda434f6f0bdf3952c40a58123e4d5e755332f23731a8684` |

Qwenのテスト入力は英語の「The cat sleeps on the sofa.」に対するanimal/vehicleのchoice、catを含むかのnoul、記述の詳細度scoreです。単独と混在の形式検証を実施しました。モデルや期待する答えをアダプタへ固定していません。

実際のQwen結果はchoice animal=0.9 / vehicle=0.1、noul=0.9999999999999999でした。一方scoreは「動物名だけ」段階を0.9、「動物と行動」段階を0.1としてscore=0.1となり、文中に行動があることを十分に評価できませんでした。**scoreは形式には適合しましたが意味的には不適切な判定です。** 数値を修正して正答扱いしていません。

SmolLM2はモデル読込に成功しましたが、choiceで確率の和2の不正分布を生成しました。UIは `INVALID_OUTPUT / 質問 animal` を表示し、成功responseを表示しませんでした。この失敗はモデル出力の制限として記録し、分布の無制限な修復は行っていません。

形式検証は正答率評価ではありません。単一の簡単な英語入力を通過しても、日本語サンプルを含む一般的な分類精度・校正・速度は保証しません。

### CSPの実測

1. 通常拡張のCSPに `worker-src 'self' blob:` を明記すると、Chromeの `Extensions.loadUnpacked` が `Insecure CSP value "blob:" in directive 'worker-src'` と拒否。
2. 指示書の候補であるsandboxを小さく試したが、opaque-originでWorkerエラーとなり初期化完了しなかった。
3. 通常拡張ページで `script-src 'self' 'wasm-unsafe-eval'` を使用し、worker-srcを明記しないと、同じ公開wllamaのWorker/WASM/モデル読込に成功。**これを最終実装として採用**。

sandboxやBlob許可の追加を最終manifestに残していません。`setCompat(null)`、ローカルWASM、外部通信を許可しないconnect-srcを使用します。

### 未実行・制限

- 分割GGUFの実ファイル読込、既存キャッシュ済みGGUFの実ファイル読込
- 実モデルでの生成上限1024トークン到達・途中JSON切断（モック／validatorでは実行済み）
- テンプレートなし実GGUF（セッションのモックでは実行済み）
- 日本語の全サンプルの精度評価、統計的な校正・速度ベンチマーク
- 他のChromeバージョン、Firefox/Safari、GPU・マルチスレッド（提供経路外）
- ストア公開、commit、push、PRは指示に従い未実施

ブラウザ実行テストの機械可読結果は併記するJSONを参照してください。未実行事項を成功扱いしていません。
