document.addEventListener('DOMContentLoaded', () => {
  const apiKeyInput = document.getElementById('api-key-input');
  const toggleVisibilityBtn = document.getElementById('toggle-key-visibility');
  const aiModelSelect = document.getElementById('ai-model-select');
  const defaultLangSelect = document.getElementById('default-lang-select');
  const maxPointsSelect = document.getElementById('max-points-select');
  const highlightColorSelect = document.getElementById('highlight-color-select');
  const previewHighlight = document.getElementById('preview-highlight');
  const testKeyBtn = document.getElementById('test-key-btn');
  const testStatus = document.getElementById('test-status');
  const saveBtn = document.getElementById('save-btn');
  const saveFeedback = document.getElementById('save-feedback');

  if (typeof SUPPORTED_LANGUAGES !== 'undefined') {
    SUPPORTED_LANGUAGES.forEach(lang => {
      const opt = document.createElement('option');
      opt.value = lang.code;
      opt.textContent = `${lang.native} (${lang.name})`;
      defaultLangSelect.appendChild(opt);
    });
  }

  chrome.storage.sync.get(
    ['apiKey', 'aiModel', 'selectedLanguage', 'maxPoints', 'highlightColor'],
    (items) => {
      if (items.apiKey) apiKeyInput.value = items.apiKey;
      if (items.aiModel) aiModelSelect.value = items.aiModel;
      if (items.selectedLanguage) defaultLangSelect.value = items.selectedLanguage;
      if (items.maxPoints) maxPointsSelect.value = items.maxPoints;
      if (items.highlightColor) {
        highlightColorSelect.value = items.highlightColor;
        updatePreviewColor(items.highlightColor);
      }
    }
  );

  toggleVisibilityBtn.addEventListener('click', () => {
    if (apiKeyInput.type === 'password') {
      apiKeyInput.type = 'text';
      toggleVisibilityBtn.textContent = '🔒';
    } else {
      apiKeyInput.type = 'password';
      toggleVisibilityBtn.textContent = '👁️';
    }
  });

  highlightColorSelect.addEventListener('change', (e) => {
    updatePreviewColor(e.target.value);
  });

  function updatePreviewColor(color) {
    if (previewHighlight) {
      previewHighlight.style.background = color;
    }
  }

  testKeyBtn.addEventListener('click', async () => {
    const key = apiKeyInput.value.trim();
    if (!key) {
      testStatus.textContent = '❌ Please enter an API key first.';
      testStatus.style.color = '#dc2626';
      return;
    }

    testStatus.textContent = '⏳ Testing connection to Gemini API...';
    testStatus.style.color = '#4338ca';

    try {
      chrome.runtime.sendMessage(
        {
          action: 'CALL_GEMINI_API',
          payload: {
            apiKey: key,
            model: aiModelSelect.value,
            prompt: 'Respond with valid JSON: {"status": "ok", "message": "Connection successful"}'
          }
        },
        (res) => {
          if (res && res.success) {
            testStatus.textContent = '✅ Success! Gemini API connected properly.';
            testStatus.style.color = '#16a34a';
          } else {
            testStatus.textContent = `❌ Test failed: ${res?.error || 'Invalid API Key'}`;
            testStatus.style.color = '#dc2626';
          }
        }
      );
    } catch (err) {
      testStatus.textContent = `❌ Error: ${err.message}`;
      testStatus.style.color = '#dc2626';
    }
  });

  saveBtn.addEventListener('click', () => {
    const settings = {
      apiKey: apiKeyInput.value.trim(),
      aiModel: aiModelSelect.value,
      selectedLanguage: defaultLangSelect.value,
      maxPoints: maxPointsSelect.value,
      highlightColor: highlightColorSelect.value
    };

    chrome.storage.sync.set(settings, () => {
      saveFeedback.textContent = '✅ Settings saved successfully!';
      setTimeout(() => {
        saveFeedback.textContent = '';
      }, 3000);
    });
  });
});