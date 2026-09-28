# ハードウェア設定

拡張を再読み込みしてタブを開き直すと、左メニューに「ハードウェア設定」が表示されます。

1. 「処理方法」でCPUまたはGPU（WebGPU）を選択します。GPUを取得できない環境ではGPUの選択を無効にし、理由を表示します。
2. CPUスレッド数を選択します。自動は論理コア数の半分（切り捨て、最低1、最大8）です。手動は検出コア数まで、最大32です。複数スレッド非対応環境では自動も1スレッドになります。
3. GPUでは、すべての層または一部の層を選べます。GPUメモリ不足のときは層数を減らすかCPUに戻してください。
4. 文章量は1,024／2,048／4,096／8,192トークンです。判定基準と出力も含めた上限で、文字数ではありません。大きくするほど速いという設定ではありません。
5. 「設定を保存」は次のモデル読込へ適用します。既に読み込み済みなら「モデルを再読み込みして適用」を押してください。判定中は適用ボタンを無効にします。

初期設定はCPU・スレッド数自動・文章量4,096です。ハードウェア設定と最後に使用したモデルの識別情報を拡張オリジンのlocalStorageへ保存します。入力と結果を自動で永続保存する機能はありません。Consoleへのモデル応答出力と手動の結果保存は行えます。設定変更で推論条件が変わる場合、前回の判定結果には再実行の案内を付けます。

## 実装

公開配布版 `@wllama/wllama@3.6.1` の `loadModel` に `n_threads`、`n_gpu_layers`、`n_ctx` を渡します。CPUは `n_gpu_layers: 0`、GPU全層は配布版と同じ99999指定です。モデルを固定せず、fork・patch・binding追加・独自WASMビルドはありません。並列スロット1・質問直列処理・入力を切り捨てない設定は維持します。

同じモデルでも設定が異なれば、旧ランタイムを解放して再ロードします。設定が同じなら不要な再ロードを省略します。GPU読込に失敗した場合にCPUへ黙って切り替える処理はありません。

CPUの実スレッド数は公開 `getNumThreads()`、文章量は公開 `getLoadedContextInfo()` から読みます。GPUへの実配置層数には公開loggerで受信した `offloaded N/M layers to GPU` の記録を使用します。指定値だけを根拠にGPU使用中と表示しません。層数を確認できない場合は「GPUを要求（使用層数は未確認）」と表示します。取得ログ全文や入力は保存せず、検出した層数だけを結果の実行情報へ含めます。

複数スレッドのSharedArrayBuffer用にmanifestへCOEP `require-corp` とCOOP `same-origin` を追加しました。CSPを緩めず、外部ホスト権限も追加しません。専用WorkerとWASMは既存のnpm配布資産を使用します。[Chromeの公式説明](https://developer.chrome.com/docs/extensions/develop/concepts/cross-origin-isolation)、[wllamaの公開ロード設定](https://github.ngxson.com/wllama/docs/interfaces/LoadModelParams.html)

## ハードウェア設定追加時の検証記録

**以下の速度と出力は、旧方式（数値JSON生成）での参考記録です。現行の1トークン判定の速度として扱わないでください。** 現行方式の実測と制限は [verification.md](verification.md) と [token-readout-test-results.json](token-readout-test-results.json) に記載しています。

`npm run typecheck`、`npm test`（84件）、`npm run build` を実行済みです。`test:extension:hardware` はChrome for Testing 145.0.7632.6のビルド済み拡張で実行しました。20論理コア・WebGPU表示名 `amd rdna-4` を検出し、SharedArrayBuffer・設定保存・同一モデル再ロード・実スレッド数・実GPUオフロード・実推論を確認しています。[実行記録](hardware-test-results.json)

モデルはQwen2.5-0.5B-Instruct Q4_K_M。短い同一文章・単一の当てはまり判定を各1回実行した参考値です。モデルの読込時間は含めません。

| 設定 | 文章量 | 判定時間 |
|---|---:|---:|
| CPU 1スレッド | 4,096 | 26.88秒 |
| CPU 4スレッド | 2,048 | 8.84秒 |
| WebGPU 全25層・CPU 4スレッド | 2,048 | 0.84秒 |

CPU 1スレッドの回は文章量も異なるため、スレッド数だけの厳密比較ではありません。CPU 4スレッドとGPUの回は同じ文章量です。順番・初回処理・出力長などを統制した性能ベンチマークや、すべてのモデルでの速度保証ではありません。

`JEV_TEST_GPU_INFERENCE=1` で `test:extension:repo` も実行しました。新しいCOEP/COOP設定で `unsloth/Qwen3-0.6B-GGUF` の実ダウンロードとオフラインキャッシュ再利用が成功。Q4_K_MをWebGPU全29層・CPU 8スレッド・文章量4,096で読み込み、初期の問い合わせ例のchoice／noul／score混在3基準が18.11秒で完了しました。モデル読込時間は含みません。実行中の外部通信はなく、結果ファイルも保存できました。[Qwen3の実行記録](hardware-qwen3-test-results.json)

未実行：他GPUメーカー、GPUメモリ不足、OS・ドライバ差、すべてのスレッド数、長時間運用、統計的な繰り返し速度比較。GPU検出はブラウザの利用可否であり、あらゆるモデルが読み込める保証ではありません。
