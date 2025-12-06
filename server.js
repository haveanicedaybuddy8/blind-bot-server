import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Allow large payloads

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// --- HELPER: DOWNLOAD IMAGE & CONVERT TO BASE64 ---
async function urlToGenerativePart(url) {
    try {
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        return {
            inlineData: {
                data: Buffer.from(response.data).toString('base64'),
                mimeType: "image/jpeg"
            }
        };
    } catch (e) {
        console.error("Failed to download image:", url);
        return null; // Skip broken images
    }
}

// --- SYSTEM INSTRUCTIONS ---
const systemPrompt = `
You are a senior sales agent for "The Window Valet". 
GOAL: Secure a lead by getting the customer's NAME and CONTACT INFO.

VISION CAPABILITIES:
- The user may upload MULTIPLE images. Look at ALL of them.
- Analyze the window styles (Bay, Bow, Double-hung, Sliding).
- Comment on the decor and light levels.
- Suggest products based on the visuals.

OUTPUT FORMAT:
Reply in valid JSON format ONLY. Structure:
{
  "reply": "Your response here",
  "lead_captured": boolean, 
  "customer_name": "extracted name or null",
  "customer_phone": "extracted phone or null",
  "customer_email": "extracted email or null",
  "customer_address": "extracted address or null",
  "summary": "brief summary of needs"
}
`;

app.get('/init', async (req, res) => {
    // ... (Keep this the same as before, or copy from previous code if lost) ...
    // For brevity, assuming you have the INIT code. If not, ask me and I'll paste it full.
    try {
        const apiKey = req.query.apiKey;
        if (!apiKey) return res.status(400).json({ error: "Missing API Key" });
        const { data: client } = await supabase.from('clients').select('*').eq('api_key', apiKey).single();
        if (!client) return res.status(404).json({ error: "Client not found" });
        res.json({
            name: client.company_name, logo: client.logo_url || "", color: client.primary_color || "#007bff", title: client.bot_title || "Sales Assistant", website: client.website_url
        });
    } catch (err) { res.status(500).json({ error: "Server Error" }); }
});

app.post('/chat', async (req, res) => {
    try {
        const { history, clientApiKey } = req.body;
        const { data: client } = await supabase.from('clients').select('*').eq('api_key', clientApiKey).single();
        if (!client || client.status !== 'active') return res.json({ reply: "Service Suspended." });

        const model = genAI.getGenerativeModel({ 
            model: "gemini-2.5-flash", 
            systemInstruction: systemPrompt,
            generationConfig: { responseMimeType: "application/json" }
        });

        // --- MULTI-IMAGE PARSING LOGIC ---
        // We will construct the CURRENT turn prompt by looking at recent history
        let currentPromptParts = [];
        
        // If the user just sent images, they are in the history array.
        // We need to grab the LAST user message(s). 
        // Logic: Grab the last entry. If it has images, download them.
        
        const lastEntry = history[history.length - 1];
        
        // Loop through the parts of the last message to find ALL images
        let foundImage = false;
        
        for (const part of lastEntry.parts) {
            // Check for our special image tag
            const imgMatch = part.text.match(/\[IMAGE_URL: (.*?)\]/);
            
            if (imgMatch) {
                foundImage = true;
                const imageUrl = imgMatch[1];
                console.log("👀 Processing Image:", imageUrl);
                const imagePart = await urlToGenerativePart(imageUrl);
                if (imagePart) currentPromptParts.push(imagePart);
            } else {
                // It's just text
                currentPromptParts.push({ text: part.text });
            }
        }

        // If we found images but no text, add a prompt so Gemini knows what to do
        if (foundImage && currentPromptParts.every(p => p.inlineData)) {
            currentPromptParts.push({ text: "I have uploaded photos of my windows. Please analyze them and recommend blinds." });
        }

        // Generate
        const result = await model.generateContent(currentPromptParts);
        const text = result.response.text();
        const cleanText = text.replace(/```json/g, '').replace(/```/g, '').trim();
        const jsonResponse = JSON.parse(cleanText);

        // Lead Capture Logic (Same as before)
        if (jsonResponse.lead_captured && (jsonResponse.customer_phone || jsonResponse.customer_email)) {
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

        res.json({ reply: jsonResponse.reply });

    } catch (err) {
        console.error("Server Error:", err);
        res.status(500).json({ reply: "I'm having trouble analyzing those photos. Please try again." });
    }
});

app.listen(3000, () => console.log('🚀 Multi-Vision Agent Running'));