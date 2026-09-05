/* GameDay Tracker - app logic
   Vanilla JS, no build step. Data comes from ESPN's public "site.api"
   sports feeds, reached through a small proxy the user deploys themselves
   (see README.md). Everything the user picks (teams followed, radio
   stations, proxy address) is saved on-device with localStorage. */

(() => {
  "use strict";

  // ---------------------------------------------------------------------
  // League catalog
  // ---------------------------------------------------------------------
  const LEAGUES = [
    { key: "nfl",      label: "NFL",                          sport: "football",   slug: "nfl",                     hasRank: false },
    { key: "nba",      label: "NBA",                          sport: "basketball", slug: "nba",                     hasRank: false },
    { key: "mlb",      label: "MLB",                          sport: "baseball",   slug: "mlb",                     hasRank: false },
    { key: "nhl",      label: "NHL",                          sport: "hockey",     slug: "nhl",                     hasRank: false },
    { key: "ncaaf",    label: "College Football",             sport: "football",   slug: "college-football",        hasRank: true,  scoreboardParams: "groups=80" },
    { key: "ncaab",    label: "College Basketball (Men's)",   sport: "basketball", slug: "mens-college-basketball", hasRank: true,  scoreboardParams: "groups=50" },
    { key: "wncaab",   label: "College Basketball (Women's)", sport: "basketball", slug: "womens-college-basketball", hasRank: true, scoreboardParams: "groups=50" },
    { key: "epl",      label: "Premier League (Soccer)",      sport: "soccer",     slug: "eng.1",                   hasRank: false },
    { key: "mls",      label: "MLS (Soccer)",                 sport: "soccer",     slug: "usa.1",                   hasRank: false },
    { key: "laliga",   label: "La Liga (Soccer)",              sport: "soccer",     slug: "esp.1",                   hasRank: false },
    { key: "seriea",   label: "Serie A (Soccer)",              sport: "soccer",     slug: "ita.1",                   hasRank: false },
    { key: "bundesliga", label: "Bundesliga (Soccer)",         sport: "soccer",     slug: "ger.1",                   hasRank: false },
    { key: "ligue1",   label: "Ligue 1 (Soccer)",              sport: "soccer",     slug: "fra.1",                   hasRank: false },
    { key: "ucl",      label: "Champions League (Soccer)",     sport: "soccer",     slug: "uefa.champions",          hasRank: false },
  ];
  const leagueByKey = (k) => LEAGUES.find((l) => l.key === k);

  // ---------------------------------------------------------------------
  // Storage helpers
  // ---------------------------------------------------------------------
  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (e) {
        return fallback;
      }
    },
    set(key, val) {
      try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* storage full/blocked */ }
    },
  };

  let followedTeams = store.get("gd_followedTeams", []);
  let proxyUrl = store.get("gd_proxyUrl", "");
  let lookaheadDays = store.get("gd_lookaheadDays", 10);
  const teamListCache = store.get("gd_teamListCache", {}); // { leagueKey: { fetchedAt, teams: [] } }

  function saveFollowed() { store.set("gd_followedTeams", followedTeams); }
  function saveTeamListCache() { store.set("gd_teamListCache", teamListCache); }

  // ---------------------------------------------------------------------
  // Networking
  // ---------------------------------------------------------------------
  async function apiFetch(path) {
    if (!proxyUrl) throw new Error("NO_PROXY");
    const base = proxyUrl.replace(/\/$/, "");
    const resp = await fetch(base + path, { cache: "no-store" });
    if (!resp.ok) throw new Error("HTTP_" + resp.status);
    return resp.json();
  }

  async function fetchTeams(league) {
    const cached = teamListCache[league.key];
    const dayMs = 24 * 60 * 60 * 1000;
    if (cached && Date.now() - cached.fetchedAt < 7 * dayMs) {
      return cached.teams;
    }
    const data = await apiFetch(`/api/sports/${league.sport}/${league.slug}/teams?limit=1000`);
    const rawTeams = (((data.sports || [])[0] || {}).leagues || [])[0]?.teams || [];
    const teams = rawTeams.map((t) => {
      const team = t.team;
      const logo = (team.logos && team.logos[0] && team.logos[0].href) || "";
      return { id: String(team.id), name: team.displayName, abbr: team.abbreviation || "", logo };
    }).sort((a, b) => a.name.localeCompare(b.name));
    teamListCache[league.key] = { fetchedAt: Date.now(), teams };
    saveTeamListCache();
    return teams;
  }

  function fmtDateRange(startDate, days) {
    const fmt = (d) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${y}${m}${day}`;
    };
    const end = new Date(startDate);
    end.setDate(end.getDate() + days);
    return `${fmt(startDate)}-${fmt(end)}`;
  }

  function extractRecord(competitor) {
    const recs = competitor.records || [];
    const overall = recs.find((r) => r.type === "total" || r.name === "overall") || recs[0];
    return overall ? overall.summary : "";
  }

  function extractBroadcastsScoreboardShape(comp) {
    const list = comp.broadcasts || [];
    const names = [];
    list.forEach((b) => {
      if (Array.isArray(b.names)) names.push(...b.names);
    });
    return [...new Set(names)];
  }

  function extractBroadcastsScheduleShape(broadcasts) {
    const names = [];
    (broadcasts || []).forEach((b) => {
      const name = b.media && b.media.shortName;
      if (name) names.push(name);
    });
    return [...new Set(names)];
  }

  function radioForTeamId(teamId) {
    const ft = followedTeams.find((f) => f.teamId === String(teamId));
    return ft && ft.radio ? ft.radio : "";
  }

  function teamLogoOf(teamObj) {
    if (!teamObj) return "";
    if (teamObj.logo) return teamObj.logo;
    if (teamObj.logos && teamObj.logos[0] && teamObj.logos[0].href) return teamObj.logos[0].href;
    return "";
  }

  function isFollowed(leagueKey, teamId) {
    return followedTeams.some((f) => f.leagueKey === leagueKey && f.teamId === String(teamId));
  }

  // ---------------------------------------------------------------------
  // Building the games list
  // ---------------------------------------------------------------------
  async function fetchGamesForLeague(league, followedIdsInLeague) {
    const range = fmtDateRange(new Date(), lookaheadDays);
    let path = `/api/sports/${league.sport}/${league.slug}/scoreboard?dates=${range}&limit=1000`;
    if (league.scoreboardParams) path += `&${league.scoreboardParams}`;
    const data = await apiFetch(path);
    const events = data.events || [];
    const games = [];
    const seenTeamIds = new Set();

    events.forEach((ev) => {
      const comp = (ev.competitions || [])[0];
      if (!comp) return;
      const competitors = comp.competitors || [];
      const involved = competitors.some((c) => followedIdsInLeague.includes(String(c.team.id)));
      if (!involved) return;

      competitors.forEach((c) => { if (followedIdsInLeague.includes(String(c.team.id))) seenTeamIds.add(String(c.team.id)); });

      const home = competitors.find((c) => c.homeAway === "home") || competitors[0];
      const away = competitors.find((c) => c.homeAway === "away") || competitors[1];
      const oddsEntry = (comp.odds || [])[0];

      games.push({
        league,
        date: comp.date || ev.date,
        venueName: comp.venue ? comp.venue.fullName : "",
        venueCity: comp.venue && comp.venue.address ? [comp.venue.address.city, comp.venue.address.state].filter(Boolean).join(", ") : "",
        away: {
          name: away.team.displayName,
          abbr: away.team.abbreviation,
          logo: teamLogoOf(away.team),
          rank: league.hasRank && away.curatedRank ? away.curatedRank.current : null,
          record: extractRecord(away),
          radio: radioForTeamId(away.team.id),
        },
        home: {
          name: home.team.displayName,
          abbr: home.team.abbreviation,
          logo: teamLogoOf(home.team),
          rank: league.hasRank && home.curatedRank ? home.curatedRank.current : null,
          record: extractRecord(home),
          radio: radioForTeamId(home.team.id),
        },
        broadcasts: extractBroadcastsScoreboardShape(comp),
        odds: oddsEntry ? {
          details: oddsEntry.details || "",
          overUnder: oddsEntry.overUnder,
          provider: oddsEntry.provider ? oddsEntry.provider.name : "",
        } : null,
        hasOdds: !!oddsEntry,
      });
    });

    // Followed teams in this league with no game inside the lookahead window:
    // fall back to their team schedule endpoint just to show the next game
    // (without odds, since odds aren't posted that far out anyway).
    const missing = followedIdsInLeague.filter((id) => !seenTeamIds.has(id));
    for (const teamId of missing) {
      try {
        const sched = await apiFetch(`/api/sports/${league.sport}/${league.slug}/teams/${teamId}/schedule`);
        const now = Date.now();
        const upcoming = (sched.events || [])
          .filter((ev) => new Date(ev.date).getTime() > now)
          .sort((a, b) => new Date(a.date) - new Date(b.date))[0];
        if (!upcoming) continue;
        const comp = (upcoming.competitions || [])[0];
        if (!comp) continue;
        const competitors = comp.competitors || [];
        const homeC = competitors.find((c) => c.homeAway === "home") || competitors[0];
        const awayC = competitors.find((c) => c.homeAway === "away") || competitors[1];
        games.push({
          league,
          date: upcoming.date,
          venueName: comp.venue ? comp.venue.fullName : "",
          venueCity: comp.venue && comp.venue.address ? [comp.venue.address.city, comp.venue.address.state].filter(Boolean).join(", ") : "",
          away: awayC && awayC.team ? {
            name: awayC.team.displayName,
            abbr: awayC.team.abbreviation || "",
            logo: teamLogoOf(awayC.team),
            rank: null, record: "", radio: radioForTeamId(awayC.team.id),
          } : { name: "TBD", abbr: "", logo: "", rank: null, record: "", radio: "" },
          home: homeC && homeC.team ? {
            name: homeC.team.displayName,
            abbr: homeC.team.abbreviation || "",
            logo: teamLogoOf(homeC.team),
            rank: null, record: "", radio: radioForTeamId(homeC.team.id),
          } : { name: "TBD", abbr: "", logo: "", rank: null, record: "", radio: "" },
          broadcasts: extractBroadcastsScheduleShape(comp.broadcasts),
          odds: null,
          hasOdds: false,
          beyondWindow: true,
        });
      } catch (e) {
        // Best-effort fallback only; skip silently on failure.
      }
    }

    return games;
  }

  async function loadAllGames() {
    const gamesListEl = document.getElementById("gamesList");
    const setupNotice = document.getElementById("setupNotice");
    const emptyNotice = document.getElementById("emptyTeamsNotice");

    setupNotice.classList.toggle("hidden", !!proxyUrl);
    emptyNotice.classList.toggle("hidden", followedTeams.length === 0 || !proxyUrl);

    if (!proxyUrl || followedTeams.length === 0) {
      gamesListEl.innerHTML = "";
      return;
    }

    gamesListEl.innerHTML = '<div class="spinner-row">Loading games...</div>';

    const leagueKeys = [...new Set(followedTeams.map((f) => f.leagueKey))];
    let allGames = [];
    const errors = [];

    for (const key of leagueKeys) {
      const league = leagueByKey(key);
      if (!league) continue;
      const idsInLeague = followedTeams.filter((f) => f.leagueKey === key).map((f) => f.teamId);
      try {
        const games = await fetchGamesForLeague(league, idsInLeague);
        allGames = allGames.concat(games);
      } catch (e) {
        errors.push(league.label);
      }
    }

    allGames.sort((a, b) => new Date(a.date) - new Date(b.date));
    renderGames(allGames, errors);
    document.getElementById("updatedAt").textContent = "Updated " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    store.set("gd_lastGames", allGames);
    store.set("gd_lastUpdated", Date.now());
  }

  function dayLabel(dateObj) {
    const now = new Date();
    const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diffDays = Math.round((startOfDay(dateObj) - startOfDay(now)) / 86400000);
    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "Tomorrow";
    if (diffDays > 1 && diffDays < 7) return dateObj.toLocaleDateString([], { weekday: "long" });
    return dateObj.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  }

  function renderGames(games, errors) {
    const el = document.getElementById("gamesList");
    if (games.length === 0) {
      el.innerHTML = '<div class="notice"><p>No upcoming games found for your teams in the selected window. Try increasing the lookahead in Settings.</p></div>';
    } else {
      el.innerHTML = games.map(renderGameCard).join("");
    }
    if (errors.length) {
      const box = document.createElement("div");
      box.className = "error-box";
      box.textContent = `Couldn't load data for: ${errors.join(", ")}. Check your proxy URL in Settings, or try again in a bit.`;
      el.prepend(box);
    }
  }

  function teamBlockHtml(t, side) {
    const rankOrRecord = t.rank ? `#${t.rank}` : (t.record || "");
    return `
      <div class="team-block ${side}">
        ${t.logo ? `<img class="team-logo" src="${t.logo}" alt="" loading="lazy">` : `<div class="team-logo"></div>`}
        <div class="team-name-wrap">
          <div class="team-name">${escapeHtml(t.abbr || t.name)}</div>
          ${rankOrRecord ? `<div class="team-sub">${escapeHtml(rankOrRecord)}</div>` : ""}
        </div>
      </div>`;
  }

  function renderGameCard(g) {
    const d = new Date(g.date);
    const dateStr = dayLabel(d) + " &middot; " + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const venue = [g.venueName, g.venueCity].filter(Boolean).join(" &mdash; ");
    const tv = g.broadcasts && g.broadcasts.length ? g.broadcasts.join(", ") : "";
    const radio = g.away.radio || g.home.radio
      ? [g.away.radio ? `${g.away.abbr || g.away.name}: ${g.away.radio}` : "", g.home.radio ? `${g.home.abbr || g.home.name}: ${g.home.radio}` : ""].filter(Boolean).join(" / ")
      : "";
    let oddsStr = "";
    if (g.odds) {
      const parts = [];
      if (g.odds.details) parts.push(g.odds.details);
      if (g.odds.overUnder) parts.push(`O/U ${g.odds.overUnder}`);
      oddsStr = parts.join(" &middot; ") + (g.odds.provider ? ` (${g.odds.provider})` : "");
    }

    return `
      <div class="game-card">
        <span class="league-badge">${escapeHtml(g.league.label)}</span>
        <div class="date-line">${dateStr}</div>
        <div class="matchup-row">
          ${teamBlockHtml(g.away, "away")}
          <div class="at-sep">@</div>
          ${teamBlockHtml(g.home, "home")}
        </div>
        <div class="game-meta">
          <div class="meta-item">
            <span class="meta-label">Venue</span>
            <span class="meta-value ${venue ? "" : "muted"}">${venue || "TBD"}</span>
          </div>
          <div class="meta-item">
            <span class="meta-label">TV</span>
            <span class="meta-value ${tv ? "" : "muted"}">${tv || "Not announced yet"}</span>
          </div>
          <div class="meta-item">
            <span class="meta-label">Radio</span>
            <span class="meta-value ${radio ? "" : "muted"}">${radio || "Not set (add in My Teams)"}</span>
          </div>
          <div class="meta-item">
            <span class="meta-label">Odds</span>
            <span class="meta-value ${oddsStr ? "" : "muted"}">${oddsStr || (g.beyondWindow ? "Too early for odds" : "Not posted yet")}</span>
          </div>
        </div>
      </div>`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---------------------------------------------------------------------
  // Teams tab
  // ---------------------------------------------------------------------
  function renderFollowedTeams() {
    const el = document.getElementById("followedTeamsList");
    if (followedTeams.length === 0) {
      el.innerHTML = '<p class="help-text">No teams yet — search for one below.</p>';
      return;
    }
    el.innerHTML = followedTeams.map((f, idx) => `
      <div class="followed-team-row">
        ${f.logo ? `<img class="team-logo" src="${f.logo}" alt="">` : `<div class="team-logo"></div>`}
        <div class="followed-team-info">
          <div class="followed-team-name">${escapeHtml(f.teamName)}</div>
          <div class="followed-team-league">${escapeHtml(leagueByKey(f.leagueKey)?.label || f.leagueKey)}</div>
          ${f.radio ? `<div class="followed-team-radio">Radio: ${escapeHtml(f.radio)}</div>` : ""}
        </div>
        <div class="row-actions">
          <button data-radio-idx="${idx}">Radio</button>
          <button class="remove" data-remove-idx="${idx}">Remove</button>
        </div>
      </div>`).join("");
  }

  function populateLeagueSelect() {
    const sel = document.getElementById("leagueSelect");
    sel.innerHTML = LEAGUES.map((l) => `<option value="${l.key}">${l.label}</option>`).join("");
  }

  let teamSearchDebounce = null;
  async function handleTeamSearch() {
    const query = document.getElementById("teamSearch").value.trim().toLowerCase();
    const resultsEl = document.getElementById("teamSearchResults");
    const leagueKey = document.getElementById("leagueSelect").value;
    const league = leagueByKey(leagueKey);
    if (!proxyUrl) {
      resultsEl.innerHTML = '<p class="help-text">Set your proxy URL in Settings first.</p>';
      return;
    }
    resultsEl.innerHTML = '<div class="spinner-row">Loading teams...</div>';
    try {
      const teams = await fetchTeams(league);
      const filtered = query ? teams.filter((t) => t.name.toLowerCase().includes(query) || t.abbr.toLowerCase().includes(query)) : teams;
      if (filtered.length === 0) {
        resultsEl.innerHTML = '<p class="help-text">No teams matched.</p>';
        return;
      }
      resultsEl.innerHTML = filtered.slice(0, 60).map((t) => `
        <div class="team-result-row" data-team-id="${t.id}" data-team-name="${escapeHtml(t.name)}" data-team-abbr="${escapeHtml(t.abbr)}" data-team-logo="${escapeHtml(t.logo)}">
          ${t.logo ? `<img class="team-logo" src="${t.logo}" alt="">` : `<div class="team-logo"></div>`}
          <div>${escapeHtml(t.name)}</div>
          ${isFollowed(leagueKey, t.id) ? '<span class="help-text" style="margin-left:auto">Following</span>' : ""}
        </div>`).join("");
    } catch (e) {
      resultsEl.innerHTML = `<div class="error-box">Couldn't load teams (${e.message}). Check your proxy URL in Settings.</div>`;
    }
  }

  function addFollowedTeam(leagueKey, id, name, abbr, logo) {
    if (isFollowed(leagueKey, id)) return;
    followedTeams.push({ leagueKey, teamId: String(id), teamName: name, teamAbbr: abbr, logo, radio: "" });
    saveFollowed();
    renderFollowedTeams();
    handleTeamSearch();
  }

  // ---------------------------------------------------------------------
  // Settings tab
  // ---------------------------------------------------------------------
  function initSettings() {
    document.getElementById("proxyUrl").value = proxyUrl;
    document.getElementById("lookaheadDays").value = String(lookaheadDays);
  }

  // ---------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------
  function showView(viewId) {
    document.querySelectorAll(".view").forEach((v) => v.classList.toggle("hidden", v.id !== viewId));
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === viewId));
    if (viewId === "view-teams") renderFollowedTeams();
    if (viewId === "view-games") loadAllGames();
  }

  // ---------------------------------------------------------------------
  // Radio modal
  // ---------------------------------------------------------------------
  let radioEditIdx = null;
  function openRadioModal(idx) {
    radioEditIdx = idx;
    const f = followedTeams[idx];
    document.getElementById("radioModalTitle").textContent = "Radio station — " + f.teamName;
    document.getElementById("radioInput").value = f.radio || "";
    document.getElementById("radioModal").classList.remove("hidden");
  }
  function closeRadioModal() {
    document.getElementById("radioModal").classList.add("hidden");
    radioEditIdx = null;
  }

  // ---------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------
  document.addEventListener("DOMContentLoaded", () => {
    populateLeagueSelect();
    initSettings();
    showView("view-games");

    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => showView(btn.dataset.view));
    });
    document.querySelectorAll("[data-goto]").forEach((btn) => {
      btn.addEventListener("click", () => showView(btn.dataset.goto));
    });

    document.getElementById("refreshBtn").addEventListener("click", loadAllGames);

    document.getElementById("leagueSelect").addEventListener("change", handleTeamSearch);
    document.getElementById("teamSearch").addEventListener("input", () => {
      clearTimeout(teamSearchDebounce);
      teamSearchDebounce = setTimeout(handleTeamSearch, 250);
    });

    document.getElementById("teamSearchResults").addEventListener("click", (e) => {
      const row = e.target.closest(".team-result-row");
      if (!row) return;
      const leagueKey = document.getElementById("leagueSelect").value;
      addFollowedTeam(leagueKey, row.dataset.teamId, row.dataset.teamName, row.dataset.teamAbbr, row.dataset.teamLogo);
    });

    document.getElementById("followedTeamsList").addEventListener("click", (e) => {
      if (e.target.dataset.removeIdx !== undefined) {
        const idx = Number(e.target.dataset.removeIdx);
        followedTeams.splice(idx, 1);
        saveFollowed();
        renderFollowedTeams();
      } else if (e.target.dataset.radioIdx !== undefined) {
        openRadioModal(Number(e.target.dataset.radioIdx));
      }
    });

    document.getElementById("radioCancelBtn").addEventListener("click", closeRadioModal);
    document.getElementById("radioSaveBtn").addEventListener("click", () => {
      if (radioEditIdx !== null) {
        followedTeams[radioEditIdx].radio = document.getElementById("radioInput").value.trim();
        saveFollowed();
        renderFollowedTeams();
      }
      closeRadioModal();
    });

    document.getElementById("saveProxyBtn").addEventListener("click", () => {
      proxyUrl = document.getElementById("proxyUrl").value.trim();
      store.set("gd_proxyUrl", proxyUrl);
      document.getElementById("proxyStatus").textContent = proxyUrl ? "Saved." : "Cleared.";
      loadAllGames();
    });

    document.getElementById("lookaheadDays").addEventListener("change", (e) => {
      lookaheadDays = Number(e.target.value);
      store.set("gd_lookaheadDays", lookaheadDays);
      loadAllGames();
    });

    document.getElementById("resetAppBtn").addEventListener("click", () => {
      if (confirm("This clears all followed teams, radio stations, and settings on this device. Continue?")) {
        localStorage.clear();
        location.reload();
      }
    });

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
  });
})();
