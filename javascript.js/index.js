// index.js
(function() {
    'use strict';

    var TOKEN_KEY = 'akmark_token';
    var SUPABASE_URL = window.SUPABASE_URL || 'https://jnqwvmxuieeelvukhcsq.supabase.co';

    // ===== CHECK LOGIN & REDIRECT =====
    function checkLoginAndRedirect() {
        var token = localStorage.getItem(TOKEN_KEY);
        
        // If no token, go to non.html (guest)
        if (!token) {
            window.location.href = 'non.html';
            return;
        }

        // Token exists – verify with backend
        fetch(`${SUPABASE_URL}/functions/v1/login-checker`, {
            method: 'GET',
            headers: {
                'Authorization': 'Bearer ' + token,
                'Content-Type': 'application/json'
            }
        })
        .then(function(response) {
            return response.text().then(function(text) {
                try { return JSON.parse(text); } catch (e) { throw new Error('Invalid'); }
            });
        })
        .then(function(data) {
            if (data.valid) {
                // Valid session – go to home
                window.location.href = 'home.html';
            } else {
                // Invalid session – clear and go to non
                clearSession();
                window.location.href = 'non.html';
            }
        })
        .catch(function() {
            // Network error or invalid – go to non
            clearSession();
            window.location.href = 'non.html';
        });
    }

    function clearSession() {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem('akmark_refresh_token');
        localStorage.removeItem('akmark_user');
    }

    // Start after page loads
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', checkLoginAndRedirect);
    } else {
        checkLoginAndRedirect();
    }
})();
