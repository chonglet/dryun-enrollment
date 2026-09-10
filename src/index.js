import Stripe from "stripe";
import { validateAndPriceMembers, CATEGORIES } from "./pricing.js";
import { signEnrollment, verifyEnrollment } from "./token.js";

const SIGNWELL_ENDPOINT = "https://www.signwell.com/api/v1/document_templates/documents";
const WORKER_ORIGIN = "https://dryun-enrollment.chonglet.workers.dev";

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonResponse(data, status, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(env) },
  });
}

function getStripe(env) {
  return new Stripe(env.STRIPE_SECRET_KEY, {
    httpClient: Stripe.createFetchHttpClient(),
  });
}

function nowISO() {
  return new Date().toISOString();
}

async function handleCreateEnrollment(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid request body." }, 400, env);
  }

  let members;
  try {
    members = validateAndPriceMembers(body?.members);
  } catch (err) {
    return jsonResponse({ error: err.message }, 400, env);
  }

  const enrollmentId = "ENR-" + Math.random().toString(36).slice(2, 8).toUpperCase();

  const token = await signEnrollment(
    {
      enrollmentId,
      members: members.map((m) => ({ name: m.name, category: m.category, categoryLabel: m.categoryLabel })),
    },
    env.TOKEN_SECRET
  );

  const url = new URL(request.url);
  const payUrl = `${url.origin}/api/pay?token=${encodeURIComponent(token)}`;

  const templateEnvByCategory = {
    adult: "SIGNWELL_TEMPLATE_ADULT",
    family: "SIGNWELL_TEMPLATE_FAMILY",
    child: "SIGNWELL_TEMPLATE_CHILD",
  };

  const signingDocuments = [];

  for (const m of members) {
    const templateId = env[templateEnvByCategory[m.category]];
    if (!templateId) {
      return jsonResponse({ error: `Missing configured template for ${m.category}.` }, 500, env);
    }

    const signwellBody = {
      test_mode: env.SIGNWELL_TEST_MODE === "true",
      template_ids: [templateId],
      recipients: [
        {
          id: "1",
          name: m.name,
          email: m.email,
          placeholder_name: "Patient",
        },
      ],
      draft: false,
      embedded_signing: true,
      metadata: { enrollment_id: enrollmentId, member_name: m.name },
    };

    try {
      const swRes = await fetch(SIGNWELL_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": env.SIGNWELL_API_KEY,
        },
        body: JSON.stringify(signwellBody),
      });

      const swData = await swRes.json();

      if (!swRes.ok) {
        console.error("SignWell error:", JSON.stringify(swData));
        return jsonResponse(
          { error: `Could not create the agreement for ${m.name}. Please try again or contact the office.` },
          502,
          env
        );
      }

      const signingUrl = swData.recipients?.[0]?.embedded_signing_url || swData.embedded_signing_url;

      if (!signingUrl) {
        console.error("No signing URL in SignWell response:", JSON.stringify(swData));
        return jsonResponse({ error: "Could not retrieve a signing link. Please contact the office." }, 502, env);
      }

      signingDocuments.push({ name: m.name, signingUrl });
    } catch (err) {
      console.error(err);
      return jsonResponse({ error: "Unexpected error creating the enrollment." }, 500, env);
    }
  }

  try {
    const primary = members.find((m) => m.isPrimary);
    const memberNames = members.map((m) => m.name).join(", ");
    const ts = nowISO();

    await env.DB.prepare(
      `INSERT INTO enrollments
        (enrollment_id, created_at, primary_name, primary_email, member_names, member_count, signing_status, members_signed, payment_status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, 'unpaid', ?)`
    )
      .bind(enrollmentId, ts, primary?.name || "", primary?.email || "", memberNames, members.length, ts)
      .run();

    for (const m of members) {
      await env.DB.prepare(
        `INSERT INTO enrollment_members (enrollment_id, member_name, category, signing_status)
         VALUES (?, ?, ?, 'sent')`
      )
        .bind(enrollmentId, m.name, m.category)
        .run();
    }
  } catch (err) {
    console.error("D1 write failed on create-enrollment:", err);
  }

  return jsonResponse({ enrollmentId, payUrl, signingDocuments }, 200, env);
}

async function handlePay(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token) return new Response("Missing enrollment token.", { status: 400 });

  let enrollment;
  try {
    enrollment = await verifyEnrollment(token, env.TOKEN_SECRET);
  } catch {
    return Response.redirect(`${env.CANCEL_URL}?error=expired_link`, 302);
  }

  try {
    const existing = await env.DB.prepare(
      `SELECT payment_status FROM enrollments WHERE enrollment_id = ?`
    )
      .bind(enrollment.enrollmentId)
      .first();

    if (existing && existing.payment_status === "paid") {
      return Response.redirect(`${env.SUCCESS_URL}?enrollment=${enrollment.enrollmentId}`, 302);
    }
  } catch (err) {
    console.error("D1 read failed on handlePay pre-check:", err);
  }

  try {
    const priceGroups = {};
    for (const m of enrollment.members) {
      const priceId = env[CATEGORIES[m.category].stripePriceEnv];
      if (!priceId) throw new Error(`Missing configured price for ${m.category}.`);
      priceGroups[priceId] = (priceGroups[priceId] || 0) + 1;
    }
    const lineItems = Object.entries(priceGroups).map(([price, quantity]) => ({
      price,
      quantity,
    }));

    const stripe = getStripe(env);

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: lineItems,
      success_url: `${env.SUCCESS_URL}?enrollment=${enrollment.enrollmentId}`,
      cancel_url: env.CANCEL_URL,
      metadata: {
        enrollment_id: enrollment.enrollmentId,
        member_names: enrollment.members.map((m) => m.name).join(", "),
      },
    });

    try {
      await env.DB.prepare(
        `UPDATE enrollments SET stripe_session_id = ?, updated_at = ? WHERE enrollment_id = ?`
      )
        .bind(session.id, nowISO(), enrollment.enrollmentId)
        .run();
    } catch (err) {
      console.error("D1 write failed recording session id:", err);
    }

    return Response.redirect(session.url, 303);
  } catch (err) {
    console.error(err);
    return new Response(
      "Something went wrong setting up payment. Please contact the office — your agreement is signed, nothing was charged.",
      { status: 500 }
    );
  }
}

async function handleStripeWebhook(request, env) {
  const sig = request.headers.get("stripe-signature");
  const rawBody = await request.text();
  const stripe = getStripe(env);

  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(rawBody, sig, env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Stripe webhook signature verification failed:", err.message);
    return new Response(`Webhook Error: ${err.message}`, { status: 400 });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const enrollmentId = session.metadata?.enrollment_id;
    console.log(`Enrollment ${enrollmentId} paid. Members: ${session.metadata?.member_names}`);

    if (enrollmentId) {
      try {
        const ts = nowISO();
        await env.DB.prepare(
          `UPDATE enrollments
           SET payment_status = 'paid', paid_at = ?, stripe_subscription_id = ?, updated_at = ?
           WHERE enrollment_id = ?`
        )
          .bind(ts, session.subscription || null, ts, enrollmentId)
          .run();
      } catch (err) {
        console.error("D1 write failed on stripe webhook:", err);
      }
    }
  }

  return jsonResponse({ received: true }, 200, env);
}

async function handleSignwellWebhook(request, env) {
  let event;
  try {
    event = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid payload" }, 400, env);
  }

  const eventType = event?.event?.type;
  const metadata = event?.data?.object?.metadata;
  console.log("SignWell event:", eventType, JSON.stringify(metadata));

  const enrollmentId = metadata?.enrollment_id;
  const memberName = metadata?.member_name;

  if (enrollmentId && memberName && eventType === "document_completed") {
    try {
      const ts = nowISO();

      await env.DB.prepare(
        `UPDATE enrollment_members
         SET signing_status = 'completed', signed_at = ?
         WHERE enrollment_id = ? AND member_name = ?`
      )
        .bind(ts, enrollmentId, memberName)
        .run();

      const remaining = await env.DB.prepare(
        `SELECT COUNT(*) as cnt FROM enrollment_members WHERE enrollment_id = ? AND signing_status != 'completed'`
      )
        .bind(enrollmentId)
        .first();

      const signedCountRow = await env.DB.prepare(
        `SELECT COUNT(*) as cnt FROM enrollment_members WHERE enrollment_id = ? AND signing_status = 'completed'`
      )
        .bind(enrollmentId)
        .first();

      const allSigned = remaining && remaining.cnt === 0;

      await env.DB.prepare(
        `UPDATE enrollments
         SET members_signed = ?, signing_status = ?, all_signed_at = CASE WHEN ? THEN ? ELSE all_signed_at END, updated_at = ?
         WHERE enrollment_id = ?`
      )
        .bind(
          signedCountRow?.cnt || 0,
          allSigned ? "completed" : "in_progress",
          allSigned ? 1 : 0,
          ts,
          ts,
          enrollmentId
        )
        .run();
    } catch (err) {
      console.error("D1 write failed on signwell webhook:", err);
    }
  }

  return jsonResponse({ received: true }, 200, env);
}

async function handleAdminEnrollments(request, env) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key");

  if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) {
    return new Response("Unauthorized", { status: 401 });
  }

  let rows;
  try {
    const result = await env.DB.prepare(
      `SELECT enrollment_id, created_at, primary_name, primary_email, member_names, member_count,
              signing_status, members_signed, all_signed_at, payment_status, paid_at, reminder_sent_at
       FROM enrollments
       ORDER BY created_at DESC
       LIMIT 200`
    ).all();
    rows = result.results || [];
  } catch (err) {
    console.error("D1 read failed on admin view:", err);
    return new Response("Database error.", { status: 500 });
  }

  const escapeHtml = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const statusBadge = (row) => {
    if (row.payment_status === "paid") return `<span style="color:#1a7f37;font-weight:600;">Paid</span>`;
    if (row.signing_status === "completed") {
      const reminder = row.reminder_sent_at
        ? `<br><span style="color:#766f5a;font-size:0.8em;">Reminder sent ${escapeHtml(row.reminder_sent_at)}</span>`
        : "";
      return `<span style="color:#b3402f;font-weight:600;">Signed — Not Paid</span>${reminder}`;
    }
    return `<span style="color:#766f5a;">Signing in progress (${row.members_signed}/${row.member_count})</span>`;
  };

  const tableRows = rows
    .map(
      (row) => `
    <tr>
      <td>${escapeHtml(row.created_at)}</td>
      <td>${escapeHtml(row.primary_name)}<br><span style="color:#766f5a;font-size:0.85em;">${escapeHtml(row.primary_email)}</span></td>
      <td>${escapeHtml(row.member_names)}</td>
      <td>${statusBadge(row)}</td>
      <td>${escapeHtml(row.paid_at) || "—"}</td>
      <td style="font-family:monospace;font-size:0.85em;">${escapeHtml(row.enrollment_id)}</td>
    </tr>`
    )
    .join("");

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<title>Enrollments | Dr. Yun</title>
<style>
  body { font-family: -apple-system, Arial, sans-serif; padding: 32px; background: #f8f2e6; color: #201d16; }
  h1 { font-size: 1.4rem; }
  table { border-collapse: collapse; width: 100%; background: #fff; box-shadow: 0 4px 12px rgba(0,0,0,0.06); }
  th, td { text-align: left; padding: 10px 14px; border-bottom: 1px solid #ddc79a; font-size: 0.9rem; vertical-align: top; }
  th { background: #12141b; color: #fff; font-weight: 500; }
  tr:hover { background: #fdfaf2; }
</style>
</head>
<body>
  <h1>Enrollments (most recent 200)</h1>
  <table>
    <thead>
      <tr><th>Created</th><th>Primary</th><th>Household</th><th>Status</th><th>Paid At</th><th>Enrollment ID</th></tr>
    </thead>
    <tbody>
      ${tableRows || '<tr><td colspan="6">No enrollments yet.</td></tr>'}
    </tbody>
  </table>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

async function checkAndSendReminders(env) {
     const twoHoursAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString(); // TEMP: 2 min for testing

  const result = await env.DB.prepare(
    `SELECT enrollment_id, primary_name, primary_email, member_count
     FROM enrollments
     WHERE signing_status = 'completed'
       AND payment_status = 'unpaid'
       AND created_at <= ?
       AND reminder_sent_at IS NULL`
  )
    .bind(twoHoursAgo)
    .all();

  const stale = result.results || [];

  for (const enrollment of stale) {
    const membersResult = await env.DB.prepare(
      `SELECT member_name, category FROM enrollment_members WHERE enrollment_id = ?`
    )
      .bind(enrollment.enrollment_id)
      .all();

    const members = (membersResult.results || []).map((m) => ({
      name: m.member_name,
      category: m.category,
    }));

    const token = await signEnrollment(
      { enrollmentId: enrollment.enrollment_id, members },
      env.TOKEN_SECRET
    );
    const payUrl = `${WORKER_ORIGIN}/api/pay?token=${encodeURIComponent(token)}`;

    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
        },
        body: JSON.stringify({
          from: "Chong Yun, MD <noreply@dryun.org>",
          to: enrollment.primary_email,
          subject: "Finish setting up your Chong Yun, MD membership",
          html: `
            <p>Hi ${enrollment.primary_name},</p>
            <p>Your membership agreement${enrollment.member_count > 1 ? "s are" : " is"} signed — the only step left is completing payment.</p>
            <p><a href="${payUrl}">Click here to finish enrolling</a></p>
            <p>If you have any questions, feel free to reply to this email or contact the office directly.</p>
          `,
        }),
      });

      if (res.ok) {
        await env.DB.prepare(
          `UPDATE enrollments SET reminder_sent_at = ? WHERE enrollment_id = ?`
        )
          .bind(nowISO(), enrollment.enrollment_id)
          .run();
        console.log(`Reminder sent for ${enrollment.enrollment_id}`);
      } else {
        console.error(`Resend error for ${enrollment.enrollment_id}:`, await res.text());
      }
    } catch (err) {
      console.error(`Failed to send reminder for ${enrollment.enrollment_id}:`, err);
    }
  }
}

async function handleReserve(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid request body." }, 400, env);
  }

  const first_name = (body?.first_name || "").trim();
  const last_name = (body?.last_name || "").trim();
  const email = (body?.email || "").trim();
  const phone = (body?.phone || "").trim();
  const texas_resident = (body?.texas_resident || "").trim();

  if (!first_name || !last_name || !email) {
    return jsonResponse({ error: "Missing required fields." }, 400, env);
  }

  const ts = nowISO();

  try {
    await env.DB.prepare(
      `INSERT INTO reservations (created_at, first_name, last_name, email, phone, texas_resident, email_sent)
       VALUES (?, ?, ?, ?, ?, ?, 0)`
    )
      .bind(ts, first_name, last_name, email, phone, texas_resident)
      .run();
  } catch (err) {
    console.error("D1 write failed on reserve:", err);
  }

  const enrollUrl = "https://dryun.org/enroll.html";

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: "Chong Yun, MD <noreply@dryun.org>",
        to: email,
        subject: "Thank you for reserving your Founding Membership spot",
        html: `
          <p>Hi ${first_name},</p>
          <p>Thank you for your interest in becoming a Founding Member with Chong "Joy" Yun, MD. I've received your information and will follow up personally to confirm next steps.</p>
          <p>Whenever you're ready, you can go ahead and start your enrollment here:</p>
          <p><a href="${enrollUrl}">Begin Enrollment</a></p>
          <p>If you have any questions in the meantime, feel free to reply to this email or contact the office directly.</p>
        `,
      }),
    });

    if (res.ok) {
      await env.DB.prepare(
        `UPDATE reservations SET email_sent = 1 WHERE email = ? AND created_at = ?`
      )
        .bind(email, ts)
        .run();
    } else {
      console.error("Resend error on reserve confirmation:", await res.text());
    }
  } catch (err) {
    console.error("Failed to send reservation confirmation email:", err);
  }

  return jsonResponse({ received: true }, 200, env);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    try {
      if (pathname === "/api/create-enrollment" && request.method === "POST") {
        return await handleCreateEnrollment(request, env);
      }
      if (pathname === "/api/pay" && request.method === "GET") {
        return await handlePay(request, env);
      }
      if (pathname === "/api/webhooks/stripe" && request.method === "POST") {
        return await handleStripeWebhook(request, env);
      }
      if (pathname === "/api/webhooks/signwell" && request.method === "POST") {
        return await handleSignwellWebhook(request, env);
      }
      if (pathname === "/api/admin/enrollments" && request.method === "GET") {
        return await handleAdminEnrollments(request, env);
      }
      if (pathname === "/api/reserve" && request.method === "POST") {
        return await handleReserve(request, env);
      }
      return new Response("Not found", { status: 404 });
    } catch (err) {
      console.error(err);
      return jsonResponse({ error: "Unexpected server error." }, 500, env);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkAndSendReminders(env));
  },
};
