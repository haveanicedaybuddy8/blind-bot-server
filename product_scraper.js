// product_scraper.js
import axios from 'axios';
import * as cheerio from 'cheerio';

export async function scrapeAndSaveProducts(supabase, clientId, websiteUrl) {
    console.log(`🕷️ Scraping products from: ${websiteUrl}`);
    let count = 0;

    try {
        // 1. Fetch HTML
        const { data } = await axios.get(websiteUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        const $ = cheerio.load(data);

        // 2. Heuristic: Find Images that look like products
        // We look for <img> tags inside common product containers or just generic large images
        const productCandidates = [];

        $('img').each((i, el) => {
            const src = $(el).attr('src');
            const alt = $(el).attr('alt');
            
            // FILTER: Skip logos, tiny icons, and svgs
            if (src && !src.endsWith('.svg') && !src.includes('logo') && !src.includes('icon')) {
                // Resolve relative URLs
                const fullUrl = src.startsWith('http') ? src : new URL(src, websiteUrl).href;
                
                // If it has an ALT tag, use it as the name. 
                // If not, try to find a nearby Header (h2, h3, h4)
                let name = alt;
                if (!name || name.length < 3) {
                    name = $(el).closest('div').find('h2, h3, h4, .product-title').first().text().trim();
                }

                // Only add if we have a decent name and unique URL
                if (name && name.length > 3 && fullUrl) {
                    productCandidates.push({ name, image_url: fullUrl });
                }
            }
        });

        // 3. Insert into Supabase (Batch)
        // Note: We leave 'ai_description' NULL so your 'product_worker.js' picks it up automatically!
        for (const prod of productCandidates) {
            // Check for duplicates to avoid spamming
            const { data: existing } = await supabase
                .from('product_gallery')
                .select('id')
                .eq('client_id', clientId)
                .eq('image_url', prod.image_url)
                .maybeSingle();

            if (!existing) {
                await supabase.from('product_gallery').insert({
                    client_id: clientId,
                    name: prod.name.substring(0, 50), // Cap length
                    image_url: prod.image_url,
                    description: "Imported from website", // Temporary placeholder
                    ai_description: null // <--- This triggers the AI Worker!
                });
                count++;
            }
        }

        console.log(`✅ Scraper finished. Imported ${count} new products.`);
        return { success: true, count };

    } catch (err) {
        console.error("❌ Scraper Error:", err.message);
        return { success: false, error: err.message };
    }
}