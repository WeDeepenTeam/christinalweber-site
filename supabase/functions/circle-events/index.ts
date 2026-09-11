// Supabase Edge Function: circle-events
// Proxies Circle API to serve live events to the WeDeepen site.
// Holds CIRCLE_API_TOKEN server-side (never exposed to browser).
//
// Deploy:  supabase functions deploy circle-events --no-verify-jwt
// Public URL: https://<project-ref>.supabase.co/functions/v1/circle-events

// deno-lint-ignore-file no-explicit-any

const CIRCLE_API = "https://app.circle.so/api/admin/v2/events";
const CIRCLE_TOPICS_API = "https://app.circle.so/api/admin/v2/topics";
const CIRCLE_COMMUNITY_URL = "https://circle.wedeepen.com";
const PER_PAGE = 100;
// Cache for 60 seconds so repeat page loads don't hammer Circle
const CACHE_TTL_SECONDS = 60;
// Recurring series run out for years; only return the next 12 months
const HORIZON_MS = 365 * 24 * 60 * 60 * 1000;

interface CircleEvent {
  slug: string;
  name: string;
  starts_at: string;
  ends_at: string | null;
  location_type: string;
  in_person_location: string | null;
  cover_image_url: string | null;
  body: string | null;
  confirmation_message_title: string | null;
  topics?: number[]; // Circle topic ids; resolved to names via /topics
  space?: { id: number; slug: string; name: string; community_id: number } | null;
}

// Only events in this Circle space appear on the site.
// This is the "Member's Calendar" space under the WeDeepen space group
// (https://circle.wedeepen.com/c/member-s-calendar). The old
// "events-calendar" space under "WeDeepen (old)" is no longer synced.
const ALLOWED_SPACE_SLUG = "member-s-calendar";

interface NormalizedEvent {
  id: string;
  title: string;
  date: string; // Central Time (YYYY-MM-DD), used as primary sort + date label fallback
  end_date: string | null;
  time: string; // Pre-formatted Central Time string, fallback if frontend can't use ISO
  starts_at_iso: string; // Raw UTC ISO, for client-side local-time conversion
  ends_at_iso: string | null;
  location_type: "austin" | "online";
  location_label: string;
  tag: string;
  topics: string[]; // Circle topic names, e.g. "Love Club", "WeDeepen Members", "In-Person"
  recurring: boolean; // true when this event is one occurrence of a repeating series
  series: string; // shared key for every occurrence of a series (the slug minus its hex suffix)
  description: string;
  image_url: string;
  url: string;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function pad(s: string) {
  return s;
}

// Convert UTC ISO datetime to Central Time formatted values.
// All WeDeepen events are anchored in Austin, TX — the event's wall-clock
// time in Austin is what members care about.
const TZ = "America/Chicago";

function formatTime(iso: string): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString("en-US", {
      timeZone: TZ,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return "";
  }
}

function toISODateCT(iso: string): string {
  if (!iso) return "";
  try {
    // en-CA yields "YYYY-MM-DD"
    return new Date(iso).toLocaleDateString("en-CA", { timeZone: TZ });
  } catch {
    return iso.substring(0, 10);
  }
}

async function fetchAllEvents(token: string): Promise<CircleEvent[]> {
  const all: CircleEvent[] = [];
  let page = 1;
  // Hard cap at 20 pages (2000 events) to prevent runaway
  while (page <= 20) {
    const res = await fetch(`${CIRCLE_API}?per_page=${PER_PAGE}&page=${page}`, {
      headers: {
        Authorization: `Token ${token}`,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) {
      throw new Error(`Circle API returned ${res.status} on page ${page}`);
    }
    const data = await res.json();
    all.push(...(data.records || []));
    if (!data.has_next_page) break;
    page++;
  }
  return all;
}

// Circle expands recurring events into one record per occurrence, each with
// the series slug plus a 6-char hex suffix (office-hours-b0056a, -6d8c9c, ...).
// Strip the suffix to get a key shared by every occurrence in the series.
function seriesKey(slug: string): string {
  return slug.replace(/-[0-9a-f]{6}$/, "");
}

// Topic ids -> names. Topics are how the calendar is categorized in Circle
// (Love Club, WeDeepen Members, In-Person, Office Hours, ...) and drive the
// filter buttons on wedeepen.com/events.
async function fetchTopicNames(token: string): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  try {
    const res = await fetch(`${CIRCLE_TOPICS_API}?per_page=100`, {
      headers: { Authorization: `Token ${token}` },
    });
    if (!res.ok) return map;
    const data = await res.json();
    for (const t of data.records || []) {
      if (t.id && t.name) map.set(t.id, String(t.name).trim());
    }
  } catch { /* topics are optional; events still render without them */ }
  return map;
}

function normalize(events: CircleEvent[], topicNames: Map<number, string>): NormalizedEvent[] {
  const now = Date.now();
  const seen = new Set<string>();
  const out: NormalizedEvent[] = [];

  // Sort by start time so occurrences come out in calendar order
  const sorted = [...events].sort((a, b) =>
    (a.starts_at || "").localeCompare(b.starts_at || "")
  );

  // Count occurrences per series so we can flag recurring events
  const seriesCount = new Map<string, number>();
  for (const e of sorted) {
    if (!e.space || e.space.slug !== ALLOWED_SPACE_SLUG || !e.slug) continue;
    const k = seriesKey(e.slug);
    seriesCount.set(k, (seriesCount.get(k) || 0) + 1);
  }

  for (const e of sorted) {
    // Filter: only include events from the Member's Calendar space,
    // not "Official Events" or other internal spaces
    if (!e.space || e.space.slug !== ALLOWED_SPACE_SLUG) continue;

    const starts = e.starts_at || "";
    const ends = e.ends_at || "";
    const endTime = ends ? new Date(ends).getTime() : new Date(starts).getTime();
    if (isNaN(endTime) || endTime < now) continue;
    const startTime = new Date(starts).getTime();
    if (!isNaN(startTime) && startTime > now + HORIZON_MS) continue;

    // Every occurrence of a recurring series is returned; the site decides
    // whether to show them all (events page) or one per series (homepage).
    const slug = e.slug || "";
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const series = seriesKey(slug);
    const recurring = (seriesCount.get(series) || 0) > 1;

    let location_type: "austin" | "online" = "austin";
    let location_label = "Austin, TX";
    const locType = e.location_type || "";
    if (locType === "in_person") {
      location_type = "austin";
      try {
        const parsed = JSON.parse(e.in_person_location || "{}");
        location_label = parsed.formatted_address || "Austin, TX";
      } catch { /* default */ }
    } else if (locType === "virtual" || locType === "live_room") {
      location_type = "online";
      location_label = "Online";
    }

    let tag = "";
    const confTitle = (e.confirmation_message_title || "").toLowerCase();
    const name = e.name || "";
    if (confTitle.includes("member") || name.toLowerCase().includes("included")) {
      tag = "Included for Members";
    }

    const body = (e.body || "").substring(0, 200).replace(/\n/g, " ").trim();
    const startDate = toISODateCT(starts);
    const endDate = ends && toISODateCT(ends) !== startDate ? toISODateCT(ends) : null;

    out.push({
      id: slug,
      title: name,
      date: startDate,
      end_date: endDate,
      time: formatTime(starts),
      starts_at_iso: starts,
      ends_at_iso: ends || null,
      location_type,
      location_label,
      tag,
      topics: (e.topics || []).map((id) => topicNames.get(id)).filter((n): n is string => !!n),
      recurring,
      series,
      description: body || name,
      image_url: e.cover_image_url || "",
      url: `${CIRCLE_COMMUNITY_URL}/c/${e.space.slug}/${slug}`,
    });
  }

  out.sort((a, b) => a.starts_at_iso.localeCompare(b.starts_at_iso));
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const token = Deno.env.get("CIRCLE_API_TOKEN");
    if (!token) {
      return new Response(
        JSON.stringify({ error: "CIRCLE_API_TOKEN not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const [raw, topicNames] = await Promise.all([fetchAllEvents(token), fetchTopicNames(token)]);
    const events = normalize(raw, topicNames);

    const body = {
      last_updated: new Date().toISOString(),
      source: "circle.wedeepen.com",
      event_count: events.length,
      events,
    };

    return new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        // Browser cache for 60s, CDN cache for 300s
        "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}, s-maxage=300, stale-while-revalidate=600`,
      },
    });
  } catch (err: any) {
    console.error("Circle events fetch failed:", err);
    return new Response(
      JSON.stringify({ error: err?.message || "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
