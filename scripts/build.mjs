import { build } from "esbuild";
import { mkdir, cp, copyFile } from "node:fs/promises";
await mkdir("dist/runtime", { recursive: true });
await cp("public", "dist", { recursive: true });
// Keep existing extension-page bookmarks working after the product rename.
await copyFile("public/index.html", "dist/jev.html");
await copyFile(
  "node_modules/@wllama/wllama/src/wasm/wllama.wasm",
  "dist/runtime/wllama.wasm",
);
await copyFile(
  "node_modules/@wllama/wllama/LICENCE",
  "dist/runtime/WLLAMA-LICENSE.txt",
);
await copyFile("THIRD_PARTY_NOTICES.md", "dist/THIRD_PARTY_NOTICES.md");
await copyFile("LICENSE", "dist/LICENSE");
await build({
  entryPoints: ["src/pages/jev/page.ts"],
  outfile: "dist/page.js",
  bundle: true,
  format: "esm",
  target: "chrome138",
  sourcemap: true,
});
