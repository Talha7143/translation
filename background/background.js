// Background Service Worker for Smart Page Explainer

chrome.runtime.onInstalled.addListener(() => {
  // Initialize default settings if not already set
  chrome.storage.sync.get(['selectedLanguage', 'apiKey', 'aiModel', 'highlightColor'], (res) => {
    chrome.storage.sync.set({
      selectedLanguage: res.selectedLanguage || 'en-plain',
      apiKey: res.apiKey || '',
      aiModel: res.aiModel || 'gemini-1.5-flash',
      highlightColor: res.highlightColor || '#fef08a'
    });
  });

  // Setup context menu items
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'spe-explain-page',
      title: '💡 Analyze & Highlight Key Points',
      contexts: ['page']
    });

    chrome.contextMenus.create({
      id: 'spe-explain-selection',
      title: '✨ Explain Selection in Plain English / Native Language',
      contexts: ['selection']
    });
  });
});

// Context menu click listener
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || !tab.id) return;

  if (info.menuItemId === 'spe-explain-page') {
    chrome.tabs.sendMessage(tab.id, { action: 'ANALYZE_PAGE' });
  } else if (info.menuItemId === 'spe-explain-selection') {
    chrome.tabs.sendMessage(tab.id, {
      action: 'EXPLAIN_SELECTION',
      text: info.selectionText
    });
  }
});

// Listener for background API calls (e.g. Gemini API proxy or Translation fallback)
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'CALL_GEMINI_API') {
    handleGeminiCall(request.payload)
      .then(data => sendResponse({ success: true, data }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // Keep channel open for async response
  }

  if (request.action === 'CALL_TRANSLATION_FALLBACK') {
    handleTranslationFallback(request.text, request.targetLang)
      .then(translatedText => sendResponse({ success: true, text: translatedText }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

// Gemini API Handler
async function handleGeminiCall({ apiKey, prompt, model = 'gemini-1.5-flash' }) {
  if (!apiKey) {
    throw new Error('API_KEY_MISSING');
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          parts: [{ text: prompt }]
        }
      ],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 2048,
        responseMimeType: "application/json"
      }
    })
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error?.message || `API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) throw new Error('No response returned by AI model.');

  try {
    return JSON.parse(rawText);
  } catch (e) {
    // If model didn't return clean JSON, return plain text
    return { raw: rawText };
  }
}

// Fallback Translation Handler (Using free public Google Translate API endpoint)
async function handleTranslationFallback(text, targetLang) {
  if (!text || !text.trim()) return '';
  const lang = targetLang === 'en-plain' ? 'en' : targetLang;
  
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(lang)}&dt=t&q=${encodeURIComponent(text)}`;
  
  const res = await fetch(url);
  if (!res.ok) throw new Error('Translation fallback request failed');
  const data = await res.json();
  
  // Parse response: data[0] is array of [translatedChunk, originalChunk, ...]
  if (Array.isArray(data) && Array.isArray(data[0])) {
    return data[0].map(item => item[0]).join('');
  }
  return text;
}
