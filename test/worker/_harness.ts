// Minimal harness to drive the Hono worker (src/index.ts) in a Node test without
// the Workers runtime. Provides a stub env (DB no-ops, used only by route
// logging), an execution context, and an in-memory Cache API for /api/search.
import { vi } from 'vitest';

export const urlOf = (input: any) => (typeof input === 'string' ? input : input.url);

export const jsonResponse = (obj: any, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

// D1 stub: prepare().bind().run() chain that resolves to nothing.
const stmt = { bind: () => stmt, run: async () => ({}), first: async () => null, all: async () => ({ results: [] }) };
export const testEnv: any = {
  DB: { prepare: () => stmt },
  ASSETS: { fetch: async () => new Response('asset', { status: 200 }) },
  OWN_API_KEY: 'test',
};

export function testCtx() {
  return {
    waitUntil(p: Promise<any>) { if (p && typeof (p as any).catch === 'function') (p as any).catch(() => {}); },
    passThroughOnException() {},
  } as unknown as ExecutionContext;
}

// A tiny Cache API backed by a Map keyed on request URL, installed as the global
// `caches` so the /api/search edge-cache path works under Node.
export function installCache() {
  const store = new Map<string, Response>();
  vi.stubGlobal('caches', {
    default: {
      async match(req: Request | string) { const r = store.get(urlOf(req)); return r ? r.clone() : undefined; },
      async put(req: Request | string, res: Response) { store.set(urlOf(req), res.clone()); },
    },
  });
  return store;
}
