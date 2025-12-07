import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import FormData from 'form-data';

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
GOAL: Secure a lead by getting the customer's CONTACT INFO and a HOME VISIT TIME.

CORE INFO:
- Products: Roller Shades, Zebra Blinds, Shutters, Motorization.
- Owner: Josh LeClair.
- Location: Indianapolis, IN.

RULES:
1. **The Home Visit:** You MUST try to schedule a "Free In-Home Estimate." Ask: "When would be a good time for us to come out and measure?"
2. **Contact Info:** You MUST get their Name AND (Phone OR Email). 
3. **Preference:** Ask: "Do you prefer we contact you via phone, text, or email?"
4. **Validation:** If they give a time but no phone/email, keep asking for contact info. You cannot book a slot without a contact.

TOOLS:
- You can GENERATE RENDERINGS. 
- If the user uploads a photo and asks to see a product (e.g. "Show me zebra blinds"), set "visualize": true.
- In "visual_style", describe the NEW product clearly (e.g. "modern white zebra blinds, luxury style").

OUTPUT FORMAT:
Reply in valid JSON format ONLY. Structure:
{
  "reply": "Your response to the customer",
  "lead_captured": boolean, (TRUE only if you have Name AND (Phone OR Email)),
  "customer_name": "extracted name or null",
  "customer_phone": "extracted phone or null",
  "customer_email": "extracted email or null",
  "customer_address": "extracted address or null",
  "appointment_request": "extracted date/time preference or null",
  "preferred_method": "Phone, Text, or Email",
  "ai_summary": "A 2-sentence summary of what they want and their vibe (e.g. 'Customer wants zebra blinds for living room, very price conscious, requested Tuesday visit.')"
  "visualize": boolean, 
  "visual_style": "description for the artist"
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
// --- HELPER: PAINT THE WINDOW (Stability AI) ---
async function generateRendering(imageUrl, stylePrompt) {
    try {
        console.log("🎨 Painting:", stylePrompt);
        
        // 1. Download the user's original photo
        const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(imageResponse.data);

        // 2. Prepare the payload
        const payload = new FormData();
        payload.append('init_image', buffer);
        payload.append('init_image_mode', 'IMAGE_STRENGTH');
        payload.append('image_strength', 0.35); // 0.35 = Keep 65% of original room, change 35%
        payload.append('text_prompts[0][text]', `${stylePrompt}, interior design photography, 8k, realistic`);
        payload.append('text_prompts[0][weight]', 1);
        payload.append('cfg_scale', 7);
        payload.append('steps', 30);

        // 3. Call Stability API
        const response = await axios.post(
            'https://api.stability.ai/v1/generation/stable-diffusion-v1-6/image-to-image',
            payload,
            {
                headers: {
                    ...payload.getHeaders(),
                    Authorization: `Bearer ${process.env.STABILITY_API_KEY}`,
                    Accept: 'application/json',
                },
            }
        );

        // 4. Save result to Supabase
        const base64Image = response.data.artifacts[0].base64;
        const imageBuffer = Buffer.from(base64Image, 'base64');
        const fileName = `renderings/${Date.now()}_ai.png`;

        const { error } = await supabase.storage
            .from('chat-uploads')
            .upload(fileName, imageBuffer, { contentType: 'image/png' });

        if (error) throw error;

        const { data: urlData } = supabase.storage
            .from('chat-uploads')
            .getPublicUrl(fileName);

        return urlData.publicUrl;

    } catch (error) {
        console.error("Rendering Failed:", error.response?.data || error.message);
        return null;
    }
}

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

        // 3. Image Handling (Keep your existing image logic here!)
        // ... (Copy the multi-image parsing logic from your previous server.js) ...
        // [For brevity, I assume you kept the image parsing code. If not, I can re-paste it].
        // Let's assume 'currentPromptParts' is built correctly here.
        
        // --- RE-INSERTING IMAGE LOGIC FOR SAFETY ---
        let currentPromptParts = [];
        const lastEntry = history[history.length - 1];
        let foundImage = false;
        
        for (const part of lastEntry.parts) {
            const imgMatch = part.text.match(/\[IMAGE_URL: (.*?)\]/);
            if (imgMatch) {
                foundImage = true;
                const imagePart = await urlToGenerativePart(imgMatch[1]); // Ensure helper function exists
                if (imagePart) currentPromptParts.push(imagePart);
            } else {
                currentPromptParts.push({ text: part.text });
            }
        }
        if (foundImage && currentPromptParts.every(p => p.inlineData)) {
            currentPromptParts.push({ text: "I have uploaded photos. Please analyze." });
        }
        // -------------------------------------------

        const result = await model.generateContent(currentPromptParts);
        const text = result.response.text();
        const cleanText = text.replace(/```json/g, '').replace(/```/g, '').trim();
        const jsonResponse = JSON.parse(cleanText);// ... after const jsonResponse = JSON.parse(cleanText); ...

        // 7. VISUALIZATION LOGIC
        if (jsonResponse.visualize === true) {
            
            // Find the last image the user sent
            let sourceImageUrl = null;
            // Scan history backwards
            for (let i = history.length - 1; i >= 0; i--) {
                const parts = history[i].parts;
                for (const part of parts) {
                    const match = part.text.match(/\[IMAGE_URL: (.*?)\]/);
                    if (match) {
                        sourceImageUrl = match[1];
                        break;
                    }
                }
                if (sourceImageUrl) break;
            }

            if (sourceImageUrl) {
                console.log("🎨 Generating Render...");
                const renderedUrl = await generateRendering(sourceImageUrl, jsonResponse.visual_style);
                
                if (renderedUrl) {
                    jsonResponse.reply += `\n\n[RENDER_URL: ${renderedUrl}]`; 
                } else {
                    jsonResponse.reply += " (I couldn't generate the preview right now.)";
                }
            }
        }

        // 4. LEAD CAPTURE LOGIC (STRICT)
        // Only save if lead_captured is TRUE (which Gemini only sets if Name + Contact exists)
        if (jsonResponse.lead_captured === true) {
            
            // Double Validation: Code check
            const hasContact = jsonResponse.customer_phone || jsonResponse.customer_email;
            
            if (hasContact) {
                console.log("🔥 SAVING LEAD:", jsonResponse.customer_name);
                
                await supabase.from('leads').insert({
                    client_id: client.id,
                    customer_name: jsonResponse.customer_name,
                    customer_phone: jsonResponse.customer_phone,
                    customer_email: jsonResponse.customer_email,
                    customer_address: jsonResponse.customer_address,
                    
                    // NEW FIELDS
                    appointment_request: jsonResponse.appointment_request,
                    preferred_method: jsonResponse.preferred_method,
                    ai_summary: jsonResponse.ai_summary,
                    
                    full_transcript: JSON.stringify(history) 
                });
            }
        }

        res.json({ reply: jsonResponse.reply });

    } catch (err) {
        console.error("Server Error:", err);
        res.status(500).json({ reply: "I'm having trouble connecting right now." });
    }
});

app.listen(3000, () => console.log('🚀 Multi-Vision Agent Running'));