import { ModelManager, type CacheManager, type Model } from "@wllama/wllama";
import { JevError } from "../features/jev/types";

// Use the public cache API, preserving projectors referenced by other models.
// Model.remove() also removes shared projector files in wllama 3.6.1.
export async function removeCachedModel(
  cache: Pick<CacheManager, "list" | "deleteMany">,
  model: Pick<Model, "url" | "mmprojUrl">,
) {
  const files = await cache.list();
  const mainUrls = new Set(ModelManager.parseModelUrl(model.url));
  const otherFiles = files.filter(
    (file) => !mainUrls.has(file.metadata.originalURL),
  );
  if (
    otherFiles.some(
      (file) =>
        file.metadata.mmprojURL && mainUrls.has(file.metadata.mmprojURL),
    )
  )
    throw new JevError(
      "INVALID_REQUEST",
      "このファイルは別のモデルの画像用ファイルとして使われています。先にそのモデルを削除してください。",
    );
  const sharedProjector =
    !!model.mmprojUrl &&
    otherFiles.some(
      (file) =>
        file.metadata.originalURL !== model.mmprojUrl &&
        file.metadata.mmprojURL === model.mmprojUrl,
    );
  const urls = new Set(mainUrls);
  if (model.mmprojUrl && !sharedProjector) urls.add(model.mmprojUrl);
  const names = new Set(
    files
      .filter((file) => urls.has(file.metadata.originalURL))
      .map((file) => file.name),
  );
  await cache.deleteMany((file) => names.has(file.name));
  return { sharedProjector };
}
