# JEV形式との互換範囲

この機能はTypeSafe AIの公開資料を参考にしたローカルLLMの入出力形式アダプタです。本ページに記載したフィールドと計算が対応範囲であり、JEV / System Oneの全APIとの互換性は主張しません。JEVモデル移植、HTTP互換サーバー、公式推論の同等精度・速度・校正・質問間の完全な独立性の再現ではありません。

この文書の生成・confidenceの説明はローカル実行に適用します。モデル管理で選択できる[JEV互換API接続](cloud-api.md)は、クラウドの回答を検証して利用し、確率やconfidenceをローカル算式で上書きしません。

## 入力

以下は内部のJEV形式です。通常の画面操作は文章とラベル・説明の入力だけで行い、JSON入力欄はありません。基準名（alias）は内部IDとは別に画面とダウンロードのpresentationで保持し、JEVのquestionsに未定義フィールドを追加しません。段階評価のラベルと説明は、既存仕様が許容する構造化criteriaの要素として渡します。

| フィールド | 対応 |
|---|---|
| state | 文字列・JSONオブジェクト・JSON配列 |
| questions | 質問IDをキーとするオブジェクト。空ID、重複IDは拒否 |
| instructions | 文字列・JSONオブジェクト・JSON配列。構造を保持 |
| choice.criteria | 候補名→文字列・構造化説明・nullのmap。nullは空文字等に変換しない |
| score.criteria | 低→高に並んだ説明配列。2〜10段階 |
| noul.criteria | 省略可能。指定時はtrueとfalseの説明を両方必要とする |
| model | 登録済みローカルID。未登録IDはエラー、未ロードIDもエラー。省略時はロード済みモデルを使うローカル拡張 |

不明な型・フィールド、数値やbooleanをstate/instructionsとして渡す入力は拒否します。構造化値の内部にはJSONのnull、boolean、有限数を含められます。NaN/Infinity、深さ32超、重複JSONキーは拒否します。`__proto__`や`constructor`も安全な辞書とMapで扱い、ラベルをそのまま戻します。

ページ独自の上限はシリアライズ後65,536文字、質問1〜16件、choice候補2〜32件です。これはJEV本体の上限ではありません。キーの順序はJavaScriptの `Object.keys` 順（整数形式キーは数値順）です。同率choiceはこの順の先頭、同率scoreのmodeも先頭です。

## 生成・検証

質問を1つずつ直列実行します。質問IDは結果対応付けにのみ使用し、プロンプトに追加しません。各呼出は独立したsystem/userメッセージで、以前の回答や会話履歴は渡しません。stateはデータ、instructions/criteriaは条件としてJSONシリアライズします。プロンプトの区切りが完全なインジェクション防御であるとは主張しません。結果にブラウザ操作などの副作用はありません。

公開 `createChatCompletion` に単一文字の候補を許すgrammar、`max_tokens: 1`、`logprobs: true`、`temperature: 1`、thinking無効を指定します。候補文字のIDは選択したGGUFの語彙から取得します。モデル名によるID固定、private API、fork、独自WASMは使いません。内部のJSON数値生成・schemaは廃止しました。

返された1トークンの候補logprobsを読み、全候補が一意に存在し有限値であることを検証します。最大値を引く安定化softmaxで候補間の条件付き確率を計算します。生成された文字自体ではなく、この分布でchoice/score/noulを決定します。noulはtrue/falseの2候補を評価し、true側の確率を返します。全候補がそろわない場合はエラーにし、ゼロ埋め、均等分布への置換、数値生成へのフォールバックはしません。[方式の詳細と制限](token-readout.md)

## 出力

`response` は `{model: 実際のローカルID, answers: {質問ID: 結果}}`。

- choice: `type`, `choice`（分布のargmax）, 元ラベルの `probabilities`, `confidence`
- score: `type`, `score = Σ(i × p[i])`（0始まり）, `probabilities`, `confidence`, `legend`
- noul: `type`, `noul`（true/false間で正規化したtrueの確率）。boolean化、丸め、confidence追加はしません。

legendの文字列説明はそのまま、構造化説明は `JSON.stringify` のコンパクトJSON文字列で表現します。質問途中で失敗した場合は失敗質問ID付きエラーを返し、部分結果や全体成功responseは表示しません。1トークン読出しでは終了理由lengthを正常として受理します。候補確率の欠損・非有限値・複数トークンなどは `INVALID_OUTPUT`、context超過は `CONTEXT_LIMIT`。入力を切り捨てず、モデルをクラウドへ切り替えません。

## confidence

TypeSafe AIのSystem One AdapterのMITライセンス付き実装を確認し、commit `e1d4cc938204b22fc5a3c3aca7044072fe3f712d` の算式を採用しました。ライセンス全文と参照先は [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。JevWexが同社の公式アダプタであることを意味しません。

正規化済み分布p、候補・段階数K（2以上）について:

```text
choice: (max(p) − 1/K) / (1 − 1/K)
score:
  m = 最頻段階（同率は先頭）
  D = Σ p[i] × |i − m|
  U = Σ |i − (K−1)/2| / K
  confidence = max(0, 1 − D/U)
```

0〜1へ浮動小数点補正します。scoreの負数を0にする処理は参照算式そのものです。公式テストのchoice [0.82,0.18]→0.64、score [0.01,0.02,0.07,0.3,0.6]→0.55を確認します。参照元のゼロ和→均等分布への修復は採用せず、前段で拒否します。diagnosticsは `confidence_method: "typesafe_adapter_e1d4cc9"`。

これらは**候補トークン間の未校正の条件付き分布**から計算した値です。公式アダプタ算式の参照はJEVモデルの再現や正答率を意味しません。

confidenceはモデルが別途生成する値ではなく、コードが候補間の分布から計算します。画面では「重みの集中度」と表示します。診断の `readout_method` は `candidate_token_logprobs_v1`、`model_outputs` は生成文字・候補文字とtoken ID・logprob・確率・生成トークン数です。未加工の応答オブジェクトはconsole.logに出します。旧形式との互換用の `normalizations` は空配列です。外部への送信やアプリによる自動永続保存は行いませんが、手動の結果ダウンロードには入力と診断も含まれます。

## 公開資料

- [Choice](https://docs.typesafe.ai/primitives/choice)
- [Score](https://docs.typesafe.ai/primitives/score)
- [Noul](https://docs.typesafe.ai/primitives/noul)
- [公式confidence実装（固定commit）](https://github.com/typesafe-ai/system-one-adapter-python/blob/e1d4cc938204b22fc5a3c3aca7044072fe3f712d/src/system_one_adapter/_utils/confidence_metrics.py)
- [Chrome MV3 CSP](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy)

実装はGitHub masterではなく、npm配布版wllama 3.6.1の公開型と配布資産を基準としています。
