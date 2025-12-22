import dotenv from 'dotenv';
import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import { createRequire } from 'module'; 

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse'); 

// 🔍 DEBUGGING LINES (Add these temporarily)
console.log("------------------------------------------------");
console.log("DEBUGGING PDF PARSE:");
console.log("Type of pdfParse:", typeof pdfParse);
console.log("Is it a function?", typeof pdfParse === 'function');
console.log("Structure:", pdfParse);
console.log("Does it have .default?", pdfParse.default);
console.log("------------------------------------------------");

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// --- HELPER: Download & Parse File ---
async function extractContentFromUrl(url) {
    if (!url) return null;
    try {
        // Fix spaces in filenames (e.g. "home screen.pdf" -> "home%20screen.pdf")
        const safeUrl = encodeURI(url);
        
        console.log(`      📂 Downloading: ${safeUrl}`);
        const response = await axios.get(safeUrl, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(response.data);
        
        if (url.toLowerCase().includes('.pdf')) {
            // Check if it's a real PDF file header
            if (buffer.lastIndexOf("%PDF-", 0) === 0) {
                 const data = await pdfParse(buffer);
                 return data.text.substring(0, 30000); 
            } else {
                 console.log("      ⚠️ File extension is .pdf but content is not (likely an image/error).");
                 return null;
            }
        } else {
            return "[Image Content Not Parsed]";
        }
    } catch (e) {
        console.error("      ❌ File parsing failed:", e.message);
        return null;
    }
}

// --- MAIN WORKER ---
export async function startPersonaWorker() {
    console.log("👷 Persona Worker: Started. Watching for empty 'bot_persona' fields...");

    setInterval(async () => {
        try {
            // Heartbeat log so you know it's alive (optional, remove later if noisy)
            // console.log("...Heartbeat: Checking DB for updates...");

            // 1. Find clients who HAVE inputs but NO Persona yet
            const { data: clients, error } = await supabase
                .from('clients')
                .select('*')
                .or('training_pdf.neq.null,sales_prompt_override.neq.null') 
                .is('bot_persona', null); 

            if (clients && clients.length > 0) {
                console.log(`📝 Found ${clients.length} clients needing AI Persona generation...`);
                const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

                for (const client of clients) {
                    console.log(`   -> Processing: ${client.company_name}`);
                    
                    let pdfContent = "No Training Document provided.";
                    if (client.training_pdf) {
                        const extracted = await extractContentFromUrl(client.training_pdf);
                        if (extracted) pdfContent = extracted;
                    }

                    const override = client.sales_prompt_override || "No specific owner instructions.";

                    const systemPrompt = `
                    You are an expert AI Sales System Architect.
                    
                    YOUR GOAL: 
                    Write a "System Instruction" block for a Sales Chatbot.
                    
                    INPUT DATA:
                    1. OWNER INSTRUCTIONS (High Priority): "${override}"
                    2. COMPANY DOCUMENTS: "${pdfContent}"

                    RULES:
                    - IGNORE visual descriptions (logos, layout).
                    - EXTRACT Policy, Discounts, Hours, and Contact Info.
                    - IF Owner Instructions contradict PDF, Owner Instructions WIN.
                    - Output format: "You are the sales assistant for [Company]..."
                    `;

                    const result = await model.generateContent(systemPrompt);
                    const generatedPersona = result.response.text();

                    await supabase
                        .from('clients')
                        .update({ bot_persona: generatedPersona })
                        .eq('id', client.id);

                    console.log(`      ✅ Persona Saved for ${client.company_name}!`);
                }
            }
        } catch (err) {
            console.error("Persona Worker Error:", err.message);
        }
    }, 10000); // Check every 10 seconds
}