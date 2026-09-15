// Supabase Edge Function: drop-a-line
// Accepts contact form submissions from the WeDeepen site. Creates (or finds)
// the Circle community member, tags them "drop-a-line" + a subject tag, and
// posts the full submission into a private "Drop a Line Inbox" space so the
// team is notified and nothing is lost.
//
// Deploy:  supabase functions deploy drop-a-line --no-verify-jwt
// Public URL: https://<project-ref>.supabase.co/functions/v1/drop-a-line

// deno-lint-ignore-file no-explicit-any

const CIRCLE_API_BASE = "https://app.circle.so/api/admin/v2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Must match the <option> values in the Drop a Line form on wedeepen.com
const ALLOWED_SUBJECTS = new Set([
  "WeDeepen Membership",
  "Love Club",
  "Love Immersion",
  "Make a Request",
  "Media / Press",
  "Joining the Faculty",
  "Becoming a Love Strategist", // legacy value, kept so cached pages still submit
  "Other",
]);

function subjectToTag(subject: string): string {
  return "drop-a-line-" + subject.toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

async function createCircleMember(token: string, payload: {
  name: string;
  email: string;
  phone?: string;
  subject?: string;
  message?: string;
}) {
  // Create the community member (skip_invitation so they don't get a welcome email).
  // If they already exist Circle returns an error; we look them up instead so the
  // tag still lands.
  const memberRes = await fetch(`${CIRCLE_API_BASE}/community_members`, {
    method: "POST",
    headers: {
      "Authorization": `Token ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: payload.name,
      email: payload.email,
      skip_invitation: true,
    }),
  });
  const memberData = await memberRes.json().catch(() => ({}));
  let memberId: number | null = memberData?.community_member?.id ?? memberData?.id ?? null;

  if (!memberId) {
    const lookup = await fetch(
      `${CIRCLE_API_BASE}/community_members/search?email=${encodeURIComponent(payload.email)}`,
      { headers: { "Authorization": `Token ${token}` } },
    );
    const lookupData = await lookup.json().catch(() => ({}));
    memberId = lookupData?.community_member?.id ?? lookupData?.id ?? null;
  }

  return {
    ok: memberRes.ok,
    status: memberRes.status,
    data: memberData,
    memberId,
    tag_hint: payload.subject ? subjectToTag(payload.subject) : "drop-a-line",
  };
}

async function applyTagToMember(token: string, memberId: number, tagName: string) {
  const res = await fetch(
    `${CIRCLE_API_BASE}/community_members/${memberId}/community_member_tags`,
    {
      method: "POST",
      headers: { "Authorization": `Token ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: tagName }),
    },
  );
  return { ok: res.ok, status: res.status };
}

// ─── Inbox: every submission becomes a post in a private admin space ────
// Submissions used to be dropped on the floor (member created, message lost).
// Now the full message lands in a private "Drop a Line Inbox" space so the
// team gets Circle's new-post notification and can reply from there.

const INBOX_SLUG = "drop-a-line-inbox";
const INBOX_NAME = "Drop a Line Inbox";

function records(data: any): any[] {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.records)) return data.records;
  return [];
}

async function findOrCreateInboxSpace(token: string): Promise<number | null> {
  const override = Deno.env.get("DROP_A_LINE_SPACE_ID");
  if (override && /^\d+$/.test(override)) return Number(override);

  const headers = { "Authorization": `Token ${token}`, "Content-Type": "application/json" };

  for (let page = 1; page <= 5; page++) {
    const res = await fetch(`${CIRCLE_API_BASE}/spaces?per_page=100&page=${page}`, { headers });
    const data = await res.json().catch(() => ({}));
    const list = records(data);
    const hit = list.find((s: any) => s?.slug === INBOX_SLUG || s?.name === INBOX_NAME);
    if (hit?.id) return hit.id;
    if (list.length < 100 || data?.has_next_page === false) break;
  }

  // Not there yet: create it as a private space in the first space group.
  const groupsRes = await fetch(`${CIRCLE_API_BASE}/space_groups?per_page=100`, { headers });
  const groups = records(await groupsRes.json().catch(() => ({})));
  const groupId = groups[0]?.id;
  if (!groupId) {
    console.error("drop-a-line: no space group found to create the inbox in");
    return null;
  }
  const createRes = await fetch(`${CIRCLE_API_BASE}/spaces`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: INBOX_NAME,
      slug: INBOX_SLUG,
      space_group_id: groupId,
      is_private: true,
      visibility: "secret",
      post_type: "basic",
      hide_from_featured_areas: true,
    }),
  });
  const created = await createRes.json().catch(() => ({}));
  const id = created?.space?.id ?? created?.id ?? null;
  if (!id) console.error("drop-a-line: inbox space create failed", createRes.status, created);
  return id;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function postToInbox(token: string, spaceId: number, p: {
  name: string; email: string; phone: string; subject: string; message: string;
}) {
  const title = `${p.subject || "Other"}: ${p.name}`;
  const body =
    `<p><strong>From:</strong> ${esc(p.name)} &lt;${esc(p.email)}&gt;</p>` +
    (p.phone ? `<p><strong>Phone:</strong> ${esc(p.phone)}</p>` : "") +
    `<p><strong>Subject:</strong> ${esc(p.subject || "Other")}</p>` +
    `<p><strong>Message:</strong></p>` +
    (p.message ? p.message.split(/\n{2,}/).map((para) => `<p>${esc(para).replace(/\n/g, "<br>")}</p>`).join("") : "<p><em>(no message)</em></p>") +
    `<p><em>Sent from the Drop a Line form on wedeepen.com. Reply by email: <a href="mailto:${esc(p.email)}">${esc(p.email)}</a></em></p>`;
  const res = await fetch(`${CIRCLE_API_BASE}/posts`, {
    method: "POST",
    headers: { "Authorization": `Token ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      space_id: spaceId,
      name: title,
      body,
      status: "published",
      is_comments_enabled: true,
      is_liking_enabled: false,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) console.error("drop-a-line: inbox post failed", res.status, data);
  return { ok: res.ok, status: res.status, id: data?.post?.id ?? data?.id ?? null };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }

  try {
    const token = Deno.env.get("CIRCLE_API_TOKEN");
    if (!token) {
      return new Response(
        JSON.stringify({ error: "CIRCLE_API_TOKEN not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const body = await req.json().catch(() => ({}));
    const name = (body.name || "").toString().trim();
    const email = (body.email || "").toString().trim().toLowerCase();
    const phone = (body.phone || "").toString().trim();
    const subject = (body.subject || "").toString().trim();
    const message = (body.message || "").toString().trim();

    // Basic validation
    if (!name || !email || !email.includes("@")) {
      return new Response(
        JSON.stringify({ error: "Name and valid email are required." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    if (subject && !ALLOWED_SUBJECTS.has(subject)) {
      return new Response(
        JSON.stringify({ error: "Invalid subject." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    if (name.length > 200 || email.length > 320 || phone.length > 50 || message.length > 5000) {
      return new Response(
        JSON.stringify({ error: "Input too long." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const result = await createCircleMember(token, { name, email, phone, subject, message });

    // Tag the member so they can be filtered in Circle (drop-a-line + subject tag).
    let tagged = false;
    if (result.memberId) {
      const t1 = await applyTagToMember(token, result.memberId, "drop-a-line");
      const t2 = subject ? await applyTagToMember(token, result.memberId, subjectToTag(subject)) : { ok: true };
      tagged = t1.ok && t2.ok;
    }

    // The message itself goes to the private inbox space. This is the part
    // that matters: without it nobody ever sees what was written.
    let inbox: { ok: boolean; status: number; id: number | null } = { ok: false, status: 0, id: null };
    const spaceId = await findOrCreateInboxSpace(token);
    if (spaceId) inbox = await postToInbox(token, spaceId, { name, email, phone, subject, message });

    console.log("drop-a-line submission:", {
      name, email, phone, subject,
      message: message.slice(0, 200),
      circle_ok: result.ok, circle_status: result.status, member_id: result.memberId,
      tagged, inbox_space: spaceId, inbox_ok: inbox.ok, inbox_post: inbox.id,
    });

    // The visitor should never see a failure for a Circle hiccup as long as the
    // message reached the inbox; if the inbox failed too, say so honestly so the
    // form shows its "email us instead" fallback.
    if (!inbox.ok) {
      return new Response(
        JSON.stringify({ error: "Could not deliver message." }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ ok: true, tag: result.tag_hint, inbox_post: inbox.id }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    console.error("drop-a-line failed:", err);
    return new Response(
      JSON.stringify({ error: err?.message || "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
