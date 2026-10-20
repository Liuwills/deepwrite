import {
  PluginInstallInputSchema,
  PluginListResultSchema,
  PluginsChooseSourceResultSchema,
  createEnvelope,
  type PluginListResult,
  type PluginsApi
} from "@deepwrite/contracts";
import { browserId, invokeCommand } from "./invoke";

async function list(): Promise<PluginListResult> {
  const id = browserId("cmd_plugins_list");
  return PluginListResultSchema.parse(
    await invokeCommand(
      createEnvelope("plugins.list", {}, { id, correlationId: id })
    )
  );
}

export const plugins: PluginsApi = {
  list,
  async install(rawInput) {
    const input = PluginInstallInputSchema.parse(rawInput);
    const id = browserId("cmd_plugins_install");
    return PluginListResultSchema.parse(
      await invokeCommand(
        createEnvelope("plugins.install", input, { id, correlationId: id })
      )
    );
  },
  async setEnabled(pluginId, enabled) {
    const id = browserId("cmd_plugins_enabled");
    return PluginListResultSchema.parse(
      await invokeCommand(
        createEnvelope(
          "plugins.setEnabled",
          { id: pluginId, enabled },
          { id, correlationId: id }
        )
      )
    );
  },
  async uninstall(pluginId) {
    const id = browserId("cmd_plugins_uninstall");
    return PluginListResultSchema.parse(
      await invokeCommand(
        createEnvelope(
          "plugins.uninstall",
          { id: pluginId },
          { id, correlationId: id }
        )
      )
    );
  },
  async reload(pluginId) {
    const id = browserId("cmd_plugins_reload");
    return PluginListResultSchema.parse(
      await invokeCommand(
        createEnvelope(
          "plugins.reload",
          { id: pluginId },
          { id, correlationId: id }
        )
      )
    );
  },
  async chooseSource() {
    const id = browserId("cmd_plugins_choose_source");
    return PluginsChooseSourceResultSchema.parse(
      await invokeCommand(
        createEnvelope("plugins.chooseSource", {}, { id, correlationId: id })
      )
    );
  }
};
