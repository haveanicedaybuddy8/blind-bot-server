// stripe_handler.js
import Stripe from 'stripe';
import express from 'express';

// --- CONFIGURATION ---
// CRITICAL: You need the PRICE ID (starts with 'price_...'), not the Product ID.
// Go to Stripe Dashboard > Products > Click the 300 Credits Product > Look for the Pricing ID.
const CREDITS_PRICE_ID = 'price_1ScdSFGwRTh0iDhh6GMbxxgp'; 

const CREDITS_PRODUCT_ID = 'prod_TZn2iDLsLFIDTD';      
const SUBSCRIPTION_PRODUCT_ID = 'prod_TZmsARYjlbDrJ5'; 

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ==================================================================
// 1. HELPER: TRIGGER AUTO-REFILL
// ==================================================================
export async function triggerAutoRefill(stripeCustomerId) {
    if (!stripeCustomerId) return;

    try {
        console.log(`⚡ Triggering Auto-Replenish for ${stripeCustomerId}...`);

        // A. Add the Credits Item to their "Tab"
        await stripe.invoiceItems.create({
            customer: stripeCustomerId,
            price: CREDITS_PRICE_ID, // Must be the 'price_...' ID
        });

        // B. Create an Invoice and Charge it IMMEDIATELY
        const invoice = await stripe.invoices.create({
            customer: stripeCustomerId,
            auto_advance: true, // Auto-finalize
            collection_method: 'charge_automatically'
        });

        // C. Pay it (Stripe sometimes waits an hour, so we force pay now)
        await stripe.invoices.pay(invoice.id);

        console.log(`   ✅ Auto-Refill Successful! Invoice: ${invoice.id}`);
        // NOTE: We don't need to update Supabase here manually. 
        // The webhook below (invoice.payment_succeeded) will catch this payment 
        // and add the 300 credits automatically!

    } catch (err) {
        console.error("❌ Auto-Refill Failed:", err.message);
    }
}
// ==================================================================
// 2. THE WEBHOOK
export function setupStripeWebhook(app, supabase) {
    console.log("💳 Stripe Webhook Module Loaded.");

    app.post('/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
        const sig = req.headers['stripe-signature'];
        let event;

        try {
            event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
        } catch (err) {
            console.error(`⚠️  Webhook signature verification failed.`, err.message);
            return res.status(400).send(`Webhook Error: ${err.message}`);
        }

        // ====================================================
        // 1. ONE-TIME PURCHASES (Credits & New Signups)
        // ====================================================
        if (event.type === 'checkout.session.completed') {
            const session = event.data.object;
            const customerEmail = session.customer_details?.email;
            const stripeCustomerId = session.customer;

            if (customerEmail) {
                // 1. Link the Stripe Customer ID to the user
                await supabase.from('clients')
                    .update({ stripe_customer_id: stripeCustomerId })
                    .eq('email', customerEmail);
                
                // 2. Add Credits or Activate
                await handleCheckout(session, customerEmail, stripe, supabase);
            }
        }

        // ====================================================
        // 2. SUBSCRIPTION RENEWALS (Add 100 Credits)
        // ====================================================
        if (event.type === 'invoice.payment_succeeded') {
            const invoice = event.data.object;
            const customerEmail = invoice.customer_email;
            if (customerEmail) {
                await handleInvoicePaid(invoice, customerEmail, supabase);
            }
        }

        // ====================================================
        // 3. THE "SOURCE OF TRUTH" (Sync Status)
        // ====================================================
        // Fires on: Renewal Success, Payment Failure, Cancellation, Upgrades
        if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
            const subscription = event.data.object;
            const stripeCustomerId = subscription.customer;
            const stripeStatus = subscription.status; // active, past_due, canceled, unpaid

            console.log(`🔄 Syncing Subscription Status: ${stripeStatus} for ${stripeCustomerId}`);

            // MAP STRIPE STATUS TO OUR DB STATUS
            // We treat 'active' and 'trialing' as ALLOWED. Everything else is BLOCKED.
            let newDbStatus = 'inactive';
            if (stripeStatus === 'active' || stripeStatus === 'trialing') {
                newDbStatus = 'active';
            }

            // Update DB using the Stripe Customer ID
            await supabase.from('clients')
                .update({ status: newDbStatus })
                .eq('stripe_customer_id', stripeCustomerId);
        }

        res.json({ received: true });
    });
}
// --- INTERNAL HELPERS ---

async function handleCheckout(session, email, stripe, supabase) {
    try {
        const lineItems = await stripe.checkout.sessions.listLineItems(session.id);
        const { data: client } = await supabase.from('clients').select('id, image_credits').eq('email', email).single();

        if (client) {
            let updateData = {};
            for (const item of lineItems.data) {
                if (item.price.product === CREDITS_PRODUCT_ID) {
                    const qty = item.quantity || 1;
                    const current = client.image_credits || 0;
                    // Fix: Ensure we don't overwrite if multiple packs bought
                    const base = updateData.image_credits !== undefined ? updateData.image_credits : current;
                    updateData.image_credits = base + (300 * qty);
                }
                if (item.price.product === SUBSCRIPTION_PRODUCT_ID) {
                    updateData.status = 'active';
                }
            }
            if (Object.keys(updateData).length > 0) {
                await supabase.from('clients').update(updateData).eq('id', client.id);
            }
        }
    } catch (err) { console.error(err); }
}

async function handleInvoicePaid(invoice, email, supabase) {
    try {
        const lines = invoice.lines.data;
        const { data: client } = await supabase.from('clients').select('id, image_credits').eq('email', email).single();
        if (!client) return;

        let creditsToAdd = 0;
        let shouldActivate = false;

        lines.forEach(line => {
            // 1. Subscription Renewal (+100 Credits)
            if (line.price.product === SUBSCRIPTION_PRODUCT_ID) {
                creditsToAdd += 100;
                shouldActivate = true;
                console.log(`   🔄 Subscription Renewal Detected.`);
            }
            // 2. Auto-Refill Item (+300 Credits)
            // Note: We check Product ID because Price ID might change
            if (line.price.product === CREDITS_PRODUCT_ID) {
                const qty = line.quantity || 1;
                creditsToAdd += (300 * qty);
                console.log(`   ⚡ Auto-Refill Payment Detected.`);
            }
        });

        if (creditsToAdd > 0 || shouldActivate) {
            const updateData = { image_credits: (client.image_credits || 0) + creditsToAdd };
            if (shouldActivate) updateData.status = 'active';

            await supabase.from('clients').update(updateData).eq('id', client.id);
            console.log(`   ✅ Added ${creditsToAdd} credits to ${email}.`);
        }
    } catch (err) { console.error(err); }
}
export async function createPortalSession(stripeCustomerId) {
    // This creates a temporary, secure link that logs the user into Stripe
    const session = await stripe.billingPortal.sessions.create({
        customer: stripeCustomerId,
        return_url: 'https://www.theblindbots.com/settings', 
    });
    return session.url;
}