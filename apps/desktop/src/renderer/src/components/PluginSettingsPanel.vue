<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type {
  PluginCapability,
  PluginInstallSource,
  PluginListResult,
  PluginRecord
} from "@deepwrite/contracts";
import AgentTeamSwitch from "./AgentTeamSwitch.vue";
import PopupSelect from "./PopupSelect.vue";
import { createScopedTranslator } from "../i18n";
import { uiMessage } from "../ui-feedback";

const t = createScopedTranslator("components.pluginSettings");

type InstallSource = "local" | "npm" | "github";

const plugins = ref<readonly PluginRecord[]>([]);
const loading = ref(true);
const loadError = ref<string | null>(null);
const adding = ref(false);
const installing = ref(false);
const busyId = ref<string | null>(null);
const source = ref<InstallSource>("local");
const spec = ref("");
const pendingRemoval = ref<string | null>(null);
let removalTimer: ReturnType<typeof setTimeout> | undefined;

const sourceOptions = computed<Array<{ value: InstallSource; label: string }>>(
  () => [
    { value: "local", label: t("sourceLocal") },
    { value: "npm", label: t("sourceNpm") },
    { value: "github", label: t("sourceGithub") }
  ]
);

const placeholder = computed(() =>
  source.value === "local"
    ? t("specLocalPlaceholder")
    : source.value === "npm"
      ? t("specNpmPlaceholder")
      : t("specGithubPlaceholder")
);
const hint = computed(() =>
  source.value === "local"
    ? t("installHintLocal")
    : source.value === "npm"
      ? t("installHintNpm")
      : t("installHintGithub")
);
const canInstall = computed(() => spec.value.trim().length > 0);

function api() {
  return window.deepwrite?.plugins;
}

function applySnapshot(snapshot: PluginListResult): void {
  plugins.value = snapshot.plugins;
  loadError.value = null;
}

async function load(): Promise<void> {
  const service = api();
  if (!service) {
    loading.value = false;
    loadError.value = t("unsupported");
    return;
  }
  loading.value = true;
  try {
    applySnapshot(await service.list());
  } catch (error) {
    loadError.value = t("loadFailed", { message: messageOf(error) });
  } finally {
    loading.value = false;
  }
}

async function install(): Promise<void> {
  const service = api();
  if (!service || !canInstall.value || installing.value) return;
  installing.value = true;
  const before = new Set(plugins.value.map((plugin) => plugin.id));
  try {
    const snapshot = await service.install({
      source: source.value,
      spec: spec.value.trim()
    });
    applySnapshot(snapshot);
    const installed = snapshot.plugins.find((plugin) => !before.has(plugin.id));
    uiMessage.success(
      t("installed", { name: installed?.name ?? spec.value.trim() })
    );
    spec.value = "";
    adding.value = false;
  } catch (error) {
    uiMessage.error(t("installFailed", { message: messageOf(error) }));
  } finally {
    installing.value = false;
  }
}

function selectSource(value: string | number): void {
  if (value === "local" || value === "npm" || value === "github") {
    source.value = value;
  }
}

async function browse(): Promise<void> {
  const service = api();
  if (!service) return;
  try {
    const result = await service.chooseSource();
    if (result.path) spec.value = result.path;
  } catch (error) {
    uiMessage.error(t("installFailed", { message: messageOf(error) }));
  }
}

async function toggle(plugin: PluginRecord, enabled: boolean): Promise<void> {
  const service = api();
  if (!service || busyId.value) return;
  busyId.value = plugin.id;
  try {
    applySnapshot(await service.setEnabled(plugin.id, enabled));
  } catch (error) {
    uiMessage.error(t("toggleFailed", { message: messageOf(error) }));
  } finally {
    busyId.value = null;
  }
}

async function reload(plugin: PluginRecord): Promise<void> {
  const service = api();
  if (!service || busyId.value) return;
  busyId.value = plugin.id;
  try {
    applySnapshot(await service.reload(plugin.id));
    uiMessage.success(t("reloaded", { name: plugin.name }));
  } catch (error) {
    uiMessage.error(t("reloadFailed", { message: messageOf(error) }));
  } finally {
    busyId.value = null;
  }
}

async function remove(plugin: PluginRecord): Promise<void> {
  const service = api();
  if (!service || busyId.value) return;
  if (pendingRemoval.value !== plugin.id) {
    pendingRemoval.value = plugin.id;
    if (removalTimer) clearTimeout(removalTimer);
    removalTimer = setTimeout(() => {
      if (pendingRemoval.value === plugin.id) pendingRemoval.value = null;
    }, 4_000);
    return;
  }
  pendingRemoval.value = null;
  busyId.value = plugin.id;
  try {
    applySnapshot(await service.uninstall(plugin.id));
    uiMessage.success(t("uninstalled", { name: plugin.name }));
  } catch (error) {
    uiMessage.error(t("uninstallFailed", { message: messageOf(error) }));
  } finally {
    busyId.value = null;
  }
}

function stateLabel(plugin: PluginRecord): string {
  if (plugin.state === "active") return t("stateActive");
  if (plugin.state === "error") return t("stateError");
  return t("stateDisabled");
}

function sourceLabel(value: PluginInstallSource): string {
  switch (value) {
    case "bundled":
      return t("sourceBundled");
    case "npm":
      return t("sourceNpmLabel");
    case "github":
      return t("sourceGithubLabel");
    default:
      return t("sourceLocalLabel");
  }
}

function capabilityLabel(capability: PluginCapability): string {
  return capability === "model-provider"
    ? t("capabilityModelProvider")
    : capability;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

onMounted(() => void load());
</script>

<template>
  <section class="settings-group plugin-settings">
    <p class="plugin-intro">{{ t("intro") }}</p>

    <div class="plugin-toolbar">
      <span class="plugin-count">
        {{ t("installedCount", { count: plugins.length }) }}
      </span>
      <button class="plugin-primary" type="button" @click="adding = !adding">
        {{ adding ? t("cancel") : t("addPlugin") }}
      </button>
    </div>

    <div v-if="adding" class="settings-card plugin-add">
      <div class="plugin-add-row">
        <PopupSelect
          class="plugin-source-select"
          :model-value="source"
          :options="sourceOptions"
          :accessible-label="t('installSource')"
          @update:model-value="selectSource"
        />
        <input
          v-model="spec"
          class="plugin-input"
          type="text"
          :placeholder="placeholder"
          :aria-label="t('installSource')"
          @keydown.enter.prevent="install"
        />
        <button
          v-if="source === 'local'"
          class="plugin-secondary"
          type="button"
          @click="browse"
        >
          {{ t("browse") }}
        </button>
        <button
          class="plugin-primary"
          type="button"
          :disabled="!canInstall || installing"
          @click="install"
        >
          {{ installing ? t("installing") : t("install") }}
        </button>
      </div>
      <p class="plugin-hint">{{ hint }}</p>
    </div>

    <p class="plugin-security">{{ t("securityNote") }}</p>

    <p v-if="loading" class="plugin-empty">{{ t("loading") }}</p>
    <p v-else-if="loadError" class="plugin-error-block">{{ loadError }}</p>
    <div v-else-if="!plugins.length" class="settings-card plugin-empty">
      <strong>{{ t("emptyTitle") }}</strong>
      <span>{{ t("emptyDescription") }}</span>
    </div>

    <article
      v-for="plugin in plugins"
      :key="plugin.id"
      class="settings-card plugin-card"
    >
      <header class="plugin-card-head">
        <div class="plugin-identity">
          <strong class="plugin-name">{{ plugin.name }}</strong>
          <span class="plugin-version">v{{ plugin.version }}</span>
          <span class="plugin-state" :class="`is-${plugin.state}`">
            {{ stateLabel(plugin) }}
          </span>
          <span class="plugin-source">{{ sourceLabel(plugin.source) }}</span>
        </div>
        <div class="plugin-actions">
          <button
            class="plugin-text-button"
            type="button"
            :disabled="busyId === plugin.id"
            @click="reload(plugin)"
          >
            {{ t("reload") }}
          </button>
          <button
            v-if="plugin.source !== 'bundled'"
            class="plugin-text-button is-danger"
            type="button"
            :disabled="busyId === plugin.id"
            @click="remove(plugin)"
          >
            {{
              pendingRemoval === plugin.id
                ? t("confirmUninstall")
                : t("uninstall")
            }}
          </button>
          <AgentTeamSwitch
            :model-value="plugin.enabled"
            :disabled="busyId === plugin.id"
            :label="plugin.name"
            @update:model-value="toggle(plugin, $event)"
          />
        </div>
      </header>

      <p v-if="plugin.description" class="plugin-description">
        {{ plugin.description }}
      </p>
      <p v-if="plugin.error" class="plugin-error">{{ plugin.error }}</p>

      <dl v-if="plugin.statusFields.length" class="plugin-status">
        <div
          v-for="field in plugin.statusFields"
          :key="field.label"
          class="plugin-status-row"
        >
          <dt>{{ field.label }}</dt>
          <dd>{{ field.value }}</dd>
        </div>
      </dl>

      <div class="plugin-meta">
        <span
          v-for="capability in plugin.capabilities"
          :key="capability"
          class="plugin-tag"
        >
          {{ capabilityLabel(capability) }}
        </span>
        <span v-if="plugin.modelIds.length" class="plugin-tag">
          {{ t("modelCount", { count: plugin.modelIds.length }) }}
        </span>
        <span class="plugin-path" :title="plugin.directory">
          {{ plugin.directory }}
        </span>
      </div>
    </article>
  </section>
</template>

<style scoped src="./plugin-settings.css"></style>
