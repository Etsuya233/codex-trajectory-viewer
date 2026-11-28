import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema, ErrorCode, ListResourcesRequestSchema, ListToolsRequestSchema, McpError, ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { MCP_CONTEXT, MCP_OPEN, MCP_READ, MCP_SETTINGS, MCP_SHOW, MCP_UI_MIME, MCP_UI_URI } from '../mcp-contract.ts';
import type { PanelContext, PanelResponse } from '../mcp-contract.ts';
import { RequestError, SESSION_ID } from './session.ts';
import { createTrajectoryApi } from './api.ts';
import { accessSettings } from './settings.ts';

const resource = { uri: MCP_UI_URI, name: '本地 Codex 轨迹查看器', mimeType: MCP_UI_MIME };
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const noArguments = { type: 'object', properties: {}, additionalProperties: false } as const;
const privateTool = { ui: { visibility: ['app'] }, 'openai/visibility': 'private' };
const uiTool = { ui: { resourceUri: MCP_UI_URI }, 'openai/outputTemplate': MCP_UI_URI };
const tools: Tool[] = [
  {
    name: MCP_OPEN, title: '本地 Codex 轨迹',
    description: '在当前聊天的侧面板打开本地轨迹。', inputSchema: noArguments, annotations: readOnly,
    _meta: { ...privateTool, ...uiTool, ui: { resourceUri: MCP_UI_URI, visibility: ['app'] },
      'openai/ui': { entrypoints: [{ type: 'thread' }] } },
  },
  {
    name: MCP_SHOW, title: '显示本地 Codex 轨迹',
    description: '打开交互式查看器。工具结果不包含会话正文。', inputSchema: noArguments,
    annotations: readOnly, _meta: uiTool,
  },
  {
    name: MCP_CONTEXT, title: '读取面板会话身份',
    description: '仅供面板读取这次宿主调用明确提供的聊天身份。', inputSchema: noArguments,
    annotations: readOnly, _meta: privateTool,
  },
  {
    name: MCP_READ, title: '加载轨迹面板数据',
    description: '仅供面板按需读取已有轨迹接口。', annotations: readOnly, _meta: privateTool,
    inputSchema: {
      type: 'object', properties: { path: { type: 'string', pattern: '^/api/sessions(?:[/?]|$)', maxLength: 8192 } },
      required: ['path'], additionalProperties: false,
    },
  },
  {
    name: MCP_SETTINGS, title: '轨迹查看器设置',
    description: '仅供面板读取或保存本机的轨迹查看器设置。', _meta: privateTool,
    annotations: { ...readOnly, readOnlyHint: false },
    inputSchema: {
      type: 'object', properties: {
        key: { type: 'string', enum: ['foldTools', 'keepLatestOpen', 'loadAll'] }, value: { type: 'boolean' },
      }, additionalProperties: false,
    },
  },
];

export function callingThread(meta: Record<string, unknown> | undefined): PanelContext {
  const ids = ['threadId', 'thread_id'].filter(key => meta && Object.hasOwn(meta, key)).map(key => meta![key]);
  if (!ids.length) return { mode: 'choose-session', reason: 'missing' };
  if (ids.some(id => typeof id !== 'string' || !SESSION_ID.test(id))) return { mode: 'choose-session', reason: 'invalid' };
  const normalized = (ids as string[]).map(id => id.toLowerCase());
  if (new Set(normalized).size !== 1) return { mode: 'choose-session', reason: 'invalid' };
  return { mode: 'host-thread', sessionId: normalized[0] };
}

function panelData(response: PanelResponse): CallToolResult {
  return {
    content: [{ type: 'text', text: '轨迹面板数据。' }],
    _meta: { trajectoryResponse: response },
  };
}

function panelContext(context: PanelContext, open: boolean): CallToolResult {
  return {
    content: [{ type: 'text', text: open ? '已请求打开本地 Codex 轨迹查看器。' : '本地 Codex 轨迹面板已连接。' }],
    _meta: { trajectoryContext: context, ...(open ? { ui: { resourceUri: MCP_UI_URI } } : {}) },
  };
}

export function createMcpBridge(
  codexHome: string,
  readHtml: () => Promise<string>,
  read = createTrajectoryApi(codexHome),
  requestSignal?: AbortSignal,
) {
  const server = new Server({ name: 'local-trajectory-viewer', version: '1.0.0' }, {
    capabilities: { tools: {}, resources: {} },
  });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
  server.setRequestHandler(ListResourcesRequestSchema, () => ({ resources: [resource] }));
  server.setRequestHandler(ReadResourceRequestSchema, async ({ params }) => {
    if (params.uri !== MCP_UI_URI) throw new McpError(ErrorCode.InvalidParams, '找不到轨迹面板资源。');
    return { contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: await readHtml(),
      _meta: { ui: { prefersBorder: false } } }] };
  });
  server.setRequestHandler(CallToolRequestSchema, async ({ params }, { signal }) => {
    const { name, _meta } = params;
    const args = params.arguments ?? {};
    if (name === MCP_SHOW || name === MCP_OPEN || name === MCP_CONTEXT) {
      if (Object.keys(args).length) throw new McpError(ErrorCode.InvalidParams, '此工具不接受会话身份参数。');
      return panelContext(callingThread(_meta), name !== MCP_CONTEXT);
    }
    if (name === MCP_SETTINGS) {
      try {
        return panelData({ data: await accessSettings(codexHome, args) });
      } catch (error) {
        return panelData({ error: error instanceof RequestError ? error.message : '无法保存或读取查看器设置。' });
      }
    }
    if (name !== MCP_READ) throw new McpError(ErrorCode.InvalidParams, '未知工具。');
    const { path } = args;
    if (Object.keys(args).length !== 1 || typeof path !== 'string' || path.length > 8192
      || !/^\/api\/sessions(?:[/?]|$)/.test(path) || /[\\#\r\n]/.test(path)) {
      throw new McpError(ErrorCode.InvalidParams, '只支持查看器的本地读取路径。');
    }
    try {
      const readSignal = requestSignal ? AbortSignal.any([signal, requestSignal]) : signal;
      return panelData({ data: await read(new URL(path, 'http://trajectory.invalid'), readSignal) });
    } catch (error) {
      return panelData({ error: error instanceof RequestError ? error.message : '无法读取本地会话，请重试。' });
    }
  });
  return server;
}
