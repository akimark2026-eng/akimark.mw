// index.js (v4 — Ultra Fast Local Session Check)
// Removed: Edge Function calls for initial routing.
// Result: Instant page load, 0 Supabase invocations for simple navigation.

(function() {
    'use strict';

    var TOKEN_KEY = 'akmark_token';
    var HOME_PAGE = 'home.html';
    var NON_PAGE = 'non.html';
    var BLOCKED_PAGE = 'blocked.html';

    // ================== LOCAL RISK CHECK (No Network) ==================
    function getAndroidRiskScore() {
        if (window.Android && typeof window.Android.getEmulatorRisk === 'function') {
            try {
                var score = parseInt(window.Android.getEmulatorRisk());
                return isNaN(score) ? 0 : score;
            } catch (e) { return 0; }
        }
        return 0;
    }

    function getBrowserRiskScore() {
        var score = 0;
        var ua = navigator.userAgent.toLowerCase();
        var emulatorKeywords = ['emulator', 'simulator', 'bluestacks', 'nox', 'ldplayer', 'mumu', 'memu', 'genymotion'];
        for (var i = 0; i < emulatorKeywords.length; i++) {
            if (ua.indexOf(emulatorKeywords[i]) !== -1) { score += 40; break; }
        }
        if (!('ontouchstart' in window) && !navigator.maxTouchPoints) score += 15;
        if (window.screen.width === 320 && window.screen.height === 240) score += 10;
        return score;
    }

    // ================== ROBUST TOKEN RETRIEVAL (LocalStorage + Cookie) ==================
    function getCookie(name) {
        var nameEQ = name + "=";
        var ca = document.cookie.split(';');
        for(var i=0; i < ca.length; i++) {
            var c = ca[i];
            while (c.charAt(0)==' ') c = c.substring(1,c.length);
            if (c.indexOf(nameEQ) == 0) return c.substring(nameEQ.length,c.length);
        }
        return null;
    }

    function getToken() {
        var token = null;
        
        // 1. Try LocalStorage (WebView normal)
        try { token = localStorage.getItem(TOKEN_KEY); } catch(e) {}
        
        // 2. Try SessionStorage
        if (!token) { try { token = sessionStorage.getItem(TOKEN_KEY); } catch(e) {} }
        
        // 3. Try Cookie (WebView fallback)
        if (!token) { token = getCookie(TOKEN_KEY); }
        
        if (!token || token === 'null' || token === 'undefined') return null;
        
        try {
            var parsed = JSON.parse(token);
            if (parsed && parsed.access_token) return parsed.access_token;
            if (typeof parsed === 'string') return parsed;
        } catch(e) {}
        
        return String(token).replace(/^["']|["']$/g, '').trim();
    }

    // ================== INITIALIZATION ==================
    function init() {
        // 1. Check for Emulators (No network call)
        var combinedRisk = Math.max(getAndroidRiskScore(), getBrowserRiskScore());
        if (combinedRisk >= 90) {
            window.location.replace(BLOCKED_PAGE);
            return;
        }

        // 2. Fast Local Check for Token
        var token = getToken();
        
        if (token) {
            // User has a token (Valid or Expired) -> Send to Home
            // Home.js will verify the token in the background.
            console.log('[Akimark] Token found — Fast routing to HOME');
            window.location.replace(HOME_PAGE);
        } else {
            // No token -> Send to Non (Guest mode)
            console.log('[Akimark] No token — Routing to NON');
            window.location.replace(NON_PAGE);
        }
    }

    // ================== RUN ==================
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
