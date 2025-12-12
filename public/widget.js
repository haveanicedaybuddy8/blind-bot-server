(function() {
    // 1. Get the config from the script tag
    const scriptTag = document.currentScript || document.querySelector('script[data-api-key]');
    const apiKey = scriptTag.getAttribute('data-api-key');
    const primaryColor = scriptTag.getAttribute('data-color') || "#000";

    if (!apiKey) return console.error("BlindBot: No API Key found.");

    // 2. Create the HTML Elements
    const container = document.createElement('div');
    container.id = 'blind-bot-container';
    container.style.position = 'fixed';
    container.style.bottom = '20px';
    container.style.right = '20px';
    container.style.zIndex = '999999';
    container.style.fontFamily = 'sans-serif';

    // The Chat Window (Hidden by default)
    const iframeBox = document.createElement('div');
    iframeBox.style.width = '350px';
    iframeBox.style.height = '600px';
    iframeBox.style.marginBottom = '15px';
    iframeBox.style.borderRadius = '12px';
    iframeBox.style.boxShadow = '0 5px 25px rgba(0,0,0,0.15)';
    iframeBox.style.overflow = 'hidden';
    iframeBox.style.display = 'none'; // Hidden initially
    iframeBox.style.transition = 'all 0.3s ease';
    iframeBox.style.opacity = '0';
    iframeBox.style.transform = 'translateY(20px)';
    
    // Load your Chatbot HTML
    const iframe = document.createElement('iframe');
    iframe.src = `https://blind-bot-server.onrender.com/index.html?apiKey=${apiKey}`;
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    iframe.style.border = 'none';
    
    // The Floating Bubble Button
    const bubble = document.createElement('div');
    bubble.style.width = '60px';
    bubble.style.height = '60px';
    bubble.style.borderRadius = '50%';
    bubble.style.backgroundColor = primaryColor;
    bubble.style.boxShadow = '0 4px 12px rgba(0,0,0,0.2)';
    bubble.style.cursor = 'pointer';
    bubble.style.display = 'flex';
    bubble.style.alignItems = 'center';
    bubble.style.justifyContent = 'center';
    bubble.style.transition = 'transform 0.2s';

    // Icon inside the bubble (Chat Icon)
    const icon = document.createElement('img');
    icon.src = 'https://img.icons8.com/ios-filled/50/ffffff/chat-message.png';
    icon.style.width = '30px';
    icon.style.height = '30px';
    
    // Close Icon (Hidden initially)
    const closeIcon = document.createElement('span');
    closeIcon.innerHTML = '&times;';
    closeIcon.style.color = 'white';
    closeIcon.style.fontSize = '40px';
    closeIcon.style.lineHeight = '60px';
    closeIcon.style.display = 'none';

    // 3. Assemble
    iframeBox.appendChild(iframe);
    bubble.appendChild(icon);
    bubble.appendChild(closeIcon);
    container.appendChild(iframeBox);
    container.appendChild(bubble);
    document.body.appendChild(container);

    // 4. Logic: Hover to Open, Click to Close
    let isOpen = false;

    function openChat() {
        if (isOpen) return;
        isOpen = true;
        iframeBox.style.display = 'block';
        // Small delay to allow CSS transition to capture the display change
        setTimeout(() => {
            iframeBox.style.opacity = '1';
            iframeBox.style.transform = 'translateY(0)';
        }, 10);
        
        // Switch icons
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

        // Switch icons
        icon.style.display = 'block';
        closeIcon.style.display = 'none';
    }

    // THE REQUEST: "Hover to expand, remain expanded until closed"
    bubble.addEventListener('mouseenter', openChat);
    
    // Also allow clicking the bubble to toggle (in case they are on mobile)
    bubble.addEventListener('click', () => {
        if (isOpen) closeChat();
        else openChat();
    });

})();