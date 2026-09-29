import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
if (!process.env.JEVWEX_TOKEN)
  throw new Error("JEVWEX_TOKENを設定してください");
const input = {
  state: "The cat sleeps on a sofa.",
  questions: {
    animal: {
      type: "choice",
      instructions: "Identify the animal.",
      criteria: { cat: "A cat", dog: "A dog", other: "Other or no animal" },
    },
  },
};
if (process.argv[2]) {
  const path = process.argv[2];
  input.state = "Identify the animal in the image.";
  input.images = [
    {
      name: basename(path),
      mime_type:
        extname(path).toLowerCase() === ".png" ? "image/png" : "image/jpeg",
      data_base64: (await readFile(path)).toString("base64"),
    },
  ];
}
const response = await fetch(
  `http://127.0.0.1:${process.env.JEVWEX_PORT ?? "39281"}/api/v1/evaluate`,
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.JEVWEX_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(310000),
  },
);
console.log(JSON.stringify(await response.json(), null, 2));
if (!response.ok) process.exitCode = 1;
