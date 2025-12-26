(function() {
    const scriptTag = document.currentScript || document.querySelector('script[data-api-key]');
    const apiKey = scriptTag.getAttribute('data-api-key');
    const SERVER_URL = "https://blind-bot-server.onrender.com"; 

    if (!apiKey) return console.error("BlindBot: No API Key found.");

    // Fetch Client Config from Server
    fetch(`${SERVER_URL}/client-config/${apiKey}`)
        .then(response => response.json())
        .then(config => {
            initBot(config);
        })
        .catch(err => {
            console.error("BlindBot: Could not load config", err);
            // Fallback if server fails
            initBot({ color: "#333", logo: "" });
        });

    function initBot(config) {
        // 1. Create Container
        const container = document.createElement('div');
        container.id = 'blind-bot-container';
        container.style.position = 'fixed';
        container.style.bottom = '20px';
        container.style.right = '20px';
        container.style.zIndex = '999999';
        container.style.fontFamily = 'sans-serif';

        // 2. Chat Window (Iframe)
        const iframeBox = document.createElement('div');
        iframeBox.style.width = '350px';
        iframeBox.style.height = '600px';
        iframeBox.style.marginBottom = '15px';
        iframeBox.style.borderRadius = '12px';
        iframeBox.style.boxShadow = '0 5px 25px rgba(0,0,0,0.15)';
        iframeBox.style.overflow = 'hidden';
        iframeBox.style.display = 'none';
        iframeBox.style.opacity = '0';
        iframeBox.style.transform = 'translateY(20px)';
        iframeBox.style.transition = 'all 0.3s ease';
        
        // Pass color and logo to the internal HTML via URL parameters
        const themeParam = encodeURIComponent(config.color);
        const logoParam = encodeURIComponent(config.logo);
        // 1. Add Name Parameter
        const nameParam = encodeURIComponent(config.name || "us"); 
        const iframe = document.createElement('iframe');
        // 2. Pass it in the URL
        iframe.src = `${SERVER_URL}/chat.html?apiKey=${apiKey}&theme=${themeParam}&logo=${logoParam}&name=${nameParam}`;
        iframe.style.width = '100%';
        iframe.style.height = '100%';
        iframe.style.border = 'none';
        iframe.allow = "camera; microphone; fullscreen; clipboard-read; clipboard-write";

        // 3. Floating Bubble
        const bubble = document.createElement('div');
        bubble.style.width = '60px';
        bubble.style.height = '60px';
        bubble.style.borderRadius = '50%';
        bubble.style.backgroundColor = config.color; // <--- DYNAMIC COLOR
        bubble.style.boxShadow = '0 4px 12px rgba(0,0,0,0.2)';
        bubble.style.cursor = 'pointer';
        bubble.style.display = 'flex';
        bubble.style.alignItems = 'center';
        bubble.style.justifyContent = 'center';
        bubble.style.transition = 'transform 0.2s';

        // Chat Icon
        const icon = document.createElement('img');
        icon.src = 'https://img.icons8.com/ios-filled/50/ffffff/chat-message.png';
        icon.style.width = '30px';
        icon.style.height = '30px';
        
        // Close Icon
        const closeIcon = document.createElement('span');
        closeIcon.innerHTML = '&times;';
        closeIcon.style.color = 'white';
        closeIcon.style.fontSize = '40px';
        closeIcon.style.lineHeight = '60px';
        closeIcon.style.display = 'none';

        // Assemble
        iframeBox.appendChild(iframe);
        bubble.appendChild(icon);
        bubble.appendChild(closeIcon);
        container.appendChild(iframeBox);
        container.appendChild(bubble);
        document.body.appendChild(container);

        // Toggle Logic (HOVER TO OPEN)
        let isOpen = false;

        function openChat() {
            if (isOpen) return;
            isOpen = true;
            iframeBox.style.display = 'block';
            setTimeout(() => {
                iframeBox.style.opacity = '1';
                iframeBox.style.transform = 'translateY(0)';
            }, 10);
            icon.style.display = 'none';
            closeIcon.style.display = 'block';
        }

        function closeChat() {
            if (!isOpen) return;
            isOpen = false;
            iframeBox.style.opacity = '0';
            iframeBox.style.transform = 'translateY(20px)';
            setTimeout(() => {
                iframeBox.style.display = 'none';
            }, 300);
            icon.style.display = 'block';
            closeIcon.style.display = 'none';
        }

        // 1. Open on Hover
        bubble.addEventListener('mouseenter', openChat);

        // 2. Close on Click (the 'X' button)
        bubble.addEventListener('click', closeChat);
    }
})();