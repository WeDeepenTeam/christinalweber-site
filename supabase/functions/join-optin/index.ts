// Supabase Edge Function: join-optin
// Backend for the opt-in form on wedeepen.com/join/ (js/optin.js in
// WeDeepenTeam/wedeepen-site). Until this existed, every submission showed
// the form's "Something went wrong" message.
//
// For each submission it:
//   1. Stores a consent record (table public.optin_consents, migration in
//      wedeepen-site/supabase/migrations/20261111_optin_consents.sql): the
//      exact consent wording and its version, timestamp, IP, user agent and
//      page. This is the proof of consent behind the toll-free number's
//      carrier registration.
//   2. Email box checked: adds the person to the MailerLite group
//      "Website opt-in (/join/)" (needs the MAILERLITE_API_KEY secret).
//   3. Text box checked: adds them through the same SimpleTexting web form
//      the site popup uses, which sends the confirmation text.
//
// It answers 200 when every box the person checked went through (or the
// contact was already on that list), so the form shows "You're in". If a
// requested list fails, it answers 502 and the form tells them to text
// COUNT ME IN instead; the consent record is still kept for follow-up.
//
// Deploy:  supabase functions deploy join-optin --no-verify-jwt
// Secret:  supabase secrets set MAILERLITE_API_KEY=...
// Public URL: https://oycfonjaufdihuwjecxu.supabase.co/functions/v1/join-optin

// deno-lint-ignore-file no-explicit-any

const MAILERLITE_GROUP_ID = "203847096002938619"; // "Website opt-in (/join/)"
const ST_ENDPOINT = "https://app2.simpletexting.com/join/joinContact";
const ST_WEBFORM_ID = "6a725eb22813b371a658bdc9"; // "WebSite Pop-up" web form (same as the site popup)

const ALLOWED_ORIGINS = new Set([
  "https://wedeepen.com",
  "https://www.wedeepen.com",
]);

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  const allowed = ALLOWED_ORIGINS.has(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return {
    "Access-Control-Allow-Origin": allowed ? origin : "https://wedeepen.com",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(req: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(req), "Content-Type": "application/json" },
  });
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

async function saveConsent(row: Record<string, unknown>): Promise<{ ok: boolean; id?: string; error?: string }> {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return { ok: false, error: "supabase env missing" };
  const res = await fetch(`${url}/rest/v1/optin_consents`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(row),
  });
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}` };
  const data = await res.json().catch(() => []);
  return { ok: true, id: data?.[0]?.id };
}

async function updateConsent(id: string, patch: Record<string, unknown>) {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return;
  await fetch(`${url}/rest/v1/optin_consents?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  }).catch((e) => console.error("join-optin: consent update failed", e));
}

async function addToMailerLite(firstName: string, email: string, phone: string | null): Promise<string> {
  const key = Deno.env.get("MAILERLITE_API_KEY");
  if (!key) return "error: MAILERLITE_API_KEY not set";
  const fields: Record<string, string> = { name: firstName };
  if (phone) fields.phone = phone;
  // Upsert: adds the group without removing any groups they're already in.
  const res = await fetch("https://connect.mailerlite.com/api/subscribers", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ email, fields, groups: [MAILERLITE_GROUP_ID], status: "active" }),
  });
  if (res.ok) return res.status === 201 ? "added" : "updated";
  return `error: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`;
}

async function addToSimpleTexting(firstName: string, email: string, phoneE164: string): Promise<string> {
  const fieldValues: Record<string, string> = {
    phone: phoneE164.replace(/^\+1/, ""),
    firstname: firstName,
  };
  if (email) fieldValues.email = email;
  const res = await fetch(ST_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify({ webFormId: ST_WEBFORM_ID, fieldValues, listIds: [] }),
  });
  if (res.ok) return "added";
  const text = await res.text();
  let err: any = {};
  try { err = JSON.parse(text); } catch { /* not JSON */ }
  if (err.code === "DuplicateContactPhoneException") return "already on list";
  return `error: HTTP ${res.status} ${err.code || text.slice(0, 200)}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, 405, { error: "Method not allowed" });

  try {
    const body: any = await req.json().catch(() => ({}));

    const firstName = str(body.first_name, 100);
    const email = str(body.email, 320).toLowerCase();
    const phoneE164 = str(body.phone_e164, 20) || null;
    const emailConsent = body.email_consent === true;
    const smsConsent = body.sms_consent === true;

    // Same rules as the form (js/optin.js).
    if (!firstName) return json(req, 400, { error: "First name is required." });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return json(req, 400, { error: "Valid email is required." });
    if (phoneE164 && !/^\+1\d{10}$/.test(phoneE164)) return json(req, 400, { error: "Phone must be a 10-digit US number." });
    if (smsConsent && !phoneE164) return json(req, 400, { error: "Phone is required for text consent." });

    const ip = (req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for") || "")
      .split(",")[0].trim() || null;

    const saved = await saveConsent({
      first_name: firstName,
      email,
      phone_e164: phoneE164,
      email_consent: emailConsent,
      sms_consent: smsConsent,
      consent_language_version: str(body.consent_language_version, 40) || null,
      consent_language_text: str(body.consent_language_text, 2000) || null,
      source_url: str(body.source_url, 500) || null,
      user_agent: str(body.user_agent, 500) || req.headers.get("user-agent")?.slice(0, 500) || null,
      client_timestamp: str(body.timestamp, 40) || null,
      ip_address: ip,
    });
    if (!saved.ok) console.error("join-optin: consent record not saved", saved.error);

    const [mailerlite, simpletexting] = await Promise.all([
      emailConsent ? addToMailerLite(firstName, email, phoneE164).catch((e) => `error: ${e?.message || e}`) : Promise.resolve(null),
      smsConsent && phoneE164 ? addToSimpleTexting(firstName, email, phoneE164).catch((e) => `error: ${e?.message || e}`) : Promise.resolve(null),
    ]);

    if (saved.ok && saved.id) await updateConsent(saved.id, { mailerlite_status: mailerlite, simpletexting_status: simpletexting });

    const failed = [mailerlite, simpletexting].some((s) => typeof s === "string" && s.startsWith("error"));
    console.log("join-optin:", { email_consent: emailConsent, sms_consent: smsConsent, consent_saved: saved.ok, mailerlite, simpletexting });

    // Nothing requested and nothing stored means nothing happened at all.
    if (failed || (!saved.ok && !emailConsent && !smsConsent)) {
      return json(req, 502, { ok: false, mailerlite, simpletexting });
    }
    return json(req, 200, { ok: true, mailerlite, simpletexting });
  } catch (err: any) {
    console.error("join-optin failed:", err);
    return json(req, 500, { error: "Unexpected error" });
  }
});
