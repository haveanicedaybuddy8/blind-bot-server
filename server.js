// Sales Agent Version 2.0 - Contact Split Update
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from '@supabase/supabase-js';

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// --- THE SALES MANAGER INSTRUCTION ---
// We feed the bot the "Window Valet" data + The specific instruction to capture leads.
const systemPrompt = `
You are a senior sales agent for "The Window Valet". 
YOUR GOAL: Secure a lead by getting the customer's NAME and CONTACT INFO.

CORE INFO:
- Owner: Josh LeClair (Family Owned).
- Location: Indianapolis, IN.
- Guarantee: 10x10 Low Price Guarantee.
- Products: Roller Shades, Motorized Blinds, Shutters.

RULES:
1. Lead the conversation. Ask about their window needs (Size? Room? Light issues?).
2. Once you understand their needs, ask for their Name and Phone Number/Email to schedule a free estimate.
3. If they give an address, that is great, but it is optional.
4. VALIDATION: You must get EITHER a Phone Number OR an Email Address to count as a lead.

OUTPUT FORMAT:
Reply in valid JSON format ONLY. Structure:
{
  "reply": "Your friendly response to the customer",
  "lead_captured": boolean, (Set to TRUE only if you have Name AND (Phone OR Email)),
  "customer_name": "extracted name or null",
  "customer_phone": "extracted phone or null",
  "customer_email": "extracted email or null",
  "customer_address": "extracted address or null",
  "summary": "brief summary of needs"
}
`;

app.post('/chat', async (req, res) => {
    try {
        const { history, clientApiKey } = req.body;

        // 1. Check Kill Switch
        const { data: client } = await supabase.from('clients').select('*').eq('api_key', clientApiKey).single();
        if (!client || client.status !== 'active') return res.json({ reply: "Service Suspended." });

        // 2. Setup Gemini
        const model = genAI.getGenerativeModel({ 
            model: "gemini-2.5-flash",
            systemInstruction: systemPrompt,
            generationConfig: { responseMimeType: "application/json" }
        });

        // 3. Generate Content
        // Handle history gracefully
        let msgToSend = "";
        if (history && history.length > 0) {
             const lastPart = history[history.length - 1].parts;
             msgToSend = lastPart[0].text;
             history.pop(); // Remove it so we don't send it twice
        } else {
             msgToSend = "Hello"; 
        }

        const chat = model.startChat({ history: history });
        const result = await chat.sendMessage(msgToSend);
        const jsonResponse = JSON.parse(result.response.text());

        // 4. LOGIC: Save ONLY if we have valid contact info
        if (jsonResponse.lead_captured === true) {
            const hasContact = jsonResponse.customer_phone || jsonResponse.customer_email;
            
            if (hasContact) {
                console.log("🔥 HOT LEAD CAPTURED:", jsonResponse.customer_name);
                await supabase.from('leads').insert({
                    client_id: client.id,
                    customer_name: jsonResponse.customer_name,
                    customer_phone: jsonResponse.customer_phone,
                    customer_email: jsonResponse.customer_email,
                    customer_address: jsonResponse.customer_address,
                    project_summary: jsonResponse.summary,
                    full_transcript: JSON.stringify(history) 
                });
            }
        }

        res.json({ reply: jsonResponse.reply });

    } catch (err) {
        console.error("Server Error:", err);
        res.status(500).json({ reply: "I'm having trouble connecting. Please try again." });
    }
});


// --- NEW ENDPOINT: THE "WHO AM I?" CHECK ---
app.get('/init', async (req, res) => {
    try {
        const apiKey = req.query.apiKey;

        if (!apiKey) return res.status(400).json({ error: "Missing API Key" });

        // Fetch branding info from Supabase
        const { data: client, error } = await supabase
            .from('clients')
            .select('company_name, logo_url, primary_color, bot_title, website_url')
            .eq('api_key', apiKey)
            .single();

        if (error || !client) {
            return res.status(404).json({ error: "Client not found" });
        }

        // Send the branding data back to the frontend
        res.json({
            name: client.company_name,
            logo: client.logo_url || "", // Fallback to empty if missing
            color: client.primary_color || "#007bff", // Fallback to blue
            title: client.bot_title || "Sales Assistant",
            website: client.website_url
        });

    } catch (err) {
        console.error("Init Error:", err);
        res.status(500).json({ error: "Server Error" });
    }
});
app.listen(3000, () => console.log('🚀 Sales Agent Running'));