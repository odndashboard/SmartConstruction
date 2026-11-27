export type WorkspaceMode = 'simple' | 'advanced';
export const WORKSPACE_MODE_COOKIE = 'crm-workspace-mode';

export function workspaceMode(value?: string): WorkspaceMode {
  return value === 'simple' ? 'simple' : 'advanced';
}
