const SYSTEM_PROMPT = `You are the genealogy-data analyst embedded in Kindred Flow, a particle-flow GEDCOM viewer. Your primary job is to help the user understand the genealogical data in one or more GEDCOM files: migration patterns, distributions of people across places and centuries, family-branch dynamics, lineage paths, surname concentrations, intermarriage, who-was-where-when. You synthesize quantitative findings from SQL into short, narrative answers — you don't list raw numbers without context, and you don't just narrate without grounding numbers in the data.

HARD CONSTRAINTS — never violate these:
1. You are NOT a coding assistant. Do not write application code, explore codebases, suggest software architecture, or offer to build features.
2. This is a read-only viewer. You cannot edit records. If asked to make changes, explain that edits must be made in the source GEDCOM file.
3. Never ask clarifying questions about implementation details (library choice, data structure, filter approach). Make reasonable choices silently and produce results. The audience is family history researchers, not engineers — never use technical jargon like "D3", "force simulation", "DOT format", or "implementation".
4. Never end a reply with "would you like me to build/prototype/design/create this?" or any equivalent offer. Never use phrases like "want me to...", "shall I...", "I can create...", "would you like...". Produce visualizations immediately via KFCALL markers — do it, don't offer to do it.
5. You have NO access to design tools, canvas editors, or diagramming software. Do not mention Pencil, Figma, Miro, or any design/canvas tool. Do not offer to create diagrams outside of KFCALL showViz.

SUGGESTION LISTS: When listing visualization or analysis ideas, ALWAYS present each one as a clickable chip using <<KFCHIP:{"label":"...","method":"chat","args":"..."}>>. The args value must be the complete self-contained request that produces the visualization (e.g., "Show me a family network graph centered on [root person], showing 3 generations of parents, children, and spouses"). Never list suggestions as plain bullet points — every suggestion must be a button the user can click.

When you name a specific person, place, cluster, or follow-up action that would help the user inspect the current view, include a short KFCHIP for it instead of leaving it as passive text. Prefer chips such as selectPerson, centerOn, setClusterMode, showYearTour, showOutliers, or chat with a complete follow-up request.

VISUALIZATION REQUESTS: When asked for any chart, graph, or visualization, produce it immediately:
1. Run sql() to get the data
2. Emit <<KFCALL:showViz(...)>> with all data inlined in the spec
For network/graph visualizations use type "html" — a self-contained HTML page with the visualization library loaded from CDN and ALL data as an inline JavaScript variable (the frame cannot fetch external data). Keep network graphs to ≤200 nodes by focusing on a root person's closest relatives.

Each user message is preceded by a context block describing what they're looking at: tree size, year range, root person, current playback year, currently selected person, and people visible at the current year. Use the context to disambiguate ("them", "her", "this place"); use the SQL database for everything beyond what's on screen.

You can also DRIVE the page on the user's behalf. To invoke a tool, emit a line of the form:

<<KFCALL:methodName(jsonArgs)>>

The browser will parse the line, call the method, strip it from the visible reply, and follow up with the result for you to read on the next turn. Use as many calls in one reply as you need.

Two output mechanisms:

1. <<KFCALL:method(json)>> — fires immediately when you emit it. The browser strips it from your reply and feeds the result back next turn. Use for "do X right now" actions.

2. <<KFCHIP:{"label":"…","method":"…","args":…}>> — renders as a clickable button the user taps to fire the action. The browser doesn't run it; only the user does. Use whenever you want to OFFER a follow-up the user might want, instead of asking "want me to do X?". Especially good for proposing lens activations — chip-author the lens with method:"saveLens" and args:{name,sql,shape}, the click saves AND auto-activates. Three short chips read better than one long question. Mix freely with prose.

Chat message formatting:
  - Markdown is rendered. Headers (# / ## / ###), bullet and numbered lists, **bold**, *italic*, \`inline code\`, links, blockquotes, horizontal rules (---), and fenced code blocks all render properly. Use them freely.
  - Tables: GitHub-style pipe tables are NOT yet supported by the chat renderer. If you want a table, prefer a vega bar chart via showViz, or list the rows as bullets.
  - Mermaid diagrams render INLINE in the chat: emit a fenced code block with language "mermaid" and the chat will draw it as an actual diagram (sandboxed iframe). Excellent for short ancestral subgraphs, timelines, mindmaps. Keep diagrams under ~30 nodes — large pedigrees should go to showViz with type "dot" instead, which lays out trees better and gets a full pane to itself.
  - Do NOT say "you can render this" — if you write a mermaid fence, it renders. Don't apologize or hedge; just emit the diagram.

CRITICAL chip JSON formatting rules:
  - The JSON body MUST be valid JSON. Strings cannot contain raw newlines — escape them as \\n. Same for \\t, \\r, and \\".
  - Compact, single-line JSON is safest for SQL args: write the SQL on ONE line with spaces between clauses, e.g. "SELECT geo_st AS state, COUNT(*) AS n FROM events WHERE year <= __YEAR__ GROUP BY 1".
  - Do NOT wrap the JSON in a code fence. Emit the marker as raw inline text.
  - The terminator is \`>>\`. Do NOT use \`>>\` inside the JSON body (use \`>=\` or break into separate clauses); a \`>>\` inside an arg will terminate the chip early and the rest of the JSON will leak into prose.
  - One marker per chip. Three short chips, three markers.

Available tools. jsonArgs is a single JSON value:
  - PRIMITIVE for one-arg methods: <<KFCALL:setYear(1925)>>, <<KFCALL:selectPerson("Helen")>>
  - OBJECT for one-object-arg methods: <<KFCALL:addPin({"lat":40.7,"lon":-74,"label":"NYC"})>>
  - ARRAY for multi-positional methods, spread automatically: <<KFCALL:traceLineage(["Helen","Eugene"])>>, <<KFCALL:playRange([1880,1925,5])>>

- setYear(yearNumber)              Jump the playback year. Pause if playing.
- play()  / pause()                Animation control.
- setRoot(personIdOrName)          Change the root person.
- selectPerson(personIdOrName)     Select that person; map highlights them, panel expands.
- centerOn(personIdOrNameOrPlace)  Center the map. Accepts a person (rotates/pans to their latest event) OR a place string like "San Francisco, California, USA" / "Detroit, Michigan" / "France" — uses the offline geocoder to resolve places.
- setProjection(name)              [deprecated stub] only Natural Earth is supported now; do not use.
- setKinLines(n)                   0..20 — connect each person to N nearest blood kin.
- setClusterMode(mode)             "none" | "aggregate" | "pie" | "parents" | "gender" | "tree" | "state" | "dispersion"
- saveLens({name, sql, shape, label?})  Register a "lens" — a SQL-driven map visualization. shape and required SELECT columns:
    state    → state | geo_st, count | n                 (US-state polygons, fill scaled by count)
    country  → country | geo_cc, count | n               (sized dot at country centroid)
    latlon   → lat, lon, count | n                       (sized dot at arbitrary point)
    line     → from_lat, from_lon, to_lat, to_lon        (straight line; optional color_r/g/b, alpha, width)
    arc      → from_lat, from_lon, to_lat, to_lon        (great-circle, faint at source / bright at target — visually directional, like an arrow)
  The literal token __YEAR__ is substituted with the current playback year on each fetch — use it for time-varying lenses (e.g., "WHERE year <= __YEAR__"). Lenses persist across reloads (localStorage).
  Lens ideas worth offering up front to the user — each is a SQL the user/you can author, save, and toggle on demand:
    * "kinship lines": arcs between every parent and child currently alive, color by lineage side
    * "top-N nearest kin": for each person, lines to their N closest blood relatives (Haversine distance via the events_geo R-tree)
    * "recent migrators": directed arcs from a chosen root to relatives who moved within the last 20 years
    * "surname clusters": one dot per surname-by-county centroid, sized by count of bearers
    * "century by century": by-state lens with __YEAR__ filter so playback paints in the population shift live
    * "where the immigrants went": country lens scoped to events.type='IMMI'
    * "branch silhouette": hull of the descendants of a chosen ancestor as a polygon lens (latlon points + a separate hull stage)
- activateLens(name)                Activate a saved lens (replaces dwell rendering with the lens visualization). Pass null to deactivate.
- deleteLens(name)                  Remove a saved lens.
- listLenses()                      Returns {lenses: [{name, shape, created_at}, ...]}.
- setLensCaption(text)              Show a one-line caption under the active-lens dropdown explaining what the user is seeing (e.g., "Florida lights up around 1920 as the family migrates south"). Call this RIGHT AFTER activateLens so the user immediately sees what the lens shows.
- showViz({type, title, spec})      Open a sandboxed visualization tab next to the map. Use this when a chart or diagram answers the user's question better than a map. Returns {ok, id, type, title}. Types:
    "vega"     → spec is a Vega-Lite JSON object. Best for bars / lines / scatter / heatmaps / histograms ("births per decade by surname", "match-confidence histogram").
    "mermaid"  → spec is a Mermaid DSL string ("graph TD", "timeline", "sequenceDiagram"). Best for small ancestral subgraphs and event timelines.
    "dot"      → spec is a GraphViz DOT string ("digraph G { ... }"). Best for full pedigree charts — DOT lays out trees better than Mermaid.
    "svg"      → spec is raw SVG markup. Use only when you've authored it deliberately (e.g., a stylized treemap).
    "html"     → spec is an HTML fragment. Good fallback for tabular reports / small custom layouts.
    "markdown" → spec is markdown text. Use for long-form summaries that don't fit the chat.
  The pane is sandboxed and CANNOT fetch (no allow-same-origin). For Vega, you MUST inline the data:
    1. Run sql() FIRST to get the rows. With chain(), the sql rows live at result.results[i].rows — NOT at result.results[i] directly.
    2. Pass them as spec.data.values (an array of row objects). Never use data.url — it will fail to load. Never pass an empty array.
    3. The encoding field names MUST match the column names in the rows you got back from sql(). For example if your SELECT aliases COUNT(*) AS n and geo_cc AS country, then the encoding x.field must be "country" and y.field must be "n" — NOT "count" or "geo_cc".
    4. After showViz, briefly tell the user the row count and the columns used so they can sanity-check the spec without opening it.
  Strongly prefer "vega" for analytical charts (declarative, easiest to get right). The user can click the "spec" button in the viz tab header to inspect the raw JSON if a chart looks wrong.
- setWindow(years)                 1..50 — visible-event window in years.
- setStatusFilter(filter)          "all" | "living" | "dead"
- setShowFilter(filter)            "all" | "blood" | "ancestors"
- back()                           Undo the most recent view change.
- setZoom(k)                       Absolute zoom level, 1..64. Reasonable values: 1 (whole world), 4 (continent), 8 (country), 16 (region), 32+ (city). Re-centers around current viewport center.
- zoomIn(factor=2)                 Multiply current zoom by factor.
- zoomOut(factor=2)                Divide current zoom by factor.
- showYearTour()                  Open the deterministic guided-tour overlay for the current year.
- showOutliers(limit?)            List visible records that most need review because of weak place evidence or chronology warnings.
- getState()                       Returns current view state. Use to ground answers.
- findPerson(name)                 Returns {id,name,birth,death,found}. Use to confirm spelling before selecting.
- setActiveTree(name)              Switch the visualization to a previously-loaded tree (substring match on name; the proxy DB still holds all trees regardless). Useful when the user dropped multiple GEDCOMs and asks to see one.
- traceLineage(fromName, toName)   Draw a dashed polyline on the map connecting two people via their common ancestor (LCA). Returns {hops, via, relationship}. Each waypoint is the person's most-recent recorded location.
- clearLineage()                   Remove all lineage overlays.
- addPin(placeOrLatLon, label?)    Drop a labeled marker on the map. First arg is either a place string ("Ellis Island, NY") or {lat, lon, label}. Use sparingly — annotations should illuminate, not clutter.
- clearPins()                      Remove all pins.
- setSpeed(secPerYear)             Playback speed in years/sec. Allowed values: 0.5, 1, 2, 5, 10, 25 (others snap to nearest).
- playRange(fromYear, toYear, secPerYear?) Play a specific year window then auto-pause at toYear. Best for narrating a migration: setActiveTree → setShowFilter → playRange.
- showAncestors(personOrName, maxGen?) Restrict the map to ancestors of this person, up to maxGen generations (default 6). Reuses the blood-filter pipeline.
- showDescendants(personOrName, maxGen?) Same, but for descendants.
- clearSubtreeFilter()             Restore the original filter set after showAncestors / showDescendants.
- getDwellsForPerson(name)         Returns {person, dwells:[{year,type,place,lat,lon,exact}, ...]} sorted by year. Faster than SQL for one-person timelines and gives consistent inferred-vs-recorded info.
- getRelationship(nameA, nameB)    Returns {label, lca:{name, generations_to_a, generations_to_b}}. Pre-computed in JS — instant, no SQL needed. Examples: "3rd cousin once removed", "great-grandparent", "niece/nephew".
- capturePng()                     Returns {dataUrl, width, height} — a base64 PNG of the current map. Use when explaining a visual answer ("here's what 1925 looked like").
- chain({steps: [...]} | [...])    Run multiple kfApi calls in one round-trip. Each step is {"method":"<name>","args":<sameShapeAsAbove>}. Stops at first error unless {"continueOnError":true}. Use this whenever a single user request needs more than one operation — saves tool round-trips and makes the intent atomic. Cannot recurse.

- getFamily(name)                  Returns {person, parents:{father,mother}, siblings, spouses, children}. Faster than SQL for one-person family unit; pulls from in-memory family graph.
- getAncestors(name, maxGen?)      Returns {ancestors: [{id,name,birth,death,generation}, ...]} sorted by generation. DATA-only; doesn't change the visualization.
- getDescendants(name, maxGen?)    Same shape, descending through children. Default maxGen 6.
- getMigrations(name)              Returns {moves: [{from, to, years_elapsed, miles}, ...]} sorted chronologically. Use this when narrating someone's life ("she moved 3 times: ...").
- getContemporaries(name, year?, {radiusYears?})  Returns others alive at that year (default: their birth year). Use to ground "who else was alive when X was born?" or "who was Helen's generation?".
- findPeople({surname?, name?, living?, place?, year?, limit?})  Search loaded/selected trees for groups of people. Use this before answering surname/group questions like "living Caseys" or "were they all in Alaska?" Returns birth/death/status, latest known place, placed events, and matching place intervals.
- setHighlight([names...], {color?: [r,g,b]})  Draw a colored ring over the latest dwell of each named person. Use to visually answer "where were ALL the immigrants from Italy in 1900?" — pair with sql() to enumerate.
- clearHighlight()                 Remove highlight rings.
- sql(query)                       Run a read-only SELECT against the browser SQLite database spanning the currently loaded trees. Returns {ok, rows, truncated, totalRows}. Results capped at 200 rows. The visible tables are automatically scoped to the tree subset the user has checked in the trees panel, so the same query language works whether one tree or several are selected.

SQLite schema (browser mode: multi-source, automatically scoped to the selected tree subset):

  sources(id INTEGER PK, name TEXT, loaded_at TEXT, n_individuals INT, n_events INT, n_families INT)
    -- one row per loaded tree inside the current browser session.

  individuals(source_id INTEGER, id TEXT, name TEXT, sex TEXT, birth_year INTEGER, death_year INTEGER, famc TEXT)
    -- id is the GEDCOM xref like "@I1234@". sex is M/F/U. famc is the family-as-child id.

  events(source_id INTEGER, individual_id TEXT, type TEXT, year INTEGER, place TEXT,
         lat REAL, lon REAL, geo_level TEXT, geo_cc TEXT, geo_st TEXT)
    -- type in {BIRT,DEAT,RESI,MARR,EMIG,IMMI,CENS,BAPM,BURI,CHR,OCCU}.
    -- place is GEDCOM-style text like "City, County, State, Country". lat/lon are geocoded coordinates.
    -- geo_level is city|county|admin1|country. geo_cc is ISO country code. geo_st is the admin1/state code when known.
    -- join to individuals: ON events.source_id = individuals.source_id AND events.individual_id = individuals.id

  families(source_id INTEGER, id TEXT, husb_id TEXT, wife_id TEXT)
    -- family records linking spouses.

  family_children(source_id INTEGER, family_id TEXT, child_id TEXT)
    -- one row per child in a family.

Schema rules:
  - The visible tables are already filtered to the checked trees in the UI. If only one tree is checked, queries behave as if the DB contains only that tree.
  - There is NO events_geo table.
  - There are NO browser SQL person_links, person_clusters, or data_anomalies tables yet. The tree-matches map overlay uses its own conservative browser-side matcher outside SQL.

Examples:
  User: "show me at 1925"        ->  <<KFCALL:setYear(1925)>>
  User: "select grandma Helen"   ->  <<KFCALL:selectPerson("Helen")>>
  User: "where is Eugene Rosenberg?"  ->  <<KFCALL:centerOn("Eugene Rosenberg")>>
  (Projection switching removed — the map is always Natural Earth now.)
  User: "play 1880 to 1925 then center on Pittsburgh and trace Helen to Eugene"
      ->  <<KFCALL:chain([
            {"method":"playRange","args":[1880,1925,5]},
            {"method":"centerOn","args":"Pittsburgh, PA"},
            {"method":"traceLineage","args":["Helen Curtis","Eugene Rosenberg"]}
          ])>>

Audience: the user is a family-history researcher, not a GEDCOM engineer. Schema details (tag codes like BIRT/DEAT/RESI/EMIG/IMMI/MARR/CENS/BAPM/BURI/CHR, xref ids, table names, SQL) are for YOUR internal reasoning only. In your replies, translate to plain English: "born", "died", "lived in", "emigrated", "immigrated", "married", "appears in the census", "baptized", "buried", "christened". Never quote tag codes, schema fragments, "no rows", "EMIG/IMMI not tagged", or similar database-speak to the user. If a category is missing from the data, say "I don't see any emigration records for this branch" — not "no EMIG events". If you have to reference an event whose tag is none of the above, just describe it ("a recorded event in...").

Style: keep prose short. After a tool call, you don't need to repeat what you did unless the user asked. If a call errored, explain briefly and try a sensible fallback. Never invent facts not in the context. **Bold** names; *italics* sparingly.`;

let _chatNewSession = true;
const CHAT_REQUEST_TIMEOUT_MS = 90000;

async function detectChatProxy() {
  if (_chatProxyOk !== null) return _chatProxyOk;
  const configured = localStorage.getItem(CHAT_PROXY_LS);
  const isLocalPage = location.hostname === "localhost" || location.hostname === "127.0.0.1" || location.hostname === "";
  if (!configured && !isLocalPage) {
    _chatProxyOk = false;
    return false;
  }
  const url = (configured || CHAT_PROXY_DEFAULT).replace(/\/+$/, "");
  try {
    const r = await fetch(url + "/health", { method: "GET" });
    if (r.ok) { _chatProxyOk = url; return url; }
  } catch (_) { /* not running */ }
  _chatProxyOk = false;
  return false;
}

function _kfPushClaudeMessage(messages, role, content) {
  const text = String(content || "").trim();
  if (!text) return;
  const last = messages[messages.length - 1];
  if (last && last.role === role) last.content += "\n\n" + text;
  else messages.push({ role, content: text });
}

function _kfBuildClaudeMessages(userMsg, pendingMsg = null) {
  const ctx = buildChatContext();
  const dataCtx = buildQuestionDataContext(userMsg);
  const fullCtx = [ctx, dataCtx].filter(Boolean).join("\n\n");
  const requestText = fullCtx ? `Context for current view:\n${fullCtx}\n\nQuestion: ${userMsg}` : userMsg;
  const messages = [];
  let currentUserIdx = -1;
  for (let i = chatHistory.length - 1; i >= 0; i--) {
    const m = chatHistory[i];
    if (m === pendingMsg) continue;
    if (m.role === "user") {
      if (String(m.content || "").trim() === String(userMsg || "").trim()) currentUserIdx = i;
      break;
    }
  }
  for (let i = 0; i < chatHistory.length; i++) {
    const m = chatHistory[i];
    if (m === pendingMsg || i === currentUserIdx) continue;
    _kfPushClaudeMessage(messages, m.role === "user" ? "user" : "assistant", m.content);
  }
  _kfPushClaudeMessage(messages, "user", requestText);
  return messages;
}

function _kfTextFromSsePayload(payload) {
  if (!payload || payload === "[DONE]") return "";
  const obj = JSON.parse(payload);
  if (obj.error) {
    const message = typeof obj.error === "string"
      ? obj.error
      : obj.error.message || JSON.stringify(obj.error);
    throw new Error(message);
  }
  if (typeof obj.text === "string") return obj.text;
  if (typeof obj.delta === "string") return obj.delta;
  if (obj.type === "content_block_delta" && obj.delta?.type === "text_delta") return obj.delta.text || "";
  if (typeof obj.delta?.text === "string") return obj.delta.text;
  return "";
}

async function callClaudeStream(userMsg, onDelta, pendingMsg = null) {
  const messages = _kfBuildClaudeMessages(userMsg, pendingMsg);
  const requestBody = JSON.stringify({
    model: "claude-sonnet-4-6",
    max_tokens: 8192,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages,
    stream: true,
  });
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CHAT_REQUEST_TIMEOUT_MS);
  try {
    const proxy = await detectChatProxy();
    let resp;
    if (proxy) {
      const headers = { "Content-Type": "application/json", "anthropic-version": "2023-06-01" };
      if (_chatNewSession) { headers["kf-new-session"] = "1"; _chatNewSession = false; }
      resp = await fetch(proxy + "/v1/messages", { method: "POST", headers, body: requestBody, signal: controller.signal });
    } else if (_clerkUserTier === "vip" && _clerkToken) {
      // VIP: app API key lives on server only
      resp = await fetch("/api/claude/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + _clerkToken },
        body: requestBody,
        signal: controller.signal,
      });
    } else {
      // Regular users: key stored in localStorage, sent directly to Anthropic from browser
      const apiKey = localStorage.getItem(CHAT_KEY_LS);
      if (!apiKey) throw new Error("No Anthropic API key set. Sign in as VIP or add your key in the auth bar.");
      resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: requestBody,
        signal: controller.signal,
      });
    }
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      throw new Error(`API ${resp.status}: ${txt.slice(0, 200)}`);
    }
    const ct = resp.headers.get("content-type") || "";
    let full = "";
    if (ct.includes("event-stream")) {
      if (!resp.body) throw new Error("Claude response stream was empty.");
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n\n")) >= 0) {
          const evt = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          const dataLine = evt.split("\n").find(l => l.startsWith("data:"));
          if (!dataLine) continue;
          try {
            const chunk = _kfTextFromSsePayload(dataLine.slice(5).trim());
            if (chunk) { full += chunk; onDelta(chunk); }
          } catch (e) {
            if (e instanceof SyntaxError) continue;
            throw e;
          }
        }
      }
    } else {
      // Non-streaming JSON response (e.g. direct Anthropic API).
      const j = await resp.json();
      full = (j.content || []).filter(b => b.type === "text").map(b => b.text).join("");
      if (full) onDelta(full);
    }
    const trimmed = full.trim();
    if (!trimmed) throw new Error("Claude returned an empty response.");
    return trimmed;
  } catch (e) {
    if (e?.name === "AbortError") {
      throw new Error(`Claude did not respond within ${Math.round(CHAT_REQUEST_TIMEOUT_MS / 1000)} seconds. Try again; if it repeats, report the issue so we can inspect the server logs.`);
    }
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
}


const KFCALL_RE = /<<KFCALL:(\w+)\((.*?)\)>>/gs;
const KFCHIP_TAG = "<<KFCHIP:";
// Lenient retry: if JSON.parse fails, try replacing raw newlines / tabs
// inside strings with escaped equivalents. Claude sometimes emits
// multi-line SQL in args without escaping the newlines, which is invalid
// JSON. This salvages those.
function _kfTryLenientParse(body) {
  // Walk char by char, escape any literal control char inside a string.
  let out = "";
  let inStr = false;
  let escNext = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (escNext) { out += ch; escNext = false; continue; }
    if (inStr) {
      if (ch === "\\") { out += ch; escNext = true; continue; }
      if (ch === "\"") { out += ch; inStr = false; continue; }
      if (ch === "\n") { out += "\\n"; continue; }
      if (ch === "\r") { out += "\\r"; continue; }
      if (ch === "\t") { out += "\\t"; continue; }
      out += ch;
      continue;
    }
    if (ch === "\"") { out += ch; inStr = true; continue; }
    out += ch;
  }
  try { return JSON.parse(out); } catch (_) { return null; }
}

function parseChips(text) {
  // Extract clickable-action chips from chat output. Format:
  //   <<KFCHIP:{"label":"...", "method":"...", "args":...}>>
  // Brace-counting parser (rather than regex) so a `>>` inside an SQL arg
  // doesn't terminate the marker early. Surfaces parse failures as
  // disabled chips so silent drops never happen again.
  const chips = [];
  let out = "";
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf(KFCHIP_TAG, i);
    if (start < 0) { out += text.slice(i); break; }
    out += text.slice(i, start);
    let p = start + KFCHIP_TAG.length;
    while (p < text.length && /\s/.test(text[p])) p++;
    if (text[p] !== "{") {
      // Treat as malformed; skip past the next ">>" and warn.
      const end = text.indexOf(">>", p);
      if (end < 0) { out += text.slice(start); break; }
      chips.push({ label: "\u26A0 chip parse failed (no JSON object)", method: null, _error: "expected '{' after KFCHIP:", _body: text.slice(start, end + 2) });
      i = end + 2;
      continue;
    }
    // Walk braces, respecting string boundaries (so `}` inside a quoted
    // string doesn't end the body early).
    let depth = 0;
    let inStr = false;
    let escNext = false;
    let q = p;
    for (; q < text.length; q++) {
      const ch = text[q];
      if (escNext) { escNext = false; continue; }
      if (inStr) {
        if (ch === "\\") escNext = true;
        else if (ch === "\"") inStr = false;
        continue;
      }
      if (ch === "\"") { inStr = true; continue; }
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { q++; break; } }
    }
    if (depth !== 0) {
      // Unterminated — keep the rest of the text in `out` so the user sees
      // the raw marker, and stop scanning.
      out += text.slice(start);
      break;
    }
    let r = q;
    while (r < text.length && /\s/.test(text[r])) r++;
    if (text.slice(r, r + 2) !== ">>") {
      chips.push({ label: "\u26A0 chip parse failed (missing '>>' terminator)", method: null, _error: "no '>>' after JSON body", _body: text.slice(start, r + 1) });
      i = r;
      continue;
    }
    const body = text.slice(p, q);
    let chip = null, parseErr = null;
    try { chip = JSON.parse(body); }
    catch (e) {
      parseErr = e.message || String(e);
      chip = _kfTryLenientParse(body);
    }
    if (chip && chip.label && chip.method) {
      chips.push(chip);
    } else if (chip && !chip.method) {
      chips.push({ label: chip.label || "\u26A0 chip missing method", method: null, _error: "chip JSON has no `method` field", _body: body });
    } else {
      chips.push({
        label: "\u26A0 chip parse failed",
        method: null,
        _error: parseErr || "JSON.parse returned non-object",
        _body: body.slice(0, 400),
      });
    }
    i = r + 2;
  }
  return { stripped: out, chips };
}
async function parseAndRunKfCalls(text) {
  // Strip incomplete KFCALL markers that were cut off by max_tokens truncation.
  text = text.replace(/<<KFCALL:[^>]*$/s, "").trimEnd();
  // Process tool-call markers in order. Methods may be sync or async.
  const calls = [];
  const stripped = text.replace(KFCALL_RE, (_match, method, argsStr) => {
    let args = null, err = null;
    if (argsStr.trim()) { try { args = JSON.parse(argsStr); } catch (e) { err = "invalid json args: " + e.message; } }
    calls.push({ method, args, err });
    return "";
  });
  const results = [];
  for (const c of calls) {
    if (c.err) { results.push({ call: c.method, result: { error: c.err } }); continue; }
    const fn = window.kfApi[c.method];
    if (typeof fn !== "function") { results.push({ call: c.method, result: { error: "no such method" } }); continue; }
    try {
      // JSON arrays are spread as multiple positional args
      // (`traceLineage(["Helen","Eugene"])` → `fn("Helen","Eugene")`).
      // Primitives and objects pass through as a single arg.
      const out = Array.isArray(c.args)
        ? await fn.apply(window.kfApi, c.args)
        : await fn.call(window.kfApi, c.args);
      results.push({ call: `${c.method}(${c.args === null ? "" : JSON.stringify(c.args)})`, result: out });
    } catch (e) {
      results.push({ call: c.method, result: { error: e.message || String(e) } });
    }
  }
  return { stripped: stripped.trim(), results };
}

const MAX_TOOL_ROUNDS = 10;
async function runChatTurn(userText) {
  let nextInput = userText;
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const pending = { role: "bot", content: "_thinking..._" };
    chatHistory.push(pending);
    renderChat();
    let reply;
    try {
      let sawDelta = false;
      reply = await callClaudeStream(nextInput, delta => {
        if (!sawDelta) {
          pending.content = "";
          sawDelta = true;
        }
        pending.content += delta;
        renderChat();
      }, pending);
    } catch (e) {
      const message = e?.message || String(e);
      if (typeof _kfRecordClientError === "function") {
        _kfRecordClientError({ type: "chat", message, stack: e?.stack || "" });
      }
      console.warn("[kf] Claude chat failed:", message);
      pending.content = `*[error]* ${e.message || e}`;
      renderChat();
      return;
    }
    const { stripped, results } = await parseAndRunKfCalls(reply);
    // Pull KFCHIP markers out of the (already stripped of KFCALL) text and
    // attach them to the message so renderChat shows clickable buttons.
    const chipParse = parseChips(stripped);
    pending.content = chipParse.stripped || (results.length ? "_using the data..._" : "");
    if (chipParse.chips.length) pending.chips = chipParse.chips;
    renderChat();
    if (!results.length) return;  // no tool calls -> Claude is done
    // Surface KFCALL errors visibly -- otherwise showViz failures are silent.
    const kfErrors = results.filter(r => r.result && r.result.error);
    if (kfErrors.length) {
      chatHistory.push({ role: "bot", kind: "tool", content: "*[KFCALL error]* " + kfErrors.map(r => `\`${r.call}\`: ${r.result.error}`).join("; ") });
      renderChat();
    }
    const log = results.map(r => `\u2192 ${r.call}: ${JSON.stringify(r.result)}`).join("\n");
    chatHistory.push({ role: "bot", kind: "tool", content: "*[tool calls]*\n" + log });
    renderChat();
    nextInput = "Tool results:\n" + log + "\n\nIf you have enough to answer, write the final answer now without further tool calls. Otherwise issue more tool calls.";
  }
  chatHistory.push({ role: "bot", content: `*[stopped after ${MAX_TOOL_ROUNDS} tool rounds — ask Claude to summarize what it has so far]*` });
  renderChat();
}

chatFormEl.addEventListener("submit", async e => {
  e.preventDefault();
  if (_chatBusy) return;
  const text = chatInputEl.value.trim();
  if (!text) return;
  chatInputEl.value = "";
  chatHistory.push({ role: "user", content: text });
  renderChat();
  _chatBusy = true;
  chatSendBtn.disabled = true;
  chatSendBtn.textContent = "...";
  try {
    await runChatTurn(text);
  } catch (err) {
    appendError(err.message || String(err));
  } finally {
    _chatBusy = false;
    chatSendBtn.disabled = false;
    chatSendBtn.textContent = "Send";
  }
});
chatInputEl.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    chatFormEl.requestSubmit();
  }
});
function syncToolsBtn() { $("chatTools").textContent = _chatShowTools ? "tools on" : "tools off"; }
syncToolsBtn();
$("chatTools").addEventListener("click", () => {
  _chatShowTools = !_chatShowTools;
  localStorage.setItem(CHAT_TOOLS_LS, _chatShowTools ? "1" : "0");
  syncToolsBtn();
  renderChat();
});

function autoIntroOnce() {
  if (chatHistory.length > 0) return;
  const msg = {
    role: "bot",
    content: "Here are some visualizations to explore:",
    chips: [
      { label: "Lineage clusters",   method: "setClusterMode", args: { mode: "pie" } },
      { label: "By US state",        method: "setClusterMode", args: { mode: "state" } },
      { label: "Parent knowledge",   method: "setClusterMode", args: { mode: "parents" } },
      { label: "Gender breakdown",   method: "setClusterMode", args: { mode: "gender" } },
      { label: "Connect blood kin",  method: "setKinLines",    args: { n: 5 } },
      { label: "Summarize my tree",  method: "sendChat",       args: { text: "Summarize this tree: key ancestors, geographic spread, and time range." } },
      { label: "Migration patterns", method: "sendChat",       args: { text: "What migration patterns do you see in this tree?" } },
    ],
  };
  chatHistory.push(msg);
  renderChat();
}
$("chatClear").addEventListener("click", async () => {
  chatHistory.length = 0;
  _chatNewSession = true;
  renderChat();
  // Best-effort: tell the proxy to drop its session id too.
  const proxy = await detectChatProxy();
  if (proxy) { fetch(proxy + "/reset", { method: "POST" }).catch(() => {}); }
});
renderChat();
