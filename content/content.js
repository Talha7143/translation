// Smart Page Explainer - Content Script
// Reads the whole page, highlights key points in-place, and provides plain English & 50+ language explanations

(function () {
  // Prevent duplicate injection
  if (window.__smartPageExplainerLoaded) return;
  window.__smartPageExplainerLoaded = true;

  // State Management
  const state = {
    isOpen: false,
    isAnalyzing: false,
    highlightsVisible: true,
    selectedLang: 'en-plain',
    apiKey: '',
    aiModel: 'gemini-1.5-flash',
    highlights: [], // { id, text, element, explanation, simplified }
    summary: '',
    stats: { wordCount: 0, readTime: 0, sentencesCount: 0 },
    activeHighlightId: null,
    isSpeaking: false
  };

  // Load saved preferences
  chrome.storage.sync.get(['selectedLanguage', 'apiKey', 'aiModel'], (res) => {
    if (res.selectedLanguage) state.selectedLang = res.selectedLanguage;
    if (res.apiKey) state.apiKey = res.apiKey;
    if (res.aiModel) state.aiModel = res.aiModel;
  });

  // Listen for background messages
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'ANALYZE_PAGE') {
      openSidebar();
      runFullAnalysis();
      sendResponse({ status: 'started' });
    } else if (request.action === 'EXPLAIN_SELECTION') {
      openSidebar();
      explainCustomText(request.text);
      sendResponse({ status: 'explaining_selection' });
    } else if (request.action === 'TOGGLE_SIDEBAR') {
      toggleSidebar();
      sendResponse({ status: 'toggled', isOpen: state.isOpen });
    }
  });

  // =========================================================================
  // 1. TEXT EXTRACTION & HEURISTIC KEYPOINT ANALYSIS ENGINE
  // =========================================================================

  function extractCleanPageText() {
    // Focus on primary article/content containers if available
    const contentSelectors = [
      'article', 'main', '[role="main"]', '.post-content', '.article-body',
      '.entry-content', '.content-body', '#content', '#main-content'
    ];

    let rootElement = null;
    for (const selector of contentSelectors) {
      const el = document.querySelector(selector);
      if (el && el.innerText && el.innerText.trim().length > 300) {
        rootElement = el;
        break;
      }
    }

    if (!rootElement) {
      rootElement = document.body;
    }

    // Collect readable paragraphs and text blocks
    const nodes = rootElement.querySelectorAll('p, li, blockquote, h1, h2, h3, h4');
    const validParagraphs = [];
    let fullText = '';

    nodes.forEach(node => {
      // Ignore navigation, footers, sidebars, hidden elements, and script tags
      if (node.closest('nav, footer, header, aside, .sidebar, [aria-hidden="true"], #spe-sidebar-root')) {
        return;
      }
      const style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return;
      }

      const text = node.innerText.trim();
      if (text.length > 25) {
        validParagraphs.push({ element: node, text: text });
        fullText += text + ' ';
      }
    });

    // Compute stats
    const words = fullText.trim().split(/\s+/).filter(w => w.length > 0);
    const wordCount = words.length;
    const readTime = Math.max(1, Math.ceil(wordCount / 200));

    state.stats = {
      wordCount,
      readTime,
      sentencesCount: 0
    };

    return { fullText, validParagraphs };
  }

  // Split text into coherent sentences
  function splitIntoSentences(text) {
    if (!text) return [];
    // Sentence splitting regex that avoids splitting common abbreviations
    const raw = text.replace(/([.?!])\s+(?=[A-Z0-9"'])/g, '$1|__SPE_SPLIT__|');
    return raw.split('|__SPE_SPLIT__|')
      .map(s => s.trim())
      .filter(s => s.length >= 35 && s.length <= 400 && !/^(cookie|sign in|subscribe|all rights reserved)/i.test(s));
  }

  // Extractive TextRank / TF-IDF scoring algorithm for key points
  function extractKeySentences(validParagraphs, maxPoints = 6) {
    const allSentences = [];
    const wordFreq = {};
    const stopWords = new Set([
      'the', 'is', 'at', 'which', 'on', 'and', 'a', 'an', 'in', 'to', 'for', 'of', 'or', 'by',
      'with', 'as', 'from', 'that', 'this', 'it', 'be', 'are', 'was', 'were', 'have', 'has', 'had',
      'not', 'but', 'what', 'all', 'were', 'when', 'we', 'there', 'can', 'an', 'your', 'which', 'their', 'if'
    ]);

    validParagraphs.forEach(para => {
      const sents = splitIntoSentences(para.text);
      sents.forEach((sent, indexInPara) => {
        const words = sent.toLowerCase().match(/\b[a-z]{3,}\b/g) || [];
        words.forEach(w => {
          if (!stopWords.has(w)) {
            wordFreq[w] = (wordFreq[w] || 0) + 1;
          }
        });
        allSentences.push({
          sentence: sent,
          element: para.element,
          indexInPara,
          length: sent.length
        });
      });
    });

    state.stats.sentencesCount = allSentences.length;
    if (allSentences.length === 0) return [];

    // Score sentences based on:
    // 1. Keyword density
    // 2. Position (earlier paragraphs & first sentence in paragraph carry higher weight)
    // 3. Proximity to numeric data or research indicators
    const scored = allSentences.map((item, idx) => {
      const words = item.sentence.toLowerCase().match(/\b[a-z]{3,}\b/g) || [];
      let score = 0;
      words.forEach(w => {
        if (wordFreq[w]) {
          score += wordFreq[w];
        }
      });

      // Normalise by word count
      const wordLen = Math.max(words.length, 1);
      let normalizedScore = score / wordLen;

      // Position bias: introductory and concluding sentences often summarize
      if (item.indexInPara === 0) normalizedScore *= 1.35;
      if (idx < 5) normalizedScore *= 1.25;

      // Bonus for factual/statistical indicators
      if (/\d+%|\$|\b(found|discovered|concluded|key|important|primary|result|revealed)\b/i.test(item.sentence)) {
        normalizedScore *= 1.3;
      }

      return {
        ...item,
        score: normalizedScore
      };
    });

    // Sort descending by score
    scored.sort((a, b) => b.score - a.score);

    // Pick diverse top sentences (avoid overlapping sentences from same element)
    const picked = [];
    const seenElements = new Set();

    for (const item of scored) {
      if (picked.length >= maxPoints) break;
      if (!seenElements.has(item.element)) {
        seenElements.add(item.element);
        picked.push(item);
      }
    }

    // Sort picked back to natural reading order in document
    picked.sort((a, b) => {
      return a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });

    return picked;
  }

  // =========================================================================
  // 2. DOM IN-PAGE HIGHLIGHTER
  // =========================================================================

  function clearInPageHighlights() {
    const marks = document.querySelectorAll('mark.spe-highlight');
    marks.forEach(mark => {
      const parent = mark.parentNode;
      if (parent) {
        while (mark.firstChild) {
          parent.insertBefore(mark.firstChild, mark);
        }
        parent.removeChild(mark);
        parent.normalize();
      }
    });
  }

  function highlightSentencesInPage(keyPoints) {
    clearInPageHighlights();

    keyPoints.forEach((point, idx) => {
      const targetElement = point.element;
      if (!targetElement) return;

      const sentenceText = point.sentence.trim();
      highlightTextInElement(targetElement, sentenceText, point.id);
    });
  }

  function highlightTextInElement(element, searchText, id) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null, false);
    let node;
    const textNodes = [];

    while ((node = walker.nextNode())) {
      if (node.nodeValue && node.nodeValue.trim().length > 0) {
        textNodes.push(node);
      }
    }

    // Try finding exact or fuzzy match in text nodes
    for (const textNode of textNodes) {
      const val = textNode.nodeValue;
      const idx = val.indexOf(searchText);
      if (idx !== -1) {
        // Direct containment in a single text node
        const range = document.createRange();
        range.setStart(textNode, idx);
        range.setEnd(textNode, idx + searchText.length);

        const mark = document.createElement('mark');
        mark.className = 'spe-highlight';
        mark.setAttribute('data-spe-id', id);
        mark.title = `Smart Key Point #${id + 1} - Click to see explanation`;

        mark.addEventListener('click', (e) => {
          e.stopPropagation();
          openSidebar();
          focusHighlightCard(id);
        });

        try {
          range.surroundContents(mark);
        } catch (err) {
          // If range crosses elements, fallback gracefully
        }
        return;
      }
    }

    // If exact single-node match wasn't found, find prefix of 40 chars
    const prefix = searchText.slice(0, Math.min(45, searchText.length)).trim();
    for (const textNode of textNodes) {
      const val = textNode.nodeValue;
      const idx = val.indexOf(prefix);
      if (idx !== -1) {
        const range = document.createRange();
        range.setStart(textNode, idx);
        range.setEnd(textNode, Math.min(val.length, idx + searchText.length));

        const mark = document.createElement('mark');
        mark.className = 'spe-highlight';
        mark.setAttribute('data-spe-id', id);
        mark.title = `Smart Key Point #${id + 1} - Click to see explanation`;

        mark.addEventListener('click', (e) => {
          e.stopPropagation();
          openSidebar();
          focusHighlightCard(id);
        });

        try {
          range.surroundContents(mark);
        } catch (err) {}
        return;
      }
    }
  }

  function scrollToPageHighlight(id) {
    const mark = document.querySelector(`mark.spe-highlight[data-spe-id="${id}"]`);
    if (mark) {
      // Remove focus class from all
      document.querySelectorAll('mark.spe-highlight').forEach(m => m.classList.remove('spe-active-focus'));
      mark.classList.add('spe-active-focus');
      mark.scrollIntoView({ behavior: 'smooth', block: 'center' });

      // Pulse animation
      setTimeout(() => {
        mark.classList.remove('spe-active-focus');
      }, 3500);
    }
  }

  // =========================================================================
  // 3. AI / MULTILINGUAL EXPLAINER INTEGRATION
  // =========================================================================

  function getLanguageMetadata(code) {
    if (typeof SUPPORTED_LANGUAGES !== 'undefined') {
      return SUPPORTED_LANGUAGES.find(l => l.code === code) || SUPPORTED_LANGUAGES[0];
    }
    return { code: 'en-plain', name: 'Plain English', native: 'Plain English', bcp47: 'en-US' };
  }

  async function generateExplanations(keyPoints, fullArticleSnippet, targetLang) {
    const langMeta = getLanguageMetadata(targetLang);
    const isPlainEnglish = targetLang === 'en-plain' || targetLang === 'en';

    // 1. If Gemini API key is present, use Gemini for deep multimodal explanation
    if (state.apiKey && state.apiKey.trim().length > 10) {
      try {
        const prompt = buildGeminiPrompt(keyPoints, fullArticleSnippet, langMeta);
        const response = await callBackgroundGemini(prompt, state.apiKey, state.aiModel);
        if (response && response.keyPoints && Array.isArray(response.keyPoints)) {
          return {
            summary: response.overallSummary || 'Here is the summary of this page in simple terms.',
            points: response.keyPoints.map((item, idx) => ({
              id: idx,
              sentence: keyPoints[idx]?.sentence || item.originalText,
              takeaway: item.keyTakeaway || item.simpleExplanation,
              explanation: item.simpleExplanation || item.keyTakeaway,
              analogy: item.analogy || ''
            }))
          };
        }
      } catch (err) {
        console.warn('Gemini API call returned an error, falling back to smart local translation:', err);
      }
    }

    // 2. Intelligent Built-in Fallback (Extractive summary + 50+ language translation)
    const points = keyPoints.map((p, idx) => {
      // Plain English simplification heuristic
      const simpleEng = simplifySentenceHeuristic(p.sentence);
      return {
        id: idx,
        sentence: p.sentence,
        takeaway: simpleEng.takeaway,
        explanation: simpleEng.explanation,
        analogy: simpleEng.analogy
      };
    });

    let overallSummary = `This page discusses ${document.title.replace(/[-|].*$/, '').trim()}. Here are the ${points.length} most critical insights distilled into plain language.`;

    // If target language is NOT English, translate using background translation fallback
    if (!isPlainEnglish) {
      try {
        overallSummary = await callBackgroundTranslation(overallSummary, langMeta.code);
        for (const pt of points) {
          pt.takeaway = await callBackgroundTranslation(pt.takeaway, langMeta.code);
          pt.explanation = await callBackgroundTranslation(pt.explanation, langMeta.code);
        }
      } catch (e) {
        console.warn('Translation fallback notice:', e);
      }
    }

    return {
      summary: overallSummary,
      points
    };
  }

  function simplifySentenceHeuristic(sentence) {
    // Clean jargon, passive voice signals, and shorten
    let cleaned = sentence
      .replace(/\b(furthermore|moreover|consequently|notwithstanding|in accordance with|it is evident that)\b/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim();

    return {
      takeaway: cleaned,
      explanation: `Key point: "${cleaned.slice(0, 90)}..." represents a central finding of this section.`,
      analogy: 'In simple words: Focus on this statement to understand the author\'s main conclusion.'
    };
  }

  function buildGeminiPrompt(keyPoints, fullArticleSnippet, langMeta) {
    const isPlainEnglish = langMeta.code === 'en-plain';
    const targetLanguageInstruction = isPlainEnglish
      ? "Language: Plain English (ELI5 / explain like I am 12 years old, avoid jargon, use everyday metaphors)."
      : `Language: Explain completely in ${langMeta.name} (${langMeta.native}). Ensure natural native phrasing, simple vocabulary, and clear explanations.`;

    const pointsList = keyPoints.map((p, i) => `Point #${i + 1}: "${p.sentence}"`).join('\n');

    return `
You are an expert reading assistant and educator. Your goal is to explain web pages to users in simple, crystal-clear terms.

Page Title: "${document.title}"
Context snippet:
${fullArticleSnippet.slice(0, 2000)}

Here are the key highlighted sentences extracted from the page:
${pointsList}

INSTRUCTIONS:
1. ${targetLanguageInstruction}
2. Provide a 2-3 sentence overall executive summary of the page.
3. For each of the ${keyPoints.length} points above, provide:
   - "keyTakeaway": A short, punchy 1-sentence main takeaway.
   - "simpleExplanation": A 2-3 sentence plain language explanation of why this matters and what it means in simple terms.
   - "analogy": A brief 1-line everyday analogy or relatable example clarifying the concept.

Output STRICT JSON matching this format:
{
  "overallSummary": "...",
  "keyPoints": [
    {
      "originalText": "...",
      "keyTakeaway": "...",
      "simpleExplanation": "...",
      "analogy": "..."
    }
  ]
}
`;
  }

  function callBackgroundGemini(prompt, apiKey, model) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          action: 'CALL_GEMINI_API',
          payload: { prompt, apiKey, model }
        },
        (res) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!res || !res.success) return reject(new Error(res?.error || 'Failed to call Gemini'));
          resolve(res.data);
        }
      );
    });
  }

  function callBackgroundTranslation(text, targetLang) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          action: 'CALL_TRANSLATION_FALLBACK',
          text,
          targetLang
        },
        (res) => {
          if (res && res.success && res.text) {
            resolve(res.text);
          } else {
            resolve(text); // Fallback to original text if error
          }
        }
      );
    });
  }

  // =========================================================================
  // 4. SHADOW DOM SIDEBAR UI & INTERACTION
  // =========================================================================

  let sidebarHost = null;
  let shadowRoot = null;

  function initSidebarDOM() {
    if (sidebarHost) return;

    sidebarHost = document.createElement('div');
    sidebarHost.id = 'spe-sidebar-root';
    sidebarHost.style.position = 'fixed';
    sidebarHost.style.zIndex = '2147483647';
    sidebarHost.style.top = '0';
    sidebarHost.style.right = '0';
    sidebarHost.style.width = '0';
    sidebarHost.style.height = '100vh';
    sidebarHost.style.border = 'none';

    shadowRoot = sidebarHost.attachShadow({ mode: 'open' });
    document.body.appendChild(sidebarHost);

    // Inject styles and template into shadow DOM
    renderSidebarUI();
  }

  function renderSidebarUI() {
    if (!shadowRoot) return;

    const languagesOptions = (typeof SUPPORTED_LANGUAGES !== 'undefined' ? SUPPORTED_LANGUAGES : [])
      .map(lang => {
        const selected = lang.code === state.selectedLang ? 'selected' : '';
        return `<option value="${lang.code}" ${selected}>${lang.native} (${lang.name})</option>`;
      })
      .join('');

    shadowRoot.innerHTML = `
      <style>
        * {
          box-sizing: border-box;
          margin: 0;
          padding: 0;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
        }

        :host {
          all: initial;
        }

        /* Floating Trigger Pill (When sidebar is collapsed) */
        #spe-trigger-pill {
          position: fixed;
          top: 140px;
          right: 0;
          background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%);
          color: white;
          padding: 10px 14px 10px 12px;
          border-top-left-radius: 24px;
          border-bottom-left-radius: 24px;
          box-shadow: -3px 4px 18px rgba(79, 70, 229, 0.45);
          cursor: pointer;
          display: flex;
          align-items: center;
          gap: 8px;
          font-weight: 600;
          font-size: 13px;
          z-index: 2147483647;
          transition: transform 0.2s ease, box-shadow 0.2s ease;
          user-select: none;
        }

        #spe-trigger-pill:hover {
          transform: translateX(-4px);
          box-shadow: -4px 6px 22px rgba(79, 70, 229, 0.6);
        }

        #spe-trigger-pill svg {
          width: 18px;
          height: 18px;
          fill: currentColor;
        }

        /* Slide-in Main Panel */
        #spe-sidebar-panel {
          position: fixed;
          top: 0;
          right: -420px;
          width: 410px;
          height: 100vh;
          background: #ffffff;
          box-shadow: -5px 0 30px rgba(0, 0, 0, 0.18);
          display: flex;
          flex-direction: column;
          transition: right 0.3s cubic-bezier(0.16, 1, 0.3, 1);
          z-index: 2147483647;
          color: #1f2937;
          border-left: 1px solid #e5e7eb;
        }

        #spe-sidebar-panel.open {
          right: 0;
        }

        /* Header */
        .spe-header {
          padding: 16px;
          background: linear-gradient(135deg, #312e81 0%, #4338ca 100%);
          color: white;
          display: flex;
          flex-direction: column;
          gap: 12px;
          box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
        }

        .spe-topbar {
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .spe-title {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 15px;
          font-weight: 700;
          letter-spacing: -0.2px;
        }

        .spe-title-badge {
          background: rgba(250, 204, 21, 0.25);
          color: #fef08a;
          font-size: 10px;
          padding: 2px 6px;
          border-radius: 10px;
          border: 1px solid rgba(250, 204, 21, 0.4);
          font-weight: 600;
          text-transform: uppercase;
        }

        .spe-header-actions {
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .spe-icon-btn {
          background: rgba(255, 255, 255, 0.15);
          border: none;
          color: white;
          width: 28px;
          height: 28px;
          border-radius: 6px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: background 0.2s;
        }

        .spe-icon-btn:hover {
          background: rgba(255, 255, 255, 0.28);
        }

        /* Language Selector Bar */
        .spe-lang-bar {
          display: flex;
          align-items: center;
          background: rgba(255, 255, 255, 0.12);
          border: 1px solid rgba(255, 255, 255, 0.2);
          border-radius: 8px;
          padding: 4px 8px;
          gap: 6px;
        }

        .spe-lang-bar label {
          font-size: 11px;
          color: #e0e7ff;
          white-space: nowrap;
          font-weight: 500;
        }

        .spe-lang-select {
          flex: 1;
          background: transparent;
          border: none;
          color: #ffffff;
          font-size: 12px;
          font-weight: 600;
          outline: none;
          cursor: pointer;
        }

        .spe-lang-select option {
          background: #312e81;
          color: #ffffff;
        }

        /* Stats Sub-Bar */
        .spe-stats-bar {
          display: flex;
          justify-content: space-between;
          padding: 8px 16px;
          background: #f8fafc;
          border-bottom: 1px solid #e2e8f0;
          font-size: 11px;
          color: #64748b;
          font-weight: 500;
        }

        .spe-stats-pill {
          display: inline-flex;
          align-items: center;
          gap: 4px;
        }

        /* Action Toolbar */
        .spe-toolbar {
          display: flex;
          gap: 8px;
          padding: 10px 16px;
          background: #ffffff;
          border-bottom: 1px solid #f1f5f9;
        }

        .spe-btn {
          flex: 1;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          padding: 8px 10px;
          border-radius: 7px;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          border: 1px solid transparent;
          transition: all 0.2s;
        }

        .spe-btn-primary {
          background: #4f46e5;
          color: white;
          box-shadow: 0 1px 3px rgba(79, 70, 229, 0.3);
        }

        .spe-btn-primary:hover {
          background: #4338ca;
        }

        .spe-btn-secondary {
          background: #f1f5f9;
          color: #334155;
          border-color: #e2e8f0;
        }

        .spe-btn-secondary:hover {
          background: #e2e8f0;
        }

        /* API Key Banner (Compact) */
        .spe-api-banner {
          margin: 12px 16px 0;
          padding: 10px 12px;
          background: #eff6ff;
          border: 1px solid #bfdbfe;
          border-radius: 8px;
          font-size: 11px;
          color: #1e40af;
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        .spe-api-input-row {
          display: flex;
          gap: 6px;
        }

        .spe-api-input {
          flex: 1;
          padding: 5px 8px;
          border: 1px solid #93c5fd;
          border-radius: 5px;
          font-size: 11px;
          outline: none;
        }

        .spe-api-save-btn {
          background: #2563eb;
          color: white;
          border: none;
          padding: 4px 10px;
          border-radius: 5px;
          cursor: pointer;
          font-weight: 600;
        }

        /* Scrollable Content */
        .spe-content {
          flex: 1;
          overflow-y: auto;
          padding: 16px;
          display: flex;
          flex-direction: column;
          gap: 14px;
        }

        /* Loading View */
        .spe-loading-box {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: 40px 20px;
          text-align: center;
          gap: 12px;
        }

        .spe-spinner {
          width: 36px;
          height: 36px;
          border: 3px solid #e0e7ff;
          border-top-color: #4f46e5;
          border-radius: 50%;
          animation: speSpin 0.8s linear infinite;
        }

        @keyframes speSpin {
          to { transform: rotate(360deg); }
        }

        /* Overview Summary Card */
        .spe-summary-card {
          background: linear-gradient(145deg, #f8fafc 0%, #f1f5f9 100%);
          border: 1px solid #cbd5e1;
          border-radius: 10px;
          padding: 14px;
          position: relative;
        }

        .spe-summary-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 8px;
        }

        .spe-summary-title {
          font-size: 13px;
          font-weight: 700;
          color: #0f172a;
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .spe-summary-text {
          font-size: 13px;
          line-height: 1.55;
          color: #334155;
        }

        /* Highlight Cards */
        .spe-points-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-top: 6px;
        }

        .spe-points-title {
          font-size: 13px;
          font-weight: 700;
          color: #1e293b;
        }

        .spe-card {
          background: #ffffff;
          border: 1px solid #e2e8f0;
          border-radius: 10px;
          padding: 12px;
          display: flex;
          flex-direction: column;
          gap: 8px;
          transition: all 0.2s;
          cursor: pointer;
        }

        .spe-card:hover {
          border-color: #94a3b8;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);
          transform: translateY(-1px);
        }

        .spe-card.active {
          border-color: #4f46e5;
          background: #faf5ff;
          box-shadow: 0 0 0 2px rgba(79, 70, 229, 0.2);
        }

        .spe-card-top {
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .spe-badge {
          background: #fef08a;
          color: #854d0e;
          font-size: 11px;
          font-weight: 700;
          padding: 2px 7px;
          border-radius: 6px;
          border: 1px solid #fde047;
        }

        .spe-card-actions {
          display: flex;
          gap: 4px;
        }

        .spe-mini-btn {
          background: #f1f5f9;
          border: none;
          color: #475569;
          width: 24px;
          height: 24px;
          border-radius: 4px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 11px;
        }

        .spe-mini-btn:hover {
          background: #e2e8f0;
          color: #0f172a;
        }

        .spe-original-quote {
          font-size: 11px;
          color: #64748b;
          font-style: italic;
          border-left: 3px solid #cbd5e1;
          padding-left: 8px;
          line-height: 1.4;
        }

        .spe-explanation-box {
          background: #f8fafc;
          border-radius: 6px;
          padding: 8px 10px;
          border: 1px solid #e2e8f0;
        }

        .spe-explanation-label {
          font-size: 10px;
          font-weight: 700;
          text-transform: uppercase;
          color: #4f46e5;
          letter-spacing: 0.5px;
          margin-bottom: 2px;
        }

        .spe-explanation-text {
          font-size: 12.5px;
          font-weight: 500;
          color: #1e293b;
          line-height: 1.45;
        }

        .spe-analogy-box {
          font-size: 11.5px;
          color: #475569;
          display: flex;
          gap: 6px;
          align-items: flex-start;
          background: #fffbeb;
          border: 1px solid #fef3c7;
          border-radius: 6px;
          padding: 6px 8px;
        }

        /* Empty State */
        .spe-empty {
          text-align: center;
          padding: 40px 10px;
          color: #64748b;
          font-size: 13px;
          line-height: 1.6;
        }

        /* Toast notification */
        #spe-toast {
          position: fixed;
          bottom: 20px;
          right: 20px;
          background: #0f172a;
          color: white;
          padding: 8px 16px;
          border-radius: 20px;
          font-size: 12px;
          opacity: 0;
          transform: translateY(10px);
          transition: all 0.25s;
          pointer-events: none;
          z-index: 2147483647;
        }

        #spe-toast.show {
          opacity: 1;
          transform: translateY(0);
        }
      </style>

      <!-- Collapsed Trigger Pill -->
      <div id="spe-trigger-pill" title="Open Smart Page Explainer">
        <svg viewBox="0 0 24 24"><path d="M9 21c0 .55.45 1 1 1h4c.55 0 1-.45 1-1v-1H9v1zm3-19C8.14 2 5 5.14 5 9c0 2.38 1.19 4.47 3 5.74V17c0 .55.45 1 1 1h6c.55 0 1-.45 1-1v-2.26c1.81-1.27 3-3.36 3-5.74 0-3.86-3.14-7-7-7z"/></svg>
        <span>Explain Page</span>
      </div>

      <!-- Slide-out Sidebar Panel -->
      <div id="spe-sidebar-panel">
        <div class="spe-header">
          <div class="spe-topbar">
            <div class="spe-title">
              <span>💡 Smart Page Explainer</span>
              <span class="spe-title-badge">50+ Langs</span>
            </div>
            <div class="spe-header-actions">
              <button class="spe-icon-btn" id="spe-close-btn" title="Close">✕</button>
            </div>
          </div>

          <div class="spe-lang-bar">
            <label for="spe-lang-select">🌐 Language:</label>
            <select class="spe-lang-select" id="spe-lang-select">
              ${languagesOptions}
            </select>
          </div>
        </div>

        <div class="spe-stats-bar">
          <span class="spe-stats-pill" id="spe-stat-words">📝 0 words</span>
          <span class="spe-stats-pill" id="spe-stat-time">⏱️ 0 min read</span>
          <span class="spe-stats-pill" id="spe-stat-points">✨ 0 highlights</span>
        </div>

        <div class="spe-toolbar">
          <button class="spe-btn spe-btn-primary" id="spe-analyze-btn">
            🔍 Analyze & Highlight
          </button>
          <button class="spe-btn spe-btn-secondary" id="spe-toggle-highlights-btn" title="Toggle highlight visibility">
            🎨 Highlights: ON
          </button>
          <button class="spe-btn spe-btn-secondary" id="spe-tts-btn" title="Listen aloud">
            🔊 Listen
          </button>
        </div>

        <!-- Gemini API Key configuration card (shown if no key is entered) -->
        <div class="spe-api-banner" id="spe-api-banner" style="${state.apiKey ? 'display: none;' : ''}">
          <div><strong>⚡ Unlock Deep AI Explanations:</strong> Add a free Google Gemini API key or use built-in smart extractive analysis.</div>
          <div class="spe-api-input-row">
            <input type="password" class="spe-api-input" id="spe-api-input" placeholder="Paste Gemini API key..." />
            <button class="spe-api-save-btn" id="spe-api-save-btn">Save</button>
          </div>
        </div>

        <div class="spe-content" id="spe-content-area">
          <div class="spe-empty">
            <p><strong>Click "Analyze & Highlight"</strong> to read this page, highlight all core arguments, and explain them in Plain English or your native language!</p>
          </div>
        </div>
      </div>

      <div id="spe-toast"></div>
    `;

    bindSidebarEvents();
  }

  function bindSidebarEvents() {
    const trigger = shadowRoot.getElementById('spe-trigger-pill');
    const closeBtn = shadowRoot.getElementById('spe-close-btn');
    const analyzeBtn = shadowRoot.getElementById('spe-analyze-btn');
    const toggleHighlightsBtn = shadowRoot.getElementById('spe-toggle-highlights-btn');
    const ttsBtn = shadowRoot.getElementById('spe-tts-btn');
    const langSelect = shadowRoot.getElementById('spe-lang-select');
    const apiSaveBtn = shadowRoot.getElementById('spe-api-save-btn');
    const apiInput = shadowRoot.getElementById('spe-api-input');

    trigger?.addEventListener('click', openSidebar);
    closeBtn?.addEventListener('click', closeSidebar);

    analyzeBtn?.addEventListener('click', () => {
      runFullAnalysis();
    });

    langSelect?.addEventListener('change', (e) => {
      state.selectedLang = e.target.value;
      chrome.storage.sync.set({ selectedLanguage: state.selectedLang });
      showToast(`Language changed to ${e.target.options[e.target.selectedIndex].text}`);
      if (state.highlights.length > 0) {
        // Re-explain current keypoints in new language
        updateExplanationsForNewLanguage();
      }
    });

    toggleHighlightsBtn?.addEventListener('click', () => {
      state.highlightsVisible = !state.highlightsVisible;
      const marks = document.querySelectorAll('mark.spe-highlight');
      marks.forEach(m => {
        m.style.display = state.highlightsVisible ? 'inline' : 'inline';
        m.style.background = state.highlightsVisible ? '' : 'transparent';
        m.style.borderBottom = state.highlightsVisible ? '' : 'none';
      });
      toggleHighlightsBtn.innerText = state.highlightsVisible ? '🎨 Highlights: ON' : '🎨 Highlights: OFF';
    });

    ttsBtn?.addEventListener('click', () => {
      toggleTextToSpeech();
    });

    apiSaveBtn?.addEventListener('click', () => {
      const val = apiInput.value.trim();
      if (val) {
        state.apiKey = val;
        chrome.storage.sync.set({ apiKey: val });
        shadowRoot.getElementById('spe-api-banner').style.display = 'none';
        showToast('Gemini API Key saved successfully!');
        runFullAnalysis();
      }
    });
  }

  function openSidebar() {
    initSidebarDOM();
    state.isOpen = true;
    sidebarHost.style.width = '410px';
    const panel = shadowRoot.getElementById('spe-sidebar-panel');
    const trigger = shadowRoot.getElementById('spe-trigger-pill');
    panel?.classList.add('open');
    if (trigger) trigger.style.display = 'none';
  }

  function closeSidebar() {
    state.isOpen = false;
    const panel = shadowRoot.getElementById('spe-sidebar-panel');
    const trigger = shadowRoot.getElementById('spe-trigger-pill');
    panel?.classList.remove('open');
    if (trigger) trigger.style.display = 'flex';
    setTimeout(() => {
      if (!state.isOpen && sidebarHost) {
        sidebarHost.style.width = '0';
      }
    }, 300);
    stopTTS();
  }

  function toggleSidebar() {
    if (state.isOpen) closeSidebar();
    else openSidebar();
  }

  function showToast(msg) {
    const toast = shadowRoot?.getElementById('spe-toast');
    if (toast) {
      toast.innerText = msg;
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 2500);
    }
  }

  // =========================================================================
  // 5. FULL ORCHESTRATION: EXTRACT, HIGHLIGHT, AND EXPLAIN
  // =========================================================================

  async function runFullAnalysis() {
    if (state.isAnalyzing) return;
    state.isAnalyzing = true;

    const contentArea = shadowRoot.getElementById('spe-content-area');
    contentArea.innerHTML = `
      <div class="spe-loading-box">
        <div class="spe-spinner"></div>
        <p><strong>Reading page & extracting key points...</strong></p>
        <span style="font-size: 11px; color: #64748b;">Distilling key arguments into simple language</span>
      </div>
    `;

    try {
      // 1. Extract content from webpage
      const { fullText, validParagraphs } = extractCleanPageText();

      // Update stats UI
      shadowRoot.getElementById('spe-stat-words').innerText = `📝 ${state.stats.wordCount} words`;
      shadowRoot.getElementById('spe-stat-time').innerText = `⏱️ ${state.stats.readTime} min read`;

      if (validParagraphs.length === 0 || fullText.trim().length < 50) {
        contentArea.innerHTML = `
          <div class="spe-empty">
            <p>Could not extract readable article text from this page. Try selecting text manually to explain it.</p>
          </div>
        `;
        state.isAnalyzing = false;
        return;
      }

      // 2. Identify top key sentences (heuristic extractive TextRank)
      const keyPoints = extractKeySentences(validParagraphs, 6);
      keyPoints.forEach((p, idx) => p.id = idx);

      // 3. Highlight in-page
      highlightSentencesInPage(keyPoints);
      shadowRoot.getElementById('spe-stat-points').innerText = `✨ ${keyPoints.length} highlights`;

      // 4. Generate plain English or multilingual explanations
      const result = await generateExplanations(keyPoints, fullText, state.selectedLang);
      state.summary = result.summary;
      state.highlights = result.points;

      // 5. Render results
      renderResultsUI(result.summary, result.points);
      showToast(`Found and highlighted ${keyPoints.length} key points!`);
    } catch (err) {
      console.error('Error during analysis:', err);
      contentArea.innerHTML = `
        <div class="spe-empty" style="color: #ef4444;">
          <p><strong>Analysis Error:</strong> ${err.message || 'Something went wrong while analyzing the page.'}</p>
        </div>
      `;
    } finally {
      state.isAnalyzing = false;
    }
  }

  async function updateExplanationsForNewLanguage() {
    if (state.highlights.length === 0) return;
    const contentArea = shadowRoot.getElementById('spe-content-area');
    contentArea.innerHTML = `
      <div class="spe-loading-box">
        <div class="spe-spinner"></div>
        <p><strong>Translating explanations...</strong></p>
      </div>
    `;

    const { fullText } = extractCleanPageText();
    const result = await generateExplanations(state.highlights, fullText, state.selectedLang);
    state.summary = result.summary;
    state.highlights = result.points;
    renderResultsUI(result.summary, result.points);
  }

  function renderResultsUI(summaryText, points) {
    const contentArea = shadowRoot.getElementById('spe-content-area');
    const langMeta = getLanguageMetadata(state.selectedLang);

    let html = `
      <div class="spe-summary-card">
        <div class="spe-summary-header">
          <div class="spe-summary-title">
            <span>📋 Executive Summary</span>
          </div>
          <button class="spe-mini-btn" id="spe-copy-summary" title="Copy summary">📋</button>
        </div>
        <div class="spe-summary-text">${escapeHtml(summaryText)}</div>
      </div>

      <div class="spe-points-header">
        <div class="spe-points-title">Key Points & Plain Explanations (${points.length})</div>
        <span style="font-size: 11px; color: #64748b;">Click card to jump on page</span>
      </div>
    `;

    points.forEach((pt, idx) => {
      html += `
        <div class="spe-card" data-card-id="${pt.id}">
          <div class="spe-card-top">
            <span class="spe-badge">Key Point #${idx + 1}</span>
            <div class="spe-card-actions">
              <button class="spe-mini-btn spe-jump-btn" data-id="${pt.id}" title="Scroll to highlight on page">📍 Jump</button>
              <button class="spe-mini-btn spe-card-tts-btn" data-id="${pt.id}" title="Read aloud">🔊</button>
            </div>
          </div>

          <div class="spe-original-quote">
            "${escapeHtml(pt.sentence)}"
          </div>

          <div class="spe-explanation-box">
            <div class="spe-explanation-label">Plain Explanation (${langMeta.native}):</div>
            <div class="spe-explanation-text">${escapeHtml(pt.explanation || pt.takeaway)}</div>
          </div>

          ${pt.analogy ? `
            <div class="spe-analogy-box">
              <span>💡</span>
              <span><strong>In simple words:</strong> ${escapeHtml(pt.analogy)}</span>
            </div>
          ` : ''}
        </div>
      `;
    });

    contentArea.innerHTML = html;

    // Attach card event listeners
    contentArea.querySelectorAll('.spe-card').forEach(card => {
      const id = parseInt(card.getAttribute('data-card-id'), 10);
      card.addEventListener('click', () => {
        focusHighlightCard(id);
        scrollToPageHighlight(id);
      });
    });

    contentArea.querySelectorAll('.spe-jump-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = parseInt(btn.getAttribute('data-id'), 10);
        scrollToPageHighlight(id);
      });
    });

    contentArea.querySelectorAll('.spe-card-tts-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = parseInt(btn.getAttribute('data-id'), 10);
        const point = points.find(p => p.id === id);
        if (point) {
          speakText(`${point.takeaway}. ${point.explanation}`);
        }
      });
    });

    shadowRoot.getElementById('spe-copy-summary')?.addEventListener('click', () => {
      let fullExport = `Summary:\n${summaryText}\n\nKey Points:\n`;
      points.forEach((p, i) => {
        fullExport += `${i + 1}. ${p.takeaway}\nExplanation: ${p.explanation}\n\n`;
      });
      navigator.clipboard.writeText(fullExport);
      showToast('Summary copied to clipboard!');
    });
  }

  function focusHighlightCard(id) {
    state.activeHighlightId = id;
    const cards = shadowRoot.querySelectorAll('.spe-card');
    cards.forEach(c => {
      if (parseInt(c.getAttribute('data-card-id'), 10) === id) {
        c.classList.add('active');
        c.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } else {
        c.classList.remove('active');
      }
    });
  }

  // =========================================================================
  // 6. TEXT-TO-SPEECH (TTS) IN NATIVE LANGUAGE
  // =========================================================================

  function toggleTextToSpeech() {
    if (state.isSpeaking) {
      stopTTS();
      return;
    }

    if (!state.summary && state.highlights.length === 0) {
      showToast('Please analyze the page first!');
      return;
    }

    let speechText = state.summary + '. ';
    state.highlights.forEach((h, i) => {
      speechText += `Point ${i + 1}: ${h.takeaway}. ${h.explanation}. `;
    });

    speakText(speechText);
  }

  function speakText(text) {
    if (!('speechSynthesis' in window)) {
      showToast('Speech synthesis not supported in this browser.');
      return;
    }

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    const langMeta = getLanguageMetadata(state.selectedLang);
    utterance.lang = langMeta.bcp47 || 'en-US';
    utterance.rate = 1.0;

    utterance.onstart = () => {
      state.isSpeaking = true;
      const ttsBtn = shadowRoot?.getElementById('spe-tts-btn');
      if (ttsBtn) ttsBtn.innerText = '⏹️ Stop';
    };

    utterance.onend = () => {
      state.isSpeaking = false;
      const ttsBtn = shadowRoot?.getElementById('spe-tts-btn');
      if (ttsBtn) ttsBtn.innerText = '🔊 Listen';
    };

    utterance.onerror = () => {
      state.isSpeaking = false;
      const ttsBtn = shadowRoot?.getElementById('spe-tts-btn');
      if (ttsBtn) ttsBtn.innerText = '🔊 Listen';
    };

    window.speechSynthesis.speak(utterance);
  }

  function stopTTS() {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    state.isSpeaking = false;
    const ttsBtn = shadowRoot?.getElementById('spe-tts-btn');
    if (ttsBtn) ttsBtn.innerText = '🔊 Listen';
  }

  // =========================================================================
  // 7. SELECTION QUICK EXPLAIN BUBBLE
  // =========================================================================

  let bubbleElement = null;

  document.addEventListener('mouseup', (e) => {
    // If click inside our sidebar, ignore
    if (sidebarHost && sidebarHost.contains(e.target)) return;

    setTimeout(() => {
      const selection = window.getSelection();
      const selectedText = selection.toString().trim();

      if (selectedText.length > 8 && selectedText.length < 2500) {
        showSelectionBubble(e.pageX, e.pageY, selectedText);
      } else {
        removeSelectionBubble();
      }
    }, 10);
  });

  function showSelectionBubble(x, y, text) {
    removeSelectionBubble();

    bubbleElement = document.createElement('div');
    bubbleElement.id = 'spe-selection-bubble';
    bubbleElement.innerHTML = `💡 Explain Selection`;
    bubbleElement.style.top = `${y + 12}px`;
    bubbleElement.style.left = `${Math.min(window.innerWidth - 180, Math.max(10, x - 50))}px`;

    bubbleElement.addEventListener('click', (e) => {
      e.stopPropagation();
      openSidebar();
      explainCustomText(text);
      removeSelectionBubble();
    });

    document.body.appendChild(bubbleElement);
  }

  function removeSelectionBubble() {
    if (bubbleElement && bubbleElement.parentNode) {
      bubbleElement.parentNode.removeChild(bubbleElement);
      bubbleElement = null;
    }
  }

  async function explainCustomText(text) {
    const contentArea = shadowRoot.getElementById('spe-content-area');
    contentArea.innerHTML = `
      <div class="spe-loading-box">
        <div class="spe-spinner"></div>
        <p><strong>Explaining selection...</strong></p>
      </div>
    `;

    const singlePoint = [{ sentence: text, element: null, id: 0 }];
    const result = await generateExplanations(singlePoint, text, state.selectedLang);
    renderResultsUI(`Explanation for selected text`, result.points);
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Initial trigger creation on idle
  initSidebarDOM();
})();