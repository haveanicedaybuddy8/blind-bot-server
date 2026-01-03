import dotenv from 'dotenv';
import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';

dotenv.config();

// Use Gemini 1.5 Flash - Best balance of speed & document reading capabilities
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY);

// ---------------------------------------------------------
// 1. HELPER: Download Media (Images or PDFs)
// ---------------------------------------------------------
async function downloadMedia(url) {
    if (!url) return null;
    try {
        console.log(`      ⬇️ Downloading: ${url}`);
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(response.data);
        
        // Simple MIME type detection
        const lowerUrl = url.toLowerCase();
        let mimeType = "image/jpeg"; // Default
        if (lowerUrl.endsWith('.png')) mimeType = "image/png";
        if (lowerUrl.endsWith('.webp')) mimeType = "image/webp";
        if (lowerUrl.endsWith('.pdf')) mimeType = "application/pdf";

        return {
            inlineData: {
                data: buffer.toString('base64'),
                mimeType: mimeType
            }
        };
    } catch (e) { 
        console.error("      ❌ Download failed:", e.message);
        return null; 
    }
}

// ---------------------------------------------------------
// 2. MAIN WORKER
// ---------------------------------------------------------
export async function startProductWorker() {
    console.log("🏭 Product Worker: Running. Watching for new products/files...");

    // Run every 30 seconds
    setInterval(async () => {
        try {
            // Find products that are missing an AI Description
            // We select both the image AND the file url
            const { data: products, error } = await supabase
                .from('product_gallery')
                .select('*')
                .is('ai_description', null);

            if (error) throw error;

            if (products && products.length > 0) {
                console.log(`📝 Found ${products.length} products to analyze.`);
                
                // Switch to 1.5 Flash for better Document + Image handling
                const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

                for (const product of products) {
                    console.log(`   👉 Processing: ${product.name}`);
                    
                    const inputs = [];
                    let prompt = "";

                    // A. Prepare The Media Inputs
                    const filePart = await downloadMedia(product.product_file_url);
                    const imagePart = await downloadMedia(product.image_url);

                    // B. Construct Prompt based on what we found
                    if (filePart && imagePart) {
                        // BEST CASE: We have both File (Specs) + Image (Looks)
                        inputs.push(filePart);
                        inputs.push(imagePart);
                        prompt = `
                        You are a technical window treatment specialist.
                        Task: Create a comprehensive product summary for "${product.name}".
                        
                        Source 1 (Document): Use this strictly for technical specs, available sizes, colors, mount depths, and restrictions.
                        Source 2 (Image): Use this for visual description (texture, light filtering appearance).

                        Output a structured summary paragraph covering:
                        1. Visual Style & Material (from Image).
                        2. Technical Specifications (Size limits, Min depth, Mount types from Doc).
                        3. Available Colors/Patterns (from Doc).
                        4. Functional Benefits (Insulation, Privacy, Motorization).
                        
                        Keep it under 80 words. Focus on facts.
                        `;
                    } 
                    else if (filePart) {
                        // CASE: File Only
                        inputs.push(filePart);
                        prompt = `
                        Read this product document for "${product.name}".
                        Summarize the key sales details: Available sizes, colors, material types, and installation restrictions.
                        Keep it under 60 words.
                        `;
                    } 
                    else if (imagePart) {
                        // CASE: Image Only (Fallback)
                        inputs.push(imagePart);
                        prompt = `
                        Analyze this window treatment image for "${product.name}".
                        Describe the likely material, light filtering capabilities (sheer vs blackout), and style (roller, zebra, cellular, etc).
                        Keep it under 50 words.
                        `;
                    }

                    // C. Generate and Save
                    if (inputs.length > 0) {
                        inputs.push(prompt); // Add prompt as the last argument
                        
                        try {
                            const result = await model.generateContent(inputs);
                            const description = result.response.text();

                            // Save to Supabase
                            const { error: updateError } = await supabase
                                .from('product_gallery')
                                .update({ ai_description: description })
                                .eq('id', product.id);
                                
                            if (updateError) console.error(`      ❌ DB Save Failed: ${updateError.message}`);
                            else console.log(`      ✅ Saved Description!`);
                            
                        } catch (aiErr) {
                            console.error(`      ❌ AI Generation Failed:`, aiErr.message);
                        }
                    } else {
                        console.log(`      ⚠️ No file or image found. Skipping.`);
                    }
                }
            }
        } catch (err) {
            console.error("Product Worker Error:", err.message);
        }
    }, 30000); 
}