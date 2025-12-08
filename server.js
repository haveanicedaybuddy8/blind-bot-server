import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import FormData from 'form-data';
import sharp from 'sharp'; // The Image Processor
import { createRequire } from 'module'; 
const require = createRequire(import.meta.url);
const pdf = require('pdf-parse');
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { TaskType } from "@google/generative-ai";

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

// --- HELPER: CREATE EMBEDDINGS (THE "BRAIN" STORAGE) ---
async function createEmbedding(text) {
    const embeddingModel = genAI.getGenerativeModel({ model: "text-embedding-004"});
    const result = await embeddingModel.embedContent({
        content: { parts: [{ text }] },
        taskType: TaskType.RETRIEVAL_DOCUMENT,
    });
    return result.embedding.values;
}

// --- NEW HELPER: ANALYZE IMAGE WITH GEMINI VISION ---
async function analyzeProductImage(imageUrl) {
    try {
        const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        const base64Data = Buffer.from(response.data).toString('base64');
        
        const visionModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const prompt = "Describe this window treatment product in extreme visual detail for a generative AI prompt. Include texture, material, transparency (sheer/opaque), and style. Start with 'A photo of...'. Keep it under 50 words.";
        
        const result = await visionModel.generateContent([
            prompt,
            { inlineData: { data: base64Data, mimeType: "image/jpeg" } }
        ]);
        
        return result.response.text();
    } catch (e) {
        console.error("Failed to analyze image:", imageUrl);
        return null;
    }
}

const systemPrompt = `
You are a senior sales agent for "The Window Valet". 
GOAL: Secure a lead by getting the customer's CONTACT INFO and a HOME VISIT TIME.

VISION CAPABILITIES:
- You CAN see images. When a user uploads a photo, ANALYZE IT.
- Describe the window style (Bay, Bow, Sliding, Double-hung).
- Mention lighting and decor.
- NEVER say "I cannot see images." You have eyes. Use them.

TOOLS (VISUALIZATION):
- IF the user asks to see a product (e.g. "preview", "show me zebra blinds"), set "visualize": true.
- In "visual_style", describe the product clearly (e.g. "modern white zebra blinds, luxury style").

RULES:
1. **Memory:** REMEMBER what the user told you earlier (Name, Room, Issues).
2. **The Home Visit:** Try to schedule a "Free In-Home Estimate."
3. **Contact Info:** You MUST get their Name AND (Phone OR Email). 

OUTPUT FORMAT (JSON ONLY):
{
  "reply": "Your friendly response",
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

app.post('/train-agent', async (req, res) => {
    try {
        const { clientApiKey } = req.body; // We only need the API Key now
        
        // 1. Fetch Client Data (PDF + Gallery Images)
        const { data: client } = await supabase
            .from('clients')
            .select('id, training_pdf, gallery_images')
            .eq('api_key', clientApiKey)
            .single();

        if (!client) return res.status(401).json({ error: "Invalid API Key" });

        console.log(`🧠 Starting training for ${client.id}...`);
        
        // --- PART A: PROCESS PDF (Sales Knowledge) ---
        if (client.training_pdf) {
            try {
                const response = await axios.get(client.training_pdf, { responseType: 'arraybuffer' });
                const pdfData = await pdf(Buffer.from(response.data));
                const chunks = pdfData.text.split('\n\n').filter(c => c.length > 50);

                for (const chunk of chunks) {
                    const vector = await createEmbedding(chunk);
                    await supabase.from('documents').insert({
                        client_id: client.id,
                        content: `[SALES KNOWLEDGE] ${chunk}`,
                        embedding: vector
                    });
                }
                console.log("📄 PDF Knowledge Processed");
            } catch (e) { console.error("PDF Error:", e.message); }
        }

        // --- PART B: PROCESS GALLERY (Visual Knowledge) ---
        if (client.gallery_images) {
            // Softr stores images as comma-separated string: "url1,url2,url3"
            const imageUrls = client.gallery_images.split(',').map(url => url.trim());
            
            for (const url of imageUrls) {
                if (!url) continue;
                
                // 1. Ask Gemini to "Look" at the product
                const visualDescription = await analyzeProductImage(url);
                
                if (visualDescription) {
                    // 2. Save this description so the Chatbot can find it later
                    // We tag it as [PRODUCT VISUAL] so we know it's for generating images
                    const content = `[PRODUCT VISUAL] Reference Description: ${visualDescription}. Use this style when the user asks to see this product. Source URL: ${url}`;
                    const vector = await createEmbedding(content);
                    
                    await supabase.from('documents').insert({
                        client_id: client.id,
                        content: content,
                        embedding: vector
                    });
                    console.log("👁️ Learned visual style for:", visualDescription.substring(0, 30) + "...");
                }
            }
        }

        res.json({ success: true, message: "Agent trained on PDF and Gallery Photos!" });

    } catch (err) {
        console.error("Training Error:", err);
        res.status(500).json({ error: "Training Failed" });
    }
});

app.post('/chat', async (req, res) => {
    try {
        const { history, clientApiKey } = req.body;
        const { data: client } = await supabase.from('clients').select('*').eq('api_key', clientApiKey).single();
        if (!client) return res.json({ reply: "Service Suspended." });

        // 1. GET USER'S LAST MESSAGE
        // We look at the last message to generate the search vector
        const lastMessageObj = history[history.length - 1]; 
        const userQuery = lastMessageObj.parts.map(p => p.text).join(' ');

        // 2. SEARCH KNOWLEDGE BASE (RAG)
        let contextText = "";
        try {
            const embeddingModel = genAI.getGenerativeModel({ model: "text-embedding-004"});
            const result = await embeddingModel.embedContent({
                content: { parts: [{ text: userQuery }] },
                taskType: TaskType.RETRIEVAL_QUERY,
            });
            const queryVector = result.embedding.values;

            const { data: documents } = await supabase.rpc('match_documents', {
                query_embedding: queryVector,
                match_threshold: 0.5, 
                match_count: 3,       
                filter_client_id: client.id
            });

            if (documents && documents.length > 0) {
                contextText = documents.map(d => d.content).join("\n\n");
                console.log("🧠 Knowledge Found:", contextText.substring(0, 50) + "...");
            }
        } catch (e) {
            console.error("Vector Search Failed (continuing without context):", e);
        }

        // 3. COMBINE EVERYTHING INTO THE DYNAMIC PROMPT
        // We take the global 'systemPrompt' (lines 145-167) and add the context and company name to it.
        const dynamicSystemPrompt = `
        You are a senior sales agent for "${client.company_name}".
        
        KNOWLEDGE BASE (CONTEXT FROM CLIENT DOCUMENTS):
        "${contextText}"
        
        If the Knowledge Base has an answer, use it. If not, use your general knowledge.
        
        ${systemPrompt} 
        `; 
        // ^ We injected the 'systemPrompt' variable from the top of your file here.

        const model = genAI.getGenerativeModel({ 
            model: "gemini-2.5-flash", 
            systemInstruction: dynamicSystemPrompt, 
            generationConfig: { responseMimeType: "application/json" }
        });

        // 4. PREPARE CHAT HISTORY
        const lastTurn = history.pop(); 
        const pastHistory = history;
        const chat = model.startChat({ history: pastHistory });

        // 5. HANDLE IMAGES IN MESSAGE
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

        // 6. GENERATE RESPONSE
        const result = await chat.sendMessage(currentParts);
        const cleanText = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
        const jsonResponse = JSON.parse(cleanText);

        // --- VISUALIZATION LOGIC ---
        if (jsonResponse.visualize === true) {
            // If the AI wants to visualize but didn't just get an image, look back in history
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

        // 7. SAVE LEADS
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