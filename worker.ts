import {
  onRequest,
  storeIncomingCloudflareEmail,
  type CloudflareKvNamespace,
} from './functions/api/[[path]]';

interface AssetFetcher {
  fetch(request: Request): Promise<Response>;
}

interface ForwardableEmailMessage {
  readonly from: string;
  readonly to: string;
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize?: number;
}

export interface WorkerEnv {
  ASSETS?: AssetFetcher;
  MAILBOX_SESSION_SECRET?: string;
  MAILBOX_KV?: CloudflareKvNamespace;
  CUSTOM_DOMAINS?: string;
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

  async email(message: ForwardableEmailMessage, env: WorkerEnv): Promise<void> {
    if (!env.MAILBOX_KV) return;
    const rawEmail = await new Response(message.raw).text();
    await storeIncomingCloudflareEmail(env, rawEmail, message.from, message.to);
  },
};
