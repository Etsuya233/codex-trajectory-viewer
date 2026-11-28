export const MCP_UI_URI = 'ui://local-trajectory-viewer/viewer-v1.html';
export const MCP_UI_MIME = 'text/html;profile=mcp-app';
export const MCP_OPEN = 'open_local_trajectory_viewer';
export const MCP_SHOW = 'show_local_trajectory_viewer';
export const MCP_CONTEXT = 'local_trajectory_context';
export const MCP_READ = 'local_trajectory_read';
export const MCP_SETTINGS = 'local_trajectory_settings';

export type PanelContext =
  | { mode: 'host-thread'; sessionId: string }
  | { mode: 'choose-session'; reason: 'missing' | 'invalid' };

export type PanelResponse = { data: unknown } | { error: string };
