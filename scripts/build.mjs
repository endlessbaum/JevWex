import { build } from "esbuild";
import { mkdir, cp, copyFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
export async function buildApp(web = false) {
  const output = web ? "dist-web" : "dist";
  await mkdir(`${output}/runtime`, { recursive: true });
  if (web) {
    await copyFile("public/index.html", `${output}/index.html`);
    await cp("public/licenses", `${output}/licenses`, { recursive: true });
    await writeFile(
      `${output}/engine.html`,
      '<!doctype html><html><head><meta charset="utf-8"><title>JevWex inference engine</title></head><body><script type="module" src="engine.js"></script></body></html>',
    );
    await build({
      entryPoints: ["src/server/engine.ts"],
      outfile: `${output}/engine.js`,
      bundle: true,
      format: "esm",
      target: "chrome138",
      sourcemap: true,
    });
  } else {
    await cp("public", output, { recursive: true });
    await build({
      entryPoints: ["src/extension/background.ts"],
      outfile: `${output}/launch.js`,
      bundle: true,
      target: "chrome138",
    });
    await build({
      entryPoints: ["src/pages/jev/panel.ts"],
      outfile: `${output}/panel.js`,
      bundle: true,
      format: "esm",
      target: "chrome138",
      sourcemap: true,
    });
  }
  // Keep existing extension-page bookmarks working after the product rename.
  await copyFile("public/index.html", `${output}/jev.html`);
  await copyFile(
    "node_modules/@wllama/wllama/src/wasm/wllama.wasm",
    `${output}/runtime/wllama.wasm`,
  );
  await copyFile(
    "node_modules/@wllama/wllama/LICENCE",
    `${output}/runtime/WLLAMA-LICENSE.txt`,
  );
  await copyFile("THIRD_PARTY_NOTICES.md", `${output}/THIRD_PARTY_NOTICES.md`);
  await copyFile("LICENSE", `${output}/LICENSE`);
  await build({
    entryPoints: ["src/pages/jev/page.ts"],
    outfile: `${output}/page.js`,
    define: { __JEVWEX_WEB__: String(web) },
    bundle: true,
    format: "esm",
    target: "chrome138",
    sourcemap: true,
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await buildApp(process.argv.includes("--web"));
