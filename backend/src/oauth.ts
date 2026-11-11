/**
 * OAuth for the MCP endpoint, so apps that cannot send a fixed bearer token
 * (the Claude web/desktop/mobile connector) can still connect.
 *
 * Single-user: "signing in" means typing the one password in
 * MCP_OAUTH_PASSWORD. Everything issued here (client ids, authorization
 * codes, access and refresh tokens) is a signed, self-describing string, so
 * nothing has to survive a Render restart and Redis is not involved.
 * Changing the password invalidates every token and client at once.
 */
import express, { type Express, type Request, type Response } from 'express';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import { InvalidGrantError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

const ACCESS_TTL = 60 * 60;                 // 1 hour
const REFRESH_TTL = 180 * 24 * 60 * 60;     // 180 days, renewed on every refresh
const CODE_TTL = 5 * 60;                    // 5 minutes
const LOGIN_TTL = 15 * 60;                  // how long the sign-in page stays valid
const MAX_FAILED_LOGINS = 10;               // per LOGIN_WINDOW_MS, across all visitors
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

const now = () => Math.floor(Date.now() / 1000);
const sha256 = (value: string) => createHash('sha256').update(value).digest();
const b64 = (value: Buffer | string) => Buffer.from(value).toString('base64url');

type Sealed = { t: 'client' | 'login' | 'code' | 'access' | 'refresh'; exp?: number } & Record<string, unknown>;

export interface McpOAuth {
  /** URL advertised in WWW-Authenticate so clients can discover the sign-in flow. */
  resourceMetadataUrl: string;
  /** True when the string is an unexpired access token issued by this server. */
  verifyAccessToken: (token: string) => boolean;
}

/** Public origin of this backend. Render sets RENDER_EXTERNAL_URL itself. */
function publicBaseUrl(): URL {
  const raw = process.env.MCP_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
  return new URL(raw.replace(/\/+$/, '') + '/');
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

function loginPage(opts: { clientName: string; returnHost: string; login: string; error?: string }): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Connect to OpenMemory</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 16px/1.5 system-ui, sans-serif; background: #f4f4f1; color: #1c1c1a; }
  main { width: min(360px, calc(100vw - 32px)); padding: 28px; border-radius: 16px; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.08), 0 12px 32px rgba(0,0,0,.06); box-sizing: border-box; }
  h1 { margin: 0 0 6px; font-size: 20px; }
  p { margin: 0 0 18px; color: #5c5c57; font-size: 14px; }
  label { display: block; font-size: 13px; margin-bottom: 6px; }
  input { width: 100%; box-sizing: border-box; padding: 10px 12px; font: inherit; border: 1px solid #c9c9c3; border-radius: 10px; background: transparent; color: inherit; }
  button { width: 100%; margin-top: 14px; padding: 10px 12px; font: inherit; font-weight: 600; border: 0; border-radius: 10px; background: #1c1c1a; color: #fff; cursor: pointer; }
  .error { color: #b3261e; font-size: 14px; margin: 0 0 12px; }
  @media (prefers-color-scheme: dark) {
    body { background: #141413; color: #ecece8; } main { background: #1f1f1d; box-shadow: none; }
    p { color: #a3a39c; } input { border-color: #45453f; } button { background: #ecece8; color: #141413; } .error { color: #ff8a80; }
  }
</style></head>
<body><main>
  <h1>Connect to OpenMemory</h1>
  <p><strong>${escapeHtml(opts.clientName)}</strong> wants to read your saved inspirations. After signing in you will be sent back to <strong>${escapeHtml(opts.returnHost)}</strong>.</p>
  ${opts.error ? `<p class="error" role="alert">${escapeHtml(opts.error)}</p>` : ''}
  <form method="post" action="/oauth/login">
    <input type="hidden" name="login" value="${escapeHtml(opts.login)}">
    <label for="password">OpenMemory password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
    <button type="submit">Connect</button>
  </form>
</main></body></html>`;
}

/**
 * Mounts the OAuth endpoints (/authorize, /token, /register, /oauth/login and
 * the two /.well-known documents). Returns null — leaving the MCP endpoint on
 * static-token auth only — while MCP_OAUTH_PASSWORD is unset.
 */
export function mountMcpOAuth(app: Express): McpOAuth | null {
  const password = process.env.MCP_OAUTH_PASSWORD;
  if (!password) return null;

  const baseUrl = publicBaseUrl();
  const resourceUrl = new URL('mcp', baseUrl);
  // Tied to the password (and static token) so rotating either revokes everything.
  const key = sha256(`openmemory-mcp-oauth|${password}|${process.env.MCP_AUTH_TOKEN ?? ''}`);

  const sign = (body: string) => b64(createHmac('sha256', key).update(body).digest());
  const seal = (payload: Sealed) => { const body = b64(JSON.stringify(payload)); return `${body}.${sign(body)}`; };
  const unseal = (value: string, type: Sealed['t']): Sealed | null => {
    const [body, mac, extra] = value.split('.');
    if (!body || !mac || extra !== undefined) return null;
    const expected = Buffer.from(sign(body)), supplied = Buffer.from(mac);
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as Sealed;
      if (payload.t !== type) return null;
      if (payload.exp !== undefined && payload.exp < now()) return null;
      return payload;
    } catch { return null; }
  };

  const CLIENT_PREFIX = 'omc_';
  const clientSecret = (clientId: string) => createHmac('sha256', key).update(`client-secret|${clientId}`).digest('hex');
  const clientTag = (clientId: string) => b64(sha256(clientId)).slice(0, 22);

  // A client id carries its own registration, signed by us.
  const clientsStore: OAuthRegisteredClientsStore = {
    getClient(clientId) {
      if (!clientId.startsWith(CLIENT_PREFIX)) return undefined;
      const data = unseal(clientId.slice(CLIENT_PREFIX.length), 'client');
      if (!data) return undefined;
      const isPublic = data.m === 'none';
      return {
        client_id: clientId,
        client_id_issued_at: data.iat as number,
        redirect_uris: data.r as string[],
        client_name: data.n as string | undefined,
        token_endpoint_auth_method: isPublic ? 'none' : 'client_secret_post',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        ...(isPublic ? {} : { client_secret: clientSecret(clientId), client_secret_expires_at: 0 }),
      };
    },
    registerClient(client) {
      const isPublic = client.token_endpoint_auth_method === 'none';
      const clientId = CLIENT_PREFIX + seal({
        t: 'client', iat: now(), r: client.redirect_uris,
        n: client.client_name?.slice(0, 80), m: isPublic ? 'none' : 'secret',
      });
      return clientsStore.getClient(clientId) as OAuthClientInformationFull;
    },
  };

  const issueTokens = (client: OAuthClientInformationFull): OAuthTokens => ({
    access_token: seal({ t: 'access', c: clientTag(client.client_id), exp: now() + ACCESS_TTL }),
    token_type: 'bearer',
    expires_in: ACCESS_TTL,
    refresh_token: seal({ t: 'refresh', c: clientTag(client.client_id), exp: now() + REFRESH_TTL }),
  });

  // Best-effort single use: a code cannot be redeemed twice by this process.
  // PKCE already stops anyone but the original client from redeeming it at all.
  const usedCodes = new Map<string, number>();
  const readCode = (client: OAuthClientInformationFull, code: string) => {
    const data = unseal(code, 'code');
    if (!data || data.c !== clientTag(client.client_id)) throw new InvalidGrantError('Invalid or expired authorization code');
    return data;
  };

  const provider: OAuthServerProvider = {
    get clientsStore() { return clientsStore; },

    async authorize(client, params: AuthorizationParams, res) {
      const login = seal({
        t: 'login', exp: now() + LOGIN_TTL, id: client.client_id,
        ru: params.redirectUri, cc: params.codeChallenge, s: params.state,
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('X-Frame-Options', 'DENY');
      res.send(loginPage({ clientName: client.client_name || 'An app', returnHost: new URL(params.redirectUri).host, login }));
    },

    async challengeForAuthorizationCode(client, code) {
      return readCode(client, code).cc as string;
    },

    async exchangeAuthorizationCode(client, code, _verifier, redirectUri) {
      const data = readCode(client, code);
      if (redirectUri !== undefined && redirectUri !== data.ru) throw new InvalidGrantError('redirect_uri does not match the authorization request');
      const id = data.j as string;
      if (usedCodes.has(id)) throw new InvalidGrantError('Authorization code was already used');
      for (const [used, exp] of usedCodes) if (exp < now()) usedCodes.delete(used);
      usedCodes.set(id, data.exp as number);
      return issueTokens(client);
    },

    async exchangeRefreshToken(client, refreshToken) {
      const data = unseal(refreshToken, 'refresh');
      if (!data || data.c !== clientTag(client.client_id)) throw new InvalidGrantError('Invalid or expired refresh token');
      return issueTokens(client);
    },

    async verifyAccessToken(token) {
      const data = unseal(token, 'access');
      if (!data) throw new InvalidGrantError('Invalid or expired access token');
      return { token, clientId: data.c as string, scopes: [], expiresAt: data.exp };
    },
  };

  // The SDK's own rate limiters key on client IP, which behind Render's proxy
  // is the proxy. These endpoints only mint signed strings, so the one thing
  // worth throttling is password guessing, handled below.
  app.use(mcpAuthRouter({
    provider,
    issuerUrl: baseUrl,
    resourceServerUrl: resourceUrl,
    resourceName: 'OpenMemory',
    authorizationOptions: { rateLimit: false },
    tokenOptions: { rateLimit: false },
    clientRegistrationOptions: { rateLimit: false, clientIdGeneration: false, clientSecretExpirySeconds: 0 },
  }));

  let failedLogins: number[] = [];
  const passwordDigest = sha256(password);

  app.post('/oauth/login', express.urlencoded({ extended: false, limit: '16kb' }), (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Frame-Options', 'DENY');
    const body = req.body as { login?: unknown; password?: unknown };
    const loginToken = typeof body.login === 'string' ? body.login : '';
    const login = unseal(loginToken, 'login');
    const client = login ? clientsStore.getClient(login.id as string) as OAuthClientInformationFull | undefined : undefined;
    if (!login || !client) {
      return res.status(400).type('html').send('<p>This sign-in page has expired. Go back to the app and connect again.</p>');
    }
    const page = (error: string, status: number) => res.status(status).type('html').send(loginPage({
      clientName: client.client_name || 'An app', returnHost: new URL(login.ru as string).host, login: loginToken, error,
    }));

    failedLogins = failedLogins.filter(at => at > Date.now() - LOGIN_WINDOW_MS);
    if (failedLogins.length >= MAX_FAILED_LOGINS) return page('Too many wrong passwords. Wait 15 minutes and try again.', 429);

    const supplied = typeof body.password === 'string' ? body.password : '';
    if (!timingSafeEqual(sha256(supplied), passwordDigest)) {
      failedLogins.push(Date.now());
      return page('Wrong password.', 401);
    }

    const target = new URL(login.ru as string);
    target.searchParams.set('code', seal({
      t: 'code', exp: now() + CODE_TTL, c: clientTag(client.client_id),
      ru: login.ru, cc: login.cc, j: randomBytes(12).toString('base64url'),
    }));
    if (typeof login.s === 'string') target.searchParams.set('state', login.s);
    res.redirect(302, target.href);
  });

  console.log(`[MCP] OAuth sign-in enabled (issuer ${baseUrl.href})`);
  return {
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl),
    verifyAccessToken: token => unseal(token, 'access') !== null,
  };
}
