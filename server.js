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
  "options": ["Option A", "Option B"], // NEW: Optional array of string buttons
  "lead_captured": boolean, 
  "customer_name": "...", 
  "customer_phone": "...",
  "customer_email": "...",
  "customer_address": "...",
  "appointment_request": "...",
  "preferred_method": "...",
  "ai_summary": "...",
  "visualize": boolean, 
  "visual_style": "description for image generator" 
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

// --- UPDATED HELPER: GENERATE RENDERING (Stable Image Ultra) ---
async function generateRendering(imageUrl, stylePrompt) {
    try {
        console.log("🎨 Downloading original image...");
        const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        let buffer = Buffer.from(imageResponse.data);

        // Resize is still recommended to save bandwidth and improve processing speed
        buffer = await smartResize(buffer);

        console.log("💎 Sending to Stability API (Ultra Model)...");
        const payload = new FormData();
        
        // 1. IMAGE: The field name is now 'image', not 'init_image'
        payload.append('image', buffer, 'source.jpg');
        
        // 2. STRENGTH: Controls how much the AI changes the photo.
        // 0.0 = No change, 1.0 = Complete hallucination.
        // 0.65 is optimal for keeping the room structure but ensuring the blinds actually appear.
        payload.append('strength', 0.65); 

        // 3. POSITIVE PROMPT: Now a single string
        const fullPrompt = `${stylePrompt}, fully closed, covering the entire window, blinds lowered all the way down, privacy mode, interior design photography, 8k, highly detailed, architectural digest style, professional lighting`;
        payload.append('prompt', fullPrompt);
        
        // 4. NEGATIVE PROMPT: Now a separate field
        payload.append('negative_prompt', 'distorted windows, blurry, low quality, cartoon, illustration, messy room, watermarks, open blinds, half open, raised blinds, view through window');

        // 5. FORMAT
        payload.append('output_format', 'png');

        // NOTE: 'steps' and 'cfg_scale' are NOT supported in Ultra (it handles them automatically)

        const response = await axios.post(
            'https://api.stability.ai/v2beta/stable-image/generate/core',
            payload,
            {
                headers: {
                    ...payload.getHeaders(),
                    Authorization: `Bearer ${process.env.STABILITY_API_KEY}`, 
                    Accept: 'application/json', // Critical: Tells API to return JSON with base64
                },
            }
        );

        console.log("💎 Ultra Success! Saving result...");
        
        // 6. PARSING: The new API returns { image: "base64string" } directly
        const base64Image = response.data.image; 
        const imageBuffer = Buffer.from(base64Image, 'base64');
        const fileName = `renderings/${Date.now()}_ultra.png`;

        const { error } = await supabase.storage.from('chat-uploads').upload(fileName, imageBuffer, { contentType: 'image/png' });
        if (error) throw error;

        const { data: urlData } = supabase.storage.from('chat-uploads').getPublicUrl(fileName);
        return urlData.publicUrl;

    } catch (error) {
        if (error.response) {
            // Stability V2 error messages are usually in error.response.data.errors
            console.error("❌ Stability API Error:", error.response.status, JSON.stringify(error.response.data));
        } else {
            console.error("❌ Internal Rendering Error:", error.message);
        }
        return null;
    }
}
async function generatePersonaFromText(companyName, text) {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const prompt = `
    Analyze the following sales training text for "${companyName}".
    Create a "System Persona" for an AI sales agent.
    The persona should describe the tone (e.g. professional, friendly, luxury), key selling points, and specific vocabulary to use.
    Keep it under 200 words.

    TEXT:
    ${text.substring(0, 10000)} 
    `;
    const result = await model.generateContent(prompt);
    return result.response.text();
}

async function createEmbedding(text) {
    const embeddingModel = genAI.getGenerativeModel({ model: "text-embedding-004"});
    const result = await embeddingModel.embedContent({ content: { parts: [{ text }] }, taskType: TaskType.RETRIEVAL_DOCUMENT });
    return result.embedding.values;
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
        console.log("📨 --- NEW CHAT REQUEST RECEIVED ---");
        const { history, clientApiKey } = req.body;
        
        // 1. Log Client Lookup
        const { data: client } = await supabase.from('clients').select('*').eq('api_key', clientApiKey).single();
        if (!client) {
            console.log("❌ Client Lookup Failed: API Key not found.");
            return res.json({ reply: "Service Suspended." });
        }
        console.log(`✅ Client Verified: ${client.email} | Credits: ${client.image_credits}`);

        // 2. Load Dynamic Persona & Products
        const agentPersona = client.bot_persona || `You are a helpful sales assistant for ${client.company_name}.`;
        let productConfig = client.product_config;
        if (!productConfig || !Array.isArray(productConfig)) {
            productConfig = [
                { name: "Zebra Blinds", ai_prompt: "modern dual-layered fabric..." },
                { name: "Roller Shades", ai_prompt: "sleek flat fabric shade..." }
            ];
        }
        const productNames = productConfig.map(p => p.name).join(", ");

        // 3. Construct Prompt
        const finalSystemPrompt = `
        ${TECHNICAL_RULES}
        YOUR PERSONALITY & KNOWLEDGE:
        ${agentPersona}
        PRODUCTS WE SELL:
        ${productNames}
        VISUALIZATION RULES:
        - If the user asks to see a specific product, you must set "visual_style" to the description in: ${JSON.stringify(productConfig)}
        - If the user provides an image, assume they want to visualize it.
        INSTRUCTION:
        - Use the "options" array for product choices.
        `;

        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash", systemInstruction: finalSystemPrompt, generationConfig: { responseMimeType: "application/json" } });
        
        // 4. Chat Logic & Image Extraction
        const pastHistory = history.slice(0, -1);
        const chat = model.startChat({ history: pastHistory });
        const lastTurn = history[history.length - 1];
        
        let currentParts = [];
        let sourceImageUrl = null;
        
        console.log("🔍 Analyzing User Input...");
        for (const part of lastTurn.parts) {
            console.log(`   -> Input Part: ${part.text.substring(0, 50)}...`); // Log first 50 chars
            const imgMatch = part.text.match(/\[IMAGE_URL: (.*?)\]/);
            if (imgMatch) {
                sourceImageUrl = imgMatch[1];
                console.log(`   📸 FOUND IMAGE URL: ${sourceImageUrl}`);
                const imagePart = await urlToGenerativePart(sourceImageUrl);
                if (imagePart) currentParts.push(imagePart);
            } else {
                currentParts.push({ text: part.text });
            }
        }
        if (sourceImageUrl) currentParts.push({ text: "Analyze this image." });

        const result = await chat.sendMessage(currentParts);
        const jsonResponse = JSON.parse(result.response.text());
        
        console.log("🤖 Gemini Response Decision:", {
            visualize: jsonResponse.visualize,
            visual_style: jsonResponse.visual_style ? "Style Present" : "Missing"
        });

        // 5. Visualization Handling
        if (jsonResponse.visualize === true) {             
             // A. Check Credits
             if (client.image_credits <= 0) {
                 console.log("⛔ Visualization blocked: No credits.");
                 jsonResponse.reply += "\n\n(System Note: Out of visualization credits.)";
             } 
             // B. Generate Image
             else if (sourceImageUrl) {
                 console.log("🚀 Starting Image Generation...");
                 try {
                     // SWITCHED TO CORE MODEL FOR RELIABILITY
                     // Make sure to use 'core' if 'ultra' is failing silently
                     const renderedUrl = await generateRendering(sourceImageUrl, jsonResponse.visual_style);
                     
                     if (renderedUrl) {
                         console.log("✨ Generation Success:", renderedUrl);
                         jsonResponse.reply += `\n\n[RENDER_URL: ${renderedUrl}]`;
                         await supabase.rpc('decrement_credits', { row_id: client.id, count: 1 });
                     } else {
                         console.log("❌ Generation Failed: renderedUrl was null.");
                         jsonResponse.reply += "\n\n(Server busy, please try again.)";
                     }
                 } catch (err) {
                     console.error("❌ Render Error Exception:", err);
                 }
             } else {
                 console.log("⚠️ Gemini wanted to visualize, but NO SOURCE IMAGE was found.");
             }
        }

        // 6. Lead Capture
         if (jsonResponse.lead_captured) {
            await supabase.from('leads').insert({
                client_id: client.id,
                customer_name: jsonResponse.customer_name,
                customer_email: jsonResponse.customer_email,
                ai_summary: jsonResponse.ai_summary
            });
        }

        res.json({ reply: jsonResponse.reply, options: jsonResponse.options });

    } catch (err) {
        console.error("🔥 CRITICAL SERVER ERROR:", err);
        res.status(500).json({ reply: "Connection Error." });
    }
});

// Init Endpoint

app.listen(3000, () => console.log('🚀 Smart-Resize Agent Running'));