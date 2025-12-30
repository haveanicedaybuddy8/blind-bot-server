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
import { startPersonaWorker } from './persona_worker.js'; 
import { validateClientAccess, deductImageCredit } from './subscription_manager.js'; 
import { startProductWorker } from './product_worker.js';
import { setupStripeWebhook, createPortalSession } from './stripe_handler.js';
import { handleLeadData } from './leads_manager.js'; 

const require = createRequire(import.meta.url);

dotenv.config();
const app = express();
app.use(cors());
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
setupStripeWebhook(app, supabase);
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ==================================================================
// 1. HELPER FUNCTIONS
// ==================================================================

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
        console.error("❌ Failed to download image for AI analysis:", e.message);
        return null; 
    }
}

async function generateRendering(sourceImageUrl, promptText) {
    try {
        console.log("🎨 Generating with Nano Banana Pro (Gemini 3 Pro Image)...");
        
        // 1. Prepare the model (Nano Banana Pro)
        const imageModel = genAI.getGenerativeModel({ model: "gemini-3-pro-image-preview" });
        
        // 2. Download the room image
        const imagePart = await urlToGenerativePart(sourceImageUrl);
        if (!imagePart) throw new Error("Could not download source image.");

        // 3. Construct Prompt
        const fullPrompt = `
        Turn this room image into a professional interior design photo.
        Apply the following window treatment strictly: ${promptText}.
        Keep the original room layout, furniture, and lighting.
        High resolution, photorealistic, 8k.
        `;

        // 4. Generate (Image-to-Image)
        const result = await imageModel.generateContent([fullPrompt, imagePart]);
        const response = result.response;
        
        // 5. Extract Image
        if (!response.candidates || !response.candidates[0].content.parts) {
            throw new Error("No image generated.");
        }
        const generatedPart = response.candidates[0].content.parts.find(p => p.inlineData);
        if (!generatedPart) throw new Error("API returned text but no image.");

        const base64Image = generatedPart.inlineData.data;

        // 6. Upload to Supabase
        const fileName = `renderings/${Date.now()}_render.png`;
        const { error } = await supabase.storage.from('chat-uploads').upload(fileName, Buffer.from(base64Image, 'base64'), { contentType: 'image/png' });
        
        if (error) throw error;
        const { data: urlData } = supabase.storage.from('chat-uploads').getPublicUrl(fileName);
        return urlData.publicUrl;

    } catch (err) {
        console.error("Nano Banana Error:", err.message);
        return null;
    }
}

// ==================================================================
// 4. NEW: CLIENT CONFIG ENDPOINT
// ==================================================================
app.get('/client-config/:apiKey', async (req, res) => {
    try {
        const { apiKey } = req.params;
        const { data: client, error } = await supabase
            .from('clients')
            .select('primary_color, logo_url, company_name, greeting_override') 
            .eq('api_key', apiKey)
            .single();

        if (error || !client) {
            return res.status(404).json({ error: "Client not found" });
        }

        // Return the customization settings
        res.json({
            color: client.primary_color || "#333333",
            logo: client.logo_url || "",
            name: client.company_name,
            greeting: client.greeting_override || "" 
        });

    } catch (err) {
        console.error("Config Error:", err);
        res.status(500).json({ error: "Server Error" });
    }
});
// ==================================================================
// 3. CHAT ENDPOINT (Unchanged)
// ==================================================================
app.post('/chat', async (req, res) => {
    try {
        const { history, clientApiKey } = req.body;
        const accessCheck = await validateClientAccess(supabase, clientApiKey);

        if (!accessCheck.allowed) {
            return res.json({ reply: accessCheck.error || "Service Suspended." });
        }
        
        const client = accessCheck.client;

        const { data: products } = await supabase
            .from('product_gallery')
            .select('name, description, ai_description, image_url')
            .eq('client_id', client.id);

        const productNames = products ? products.map(p => p.name).join(", ") : "Standard Blinds";
        
        const finalSystemPrompt = `
        CRITICAL: You DO NOT speak plain text. You ONLY speak JSON.
        Structure:
        {
          "reply": "text",
          "product_suggestions": [ { "name": "Exact Name From List", "image": "URL", "id": "index" } ],
          "visualize": boolean,
          "selected_product_name": "Exact Name From List" 
          "lead_data": {
              "name": "User Name (or null)",
              "phone": "Phone (or null)",
              "email": "Email (or null)",
              "address": "Address (or null)",
              "project_summary": "Brief summary of what they want (e.g. '3 zebra blinds for living room')",
              "appointment_request": "Requested time (or null)",
              "preferred_method": "text/call/email",
              "quality_score": 1-10 (judge their purchase intent),
              "ai_summary": "2 sentence summary of conversation so far"
          }
        }

        YOUR IDENTITY AND RULE:
        ${client.bot_persona || "You are a sales assistant."}
        
        AVAILABLE PRODUCTS: ${productNames}

        BEHAVIOR RULES:

        1. SALES GOAL (HIGH PRIORITY):
           - Your ultimate goal is to BOOK AN IN-HOME CONSULTATION.
           - Once the user shows interest or has seen a visualization, you MUST pivot to asking for contact details.
           - Key phrase to work towards: "I can have a designer bring these samples to your home. What is your Name and Phone Number to schedule a visit?"
           - If they ask for price, give a rough idea but say "Exact price depends on measurements. Can we stop by to measure?"
        
        2. WHEN TO SHOW PRODUCT MENU (product_suggestions):
           - DEFAULT: Keep "product_suggestions": [] (Empty Array). Do NOT show the menu for general chat, greetings, or when asking for contact info.
           - SHOW ONLY IF:
             A) The user explicitly asks to see options (e.g. "What styles do you have?", "Show me blinds").
             B) The user has uploaded an image but has NOT selected a product style yet (e.g. "Here is my room, what do you suggest?").
           - TO TRIGGER MENU: Return "product_suggestions": [{ "name": "trigger" }] in your JSON. The system will fill the real data.

        3. UNAVAILABLE PRODUCTS:
           If the user asks for a product NOT in the "AVAILABLE PRODUCTS" list (e.g., they ask for shutters but you only have rollers), you MUST reply:
           "Unfortunately we don't offer that option right now."

        4. VISUALIZATION LOGIC (The 2-Step Requirement):
           You can ONLY set "visualize": true if you have BOTH: (A) A User Uploaded Image in history, AND (B) A specific product selection.

           CASE A: User uploads an image but has NOT selected a product yet.
           - Action: You must ask for the product.
           - Reply: "I see your room! Please select a style below so I can generate a preview."
           - "product_suggestions": [List all items from AVAILABLE PRODUCTS]
           - "visualize": false

           CASE B: User selects a product (e.g. "I want Zebra Blinds") but has NOT uploaded an image.
           - Action: You must ask for the image.
           - Reply: "Great choice! Please upload a photo of your window so I can show you how it looks."
           - "product_suggestions": []
           - "visualize": false

           CASE C: User has BOTH (An image is in the chat history AND they just selected a product).
           - Action: Start generation.
           - Reply: "Generating a preview of [Product Name] in your room now..."
           - "visualize": true
           - "selected_product_name": "[Exact Name]"
           - "product_suggestions": []

           CASE D: General Conversation.
           - If the user is just asking questions and NOT trying to visualize, just answer helpfully. 
           - DO NOT send "product_suggestions" unless they explicitly ask to see options or upload an image.
        `;

        const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview", systemInstruction: finalSystemPrompt, generationConfig: { responseMimeType: "application/json" } });
        
        // C. Parse History for Image
        const pastHistory = history.slice(0, -1);
        const chat = model.startChat({ history: pastHistory });
        const lastTurn = history[history.length - 1];
        
        let currentParts = [];
        let sourceImageUrl = null;
        
        // --- OBJECTIVE FIX: LOOK BACK FOR IMAGE IF NOT IN LAST TURN ---
        for (const part of lastTurn.parts) {
            const imgMatch = part.text.match(/\[IMAGE_URL: (.*?)\]/);
            if (imgMatch) sourceImageUrl = imgMatch[1];
        }

        if (!sourceImageUrl && history.length > 1) {
            for (let i = history.length - 2; i >= 0; i--) {
                const turn = history[i];
                if (turn.role === 'user') {
                    for (const part of turn.parts) {
                        const imgMatch = part.text.match(/\[IMAGE_URL: (.*?)\]/);
                        if (imgMatch) {
                            sourceImageUrl = imgMatch[1];
                            break;
                        }
                    }
                }
                if (sourceImageUrl) break;
            }
        }
        // -------------------------------------------------------------

        for (const part of lastTurn.parts) {
             if (!part.text.includes('[IMAGE_URL:')) {
                  currentParts.push({ text: part.text });
             }
        }
        if (sourceImageUrl) {
             const imagePart = await urlToGenerativePart(sourceImageUrl);
             if (imagePart) currentParts.push(imagePart);
             currentParts.push({ text: "Analyze this image context." });
        }

        const result = await chat.sendMessage(currentParts);
        const jsonResponse = JSON.parse(result.response.text());
        
        if (jsonResponse.product_suggestions && jsonResponse.product_suggestions.length > 0 && products) {
            jsonResponse.product_suggestions = products.map(p => ({
                name: p.name,
                image: p.image_url
            }));
        } else {
            jsonResponse.product_suggestions = [];
        }
    let renderUrl = null;
       if (jsonResponse.visualize && jsonResponse.selected_product_name && sourceImageUrl) {
            const selectedProduct = products.find(p => p.name.toLowerCase() === jsonResponse.selected_product_name.toLowerCase());
            
            if (selectedProduct) {
                // --- NEW CHARGING LOGIC ---
                // We only charge IF we are about to generate
                const canGenerate = await deductImageCredit(supabase, client.id);

                if (canGenerate) {
                    // 1. Success: Generate the Image
                    const desc = selectedProduct.ai_description || selectedProduct.description;
                    const combinedPrompt = `Install ${selectedProduct.name} (${desc}) on the windows.`;
                    
                    console.log(`🎨 Generating with prompt: ${combinedPrompt}`);
                    
                    renderUrl = await generateRendering(sourceImageUrl, combinedPrompt);
                    if (renderUrl) jsonResponse.reply += `\n\n[RENDER_URL: ${renderUrl}]`;
                
                } else {
                    // 2. Failure: No Credits
                    console.log(`🚫 Generation blocked: Insufficient credits for ${client.company_name}`);
                    jsonResponse.reply += "\n\n(System: Preview generation skipped. Insufficient image credits. Please top up in Settings.)";
                    // We turn off visualize so the UI doesn't try to show a broken image
                    jsonResponse.visualize = false; 
                }
            }
        }
        if (jsonResponse.lead_data) {
            const d = jsonResponse.lead_data;
            
            // Inject images into the data payload
            if (sourceImageUrl) d.new_customer_image = sourceImageUrl;
            if (renderUrl) d.new_ai_rendering = renderUrl; // Defined in the scope above

            // Only save if we have contact info or if we just generated valuable data
            if (d.name || d.phone || d.email) {
                handleLeadData(supabase, client.id, d); 
            }
        }
        res.json(jsonResponse);

    } catch (err) {
        console.error(err);
        res.status(500).json({ reply: "Error processing request." });
    }
});
app.get('/create-portal-session/:apiKey', async (req, res) => {
    try {
        const { apiKey } = req.params;
        const { data: client } = await supabase
            .from('clients')
            .select('stripe_customer_id')
            .eq('api_key', apiKey)
            .single();

        if (!client || !client.stripe_customer_id) {
            return res.status(404).send("No active subscription found. Please contact support.");
        }

        const url = await createPortalSession(client.stripe_customer_id);
        res.redirect(url);

    } catch (err) {
        console.error("Portal Error:", err);
        res.status(500).send("Error accessing subscription settings.");
    }
});
startPersonaWorker();
startProductWorker();
app.listen(3000, () => console.log('🚀 Gallery Agent Running'));