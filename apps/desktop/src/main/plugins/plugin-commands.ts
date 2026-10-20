import type { CommandEnvelope, CommandResult } from "@deepwrite/contracts";
import type { PluginHost } from "./plugin-host";

interface PluginCommandOptions {
  /** Opens the native folder picker for a local plugin directory. */
  chooseDirectory: () => Promise<string | null>;
}

export async function handlePluginCommands(
  command: CommandEnvelope,
  host: PluginHost | undefined,
  options: PluginCommandOptions
): Promise<CommandResult | undefined> {
  if (!command.type.startsWith("plugins.")) return undefined;
  if (!host) {
    return rejected(command.id, "plugins.unavailable", "插件服务尚未就绪。");
  }
  try {
    switch (command.type) {
      case "plugins.list":
        return accepted(command.id, await host.list());
      case "plugins.install":
        return accepted(
          command.id,
          await host.install({
            source: command.payload.source,
            spec: command.payload.spec
          })
        );
      case "plugins.setEnabled":
        return accepted(
          command.id,
          await host.setEnabled(command.payload.id, command.payload.enabled)
        );
      case "plugins.uninstall":
        return accepted(command.id, await host.uninstall(command.payload.id));
      case "plugins.reload":
        return accepted(command.id, await host.reload(command.payload.id));
      case "plugins.chooseSource":
        return accepted(command.id, {
          path: await options.chooseDirectory()
        });
      default:
        return undefined;
    }
  } catch (error) {
    return rejected(
      command.id,
      `plugins.${command.type.slice("plugins.".length)}_failed`,
      error instanceof Error ? error.message : String(error)
    );
  }
}

function accepted(requestId: string, result: unknown): CommandResult {
  return {
    status: "accepted",
    requestId,
    payload: result
  };
}

function rejected(
  requestId: string,
  code: string,
  message: string
): CommandResult {
  return {
    status: "rejected",
    requestId,
    error: { code, message }
  };
}
