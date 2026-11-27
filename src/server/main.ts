import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DetailField } from '../model.ts';
import { detailSourceLimit, findSession, readDetail, readRecent, RequestError } from './session.ts';

const port = Number(process.env.TRAJECTORY_PORT ?? 4380);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid TRAJECTORY_PORT');
const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
const staticRoot = new URL('../../dist/', import.meta.url);
const sessionRoute = /^\/api\/sessions\/([^/]+)(\/detail)?$/;
const assetRoute = /^\/assets\/[a-zA-Z0-9_.-]+\.(js|css)$/;
const csp = "default-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

function requiredInteger(search: URLSearchParams, key: string, minimum: number, maximum: number) {
  const raw = search.get(key);
  const value = Number(raw);
  if (raw === null || !/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RequestError(400, '详情请求参数无效。');
  }
  return value;
}

const server = createServer(async (req, res) => {
  res.setHeader('Content-Security-Policy', csp);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  const sendJson = (status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  try {
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) {
      throw new RequestError(403, '请从本机地址打开。');
    }
    if (req.method !== 'GET') throw new RequestError(405, '此服务只接受 GET。');
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const route = url.pathname.match(sessionRoute);
    if (route) {
      const path = await findSession(codexHome, route[1]);
      if (!route[2]) return sendJson(200, await readRecent(path));
      const offset = requiredInteger(url.searchParams, 'offset', 0, Number.MAX_SAFE_INTEGER);
      const length = requiredInteger(url.searchParams, 'length', 1, detailSourceLimit);
      const from = requiredInteger(url.searchParams, 'from', 0, Number.MAX_SAFE_INTEGER);
      const digest = url.searchParams.get('digest');
      const field = url.searchParams.get('field') as DetailField | null;
      if (digest === null || !/^[a-f0-9]{64}$/.test(digest) || (field !== 'content' && field !== 'raw')) {
        throw new RequestError(400, '详情请求参数无效。');
      }
      return sendJson(200, await readDetail(path, { offset, length, digest }, field, from));
    }
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
