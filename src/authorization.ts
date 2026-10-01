import {
  getAgentDir,
  SettingsManager,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export const SETTINGS_KEY = "pi-session-snapshot";
export const SAVE_SETTING = "agentSaveToolAllowed";
export const RESTORE_SETTING = "agentRestoreToolAllowed";

export type AgentAction = "save" | "restore";
export type PermissionOverride = boolean | null;
export type PermissionSource = "override" | "configuration" | "default";

export interface AgentConfiguration {
  save: boolean;
  restore: boolean;
}

export interface PermissionResolution {
  allowed: boolean;
  source: PermissionSource;
}

interface RuntimeState {
  version: 1;
  configurationLoaded: boolean;
  configuration: AgentConfiguration;
  overrides: Record<AgentAction, PermissionOverride>;
}

const STATE_SYMBOL = Symbol.for("pi-session-snapshot.agent-permissions.v1");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readState(): unknown {
  return (globalThis as Record<symbol, unknown>)[STATE_SYMBOL];
}

function isRuntimeState(value: unknown): value is RuntimeState {
  if (!isRecord(value) || value.version !== 1) return false;
  if (
    typeof value.configurationLoaded !== "boolean" ||
    !isRecord(value.configuration) ||
    !isRecord(value.overrides)
  ) {
    return false;
  }
  return (
    typeof value.configuration.save === "boolean" &&
    typeof value.configuration.restore === "boolean" &&
    (value.overrides.save === null ||
      typeof value.overrides.save === "boolean") &&
    (value.overrides.restore === null ||
      typeof value.overrides.restore === "boolean")
  );
}

export function getPermissionState(): RuntimeState {
  const existing = readState();
  if (isRuntimeState(existing)) return existing;
  const fresh: RuntimeState = {
    version: 1,
    configurationLoaded: false,
    configuration: { save: false, restore: false },
    overrides: { save: null, restore: null },
  };
  (globalThis as Record<symbol, unknown>)[STATE_SYMBOL] = fresh;
  return fresh;
}

function settingKey(action: AgentAction): string {
  return action === "save" ? SAVE_SETTING : RESTORE_SETTING;
}

function readNamespace(
  settings: unknown,
  scope: "global settings" | "trusted project settings",
  warnings: string[],
): Partial<AgentConfiguration> {
  if (!isRecord(settings)) return {};
  const namespace = settings[SETTINGS_KEY];
  if (namespace === undefined) return {};
  if (!isRecord(namespace)) {
    warnings.push(
      `${scope}.${SETTINGS_KEY} must be an object; agent tools denied.`,
    );
    return { save: false, restore: false };
  }

  const values: Partial<AgentConfiguration> = {};
  for (const [key, value] of Object.entries(namespace)) {
    if (key !== SAVE_SETTING && key !== RESTORE_SETTING) {
      warnings.push(
        `${scope}.${SETTINGS_KEY} has unsupported key ${JSON.stringify(key)}`,
      );
      continue;
    }
    if (typeof value !== "boolean") {
      warnings.push(
        `${scope}.${SETTINGS_KEY}.${key} must be a boolean; this capability is denied.`,
      );
      values[key === SAVE_SETTING ? "save" : "restore"] = false;
      continue;
    }
    values[key === SAVE_SETTING ? "save" : "restore"] = value;
  }
  return values;
}

export function resolveConfiguration(
  globalSettings: unknown,
  projectSettings: unknown,
  projectTrusted: boolean,
  warnings: string[] = [],
): AgentConfiguration {
  const global = readNamespace(globalSettings, "global settings", warnings);
  const project = projectTrusted
    ? readNamespace(projectSettings, "trusted project settings", warnings)
    : {};
  return {
    save: project.save ?? global.save ?? false,
    restore: project.restore ?? global.restore ?? false,
  };
}

export function refreshConfiguration(
  ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted" | "ui">,
): AgentConfiguration {
  const warnings: string[] = [];
  let configuration: AgentConfiguration;
  try {
    const projectTrusted = ctx.isProjectTrusted();
    const settings = SettingsManager.create(ctx.cwd, getAgentDir(), {
      projectTrusted,
    });
    const settingErrors = settings.drainErrors();
    for (const { scope, error } of settingErrors) {
      warnings.push(`could not read ${scope} settings: ${error.message}`);
    }
    configuration =
      settingErrors.length > 0
        ? { save: false, restore: false }
        : resolveConfiguration(
            settings.getGlobalSettings(),
            settings.getProjectSettings(),
            projectTrusted,
            warnings,
          );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`could not load settings: ${message}`);
    configuration = { save: false, restore: false };
  }

  const state = getPermissionState();
  state.configuration = configuration;
  state.configurationLoaded = true;
  for (const warning of warnings) {
    ctx.ui.notify(`pi-session-snapshot: ${warning}`, "warning");
  }
  return configuration;
}

export function setOverride(
  action: AgentAction,
  value: PermissionOverride,
): void {
  getPermissionState().overrides[action] = value;
}

export function getOverride(action: AgentAction): PermissionOverride {
  return getPermissionState().overrides[action];
}

export function resetPermissionState(): void {
  (globalThis as Record<symbol, unknown>)[STATE_SYMBOL] = {
    version: 1,
    configurationLoaded: false,
    configuration: { save: false, restore: false },
    overrides: { save: null, restore: null },
  } satisfies RuntimeState;
}

export function setConfiguration(configuration: AgentConfiguration): void {
  const state = getPermissionState();
  state.configuration = configuration;
  state.configurationLoaded = true;
}

export function resolvePermission(action: AgentAction): PermissionResolution {
  const state = getPermissionState();
  const override = state.overrides[action];
  if (override !== null) return { allowed: override, source: "override" };
  if (state.configurationLoaded) {
    return { allowed: state.configuration[action], source: "configuration" };
  }
  return { allowed: false, source: "default" };
}

export function formatPermissionStatus(action: AgentAction): string {
  const permission = resolvePermission(action);
  const state = getPermissionState();
  const configured = state.configuration[action] ? "allowed" : "denied";
  return `${action}: ${permission.allowed ? "allowed" : "denied"} (${permission.source}; configuration baseline ${configured})`;
}

export function permissionGuidance(action: AgentAction): string {
  return `Agent-driven snapshot ${action} is denied for this session. Only the user can allow it with /snapshot agent ${action} allow. If the user requested this action, ask them to authorize it; otherwise do not retry.`;
}

export function settingName(action: AgentAction): string {
  return settingKey(action);
}
