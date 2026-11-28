import { isDetailField } from '../model.ts';
import { detailSourceLimit, RequestError } from './session.ts';
import { IndexStore } from './index.ts';
import { SessionCatalog } from './catalog.ts';

const sessionRoute = /^\/api\/sessions\/([^/]+)(?:\/(detail|updates|search|stats|agents|meta))?$/;

function requiredInteger(search: URLSearchParams, key: string, minimum: number, maximum: number) {
  const raw = search.get(key);
  const value = Number(raw);
  if (raw === null || !/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RequestError(400, '请求参数无效。');
  }
  return value;
}

function optionalOffset(search: URLSearchParams, key: string) {
  return search.has(key) ? requiredInteger(search, key, 0, Number.MAX_SAFE_INTEGER) : undefined;
}

export function createTrajectoryApi(codexHome: string) {
  const store = new IndexStore(codexHome);
  const catalog = new SessionCatalog(codexHome);
  return async (url: URL, signal?: AbortSignal): Promise<unknown> => {
    const search = url.searchParams;
    if (url.pathname === '/api/sessions') return catalog.sessions(search.get('q') ?? '');
    const route = url.pathname.match(sessionRoute);
    if (!route) throw new RequestError(404, '找不到该接口。');

    const [, id, endpoint] = route;
    if (endpoint === 'meta') return catalog.meta(id);
    if (endpoint === 'detail') {
      const offset = requiredInteger(search, 'offset', 0, Number.MAX_SAFE_INTEGER);
      const length = requiredInteger(search, 'length', 1, detailSourceLimit);
      const from = requiredInteger(search, 'from', 0, Number.MAX_SAFE_INTEGER);
      const digest = search.get('digest');
      const field = search.get('field');
      if (digest === null || !/^[a-f0-9]{64}$/.test(digest) || !isDetailField(field)) {
        throw new RequestError(400, '详情请求参数无效。');
      }
      return store.detail(id, { offset, length, digest }, field, from);
    }

    const before = optionalOffset(search, 'before');
    const around = optionalOffset(search, 'around');
    const after = optionalOffset(search, 'after');
    if (!endpoint && before === undefined && around === undefined && after === undefined) return store.recent(id);

    const index = await store.indexed(id);
    const generation = search.get('generation');
    if (endpoint !== 'updates' && generation && generation !== index.generation) {
      throw new RequestError(409, '日志已替换，请刷新会话。');
    }
    if (!endpoint) {
      const limit = search.has('limit') ? requiredInteger(search, 'limit', 1, 250) : undefined;
      return index.page(before, around, after, limit);
    }
    if (endpoint === 'stats') return index.statistics();
    if (endpoint === 'agents') return catalog.resolveAgents(index.agentLinks());
    if (endpoint === 'updates') {
      const revision = requiredInteger(search, 'revision', 0, Number.MAX_SAFE_INTEGER);
      return index.delta(generation ?? '', revision, optionalOffset(search, 'lower') ?? 0, optionalOffset(search, 'upper'));
    }
    const term = (search.get('q') ?? '').trim().slice(0, 500);
    const tool = (search.get('tool') ?? '').trim().slice(0, 100);
    return index.search(term, tool, search.get('errors') === '1', before, signal);
  };
}
