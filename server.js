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

const require = createRequire(import.meta.url);
const pdfLib = require('pdf-extraction');
const pdf = pdfLib.default || pdfLib;

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

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
    // (Your existing visualization logic - unchanged)
    try {
        console.log("🎨 Downloading customer room image...");
        const imageResponse = await axios.get(sourceImageUrl, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(imageResponse.data);

        console.log("💎 Sending to Stability AI...");
        const payload = new FormData();
        payload.append('image', buffer, 'source.jpg');
        payload.append('strength', 0.65); 
        
        const fullPrompt = `${promptText}, fully closed, covering window, interior design photography, 8k, professional lighting`;
        
        payload.append('prompt', fullPrompt);
        payload.append('output_format', 'png');
        payload.append('negative_prompt', 'distorted, blurry, open blinds, bad architecture');

        const response = await axios.post(
            'https://api.stability.ai/v2beta/stable-image/generate/core',
            payload,
            { headers: { ...payload.getHeaders(), Authorization: `Bearer ${process.env.STABILITY_API_KEY}`, Accept: 'application/json' } }
        );

        const base64Image = response.data.image; 
        const fileName = `renderings/${Date.now()}_render.png`;
        const { error } = await supabase.storage.from('chat-uploads').upload(fileName, Buffer.from(base64Image, 'base64'), { contentType: 'image/png' });
        
        const { data: urlData } = supabase.storage.from('chat-uploads').getPublicUrl(fileName);
        return urlData.publicUrl;
    } catch (err) {
        console.error("Stability Error:", err.response ? err.response.data : err.message);
        return null;
    }
}

// ==================================================================
// 2. NEW: AUTOMATIC BACKGROUND FIXER
// ==================================================================
// This runs every 30 seconds to fix NULL descriptions
async function checkAndFixDescriptions() {
    try {
        // 1. Find products where ai_description is NULL
        const { data: products, error } = await supabase
            .from('product_gallery')
            .select('*')
            .is('ai_description', null)
            .not('image_url', 'is', null); // Ensure image exists

        if (error) throw error;

        if (products && products.length > 0) {
            console.log(`🧹 Found ${products.length} products missing AI descriptions. Fixing...`);

            const visionModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

            for (const product of products) {
                console.log(`   -> Generating description for: ${product.name}`);
                
                const imagePart = await urlToGenerativePart(product.image_url);
                
                if (imagePart) {
                    const prompt = "Describe the window treatment in this image specifically for an AI image generator. Focus on texture, color, material, style (e.g. zebra, roller), and light filtering. Keep it under 20 words.";
                    
                    try {
                        const result = await visionModel.generateContent([prompt, imagePart]);
                        const aiDesc = result.response.text();

                        // Update the database
                        await supabase
                            .from('product_gallery')
                            .update({ ai_description: aiDesc })
                            .eq('id', product.id);
                            
                        console.log(`      ✅ Fixed!`);
                    } catch (aiErr) {
                        console.error(`      ❌ AI Generation Failed for ${product.name}:`, aiErr.message);
                    }
                }
            }
        }
    } catch (err) {
        console.error("Background Worker Error:", err.message);
    }
}

// Start the timer (Run every 30 seconds)
setInterval(checkAndFixDescriptions, 30000);
// Run once immediately on startup
checkAndFixDescriptions();

// ==================================================================
// 4. NEW: CLIENT CONFIG ENDPOINT
// ==================================================================
app.get('/client-config/:apiKey', async (req, res) => {
    try {
        const { apiKey } = req.params;
        const { data: client, error } = await supabase
            .from('clients')
            .select('primary_color, logo_url, company_name') // ⚠️ Make sure these column names match your Supabase table
            .eq('api_key', apiKey)
            .single();

        if (error || !client) {
            return res.status(404).json({ error: "Client not found" });
        }

        // Return the customization settings
        res.json({
            color: client.primary_color || "#333333", // Fallback color
            logo: client.logo_url || "",
            name: client.company_name
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
        
        const { data: client } = await supabase.from('clients').select('*').eq('api_key', clientApiKey).single();
        if (!client) return res.json({ reply: "Service Suspended." });

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
        }

        YOUR IDENTITY AND RULE:
        ${client.bot_persona || "You are a sales assistant."}
        
        AVAILABLE PRODUCTS: ${productNames}

        LOGIC:
        1. If user uploads a room image but NO style is selected -> Set "visualize": false. Reply "I see your room! Which style would you like?" and fill "product_suggestions" with the available products.
        2. If user selects a product (e.g. "I want Zebra Blinds") -> Set "visualize": true, and set "selected_product_name" to the exact name.
        `;

        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash", systemInstruction: finalSystemPrompt, generationConfig: { responseMimeType: "application/json" } });
        
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

        if (jsonResponse.product_suggestions && products) {
            jsonResponse.product_suggestions = products.map(p => ({
                name: p.name,
                image: p.image_url
            }));
        }

        if (jsonResponse.visualize && jsonResponse.selected_product_name && sourceImageUrl) {
            const selectedProduct = products.find(p => p.name.toLowerCase() === jsonResponse.selected_product_name.toLowerCase());
            
            if (selectedProduct) {
                // FALLBACK: If AI description is still null (script hasn't run yet), use plain description
                const desc = selectedProduct.ai_description || selectedProduct.description;
                const combinedPrompt = `${selectedProduct.description}. ${desc}`;
                
                console.log(`🎨 Generating with prompt: ${combinedPrompt}`);
                
                const renderUrl = await generateRendering(sourceImageUrl, combinedPrompt);
                if (renderUrl) jsonResponse.reply += `\n\n[RENDER_URL: ${renderUrl}]`;
            }
        }

        res.json(jsonResponse);

    } catch (err) {
        console.error(err);
        res.status(500).json({ reply: "Error processing request." });
    }
});

startPersonaWorker();
app.listen(3000, () => console.log('🚀 Gallery Agent Running'));