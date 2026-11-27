import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { RequestError } from './session.ts';
import { createTrajectoryApi } from './api.ts';

const port = Number(process.env.TRAJECTORY_PORT ?? 4380);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid TRAJECTORY_PORT');
const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
const readTrajectory = createTrajectoryApi(codexHome);
const staticRoot = new URL('../../dist/viewer/', import.meta.url);
const assetRoute = /^\/assets\/[a-zA-Z0-9_.-]+\.(js|css)$/;
const csp = "default-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

const server = createServer(async (req, res) => {
  const lifetime = new AbortController();
  res.once('close', () => lifetime.abort());
  res.setHeader('Content-Security-Policy', csp);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  const sendJson = (status: number, body: unknown) => {
    if (res.destroyed) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  try {
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) {
      throw new RequestError(403, '请从本机地址打开。');
    }
    if (req.method !== 'GET') throw new RequestError(405, '此服务只接受 GET。');
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (url.pathname.startsWith('/api/')) return sendJson(200, await readTrajectory(url, lifetime.signal));
    const asset = url.pathname.match(assetRoute);
    if (url.pathname !== '/' && !asset) throw new RequestError(404, '找不到该页面。');
    const type = asset?.[1] === 'js' ? 'text/javascript' : asset ? 'text/css' : 'text/html';
    const body = await readFile(new URL(asset ? url.pathname.slice(1) : 'index.html', staticRoot)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') throw new RequestError(404, asset ? '找不到该文件。' : '请先运行 npm run build。');
      throw error;
    });
    res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
    res.end(body);
  } catch (error) {
    if (lifetime.signal.aborted) return;
    if (error instanceof RequestError) {
      sendJson(error.status, { error: error.message });
    } else {
      const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
      console.error('Unable to read local trajectory:', code);
      sendJson(500, { error: '无法读取本地会话，请检查日志是否可访问后重试。' });
    }
  }
});

server.listen(port, '127.0.0.1', () => console.log(`Codex 轨迹 http://127.0.0.1:${port}`));
