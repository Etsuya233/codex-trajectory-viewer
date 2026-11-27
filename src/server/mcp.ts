import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpBridge } from './mcp-bridge.ts';

const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
const html = new URL('./viewer.html', import.meta.url);
await createMcpBridge(codexHome, () => readFile(html, 'utf8')).connect(new StdioServerTransport());
