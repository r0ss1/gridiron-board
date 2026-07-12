// Runs on Netlify's server, not in the browser — so ESPN's lack of CORS
// headers doesn't matter here. The browser talks to this function instead
// of talking to ESPN directly.
//
// ESPN uses two different endpoints depending on how old the season is:
//   2019+   -> the regular "current" endpoint, one season object back
//   <=2018  -> the "leagueHistory" endpoint, which wraps the season object
//              in a one-item array for historical reasons
//
// As of Aug 2025 ESPN also started requiring login cookies (espn_s2/SWID)
// for the leagueHistory endpoint on some leagues, even public ones. There's
// no way to get those from a browser-only app, so old seasons may fail with
// a 401/403 here — that's ESPN, not a bug in this function.

const VIEWS = 'view=mTeam&view=mStandings&view=mMatchupScore&view=mSettings';
const LEGACY_CUTOFF_YEAR = 2019; // seasons before this use leagueHistory

exports.handler = async (event) => {
  const { leagueId, season } = event.queryStringParameters || {};

  if (!leagueId || !season) {
    return {
      statusCode: 400,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'leagueId and season are required' }),
    };
  }

  const seasonNum = parseInt(season, 10);
  const isLegacy = seasonNum < LEGACY_CUTOFF_YEAR;

  const url = isLegacy
    ? `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/leagueHistory/${leagueId}?seasonId=${season}&${VIEWS}`
    : `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}?${VIEWS}`;

  try {
    const espnRes = await fetch(url, { headers: { Accept: 'application/json' } });

    if (!espnRes.ok) {
      const errBody = await espnRes.text();
      const hint = isLegacy
        ? ' ESPN restricts the legacy history endpoint for some leagues as of Aug 2025 — this may require a logged-in cookie that a static app cannot provide.'
        : '';
      return {
        statusCode: espnRes.status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'ESPN returned an error.' + hint, status: espnRes.status, detail: errBody.slice(0, 300) }),
      };
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

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body,
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Could not reach ESPN', detail: String(err) }),
    };
  }
};
