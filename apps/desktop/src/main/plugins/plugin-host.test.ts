import {
  ModelSettingsSchema,
  type CommandEnvelope,
  type ModelConfigInput,
  type ModelSettingsInput
} from "@deepwrite/contracts";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelConfigStore } from "../model-config-store";
import { handlePluginCommands } from "./plugin-commands";
import { PluginHost } from "./plugin-host";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

function createModelStore() {
  let models: ModelConfigInput[] = [];
  let defaultModelId = "";
  const store = {
    async list() {
      return ModelSettingsSchema.parse({
        models: models.map((model) => ({
          ...model,
          hasApiKey: Boolean(model.apiKey)
        })),
        defaultModelId
      });
    },
    async save(input: ModelSettingsInput) {
      models = input.models;
      defaultModelId = input.defaultModelId;
      return store.list();
    }
  };
  return {
    store: store as unknown as ModelConfigStore,
    models: () => models
  };
}

async function createPluginFixture(pluginId: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "deepwrite-plugin-"));
  temporaryDirectories.push(root);
  const directory = join(root, "source");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "plugin.json"),
    JSON.stringify({
      id: pluginId,
      name: "Demo Provider",
      version: "1.0.0",
      main: "index.mjs",
      capabilities: ["model-provider"]
    })
  );
  await writeFile(
    join(directory, "index.mjs"),
    `export async function activate(context) {
  await context.models.registerProvider({
    id: "demo",
    name: "Demo",
    baseUrl: "http://127.0.0.1:1234/v1",
    apiKey: "local-token",
    models: [
      { id: "demo-model", label: "Demo Model", contextWindow: 8000, maxTokens: 4000 }
    ]
  });
  context.status.set([{ label: "Models", value: "1" }]);
}
export async function deactivate() {}
`
  );
  return directory;
}

async function createHost() {
  const userData = await mkdtemp(join(tmpdir(), "deepwrite-userdata-"));
  temporaryDirectories.push(userData);
  const models = createModelStore();
  const host = new PluginHost({
    userDataPath: userData,
    appVersion: "1.6.0",
    pluginsDirectory: join(userData, "plugins"),
    pluginDataDirectory: join(userData, "plugin-data"),
    modelConfigStore: models.store,
    log: () => undefined
  });
  await host.initialize();
  return { host, models };
}

describe("PluginHost", () => {
  it("installs a local plugin and contributes prefixed models", async () => {
    const source = await createPluginFixture("demo-provider");
    const { host, models } = await createHost();

    const listed = await host.install({ source: "local", spec: source });

    expect(listed.plugins).toHaveLength(1);
    expect(listed.plugins[0]).toMatchObject({
      id: "demo-provider",
      state: "active",
      enabled: true
    });
    expect(models.models()).toEqual([
      expect.objectContaining({
        id: "plugin-demo-provider-demo-model",
        modelId: "demo-model",
        provider: "Demo",
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "local-token"
      })
    ]);
  });

  it("removes contributed models when the plugin is disabled", async () => {
    const source = await createPluginFixture("demo-provider");
    const { host, models } = await createHost();
    await host.install({ source: "local", spec: source });

    const listed = await host.setEnabled("demo-provider", false);

    expect(listed.plugins[0]).toMatchObject({
      state: "disabled",
      enabled: false
    });
    expect(models.models()).toEqual([]);
  });

  it("restores models after re-enabling and leaves no models on uninstall", async () => {
    const source = await createPluginFixture("demo-provider");
    const { host, models } = await createHost();
    await host.install({ source: "local", spec: source });

    await host.setEnabled("demo-provider", true);
    expect(models.models()).toHaveLength(1);

    const listed = await host.uninstall("demo-provider");
    expect(listed.plugins).toEqual([]);
    expect(models.models()).toEqual([]);
  });

  it("reports a plugin whose entry cannot be imported instead of throwing", async () => {
    const source = await createPluginFixture("broken-provider");
    await writeFile(join(source, "index.mjs"), "export const nope = 1;\n");
    const { host } = await createHost();

    const listed = await host.install({ source: "local", spec: source });

    expect(listed.plugins[0]).toMatchObject({
      id: "broken-provider",
      state: "error"
    });
    expect(listed.plugins[0]?.error).toContain("activate");
  });
});

function pluginCommand(
  type: string,
  payload: Record<string, unknown> = {}
): CommandEnvelope {
  return { id: `request-${type}`, type, payload } as CommandEnvelope;
}

describe("handlePluginCommands", () => {
  it("ignores commands outside the plugins namespace", async () => {
    const { host } = await createHost();

    await expect(
      handlePluginCommands(pluginCommand("settings.read"), host, {
        chooseDirectory: async () => null
      })
    ).resolves.toBeUndefined();
  });

  it("rejects plugin commands while the host is unavailable", async () => {
    const result = await handlePluginCommands(
      pluginCommand("plugins.list"),
      undefined,
      { chooseDirectory: async () => null }
    );

    expect(result).toMatchObject({
      status: "rejected",
      error: { code: "plugins.unavailable" }
    });
  });

  it("drives install, disable, reload and uninstall through commands", async () => {
    const source = await createPluginFixture("demo-provider");
    const { host } = await createHost();
    const options = { chooseDirectory: async () => source };

    const installed = await handlePluginCommands(
      pluginCommand("plugins.install", { source: "local", spec: source }),
      host,
      options
    );
    expect(installed).toMatchObject({
      status: "accepted",
      payload: { plugins: [{ id: "demo-provider", enabled: true }] }
    });

    const disabled = await handlePluginCommands(
      pluginCommand("plugins.setEnabled", {
        id: "demo-provider",
        enabled: false
      }),
      host,
      options
    );
    expect(disabled).toMatchObject({
      payload: { plugins: [{ id: "demo-provider", enabled: false }] }
    });

    const reloaded = await handlePluginCommands(
      pluginCommand("plugins.reload", { id: "demo-provider" }),
      host,
      options
    );
    expect(reloaded).toMatchObject({ status: "accepted" });

    const removed = await handlePluginCommands(
      pluginCommand("plugins.uninstall", { id: "demo-provider" }),
      host,
      options
    );
    expect(removed).toMatchObject({ payload: { plugins: [] } });
  });

  it("turns host failures into rejected results with a stable code", async () => {
    const { host } = await createHost();
    const result = await handlePluginCommands(
      pluginCommand("plugins.install", {
        source: "local",
        spec: join(tmpdir(), "deepwrite-missing-plugin-directory")
      }),
      host,
      { chooseDirectory: async () => null }
    );

    expect(result).toMatchObject({
      status: "rejected",
      error: { code: "plugins.install_failed" }
    });
  });

  it("forwards the native folder picker to the caller", async () => {
    const { host } = await createHost();
    const chooseDirectory = vi.fn(async () => "D:/plugins/demo");

    const result = await handlePluginCommands(
      pluginCommand("plugins.chooseSource"),
      host,
      { chooseDirectory }
    );

    expect(chooseDirectory).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "accepted",
      payload: { path: "D:/plugins/demo" }
    });
  });
});
