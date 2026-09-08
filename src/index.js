import Stripe from 'stripe';
import { validateAndPriceMembers, CATEGORIES } from './pricing.js';
import { signEnrollment, verifyEnrollment } from './token.js';

const SIGNWELL_ENDPOINT = 'https://www.signwell.com/api/v1/document_templates/documents';

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonResponse(data, status, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(env) },
  });
}

function getStripe(env) {
  return new Stripe(env.STRIPE_SECRET_KEY, {
    httpClient: Stripe.createFetchHttpClient(),
  });
}

// ---------- /api/create-enrollment ----------
async function handleCreateEnrollment(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid request body.' }, 400, env);
  }

  let members;
  try {
    members = validateAndPriceMembers(body?.members);
  } catch (err) {
    return jsonResponse({ error: err.message }, 400, env);
  }

  const enrollmentId = 'ENR-' + Math.random().toString(36).slice(2, 8).toUpperCase();

  const token = await signEnrollment(
    {
      enrollmentId,
      members: members.map((m) => ({ name: m.name, category: m.category, categoryLabel: m.categoryLabel })),
    },
    env.TOKEN_SECRET
  );

  const url = new URL(request.url);
  const redirectUrl = `${url.origin}/api/pay?token=${encodeURIComponent(token)}`;

  // --- Build template_ids + recipients ---
  // NOTE (please verify before going live): this assumes each template
  // has a single placeholder whose name matches the category, and that
  // requesting the SAME template twice (e.g. two children) is safe to
  // do by listing it twice in template_ids. That second part is NOT
  // confirmed in SignWell's docs — test it in Test Mode with two
  // same-category members before relying on it. If it doesn't work
  // cleanly, the fallback is to create separate sequential documents
  // per same-category member instead of one combined packet.
  const templateIds = [];
  const recipients = [];
  const templateEnvByCategory = {
    adult: 'SIGNWELL_TEMPLATE_ADULT',
    family: 'SIGNWELL_TEMPLATE_FAMILY',
    child: 'SIGNWELL_TEMPLATE_CHILD',
  };

  for (const [i, m] of members.entries()) {
    const templateId = env[templateEnvByCategory[m.category]];
    if (!templateId) {
      return jsonResponse({ error: `Missing configured template for ${m.category}.` }, 500, env);
    }
    templateIds.push(templateId);
    recipients.push({
      id: String(i + 1),
      name: m.name,
      email: m.email || undefined,
      // TODO: confirm this matches the actual placeholder name inside
      // each SignWell template (check Template > Placeholders in the
      // SignWell dashboard). Common patterns: "Adult", "Parent/Guardian", "Child".
      placeholder_name: m.categoryLabel,
    });
  }

  const signwellBody = {
    test_mode: env.SIGNWELL_TEST_MODE === 'true',
    template_ids: templateIds,
    recipients,
    draft: false,
    embedded_signing: true,
    redirect_url: redirectUrl,
    metadata: { enrollment_id: enrollmentId },
  };

  try {
    const swRes = await fetch(SIGNWELL_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': env.SIGNWELL_API_KEY,
      },
      body: JSON.stringify(signwellBody),
    });
    const swData = await swRes.json();

    if (!swRes.ok) {
      console.error('SignWell error:', JSON.stringify(swData));
      return jsonResponse(
        { error: 'Could not create the enrollment agreement. Please try again or contact the office.' },
        502,
        env
      );
    }

    const signingUrl = swData.recipients?.[0]?.embedded_signing_url || swData.embedded_signing_url;
    if (!signingUrl) {
      console.error('No signing URL in SignWell response:', JSON.stringify(swData));
      return jsonResponse({ error: 'Could not retrieve a signing link. Please contact the office.' }, 502, env);
    }

    return jsonResponse({ enrollmentId, signingUrl }, 200, env);
  } catch (err) {
    console.error(err);
    return jsonResponse({ error: 'Unexpected error creating the enrollment.' }, 500, env);
  }
}

// ---------- /api/pay ----------
async function handlePay(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  if (!token) return new Response('Missing enrollment token.', { status: 400 });

  let enrollment;
  try {
    enrollment = await verifyEnrollment(token, env.TOKEN_SECRET);
  } catch {
    return Response.redirect(`${env.CANCEL_URL}?error=expired_link`, 302);
  }

  try {
    const lineItems = enrollment.members.map((m) => {
      const priceId = env[CATEGORIES[m.category].stripePriceEnv];
      if (!priceId) throw new Error(`Missing configured price for ${m.category}.`);
      return { price: priceId, quantity: 1 };
    });

    const stripe = getStripe(env);

    // NOTE: 'subscription' assumes the three Stripe Price objects are
    // set up as recurring (yearly) prices, which fits "$X/yr" billing
    // and lets Stripe auto-renew members each year via ACH. If any of
    // these Prices were created as one-time instead, change this to
    // 'payment' — check each Price's "Recurring" setting in the Stripe
    // dashboard before going live.
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: lineItems,
      success_url: `${env.SUCCESS_URL}?enrollment=${enrollment.enrollmentId}`,
      cancel_url: env.CANCEL_URL,
      metadata: {
        enrollment_id: enrollment.enrollmentId,
        member_names: enrollment.members.map((m) => m.name).join(', '),
      },
    });

    return Response.redirect(session.url, 303);
  } catch (err) {
    console.error(err);
    return new Response(
      'Something went wrong setting up payment. Please contact the office — your agreement is signed, nothing was charged.',
      { status: 500 }
    );
  }
}

// ---------- /api/webhooks/stripe ----------
async function handleStripeWebhook(request, env) {
  const sig = request.headers.get('stripe-signature');
  const rawBody = await request.text();
  const stripe = getStripe(env);

  let event;
  try {
    // constructEventAsync (not the sync constructEvent) is required in
    // Workers/edge runtimes, since signature verification uses Web Crypto.
    event = await stripe.webhooks.constructEventAsync(rawBody, sig, env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err.message);
    return new Response(`Webhook Error: ${err.message}`, { status: 400 });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    console.log(`Enrollment ${session.metadata?.enrollment_id} paid. Members: ${session.metadata?.member_names}`);

    // TODO: this is the natural place to:
    //  - send the welcome email (referral-credit offer lives here per
    //    the patient-acquisition plan)
    //  - notify the office (e.g. a Slack/email ping) that a new
    //    household has enrolled and paid
    //  - kick off CharmHealth / EHR record creation, if automating that later
  }

  return jsonResponse({ received: true }, 200, env);
}

// ---------- /api/webhooks/signwell ----------
async function handleSignwellWebhook(request, env) {
  // This webhook is a backup audit trail, not the primary flow — see
  // README for why. TODO before relying on it for anything beyond
  // logging: verify the payload signature per SignWell's "Event Hash
  // Verification" docs.
  let event;
  try {
    event = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid payload' }, 400, env);
  }
  console.log('SignWell event:', event?.event?.type, JSON.stringify(event?.data?.object?.metadata));
  return jsonResponse({ received: true }, 200, env);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    try {
      if (pathname === '/api/create-enrollment' && request.method === 'POST') {
        return await handleCreateEnrollment(request, env);
      }
      if (pathname === '/api/pay' && request.method === 'GET') {
        return await handlePay(request, env);
      }
      if (pathname === '/api/webhooks/stripe' && request.method === 'POST') {
        return await handleStripeWebhook(request, env);
      }
      if (pathname === '/api/webhooks/signwell' && request.method === 'POST') {
        return await handleSignwellWebhook(request, env);
      }
      return new Response('Not found', { status: 404 });
    } catch (err) {
      console.error(err);
      return jsonResponse({ error: 'Unexpected server error.' }, 500, env);
    }
  },
};
