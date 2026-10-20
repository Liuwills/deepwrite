import { z } from "zod";
import { EnvelopeBaseSchema } from "./envelope";

/**
 * External plugin contract. A plugin is a folder with a `plugin.json` manifest
 * and an ES module entry that exports `activate(context)` / optional
 * `deactivate()`. Plugins extend DeepWrite without shipping a new build, which
 * is why installing one is always an explicit, user-initiated action.
 */
export const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

export const PluginInstallSourceSchema = z.enum([
  "bundled",
  "local",
  "npm",
  "github"
]);
export type PluginInstallSource = z.infer<typeof PluginInstallSourceSchema>;

export const PluginCapabilitySchema = z.enum(["model-provider"]);
export type PluginCapability = z.infer<typeof PluginCapabilitySchema>;

export const PluginStateSchema = z.enum(["active", "disabled", "error"]);
export type PluginState = z.infer<typeof PluginStateSchema>;

export const PluginManifestSchema = z.object({
  id: z
    .string()
    .trim()
    .regex(PLUGIN_ID_PATTERN, "Plugin ids use lowercase letters and dots.")
    .max(64),
  name: z.string().trim().min(1).max(80),
  version: z.string().trim().min(1).max(40),
  description: z.string().trim().max(500).optional(),
  author: z.string().trim().max(120).optional(),
  homepage: z.url().max(500).optional(),
  /** Entry module, relative to the plugin folder. */
  main: z.string().trim().min(1).max(200).default("index.mjs"),
  capabilities: z.array(PluginCapabilitySchema).max(8).default([]),
  engines: z
    .object({
      deepwrite: z.string().trim().max(40).optional()
    })
    .optional()
});
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

/** One label/value row a running plugin exposes on its card. */
export const PluginStatusFieldSchema = z.object({
  label: z.string().trim().min(1).max(40),
  value: z.string().trim().max(300)
});
export type PluginStatusField = z.infer<typeof PluginStatusFieldSchema>;

export const PluginRecordSchema = z.object({
  id: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(80),
  version: z.string().trim().min(1).max(40),
  description: z.string().max(500).optional(),
  author: z.string().max(120).optional(),
  homepage: z.string().max(500).optional(),
  source: PluginInstallSourceSchema,
  enabled: z.boolean(),
  state: PluginStateSchema,
  /** Human-readable activation failure, present when state is `error`. */
  error: z.string().max(1_000).optional(),
  capabilities: z.array(PluginCapabilitySchema).max(8),
  directory: z.string().max(2_000),
  statusFields: z.array(PluginStatusFieldSchema).max(12),
  /** Model ids this plugin currently contributes to the model settings. */
  modelIds: z.array(z.string().max(120)).max(100)
});
export type PluginRecord = z.infer<typeof PluginRecordSchema>;

export const PluginListResultSchema = z.object({
  directory: z.string().max(2_000),
  plugins: z.array(PluginRecordSchema).max(200)
});
export type PluginListResult = z.infer<typeof PluginListResultSchema>;

export const PluginInstallInputSchema = z.object({
  /** `local` takes a folder path; `npm` a package spec; `github` a git URL. */
  source: PluginInstallSourceSchema.exclude(["bundled"]),
  spec: z.string().trim().min(1).max(2_000)
});
export type PluginInstallInput = z.infer<typeof PluginInstallInputSchema>;

export const PluginsListCommandEnvelopeSchema = EnvelopeBaseSchema.extend({
  type: z.literal("plugins.list"),
  payload: z.object({})
});

export const PluginsInstallCommandEnvelopeSchema = EnvelopeBaseSchema.extend({
  type: z.literal("plugins.install"),
  payload: PluginInstallInputSchema
});

export const PluginsSetEnabledCommandEnvelopeSchema = EnvelopeBaseSchema.extend(
  {
    type: z.literal("plugins.setEnabled"),
    payload: z.object({
      id: z.string().trim().min(1).max(64),
      enabled: z.boolean()
    })
  }
);

export const PluginsUninstallCommandEnvelopeSchema = EnvelopeBaseSchema.extend({
  type: z.literal("plugins.uninstall"),
  payload: z.object({ id: z.string().trim().min(1).max(64) })
});

export const PluginsReloadCommandEnvelopeSchema = EnvelopeBaseSchema.extend({
  type: z.literal("plugins.reload"),
  payload: z.object({ id: z.string().trim().min(1).max(64) })
});

export const PluginsChooseSourceCommandEnvelopeSchema =
  EnvelopeBaseSchema.extend({
    type: z.literal("plugins.chooseSource"),
    payload: z.object({})
  });

export const PluginsChooseSourceResultSchema = z.object({
  path: z.string().max(2_000).nullable()
});
export type PluginsChooseSourceResult = z.infer<
  typeof PluginsChooseSourceResultSchema
>;

export const PluginCommandSchemas = [
  PluginsListCommandEnvelopeSchema,
  PluginsInstallCommandEnvelopeSchema,
  PluginsSetEnabledCommandEnvelopeSchema,
  PluginsUninstallCommandEnvelopeSchema,
  PluginsReloadCommandEnvelopeSchema,
  PluginsChooseSourceCommandEnvelopeSchema
] as const;

/** Preload surface for the plugin page. */
export interface PluginsApi {
  list(): Promise<PluginListResult>;
  install(input: PluginInstallInput): Promise<PluginListResult>;
  setEnabled(id: string, enabled: boolean): Promise<PluginListResult>;
  uninstall(id: string): Promise<PluginListResult>;
  reload(id: string): Promise<PluginListResult>;
  chooseSource(): Promise<PluginsChooseSourceResult>;
}
