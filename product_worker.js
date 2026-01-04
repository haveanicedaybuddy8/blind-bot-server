import dotenv from 'dotenv';
import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY);

// Helper: Download Media
async function downloadMedia(url) {
    if (!url) return null;
    try {
        const cleanUrl = url.trim().replace(/["\[\]]/g, ''); 
        if (cleanUrl.length < 5) return null;

        console.log(`      ⬇️ Downloading: ${cleanUrl.substring(0, 40)}...`);
        const response = await axios.get(cleanUrl, { responseType: 'arraybuffer' });
        const lowerUrl = cleanUrl.toLowerCase();
        let mimeType = "image/jpeg"; 
        if (lowerUrl.endsWith('.png')) mimeType = "image/png";
        if (lowerUrl.endsWith('.pdf')) mimeType = "application/pdf";
        if (lowerUrl.endsWith('.webp')) mimeType = "image/webp";

        return {
            inlineData: {
                data: Buffer.from(response.data).toString('base64'),
                mimeType: mimeType
            }
        };
    } catch (e) { 
        console.error("      ❌ Download failed for an item:", e.message);
        return null; 
    }
}

export async function startProductWorker() {
    console.log("🏭 Universal Spec Worker (With Restrictions): Running...");

    setInterval(async () => {
        try {
            // Find products needing processing (checking 'var_restrictions' as the flag now)
            // If restrictions are null, we assume we need to re-scan this item.
            const { data: products, error } = await supabase
                .from('product_gallery')
                .select('*')
                .is('var_restrictions', null); 

            if (error) throw error;

            if (products && products.length > 0) {
                console.log(`📝 Analyzing ${products.length} products...`);
                
                const model = genAI.getGenerativeModel({ 
                    model: "gemini-3-flash-preview",
                    generationConfig: { responseMimeType: "application/json" } 
                });

                for (const product of products) {
                    console.log(`   👉 Processing: ${product.name}`);
                    
                    const inputs = [];

                    // 1. PRIMARY SOURCES
                    const filePart = await downloadMedia(product.product_file_url);
                    const mainImagePart = await downloadMedia(product.image_url);
                    if (filePart) inputs.push(filePart);
                    if (mainImagePart) inputs.push(mainImagePart);

                    // 2. GALLERY SOURCES
                    if (product.gallery_images && Array.isArray(product.gallery_images)) {
                        const extraImages = product.gallery_images.slice(0, 3);
                        for (const imgUrl of extraImages) {
                            const galleryPart = await downloadMedia(imgUrl);
                            if (galleryPart) inputs.push(galleryPart);
                        }
                    }

                    if (inputs.length > 0) {
                        const prompt = `
                        You are a Window Treatment Technical Specifier.
                        Analyze ALL attached images and documents for "${product.name}".
                        
                        Your goal is to extract the CONFIGURATIONS and RESTRICTIONS.
                        Output strictly JSON.

                        JSON Structure:
                        {
                          "var_transparency": "List opacity/openness options (e.g., '1%, 3%, 5%', 'Blackout').",
                          "var_control": "List operation systems (e.g., 'Cordless, Wand Tilt, Motorized').",
                          "var_structure": "List structure variations (e.g. '2-inch Slat', 'Double Cell', 'Flat Fold').",
                          "var_hardware": "List hardware/valance styles (e.g. 'Square Fascia', 'Cassette', 'Z-Frame').",
                          "var_extras": "List add-ons (e.g. 'Top-Down/Bottom-Up', 'Cloth Tapes').",
                          "var_colors": "List primary colors/finishes.",
                          "var_restrictions": "List CRITICAL limitations. (e.g. 'Max width 96 inches', 'Not for humid areas', 'Indoor use only', 'Requires 3 inch depth'). If none found, write 'Standard installation'.",
                          "ai_description": "A Complete sales summary."
                        }
                        `;
                        
                        inputs.push(prompt);

                        try {
                            const result = await model.generateContent(inputs);
                            const data = JSON.parse(result.response.text());

                            await supabase
                                .from('product_gallery')
                                .update({
                                    var_transparency: data.var_transparency,
                                    var_control: data.var_control,
                                    var_structure: data.var_structure,
                                    var_hardware: data.var_hardware,
                                    var_extras: data.var_extras,
                                    var_colors: data.var_colors,
                                    var_restrictions: data.var_restrictions, // <--- New Field
                                    ai_description: data.ai_description
                                })
                                .eq('id', product.id);
                                
                            console.log(`      ✅ Specs & Restrictions Updated.`);
                            
                        } catch (aiErr) {
                            console.error(`      ❌ AI Analysis Failed:`, aiErr.message);
                        }
                    }
                }
            }
        } catch (err) {
            console.error("Worker Error:", err.message);
        }
    }, 15000); 
}