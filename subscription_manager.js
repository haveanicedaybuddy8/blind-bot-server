// subscription_manager.js
import { triggerAutoRefill } from './stripe_handler.js'; 

// 1. ACCESS CHECK (Run at start of Chat)
// This only checks if the subscription is Active. It DOES NOT charge a credit.
export async function validateClientAccess(supabase, apiKey) {
    try {
        const { data: client, error } = await supabase
            .from('clients')
            .select('*') 
            .eq('api_key', apiKey)
            .single();

        if (error || !client) return { allowed: false, error: "Invalid Key" };

        // Strictly enforce Active Subscription
        if (client.status !== 'active') return { allowed: false, error: "Service Suspended: Subscription Inactive." };

        // Note: We do NOT check for >0 credits here anymore. 
        // Users can chat for free even with 0 credits.
        
        return { allowed: true, client: client };

    } catch (err) {
        console.error(err);
        return { allowed: false, error: "Error" };
    }
}

// 2. DEDUCTION CHECK (Run only when Generating)
// This checks for credits, deducts 1, and triggers auto-refill if low.
export async function deductImageCredit(supabase, clientId) {
    try {
        // Fetch fresh balance
        const { data: client } = await supabase
            .from('clients')
            .select('id, image_credits, auto_replenish, stripe_customer_id')
            .eq('id', clientId)
            .single();

        if (!client) return false;

        // CHECK: Do they have credits?
        if (!client.image_credits || client.image_credits <= 0) {
            return false; // Block generation
        }

        // CALCULATE
        const newBalance = client.image_credits - 1;

        // AUTO-REFILL LOGIC (Moved here)
        if (newBalance <= 5 && client.auto_replenish && client.stripe_customer_id) {
            triggerAutoRefill(client.stripe_customer_id);
        }

        // DEDUCT
        await supabase
            .from('clients')
            .update({ image_credits: newBalance })
            .eq('id', clientId);

        return true; // Success

    } catch (err) {
        console.error("Credit Deduction Error:", err);
        return false;
    }
}