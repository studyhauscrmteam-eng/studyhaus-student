let translations = {};
let currentLanguage = localStorage.getItem('appLanguage') || 'en';

export const loadTranslations = async (lang = currentLanguage) => {
  try {
    const prefix = window.location.pathname.match(/\/(admin|employee|student)\//) ? '../' : './';
    const response = await fetch(`${prefix}translations/${lang}.json`);
    if (!response.ok) {
      throw new Error(`Failed to load ${lang}.json`);
    }
    translations = await response.json();
    currentLanguage = lang;
    localStorage.setItem('appLanguage', lang);
    
    // Dispatch an event so dynamic components can re-render
    window.dispatchEvent(new CustomEvent('languageChanged', { detail: { lang } }));
    
    // Immediately translate static DOM elements
    if (typeof window.translateDOM === 'function') {
      window.translateDOM();
    }
  } catch (error) {
    console.error("Translation Service Error:", error);
  }
};

export const setLanguage = async (lang) => {
  await loadTranslations(lang);
};

export const getLanguage = () => currentLanguage;

window.t = (key, args = {}) => {
  let text = translations[key] || key;
  
  // Replace variables like {{name}}
  for (const [argKey, argValue] of Object.entries(args)) {
    text = text.replace(new RegExp(`{{${argKey}}}`, 'g'), argValue);
  }
  
  return text;
};

window.translateDOM = () => {
  const elements = document.querySelectorAll('[data-i18n]');
  elements.forEach(el => {
    const key = el.getAttribute('data-i18n');
    const argsAttr = el.getAttribute('data-i18n-args');
    let args = {};
    if (argsAttr) {
      try {
        args = JSON.parse(argsAttr);
      } catch (e) {
        console.error("Error parsing data-i18n-args", e);
      }
    }
    
    const translatedText = window.t(key, args);
    
    // Check if it's an input/textarea placeholder vs innerText
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      el.placeholder = translatedText;
    } else {
      el.innerText = translatedText;
    }
  });
};

// Auto-load on script execution — then translate the DOM
loadTranslations(currentLanguage).then(() => {
  if (typeof window.translateDOM === 'function') {
    window.translateDOM();
  }
});

// Mutation Observer to auto-translate dynamically added DOM elements
const observer = new MutationObserver((mutations) => {
  let shouldTranslate = false;
  for (const mutation of mutations) {
    if (mutation.addedNodes.length > 0) {
      // Fast check if any added node or its children have data-i18n
      for (const node of mutation.addedNodes) {
        if (node.nodeType === 1) { // Element node
          if (node.hasAttribute('data-i18n') || node.querySelector('[data-i18n]')) {
            shouldTranslate = true;
            break;
          }
        }
      }
    }
    if (shouldTranslate) break;
  }
  
  if (shouldTranslate) {
    window.translateDOM();
  }
});

document.addEventListener('DOMContentLoaded', () => {
  observer.observe(document.body, { childList: true, subtree: true });
  // Also translate static DOM elements that already exist in the HTML
  window.translateDOM();
});
