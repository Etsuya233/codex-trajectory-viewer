import { App as McpApp } from '@modelcontextprotocol/ext-apps';
import { useEffect, useState } from 'react';
import { MCP_CONTEXT, MCP_READ } from '../mcp-contract.ts';
import type { PanelContext, PanelResponse } from '../mcp-contract.ts';
import { App } from './App.tsx';
import { errorMessage, setPanelReader } from './api.ts';

interface Connection {
  context?: PanelContext;
  error?: string;
}

function isContext(value: unknown): value is PanelContext {
  if (!value || typeof value !== 'object') return false;
  const context = value as Partial<PanelContext>;
  return (context.mode === 'host-thread' && typeof context.sessionId === 'string'
    && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(context.sessionId))
    || (context.mode === 'choose-session' && (context.reason === 'missing' || context.reason === 'invalid'));
}

export function Panel() {
  const [state, setState] = useState<Connection>({});
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    const app = new McpApp({ name: 'Local Codex Trajectory', version: '1.0.0' }, {}, { autoResize: false });
    app.onteardown = async () => {
      abort.abort();
      return {};
    };
    const connect = async () => {
      await app.connect(undefined, { signal: abort.signal, timeout: 8_000 });
      const answer = await app.callServerTool({ name: MCP_CONTEXT, arguments: {} }, { signal: abort.signal, timeout: 8_000 });
      const context = answer._meta?.trajectoryContext;
      if (!isContext(context)) throw new Error('宿主未返回有效的轨迹连接状态。');
      if (abort.signal.aborted) return;
      setPanelReader(async (path, signal) => {
        const requestSignal = AbortSignal.any([signal, abort.signal]);
        requestSignal.throwIfAborted();
        const result = await app.callServerTool({ name: MCP_READ, arguments: { path } }, { signal: requestSignal, timeout: 30_000 });
        const response = result._meta?.trajectoryResponse as PanelResponse | undefined;
        if (!response || typeof response !== 'object') throw new Error('宿主未返回轨迹数据。');
        if ('error' in response) throw new Error(response.error);
        return response.data;
      });
      setState({ context });
    };
    void connect().catch(error => {
      if (!abort.signal.aborted) setState({ error: errorMessage(error) });
    });
    return () => {
      abort.abort();
      void app.close().catch(() => undefined);
    };
  }, [attempt]);

  if (state.context) return <App embedded hostSession={state.context.mode === 'host-thread' ? state.context.sessionId : undefined} />;
  return <main className="shell">
    <header className="session-bar"><h1>Codex 轨迹</h1></header>
    {state.error
      ? <div className="empty" role="alert">
          <p>{state.error} <button type="button" onClick={() => {
            setState({});
            setAttempt(current => current + 1);
          }}>重试连接</button></p>
          <p>也可以运行 <code>npm start</code> 后打开 <a href="http://127.0.0.1:4380/" target="_blank" rel="noreferrer">本地网页</a>。</p>
        </div>
      : <p className="empty" role="status">正在连接 Codex 面板…</p>}
  </main>;
}
