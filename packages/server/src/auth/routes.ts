import { AppError, upsertGithubUser } from "@agent-town/core";
import { GithubDeviceInput, type AuthConfig } from "@agent-town/schema";
import type { FastifyInstance } from "fastify";
import { parse } from "../context.ts";
import type { AuthSettings } from "./config.ts";
import { authorizeUrl, exchangeCode, fetchGithubUser } from "./github.ts";
import { checkState, clearSessionCookie, clearStateCookie, newState, sessionCookie } from "./session.ts";

/**
 * Sign-in routes. `GET /api/auth/config`; web: `GET /auth/github` → GitHub → `GET /auth/github/callback` (sets the
 * session cookie) and `POST /auth/logout`; CLI device flow: `POST /api/auth/github/device { accessToken }` → town token.
 */
export function authRoutes(settings: AuthSettings) {
  return async function (app: FastifyInstance) {
    const world = app.world;
    const s = settings;
    const configured = () => {
      if (!s.githubClientId) throw new AppError("not_found", "GitHub login is not configured on this server (set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET).");
    };

    app.get("/api/auth/config", async (): Promise<AuthConfig> => ({ githubClientId: s.githubClientId, publicUrl: s.publicUrl }));

    app.get("/auth/github", async (_req, reply) => {
      configured();
      const { state, setCookie } = newState(s);
      return reply.header("set-cookie", setCookie).redirect(authorizeUrl(s, state));
    });

    app.get("/auth/github/callback", async (req, reply) => {
      configured();
      const q = req.query as { code?: string; state?: string; error?: string; error_description?: string };
      const fail = (msg: string) => reply.header("set-cookie", clearStateCookie(s)).redirect(`/?auth_error=${encodeURIComponent(msg)}`);
      if (q.error) return fail(q.error_description ?? q.error);
      if (!q.code || !checkState(s, req, q.state)) return fail("Sign-in expired or was started elsewhere. Try again.");
      let user;
      try {
        const gh = await fetchGithubUser(s, await exchangeCode(s, q.code));
        user = upsertGithubUser(world, gh, { admins: s.admins }).user;
      } catch (e) {
        return fail((e as Error).message);
      }
      world.ops.ensureAvatar(user.id);
      return reply.header("set-cookie", [clearStateCookie(s), sessionCookie(s, user.id)]).redirect("/");
    });

    app.post("/auth/logout", async (_req, reply) => reply.header("set-cookie", clearSessionCookie(s)).send({ ok: true }));

    app.post("/api/auth/github/device", async (req) => {
      configured();
      const { accessToken } = parse(GithubDeviceInput, req.body);
      const gh = await fetchGithubUser(s, accessToken);
      const { user } = upsertGithubUser(world, gh, { admins: s.admins });
      world.ops.ensureAvatar(user.id);
      return { token: world.tokens.create("user", user.id), user };
    });
  };
}
