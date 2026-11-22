// djzs.ai Worker. The site is static assets (wrangler.toml [assets]); this script answers only what no asset answers.
// Today that is one route: /scan, which sends the visitor to the Scan Room at scan.djzs.ai.
//
// Until 2026-11-21 this route rendered its own page from scan.djzs.ai/feed.json. That made two front pages for one room:
// one here that could only be read, and one there where you sign in and post. There is one now, the room itself, and
// every "Scan room" link on this site lands on it. A 302, not a 301, so the choice can be undone without browsers
// holding the old answer.
// Everything else falls through to the asset binding, 404.html included (not_found_handling in wrangler.toml).
//
// Deploy: committed + pushed to main, then `npx wrangler deploy` from site/ (the predeploy guard enforces that order).
// Check: curl -sI https://djzs.ai/scan → 302 · location: https://scan.djzs.ai/

const ROOM = "https://scan.djzs.ai/";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/scan" || url.pathname === "/scan/") {
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("GET", { status: 405, headers: { allow: "GET, HEAD" } });
      return new Response(null, { status: 302, headers: { location: ROOM, "cache-control": "public, max-age=60" } });
    }
    return env.ASSETS.fetch(request);
  },
};
