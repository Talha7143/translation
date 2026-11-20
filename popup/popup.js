// Popup Controller for Smart Page Explainer

document.addEventListener('DOMContentLoaded', async () => {
  const tabTitleEl = document.getElementById('tab-title');
  const analyzeBtn = document.getElementById('analyze-now-btn');
  const toggleSidebarBtn = document.getElementById('toggle-sidebar-btn');
  const languageSelect = document.getElementById('language-select');
  const openOptionsBtn = document.getElementById('open-options-btn');
  const apiStatusEl = document.getElementById('api-status');

  // 1. Populate Languages Dropdown
  if (typeof SUPPORTED_LANGUAGES !== 'undefined') {
    SUPPORTED_LANGUAGES.forEach(lang => {
      const opt = document.createElement('option');
      opt.value = lang.code;
      opt.textContent = `${lang.native} (${lang.name})`;
      languageSelect.appendChild(opt);
    });
  }

  // 2. Load stored settings
  chrome.storage.sync.get(['selectedLanguage', 'apiKey'], (res) => {
    if (res.selectedLanguage) {
      languageSelect.value = res.selectedLanguage;
    }
    if (res.apiKey && res.apiKey.trim().length > 5) {
      apiStatusEl.textContent = '⚡ Gemini AI Active';
      apiStatusEl.style.background = '#e0e7ff';
      apiStatusEl.style.color = '#4338ca';
      apiStatusEl.style.borderColor = '#c7d2fe';
    } else {
      apiStatusEl.textContent = '✨ Smart Extractive Active';
    }
  });

  // 3. Get Active Tab Information
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    tabTitleEl.textContent = tab.title || tab.url || 'Web Page';

    const isRestricted = !tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('edge://');
    if (isRestricted) {
      tabTitleEl.textContent = 'Chrome system page (cannot run on this tab)';
      analyzeBtn.disabled = true;
      analyzeBtn.style.opacity = '0.6';
      analyzeBtn.style.cursor = 'not-allowed';
      toggleSidebarBtn.disabled = true;
      toggleSidebarBtn.style.opacity = '0.6';
    }
  }

  // 4. Change Language Listener
  languageSelect.addEventListener('change', (e) => {
    const newLang = e.target.value;
    chrome.storage.sync.set({ selectedLanguage: newLang });

    // Inform active tab content script
    if (tab && tab.id) {
      chrome.tabs.sendMessage(tab.id, { action: 'UPDATE_LANGUAGE', language: newLang }).catch(() => {});
    }
  });

  // 5. Trigger Analysis & In-page Highlight
  analyzeBtn.addEventListener('click', async () => {
    if (!tab || !tab.id) return;

    try {
      await chrome.tabs.sendMessage(tab.id, { action: 'ANALYZE_PAGE' });
      window.close(); // Close popup so user sees the in-page highlighting and sidebar
    } catch (e) {
      // If content script was not ready, inject or alert
      alert('Please refresh the web page once to activate Smart Page Explainer on this tab.');
    }
  });

  // 6. Toggle Sidebar
  toggleSidebarBtn.addEventListener('click', async () => {
    if (!tab || !tab.id) return;
    try {
      await chrome.tabs.sendMessage(tab.id, { action: 'TOGGLE_SIDEBAR' });
      window.close();
    } catch (e) {
      alert('Please refresh the web page once to activate Smart Page Explainer on this tab.');
    }
  });

  // 7. Settings button
  openOptionsBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
});
