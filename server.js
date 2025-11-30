// server.js - The Brain, The Memory, and The Server combined.
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const app = express();
app.use(cors()); // Allow websites to talk to us
app.use(express.json()); // Allow us to read JSON data

// 1. Setup Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
// --- THE BRAIN IMPLANT ---
const companyProfile = `
You are the helpful sales assistant for 'Apex Blinds'. 
Tone: Friendly, professional, and concise.

CORE INFORMATION:
- We specialize in motorized roller shades and honeycomb blinds.
- We are located in Greenwood, Indiana.
- Our hours are 9am - 5pm EST, Mon-Fri.
- We offer free in-home consultations.
- If asked about prices: "Custom blinds depend on window size. I can schedule a free measurement for you."

GOAL:
- Answer questions based ONLY on this info.
- Always try to get the customer to book a consultation.
`;

const model = genAI.getGenerativeModel({ 
    model: "gemini-2.5-flash",
    systemInstruction: companyProfile 
});

// 2. Setup Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// 3. The "Chat" Endpoint (The Waiter)
app.post('/chat', async (req, res) => {
    try {
        console.log("📩 Message received!");
        const { message, clientApiKey } = req.body;

        // --- SECURITY CHECK (The Kill Switch) ---
        const { data: client, error } = await supabase
            .from('clients')
            .select('*')
            .eq('api_key', clientApiKey)
            .single();

        if (error || !client || client.status !== 'active') {
            console.log("⛔ Blocked: Invalid Key or Inactive Account");
            return res.json({ reply: "Service Suspended. Please contact support." });
        }

        // --- ASK GEMINI ---
        // (Later we will add the PDF logic here)
        const result = await model.generateContent(message);
        const aiText = result.response.text();

        // --- SAVE TO DB (Fire and Forget) ---
        await supabase.from('chat_logs').insert({ 
            client_id: client.id, 
            user_message: message, 
            ai_response: aiText 
        });

        // --- SEND REPLY ---
        console.log("✅ Replied:", aiText);
        res.json({ reply: aiText });

    } catch (err) {
        console.error("❌ Error:", err);
        res.status(500).json({ reply: "Internal Server Error" });
    }
});

// 4. Start Listening
app.listen(3000, () => console.log('🚀 Server running on http://localhost:3000'));