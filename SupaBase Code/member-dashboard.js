import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@12.0.0'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2022-11-15',
  httpClient: Stripe.createFetchHttpClient(),
})

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: req.headers.get('Authorization')! } } }
    )

    // -----------------------------------------------------------
    // 1. CONFIGURATION (REPLACE THESE WITH YOUR REAL IDS!)
    // -----------------------------------------------------------
    const CREDITS_PRICE_ID = 'price_1ScdSFGwRTh0iDhh6GMbxxgp' // e.g. price_123... (For 100 Credits)
    const SUBS_PRICE_ID = 'price_1ScdJ7GwRTh0iDhhIPUEh16m'    // e.g. price_456... (For Monthly Sub)

    // -----------------------------------------------------------
    // 2. GET REQUEST (Load Dashboard Stats)
    // -----------------------------------------------------------
    if (req.method === 'GET') {
      const url = new URL(req.url)
      const userEmail = url.searchParams.get('email')
      if (!userEmail) throw new Error("Missing email")

      const { data: client, error } = await supabaseClient
        .from('clients')
        .select('*')
        .eq('email', userEmail)
        .single()

      if (error) throw error
      return new Response(JSON.stringify(client), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    // -----------------------------------------------------------
    // 3. POST REQUEST (Handle Buttons & Coupons)
    // -----------------------------------------------------------
    const { email, action, payload } = await req.json()
    const returnUrl = payload?.returnUrl || req.headers.get('origin')

    // A. Fetch Client
    const { data: client } = await supabaseClient
        .from('clients')
        .select('id, stripe_customer_id, status, redeemed_coupon')
        .eq('email', email)
        .single()
    
    if (!client) throw new Error("Client not found")

    let sessionConfig: any = {
        payment_method_types: ['card'],
        success_url: returnUrl,
        cancel_url: returnUrl,
    }

    // Attach Customer ID to prevent duplicates
    if (client.stripe_customer_id) {
        sessionConfig.customer = client.stripe_customer_id
    } else {
        sessionConfig.customer_email = email
    }

    // =========================================================
    // ACTION 1: BUY CREDITS (One-Time Payment)
    // =========================================================
    if (action === 'buy_credits') {
        sessionConfig.mode = 'payment' // One-time
        sessionConfig.line_items = [{ price: CREDITS_PRICE_ID, quantity: 1 }]
        
        const session = await stripe.checkout.sessions.create(sessionConfig)
        return new Response(JSON.stringify({ url: session.url }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    // =========================================================
    // ACTION 2: ACTIVATE SUBSCRIPTION (Regular Signup)
    // =========================================================
    if (action === 'buy_subscription') {
        sessionConfig.mode = 'subscription' // Recurring
        sessionConfig.line_items = [{ price: SUBS_PRICE_ID, quantity: 1 }]

        const session = await stripe.checkout.sessions.create(sessionConfig)
        return new Response(JSON.stringify({ url: session.url }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    // =========================================================
    // ACTION 3: REDEEM COUPON
    // =========================================================
 // =========================================================
    // ACTION 3: REDEEM COUPON (Fixed: Stacks Time Correctly)
    // =========================================================
    if (action === 'redeem_coupon') {
        let { couponCode } = payload
        couponCode = couponCode.toUpperCase().trim()

        // 1. Check if used before
        if (client.redeemed_coupon) {
            return new Response(JSON.stringify({ error: `You have already redeemed a code: ${client.redeemed_coupon}` }), {
                status: 400,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            })
        }

        // 2. SCENARIO A: ACTIVE USER (Extend Existing Date)
        if (client.status === 'active' && client.stripe_customer_id) {
            const subs = await stripe.subscriptions.list({
                customer: client.stripe_customer_id,
                status: 'active',
                limit: 1
            })
            
            if (subs.data.length > 0) {
                const subId = subs.data[0].id;

                // --- LOGIC FIX: CALCULATE NEW DATE ---
                let newDate;
                const currentTrialEnd = client.trial_ends_at ? new Date(client.trial_ends_at) : new Date();
                const now = new Date();

                // If the current trial date is in the future (e.g., 2026), use THAT as the starting point.
                // If it's in the past or null, use NOW as the starting point.
                if (currentTrialEnd > now) {
                    newDate = new Date(currentTrialEnd); 
                } else {
                    newDate = new Date(now);
                }

                // Add 3 Months to the baseline
                newDate.setMonth(newDate.getMonth() + 3);

                // --- STRIPE UPDATE: PUSH BILLING DATE ---
                // We update 'trial_end' instead of just adding a coupon. 
                // This tells Stripe: "Don't charge this person until [New Date]"
                await stripe.subscriptions.update(subId, { 
                    trial_end: Math.floor(newDate.getTime() / 1000), // Convert to Unix Timestamp
                    proration_behavior: 'none', // Don't charge/refund for the change
                    coupon: couponCode // Optional: Attach coupon for tracking/discounting the first bill after trial
                })
                
                // --- SUPABASE UPDATE ---
                await supabaseClient.from('clients').update({ 
                    redeemed_coupon: couponCode,
                    trial_ends_at: newDate.toISOString() 
                }).eq('id', client.id)
                
                return new Response(JSON.stringify({ message: "Success! Membership extended by 3 months." }), {
                    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                })
            }
        }

        // 3. SCENARIO B: INACTIVE USER (Send to Checkout)
        // (No changes needed here - Checkout handles the initial setup)
        sessionConfig.mode = 'subscription'
        sessionConfig.line_items = [{ price: SUBS_PRICE_ID, quantity: 1 }]
        sessionConfig.discounts = [{ coupon: couponCode }]
        sessionConfig.metadata = { redeemed_coupon: couponCode }

        const session = await stripe.checkout.sessions.create(sessionConfig)
        return new Response(JSON.stringify({ url: session.url }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    // =========================================================
    // ACTION 4: MANAGE BILLING (Portal)
    // =========================================================
    if (action === 'manage_subscription') {
         if (!client.stripe_customer_id) throw new Error("No billing account found.")
         const session = await stripe.billingPortal.sessions.create({
            customer: client.stripe_customer_id,
            return_url: returnUrl,
         })
         return new Response(JSON.stringify({ url: session.url }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    return new Response(JSON.stringify({ error: "Invalid Action" }), { headers: corsHeaders })

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})