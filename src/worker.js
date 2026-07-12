// Cloudflare Worker with static assets. Because wrangler.jsonc sets
// run_worker_first: ["/api/*"], this fetch handler only ever runs for
// /api/* requests — everything else (index.html, manifest.json, sw.js,
// icons, data/history-cache.json) is served directly from the ./public
// folder without touching this code at all.
//
// The proxy exists because ESPN's fantasy API doesn't send CORS headers,
// so the browser can't call it directly — this runs server-side instead.
//
// ESPN uses two different endpoints depending on how old the season is:
//   2019+   -> the regular "current" endpoint
//   <=2018  -> the "leagueHistory" endpoint, which wraps the season object
//              in a one-item array for historical reasons
//
// As of Aug 2025 ESPN also started requiring login cookies (espn_s2/SWID)
// for the leagueHistory endpoint on some leagues, even public ones. Pass
// them via the X-Espn-S2 / X-Espn-Swid request headers (the app's "ESPN
// login" panel does this automatically once you've saved them there).

const VIEWS = 'view=mTeam&view=mStandings&view=mMatchupScore&view=mSettings';
const LEGACY_CUTOFF_YEAR = 2019;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/espn-proxy') {
      return handleEspnProxy(request, url);
    }

    // Shouldn't normally be reached given run_worker_first scoping, but
    // fall back to serving static assets just in case.
    return env.ASSETS.fetch(request);
  },
};

async function handleEspnProxy(request, url) {
  const leagueId = url.searchParams.get('leagueId');
  const season = url.searchParams.get('season');
  const espnS2 = request.headers.get('x-espn-s2');
  const swid = request.headers.get('x-espn-swid');

  const corsHeaders = { 'Access-Control-Allow-Origin': '*' };

  if (!leagueId || !season) {
    return jsonResponse({ error: 'leagueId and season are required' }, 400, corsHeaders);
  }

  const seasonNum = parseInt(season, 10);
  const isLegacy = seasonNum < LEGACY_CUTOFF_YEAR;

  const espnUrl = isLegacy
    ? `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/leagueHistory/${leagueId}?seasonId=${season}&${VIEWS}`
    : `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}?${VIEWS}`;

  const reqHeaders = {
    Accept: 'application/json',
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    Referer: 'https://fantasy.espn.com/',
    Origin: 'https://fantasy.espn.com',
  };
  if (espnS2 && swid) {
    reqHeaders.Cookie = `espn_s2=${espnS2}; SWID=${swid}`;
  }

  try {
    const espnRes = await fetch(espnUrl, { headers: reqHeaders });

    if (!espnRes.ok) {
      const errBody = await espnRes.text();
      const hint = isLegacy
        ? (espnS2 && swid
            ? ' Login cookies were sent but ESPN still rejected the request — double check you copied the full espn_s2 value and the SWID including its curly braces, and that they\'re not expired.'
            : ' ESPN restricts the legacy history endpoint for some leagues as of Aug 2025 — add your ESPN login (espn_s2/SWID) in the app\'s "ESPN login" panel to unlock it.')
        : '';
      return jsonResponse(
        { error: 'ESPN returned an error.' + hint, status: espnRes.status, detail: errBody.slice(0, 300) },
        espnRes.status,
        corsHeaders
      );
    }

    let body = await espnRes.text();

    // leagueHistory wraps the season in a single-item array — unwrap it so
    // the client always gets the same shape regardless of season.
    if (isLegacy) {
      try {
        const parsed = JSON.parse(body);
        body = JSON.stringify(Array.isArray(parsed) ? parsed[0] : parsed);
      } catch (e) {
        // fall through and return the raw body as-is
      }
    }

    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  } catch (err) {
    return jsonResponse({ error: 'Could not reach ESPN', detail: String(err) }, 502, corsHeaders);
  }
}

function jsonResponse(obj, status, corsHeaders) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}
