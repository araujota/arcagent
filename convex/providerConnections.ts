import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { getCurrentUser, requireAuth } from "./lib/utils";
import { decryptSecret, encryptSecret } from "./lib/secretCrypto";
import { constantTimeEqual } from "./lib/constantTimeEqual";

const providerValidator = v.union(v.literal("gitlab"), v.literal("bitbucket"));
type OAuthProvider = "gitlab" | "bitbucket";

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be configured`);
  return value;
}

function getClientConfig(provider: OAuthProvider): { clientId: string; clientSecret: string } {
  if (provider === "gitlab") {
    return {
      clientId: env("GITLAB_CLIENT_ID"),
      clientSecret: env("GITLAB_CLIENT_SECRET"),
    };
  }

  return {
    clientId: env("BITBUCKET_CLIENT_ID"),
    clientSecret: env("BITBUCKET_CLIENT_SECRET"),
  };
}

function getAppBaseUrl(): string {
  const appUrl = process.env.APP_BASE_URL?.trim() || process.env.APP_URL?.trim();
  if (!appUrl) throw new Error("APP_BASE_URL (or APP_URL) must be configured for OAuth callbacks");
  return appUrl.replace(/\/$/, "");
}

function getRedirectUri(provider: OAuthProvider): string {
  return `${getAppBaseUrl()}/oauth/${provider}/callback`;
}

async function requireActionUser(ctx: {
  auth: { getUserIdentity: () => Promise<{ subject: string } | null> };
  runQuery: <T>(ref: unknown, args: unknown) => Promise<T>;
}): Promise<{ _id: unknown }> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Authentication required");

  const user = await ctx.runQuery(internal.users.getByClerkIdInternal, {
    clerkId: identity.subject,
  });
  if (!user) throw new Error("Authenticated user not found");
  return user as { _id: unknown };
}

function toUrlSafeBase64(input: string): string {
  return btoa(input).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromUrlSafeBase64(input: string): string {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return atob(normalized + pad);
}

function toForm(params: Record<string, string | undefined>): string {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") body.set(key, value);
  }
  return body.toString();
}

async function signOAuthState(payload: string): Promise<string> {
  const secret = env("OAUTH_STATE_SIGNING_KEY");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return toUrlSafeBase64(String.fromCharCode(...new Uint8Array(signature)));
}

async function buildState(args: {
  userId: string;
  provider: OAuthProvider;
  returnTo?: string;
}): Promise<string> {
  const payload = JSON.stringify({
    userId: args.userId,
    provider: args.provider,
    returnTo: args.returnTo,
    exp: Date.now() + 10 * 60 * 1000,
  });
  const payloadB64 = toUrlSafeBase64(payload);
  const sig = await signOAuthState(payloadB64);
  return `${payloadB64}.${sig}`;
}

async function parseAndVerifyState(state: string): Promise<{
  userId: string;
  provider: OAuthProvider;
  returnTo?: string;
}> {
  const [payloadB64, providedSig] = state.split(".");
  if (!payloadB64 || !providedSig) throw new Error("Invalid OAuth state");

  const expectedSig = await signOAuthState(payloadB64);
  if (!constantTimeEqual(providedSig, expectedSig)) {
    throw new Error("Invalid OAuth state signature");
  }

  const parsed = JSON.parse(fromUrlSafeBase64(payloadB64)) as {
    userId?: string;
    provider?: OAuthProvider;
    returnTo?: string;
    exp?: number;
  };

  if (!parsed.userId || !parsed.provider || typeof parsed.exp !== "number") {
    throw new Error("Invalid OAuth state payload");
  }
  if (Date.now() > parsed.exp) {
    throw new Error("OAuth state has expired");
  }

  return {
    userId: parsed.userId,
    provider: parsed.provider,
    returnTo: parsed.returnTo,
  };
}

async function fetchProviderProfile(provider: OAuthProvider, accessToken: string): Promise<{
  accountId?: string;
  accountName?: string;
}> {
  if (provider === "gitlab") {
    const response = await fetch("https://gitlab.com/api/v4/user", {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    if (!response.ok) return {};

    const user = (await response.json()) as { id?: number; username?: string; name?: string };
    return {
      accountId: user.id ? String(user.id) : undefined,
      accountName: user.username ?? user.name,
    };
  }

  const response = await fetch("https://api.bitbucket.org/2.0/user", {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!response.ok) return {};

  const user = (await response.json()) as { account_id?: string; username?: string; nickname?: string };
  return {
    accountId: user.account_id,
    accountName: user.nickname ?? user.username,
  };
}

async function exchangeCodeForToken(provider: OAuthProvider, code: string): Promise<{
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenType?: string;
  scope?: string;
}> {
  const { clientId, clientSecret } = getClientConfig(provider);
  const redirectUri = getRedirectUri(provider);

  if (provider === "gitlab") {
    const response = await fetch("https://gitlab.com/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: toForm({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),
    });

    if (!response.ok) {
      const payload = await response.text().catch(() => "");
      throw new Error(`GitLab OAuth token exchange failed (${response.status}): ${payload.slice(0, 240)}`);
    }

    const payload = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      token_type?: string;
      scope?: string;
    };

    if (!payload.access_token) {
      throw new Error("GitLab OAuth response missing access_token");
    }

    return {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      expiresAt: payload.expires_in ? Date.now() + payload.expires_in * 1000 : undefined,
      tokenType: payload.token_type,
      scope: payload.scope,
    };
  }

  const response = await fetch("https://bitbucket.org/site/oauth2/access_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: toForm({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    const payload = await response.text().catch(() => "");
    throw new Error(`Bitbucket OAuth token exchange failed (${response.status}): ${payload.slice(0, 240)}`);
  }

  const payload = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    scopes?: string;
  };

  if (!payload.access_token) {
    throw new Error("Bitbucket OAuth response missing access_token");
  }

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: payload.expires_in ? Date.now() + payload.expires_in * 1000 : undefined,
    tokenType: payload.token_type,
    scope: payload.scopes,
  };
}

async function refreshOAuthToken(args: {
  provider: OAuthProvider;
  refreshToken: string;
}): Promise<{
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenType?: string;
  scope?: string;
}> {
  const { clientId, clientSecret } = getClientConfig(args.provider);

  if (args.provider === "gitlab") {
    const response = await fetch("https://gitlab.com/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: toForm({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: args.refreshToken,
        grant_type: "refresh_token",
      }),
    });

    if (!response.ok) {
      const payload = await response.text().catch(() => "");
      throw new Error(`GitLab OAuth refresh failed (${response.status}): ${payload.slice(0, 240)}`);
    }

    const payload = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      token_type?: string;
      scope?: string;
    };
    if (!payload.access_token) {
      throw new Error("GitLab OAuth refresh response missing access_token");
    }

    return {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      expiresAt: payload.expires_in ? Date.now() + payload.expires_in * 1000 : undefined,
      tokenType: payload.token_type,
      scope: payload.scope,
    };
  }

  const response = await fetch("https://bitbucket.org/site/oauth2/access_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: toForm({
      grant_type: "refresh_token",
      refresh_token: args.refreshToken,
    }),
  });

  if (!response.ok) {
    const payload = await response.text().catch(() => "");
    throw new Error(`Bitbucket OAuth refresh failed (${response.status}): ${payload.slice(0, 240)}`);
  }

  const payload = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    scopes?: string;
  };
  if (!payload.access_token) {
    throw new Error("Bitbucket OAuth refresh response missing access_token");
  }

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: payload.expires_in ? Date.now() + payload.expires_in * 1000 : undefined,
    tokenType: payload.token_type,
    scope: payload.scopes,
  };
}

export const getByIdInternal = internalQuery({
  args: {
    providerConnectionId: v.id("providerConnections"),
  },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.providerConnectionId);
  },
});

export const getActiveByUserAndProviderInternal = internalQuery({
  args: {
    userId: v.id("users"),
    provider: providerValidator,
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("providerConnections")
      .withIndex("by_userId_and_provider_and_status", (q) =>
        q.eq("userId", args.userId).eq("provider", args.provider).eq("status", "active"),
      )
      .first();
  },
});

export const getActiveAuthByUserAndProviderInternal = internalQuery({
  args: {
    userId: v.id("users"),
    provider: providerValidator,
  },
  handler: async (ctx, args) => {
    const connection = await ctx.db
      .query("providerConnections")
      .withIndex("by_userId_and_provider_and_status", (q) =>
        q.eq("userId", args.userId).eq("provider", args.provider).eq("status", "active"),
      )
      .first();

    if (!connection) return null;

    return {
      _id: connection._id,
      provider: connection.provider,
      accountId: connection.accountId,
      accountName: connection.accountName,
      accessToken: await decryptSecret(connection.accessTokenEncrypted),
      refreshToken: connection.refreshTokenEncrypted
        ? await decryptSecret(connection.refreshTokenEncrypted)
        : undefined,
      expiresAt: connection.expiresAt,
    };
  },
});

export const upsertFromOAuthInternal = internalMutation({
  args: {
    userId: v.id("users"),
    provider: providerValidator,
    accountId: v.optional(v.string()),
    accountName: v.optional(v.string()),
    accessTokenEncrypted: v.string(),
    refreshTokenEncrypted: v.optional(v.string()),
    tokenType: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
    scope: v.optional(v.string()),
    updatedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("providerConnections")
      .withIndex("by_userId_and_provider_and_status", (q) =>
        q.eq("userId", args.userId).eq("provider", args.provider).eq("status", "active"),
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        accountId: args.accountId,
        accountName: args.accountName,
        accessTokenEncrypted: args.accessTokenEncrypted,
        refreshTokenEncrypted: args.refreshTokenEncrypted,
        tokenType: args.tokenType,
        expiresAt: args.expiresAt,
        scope: args.scope,
        status: "active",
        updatedAt: args.updatedAt,
      });
      return existing._id;
    }

    return await ctx.db.insert("providerConnections", {
      userId: args.userId,
      provider: args.provider,
      accountId: args.accountId,
      accountName: args.accountName,
      accessTokenEncrypted: args.accessTokenEncrypted,
      refreshTokenEncrypted: args.refreshTokenEncrypted,
      tokenType: args.tokenType,
      expiresAt: args.expiresAt,
      scope: args.scope,
      status: "active",
      createdAt: args.updatedAt,
      updatedAt: args.updatedAt,
    });
  },
});

export const updateTokensInternal = internalMutation({
  args: {
    providerConnectionId: v.id("providerConnections"),
    accessTokenEncrypted: v.string(),
    refreshTokenEncrypted: v.optional(v.string()),
    tokenType: v.optional(v.string()),
    scope: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
    updatedAt: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.providerConnectionId, {
      accessTokenEncrypted: args.accessTokenEncrypted,
      refreshTokenEncrypted: args.refreshTokenEncrypted,
      tokenType: args.tokenType,
      scope: args.scope,
      expiresAt: args.expiresAt,
      status: "active",
      updatedAt: args.updatedAt,
    });
  },
});

export const startProviderOAuth = action({
  args: {
    provider: providerValidator,
    returnTo: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireActionUser(ctx);
    const provider = args.provider as OAuthProvider;
    const { clientId } = getClientConfig(provider);
    const redirectUri = getRedirectUri(provider);
    const state = await buildState({
      userId: String(user._id),
      provider,
      returnTo: args.returnTo,
    });

    const authorizeUrl =
      provider === "gitlab"
        ? `https://gitlab.com/oauth/authorize?${toForm({
            client_id: clientId,
            redirect_uri: redirectUri,
            response_type: "code",
            state,
            scope: "read_user read_repository write_repository api",
          })}`
        : `https://bitbucket.org/site/oauth2/authorize?${toForm({
            client_id: clientId,
            response_type: "code",
            state,
          })}`;

    return {
      provider,
      authorizeUrl,
      state,
      redirectUri,
    };
  },
});

export const completeProviderOAuth = action({
  args: {
    provider: providerValidator,
    code: v.string(),
    state: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await requireActionUser(ctx);
    const provider = args.provider as OAuthProvider;
    const state = await parseAndVerifyState(args.state);

    if (state.provider !== provider) {
      throw new Error("OAuth state provider mismatch");
    }
    if (state.userId !== String(user._id)) {
      throw new Error("OAuth state user mismatch");
    }

    const token = await exchangeCodeForToken(provider, args.code);
    const profile = await fetchProviderProfile(provider, token.accessToken);

    const connectionId = await ctx.runMutation(internal.providerConnections.upsertFromOAuthInternal, {
      userId: user._id as never,
      provider,
      accountId: profile.accountId,
      accountName: profile.accountName,
      accessTokenEncrypted: await encryptSecret(token.accessToken),
      refreshTokenEncrypted: token.refreshToken
        ? await encryptSecret(token.refreshToken)
        : undefined,
      tokenType: token.tokenType,
      expiresAt: token.expiresAt,
      scope: token.scope,
      updatedAt: Date.now(),
    });

    return {
      provider,
      connectionId,
      accountId: profile.accountId,
      accountName: profile.accountName,
      expiresAt: token.expiresAt,
      returnTo: state.returnTo,
    };
  },
});

export const disconnectProvider = mutation({
  args: {
    providerConnectionId: v.id("providerConnections"),
  },
  handler: async (ctx, args) => {
    const user = requireAuth(await getCurrentUser(ctx));
    const connection = await ctx.db.get(args.providerConnectionId);
    if (!connection) throw new Error("Provider connection not found");
    if (connection.userId !== user._id) throw new Error("Unauthorized");

    await ctx.db.patch(connection._id, {
      status: "revoked",
      updatedAt: Date.now(),
    });

    return { success: true };
  },
});

export const refreshProviderToken = action({
  args: {
    providerConnectionId: v.id("providerConnections"),
  },
  handler: async (ctx, args) => {
    const user = await requireActionUser(ctx);
    const connection = await ctx.runQuery(internal.providerConnections.getByIdInternal, {
      providerConnectionId: args.providerConnectionId,
    });
    if (!connection) throw new Error("Provider connection not found");
    if (connection.userId !== user._id) throw new Error("Unauthorized");
    if (!connection.refreshTokenEncrypted) {
      throw new Error("Provider connection does not include a refresh token");
    }

    const refreshToken = await decryptSecret(connection.refreshTokenEncrypted);
    const token = await refreshOAuthToken({
      provider: connection.provider as OAuthProvider,
      refreshToken,
    });

    await ctx.runMutation(internal.providerConnections.updateTokensInternal, {
      providerConnectionId: connection._id,
      accessTokenEncrypted: await encryptSecret(token.accessToken),
      refreshTokenEncrypted: token.refreshToken
        ? await encryptSecret(token.refreshToken)
        : connection.refreshTokenEncrypted,
      tokenType: token.tokenType,
      scope: token.scope,
      expiresAt: token.expiresAt,
      updatedAt: Date.now(),
    });

    return {
      providerConnectionId: connection._id,
      provider: connection.provider,
      expiresAt: token.expiresAt,
    };
  },
});

export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];

    const records = await ctx.db
      .query("providerConnections")
      .withIndex("by_userId", (q) => q.eq("userId", user._id))
      .collect();

    return records.map((record) => ({
      _id: record._id,
      provider: record.provider,
      accountId: record.accountId,
      accountName: record.accountName,
      domain: record.domain,
      tokenType: record.tokenType,
      expiresAt: record.expiresAt,
      scope: record.scope,
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }));
  },
});
