# Chrome拡張のBYOK APIキー管理

## 実装前の調査

Manifest V3。`public/manifest.json` のWorkerは `launch.js`、ソースは `src/extension/background.ts`。モデル設定は `index.html`／`jev.html`、サイドパネルは `panel.html`。常駐Content Script・Popup・外部接続設定はなく、本文取得・対象編集・結果表示を必要時に注入する。

| 保存先 | 利用箇所・用途 | Content Scriptからの直接利用 |
| --- | --- | --- |
| chrome.storage.local | backgroundの対象保存、site-rulesの条件、content-scopeのreadScope（拡張ページ／Workerから呼ぶ） | なし。注入関数pageContentはstorage.localを使わない |
| chrome.storage.session | background・captureの本文／編集中対象、page-judgeの進捗、panel・site-pageの編集・表示 | なし |
| localStorage | 管理画面のハードウェア、起動／待ち時間、最終モデル、APIの非秘密設定 | なし |
| sessionStorage | Webサーバー版の状態画面のサーバー用トークン | BYOKキーとは別用途 |
| wllamaモデルキャッシュ | ModelManagerがブラウザ保存領域でモデルを保持 | なし |
| storage.sync | 使用なし | なし |

元のAPI経路は管理タブ → DecisionSession → evaluateCloud → fetch。キーはタブのメモリだけにあり、閉じると消えた。送信先は管理画面の入力を検証し、非秘密設定だけlocalStorageへ保存していた。

Content Scriptはruntimeメッセージで対象保存・リンク先プレビュー・中止を依頼する。Workerは拡張ID・ページURL・document IDを検証する。判定はWorker → 拡張オリジンのBroadcastChannel → 管理タブのモデルへ依頼する。キーをページへ渡す経路はなかった。

## 保存と通信

キーと検証済み設定は `chrome.storage.local` の `jev-cloud-credentials:v1` に `{version: 2, profiles: [...]}` として最大100件保存する。各設定は独立したID・設定名・送信先・モデルID・キーを持つ。旧形式の1組はID `legacy` として読み取り、次回の書き込みで同じキーの複数設定形式へ移行する。旧キーを別レコードや履歴へ複製しない。Worker起動ごとに `TRUSTED_CONTEXTS` を設定し、完了を待ってからキーを読み書きする。既存の条件・対象保存も継続する。[Chrome Storage API](https://developer.chrome.com/docs/extensions/reference/api/storage)

保存済みキーを読み出すUI用APIは作らず、設定済みかどうかと非秘密設定一覧だけを返す。保存後の入力欄は空にする。空欄で同じ設定ID・送信先の設定を保存する場合は既存キーを使う。URLを変える場合や新しいIDを追加する場合は新しいキーが必要。新しいキーは対象設定の旧キーだけを上書きし、削除時も対象IDの設定とキーだけを削除する。session・sync・localStorageへのキー保存、独自暗号化、外部バックアップは行わない。

単体・一括・ページ判定は既存DecisionSessionとローカルフォールバックを維持し、クラウド処理だけをAPI専用メッセージでWorkerへ依頼する。管理タブのクラウドセッションに保存済みキーは保持しない。Workerが要求の設定IDに対応する保存済みの送信先・キーを読み、既存evaluateCloudでJEV形式のPOSTとAuthorizationを生成する。保存設定との一致検査も設定IDごとに行い、削除されたIDから別のAPIへ自動的に振り替えない。接続テストも同じ経路で行う。他のAPI設定の編集・削除で無関係なAPIの通信を中止しない。

BYOKメッセージを受け付けるのは同じ拡張IDの最上位 `index.html`／`jev.html` だけ。Content Script・Side Panel・外部ページからのキー取得・設定変更・API要求は拒否する。既存JEV入力検証と保存済み設定との一致検査を通し、通信URL・メソッド・ヘッダーを任意指定するProxyにはしない。[Chrome拡張のクロスオリジン通信](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)

キー未設定、認証失敗（401／403）、利用制限（429）、ネットワーク、その他APIエラーを区別する。APIの任意エラー本文は表示・ログ出力しない。正常形式のレスポンスにキー全文が混入した場合も返さない。中止・管理タブ終了・移動時は該当要求を中止する。

Manifestの権限・ローカル推論・本文／画像取得・ビルド構成は維持した。保存しても起動時の選択はローカル。APIを選ぶ際にキーを再入力する必要はない。Web版とHTTP APIサーバーのトークン管理は別用途として従来の動作を維持する。

## 検証

`npm run test:extension:byok` はテスト用キー・ローカル応答APIと専用Chromiumプロファイルで、保存 → ブラウザ完全終了 → 同じプロファイルで再起動 → 再入力せず推論を実行する。Content Scriptのstorage.local読み取り・変更イベント・BYOKメッセージ拒否、Workerの読み取り、ページ側fetchを禁止した接続テスト／推論、送信先変更時のキー再使用拒否、上書き／削除、認証／レート制限／APIエラー、資格情報を返す不正レスポンス、Consoleへのキー非混入も確認する。

設定フォーム最後の「設定を保存して使用する」で一覧へ登録されて使用中になるUI、続けて複数APIを追加・選択・編集・削除する動作、全設定とキーのブラウザ完全再起動後の復元、モデルID変更と保存したAPIへの切り替えも同じブラウザテストで検証する。

`tests/jev/cloud-key-store.test.ts` は保存順序・Worker再作成・ID別のルーティング／キー分離・旧形式移行・個別削除・キーの検証・送信元制限・エラー処理を単体検証する。実サービスの有料APIでの接続・精度評価は含めない。アクセス許可は専用プロファイルのChrome設定でテスト先だけを事前承認し、UIでは実permissions.requestを呼ぶ。ユーザーのChromeプロファイルや実APIキーは使わない。
