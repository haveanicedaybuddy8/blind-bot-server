import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function runTest() {
    console.log("Attempting to connect...");

    // 1. Let's try to find the client we created in the SQL step
    const { data: client, error: clientError } = await supabase
        .from('clients')
        .select('*')
        .eq('company_name', 'Apex Blinds Demo')
        .single();

    if (clientError) {
        console.error("❌ Error finding client:", clientError.message);
        return;
    }

    console.log("✅ Found Client:", client.company_name);
    console.log("🔑 API Key to use later:", client.api_key);

    // 2. Now let's fake a chat log
    const { error: logError } = await supabase
        .from('chat_logs')
        .insert({
            client_id: client.id,
            user_message: "Test message from VS Code",
            ai_response: "I am saving this to the cloud!"
        });

    if (logError) {
        console.error("❌ Error saving log:", logError.message);
    } else {
        console.log("✅ Chat Log saved successfully!");
    }
}

runTest();