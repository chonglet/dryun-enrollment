import Stripe from "stripe";
import { validateAndPriceMembers, CATEGORIES } from "./pricing.js";
import { signEnrollment, verifyEnrollment } from "./token.js";

const SIGNWELL_ENDPOINT = "https://www.signwell.com/api/v1/document_templates/documents";

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
    // Group members by their Stripe price ID so duplicate categories (e.g. two
    // adults) become a single line item with quantity > 1, rather than two
    // separate line items referencing the same recurring price — Stripe
    // rejects the latter for subscriptions.
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
    console.log(`Enrollment ${session.metadata?.enrollment_id} paid. Members: ${session.metadata?.member_names}`);
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

  console.log("SignWell event:", event?.event?.type, JSON.stringify(event?.data?.object?.metadata));

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
      return new Response("Not found", { status: 404 });
    } catch (err) {
      console.error(err);
      return jsonResponse({ error: "Unexpected server error." }, 500, env);
    }
  },
};
