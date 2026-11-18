// Z Assistant reminder sender.
// Called every minute by pg_cron. Sends task reminders and the daily "plan your day" nudge.
// Also answers the app: GET ?vapid=1 returns the public notification key, POST {test} sends a test.
import webpush from "npm:web-push@3.6.7";
import postgres from "npm:postgres@3.4.4";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 2, prepare: false });
const SUBJECT = "https://xeeshanwolf.github.io/z-assistant/";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

let keys: { publicKey: string; privateKey: string } | null = null;
async function vapid() {
  if (keys) return keys;
  const rows = await sql`select name, value from private.app_keys where name in ('vapid_public','vapid_private')`;
  const got = Object.fromEntries(rows.map((r) => [r.name, r.value]));
  if (got.vapid_public && got.vapid_private) {
    keys = { publicKey: got.vapid_public, privateKey: got.vapid_private };
  } else {
    const k = webpush.generateVAPIDKeys();
    await sql`insert into private.app_keys (name, value) values ('vapid_public', ${k.publicKey}), ('vapid_private', ${k.privateKey})
              on conflict (name) do nothing`;
    const again = await sql`select name, value from private.app_keys where name in ('vapid_public','vapid_private')`;
    const g = Object.fromEntries(again.map((r) => [r.name, r.value]));
    keys = { publicKey: g.vapid_public, privateKey: g.vapid_private };
  }
  webpush.setVapidDetails(SUBJECT, keys.publicKey, keys.privateKey);
  return keys;
}

async function sendTo(userId: string, payload: Record<string, unknown>) {
  const subs = await sql`select endpoint, sub from public.push_subs where user_id = ${userId}`;
  let sent = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(s.sub, JSON.stringify(payload), { TTL: 3600, urgency: "high" });
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await sql`delete from public.push_subs where endpoint = ${s.endpoint}`;
      else console.error("push failed", code, String(e).slice(0, 200));
    }
  }
  return sent;
}

function localNow(tz: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz || "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const hh = p.hour === "24" ? "00" : p.hour;
  return { date: `${p.year}-${p.month}-${p.day}`, mins: Number(hh) * 60 + Number(p.minute) };
}

async function runReminders() {
  const due = await sql`
    select user_id, id, data, remind_at from public.items
    where remind_at <= now() and deleted = false
      and (notified_for is null or notified_for <> remind_at)
      and coalesce((data->>'done')::boolean, false) = false
    order by remind_at limit 200`;
  let sent = 0;
  for (const r of due) {
    const late = Date.now() - new Date(r.remind_at).getTime();
    if (late < 6 * 3600_000) {
      sent += await sendTo(r.user_id, {
        title: r.data?.kind === "idea" ? "Idea reminder" : "Reminder",
        body: String(r.data?.text || "You set a reminder").slice(0, 180),
        tag: "task-" + r.id,
        url: "./#task-" + r.id,
      });
    }
    await sql`update public.items set notified_for = remind_at where user_id = ${r.user_id} and id = ${r.id} and remind_at = ${r.remind_at}`;
  }
  return { due: due.length, sent };
}

async function runDaily() {
  const rows = await sql`select user_id, name, daily_at, tz, last_daily from public.settings where daily_at is not null and daily_at <> ''`;
  let sent = 0;
  for (const s of rows) {
    const [h, m] = String(s.daily_at).split(":").map(Number);
    if (Number.isNaN(h)) continue;
    const now = localNow(s.tz || "UTC");
    const target = h * 60 + (m || 0);
    const last = s.last_daily ? new Date(s.last_daily).toISOString().slice(0, 10) : "";
    if (now.mins < target || now.mins > target + 30 || last === now.date) continue;
    const [{ n }] = await sql`
      select count(*)::int as n from public.items
      where user_id = ${s.user_id} and deleted = false and data->>'kind' = 'task'
        and coalesce((data->>'done')::boolean, false) = false
        and ((data->>'due') <> '' and (data->>'due') <= ${now.date})`;
    const who = s.name ? `${s.name}, ` : "";
    sent += await sendTo(s.user_id, {
      title: "Plan your day",
      body: n ? `${who}${n} task${n === 1 ? " is" : "s are"} due. Pick your top 3.` : `${who}pick your top 3 for today.`,
      tag: "daily-plan",
      url: "./#today",
    });
    await sql`update public.settings set last_daily = ${now.date} where user_id = ${s.user_id}`;
  }
  return { daily: sent };
}

async function tidy() {
  // Deleted items are kept 30 days so every phone hears about the delete, then removed.
  await sql`delete from public.items where deleted = true and updated_at < now() - interval '30 days'`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = new URL(req.url);
    const k = await vapid();
    if (req.method === "GET") {
      if (url.searchParams.has("vapid")) return json({ publicKey: k.publicKey });
      const [{ ok }] = await sql`select 1 as ok`;
      return json({ ok: ok === 1 });
    }
    const body = await req.json().catch(() => ({}));
    if (body && typeof body.test === "string") {
      const rows = await sql`select user_id from public.push_subs where endpoint = ${body.test}`;
      if (!rows.length) return json({ sent: 0, error: "This phone is not registered for notifications yet." }, 404);
      const sent = await sendTo(rows[0].user_id, {
        title: "Z Assistant", body: "Notifications are working on this phone.", tag: "test", url: "./#today",
      });
      return json({ sent });
    }
    const a = await runReminders();
    const b = await runDaily();
    if (new Date().getUTCMinutes() === 7) await tidy();
    return json({ ...a, ...b });
  } catch (e) {
    console.error(e);
    return json({ error: String(e).slice(0, 300) }, 500);
  }
});
