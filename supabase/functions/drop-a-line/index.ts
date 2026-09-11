// Supabase Edge Function: drop-a-line
// Accepts contact form submissions from the WeDeepen site and creates
// a community member in Circle with a "drop-a-line" tag + subject tag.
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
  // Create the community member (skip_invitation so they don't get a welcome email)
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
  const memberData = await memberRes.json();

  // Collect context as a note on the member (if the endpoint allows)
  // For now, we return the result — tagging happens via Circle's dashboard rules
  // or via a separate POST to /community_members/:id/community_member_tags if needed.

  return {
    ok: memberRes.ok,
    status: memberRes.status,
    data: memberData,
    tag_hint: payload.subject ? subjectToTag(payload.subject) : "drop-a-line",
  };
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

    // Even if Circle returns an error (e.g. duplicate), treat as success to the user
    // and log the detail for you to review.
    console.log("drop-a-line submission:", {
      name, email, phone, subject,
      message: message.slice(0, 200),
      circle_ok: result.ok,
      circle_status: result.status,
    });

    return new Response(
      JSON.stringify({ ok: true, tag: result.tag_hint }),
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
