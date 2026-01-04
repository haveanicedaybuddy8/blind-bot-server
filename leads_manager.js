import { sendLeadNotification } from './email_handler.js';

export async function handleLeadData(supabase, clientId, leadData) {
    if (!leadData.name && !leadData.phone && !leadData.email) return;

    console.log(`💾 Processing Lead for Client ${clientId}...`);

    try {
        let existingLead = null;

        // 1. FIND EXISTING LEAD
        if (leadData.phone) {
             const { data } = await supabase.from('leads').select('*').eq('client_id', clientId).eq('customer_phone', leadData.phone).maybeSingle();
             if (data) existingLead = data;
        }
        if (!existingLead && leadData.email) {
             const { data } = await supabase.from('leads').select('*').eq('client_id', clientId).eq('customer_email', leadData.email).maybeSingle();
             if (data) existingLead = data;
        }

        // 2. PREPARE DATA
        let finalCustomerImages = existingLead ? (existingLead.customer_images || []) : [];
        let finalAiRenderings = existingLead ? (existingLead.ai_renderings || []) : [];

        if (leadData.new_customer_image && !finalCustomerImages.includes(leadData.new_customer_image)) {
            finalCustomerImages.push(leadData.new_customer_image);
        }
        if (leadData.new_ai_rendering && !finalAiRenderings.includes(leadData.new_ai_rendering)) {
            finalAiRenderings.push(leadData.new_ai_rendering);
        }

        const dbPayload = {
            client_id: clientId,
            customer_name: leadData.name || (existingLead ? existingLead.customer_name : null),
            customer_phone: leadData.phone || (existingLead ? existingLead.customer_phone : null),
            customer_email: leadData.email || (existingLead ? existingLead.customer_email : null),
            customer_address: leadData.address || (existingLead ? existingLead.customer_address : null),
            project_summary: leadData.project_summary || (existingLead ? existingLead.project_summary : null),
            appointment_request: leadData.appointment_request || (existingLead ? existingLead.appointment_request : null),
            preferred_method: leadData.preferred_method || "phone", 
            quality_score: leadData.quality_score || 5,
            ai_summary: leadData.ai_summary || null,
            customer_images: finalCustomerImages,
            ai_renderings: finalAiRenderings
        };

        // 3. SAVE TO DB
        if (existingLead) {
            await supabase.from('leads').update(dbPayload).eq('id', existingLead.id);
            console.log(`   ✅ Updated lead: ${dbPayload.customer_name}`);
        } else {
            await supabase.from('leads').insert([dbPayload]);
            console.log(`   ✨ Created new lead: ${dbPayload.customer_name}`);
        }

        // ============================================================
        // 4. SEND EMAIL NOTIFICATION (With Robust Fallback)
        // ============================================================
        if (dbPayload.customer_phone || dbPayload.customer_email) {
            
            const { data: client } = await supabase
                .from('clients')
                .select('notification_emails, email')
                .eq('id', clientId)
                .single();

            if (client) {
                let targetInput = client.notification_emails;
                
                // --- SAFETY CHECK START ---
                // Determine if the field is "empty" regardless of format (String or Array)
                let isEmpty = false;
                if (!targetInput) isEmpty = true; // Null or undefined
                else if (typeof targetInput === 'string' && targetInput.trim() === '') isEmpty = true; // Empty string
                else if (Array.isArray(targetInput) && targetInput.length === 0) isEmpty = true; // Empty array

                // If empty, use the main email as fallback
                if (isEmpty) {
                    targetInput = client.email;
                    console.log(`   ℹ️ No notification list found. Fallback to main email: ${client.email}`);
                }
                // --- SAFETY CHECK END ---

                if (targetInput) {
                    // Send notification (email_handler handles both string and array inputs)
                    sendLeadNotification(targetInput, dbPayload);
                }
            }
        }

    } catch (e) {
        console.error("Lead Manager System Error:", e);
    }
}