import { createClient } from '@supabase/supabase-js';

// Helper: Append new URL to existing gallery list
function appendToGallery(existingData, newUrl) {
    if (!newUrl) return existingData;

    let gallery = [];

    // Handle various existing formats (Array, string, or null)
    if (Array.isArray(existingData)) {
        gallery = [...existingData];
    } else if (typeof existingData === 'string' && existingData.length > 0) {
        // Safe parse if it looks like a JSON string
        if (existingData.startsWith('[')) {
            try { gallery = JSON.parse(existingData); } catch(e) { gallery = [existingData]; }
        } else if (existingData.startsWith('{')) {
             // Handle Postgres array string format '{img1, img2}' just in case
            gallery = existingData.replace(/[{}]/g, '').split(',');
        } else {
            gallery = [existingData];
        }
    }

    // Add new URL if not duplicate
    if (!gallery.includes(newUrl)) {
        gallery.push(newUrl);
    }
    return gallery;
}

function isValidLead(data) {
    return (data.name || data.phone || data.email || data.new_customer_image);
}

export async function handleLeadData(supabase, clientId, leadData) {
    try {
        if (!isValidLead(leadData)) return null;

        console.log(`💾 Saving Lead for Client ${clientId}...`);

        // 1. Find Existing Lead (Deduplicate by Phone or Email)
        // We look for matches to merge data
        let query = supabase.from('leads').select('*').eq('client_id', clientId);
        
        const conditions = [];
        if (leadData.email) conditions.push(`customer_email.eq.${leadData.email}`);
        if (leadData.phone) conditions.push(`customer_phone.eq.${leadData.phone}`);
        
        let existingLead = null;

        if (conditions.length > 0) {
            const { data: existing } = await query.or(conditions.join(','));
            if (existing && existing.length > 0) existingLead = existing[0];
        }

        // 2. Prepare Data (MAPPED EXACTLY TO YOUR CSV HEADERS)
        const finalData = {
            client_id: clientId,
            
            // --- Contact Info ---
            customer_name: leadData.name || (existingLead ? existingLead.customer_name : null),
            customer_phone: leadData.phone || (existingLead ? existingLead.customer_phone : null),
            customer_email: leadData.email || (existingLead ? existingLead.customer_email : null),
            customer_address: leadData.address || (existingLead ? existingLead.customer_address : null),
            
            // --- Project Details ---
            project_summary: leadData.project_summary || (existingLead ? existingLead.project_summary : null),
            appointment_request: leadData.appointment_request || (existingLead ? existingLead.appointment_request : null),
            preferred_method: leadData.preferred_method || (existingLead ? existingLead.preferred_method : null),
            
            // --- AI Analysis ---
            quality_score: leadData.quality_score || (existingLead ? existingLead.quality_score : null),
            ai_summary: leadData.ai_summary || (existingLead ? existingLead.ai_summary : null),
            
            // --- GALLERY (Appending Logic) ---
            customer_images: appendToGallery(
                (existingLead ? existingLead.customer_images : []), 
                leadData.new_customer_image
            ),
            
            ai_rendering_url: appendToGallery(
                (existingLead ? existingLead.ai_rendering_url : []), 
                leadData.new_ai_rendering
            ),
            
            // --- Metadata ---
            last_updated: new Date().toISOString()
        };

        // 3. Save to Supabase
        if (existingLead) {
             finalData.id = existingLead.id;
        }

        const { data, error } = await supabase
            .from('leads')
            .upsert(finalData)
            .select();

        if (error) {
            console.error("❌ Database Error:", error.message);
            throw error;
        }

        console.log("✅ Lead Saved:", data[0].id);
        return data[0];

    } catch (err) {
        console.error("Lead Manager Fault:", err);
        return null;
    }
}