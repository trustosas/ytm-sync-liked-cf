import { syncFromLikedMusic } from "./sync";

export interface Env {
  YT_COOKIE: string; // secret: full Cookie header from a logged-in music.youtube.com request
  TARGET_PLAYLIST_ID: string; // var, set in wrangler.toml (or as a secret if you'd rather not commit it)
  RUN_TOKEN?: string; // optional secret: required as ?token= on manual HTTP runs
}

async function runSync(env: Env): Promise<Response> {
  try {
    const log = await syncFromLikedMusic(env.YT_COOKIE, env.TARGET_PLAYLIST_ID);
    console.log(log.join("\n"));
    return new Response(log.join("\n") + "\n", { status: 200 });
  } catch (e: any) {
    console.error(e);
    return new Response(`Sync failed: ${e?.message ?? e}\n`, { status: 500 });
  }
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runSync(env));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/run") {
      return new Response("OK. POST /run?token=... to trigger a sync manually.\n", { status: 200 });
    }
    if (env.RUN_TOKEN && url.searchParams.get("token") !== env.RUN_TOKEN) {
      return new Response("Unauthorized\n", { status: 401 });
    }
    return runSync(env);
  },
};
