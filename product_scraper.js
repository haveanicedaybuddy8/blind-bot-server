import axios from 'axios';
import * as cheerio from 'cheerio';
import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from 'dotenv';

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function analyzeProductCandidate(existingProducts, newItemName, imageUrl) {
    try {
        // Switch to Gemini 2.0 Flash for speed and better visual recognition
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
        
        const namesList = existingProducts.map(p => `ID_${p.id}: ${p.name}`).join("\n");
        
        const prompt = `
        I am a scraper for a Window Blind store. I found an image.
        
        Item Name: "${newItemName}"
        Image URL: "${imageUrl}"
        
        EXISTING DATABASE:
        ${namesList}

        TASK 1 (FILTER): Is this item likely a "Color Swatch", "Fabric Sample", "Texture Zoom-in", or "Icon"?
        - Clues: Name is just a color (e.g. "Pink", "Off-White"), URL contains 'swatch', 'chip', 'texture', 'thumb'.
        - If it is a swatch/sample, return "INVALID".
        
        TASK 2 (MATCH): If it is a REAL product (a full blind on a window), is it a variation of an existing one?
        - If yes, return the ID (e.g. "ID_123").
        
        TASK 3 (NEW): If it is a REAL product and NOT in the database, return "NEW".

        OUTPUT FORMAT: Just one word: "INVALID", "NEW", or "ID_xxx".
        `;

        const result = await model.generateContent(prompt);
        const text = result.response.text().trim();

        if (text.includes("INVALID")) return { type: 'INVALID' };
        if (text.includes("ID_")) {
            const matchId = text.match(/ID_(\d+)/)[1];
            const parent = existingProducts.find(p => p.id == matchId);
            return { type: 'MATCH', product: parent };
        }
        
        return { type: 'NEW' };

    } catch (err) {
        console.error("   ⚠️ AI Analysis failed, skipping item:", err.message);
        return { type: 'INVALID' }; // Fail safe: Don't import if we can't check
    }
}

export async function scrapeAndSaveProducts(supabase, clientId, websiteUrl) {
    console.log(`🕷️ Smart Scraper: Scanning ${websiteUrl}`);
    let newCount = 0;
    let mergedCount = 0;
    let skippedCount = 0;

    try {
        // 1. Get Existing Products
        const { data: existingProducts } = await supabase
            .from('product_gallery')
            .select('id, name, gallery_images')
            .eq('client_id', clientId);

        // 2. Fetch HTML
        const { data: html } = await axios.get(websiteUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        const $ = cheerio.load(html);

        // 3. Extract Candidates
        const candidates = [];
        
        // Improved Selector: Try to find images specifically inside product cards first
        let images = $('.product-card img, .product-item img, .grid-view-item img, .woocommerce-loop-product__link img');
        if (images.length === 0) images = $('img'); // Fallback to all images if no containers found

        images.each((i, el) => {
            const src = $(el).attr('src') || $(el).attr('data-src'); // Check data-src for lazy loading
            const alt = $(el).attr('alt');
            
            if (src && !src.endsWith('.svg') && !src.includes('logo') && !src.includes('icon')) {
                const fullUrl = src.startsWith('http') ? src : new URL(src, websiteUrl).href;
                const lowerSrc = fullUrl.toLowerCase();

                // --- HEURISTIC FILTERING (The First Gate) ---
                // Immediately reject images that say 'swatch', 'chip', 'texture', or 'thumb'
                if (lowerSrc.includes('swatch') || lowerSrc.includes('color') || lowerSrc.includes('texture') || lowerSrc.includes('thumb')) {
                    return; 
                }

                // Try to find a meaningful name
                let name = alt;
                if (!name || name.length < 3) {
                    name = $(el).closest('div').find('h2, h3, h4, .product-title, .name, .woocommerce-loop-product__title').first().text().trim();
                }

                // If name looks like a color (e.g. "White", "Beige"), assume it's a swatch and skip
                const badNames = ['white', 'black', 'grey', 'beige', 'pink', 'blue', 'green', 'red', 'sample', 'swatch'];
                if (name && badNames.includes(name.toLowerCase())) return;

                if (name && name.length > 3 && fullUrl) {
                    // Dedup within this run
                    if (!candidates.find(c => c.image_url === fullUrl)) {
                        candidates.push({ name, image_url: fullUrl });
                    }
                }
            }
        });

        console.log(`   🔎 Found ${candidates.length} potential images. AI is filtering...`);

        // 4. Process Each Candidate
        for (const item of candidates) {
            
            // Ask the AI Judge
            const result = await analyzeProductCandidate(existingProducts, item.name, item.image_url);

            if (result.type === 'INVALID') {
                skippedCount++;
                console.log(`      🚫 Skipped Swatch/Junk: "${item.name}"`);
            } 
            else if (result.type === 'MATCH') {
                // === MERGE INTO EXISTING ===
                const parent = result.product;
                const currentGallery = parent.gallery_images || [];

                if (!currentGallery.includes(item.image_url)) {
                    const newGallery = [...currentGallery, item.image_url];
                    
                    await supabase
                        .from('product_gallery')
                        .update({ 
                            gallery_images: newGallery,
                            var_restrictions: null // Trigger re-scan
                        })
                        .eq('id', parent.id);

                    console.log(`      🔗 Merged variation into "${parent.name}"`);
                    mergedCount++;
                }
            } 
            else if (result.type === 'NEW') {
                // === CREATE NEW ===
                // Double check DB specifically for this URL to prevent duplicates from previous runs
                const { data: duplicate } = await supabase
                    .from('product_gallery')
                    .select('id')
                    .eq('client_id', clientId)
                    .eq('image_url', item.image_url)
                    .maybeSingle();

                if (!duplicate) {
                    await supabase.from('product_gallery').insert({
                        client_id: clientId,
                        name: item.name.substring(0, 50),
                        image_url: item.image_url,
                        description: "Imported from website",
                        gallery_images: [], 
                        ai_description: null, 
                        var_restrictions: null 
                    });
                    console.log(`      ✨ Created New: "${item.name}"`);
                    newCount++;
                }
            }
        }

        console.log(`✅ Scraper Done. New: ${newCount} | Merged: ${mergedCount} | Rejected Swatches: ${skippedCount}`);
        return { success: true, count: newCount + mergedCount };

    } catch (err) {
        console.error("❌ Scraper Error:", err.message);
        return { success: false, error: err.message };
    }
}