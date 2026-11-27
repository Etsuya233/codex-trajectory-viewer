import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHttpMcpServer, HTTP_MCP_HOST, HTTP_MCP_PORT, HTTP_MCP_TYPE } from './mcp-http.ts';
import { errorCode, getHttpMcpToken, writeHttpMcpConfig } from './mcp-http-state.ts';

const command = process.argv[2];
const rawPort = process.env.TRAJECTORY_HTTP_PORT ?? String(HTTP_MCP_PORT);
const port = Number(rawPort);
const stateDir = resolve(process.env.TRAJECTORY_HTTP_STATE_DIR || (process.platform === 'win32' && process.env.LOCALAPPDATA
  ? join(process.env.LOCALAPPDATA, 'CodexTrajectoryViewer') : join(homedir(), '.codex', 'trajectory-http')));
const endpoint = `http://${HTTP_MCP_HOST}:${port}`;

async function control(path: '/status' | '/stop', token: string) {
  const response = await fetch(endpoint + path, {
    method: path === '/status' ? 'GET' : 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
    redirect: 'error',
    signal: AbortSignal.timeout(2500),
  });
  if (!response.ok) throw new Error('Endpoint did not accept the control request');
  const result = await response.json() as { type?: string; pid?: number };
  if (result.type !== HTTP_MCP_TYPE) throw new Error('Endpoint is not a trajectory HTTP MCP server');
  return result;
}

async function run() {
  if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('TRAJECTORY_HTTP_PORT must be an integer from 1 to 65535');
  }
  switch (command) {
    case 'config': {
      const token = await getHttpMcpToken(stateDir, true);
      console.log(await writeHttpMcpConfig(stateDir, endpoint, token));
      break;
    }
    case 'start': {
      const token = await getHttpMcpToken(stateDir, true);
      const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
      const html = await readFile(new URL('./viewer.html', import.meta.url), 'utf8');
      const { server, stop } = createHttpMcpServer({ codexHome, token, readHtml: async () => html });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen({ host: HTTP_MCP_HOST, port, exclusive: true }, resolve);
      });
      process.once('SIGINT', () => { void stop(); });
      process.once('SIGTERM', () => { void stop(); });
      console.log(`Trajectory HTTP MCP listening at ${endpoint}/mcp (PID ${process.pid})`);
      break;
    }
    case 'status':
    case 'stop': {
      const token = await getHttpMcpToken(stateDir, false);
      const status = await control('/status', token);
      if (command === 'stop') {
        await control('/stop', token);
        console.log('Trajectory HTTP MCP stopping.');
      } else {
        console.log(`Trajectory HTTP MCP running at ${endpoint}/mcp (PID ${status.pid})`);
      }
      break;
    }
    default:
      throw new Error('Usage: node http-server.mjs start|status|stop|config');
  }
}

try {
  await run();
} catch (error) {
  const message = errorCode(error) === 'EADDRINUSE'
    ? `Port ${port} is already in use. Stop the current backend or choose a different TRAJECTORY_HTTP_PORT.`
    : error instanceof Error ? error.message : 'Unable to run trajectory HTTP MCP command';
  console.error(message);
  process.exitCode = 1;
}
