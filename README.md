# JevWex（ジェヴェックス）

**Chrome × WebAssembly — ブラウザで動くローカルAI判定。**

文章や画像を、自分で決めた基準で判定・分類するChrome拡張です。名前は **Jev + WebAssembly + Extension** に由来します。[TypeSafe AIのJEV / System One](https://docs.typesafe.ai/primitives/choice)の入出力形式を参考にした独立プロジェクトです。TypeSafe AIや参照ライブラリ・モデルの開発元による公式製品ではなく、提携・承認を示すものでもありません。

選択したGGUFモデルを公開版 `@wllama/wllama@3.6.1` で動かします。JEVモデル自体は含まず、JEVと同じ精度・速度・確率を再現する実装ではありません。ライブラリのfork・patch・binding追加・独自WASMビルドはありません。

## 導入と使い方

ビルドはNode.js 22で確認しています。Chrome for Testing 145で動作検証済みです。GPU利用にはブラウザ・OS・ドライバのWebGPU対応が必要です。

```powershell
npm ci
npm run typecheck
npm test
npm run build
```

Chromeの拡張機能管理画面でデベロッパーモードを有効にし、「パッケージ化されていない拡張機能を読み込む」から **このプロジェクトの `dist` フォルダ** を選択してください。ツールバーの拡張アイコンを押すと、通常のタブにJevWexが開きます。

1. 左メニューの「モデル管理」でモデルをダウンロードするか、端末のGGUFファイルを追加し、「読み込む」を押します。
2. 「判定」へ移動し、文章や画像と判定基準を入力します。画像は対応モデルで利用でき、画像だけでも判定できます。基準には表示名を付け、選択肢・段階は「ラベル」と「説明」の欄で編集します。
3. 「判定する」を押すと、基準名ごとの結果が表示されます。
4. 「結果をダウンロード」で結果・入力・表示名・実行情報を含むJSONファイルを保存できます。通常の操作にJSON入力は不要です。

モデル管理と判定は別の画面です。同じタブ内で移動すると入力と読み込み済みモデルが保持されます。基準の内部IDは自動管理し、画面には出しません。

「一括判定」ではCSV・表の貼り付け・文章一覧（最大10,000件）、画像一覧（最大10枚）を共通の基準で処理できます。個別の内訳と集計、検索、中止・再開、CSV保存に対応しています。[一括判定の操作と検証](docs/batch.md)

最後に読み込めたモデルと保存したハードウェア設定を記憶します。次回は判定画面でキャッシュに残っているモデルを自動読み込みし、準備が終わると判定できます。キャッシュが削除された場合は追加し直してください。端末から直接選んだGGUFは、名前を表示して再選択を案内します。[起動時の復元と検証](docs/startup.md)

`LiquidAI/LFM2.5-VL-3B-GGUF` などの画像モデルでは、本体と画像用ファイルをまとめてダウンロードできます。PNG・JPEGの追加、プレビュー、削除に対応しています。[画像入力の操作・実測・制限](docs/vision.md)

「ハードウェア設定」でCPUスレッド数、GPU（WebGPU）、文章量の上限を選べます。初期設定はCPU・スレッド数自動です。読み込み済みモデルには「モデルを再読み込みして適用」で反映します。[操作と実測結果](docs/hardware.md)

`unsloth/Qwen3-0.6B-GGUF` のようなリポジトリ名、またはGGUF直接URLを入力して「ダウンロード」を押すと取得を開始します。リポジトリ名では `Q4_K_M` を選択します。進捗を表示し、中止もできます。ダウンロード済みモデルは拡張のキャッシュに保存され、再読込後も選択できます。ローカルファイル入力の場合は再読込後に再選択してください。チャットテンプレート付きの対応GGUFが必要です。表示確率は候補トークンのlogprobsから計算した、候補間の条件付き確率です。モデルに数値JSONを書かせません。JEVモデルの確率や実測正答率ではありません。[判定方式と検証](docs/token-readout.md)

既にインストール済みの場合は、Chromeの拡張管理画面で拡張を再読み込みし、判定タブを開き直してください。[ダウンロードの操作・制限](docs/model-download.md)

## データ・通信・結果の扱い

判定する文章・画像・結果を外部の推論APIへ送信する処理はありません。モデルの取得操作ではHugging Faceと許可したモデル配信先へ通信します。モデルの準備後はキャッシュまたは端末のファイルで推論します。

モデルデータは拡張のキャッシュへ、最後に使用したモデルの識別情報とハードウェア設定はlocalStorageへ保存します。入力文章・画像・判定結果をアプリが自動で永続保存する機能はありません。ただし、**モデルの未加工応答は開発者ツールのConsoleに出力します**。手動で保存する結果JSON・CSVには入力文章や結果、画像のファイル名などが含まれます（画像本体は含みません）。ログや結果ファイルを共有する場合は内容を確認してください。

表示する確率や「重みの集中度」は正答率ではありません。テストでは形式・計算が正しくても意味判断を誤る例を確認しています。一括判定の10,000件は入力受付上限であり、同件数の実推論・耐久試験は未実施です。検証環境と実行済み・未実行の範囲は [検証記録](docs/verification.md) を参照してください。

## 依存ライブラリ・参照実装の権利表記

確認日: **2026-09-28**。npmのバージョンとライセンスは `package-lock.json` とインストール済みパッケージの表記を確認しています。第三者のライセンスは、それぞれのコード・モデルに適用されます。**JevWex自身のコードの配布ライセンスは現時点で未設定です**（ルートの `LICENSE` と `package.json` の `license` は未追加）。

### 拡張に含まれるもの・参考にした実装

| 対象 | 使用箇所 | ライセンス・出典 |
| --- | --- | --- |
| `@wllama/wllama` 3.6.1 | 推論用JavaScript・Worker・配布済みWASM | [MIT / Xuan Son NGUYEN](https://github.com/ngxson/wllama/blob/3.6.1/LICENCE) |
| llama.cpp / ggml / mtmd | wllamaの上流推論・画像処理コード | [MIT / The ggml authors](https://github.com/ggml-org/llama.cpp/blob/83d855c5a6d70487121edbf4020b25c96b7a04e7/LICENSE)。wllama 3.6.1が参照するコミットは `83d855c5a6d70487121edbf4020b25c96b7a04e7` |
| SemIf | 1トークンの候補確率を取り出す方式を参考に実装 | [MIT / TheoLeeCJ](https://github.com/tseanard/SemIf/blob/ca3ba65f142967030ecb453346e94d6f476a69df/LICENSE) |
| TypeSafe System One Adapter | 検証済み分布に対するconfidence計算式を参考に実装 | [MIT / TypeSafe AI](https://github.com/typesafe-ai/system-one-adapter-python/blob/e1d4cc938204b22fc5a3c3aca7044072fe3f712d/LICENSE) |

wllamaは公開npm配布物を使用し、WASMをそのままコピーします。SemIfやTypeSafeのランタイム・モデルは同梱していません。著作権・許諾文は [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) に記載し、ビルド時に `dist/THIRD_PARTY_NOTICES.md` と `dist/runtime/WLLAMA-LICENSE.txt` を同梱します。

確認した上流部品の許諾文も [WASM-UPSTREAM-NOTICES.txt](public/licenses/WASM-UPSTREAM-NOTICES.txt) に収録し、ビルド時に `dist/licenses/` へコピーします。wllamaのビルドスクリプトが指定するEmscripten 4.0.20の通知と、同ツリーのmuslの通知も含みます。追加したのは文書のみで、ライブラリやWASMは変更していません。

llama.cppの上流ソースには個別ライセンスの部品もあります。同じ固定コミットで、[nlohmann/json（MIT）](https://github.com/ggml-org/llama.cpp/blob/83d855c5a6d70487121edbf4020b25c96b7a04e7/vendor/nlohmann/json.hpp)、[stb_image（MITまたはPublic Domain）](https://github.com/ggml-org/llama.cpp/blob/83d855c5a6d70487121edbf4020b25c96b7a04e7/vendor/stb/stb_image.h)、[miniaudio（MIT-0またはPublic Domain）](https://github.com/ggml-org/llama.cpp/blob/83d855c5a6d70487121edbf4020b25c96b7a04e7/vendor/miniaudio/miniaudio.h)、[subprocess.h（Unlicense）](https://github.com/ggml-org/llama.cpp/blob/83d855c5a6d70487121edbf4020b25c96b7a04e7/vendor/sheredom/subprocess.h)、[xxHash（BSD-2-Clause）](https://github.com/ggml-org/llama.cpp/blob/83d855c5a6d70487121edbf4020b25c96b7a04e7/vendor/hash/xxhash/LICENSE)、[SHA-1](https://github.com/ggml-org/llama.cpp/blob/83d855c5a6d70487121edbf4020b25c96b7a04e7/vendor/hash/sha1/sha1.h)・[SHA-256（Public Domain）](https://github.com/ggml-org/llama.cpp/blob/83d855c5a6d70487121edbf4020b25c96b7a04e7/vendor/hash/sha256/LICENSE)の表記を確認しました。これは上流ソースの確認であり、配布済みWASMの最終リンク内容やEmscripten等の実行時部品を含む、全構成物・全通知の網羅監査は未実施です。

### 開発・ビルド・テスト用の依存

以下は開発用依存で、これらのパッケージ自体を拡張に同梱しません。

| パッケージ | バージョン | ライセンス・配布元 |
| --- | --- | --- |
| `@types/chrome` | 0.1.24 | MIT / [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/chrome) |
| `@types/node` | 22.19.15 | MIT / [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/node) |
| `esbuild` | 0.25.12 | MIT / [esbuild](https://github.com/evanw/esbuild/blob/v0.25.12/LICENSE.md) |
| `playwright` | 1.58.2 | Apache-2.0 / [Playwright](https://github.com/microsoft/playwright/blob/v1.58.2/LICENSE) |
| `prettier` | 3.6.2 | MIT / [Prettier](https://github.com/prettier/prettier/blob/3.6.2/LICENSE) |
| `tsx` | 4.21.0 | MIT / [tsx](https://github.com/privatenumber/tsx/blob/v4.21.0/LICENSE) |
| `typescript` | 5.9.3 | Apache-2.0 / [TypeScript](https://github.com/microsoft/TypeScript/blob/v5.9.3/LICENSE.txt) |

ロックファイル内の間接依存も確認しています。`playwright-core` 1.58.2はApache-2.0です。`@types/filesystem` 0.0.36、`@types/filewriter` 0.0.33、`@types/har-format` 1.2.16、`undici-types` 6.21.0、`get-tsconfig` 4.14.3、`resolve-pkg-maps` 1.0.0、`fsevents` 2.3.2 / 2.3.3、tsx経由の `esbuild` 0.27.7、およびesbuildの各OS向け任意依存パッケージはMITです。テスト用のChrome / Chromiumも拡張には同梱していません。

MITは著作権・許諾文の保持を条件とします。Apache-2.0はライセンスの添付、既存通知の保持、変更箇所の明示、提供されている場合のNOTICEの引継ぎなどを定めています。商標の使用許諾とは別です。詳細は各配布物のライセンスと [Apache-2.0本文](https://www.apache.org/licenses/LICENSE-2.0) を参照してください。

## 動作検証に使用したモデル（同梱なし）

**モデル本体（GGUF）・画像用ファイル（mmproj）は、ソース配布物にもビルド済みChrome拡張にも同梱しません。** 利用者が配布元から別途ダウンロードするか、手元のファイルを選択します。以下は過去の動作検証に使用したモデルの記録であり、必須モデルや精度の保証を示す一覧ではありません。[検証内容と制限](docs/verification.md)

| 配布元・モデル | 検証したファイル | ライセンス・確認先 |
| --- | --- | --- |
| [unsloth/Qwen3-0.6B-GGUF](https://huggingface.co/unsloth/Qwen3-0.6B-GGUF) | `Qwen3-0.6B-Q4_K_M.gguf` | Apache-2.0。GGUF配布カードと[元モデルQwen3-0.6BのLICENSE](https://huggingface.co/Qwen/Qwen3-0.6B/blob/c1899de289a04d12100db370d81485cdf75e47ca/LICENSE)を確認 |
| [Qwen/Qwen2.5-0.5B-Instruct-GGUF](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF) | `qwen2.5-0.5b-instruct-q4_k_m.gguf` | [Apache-2.0](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/blob/9217f5db79a29953eb74d5343926648285ec7e67/LICENSE) |
| [QuantFactory/SmolLM2-135M-Instruct-GGUF](https://huggingface.co/QuantFactory/SmolLM2-135M-Instruct-GGUF) | `SmolLM2-135M-Instruct.Q4_K_M.gguf` | Apache-2.0。GGUF配布カードと[元モデルSmolLM2-135M-Instructの表記](https://huggingface.co/HuggingFaceTB/SmolLM2-135M-Instruct/blob/12fd25f77366fa6b3b4b768ec3050bf629380bac/README.md)を確認 |
| [LiquidAI/LFM2.5-VL-3B-GGUF](https://huggingface.co/LiquidAI/LFM2.5-VL-3B-GGUF) | `LFM2.5-VL-3B-Q4_K_M.gguf` と `mmproj-LFM2.5-VL-3B-Q8_0.gguf` | [LFM Open License v1.0](https://huggingface.co/LiquidAI/LFM2.5-VL-3B-GGUF/blob/6f730e9a2c454e8af9adc29db58e638e01e5957f/LICENSE)（独自ライセンス） |

LFM2.5-VLはApache-2.0ではありません。LFM Open License v1.0には、年間売上1,000万米ドルを基準とする商用利用の制限があります（第1条・第5条。関連企業を含むLegal Entityの定義も参照）。該当する事業利用では別途許諾の条件を配布元に確認してください。

確認したGGUF配布リポジトリのリビジョンは、Qwen3: `50968a4468ef4233ed78cd7c3de230dd1d61a56b`、Qwen2.5: `9217f5db79a29953eb74d5343926648285ec7e67`、SmolLM2: `476854d00ede130660aba430d15f9347ad2e7d0e`、LFM2.5-VL: `6f730e9a2c454e8af9adc29db58e638e01e5957f` です。これは権利表記の調査時点の記録です。アプリの通常の取得URLは `main` を参照するため、過去の検証ファイルや将来のダウンロードと同一リビジョンであることを保証するものではありません。

同梱しない場合でも、モデルを利用する際はそのモデルの条件が適用されます。別のモデル・量子化・画像用ファイルを選ぶ際は、配布元と元モデル双方のモデルカード・LICENSEを確認してください。GGUF化によって元モデルの条件がなくなるわけではありません。JevWexのライセンスや、この表の条件が任意のダウンロード先すべてに適用されるわけではありません。

## ドキュメント

- 操作・構成: [docs/jev-page.md](docs/jev-page.md)
- 互換範囲・数式: [docs/jev-compatibility.md](docs/jev-compatibility.md)
- 実行済み／未実行テスト: [docs/verification.md](docs/verification.md)
- ライセンス: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)

利用方法・判定方式は、このREADMEと上記ドキュメントを参照してください。
