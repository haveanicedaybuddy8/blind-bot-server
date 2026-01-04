<div style="width: 100%; height: 600px; text-align: center">
  <h6><div style="text-align: center; margin: 20px 0;">
    <button id="scraper-btn" style="background-color: #2d3436; color: white; padding: 12px 24px; border: none; border-radius: 6px; cursor: pointer; font-family: sans-serif; font-size: 16px; display: inline-flex; align-items: center; gap: 8px;">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 1-9 9m9-9a9 9 0 0 0-9-9m9 9H3m9 9a9 9 0 0 1-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 0 1 9-9"/></svg>
          Auto-Import Products from Website
      </button>
  </div>
  
  <script>
    document.getElementById('scraper-btn').addEventListener('click', function() {
          const btn = this;
          
          // 1. Check Login
          if (!window.logged_in_user) {
              alert("⚠️ Please log in to use this feature.");
              return;
          }
  
          // 2. Ask User for URL
          const apiKey = window.logged_in_user['api_key'];
          const userUrl = prompt("👇 Paste the exact link (URL) of the page you want to scan:", "https://");
  
          // 3. Send to Server
          if (userUrl && userUrl.length > 8) {
              // Update button text to show it's working
              const originalText = btn.innerHTML;
              btn.innerHTML = "⏳ Scanning... (This takes ~30s)";
              btn.style.opacity = "0.7";
              btn.disabled = true;
  
              fetch('https://blind-bot-server.onrender.com/scrape-products', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ 
                      clientApiKey: apiKey,
                      websiteUrl: userUrl 
                  })
              })
              .then(response => response.json())
              .then(data => {
                  if (data.success) {
                      alert(`✅ Success! We found ${data.count} new products.\n\nThe AI is writing descriptions for them now. Refresh your page in a minute to see them.`);
                      location.reload(); // Refresh to show new items
                  } else {
                      alert("❌ Error: " + (data.error || "Could not read website"));
                  }
              })
              .catch(err => {
                  alert("❌ Connection Error. Is your server running?");
              })
              .finally(() => {
                  // Reset button
                  btn.innerHTML = originalText;
                  btn.style.opacity = "1";
                  btn.disabled = false;
              });
          }
      });
  </script></h6>
</div>