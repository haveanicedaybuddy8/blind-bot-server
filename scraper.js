import axios from 'axios';
import * as cheerio from 'cheerio';

// The pages we want to learn from
const urls = [
    'https://thewindowvalet.com/',
    'https://thewindowvalet.com/products/roller-shades/', 
    'https://thewindowvalet.com/products/shutters/',
    'https://thewindowvalet.com/products/motorization/',
    'https://thewindowvalet.com/about-us/'
];

async function scrapeSite() {
    console.log("🕷️  Starting the harvest... this might take a minute.\n");
    let fullKnowledgeBase = "";

    for (const url of urls) {
        try {
            console.log(`Scanning: ${url}`);
            
            // 1. Fetch the HTML
            const { data } = await axios.get(url, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } 
            });

            // 2. Load into Cheerio (The Surgeon)
            const $ = cheerio.load(data);

            // 3. Remove junk (Menus, Footers, Scripts)
            $('script').remove();
            $('style').remove();
            $('nav').remove();
            $('footer').remove();
            $('.header').remove(); // Tries to remove top menu

            // 4. Extract text from Headers, Paragraphs, and List Items
            let pageText = "";
            $('h1, h2, h3, p, li').each((i, element) => {
                const text = $(element).text().replace(/\s+/g, ' ').trim(); // Clean extra spaces
                if (text.length > 20) { // Ignore tiny snippets like "Menu"
                    pageText += `- ${text}\n`;
                }
            });

            // 5. Add to our master brain
            fullKnowledgeBase += `\n--- SOURCE: ${url} ---\n${pageText}`;

        } catch (error) {
            console.log(`❌ Failed to read ${url}: ${error.message}`);
            // If specific product pages fail (404), it might be because the URL structure is different. 
            // The main home page usually captures the most info.
        }
    }

    console.log("\n✅ HARVEST COMPLETE!");
    console.log("---------------------------------------------------");
    console.log("COPY EVERYTHING BELOW THIS LINE INTO YOUR server.js");
    console.log("---------------------------------------------------");
    console.log("const websiteData = `");
    console.log(fullKnowledgeBase);
    console.log("`;");
}

scrapeSite();