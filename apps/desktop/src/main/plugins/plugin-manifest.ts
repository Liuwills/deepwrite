import {
  PluginManifestSchema,
  type PluginManifest
} from "@deepwrite/contracts";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

export const PLUGIN_MANIFEST_FILE = "plugin.json";

/** Reads and validates `<directory>/plugin.json`. */
export async function readPluginManifest(
  directory: string
): Promise<PluginManifest> {
  const manifestPath = join(directory, PLUGIN_MANIFEST_FILE);
  const info = await stat(manifestPath).catch(() => undefined);
  if (!info?.isFile()) {
    throw new Error(`插件目录中缺少 ${PLUGIN_MANIFEST_FILE}：${directory}`);
  }
  if (info.size > 256 * 1024) {
    throw new Error("插件清单元数据过大，已拒绝安装。");
  }
  const raw = await readFile(manifestPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/u, ""));
  } catch {
    throw new Error(`${PLUGIN_MANIFEST_FILE} 不是合法的 JSON。`);
  }
  const result = PluginManifestSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `插件清单校验失败：${result.error.issues
        .map(
          (issue) => `${issue.path.join(".") || "manifest"}: ${issue.message}`
        )
        .slice(0, 3)
        .join("；")}`
    );
  }
  return result.data;
}

/** Resolves the entry module and refuses paths that escape the plugin folder. */
export async function resolvePluginEntry(
  directory: string,
  manifest: PluginManifest
): Promise<string> {
  const root = resolve(directory);
  const entry = resolve(root, manifest.main);
  const inside = relative(root, entry);
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) {
    throw new Error("插件入口必须位于插件目录内部。");
  }
  const info = await stat(entry).catch(() => undefined);
  if (!info?.isFile()) {
    throw new Error(`插件入口文件不存在：${manifest.main}`);
  }
  if (info.size > 5 * 1024 * 1024) {
    throw new Error("插件入口文件过大，已拒绝加载。");
  }
  return entry;
}
