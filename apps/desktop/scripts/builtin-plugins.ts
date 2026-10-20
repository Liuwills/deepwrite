import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Plugin } from "vite";

/**
 * Copies DeepWrite's own plugins next to the main-process bundle. They are
 * plain ESM assets, so they must not be bundled or transformed; the app copies
 * them into the user's plugin folder on first launch.
 */
export function builtinPluginsPlugin(
  source: string,
  destination: string
): Plugin {
  let copied: Promise<void> | undefined;
  const copy = (): Promise<void> => {
    copied ??= (async () => {
      const entries = await readdir(source, { withFileTypes: true }).catch(
        () => []
      );
      if (!entries.length) return;
      await rm(destination, { recursive: true, force: true });
      await mkdir(destination, { recursive: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        await cp(join(source, entry.name), join(destination, entry.name), {
          recursive: true
        });
      }
    })();
    return copied;
  };
  return {
    name: "deepwrite-builtin-plugins",
    async writeBundle() {
      await copy();
    },
    async closeBundle() {
      await copy();
    }
  };
}
