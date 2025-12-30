export async function handleLeadData(supabase, clientId, leadData) {
    // 1. Sanity Check: Don't save empty junk
    if (!leadData.name && !leadData.phone && !leadData.email) return;

    console.log(`💾 Processing Lead for Client ${clientId}...`);

    try {
        let existingLead = null;

        // 2. FIND EXISTING LEAD (Phone has priority, then Email)
        if (leadData.phone) {
             const { data } = await supabase.from('leads')
                .select('id, customer_images, ai_renderings')
                .eq('client_id', clientId)
                .eq('customer_phone', leadData.phone)
                .maybeSingle();
             if (data) existingLead = data;
        }

        if (!existingLead && leadData.email) {
             const { data } = await supabase.from('leads')
                .select('id, customer_images, ai_renderings')
                .eq('client_id', clientId)
                .eq('customer_email', leadData.email)
                .maybeSingle();
             if (data) existingLead = data;
        }

        // 3. PREPARE IMAGE ARRAYS (Merge new with existing)
        let finalCustomerImages = existingLead ? (existingLead.customer_images || []) : [];
        let finalAiRenderings = existingLead ? (existingLead.ai_renderings || []) : [];

        if (leadData.new_customer_image && !finalCustomerImages.includes(leadData.new_customer_image)) {
            finalCustomerImages.push(leadData.new_customer_image);
        }
        if (leadData.new_ai_rendering && !finalAiRenderings.includes(leadData.new_ai_rendering)) {
            finalAiRenderings.push(leadData.new_ai_rendering);
        }

        // 4. MAP DB PAYLOAD
        const dbPayload = {
            client_id: clientId,
            customer_name: leadData.name || null,
            customer_phone: leadData.phone || null,
            customer_email: leadData.email || null,
            customer_address: leadData.address || null,
            project_summary: leadData.project_summary || null,
            appointment_request: leadData.appointment_request || null,
            preferred_method: leadData.preferred_method || "phone", 
            quality_score: leadData.quality_score || 5,
            ai_summary: leadData.ai_summary || null,
            customer_images: finalCustomerImages,
            ai_renderings: finalAiRenderings
        };

        // 5. PERFORM UPSERT
        if (existingLead) {
            const { error } = await supabase.from('leads').update(dbPayload).eq('id', existingLead.id);
            if (error) console.error("❌ Lead Update Error:", error.message);
            else console.log(`   ✅ Updated lead gallery for: ${dbPayload.customer_name}`);
        } else {
            const { error } = await supabase.from('leads').insert([dbPayload]);
            if (error) console.error("❌ Lead Insert Error:", error.message);
            else console.log(`   ✨ Created new lead: ${dbPayload.customer_name}`);
        }

    } catch (e) {
        console.error("Lead Manager System Error:", e);
    }
}