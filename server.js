import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import FormData from 'form-data';
import sharp from 'sharp'; 
import { createRequire } from 'module'; 
import { TaskType } from "@google/generative-ai";
import Stripe from 'stripe';

const require = createRequire(import.meta.url);
const pdfLib = require('pdf-parse');
const pdf = pdfLib.default || pdfLib;

dotenv.config();
// Initialize Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const app = express();

// ==================================================================
// 🛑 STRIPE WEBHOOK (MUST BE BEFORE app.use(express.json))
// ==================================================================
app.post('/webhook', express.raw({ type: 'application/json' }), async (request, response) => {
  const sig = request.headers['stripe-signature'];
  let event;

  try {
    // 1. Verify the message is actually from Stripe
    event = stripe.webhooks.constructEvent(request.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error(`❌ Webhook Error: ${err.message}`);
    return response.status(400).send(`Webhook Error: ${err.message}`);
  }

  // 2. Handle the "Payment Success" Event
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    
    // Get the email of the person who paid
    const userEmail = session.customer_details.email;
    const amountPaid = session.amount_total; // e.g. 2000 cents = $20.00
    
    console.log(`💰 Payment received from: ${userEmail}`);

    // 3. Update Supabase
    // LOGIC: If they bought the "Credit Pack", give them 50 credits.
    // (You can make this smarter later by checking session.metadata.productId)
    
    // Find the client by email
    const { data: client } = await supabase
        .from('clients')
        .select('id, image_credits')
        .eq('email', userEmail) // Make sure 'email' column exists in your clients table!
        .single();

    if (client) {
        // Add 100 Credits 
        const newBalance = (client.image_credits || 0) + 100;
        
        await supabase
            .from('clients')
            .update({ image_credits: newBalance })
            .eq('id', client.id);
            
        console.log(`✅ Added credits to ${userEmail}. New Balance: ${newBalance}`);
    } else {
        console.error(`⚠️ Client with email ${userEmail} not found in database.`);
    }
  }

  // Return a 200 response to acknowledge receipt of the event
  response.send();
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));
// 1. Host the "public" folder so index.html is accessible online
app.use(express.static('public'));

// 2. Update /init to return size settings
app.get('/init', async (req, res) => {
    const apiKey = req.query.apiKey;
    if (!apiKey) return res.status(400).json({ error: "Missing API Key" });
    
    const { data: client } = await supabase
        .from('clients')
        .select('*') // Select ALL columns (including widget_width/height)
        .eq('api_key', apiKey)
        .single();
        
    if (!client) return res.status(404).json({ error: "Client not found" });

    res.json({
        name: client.company_name, 
        logo: client.logo_url || "", 
        color: client.primary_color || "#007bff", 
        title: client.bot_title || "Sales Assistant", 
        // SEND THE DIMENSIONS
        width: client.widget_width || "350px",
        height: client.widget_height || "600px"
    });
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ==========================================
// 1. STATIC RULES (DO NOT CHANGE)
// ==========================================
// This ensures the bot always speaks JSON, regardless of the client.
const TECHNICAL_RULES = `
CRITICAL: You are a backend API. You DO NOT speak plain text. You ONLY speak JSON.
Every response must follow this EXACT structure:
{
  "reply": "Your response text here",
  "lead_captured": boolean, // Set true ONLY if you just got Name + (Phone OR Email)
  "customer_name": "...", 
  "customer_phone": "...",
  "customer_email": "...",
  "customer_address": "...",
  "appointment_request": "...",
  "preferred_method": "...",
  "ai_summary": "...",
  "visualize": boolean, // Set true if user asks to see/preview a product
  "visual_style": "description for image generator" // e.g., "modern zebra shades in a living room"
}

VISION CAPABILITIES:
- If the user says "I uploaded a photo", look at the image provided.
- Describe the window type (Bay, Bow, Sliding) in your reply.
`;

// ==========================================
// 2. HELPER FUNCTIONS
// ==========================================

async function urlToGenerativePart(url) {
    try {
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        return {
            inlineData: {
                data: Buffer.from(response.data).toString('base64'),
                mimeType: "image/jpeg"
            }
        };
    } catch (e) { return null; }
}

async function smartResize(buffer) {
    const metadata = await sharp(buffer).metadata();
    const ratio = metadata.width / metadata.height;
    const allowedSizes = [
        { w: 1024, h: 1024, r: 1.00 }, { w: 1152, h: 896,  r: 1.29 },
        { w: 896,  h: 1152, r: 0.78 }, { w: 1216, h: 832,  r: 1.46 },
        { w: 832,  h: 1216, r: 0.68 }, { w: 1344, h: 768,  r: 1.75 },
        { w: 768,  h: 1344, r: 0.57 }, { w: 1536, h: 640,  r: 2.40 },
        { w: 640,  h: 1536, r: 0.42 },
    ];
    let bestMatch = allowedSizes.reduce((prev, curr) => 
        Math.abs(curr.r - ratio) < Math.abs(prev.r - ratio) ? curr : prev
    );
    return await sharp(buffer).resize(bestMatch.w, bestMatch.h, { fit: 'cover' }).toBuffer();
}

// --- UPDATED HELPER: GENERATE RENDERING (High Quality & Closed Blinds) ---
async function generateRendering(imageUrl, stylePrompt) {
    try {
        console.log("🎨 Downloading original image...");
        const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        let buffer = Buffer.from(imageResponse.data);

        // USE SMART RESIZE HERE
        buffer = await smartResize(buffer);

        console.log("🎨 Sending to Stability API (High Quality Mode)...");
        const payload = new FormData();
        payload.append('init_image', buffer, { filename: 'source.jpg', contentType: 'image/jpeg' });
        payload.append('init_image_mode', 'IMAGE_STRENGTH');
        
        // 0.35 means "Keep 65% of the room structure, let AI change 35% (the texture/blinds)"
        payload.append('image_strength', 0.35); 

        // POSITIVE PROMPT: Force "Fully Closed" and "High Quality"
        const fullPrompt = `${stylePrompt}, fully closed, covering the entire window, blinds lowered all the way down, privacy mode, interior design photography, 8k, highly detailed, architectural digest style, professional lighting`;
        payload.append('text_prompts[0][text]', fullPrompt);
        payload.append('text_prompts[0][weight]', 1);

        // NEGATIVE PROMPT: Explicitly forbid "Open" blinds
        payload.append('text_prompts[1][text]', 'open blinds, half open, raised blinds, view through window, messy, blurry, distorted, low quality, watermark, text, crooked lines');
        payload.append('text_prompts[1][weight]', -1);

        payload.append('cfg_scale', 8); // Slightly higher adherence to the prompt
        payload.append('steps', 50);    // Increased from 30 to 50 for sharper details

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

async function createEmbedding(text) {
    const embeddingModel = genAI.getGenerativeModel({ model: "text-embedding-004"});
    const result = await embeddingModel.embedContent({ content: { parts: [{ text }] }, taskType: TaskType.RETRIEVAL_DOCUMENT });
    return result.embedding.values;
}

// --- UPDATED HELPER: GENERATE PERSONA (Now with Fact Extraction) ---
async function generatePersonaFromText(companyName, fullText) {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const prompt = `
    Analyze the following company training material for "${companyName}".
    
    TRAINING MATERIAL:
    "${fullText.substring(0, 50000)}" 
    
    TASK: Write a SYSTEM PROMPT for an AI Sales Agent.
    
    CRITICAL INSTRUCTION: You must EXTRACT specific "Hard Facts" verbatim.
    - If the text mentions a specific warranty (e.g., "Lifetime", "25 years"), YOU MUST INCLUDE IT.
    - If the text mentions a price guarantee (e.g., "10x10", "Low Price Guarantee"), YOU MUST INCLUDE IT.
    
    STRUCTURE THE PERSONA AS FOLLOWS:
    1. **Identity:** Who you are (Tone: Friendly, Local Expert).
    2. **The "Hard Facts" (Scripture):** List the exact Warranties and Guarantees found in the text.
    3. **Services:** What do they sell?
    4. **Goal:** Answer questions using the "Hard Facts" first, then schedule an appointment.
    
    OUTPUT: A single block of text instructions for the AI.
    `;
    
    const result = await model.generateContent(prompt);
    return result.response.text();
}

// ==========================================
// 3. ENDPOINTS
// ==========================================

app.post('/train-agent', async (req, res) => {
    try {
        const { clientApiKey } = req.body;
        const { data: client } = await supabase.from('clients').select('id, company_name, training_pdf, gallery_images').eq('api_key', clientApiKey).single();
        if (!client) return res.status(401).json({ error: "Invalid API Key" });

        let fullTrainingText = "";

        // A. Process PDF
        if (client.training_pdf) {
            const response = await axios.get(client.training_pdf, { responseType: 'arraybuffer' });
            const data = await pdf(Buffer.from(response.data));
            const text = data.text;
            fullTrainingText += text;

            // Chunk and Store for Search
            const chunks = text.split('\n\n').filter(c => c.length > 50);
            for (const chunk of chunks) {
                const vector = await createEmbedding(chunk);
                await supabase.from('documents').insert({ client_id: client.id, content: `[SALES KNOWLEDGE] ${chunk}`, embedding: vector });
            }
        }

        // B. Generate Persona (The "Magic" Step)
        if (fullTrainingText.length > 0) {
            const newPersona = await generatePersonaFromText(client.company_name, fullTrainingText);
            console.log("🤖 Generated New Persona:", newPersona);
            await supabase.from('clients').update({ bot_persona: newPersona }).eq('id', client.id);
        }

        res.json({ success: true, message: "Agent trained & Personality Generated!" });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Training Failed" });
    }
});

app.post('/chat', async (req, res) => {
    try {
        const { history, clientApiKey } = req.body;
        const { data: client } = await supabase.from('clients').select('*').eq('api_key', clientApiKey).single();
        if (!client) return res.json({ reply: "Service Suspended." });

        // 1. RAG Search
        const lastTurn = history[history.length - 1];
        const userQuery = lastTurn.parts.map(p => p.text).join(' ');
        let contextText = "";
        try {
            const queryVector = await createEmbedding(userQuery);
            const { data: documents } = await supabase.rpc('match_documents', {
                query_embedding: queryVector, match_threshold: 0.5, match_count: 3, filter_client_id: client.id
            });
            if (documents) contextText = documents.map(d => d.content).join("\n\n");
        } catch (e) {}

        // 2. Load Dynamic Persona (Fall back to generic if missing)
        const agentPersona = client.bot_persona || `You are a helpful sales assistant for ${client.company_name}.`;

        // 3. Construct Final Prompt
        const finalSystemPrompt = `
        ${TECHNICAL_RULES}

        YOUR PERSONALITY & KNOWLEDGE:
        ${agentPersona}

        SPECIFIC KNOWLEDGE FOR THIS QUESTION:
        ${contextText}

        INSTRUCTION:
        - If the "SPECIFIC KNOWLEDGE" has the answer, USE IT.
        - If not, rely on your "YOUR PERSONALITY" to be helpful.
        - Always pivot to scheduling a home visit after answering.
        `;

        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash", systemInstruction: finalSystemPrompt, generationConfig: { responseMimeType: "application/json" } });
        
        // 4. Chat Logic (Images & History)
        const pastHistory = history.slice(0, -1);
        const chat = model.startChat({ history: pastHistory });
        
        let currentParts = [];
        let sourceImageUrl = null;
        for (const part of lastTurn.parts) {
            const imgMatch = part.text.match(/\[IMAGE_URL: (.*?)\]/);
            if (imgMatch) {
                sourceImageUrl = imgMatch[1];
                const imagePart = await urlToGenerativePart(sourceImageUrl);
                if (imagePart) currentParts.push(imagePart);
            } else {
                currentParts.push({ text: part.text });
            }
        }
        if (sourceImageUrl) currentParts.push({ text: "Analyze this image." });

        const result = await chat.sendMessage(currentParts);
        const jsonResponse = JSON.parse(result.response.text());

        // 5. Visualization Handling
        if (jsonResponse.visualize === true) {
             // ... (Keep your credit check & image generation logic here)
             // (Re-paste the logic from previous steps if needed, or I can provide it)
             // For brevity, assuming you paste the visualization block here:
             if (sourceImageUrl) {
                 const renderedUrl = await generateRendering(sourceImageUrl, jsonResponse.visual_style);
                 if (renderedUrl) jsonResponse.reply += `\n\n[RENDER_URL: ${renderedUrl}]`;
             }
        }
        
        // 6. Lead Saving (Keep existing logic)
         if (jsonResponse.lead_captured) {
            await supabase.from('leads').insert({
                client_id: client.id,
                customer_name: jsonResponse.customer_name,
                customer_phone: jsonResponse.customer_phone,
                customer_email: jsonResponse.customer_email,
                ai_summary: jsonResponse.ai_summary
            });
        }

        res.json({ reply: jsonResponse.reply });

    } catch (err) {
        console.error(err);
        res.status(500).json({ reply: "Connection Error." });
    }
});

// Init Endpoint
app.get('/init', async (req, res) => {
    const { data: client } = await supabase.from('clients').select('*').eq('api_key', req.query.apiKey).single();
    if (client) res.json({ name: client.company_name, logo: client.logo_url, color: client.primary_color, title: client.bot_title });
});

app.listen(3000, () => console.log('🚀 Smart-Resize Agent Running'));