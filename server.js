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
app.use(express.json({ limit: '50mb' }));

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// --- HELPER: DOWNLOAD IMAGE ---
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
        return null;
    }
}

// --- HELPER: GENERATE RENDERING (Stability AI - SDXL) ---
async function generateRendering(imageUrl, stylePrompt) {
    try {
        console.log("🎨 Painting:", stylePrompt);
        const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(imageResponse.data);

        const payload = new FormData();
        payload.append('init_image', buffer);
        payload.append('init_image_mode', 'IMAGE_STRENGTH');
        payload.append('image_strength', 0.35); // Keep 65% of original room
        payload.append('text_prompts[0][text]', `${stylePrompt}, interior design photography, 8k, realistic, high quality`);
        payload.append('text_prompts[0][weight]', 1);
        payload.append('cfg_scale', 7);
        payload.append('steps', 30);

        // Using SDXL 1.0 (Cheaper and better for architecture)
        const response = await axios.post(
            'https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/image-to-image',
            payload,
            {
                headers: {
                    ...payload.getHeaders(),
                    Authorization: `Bearer ${process.env.STABILITY_API_KEY}`,
                    Accept: 'application/json',
                },
            }
        );

        const base64Image = response.data.artifacts[0].base64;
        const imageBuffer = Buffer.from(base64Image, 'base64');
        const fileName = `renderings/${Date.now()}_ai.png`;

        const { error } = await supabase.storage.from('chat-uploads').upload(fileName, imageBuffer, { contentType: 'image/png' });
        if (error) throw error;

        const { data: urlData } = supabase.storage.from('chat-uploads').getPublicUrl(fileName);
        return urlData.publicUrl;

    } catch (error) {
        console.error("Rendering Failed:", error.response?.data || error.message);
        return null;
    }
}

const systemPrompt = `
You are a senior sales agent for "The Window Valet". 
GOAL: Secure a lead by getting the customer's CONTACT INFO and a HOME VISIT TIME.

RULES:
1. **Memory:** REMEMBER what the user told you earlier (Name, Room, Issues). Do not ask for things they already said.
2. **The Home Visit:** Try to schedule a "Free In-Home Estimate."
3. **Contact Info:** You MUST get their Name AND (Phone OR Email). 
4. **Validation:** If they give a time but no contact info, keep asking.

TOOLS:
- You can GENERATE RENDERINGS. If user uploads a photo and asks to see a product, set "visualize": true.
- In "visual_style", describe the NEW product clearly (e.g. "modern white zebra blinds, luxury style").

OUTPUT FORMAT (JSON ONLY):
{
  "reply": "Your response",
  "lead_captured": boolean,
  "customer_name": "...",
  "customer_phone": "...",
  "customer_email": "...",
  "customer_address": "...",
  "appointment_request": "...",
  "preferred_method": "...",
  "ai_summary": "...",
  "visualize": boolean,
  "visual_style": "description for artist"
}
`;

app.get('/init', async (req, res) => {
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
        
        // 1. Get Client & Check Status
        const { data: client } = await supabase.from('clients').select('*').eq('api_key', clientApiKey).single();
        if (!client || client.status !== 'active') return res.json({ reply: "Service Suspended." });

        const model = genAI.getGenerativeModel({ 
            model: "gemini-2.5-flash", 
            systemInstruction: systemPrompt,
            generationConfig: { responseMimeType: "application/json" }
        });

        // 2. MEMORY FIX: Split History
        const lastTurn = history.pop(); 
        const pastHistory = history;

        const chat = model.startChat({ history: pastHistory });

        // 3. Image Parsing
        let currentParts = [];
        let foundImage = false;
        let sourceImageUrl = null;

        for (const part of lastTurn.parts) {
            const imgMatch = part.text.match(/\[IMAGE_URL: (.*?)\]/);
            if (imgMatch) {
                foundImage = true;
                sourceImageUrl = imgMatch[1];
                const imagePart = await urlToGenerativePart(sourceImageUrl);
                if (imagePart) currentParts.push(imagePart);
            } else {
                currentParts.push({ text: part.text });
            }
        }
        
        if (foundImage && currentParts.every(p => p.inlineData)) {
            currentParts.push({ text: "I have uploaded photos. Please analyze them." });
        }

        // 4. Generate AI Response
        const result = await chat.sendMessage(currentParts);
        const cleanText = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
        const jsonResponse = JSON.parse(cleanText);

        // 5. VISUALIZATION LOGIC (WITH CREDIT CHECK)
        if (jsonResponse.visualize === true) {
            
            // If no image in this turn, look back in history
            if (!sourceImageUrl) {
                 for (let i = pastHistory.length - 1; i >= 0; i--) {
                    const parts = pastHistory[i].parts;
                    for (const part of parts) {
                        const match = part.text.match(/\[IMAGE_URL: (.*?)\]/);
                        if (match) { sourceImageUrl = match[1]; break; }
                    }
                    if (sourceImageUrl) break;
                 }
            }

            if (sourceImageUrl) {
                // --- THE CREDIT CHECK ---
                // We re-fetch credits to be safe
                const { data: wallet } = await supabase.from('clients').select('image_credits').eq('id', client.id).single();
                
                if (!wallet || wallet.image_credits < 1) {
                    jsonResponse.reply += " (I'd love to generate a preview, but your account is out of Image Credits. Please contact support to top up!)";
                } else {
                    // CHARGE THE WALLET (-1)
                    await supabase.from('clients')
                        .update({ image_credits: wallet.image_credits - 1 })
                        .eq('id', client.id);

                    // LOG THE TRANSACTION
                    await supabase.from('credit_usage').insert({ 
                        client_id: client.id, 
                        credits_spent: 1, 
                        action_type: 'rendering' 
                    });
                    
                    // DO THE WORK
                    const renderedUrl = await generateRendering(sourceImageUrl, jsonResponse.visual_style);
                    if (renderedUrl) {
                        jsonResponse.reply += `\n\n[RENDER_URL: ${renderedUrl}]`;
                    } else {
                        // Optional: Refund if failed? For MVP, we keep it simple.
                        jsonResponse.reply += " (Preview generation failed. Please try again.)";
                    }
                }
            }
        }

        // 6. Lead Capture Logic
        if (jsonResponse.lead_captured && (jsonResponse.customer_phone || jsonResponse.customer_email)) {
            console.log("🔥 SAVING LEAD:", jsonResponse.customer_name);
            await supabase.from('leads').insert({
                client_id: client.id,
                customer_name: jsonResponse.customer_name,
                customer_phone: jsonResponse.customer_phone,
                customer_email: jsonResponse.customer_email,
                customer_address: jsonResponse.customer_address,
                appointment_request: jsonResponse.appointment_request,
                preferred_method: jsonResponse.preferred_method,
                ai_summary: jsonResponse.ai_summary,
                full_transcript: JSON.stringify([...pastHistory, lastTurn, { role: 'model', parts: [{ text: jsonResponse.reply }] }])
            });
        }

        res.json({ reply: jsonResponse.reply });

    } catch (err) {
        console.error("Server Error:", err);
        res.status(500).json({ reply: "I'm having trouble connecting right now." });
    }
});

app.listen(3000, () => console.log('🚀 Super Agent + Credits Running'));