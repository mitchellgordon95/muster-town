import { AppError, upsertGithubUser } from "@muster-town/core";
import { GithubDeviceInput, type AuthConfig } from "@muster-town/schema";
import type { FastifyInstance } from "fastify";
import { parse, WEB_BASE } from "../context.ts";
import type { AuthSettings } from "./config.ts";
import { authorizeUrl, exchangeCode, fetchGithubUser } from "./github.ts";
import { checkState, clearSessionCookie, clearStateCookie, newState, safeReturnTo, sessionAuth, sessionCookie } from "./session.ts";

/**
 * Sign-in routes. One sign-in for the whole host (docs/hosted-collectives.md step 2): a hosted collective's
 * `/<slug>/auth/github` hands off to the root's flow with `?return_to=/<slug>/`, and the callback lands there.
 * `GET /api/auth/config`; web: `GET /auth/github` → GitHub → `GET /auth/github/callback` (sets the
 * session cookie) and `POST /auth/logout`; CLI device flow: `POST /api/auth/github/device { accessToken }` → town token.
 */
export function authRoutes(settings: AuthSettings) {
  return async function (app: FastifyInstance) {
    const world = app.world;
    const s = settings;
    const configured = () => {
      if (!s.githubClientId) throw new AppError("not_found", "GitHub login is not configured on this server (set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET).");
    };

    app.get("/api/auth/config", async (req): Promise<AuthConfig> => ({ githubClientId: s.githubClientId, publicUrl: s.publicUrl, dev: app.dev, session: !!sessionAuth(world, s, req) }));

    // a return-to names a hosted collective of this hub (or the Workshop's own client): never another host
    const returnTo = (raw: unknown) => safeReturnTo(raw, (slug) => `/${slug}/` === WEB_BASE || app.hub?.get(slug)?.state === "active");

    app.get("/auth/github", async (req, reply) => {
      configured();
      if (s.hosted) return reply.redirect(`/auth/github?return_to=${encodeURIComponent(`/${s.hosted.slug}/`)}`);
      const { state, setCookie } = newState(s, returnTo((req.query as { return_to?: unknown }).return_to));
      return reply.header("set-cookie", setCookie).redirect(authorizeUrl(s, state));
    });

    app.get("/auth/github/callback", async (req, reply) => {
      configured();
      if (s.hosted) throw new AppError("not_found", "Sign-in comes back to the root: /auth/github/callback.");
      const q = req.query as { code?: string; state?: string; error?: string; error_description?: string };
      const checked = checkState(s, req, q.state);
      const back = (checked && checked.returnTo && returnTo(checked.returnTo)) || WEB_BASE;
      const fail = (msg: string) => reply.header("set-cookie", clearStateCookie(s)).redirect(`${back.split(/[?#]/)[0]}?auth_error=${encodeURIComponent(msg)}`);
      if (q.error) return fail(q.error_description ?? q.error);
      if (!q.code || !checked) return fail("Sign-in expired or was started elsewhere. Try again.");
      let user, gh;
      try {
        gh = await fetchGithubUser(s, await exchangeCode(s, q.code));
        user = upsertGithubUser(world, gh, { admins: s.admins }).user;
      } catch (e) {
        return fail((e as Error).message);
      }
      world.ops.ensureAvatar(user.id);
      return reply.header("set-cookie", [clearStateCookie(s), sessionCookie(s, user.id, Date.now(), gh)]).redirect(back);
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
