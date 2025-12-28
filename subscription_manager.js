// subscription_manager.js

/**
// subscription_manager.js

/**
 * Validates if a client has access to the service.
 * NEW Logic:
 * 1. Validates API Key.
 * 2. STRICTLY REQUIRES 'status' to be 'active'.
 * 3. STRICTLY REQUIRES 'credits' > 0.
 * 4. Deducts 1 credit on every successful request.
 */
export async function validateClientAccess(supabase, apiKey) {
    try {
        // 1. Fetch Client Identity & Balance
        const { data: client, error } = await supabase
            .from('clients')
            .select('*') 
            .eq('api_key', apiKey)
            .single();

        if (error || !client) {
            return { allowed: false, error: "Invalid API Key or Client not found." };
        }

        // 2. CHECK 1: Must have Active Subscription
        if (client.status !== 'active') {
            return { allowed: false, error: "Service Suspended: Subscription is inactive." };
        }

        // 3. CHECK 2: Must have Credits
        if (!client.credits || client.credits <= 0) {
            return { allowed: false, error: "Service Suspended: Insufficient credits." };
        }

        // 4. If Both Passed: Deduct Credit
        const { error: updateError } = await supabase
            .from('clients')
            .update({ credits: client.credits - 1 })
            .eq('id', client.id);

        if (updateError) {
            console.error("Failed to deduct credit:", updateError);
            // We allow the request to proceed even if update fails to prevent 
            // user downtime during minor DB glitches, but we log it.
        }

        return { allowed: true, client: client };

    } catch (err) {
        console.error("Subscription Manager Error:", err);
        return { allowed: false, error: "Internal validation error." };
    }
}