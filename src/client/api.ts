export function sessionUrl(id: string) {
  return '/api/sessions/' + encodeURIComponent(id);
}

export function queryUrl(path: string, values: Record<string, string | number | undefined>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined) query.set(key, String(value));
  return path + '?' + query;
}

export async function request<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? '无法加载本地轨迹。');
  return body;
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '无法读取记录。';
}
