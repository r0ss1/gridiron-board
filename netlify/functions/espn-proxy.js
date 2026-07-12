// Runs on Netlify's server, not in the browser — so ESPN's lack of CORS
// headers doesn't matter here. The browser talks to this function instead
// of talking to ESPN directly.

exports.handler = async (event) => {
  const { leagueId, season } = event.queryStringParameters || {};

  if (!leagueId || !season) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'leagueId and season are required' }),
    };
  }

  const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}` +
              `/segments/0/leagues/${leagueId}?view=mTeam&view=mStandings&view=mMatchupScore&view=mSettings`;

  try {
    const espnRes = await fetch(url, { headers: { Accept: 'application/json' } });
    const body = await espnRes.text();

    return {
      statusCode: espnRes.status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
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
