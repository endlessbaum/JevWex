# MIT採用に関するライセンス調査

確認日: 2026-09-28。対象はJevWexの初回コミット `6d99e72` と、今回補足した通知文書です。

## 結論

**確認した依存関係・既知の参照実装では、JevWexの独自部分をMITで提供することを妨げるライセンス条件は見つかりませんでした。** 自分が利用許諾できる独自部分をMITとし、第三者部分の元のライセンス・著作権表示を維持する構成が適切です。MITを追加して、依存物まで一律にMITへ変更することはしません。

前回までの通知には、WebGPU部品、LLVMランタイム、一部の個別著作権表示が不足していました。今回、確認した原文を `public/licenses/` に追加しました。「未確認」と書くこと自体は、ライセンス条件を満たす代わりにはなりません。

調査後の利用者の指示により、2026-09-28に独自部分へ [MIT License](../LICENSE)（Copyright (c) 2026 endlessbaum）を採用しました。第三者の条件は維持しています。本書は特定版のソフトウェアライセンスの照合結果であり、法律専門家による意見書、権利帰属の証明、すべての権利侵害がないことの保証ではありません。

## 確認した範囲と判断

| 対象 | 確認した条件 | JevWexのMIT採用への影響 |
| --- | --- | --- |
| JevWexの独自TypeScript・HTML・CSS・文書 | 調査対象の初回コミットでは本体ライセンス未設定。調査後にMITを採用。既知の参照元は下記2実装とJEV / System One公開仕様 | 利用許諾できる独自部分にMITを適用。第三者の権利を取得したことにはならない |
| [wllama 3.6.1](https://github.com/ngxson/wllama/blob/3.6.1/LICENCE) | MIT、Xuan Son NGUYEN | 著作権・許諾文を保持して利用・改変・再配布可能。本体MITの阻害なし |
| [SemIf](https://github.com/tseanard/SemIf/blob/ca3ba65f142967030ecb453346e94d6f476a69df/LICENSE) | MIT、TheoLeeCJ。候補トークン読出し方式の参考 | 同上。既存のTHIRD_PARTY_NOTICESで保持 |
| [TypeSafe System One Adapter](https://github.com/typesafe-ai/system-one-adapter-python/blob/e1d4cc938204b22fc5a3c3aca7044072fe3f712d/LICENSE) | MIT、TypeSafe AI。confidence算式の参考 | 同上。TypeSafe公式製品であることやJEVモデルの許諾を意味しない |
| [llama.cpp / ggml / mtmd](https://github.com/ggml-org/llama.cpp/blob/83d855c5a6d70487121edbf4020b25c96b7a04e7/LICENSE) | MIT。個別vendorは別ライセンス | 本体MITの阻害なし。上流と個別部品の通知を維持 |
| nlohmann/json、cpp-httplib、stb_image | MIT（stb_imageはPublic Domainとの選択式） | 本体MITの阻害なし。json内の個別著作権者の通知も補足 |
| xxHash | BSD-2-Clause | 本体MITの阻害なし。バイナリ配布にも著作権・条件・免責文が必要 |
| miniaudio、subprocess.h、SHA-1 / SHA-256 | MIT-0またはPublic Domain、Unlicense、Public Domainの各表記 | 本体MITの阻害なし。確認した通知を保持 |
| Emscripten 4.0.20・musl | MIT等。muslの数学関数にはArmのMIT、Sunの通知保持条件付き許諾がある | 本体MITの阻害なし。プロジェクト全体のMIT表記だけで個別通知を省略しない |
| Emdawnwebgpu `v20260317.182325` | 配布ZIP内のC++側はBSD-3-Clause、JS/C側はMIT / NCSA。WebGPU CヘッダにもBSD形式の通知 | 本体MITの阻害なし。元の許諾と著作権表示を同梱し、開発元による推奨・承認を示さない |
| libc++ / libc++abi / libunwind / compiler-rt | Emscripten 4.0.20ツリーのLICENSEはApache-2.0 WITH LLVM-exception。旧ライセンスの説明も含む | 本体MITの阻害なし。これら自体を単にMITとは表示しない。例外への依存だけで通知を省略せず、原文を保持 |
| npmの開発用依存 | lock内70エントリの宣言はMIT 67、Apache-2.0 3（後者はTypeScript・Playwright・playwright-core） | 開発用パッケージ自体は拡張に同梱しない。これらでビルド・テストすることが本体をApache-2.0にする条件にはならない |

上表はライセンスの適用先を分けた判断です。[MIT](https://opensource.org/license/mit)は通知保持を条件とし、[Apache-2.0第4条](https://www.apache.org/licenses/LICENSE-2.0)は元の条件を守った上で変更部分や派生物全体に別の条件を設定する余地を認めています。LLVMの扱いは[公式ポリシー](https://llvm.org/docs/DeveloperPolicy.html#license)と下記固定版の原文も確認しました。GPL / AGPL等への本体ライセンス変更や、本体のソース公開を要求する条件は、今回確認した適用ライセンスには見つかっていません。

## WASMの追跡方法と限界

- npm登録情報の `@wllama/wllama@3.6.1` はMIT、`gitHead` は `c35450cf9597eaf901293b12458cae204aea0b65`。[npm登録情報](https://registry.npmjs.org/@wllama%2fwllama/3.6.1)
- 上流リリースのllama.cpp参照は `83d855c5a6d70487121edbf4020b25c96b7a04e7`。npm内の生成コードも `LIBLLAMA_VERSION = b10663-83d855c` と示しています。
- [上流ビルドスクリプト](https://github.com/ngxson/wllama/blob/3.6.1/scripts/build_wasm.sh)はEmscripten 4.0.20を指定。[ビルド構成](https://github.com/ngxson/wllama/blob/3.6.1/scripts/docker-compose.yml)はEmdawnwebgpu `v20260317.182325` の配布ZIPを指定しています。
- 当該ZIPを実際に取得してLICENSE・ヘッダを確認。`VERSION.txt` はDawnコミット `18eb229ef5f707c1464cc581252e7603c73a3ef0` を示します。[配布リリース](https://github.com/google/dawn/releases/tag/v20260317.182325)
- npm同梱の圧縮シンボル表を読取り、WebGPU、nlohmann/json、stb、miniaudio、C++例外処理、数学関数を確認。数学関数に対応するEmscriptenツリーの22ファイルも確認しました。短縮されたシンボル表なので、関数名がないことを部品の不存在の証明には使っていません。
- WASM SHA256は `6ca9fdd1b6c03206cd3a04e359b52c8f539896d6c5fb5d36243dded4a689f0ad`。JevWexはこの配布物を改変せずコピーします。

これは配布物・上流ビルド設定・付属シンボルを突き合わせた調査です。**上流ビルドの再現、全オブジェクトと元ファイルの完全対応、署名付きビルド来歴の検証は行っていません。** 指定ツールチェーンの通知には、個々の関数のリンク有無を確定できないものも保守的に含めています。モデルに依存する許諾や、未知の第三者権利まで保証するものではありません。

## 今回補足した通知

- [EMDAWNWEBGPU-NOTICES.txt](../public/licenses/EMDAWNWEBGPU-NOTICES.txt): 実際の配布ZIPの2つのLICENSE、WebGPU Cヘッダ、JS/C側の著作権表示。
- [LLVM-RUNTIME-NOTICES.txt](../public/licenses/LLVM-RUNTIME-NOTICES.txt): [libc++](https://github.com/emscripten-core/emscripten/blob/4.0.20/system/lib/libcxx/LICENSE.TXT)、[libc++abi](https://github.com/emscripten-core/emscripten/blob/4.0.20/system/lib/libcxxabi/LICENSE.TXT)、[libunwind](https://github.com/emscripten-core/emscripten/blob/4.0.20/system/lib/libunwind/LICENSE.TXT)、[compiler-rt](https://github.com/emscripten-core/emscripten/blob/4.0.20/system/lib/compiler-rt/LICENSE.TXT)の原文。
- [WASM-UPSTREAM-NOTICES.txt](../public/licenses/WASM-UPSTREAM-NOTICES.txt): nlohmann/json内のBjörn Hoehrmann、Florian Loitsch、Evan Nemerson、The Abseil Authors等の表記、cpp-httplib、musl数学関数の個別通知を追加。

既存の通常ビルドは `public/` をコピーするので、これらは `dist/licenses/` に入ります。ライブラリのfork・patch・binding追加・独自WASMビルドは行っていません。[調査対象の機械可読記録](license-audit-evidence.json)

## モデル・名称・独自部分

モデル本体・mmprojはGit管理対象にも拡張にも含めません。[検証した4モデルの条件](../README.md#動作検証に使用したモデル同梱なし)は本体MITとは別です。特にLFM Open License v1.0には商用利用条件があり、JevWexをMITにしてもその条件は変わりません。

JEV / System Oneの公開形式を参考にすること、MITで許諾されたアダプタ算式を使うこと、JEVという名称・商標の扱いは別の論点です。本体MITは第三者商標の使用許諾や提携の根拠にはなりません。商標登録の網羅調査は今回のソフトウェアライセンス調査の対象外です。

独自部分を利用許諾する権限（勤務先との契約、外部から持ち込まれた未申告コード等）はリポジトリだけでは証明できません。今回の判断は、記録された参照元と現在確認できる配布物を前提とします。

## MIT採用で反映した変更

1. `Copyright (c) 2026 endlessbaum` を記載した標準MITの `LICENSE` を追加。
2. `package.json` とロックファイルのルートの `license` をMITにし、READMEとTHIRD_PARTY_NOTICESの説明も更新。
3. 依存・参照コードの元の通知を維持し、本体LICENSEもビルド済み拡張の `dist/LICENSE` へコピー。
4. モデルの非同梱を維持。今後依存バージョンを変えた場合はこの調査記録も更新する。

## 調査時点の確認結果（MIT採用前）

実行済み: npm登録とロックファイルのintegrity表記一致、固定版の原文取得と比較、付属シンボル表の読取り、ビルド、追加通知の原文保持とdistへのコピー一致、WASMのバイト一致、モデル非同梱、文書内の相対リンク・見出しリンク68件の確認。ライセンス調査に伴う文書変更だけなので、単体テスト・Chrome上の推論は今回は再実行していません。MITの適用、commit、pushは今回行っていません。
