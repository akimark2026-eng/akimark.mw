// account.js (v5 — Pro Cache-First + 20-Min Auth Cache + Local Search + Zero-Block)
// Upgrades:
//  - login-checker cached 20min in sessionStorage (per-token).
//  - Transactions cached 2min, Subscriptions 5min (per-token).
//  - Immediate paint from cached user; verify session in background.
//  - Visibility refresh for session if cache is 5-20min old.
//  - Global 401 handler -> auto redirect to login.
//  - Local search from films cache, API fallback only when needed.
//  - Logout clears all app caches.

(function() {
    'use strict';

    var TOKEN_KEY = 'akmark_token';
    var USER_KEY = 'akmark_user';
    var SUPABASE_URL = window.SUPABASE_URL;

    // ════════════════════════════════════════════════════════════
    // 🎯 CACHE CONFIG
    // ════════════════════════════════════════════════════════════
    var CACHE_KEYS = {
        LOGIN: 'akmark_cache_login_',   // per token
        TX:    'akmark_cache_tx_',      // per token
        SUBS:  'akmark_cache_subs_'     // per token
    };
    var TTL = {
        LOGIN: 20 * 60 * 1000,  // 20 min — as requested
        TX:     2 * 60 * 1000,  // 2 min
        SUBS:   5 * 60 * 1000   // 5 min
    };
    var FILMS_CACHE_KEY = 'akmark_cache_films_v4';
    var FILMS_TTL = 5 * 60 * 1000;

    // ════════════════════════════════════════════════════════════
    // 🎯 COOKIE HELPERS
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
        for (var i = 0; i < ca.length; i++) {
            var c = ca[i];
            while (c.charAt(0) == ' ') c = c.substring(1, c.length);
            if (c.indexOf(nameEQ) == 0) return c.substring(nameEQ.length, c.length);
        }
        return null;
    }
    function eraseCookie(name) {
        document.cookie = name + '=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT;';
    }

    // ════════════════════════════════════════════════════════════
    // 🎯 SAFE STORAGE + CACHE HELPERS
    // ════════════════════════════════════════════════════════════
    function safeGet(storage, key) { try { return storage.getItem(key); } catch (e) { return null; } }
    function safeSet(storage, key, val) { try { storage.setItem(key, val); } catch (e) {} }
    function safeRemove(storage, key) { try { storage.removeItem(key); } catch (e) {} }

    function sessionCacheRead(key, ttl) {
        var raw = safeGet(sessionStorage, key);
        if (!raw) return null;
        try {
            var p = JSON.parse(raw);
            if (Date.now() - p.ts > ttl) return null;
            return p.data;
        } catch (e) { return null; }
    }
    function sessionCacheReadRaw(key) {
        var raw = safeGet(sessionStorage, key);
        if (!raw) return null;
        try { return JSON.parse(raw); } catch (e) { return null; }
    }
    function sessionCacheWrite(key, data) {
        safeSet(sessionStorage, key, JSON.stringify({ ts: Date.now(), data: data }));
    }

    function localStorageCacheRead(key, ttl) {
        var raw = safeGet(localStorage, key);
        if (!raw) return null;
        try {
            var p = JSON.parse(raw);
            if (Date.now() - p.ts > ttl) return null;
            return p.data;
        } catch (e) { return null; }
    }

    // ════════════════════════════════════════════════════════════
    // 🎯 TOKEN / USER
    // ════════════════════════════════════════════════════════════
    function getToken() {
        var token = safeGet(localStorage, TOKEN_KEY);
        if (!token) token = safeGet(sessionStorage, TOKEN_KEY);
        if (!token) token = getCookie(TOKEN_KEY);
        if (!token || token === 'null' || token === 'undefined') return null;
        try {
            var parsed = JSON.parse(token);
            if (parsed && parsed.access_token) return parsed.access_token;
            if (typeof parsed === 'string') return parsed;
        } catch (e) {}
        return String(token).replace(/^["']|["']$/g, '').trim();
    }

    function setTokenInAllPlaces(token) {
        safeSet(localStorage, TOKEN_KEY, token);
        safeSet(sessionStorage, TOKEN_KEY, token);
        setCookie(TOKEN_KEY, token, 7);
    }

    function setUser(user) {
        safeSet(localStorage, USER_KEY, JSON.stringify(user));
        setCookie('akmark_user_logged', 'true', 7);
    }

    function clearSession() {
        var token = window._currentToken;
        safeRemove(localStorage, TOKEN_KEY);
        safeRemove(sessionStorage, TOKEN_KEY);
        safeRemove(localStorage, 'akmark_refresh_token');
        safeRemove(sessionStorage, 'akmark_refresh_token');
        safeRemove(localStorage, USER_KEY);
        eraseCookie(TOKEN_KEY);
        eraseCookie('akmark_user_logged');

        if (token) {
            safeRemove(sessionStorage, CACHE_KEYS.LOGIN + token);
            safeRemove(sessionStorage, CACHE_KEYS.TX + token);
            safeRemove(sessionStorage, CACHE_KEYS.SUBS + token);
        }
    }

    function clearAllAppCaches() {
        // home.js caches
        safeRemove(localStorage, FILMS_CACHE_KEY);
        safeRemove(localStorage, 'akmark_cache_translators_v4');
        safeRemove(localStorage, 'akmark_cache_ads_v1');
        safeRemove(localStorage, 'akmark_cache_trending_v1');

        if (window.AkimarkCache && typeof window.AkimarkCache.clearAll === 'function') {
            try { window.AkimarkCache.clearAll(); } catch (e) {}
        }
    }

    function handleAuthError(status) {
        if (status === 401 || status === 403) {
            clearSession();
            window.location.href = 'login.html';
            return true;
        }
        return false;
    }

    // ════════════════════════════════════════════════════════════
    // 🎯 DEDUPE FETCH + ESCAPE
    // ════════════════════════════════════════════════════════════
    var inflight = {};
    function dedupeFetch(url, options) {
        var key = url + '|' + (options && options.headers ? JSON.stringify(options.headers) : '');
        if (inflight[key]) return inflight[key];
        var p = fetch(url, options).finally(function() { delete inflight[key]; });
        inflight[key] = p;
        return p;
    }

    function escHTML(str) {
        return String(str == null ? '' : str).replace(/[&<>"']/g, function(c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    // ════════════════════════════════════════════════════════════
    // 🎯 FORMATTING
    // ════════════════════════════════════════════════════════════
    function formatPrice(price) {
        return 'MK ' + Number(price || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    function formatDate(isoString) {
        if (!isoString) return 'N/A';
        var d = new Date(isoString);
        return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    }

    // ════════════════════════════════════════════════════════════
    // 🎯 RENDER USER
    // ════════════════════════════════════════════════════════════
    function renderUserData(user) {
        if (!user) return;

        var skeleton = document.getElementById('accountSkeleton');
        var real = document.getElementById('accountReal');
        if (skeleton) skeleton.style.display = 'none';
        if (real) real.style.display = 'block';

        var fullNameEl = document.getElementById('accountFullName');
        var userIdEl = document.getElementById('accountUserId');
        var phoneEl = document.getElementById('accountPhone');
        var walletEl = document.getElementById('walletValue');
        var coinsEl = document.getElementById('coinsValue');
        var earningsEl = document.getElementById('earningsValue');

        if (fullNameEl) fullNameEl.textContent = user.full_name || 'User';
        if (userIdEl) userIdEl.textContent = user.user_id || 'N/A';
        if (phoneEl) phoneEl.textContent = user.phone || 'N/A';

        var balance = user.wallet_balance || 0;
        if (walletEl) walletEl.textContent = Number(balance).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

        if (coinsEl) coinsEl.textContent = user.coins || 0;
        if (earningsEl) earningsEl.textContent = user.coins || 0;

        document.body.dataset.userId = user.user_id || '';
    }

    // ════════════════════════════════════════════════════════════
    // 🎯 RENDER TRANSACTIONS
    // ════════════════════════════════════════════════════════════
    function renderTransactions(txs) {
        var container = document.getElementById('inlineTxContainer');
        var countEl = document.getElementById('transactionsCount');
        var seeAllBtn = document.getElementById('seeAllTxBtn');
        var modalBody = document.getElementById('modalTxBody');
        if (!container || !countEl || !seeAllBtn || !modalBody) return;

        countEl.textContent = txs.length;

        if (txs.length === 0) {
            container.innerHTML = '<div class="empty-state-box"><svg viewBox="0 0 24 24"><path d="M7 16V4M7 4L3 8M7 4L11 8M17 8V20M17 20L21 16M17 20L13 16"/></svg><span>No transactions yet</span></div>';
            seeAllBtn.style.display = 'none';
            return;
        }

        function createTxHTML(tx) {
            var isPos = tx.amount > 0;
            var sign = isPos ? '+' : '';
            var amtClass = isPos ? 'positive' : 'negative';
            return '<div class="data-item">' +
                '<div class="data-info">' +
                    '<div class="data-name">' + escHTML(tx.description || tx.type || 'Transaction') + '</div>' +
                    '<div class="data-date">' + formatDate(tx.created_at) + '</div>' +
                '</div>' +
                '<div class="data-amount ' + amtClass + '">' + sign + formatPrice(tx.amount) + '</div>' +
            '</div>';
        }

        container.innerHTML = txs.slice(0, 3).map(createTxHTML).join('');

        if (txs.length > 3) {
            seeAllBtn.style.display = 'block';
            seeAllBtn.onclick = function() {
                modalBody.innerHTML = txs.map(createTxHTML).join('');
                var modal = document.getElementById('modalTx');
                if (modal) modal.classList.add('open');
            };
        } else {
            seeAllBtn.style.display = 'none';
        }
    }

    // ════════════════════════════════════════════════════════════
    // 🎯 RENDER SUBSCRIPTIONS
    // ════════════════════════════════════════════════════════════
    function renderSubscriptions(subs) {
        var container = document.getElementById('inlineSubsContainer');
        var countEl = document.getElementById('subsCount');
        var seeAllBtn = document.getElementById('seeAllSubsBtn');
        var modalBody = document.getElementById('modalSubsBody');
        if (!container || !countEl || !seeAllBtn || !modalBody) return;

        countEl.textContent = subs.length;

        if (subs.length === 0) {
            container.innerHTML = '<div class="empty-state-box"><svg viewBox="0 0 24 24"><path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"/></svg><span>No active subscriptions</span></div>';
            seeAllBtn.style.display = 'none';
            return;
        }

        function createSubHTML(sub) {
            return '<div class="data-item">' +
                '<div class="data-info">' +
                    '<div class="data-name">' + escHTML(sub.plan_name || 'Premium Plan') + '</div>' +
                    '<div class="data-status">Active</div>' +
                '</div>' +
                '<div class="data-date">Expires: ' + formatDate(sub.expiry_date) + '</div>' +
            '</div>';
        }

        container.innerHTML = subs.slice(0, 3).map(createSubHTML).join('');

        if (subs.length > 3) {
            seeAllBtn.style.display = 'block';
            seeAllBtn.onclick = function() {
                modalBody.innerHTML = subs.map(createSubHTML).join('');
                var modal = document.getElementById('modalSubs');
                if (modal) modal.classList.add('open');
            };
        } else {
            seeAllBtn.style.display = 'none';
        }
    }

    // ════════════════════════════════════════════════════════════
    // 🎯 FETCH TRANSACTIONS (cache-first, 2min)
    // ════════════════════════════════════════════════════════════
    function fetchTransactions(token) {
        var cacheKey = CACHE_KEYS.TX + token;
        var cached = sessionCacheRead(cacheKey, TTL.TX);
        if (cached) {
            renderTransactions(cached);
            return Promise.resolve();
        }

        return dedupeFetch(SUPABASE_URL + '/functions/v1/get-transactions-api', {
            method: 'GET',
            headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }
        })
        .then(function(res) {
            if (res.status === 401 || res.status === 403) {
                handleAuthError(res.status);
                return null;
            }
            return res.json();
        })
        .then(function(data) {
            if (!data) return;
            var txs = (data.success && data.transactions) ? data.transactions : [];
            sessionCacheWrite(cacheKey, txs);
            renderTransactions(txs);
        })
        .catch(function(e) {
            console.warn('Failed to load transactions', e);
            renderTransactions([]);
        });
    }

    // ════════════════════════════════════════════════════════════
    // 🎯 FETCH SUBSCRIPTIONS (cache-first, 5min)
    // ════════════════════════════════════════════════════════════
    function fetchSubscriptions(token) {
        var cacheKey = CACHE_KEYS.SUBS + token;
        var cached = sessionCacheRead(cacheKey, TTL.SUBS);
        if (cached) {
            renderSubscriptions(cached);
            return Promise.resolve();
        }

        return dedupeFetch(SUPABASE_URL + '/functions/v1/get-mysubscribes-api', {
            method: 'GET',
            headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }
        })
        .then(function(res) {
            if (res.status === 401 || res.status === 403) {
                handleAuthError(res.status);
                return null;
            }
            return res.json();
        })
        .then(function(data) {
            if (!data) return;
            var subs = (data.success && data.subscriptions) ? data.subscriptions : [];
            sessionCacheWrite(cacheKey, subs);
            renderSubscriptions(subs);
        })
        .catch(function(e) {
            console.warn('Failed to load subscriptions', e);
            renderSubscriptions([]);
        });
    }

    function loadAccountData(token) {
        fetchTransactions(token);
        fetchSubscriptions(token);
    }

    // ════════════════════════════════════════════════════════════
    // 🎯 VERIFY SESSION (background, only when cache expired)
    // ════════════════════════════════════════════════════════════
    function verifySession(token) {
        var loginCacheKey = CACHE_KEYS.LOGIN + token;

        return dedupeFetch('https://vqmmsqtlszzugdyoyilu.supabase.co/functions/v1/login-checker', {
            method: 'GET',
            headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }
        })
        .then(function(r) {
            if (r.status === 401 || r.status === 403) {
                handleAuthError(r.status);
                return null;
            }
            if (!r.ok) throw new Error('Network fail');
            return r.json();
        })
        .then(function(data) {
            if (!data) return;
            if (!data.valid) {
                clearSession();
                window.location.href = 'login.html';
                return;
            }
            sessionCacheWrite(loginCacheKey, data);
            if (data.user) {
                setUser(data.user);
                renderUserData(data.user);
            }
        })
        .catch(function(err) {
            // Network failed — keep cached session. Backend will reject if token is truly bad.
            console.warn('Auth verify ignored (WebView transition):', err);
        });
    }

    // ════════════════════════════════════════════════════════════
    // 🎯 SESSION CHECK (zero-block, 20-min cache)
    // ════════════════════════════════════════════════════════════
    function checkLogin() {
        var token = getToken();
        if (!token) {
            window.location.href = 'login.html';
            return;
        }
        window._currentToken = token;
        setTokenInAllPlaces(token);

        // Immediate paint from cached user (0ms)
        var cachedUser = null;
        try { cachedUser = JSON.parse(safeGet(localStorage, USER_KEY)); } catch (e) {}
        if (cachedUser) renderUserData(cachedUser);

        var loginCacheKey = CACHE_KEYS.LOGIN + token;
        var loginCached = sessionCacheRead(loginCacheKey, TTL.LOGIN);

        // Load TX/subs immediately (they have their own caches)
        loadAccountData(token);

        if (loginCached && loginCached.valid) {
            // Cache hit within 20 min — NO login-checker call
            if (loginCached.user) {
                setUser(loginCached.user);
                renderUserData(loginCached.user);
            }
            setupVisibilityRefresh(token, loginCacheKey);
            return;
        }

        // Cache missing/expired — verify in background while showing app
        verifySession(token);
        setupVisibilityRefresh(token, loginCacheKey);
    }

    // ════════════════════════════════════════════════════════════
    // 🎯 VISIBILITY REFRESH (only when cache is 5-20min old)
    // ════════════════════════════════════════════════════════════
    var visibilityBound = false;
    function setupVisibilityRefresh(token, loginCacheKey) {
        if (visibilityBound) return;
        visibilityBound = true;

        document.addEventListener('visibilitychange', function() {
            if (document.visibilityState !== 'visible') return;
            var raw = sessionCacheReadRaw(loginCacheKey);
            if (!raw || !raw.ts) return;
            var age = Date.now() - raw.ts;
            if (age > 5 * 60 * 1000 && age < TTL.LOGIN) {
                // Stale-ish but still within 20min — refresh silently.
                verifySession(token);
            }
        });
    }

    // ════════════════════════════════════════════════════════════
    // 🎯 LOGOUT
    // ════════════════════════════════════════════════════════════
    function logout() {
        clearSession();
        clearAllAppCaches();
        window.location.href = 'non.html';
    }

    // ════════════════════════════════════════════════════════════
    // 🎯 LOCAL SEARCH (films cache, API fallback)
    // ════════════════════════════════════════════════════════════
    function searchFilmsLocal(query) {
        var cached = localStorageCacheRead(FILMS_CACHE_KEY, FILMS_TTL);
        if (!cached || !cached.movies) return [];
        var q = query.toLowerCase();
        return cached.movies.filter(function(m) {
            return (m.title && m.title.toLowerCase().indexOf(q) !== -1) ||
                   (m.translator_name && m.translator_name.toLowerCase().indexOf(q) !== -1);
        });
    }

    function initSearch() {
        var searchNavBtn = document.getElementById('searchNavBtn');
        var searchSubheader = document.getElementById('searchSubheader');
        var searchInput = document.getElementById('searchInput');
        var searchResults = document.getElementById('searchResults');
        var clearBtn = document.getElementById('clearSearchBtn');
        if (!searchNavBtn || searchNavBtn._bound) return;
        searchNavBtn._bound = true;

        var debounceTimer = null;

        function renderResults(movies) {
            if (!movies || movies.length === 0) return false;
            searchResults.innerHTML = movies.map(function(m) {
                return '<div class="result-item" data-id="' + escHTML(m.id) + '">' + escHTML(m.title) + '</div>';
            }).join('');
            searchResults.classList.add('visible');
            return true;
        }

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

        if (clearBtn) {
            clearBtn.addEventListener('click', function(e) {
                e.preventDefault();
                searchInput.value = '';
                searchResults.classList.remove('visible');
                searchResults.innerHTML = '';
                searchInput.focus();
            });
        }

        searchInput.addEventListener('input', function() {
            var query = this.value.toLowerCase().trim();
            if (!query) {
                searchResults.classList.remove('visible');
                searchResults.innerHTML = '';
                return;
            }

            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(function() {
                // 1. Local cache search — FREE, instant
                var localResults = searchFilmsLocal(query);

                // Enough local results → skip API entirely
                if (localResults.length >= 5) {
                    renderResults(localResults);
                    return;
                }

                // Show local results immediately (if any)
                if (localResults.length > 0) renderResults(localResults);

                // 2. API fallback (only when needed)
                dedupeFetch(SUPABASE_URL + '/functions/v1/films-api?limit=10&search=' + encodeURIComponent(query))
                .then(function(r) { return r.json(); })
                .then(function(data) {
                    var movies = data.movies || [];
                    if (movies.length > 0) {
                        renderResults(movies);
                    } else if (localResults.length === 0) {
                        searchResults.innerHTML = '<div class="result-item">No movies found</div>';
                        searchResults.classList.add('visible');
                    }
                })
                .catch(function() {
                    if (localResults.length === 0) {
                        searchResults.innerHTML = '<div class="result-item">Search failed</div>';
                        searchResults.classList.add('visible');
                    }
                });
            }, 300);
        });

        searchResults.addEventListener('click', function(e) {
            var item = e.target.closest('.result-item');
            if (!item || !item.dataset.id) return;
            window.location.href = 'view-film.html?id=' + item.dataset.id;
            searchSubheader.classList.remove('open');
            searchResults.classList.remove('visible');
        });

        document.addEventListener('click', function(e) {
            if (!searchSubheader.contains(e.target) && !searchNavBtn.contains(e.target)) {
                searchResults.classList.remove('visible');
            }
        });
    }

    // ════════════════════════════════════════════════════════════
    // 🎯 TOAST / COPY / SCROLL / SECURITY
    // ════════════════════════════════════════════════════════════
    function showToast(msg, isError) {
        var toast = document.getElementById('toast');
        var toastMsg = document.getElementById('toastMsg');
        if (!toast) return;
        if (toastMsg) toastMsg.textContent = msg;
        toast.style.border = isError ? '1px solid #ff6b6b' : 'none';
        toast.classList.add('visible');
        setTimeout(function() { toast.classList.remove('visible'); }, 3000);
    }

    function initCopyUserId() {
        var copyBtn = document.getElementById('copyUserIdBtn');
        var userIdEl = document.getElementById('accountUserId');
        if (!copyBtn || !userIdEl || copyBtn._bound) return;
        copyBtn._bound = true;
        copyBtn.addEventListener('click', function() {
            var userId = userIdEl.textContent.trim();
            if (!userId || userId === '...') return;
            if (navigator.clipboard) {
                navigator.clipboard.writeText(userId).then(function() {
                    showToast('User ID copied!', false);
                }).catch(function() {});
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

    function initScrollEffects() {
        var header = document.getElementById('mainHeader');
        if (!header) return;
        var lastScrollY = 0, ticking = false, HIDE_AFTER = 100, isHidden = false;

        function updateScroll() {
            var y = window.pageYOffset || document.documentElement.scrollTop || 0;
            var delta = y - lastScrollY;

            if (y > 10) header.classList.add('scrolled');
            else header.classList.remove('scrolled');

            if (Math.abs(delta) < 4) { ticking = false; return; }

            if (y < HIDE_AFTER) {
                if (isHidden) { header.classList.remove('hidden'); isHidden = false; }
            } else if (delta > 6 && !isHidden) {
                header.classList.add('hidden'); isHidden = true;
            } else if (delta < -6 && isHidden) {
                header.classList.remove('hidden'); isHidden = false;
            }
            lastScrollY = y < 0 ? 0 : y;
            ticking = false;
        }

        window.addEventListener('scroll', function() {
            if (!ticking) { window.requestAnimationFrame(updateScroll); ticking = true; }
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

    // ════════════════════════════════════════════════════════════
    // 🎯 INIT
    // ════════════════════════════════════════════════════════════
    function init() {
        checkLogin();

        initSearch();
        initCopyUserId();
        initScrollEffects();
        initSecurity();

        var logoutBtn = document.getElementById('logoutBtn');
        if (logoutBtn && !logoutBtn._bound) {
            logoutBtn._bound = true;
            logoutBtn.addEventListener('click', function(e) {
                e.preventDefault();
                logout();
            });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
