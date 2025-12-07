import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import FormData from 'form-data';
import sharp from 'sharp'; // The Image Processor

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

// --- HELPER: SMART RESIZE FOR SDXL ---
async function smartResize(buffer) {
    // 1. Get original dimensions
    const metadata = await sharp(buffer).metadata();
    const ratio = metadata.width / metadata.height;

    // 2. Define Stability AI's Allowed Dimensions (The "Buckets")
    const allowedSizes = [
        { w: 1024, h: 1024, r: 1.00 }, // Square
        { w: 1152, h: 896,  r: 1.29 }, // Slightly Wide
        { w: 896,  h: 1152, r: 0.78 }, // Slightly Tall
        { w: 1216, h: 832,  r: 1.46 }, // Wider
        { w: 832,  h: 1216, r: 0.68 }, // Taller
        { w: 1344, h: 768,  r: 1.75 }, // Very Wide (16:9ish)
        { w: 768,  h: 1344, r: 0.57 }, // Very Tall (9:16ish)
        { w: 1536, h: 640,  r: 2.40 }, // Ultra Wide
        { w: 640,  h: 1536, r: 0.42 }, // Ultra Tall
    ];

    // 3. Find the closest match
    // We compare the user's ratio to the allowed ratios and pick the winner
    let bestMatch = allowedSizes[0];
    let minDiff = Math.abs(ratio - bestMatch.r);

    for (const size of allowedSizes) {
        const diff = Math.abs(ratio - size.r);
        if (diff < minDiff) {
            minDiff = diff;
            bestMatch = size;
        }
    }

    console.log(`🎨 Smart Resize: Original ${metadata.width}x${metadata.height} (${ratio.toFixed(2)}) -> Target ${bestMatch.w}x${bestMatch.h}`);

    // 4. Resize to that specific target
    return await sharp(buffer)
        .resize(bestMatch.w, bestMatch.h, { fit: 'cover' }) // 'cover' prevents squishing
        .toBuffer();
}

// --- HELPER: GENERATE RENDERING ---
async function generateRendering(imageUrl, stylePrompt) {
    try {
        console.log("🎨 Downloading original image...");
        const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        let buffer = Buffer.from(imageResponse.data);

        // USE SMART RESIZE HERE
        buffer = await smartResize(buffer);

        console.log("🎨 Sending to Stability API...");
        const payload = new FormData();
        payload.append('init_image', buffer, { filename: 'source.jpg', contentType: 'image/jpeg' });
        payload.append('init_image_mode', 'IMAGE_STRENGTH');
        payload.append('image_strength', 0.35); // Keep 65% of original room
        payload.append('text_prompts[0][text]', `${stylePrompt}, interior design photography, 8k, realistic, high quality`);
        payload.append('text_prompts[0][weight]', 1);
        payload.append('cfg_scale', 7);
        payload.append('steps', 30);

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

        console.log("🎨 Stability Success! Saving result...");
        const base64Image = response.data.artifacts[0].base64;
        const imageBuffer = Buffer.from(base64Image, 'base64');
        const fileName = `renderings/${Date.now()}_ai.png`;

        const { error } = await supabase.storage.from('chat-uploads').upload(fileName, imageBuffer, { contentType: 'image/png' });
        if (error) throw error;

        const { data: urlData } = supabase.storage.from('chat-uploads').getPublicUrl(fileName);
        return urlData.publicUrl;

    } catch (error) {
        if (error.response) {
            console.error("❌ Stability API Error:", error.response.status, JSON.stringify(error.response.data));
        } else {
            console.error("❌ Internal Rendering Error:", error.message);
        }
        return null;
    }
}

const systemPrompt = `
You are a senior sales agent for "The Window Valet". 
GOAL: Secure a lead by getting the customer's CONTACT INFO and a HOME VISIT TIME.

RULES:
1. **Memory:** REMEMBER what the user told you earlier (Name, Room, Issues).
2. **The Home Visit:** Try to schedule a "Free In-Home Estimate."
3. **Contact Info:** You MUST get their Name AND (Phone OR Email). 

TOOLS:
- You can GENERATE RENDERINGS. 
- If the user asks to see a product (e.g. "preview", "show me zebra blinds"), set "visualize": true.
- In "visual_style", describe the NEW product clearly (e.g. "modern black and white zebra blinds").

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
        const { data: client } = await supabase.from('clients').select('*').eq('api_key', clientApiKey).single();
        if (!client || client.status !== 'active') return res.json({ reply: "Service Suspended." });

        const model = genAI.getGenerativeModel({ 
            model: "gemini-2.5-flash", 
            systemInstruction: systemPrompt,
            generationConfig: { responseMimeType: "application/json" }
        });

        const lastTurn = history.pop(); 
        const pastHistory = history;
        const chat = model.startChat({ history: pastHistory });

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

        const result = await chat.sendMessage(currentParts);
        const cleanText = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
        const jsonResponse = JSON.parse(cleanText);

        // --- VISUALIZATION LOGIC ---
        if (jsonResponse.visualize === true) {
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
                // CREDIT CHECK
                const { data: wallet } = await supabase.from('clients').select('image_credits').eq('id', client.id).single();
                
                if (!wallet || wallet.image_credits < 1) {
                    jsonResponse.reply += " (I'd love to generate a preview, but your account is out of credits.)";
                } else {
                    await supabase.from('clients').update({ image_credits: wallet.image_credits - 1 }).eq('id', client.id);
                    await supabase.from('credit_usage').insert({ client_id: client.id, credits_spent: 1, action_type: 'rendering' });
                    
                    const renderedUrl = await generateRendering(sourceImageUrl, jsonResponse.visual_style);
                    if (renderedUrl) jsonResponse.reply += `\n\n[RENDER_URL: ${renderedUrl}]`;
                }
            }
        }

        if (jsonResponse.lead_captured && (jsonResponse.customer_phone || jsonResponse.customer_email)) {
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

app.listen(3000, () => console.log('🚀 Smart-Resize Agent Running'));