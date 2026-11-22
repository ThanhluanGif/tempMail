export interface ServerConfigInput {
  argv: string[];
  execArgv: string[];
  env: Record<string, string | undefined>;
  hasBuiltDist: boolean;
}

function parseValidPort(value: string | undefined): number | null {
  if (!value) return null;
  const num = Number(value);
  if (Number.isInteger(num) && num > 0 && num < 65536) {
    return num;
  }
  return null;
}

/**
 * Resolves the TCP port the Node/Express server must bind to:
 * 1. Explicit CLI flag `--port <N>` (or `--port=<N>`) always wins.
 * 2. When Nginx fronts the container (`NGINX_PORT` is set and equals `PORT`),
 *    avoid colliding with Nginx (EADDRINUSE) by binding to `DEFAULT_APP_PORT` (3000).
 * 3. Otherwise (including standalone Cloud Run where `PORT=8080` is injected
 *    without Nginx), bind directly to `PORT`.
 * 4. Fall back to `DEFAULT_APP_PORT` or `3000`.
 */
export function resolveServerPort(
  argv: string[],
  env: Record<string, string | undefined>
): number {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port' && argv[i + 1]) {
      const cliPort = parseValidPort(argv[i + 1]);
      if (cliPort !== null) return cliPort;
    } else if (arg.startsWith('--port=')) {
      const cliPort = parseValidPort(arg.slice('--port='.length));
      if (cliPort !== null) return cliPort;
    }
  }

  const envPort = parseValidPort(env.PORT);
  const nginxPort = parseValidPort(env.NGINX_PORT);
  const defaultAppPort = parseValidPort(env.DEFAULT_APP_PORT);

  if (nginxPort !== null && (envPort === null || envPort === nginxPort)) {
    return defaultAppPort ?? 3000;
  }

  if (envPort !== null) {
    return envPort;
  }

  return defaultAppPort ?? 3000;
}

/**
 * Determines whether the server should serve the prebuilt static `dist/` bundle
 * instead of booting Vite dev middleware.
 */
export function shouldServeStaticDist(input: ServerConfigInput): boolean {
  if (!input.hasBuiltDist) return false;
  if (input.env.NODE_ENV === 'production') return true;
  if (input.env.npm_lifecycle_event === 'start') return true;

  const isTsxRuntime = input.execArgv.some((arg) => arg.includes('tsx'));
  const isDevLifecycle = input.env.npm_lifecycle_event === 'dev';
  if (isDevLifecycle || isTsxRuntime) {
    return false;
  }

  return true;
}
