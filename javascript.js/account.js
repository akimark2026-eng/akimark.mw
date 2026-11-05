// account.js (v3 — matches home, no subheader, header scroll effects, Bulletproof Auth)
// Fixes auto-logout in WebView by using Cookie fallback and optimistic rendering.

(function() {
    'use strict';

    var TOKEN_KEY = 'akmark_token';
    var USER_KEY = 'akmark_user';

    // Sample movie list for search
    var ALL_MOVIES = [
        'The Last Horizon', 'Rising Tides', 'Neon Dreams', 'The Forgotten Path',
        'Quantum Heist', 'Summer Lights', 'Dark Matter', 'The Silent Echo',
        'Laughing Under Rain', 'The Last Stand', 'Midnight Express', 'Beyond the Stars',
        'The Garden of Words', 'Crimson Tide', 'Funny Bones', 'Echoes of Tomorrow',
        'The Local Story', 'K-Pop Love', 'The Wire', 'Space Frontier', 'City of Shadows',
        'Laugh Track', 'Love in the City'
    ];

    // ════════════════════════════════════════════════════════════
    // 🎯 COOKIE HELPERS (Fallback for WebView LocalStorage issues)
    // ════════════════════════════════════════════════════════════
    function setCookie(name, value, days) {
        var expires = "";
        if (days) {
            var date = new Date();
            date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
            expires = "; expires=" + date.toUTCString();
        }
        document.cookie = name + "=" + (value || "") + expires + "; path=/; SameSite=Lax";
    }
    
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
    
    function eraseCookie(name) {   
        document.cookie = name +'=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT;';
    }

    // ════════════════════════════════════════════════════════════
    // 🎯 ROBUST TOKEN RETRIEVAL
    // ════════════════════════════════════════════════════════════
    function getToken() { 
        var token = localStorage.getItem(TOKEN_KEY);
        if (!token) token = sessionStorage.getItem(TOKEN_KEY);
        if (!token) token = getCookie(TOKEN_KEY); // Check Cookie Fallback
        
        if (!token || token === 'null' || token === 'undefined') return null;
        
        try {
            var parsed = JSON.parse(token);
            if (parsed && parsed.access_token) return parsed.access_token;
            if (typeof parsed === 'string') return parsed;
        } catch(e) {}
        
        return String(token).replace(/^["']|["']$/g, '').trim();
    }

    function setTokenInAllPlaces(token) {
        localStorage.setItem(TOKEN_KEY, token);
        sessionStorage.setItem(TOKEN_KEY, token);
        setCookie(TOKEN_KEY, token, 7); // Save to Cookie for 7 days
    }

    function setUser(user) { 
        localStorage.setItem(USER_KEY, JSON.stringify(user)); 
        setCookie('akmark_user_logged', 'true', 7);
    }

    function clearSession() {
        localStorage.removeItem(TOKEN_KEY);
        sessionStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem('akmark_refresh_token');
        sessionStorage.removeItem('akmark_refresh_token');
        localStorage.removeItem(USER_KEY);
        eraseCookie(TOKEN_KEY); 
        eraseCookie('akmark_user_logged');
    }

    // ════════════════════════════════════════════════════════════
    // 🎯 RENDER USER DATA (Extracted for reusability)
    // ════════════════════════════════════════════════════════════
    function renderUserData(user) {
        if (!user) return;
        
        document.getElementById('accountSkeleton').style.display = 'none';
        document.getElementById('accountReal').style.display = 'block';

        document.getElementById('accountFullName').textContent = user.full_name || '';
        document.getElementById('accountUserId').textContent = user.user_id || '';
        document.getElementById('accountPhone').textContent = user.phone || '';

        var balance = user.wallet_balance || 0;
        document.getElementById('walletValue').textContent = Number(balance).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

        document.body.dataset.userId = user.user_id || '';
    }

    // ════════════════════════════════════════════════════════════
    // 🎯 BULLETPROOF AUTH SYSTEM
    // ════════════════════════════════════════════════════════════
    function checkLogin() {
        var token = getToken();
        if (!token) {
            window.location.href = 'login.html';
            return;
        }

        // Ensure token is saved in cookie if it was only in localStorage
        setTokenInAllPlaces(token);

        // 1. Optimistic Render: Load from cache immediately (No blank screen)
        var cachedUser = null;
        try { 
            cachedUser = JSON.parse(localStorage.getItem(USER_KEY)); 
        } catch(e) {}
        
        if (cachedUser) {
            renderUserData(cachedUser);
        }

        // 2. Background Fetch: Verify with server
        fetch('https://vqmmsqtlszzugdyoyilu.supabase.co/functions/v1/login-checker', {
            method: 'GET',
            headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }
        })
        .then(function(response) {
            // 🎯 ONLY LOGOUT IF SERVER EXPLICITLY SAYS UNAUTHORIZED/FORBIDDEN
            if (response.status === 401 || response.status === 403) {
                console.warn('🚨 Session explicitly invalidated by server. Logging out.');
                clearSession();
                window.location.href = 'non.html';
                return null; // Stop processing
            }
            if (!response.ok) throw new Error('Network response was not ok');
            return response.json();
        })
        .then(function(data) {
            if (!data) return; // Was logged out above

            if (!data.valid) {
                clearSession();
                window.location.href = 'non.html';
                return;
            }

            if (data.user) {
                setUser(data.user);
                renderUserData(data.user);
            }
        })
        .catch(function(err) {
            // 🎯 CRITICAL FIX: Ignore AbortError or Network Error during page transition!
            console.warn('Auth check ignored (WebView transition):', err); 
            
            // If we don't have cached user data, show a network error toast instead of logging out
            if (!cachedUser) {
                showToast('Network error. Please check your connection.', true);
            }
        });
    }

    // ===== SEARCH (matches home) =====
    function initSearch() {
        var searchNavBtn = document.getElementById('searchNavBtn');
        var searchSubheader = document.getElementById('searchSubheader');
        var searchInput = document.getElementById('searchInput');
        var searchResults = document.getElementById('searchResults');
        if (!searchNavBtn) return;

        var debounceTimer = null;

        searchNavBtn.addEventListener('click', function(e) {
            e.preventDefault();
            searchSubheader.classList.toggle('open');
            if (searchSubheader.classList.contains('open')) {
                setTimeout(function() { searchInput.focus(); }, 120);
            } else {
                searchInput.value = '';
                searchResults.classList.remove('visible');
            }
        });

        searchInput.addEventListener('input', function() {
            var query = this.value.toLowerCase().trim();
            if (!query) { searchResults.classList.remove('visible'); return; }
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(function() {
                var filtered = ALL_MOVIES.filter(function(title) {
                    return title.toLowerCase().includes(query);
                });
                if (filtered.length > 0) {
                    searchResults.innerHTML = filtered.map(function(title) {
                        return '<div class="result-item" data-title="' + title + '">' + title + '</div>';
                    }).join('');
                } else {
                    searchResults.innerHTML = '<div class="result-item">No movies found</div>';
                }
                searchResults.classList.add('visible');
            }, 220);
        });

        searchResults.addEventListener('click', function(e) {
            var item = e.target.closest('.result-item');
            if (!item || !item.dataset.title) return;
            window.location.href = 'home.html';
            searchSubheader.classList.remove('open');
            searchResults.classList.remove('visible');
        });

        document.addEventListener('click', function(e) {
            if (!searchSubheader.contains(e.target) && !searchNavBtn.contains(e.target)) {
                searchResults.classList.remove('visible');
            }
        });
    }

    function logout() {
        clearSession();
        window.location.href = 'non.html';
    }

    function showToast(msg, isError) {
        var toast = document.getElementById('toast');
        var toastMsg = document.getElementById('toastMsg');
        if (!toast) return;
        if (toastMsg) toastMsg.textContent = msg;
        else toast.textContent = msg;
        toast.classList.add('show');
        if (isError) {
            toast.style.border = '1px solid #ff6b6b';
        } else {
            toast.style.border = 'none';
        }
        setTimeout(function() { toast.classList.remove('show'); }, 3000);
    }

    function initCopyUserId() {
        var copyBtn = document.getElementById('copyUserIdBtn');
        var userIdEl = document.getElementById('accountUserId');
        if (copyBtn && userIdEl) {
            copyBtn.addEventListener('click', function() {
                var userId = userIdEl.textContent.trim();
                if (!userId) return;
                if (navigator.clipboard) {
                    navigator.clipboard.writeText(userId).then(function() {
                        showToast('User ID copied!', false);
                    }).catch(function() {
                        alert('Copy failed. Please copy manually.');
                    });
                } else {
                    var tempInput = document.createElement('input');
                    tempInput.value = userId;
                    document.body.appendChild(tempInput);
                    tempInput.select();
                    document.execCommand('copy');
                    document.body.removeChild(tempInput);
                    showToast('User ID copied!', false);
                }
            });
        }
    }

    // ════════════════════════════════════════════════════════════
    // SCROLL EFFECTS — same as home (header hides on scroll)
    // ════════════════════════════════════════════════════════════
    function initScrollEffects() {
        var header = document.getElementById('mainHeader');

        var lastScrollY = 0;
        var ticking = false;
        var HIDE_AFTER = 100;
        var isHidden = false;

        function updateScroll() {
            var y = window.pageYOffset || document.documentElement.scrollTop || 0;
            var delta = y - lastScrollY;

            if (header) {
                if (y > 10) header.classList.add('scrolled');
                else header.classList.remove('scrolled');
            }

            if (Math.abs(delta) < 4) { ticking = false; return; }

            if (y < HIDE_AFTER) {
                if (isHidden) {
                    header.classList.remove('hidden');
                    isHidden = false;
                }
            } else if (delta > 6 && !isHidden) {
                header.classList.add('hidden');
                isHidden = true;
            } else if (delta < -6 && isHidden) {
                header.classList.remove('hidden');
                isHidden = false;
            }

            lastScrollY = y < 0 ? 0 : y;
            ticking = false;
        }

        window.addEventListener('scroll', function() {
            if (!ticking) {
                window.requestAnimationFrame(updateScroll);
                ticking = true;
            }
        }, { passive: true });
    }

    function initSecurity() {
        document.addEventListener('contextmenu', function(e) { e.preventDefault(); });
        document.addEventListener('keydown', function(e) {
            if (e.key === 'F12' ||
                (e.ctrlKey && e.shiftKey && (e.key === 'I' || e.key === 'J' || e.key === 'C')) ||
                (e.ctrlKey && e.key === 'u')) {
                e.preventDefault();
                return false;
            }
        });
    }

    function init() {
        checkLogin();
        initSearch();
        initCopyUserId();
        initScrollEffects();
        initSecurity();

        var logoutBtn = document.getElementById('logoutBtn');
        if (logoutBtn) logoutBtn.addEventListener('click', function() { logout(); });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
