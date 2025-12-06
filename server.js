import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from '@supabase/supabase-js';
import axios from 'axios'; // NEW: For downloading images

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// --- HELPER: DOWNLOAD IMAGE & CONVERT TO BASE64 ---
async function urlToGenerativePart(url, mimeType) {
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    return {
        inlineData: {
            data: Buffer.from(response.data).toString('base64'),
            mimeType
        }
    };
}

// --- SYSTEM INSTRUCTIONS ---
const systemPrompt = `
You are a senior sales agent for "The Window Valet". 
GOAL: Secure a lead by getting the customer's NAME and CONTACT INFO.

VISION CAPABILITIES:
- If the user sends an image, ANALYZE IT. 
- Describe the window type (Bay, Sliding, Double-hung).
- Mention the light level or decor style you see.
- Suggest a product based on the visual (e.g., "For that large arch window, custom shutters would be stunning").

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
    try {
        const apiKey = req.query.apiKey;
        if (!apiKey) return res.status(400).json({ error: "Missing API Key" });

        const { data: client, error } = await supabase
            .from('clients')
            .select('company_name, logo_url, primary_color, bot_title, website_url')
            .eq('api_key', apiKey)
            .single();

        if (error || !client) return res.status(404).json({ error: "Client not found" });

        res.json({
            name: client.company_name,
            logo: client.logo_url || "", 
            color: client.primary_color || "#007bff",
            title: client.bot_title || "Sales Assistant",
            website: client.website_url
        });
    } catch (err) {
        console.error("Init Error:", err);
        res.status(500).json({ error: "Server Error" });
    }
});

app.post('/chat', async (req, res) => {
    try {
        const { history, clientApiKey } = req.body;

        // 1. Check Kill Switch
        const { data: client } = await supabase.from('clients').select('*').eq('api_key', clientApiKey).single();
        if (!client || client.status !== 'active') return res.json({ reply: "Service Suspended." });

        // 2. Setup Gemini
        const model = genAI.getGenerativeModel({ 
            model: "gemini-2.5-flash", // Flash is fast and sees images!
            systemInstruction: systemPrompt,
            generationConfig: { responseMimeType: "application/json" }
        });

        // 3. PARSE HISTORY FOR IMAGES
        // We need to convert the simplified history from Frontend into Gemini's specific format
        let chatHistoryForGemini = [];
        let currentPromptParts = [];

        // Check the very last message (the new one) for an image URL
        const lastMsg = history[history.length - 1];
        const lastMsgText = lastMsg.parts[0].text;
        
        // Regex to find [IMAGE_URL: https://...]
        const imgMatch = lastMsgText.match(/\[IMAGE_URL: (.*?)\]/);

        if (imgMatch) {
            // FOUND AN IMAGE!
            const imageUrl = imgMatch[1];
            console.log("👀 Gemini is looking at:", imageUrl);
            
            // Download and add to the prompt
            const imagePart = await urlToGenerativePart(imageUrl, "image/jpeg"); // Assume JPEG/PNG
            currentPromptParts.push(imagePart);
            
            // Add the user's text (if any) or a default prompt
            currentPromptParts.push({ text: "Analyze this image of my window. What do you recommend?" });
        } else {
            // No image, just text
            currentPromptParts.push({ text: lastMsgText });
        }

        // 4. Send to Gemini
        // We start a chat with empty history for now (simplifying logic for the image turn)
        // or we append previous text-only turns if we wanted full memory with images.
        // For this step, let's just send the current payload to ensure image works.
        
        const result = await model.generateContent(currentPromptParts);
        const text = result.response.text();

        // 5. Clean JSON
        const cleanText = text.replace(/```json/g, '').replace(/```/g, '').trim();
        const jsonResponse = JSON.parse(cleanText);

        // 6. Lead Capture Logic
        if (jsonResponse.lead_captured === true) {
            if (jsonResponse.customer_phone || jsonResponse.customer_email) {
                console.log("🔥 HOT LEAD:", jsonResponse.customer_name);
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
        res.status(500).json({ reply: "I'm having trouble seeing that. Try again?" });
    }
});

app.listen(3000, () => console.log('🚀 Vision Agent Running'));