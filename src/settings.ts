export interface SettingState {
  id: string
  value: unknown
  configured: boolean
  ignoredInRestrictedMode: boolean
}

export interface ConfigurationInspection {
  defaultValue?: unknown
  globalValue?: unknown
  workspaceValue?: unknown
  workspaceFolderValue?: unknown
}

export function resolveSettingState(
  id: string,
  effectiveValue: unknown,
  inspection: ConfigurationInspection | undefined,
  workspaceTrusted: boolean,
): SettingState {
  const workspaceConfigured = inspection?.workspaceValue !== undefined || inspection?.workspaceFolderValue !== undefined
  return {
    id,
    value:
      !workspaceTrusted && workspaceConfigured ? (inspection?.globalValue ?? inspection?.defaultValue) : effectiveValue,
    configured: Boolean(
      inspection?.globalValue !== undefined ||
      inspection?.workspaceValue !== undefined ||
      inspection?.workspaceFolderValue !== undefined,
    ),
    ignoredInRestrictedMode: !workspaceTrusted && workspaceConfigured,
  }
}
