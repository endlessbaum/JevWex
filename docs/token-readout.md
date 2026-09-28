# 候補トークンの確率を使う判定

SemIfのブラウザー版direct scorer（commit `ca3ba65f142967030ecb453346e94d6f476a69df`）を参考に、数値JSON生成から公開Chat APIの候補logprobsへ変更しました。元の指示書は変更していません。後続のユーザー依頼による判定方式の変更です。

## 実装

- 推論ライブラリは引き続き未改変の `@wllama/wllama@3.6.1`。fork、patch、private API、binding追加、独自WASMは使いません。
- 候補を単一文字に対応付け、`grammar`、`max_tokens: 1`、`logprobs: true` で公開 `createChatCompletion` を呼びます。thinking無効を指定します。生成文字のランダムな選択を最終結果に使わず、確率分布を使います。
- SemIfのモデル別token ID固定は採用せず、ローカルBlobまたは公開 `Model.open()` で開いたGGUFの語彙から取得します。ASCIIの `A–Z, 0–5` のうち一意に存在するものを使用。GGUF v2/v3、最大64 MiBの先頭範囲の走査に限定し、モデル全体をメモリへ読み込みません。モデル名の条件分岐はありません。候補数に足りない語彙は明示的に拒否します。
- 温度1、top-k無効、top-p/typical-pは1、min-pは0、反復ペナルティなし。各候補に同じlogit biasを与えます。
- この配布版の返すlogprobsはサンプリング前の値です。biasやgrammarだけでは候補が上位一覧に入る保証がありません。SemIfの20件から64件へ取得範囲を広げ、全候補の確率が実際に返ったことを必ず検証します。欠損をゼロ補完しません。上位64件に全候補が入らないモデル・入力は明示的にエラーとなります。
- 一覧を512件にすると、LFM2.5-VLで公開API内部の `Invalid typed array length: 1163217991` が再現しました。ライブラリを変更せず、64件に抑えて同モデルで画像入力を再検証しました。このため無制限の全語彙取得は行いません。
- 全候補のlogprobが一意かつ有限であること、生成が1トークンであることを検証し、最大値を引く安定化softmaxで候補間の確率を計算します。終了理由lengthは、この方式では正常です。

```text
p[i] = exp(logprob[i] - max(logprob)) / sum(exp(logprob[j] - max(logprob)))
choice = argmax(p)
score = sum(i * p[i])
noul = p[true]（true/falseの2候補）
```

confidenceの既存算式、基準のalias、モデル・ハードウェア保存、画像入力、一括処理、CSV集計は継続します。各基準は独立したメッセージで直列実行します。prefix cache共有や並列実行は追加していません。

未加工の応答オブジェクトとcontentは、検証・計算前に従来のconsole.logへ出します。ダウンロードには生成文字、候補文字とtoken ID、元logprob、計算した確率、生成トークン数を残します。大量処理で保存サイズが増えすぎないよう、候補以外の上位トークン一覧全体は結果ファイルに複製しません。

## 意味と制限

表示する割合は候補間の条件付き確率で、正答率や校正済みconfidenceではありません。モデル、量子化、CPU/GPU、候補順序、プロンプトにより変わります。意味判断の誤りはこの変更だけでは解消しません。32候補のテストは分布の完全性・計算の検証であり、正答を保証するものではありません。

実測ではQwen3 0.6Bが配送状況を尋ねる文を「配送」に分類した一方、返金要求の当てはまりも約0.96と返しました。また、32候補の数値一致問題を誤分類しました。これらは成功した形式検証とは分けて、モデルの意味判断の誤りとして記録しています。

数値JSON生成、欠けた候補のゼロ埋め、全ゼロの均等分布置換へフォールバックしません。現在の一般的なGGUFすべてでの互換性を保証するものではなく、単一文字語彙と候補logprobsを取得できるチャットモデルが必要です。

## 参照

- [SemIf browser worker](https://github.com/tseanard/SemIf/blob/ca3ba65f142967030ecb453346e94d6f476a69df/webgpu-demo/worker.js)
- [SemIf method](https://github.com/tseanard/SemIf/blob/ca3ba65f142967030ecb453346e94d6f476a69df/docs/METHOD.md)
- [ライセンス](../THIRD_PARTY_NOTICES.md)

実行済み・未実行テストは [verification.md](verification.md) の候補トークン方式の項目を参照してください。
