import {
  BUILT_IN_REASONING_LEVELS,
  PluginManifestSchema,
  PluginStatusFieldSchema,
  type ModelApi,
  type ModelConfigInput,
  type PluginCapability,
  type PluginListResult,
  type PluginManifest,
  type PluginRecord,
  type PluginState,
  type PluginStatusField
} from "@deepwrite/contracts";
import type { ModelConfigStore } from "../model-config-store";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  installPluginDirectory,
  type PluginInstallRequest
} from "./plugin-installer";
import { readPluginManifest, resolvePluginEntry } from "./plugin-manifest";
import {
  readPluginRegistry,
  writePluginRegistry,
  type InstalledPluginEntry,
  type PluginRegistry
} from "./plugin-registry";

const PLUGIN_MODEL_ID_PREFIX = "plugin-";
const MAX_MODELS = 100;

export interface PluginModelDescriptor {
  /** Provider-side model id, sent upstream unchanged. */
  id: string;
  label?: string;
  description?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  defaultThinkingLevel?: string;
}

export interface PluginProviderRegistration {
  id: string;
  /** Group name shown in the model picker. */
  name: string;
  /** OpenAI-compatible base URL, usually a loopback proxy. */
  baseUrl: string;
  apiKey: string;
  api?: ModelApi;
  models: PluginModelDescriptor[];
}

export interface DeepWritePluginContext {
  readonly plugin: {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly directory: string;
    readonly dataDirectory: string;
  };
  readonly app: {
    readonly version: string;
    readonly platform: NodeJS.Platform;
    readonly userDataPath: string;
  };
  readonly logger: {
    info(message: string, details?: unknown): void;
    warn(message: string, details?: unknown): void;
    error(message: string, details?: unknown): void;
  };
  readonly config: {
    read<T = unknown>(): Promise<T | undefined>;
    write(value: unknown): Promise<void>;
  };
  readonly models: {
    registerProvider(provider: PluginProviderRegistration): Promise<void>;
    unregisterProvider(providerId: string): Promise<void>;
  };
  readonly status: {
    set(fields: PluginStatusField[]): void;
  };
}

interface PluginModule {
  activate(context: DeepWritePluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

interface PluginRuntime {
  entry: InstalledPluginEntry;
  manifest: PluginManifest;
  directory: string;
  state: PluginState;
  error: string | undefined;
  statusFields: PluginStatusField[];
  instance: PluginModule | undefined;
  providers: Map<string, PluginProviderRegistration>;
}

export interface PluginHostOptions {
  userDataPath: string;
  appVersion: string;
  pluginsDirectory: string;
  pluginDataDirectory: string;
  /** Read-only folder that ships DeepWrite's own plugins. */
  builtinPluginsDirectory?: string;
  modelConfigStore: ModelConfigStore;
  log: (event: string, details?: unknown) => void;
}

/** Owns installed plugins, their lifecycle and the models they contribute. */
export class PluginHost {
  private registry: PluginRegistry = { version: 1, plugins: [] };
  private readonly runtimes = new Map<string, PluginRuntime>();
  private modelChain: Promise<void> = Promise.resolve();
  private initialized = false;

  constructor(private readonly options: PluginHostOptions) {}

  get directory(): string {
    return this.options.pluginsDirectory;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    await mkdir(this.options.pluginsDirectory, { recursive: true });
    await mkdir(this.options.pluginDataDirectory, { recursive: true });
    await this.installBundledPlugins();
    this.registry = await readPluginRegistry(this.options.pluginsDirectory);
    // A plugin's proxy port only lives for one app session, so model entries
    // from the previous session can never be dialed again.
    this.registry.plugins = await this.presentEntries(this.registry.plugins);
    await this.activateAllEnabled();
    await this.queueModels();
  }

  async dispose(): Promise<void> {
    for (const runtime of this.runtimes.values()) {
      await this.deactivateRuntime(runtime);
    }
    this.runtimes.clear();
  }

  async list(): Promise<PluginListResult> {
    const manifests = new Map<string, PluginManifest>();
    for (const entry of this.registry.plugins) {
      const runtime = this.runtimes.get(entry.id);
      if (runtime) {
        manifests.set(entry.id, runtime.manifest);
        continue;
      }
      const manifest = await readPluginManifest(
        join(this.options.pluginsDirectory, entry.id)
      ).catch(() => undefined);
      if (manifest) manifests.set(entry.id, manifest);
    }
    const plugins = this.registry.plugins
      .map((entry) => this.toRecord(entry, manifests.get(entry.id)))
      .sort((left, right) => left.name.localeCompare(right.name));
    return { directory: this.options.pluginsDirectory, plugins };
  }

  async install(request: PluginInstallRequest): Promise<PluginListResult> {
    const installed = await installPluginDirectory(
      request,
      this.options.pluginsDirectory
    );
    const previous = this.registry.plugins.find(
      (entry) => entry.id === installed.manifest.id
    );
    if (previous) {
      const runtime = this.runtimes.get(installed.manifest.id);
      if (runtime) await this.deactivateRuntime(runtime);
    }
    this.registry.plugins = [
      ...this.registry.plugins.filter(
        (entry) => entry.id !== installed.manifest.id
      ),
      {
        id: installed.manifest.id,
        source: previous?.source ?? request.source,
        enabled: true,
        version: installed.manifest.version,
        installedAt: new Date().toISOString()
      }
    ];
    await writePluginRegistry(this.options.pluginsDirectory, this.registry);
    await this.activateById(installed.manifest.id);
    await this.queueModels();
    return this.list();
  }

  async setEnabled(id: string, enabled: boolean): Promise<PluginListResult> {
    const entry = this.requireEntry(id);
    if (entry.enabled === enabled) return this.list();
    entry.enabled = enabled;
    await writePluginRegistry(this.options.pluginsDirectory, this.registry);
    if (enabled) {
      await this.activateById(id);
    } else {
      const runtime = this.runtimes.get(id);
      if (runtime) await this.deactivateRuntime(runtime);
    }
    await this.queueModels();
    return this.list();
  }

  async reload(id: string): Promise<PluginListResult> {
    const entry = this.requireEntry(id);
    const runtime = this.runtimes.get(id);
    if (runtime) await this.deactivateRuntime(runtime);
    if (entry.enabled) await this.activateById(id);
    await this.queueModels();
    return this.list();
  }

  async uninstall(id: string): Promise<PluginListResult> {
    const entry = this.requireEntry(id);
    if (entry.source === "bundled") {
      throw new Error("内置插件不能卸载，可以在列表中停用。");
    }
    const runtime = this.runtimes.get(id);
    if (runtime) await this.deactivateRuntime(runtime);
    this.runtimes.delete(id);
    this.registry.plugins = this.registry.plugins.filter(
      (item) => item.id !== id
    );
    await writePluginRegistry(this.options.pluginsDirectory, this.registry);
    await rm(join(this.options.pluginsDirectory, id), {
      recursive: true,
      force: true
    });
    await rm(join(this.options.pluginDataDirectory, id), {
      recursive: true,
      force: true
    });
    await this.queueModels();
    return this.list();
  }

  private requireEntry(id: string): InstalledPluginEntry {
    const entry = this.registry.plugins.find((item) => item.id === id);
    if (!entry) throw new Error("没有找到这个插件，请刷新后重试。");
    return entry;
  }

  private toRecord(
    entry: InstalledPluginEntry,
    manifest: PluginManifest | undefined
  ): PluginRecord {
    const runtime = this.runtimes.get(entry.id);
    const capabilities: PluginCapability[] = manifest?.capabilities ?? [];
    const state: PluginState = !entry.enabled
      ? "disabled"
      : runtime?.state === "active"
        ? "active"
        : runtime?.state === "error"
          ? "error"
          : entry.enabled
            ? "error"
            : "disabled";
    const error =
      entry.enabled && !runtime
        ? "插件未能加载，请重新加载或查看日志。"
        : runtime?.error;
    const modelIds = runtime
      ? [...runtime.providers.values()].flatMap((provider) =>
          provider.models.map((model) => pluginModelId(entry.id, model.id))
        )
      : [];
    return {
      id: entry.id,
      name: manifest?.name ?? entry.id,
      version: manifest?.version ?? entry.version,
      ...(manifest?.description ? { description: manifest.description } : {}),
      ...(manifest?.author ? { author: manifest.author } : {}),
      ...(manifest?.homepage ? { homepage: manifest.homepage } : {}),
      source: entry.source,
      enabled: entry.enabled,
      state,
      ...(error ? { error } : {}),
      capabilities,
      directory: join(this.options.pluginsDirectory, entry.id),
      statusFields: runtime?.statusFields ?? [],
      modelIds
    };
  }

  private async activateAllEnabled(): Promise<void> {
    for (const entry of this.registry.plugins) {
      if (!entry.enabled) continue;
      await this.activateById(entry.id);
    }
  }

  private async activateById(id: string): Promise<void> {
    const entry = this.registry.plugins.find((item) => item.id === id);
    if (!entry) return;
    const directory = join(this.options.pluginsDirectory, entry.id);
    const runtime: PluginRuntime = {
      entry,
      manifest: PluginManifestSchema.parse({
        id: entry.id,
        name: entry.id,
        version: entry.version
      }),
      directory,
      state: entry.enabled ? "error" : "disabled",
      error: entry.enabled ? "插件尚未加载。" : undefined,
      statusFields: [],
      instance: undefined,
      providers: new Map()
    };
    this.runtimes.set(id, runtime);
    try {
      const manifest = await readPluginManifest(directory);
      runtime.manifest = manifest;
      entry.version = manifest.version;
      const entryPath = await resolvePluginEntry(directory, manifest);
      const module = (await import(
        `${pathToFileURL(entryPath).href}?v=${Date.now()}`
      )) as PluginModule & { default?: PluginModule };
      const instance = module.default ?? module;
      if (typeof instance.activate !== "function") {
        throw new Error("插件入口没有导出 activate(context) 函数。");
      }
      await instance.activate(this.createContext(runtime));
      runtime.instance = instance;
      runtime.state = "active";
      runtime.error = undefined;
      this.log("plugins.activated", { id, version: manifest.version });
    } catch (error) {
      runtime.state = "error";
      runtime.error = errorText(error);
      runtime.providers.clear();
      this.log("plugins.activate.failed", { id, error });
    }
    await writePluginRegistry(this.options.pluginsDirectory, this.registry);
  }

  private async deactivateRuntime(runtime: PluginRuntime): Promise<void> {
    try {
      await runtime.instance?.deactivate?.();
    } catch (error) {
      this.log("plugins.deactivate.failed", {
        id: runtime.entry.id,
        error
      });
    }
    runtime.instance = undefined;
    runtime.providers.clear();
    runtime.statusFields = [];
    runtime.state = runtime.entry.enabled ? "error" : "disabled";
    runtime.error = runtime.entry.enabled ? "插件已停止。" : undefined;
    this.runtimes.delete(runtime.entry.id);
  }

  private createContext(runtime: PluginRuntime): DeepWritePluginContext {
    const dataDirectory = join(
      this.options.pluginDataDirectory,
      runtime.entry.id
    );
    const configPath = join(dataDirectory, "config.json");
    return {
      plugin: {
        id: runtime.entry.id,
        name: runtime.manifest.name,
        version: runtime.manifest.version,
        directory: runtime.directory,
        dataDirectory
      },
      app: {
        version: this.options.appVersion,
        platform: process.platform,
        userDataPath: this.options.userDataPath
      },
      logger: {
        info: (message, details) =>
          this.log("plugins.plugin.info", {
            id: runtime.entry.id,
            message,
            details
          }),
        warn: (message, details) =>
          this.log("plugins.plugin.warn", {
            id: runtime.entry.id,
            message,
            details
          }),
        error: (message, details) =>
          this.log("plugins.plugin.error", {
            id: runtime.entry.id,
            message,
            details
          })
      },
      config: {
        read: async <T>() => {
          const raw = await readFile(configPath, "utf8").catch(() => undefined);
          if (!raw) return undefined;
          try {
            return JSON.parse(raw) as T;
          } catch {
            return undefined;
          }
        },
        write: async (value) => {
          await mkdir(dataDirectory, { recursive: true });
          const temporary = `${configPath}.${process.pid}.tmp`;
          await writeFile(
            temporary,
            `${JSON.stringify(value, null, 2)}\n`,
            "utf8"
          );
          await rename(temporary, configPath);
        }
      },
      models: {
        registerProvider: async (provider) => {
          const normalized = normalizeProvider(provider);
          runtime.providers.set(normalized.id, normalized);
          await this.queueModels();
        },
        unregisterProvider: async (providerId) => {
          if (runtime.providers.delete(providerId)) await this.queueModels();
        }
      },
      status: {
        set: (fields) => {
          runtime.statusFields = fields
            .map((field) => PluginStatusFieldSchema.parse(field))
            .slice(0, 12);
        }
      }
    };
  }

  private queueModels(): Promise<void> {
    const operation = this.modelChain.then(
      () => this.applyModels(),
      () => this.applyModels()
    );
    this.modelChain = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }

  /**
   * Rewrites every plugin-owned model entry from the providers that are
   * currently registered. User-authored models are preserved untouched.
   */
  private async applyModels(): Promise<void> {
    const settings = await this.options.modelConfigStore.list();
    const kept = settings.models
      .filter((model) => !isPluginModelId(model.id))
      .map((model) => {
        const { hasApiKey: _hasApiKey, ...rest } = model;
        return rest as ModelConfigInput;
      });
    const additions: ModelConfigInput[] = [];
    for (const runtime of this.runtimes.values()) {
      if (runtime.state !== "active") continue;
      for (const provider of runtime.providers.values()) {
        for (const model of provider.models) {
          additions.push(toModelInput(runtime.entry.id, provider, model));
        }
      }
    }
    const models = [...kept, ...additions].slice(0, MAX_MODELS);
    const defaultModelId = models.some(
      (model) => model.id === settings.defaultModelId
    )
      ? settings.defaultModelId
      : (models[0]?.id ?? "");
    await this.options.modelConfigStore.save({ models, defaultModelId });
  }

  /**
   * Drops registry rows whose folder was deleted outside the app, so the list
   * never advertises a plugin that cannot be loaded.
   */
  private async presentEntries(
    entries: InstalledPluginEntry[]
  ): Promise<InstalledPluginEntry[]> {
    const present: InstalledPluginEntry[] = [];
    for (const entry of entries) {
      const directory = join(this.options.pluginsDirectory, entry.id);
      const info = await stat(directory).catch(() => undefined);
      if (info?.isDirectory()) present.push(entry);
    }
    return present;
  }

  /**
   * Bundled plugins ship with the app. They are copied into the user's plugin
   * folder on first run and refreshed when the shipped version changes, so the
   * app bundle itself never has to be writable.
   */
  private async installBundledPlugins(): Promise<void> {
    const source = this.options.builtinPluginsDirectory;
    if (!source) return;
    const entries = await readdir(source, { withFileTypes: true }).catch(
      () => []
    );
    const registry = await readPluginRegistry(this.options.pluginsDirectory);
    for (const directoryEntry of entries) {
      if (!directoryEntry.isDirectory()) continue;
      const sourceDirectory = join(source, directoryEntry.name);
      const manifest = await readPluginManifest(sourceDirectory).catch(
        () => undefined
      );
      if (!manifest) continue;
      const target = join(this.options.pluginsDirectory, manifest.id);
      const existing = registry.plugins.find(
        (entry) => entry.id === manifest.id
      );
      if (existing && existing.version === manifest.version) continue;
      await rm(target, { recursive: true, force: true });
      await copyDirectory(sourceDirectory, target);
      const next: InstalledPluginEntry = {
        id: manifest.id,
        source: "bundled",
        enabled: existing?.enabled ?? true,
        version: manifest.version,
        installedAt: new Date().toISOString()
      };
      registry.plugins = [
        ...registry.plugins.filter((entry) => entry.id !== manifest.id),
        next
      ];
      this.log("plugins.bundled.installed", {
        id: manifest.id,
        version: manifest.version
      });
    }
    await writePluginRegistry(this.options.pluginsDirectory, registry);
  }

  private log(event: string, details?: unknown): void {
    this.options.log(event, details);
  }
}

function normalizeProvider(
  provider: PluginProviderRegistration
): PluginProviderRegistration {
  if (!provider || typeof provider !== "object") {
    throw new Error("模型供应商配置无效。");
  }
  const id = String(provider.id ?? "").trim();
  const name = String(provider.name ?? "").trim();
  const baseUrl = String(provider.baseUrl ?? "").trim();
  const apiKey = String(provider.apiKey ?? "").trim();
  if (!id || id.length > 120) throw new Error("供应商 id 无效。");
  if (!name || name.length > 120) throw new Error("供应商名称无效。");
  if (!isHttpUrl(baseUrl))
    throw new Error("供应商 baseUrl 必须是 http(s) 地址。");
  if (!apiKey) throw new Error("供应商 apiKey 不能为空。");
  const models = Array.isArray(provider.models) ? provider.models : [];
  if (!models.length) throw new Error("供应商至少需要声明一个模型。");
  return {
    id,
    name,
    baseUrl,
    apiKey,
    ...(provider.api ? { api: provider.api } : {}),
    models: models.slice(0, MAX_MODELS).map((model) => {
      const modelId = String(model?.id ?? "").trim();
      if (!modelId || modelId.length > 240) {
        throw new Error("模型 id 无效。");
      }
      return {
        id: modelId,
        ...(model.label ? { label: String(model.label).slice(0, 120) } : {}),
        ...(model.description
          ? { description: String(model.description).slice(0, 500) }
          : {}),
        ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
        ...(model.maxTokens ? { maxTokens: model.maxTokens } : {}),
        ...(model.reasoning ? { reasoning: true } : {}),
        ...(model.defaultThinkingLevel
          ? { defaultThinkingLevel: model.defaultThinkingLevel }
          : {})
      };
    })
  };
}

function toModelInput(
  pluginId: string,
  provider: PluginProviderRegistration,
  model: PluginModelDescriptor
): ModelConfigInput {
  const id = pluginModelId(pluginId, model.id).slice(0, 120);
  const reasoning = Boolean(model.reasoning);
  const requestedLevel = model.defaultThinkingLevel;
  const defaultThinkingLevel =
    reasoning &&
    requestedLevel &&
    (BUILT_IN_REASONING_LEVELS as readonly string[]).includes(requestedLevel)
      ? requestedLevel
      : reasoning
        ? "medium"
        : "off";
  const hasWindow =
    typeof model.contextWindow === "number" &&
    model.contextWindow >= 1_024 &&
    typeof model.maxTokens === "number" &&
    model.maxTokens >= 1 &&
    model.maxTokens <= model.contextWindow;
  return {
    id,
    label: (model.label ?? model.id).slice(0, 120),
    ...(model.description
      ? { description: model.description.slice(0, 500) }
      : {}),
    provider: provider.name,
    modelId: model.id,
    api: provider.api ?? "openai-completions",
    baseUrl: provider.baseUrl,
    reasoning,
    defaultThinkingLevel,
    thinkingLevelOptions: [...BUILT_IN_REASONING_LEVELS],
    temperatureOptions: [0.1, 0.7, 1] as [number, number, number],
    supportsDeveloperRole: false,
    apiKey: provider.apiKey,
    ...(hasWindow
      ? {
          contextWindow: Math.floor(model.contextWindow!),
          maxTokens: Math.floor(model.maxTokens!)
        }
      : {})
  };
}

function pluginModelId(pluginId: string, modelId: string): string {
  return `${PLUGIN_MODEL_ID_PREFIX}${pluginId}-${modelId}`;
}

function isPluginModelId(id: string): boolean {
  return id.startsWith(PLUGIN_MODEL_ID_PREFIX);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Copies a folder tree without relying on asar-aware `cp` semantics. */
async function copyDirectory(from: string, to: string): Promise<void> {
  const entries = await readdir(from, { withFileTypes: true });
  await mkdir(to, { recursive: true });
  for (const entry of entries) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(source, target);
    } else if (entry.isFile()) {
      await writeFile(target, await readFile(source));
    }
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 1_000);
  return String(error).slice(0, 1_000);
}
