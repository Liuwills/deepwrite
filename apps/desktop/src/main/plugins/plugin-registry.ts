import type { PluginInstallSource } from "@deepwrite/contracts";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const PLUGIN_REGISTRY_FILE = "installed.json";

export interface InstalledPluginEntry {
  id: string;
  source: PluginInstallSource;
  enabled: boolean;
  version: string;
  installedAt: string;
}

export interface PluginRegistry {
  version: 1;
  plugins: InstalledPluginEntry[];
}

const EMPTY_REGISTRY: PluginRegistry = { version: 1, plugins: [] };

/** Loads the installed-plugin registry; a damaged file is treated as empty. */
export async function readPluginRegistry(
  pluginsDirectory: string
): Promise<PluginRegistry> {
  try {
    const raw = await readFile(
      join(pluginsDirectory, PLUGIN_REGISTRY_FILE),
      "utf8"
    );
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Array.isArray((parsed as { plugins?: unknown }).plugins)
    ) {
      return { ...EMPTY_REGISTRY, plugins: [] };
    }
    const plugins = (parsed as { plugins: unknown[] }).plugins.filter(
      (item): item is InstalledPluginEntry => {
        if (typeof item !== "object" || item === null) return false;
        const entry = item as Record<string, unknown>;
        return (
          typeof entry.id === "string" &&
          typeof entry.source === "string" &&
          typeof entry.enabled === "boolean" &&
          typeof entry.version === "string"
        );
      }
    );
    return { version: 1, plugins };
  } catch {
    return { ...EMPTY_REGISTRY, plugins: [] };
  }
}

/** Persists the registry atomically so a crash never leaves half a file. */
export async function writePluginRegistry(
  pluginsDirectory: string,
  registry: PluginRegistry
): Promise<void> {
  await mkdir(pluginsDirectory, { recursive: true });
  const target = join(pluginsDirectory, PLUGIN_REGISTRY_FILE);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}
