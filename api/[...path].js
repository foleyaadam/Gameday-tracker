/**
 * GameDay Tracker - ESPN data proxy (Vercel version)
 * ----------------------------------------------------
 * Same job as the Cloudflare version: fetch ESPN's public sports data on
 * the app's behalf and add the permission headers phone browsers require
 * (CORS). This one runs on Vercel instead, since Vercel's network isn't
 * blocked by ESPN's security service the way Cloudflare Workers are.
 *
 * You do not need to understand this file. Follow README.md to deploy it.
 */

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Cache-Control", "public, max-age=60");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  const pathParam = req.query.path;
  const targetPath = Array.isArray(pathParam) ? pathParam.join("/") : (pathParam || "");

  const queryString = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query)) {
    if (key === "path") continue;
    if (Array.isArray(value)) {
      value.forEach((v) => queryString.append(key, v));
    } else {
      queryString.append(key, value);
    }
  }
  const search = queryString.toString();

  const targetUrl = `https://site.api.espn.com/apis/site/v2/${targetPath}${search ? "?" + search : ""}`;

  try {
    const upstreamResp = await fetch(targetUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://www.espn.com/",
        "Origin": "https://www.espn.com",
      },
    });
    const body = await upstreamResp.text();
    res.status(upstreamResp.status);
    res.setHeader("Content-Type", "application/json");
    res.send(body);
  } catch (err) {
    res.status(502).json({ error: "Upstream fetch failed", detail: String(err) });
  }
};
