// Import the new trigger function
import { triggerAutoRefill } from './stripe_handler.js'; 

export async function validateClientAccess(supabase, apiKey) {
    try {
        // ... (Keep existing fetch logic) ...
        const { data: client, error } = await supabase
            .from('clients')
            .select('*') 
            .eq('api_key', apiKey)
            .single();

        if (error || !client) return { allowed: false, error: "Invalid Key" };

        if (client.status !== 'active') return { allowed: false, error: "Inactive" };
        if (!client.image_credits || client.image_credits <= 0) return { allowed: false, error: "No Credits" };

        // --- CALCULATE NEW BALANCE ---
        const newBalance = client.image_credits - 1;

        // --- THE TRIGGER LOGIC ---
        // If balance hits 5, AND auto-replenish is ON, AND we have a Stripe ID
        if (newBalance <= 5 && client.auto_replenish && client.stripe_customer_id) {
            // We call this WITHOUT 'await' so we don't slow down the user's chat response.
            // It runs in the background.
            triggerAutoRefill(client.stripe_customer_id);
        }

        // Deduct Credit
        await supabase
            .from('clients')
            .update({ image_credits: newBalance })
            .eq('id', client.id);

        return { allowed: true, client: client };

    } catch (err) {
        console.error(err);
        return { allowed: false, error: "Error" };
    }
}