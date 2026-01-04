import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
dotenv.config();

const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: 465,
    secure: true, 
    auth: {
        user: process.env.SMTP_USER, 
        pass: process.env.SMTP_PASS 
    }
});

export async function sendLeadNotification(toEmails, leadData) {
    let recipientList = [];

    // HANDLE COMMA SEPARATED STRING OR ARRAY
    if (Array.isArray(toEmails)) {
        recipientList = toEmails;
    } else if (typeof toEmails === 'string') {
        // Split "a@b.com, c@d.com" -> ["a@b.com", "c@d.com"]
        // Also removes any accidental empty spaces
        recipientList = toEmails.split(',').map(e => e.trim()).filter(e => e.length > 0);
    }

    if (recipientList.length === 0) return;

    console.log(`📧 Sending Notification to: ${recipientList.join(', ')}`);

    const htmlBody = `
    <div style="font-family: Arial, sans-serif; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px; max-width: 600px;">
        <h2 style="color: #2d3436;">🔔 New Lead Captured!</h2>
        <div style="background: #f9f9f9; padding: 15px; border-radius: 8px; margin: 20px 0;">
            <p><strong>Name:</strong> ${leadData.customer_name || 'N/A'}</p>
            <p><strong>Phone:</strong> <a href="tel:${leadData.customer_phone}">${leadData.customer_phone || 'N/A'}</a></p>
            <p><strong>Email:</strong> <a href="mailto:${leadData.customer_email}">${leadData.customer_email || 'N/A'}</a></p>
            <p><strong>Summary:</strong> ${leadData.ai_summary || leadData.project_summary || 'N/A'}</p>
        </div>
        <p style="font-size: 12px; color: #888;">Full details attached.</p>
    </div>
    `;

    const textContent = `
    NEW LEAD DETAILS
    ================
    Name: ${leadData.customer_name}
    Phone: ${leadData.customer_phone}
    Email: ${leadData.customer_email}
    Project: ${leadData.project_summary}
    AI Analysis: ${leadData.ai_summary}
    `;

    try {
        await transporter.sendMail({
            from: `"Blind Bot AI" <${process.env.SMTP_USER}>`,
            to: recipientList, 
            subject: `🎯 New Lead: ${leadData.customer_name || 'Visitor'}`,
            html: htmlBody,
            attachments: [{ filename: 'Lead_Details.txt', content: textContent }]
        });
        console.log("   ✅ Email sent successfully.");
    } catch (err) {
        console.error("   ❌ Email failed:", err.message);
    }
}