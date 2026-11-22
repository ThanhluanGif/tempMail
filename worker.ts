import { onRequest } from './functions/api/[[path]]';

interface AssetFetcher {
  fetch(request: Request): Promise<Response>;
}

export interface WorkerEnv {
  ASSETS?: AssetFetcher;
  MAILBOX_SESSION_SECRET?: string;
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return onRequest({
        request,
        env,
        params: {},
      });
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not Found', { status: 404 });
  },
};
