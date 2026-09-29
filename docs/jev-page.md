# ページの利用・内部構成

この文書はChrome拡張版について説明します。同じUIを配信するWeb版と、画面を閉じても使えるサーバー管理のHTTP APIは [server.md](server.md) を参照してください。

## 起動

Node.js 22で `npm ci` → `npm run build`。生成された `dist` をChromeへunpacked extensionとして読み込みます。従来の `index.html` は独立した管理用タブとして、モデル管理・ハードウェア設定・一括判定・手入力判定・URL別条件管理を提供します。拡張アイコンは専用の `panel.html` を開き、閲覧中のページを取り込みます。パネルでは条件の作成とオン／オフができ、オンの条件で判定します。`Alt+Shift+J` からパネルを開かずに実行することもでき、結果は対象ページのオーバーレイに表示します。Service Workerは起動・取得・実行の取りまとめを担当し、推論は管理用タブで読み込んだModelSessionへ依頼します。[Webページ判定・URL別条件管理](web-pages.md)

## モデル

- 左メニューの「モデル管理」は `index.html#models`、「判定」は `index.html#judge`、「一括判定」は `index.html#batch`、「ハードウェア設定」は `index.html#hardware` です。同時に表示しない4画面のルーティングで、履歴の戻る操作にも対応します。同じdocument内にモデルセッションと編集中のフォームを保持し、画面移動でモデルの再読み込み・常駐バックグラウンド推論を発生させません。
- 「端末のファイルから追加」で登録し、ドロップダウンから選んで「読み込む」。分割GGUFは全パートを一度に選択し、wllamaの公開 `loadModel(Blob[])` に渡します。
- 同じタブ内で登録したモデルを切り替えられます。選択中と読込済みのファイル名は別表示です。選択だけではロード済みモデルは変更されません。
- 既存のwllamaキャッシュは公開 `ModelManager.getModels()` で列挙し、公開 `Model` を `loadModel` に渡します。暗黙のdownload/refreshは行いません。
- 「モデルをダウンロード」からリポジトリ名またはHTTPS URLの公開GGUFを取得できます。wllama公開APIと既存OPFSキャッシュを利用し、進捗・中止・再読込後の再利用に対応します。独自キャッシュ基盤は作っていません。[操作・制限](model-download.md)
- ローカルファイル入力はタブ内だけで保持し、再読込後に再選択が必要です。state・結果はアプリが自動で永続保存しません。モデルデータはキャッシュへ、最後に読み込めたモデルの識別情報・ハードウェア設定はlocalStorageへ保存します。モデル応答のConsole出力と手動の結果保存については [データの扱い](../README.md#データ通信結果の扱い) を参照してください。
- 実行モデルはアダプタに固定していません。モデル名・テンプレート・トークンIDの固定や補完もありません。GGUFにテンプレートがない場合は `MODEL_UNSUPPORTED`。
- CPUスレッド数、WebGPUへの層配置、文章量をハードウェア設定から選択できます。初期値はCPU・スレッド数自動・context 4096。並列スロット1、`ctx_shift: false` でコンテキスト超過を黙って切り捨てません。読込初期化が180秒で完了しない場合はWorkerを解放して利用不可エラーにします。[詳細](hardware.md)

## 入力・結果

判定画面では「判定する文章」「判定基準」「基準名」「判定する内容・条件」を使い、JSON編集・内部IDの入力・技術的なフィールド名は表示しません。判定方法は選択式（choice）、段階評価（score）、当てはまり（noul）の3種です。画面から内部形式への変換は `criteria-editor.ts` に集約し、既存のvalidator・アダプタを再利用します。

「基準名」は内部IDとは別のaliasです。新しい基準のIDはUUIDで作り、名前を編集しても変えません。aliasは推論指示に追加せず、画面とダウンロードのpresentationに保持します。choiceはラベルをキーとした説明mapに変換します。scoreは低→高の順の `{label, description}` 配列に変換し、説明とラベルをモデルへ渡します。ラベル・説明を対にして追加・削除でき、scoreは上下ボタンで順序を変更できます。重複ラベル・空ラベル・基準名なしは分かりやすいエラーにします。choiceは2〜32件、scoreは2〜10段階です。判定方法を切り替えても、その基準内の他方式の入力は保持します。

入力例は問い合わせ分類、記事ジャンル、案内文の条件確認の3件です。構造化された初期サンプルも文章へ展開し、利用者にオブジェクトを編集させません。結果値を事前表示しません。実行時にロード済みモデルも検証します。

結果は基準名とラベル付きのカードです。scoreは点数と満点を表示します。割合は候補トークン間で正規化した確率であり、正答率ではない旨を併記します。confidenceは「重みの集中度」として表示します。「結果をダウンロード」は `{response, diagnostics, input, presentation}` のJSONファイルを保存します。responseのJEV形式は維持し、presentationで内部IDと表示名・段階ラベルを対応付けます。画面を編集した後も、ダウンロードするのは判定時の入力・表示名です。生成文字・候補logprobs・計算値をdiagnostics.model_outputsへ含めます。

編集中の古い結果には前回結果の表示を付けます。実行中に入力やモデル選択が変わると、その実行の到着結果を破棄します。入力欄はモデル読込中・判定中も操作できます。中止ボタンは公開 `abortSignal` へ伝播し、wllamaの中止完了を待ちます。切替・解放は中止完了後に行います。エラー後の再実行は明示操作のみです。

## 拡張の実行環境

**通常の拡張ページ直下で実行します。sandboxは最終成果物にありません。**

標準の `script-src 'self' 'wasm-unsafe-eval'` を利用し、Chrome for Testing 145でBlob WorkerとWASMを実測しました。`worker-src blob:` を明示した案はChromeの拡張インストール時に拒否されましたが、明示しない標準CSPで実行できました。途中検証したopaque-origin sandboxではWorker初期化が完了しなかったため採用していません。CSPやWeb Securityを無効化していません。

JS・Workerコードはnpm配布物を通常のバンドル処理で同梱し、WASMは同じ3.6.1配布物からbuildでコピーします。`setCompat(null)` で互換CDN取得を無効化します。connect-srcの外部通信先は明示的モデル取得用の `huggingface.co` と実測した `us.aws.cdn.hf.co` に限定します。JS内に依存元の未使用CDN文字列が残っていても、それを取得する設定にはしません。起動時に外部フォント・モデル・JS・WASMを取得しません。

拡張版はモデル配信用の限定host permissionsに加え、`activeTab`・`scripting`・`storage`・`sidePanel` を使用します。常駐content scriptは登録せず、ユーザーの取得操作で表示テキストを読み取ります。推論を行う拡張ページは自身の専用Workerを所有し、document破棄でWorkerが終了します。`pagehide` での公開 `exit()` は補助的処理です。終了イベントの非同期完了には依存しません。サーバー版の実行環境は [server.md](server.md) を参照してください。

## ファイル

- `src/pages/jev`: UIと古い非同期結果の抑止
- `src/features/jev`: 型、validator、token readout、prompt、数値計算、直列アダプタ、サンプル
- `src/inference`: 公開wllama APIを使う単一モデルセッションと同梱資産設定
- `public`: 最小MV3 manifest、起動Service Worker、HTML
- `scripts/build.mjs`: 通常バンドル、同一バージョンWASM・ライセンスの自動コピー
- `tests/jev`: モデルなしの純粋関数・モックセッションテスト
- `tests/extension`: production拡張の実ブラウザテスト

再ビルド後はChromeの拡張管理画面で再読み込みし、判定タブも開き直してください。

製品名はJevWex（ジェヴェックス）、名前の由来はJev + WebAssembly + Extensionです。画面に「Chrome × WebAssembly」と添えています。旧URLのブックマークも使えるよう、ビルド時に `jev.html` を互換入口として残しています。保存キーとキャッシュの識別は維持し、既存のモデル・ハードウェア設定を引き継ぎます。
