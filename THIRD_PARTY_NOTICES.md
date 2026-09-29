# Third-party notices

Original JevWex code is licensed under the MIT License, Copyright (c) 2026 endlessbaum; see LICENSE. The third-party components and adapted portions listed below retain their respective licenses and copyright notices. Model weights and multimodal projectors are not bundled. Tested models and their separate terms are listed in the repository README.md.

## Server runtime dependencies

The optional HTTP server uses the ordinary npm packages `playwright` and
`playwright-core` 1.58.2 (Apache-2.0) to manage its own headless Chromium.
These packages and Chromium are not included in the Chrome extension bundle.
Keep the LICENSE and NOTICE files supplied with the packages when redistributing
them. Chromium is installed separately and retains its own bundled notices.

The NOTICE supplied by both Playwright packages reads:

> Playwright
> Copyright (c) Microsoft Corporation
>
> This software contains code derived from the Puppeteer project (https://github.com/puppeteer/puppeteer),
> available under the Apache 2.0 license (https://github.com/puppeteer/puppeteer/blob/master/LICENSE).

## SemIf

The constrained one-token readout and conditional softmax approach references
SemIf's browser direct scorer at commit `ca3ba65f142967030ecb453346e94d6f476a69df`:
https://github.com/tseanard/SemIf/blob/ca3ba65f142967030ecb453346e94d6f476a69df/webgpu-demo/worker.js

The implementation uses the ordinary wllama dependency, not SemIf's vendored
files. Model-specific token IDs are replaced with GGUF vocabulary discovery.

MIT License

Copyright (c) 2026 TheoLeeCJ

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## wllama

`@wllama/wllama` 3.6.1 is an unmodified npm dependency (MIT, Xuan Son NGUYEN). Its distributed JavaScript/embedded Worker code is bundled by esbuild. Its distributed `src/wasm/wllama.wasm` is copied byte-for-byte at build time. No llama.cpp/wllama source modifications, patches, bindings, or WASM compilation are performed. The package's license is included as `dist/runtime/WLLAMA-LICENSE.txt`.

## llama.cpp / ggml / mtmd

wllama 3.6.1 references llama.cpp commit `83d855c5a6d70487121edbf4020b25c96b7a04e7`:
https://github.com/ggml-org/llama.cpp/blob/83d855c5a6d70487121edbf4020b25c96b7a04e7/LICENSE

This notice covers the upstream project's MIT license. Individual vendor files have separate licenses. Additional notices for nlohmann/json, xxHash, stb_image, miniaudio, subprocess.h, SHA-1, SHA-256, Emscripten and musl are retained in `public/licenses/WASM-UPSTREAM-NOTICES.txt` in the source tree and `licenses/WASM-UPSTREAM-NOTICES.txt` in the built extension. Emscripten's version is taken from wllama's upstream build script. The additional review identified Emdawnwebgpu v20260317.182325 (revision 18eb229ef5f707c1464cc581252e7603c73a3ef0) and the LLVM runtime license files in Emscripten 4.0.20. Their notices are included as `public/licenses/EMDAWNWEBGPU-NOTICES.txt` and `public/licenses/LLVM-RUNTIME-NOTICES.txt` in the source tree and under `licenses/` in the built extension. These source/configuration/symbol checks are not a complete object-level binary provenance attestation. Scope and findings are documented in the repository's `docs/license-review.md`.

MIT License

Copyright (c) 2023-2026 The ggml authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## TypeSafe System One Adapter

The confidence formulas in `src/features/jev/result-math.ts` and corresponding known-value tests are adapted from:

- Repository: https://github.com/typesafe-ai/system-one-adapter-python
- Commit: `e1d4cc938204b22fc5a3c3aca7044072fe3f712d`
- Source: `src/system_one_adapter/_utils/confidence_metrics.py`
- Tests: `tests/utils/test_confidence_metrics.py`

Only the formulas for already validated distributions are used. This project does **not** adopt the upstream behavior of replacing a zero sum with a uniform distribution.

MIT License

Copyright (c) 2026 TypeSafe AI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
