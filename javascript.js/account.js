// account.js (v14 — Pro High-End Cache + Robust UI States + Debug Mode + High-End Icons)
// v14 upgrades:
//  - Merged the exact error display logic from user's request.
//  - Sends user_id in the URL for blazing fast backend queries.
//  - High-End Icons for Transactions and Subscriptions.
//  - All v13 logic preserved (Smart SWR, 5min Profile cache, 2min TX cache, 5min Subs cache).
//  - CORS Safe (No Content-Type on GET).

(function() {
    'use strict';

    var TOKEN_KEY = 'akmark_token';
    var USER_KEY = 'akmark_user';

    // 🔧 SUPABASE_URL FALLBACK
    var SUPABASE_URL = window.SUPABASE_URL || 'https://vqmmsqtlszzugdyoyilu.supabase.co';

    // ════════════════════════════════════════════════════════════
    // 🎯 ENDPOINTS
    // ════════════════════════════════════════════════════════════
    var ENDPOINTS = {
        USER_PROFILE:  SUPABASE_URL + '/functions/v1/login-checker',
        TRANSACTIONS:  SUPABASE_URL + '/functions/v1/get-transactions-api',
        SUBSCRIPTIONS: SUPABASE_URL + '/functions/v1/get-mysubscribes-api'
    };

    // ════════════════════════════════════════════════════════════
    // 🎯 CACHE CONFIG
    // ════════════════════════════════════════════════════════════
    var CACHE_KEYS = {
        PROFILE: 'akmark_cache_profile_', // per token
        TX:      'akmark_cache_tx_',      // per token
        SUBS:    'akmark_cache_subs_'     // per token
    };
    var TTL = {
        PROFILE: 5 * 60 * 1000,  // 5 min
        TX:      2 * 60 * 1000,  // 2 min
        SUBS:    5 * 60 * 1000   // 5 min
    };
    var SWR_THRESHOLD = 60 * 1000; // 1 min — refresh in background if cache is older

    // ════════════════════════════════════════════════════════════
    // 🎯 COOKIE HELPERS
    // ════════════════════════════════════════════════════════════
    function setCookie(name, value, days) {
        var expires = "";
        if (days) {
            var d = new Date();
            d.setTime(d.getTime() + (days * 24 * 60 * 60 * 1000));
            expires = "; expires=" + d.toUTCString();
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

    function cacheRead(key, ttl) {
        var raw = safeGet(sessionStorage, key);
        if (!raw) return null;
        try {
            var p = JSON.parse(raw);
            var age = Date.now() - p.ts;
            if (age > ttl) return null;
            return { data: p.data, age: age };
        } catch (e) { return null; }
    }
    function cacheWrite(key, data) {
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

    function getUserFromCache() {
        try { return JSON.parse(safeGet(localStorage, USER_KEY) || 'null'); } catch (e) { return null; }
    }

    function setUser(user) {
        safeSet(localStorage, USER_KEY, JSON.stringify(user));
        setCookie('akmark_user_logged', 'true', 7);
    }

    function clearSession() {
        var token = getToken();
        safeRemove(localStorage, TOKEN_KEY);
        safeRemove(sessionStorage, TOKEN_KEY);
        safeRemove(localStorage, 'akmark_refresh_token');
        safeRemove(sessionStorage, 'akmark_refresh_token');
        safeRemove(localStorage, USER_KEY);
        eraseCookie(TOKEN_KEY);
        eraseCookie('akmark_user_logged');

        if (token) {
            safeRemove(sessionStorage, CACHE_KEYS.PROFILE + token);
            safeRemove(sessionStorage, CACHE_KEYS.TX + token);
            safeRemove(sessionStorage, CACHE_KEYS.SUBS + token);
        }
    }

    function clearAllAppCaches() {
        safeRemove(localStorage, 'akmark_cache_films_v4');
        safeRemove(localStorage, 'akmark_cache_translators_v4');
        safeRemove(localStorage, 'akmark_cache_ads_v1');
        safeRemove(localStorage, 'akmark_cache_trending_v1');
        safeRemove(localStorage, 'akmark_noncache_films_v1');
        safeRemove(localStorage, 'akmark_noncache_translators_v1');
        safeRemove(localStorage, 'akmark_noncache_trending_v1');
        safeRemove(localStorage, 'akmark_cache_lives_v1');

        if (window.AkimarkCache && typeof window.AkimarkCache.clearAll === 'function') {
            try { window.AkimarkCache.clearAll(); } catch (e) {}
        }
        if (window.AkimarkNonCache && typeof window.AkimarkNonCache.clearAll === 'function') {
            try { window.AkimarkNonCache.clearAll(); } catch (e) {}
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
    function formatBalance(balance) {
        return Number(balance || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
        if (walletEl) walletEl.textContent = formatBalance(user.wallet_balance);
        if (coinsEl) coinsEl.textContent = user.coins || 0;
        if (earningsEl) earningsEl.textContent = user.earnings || 0;

        document.body.dataset.userId = user.user_id || '';
    }

    // ════════════════════════════════════════════════════════════
    // 🎯 RENDER TRANSACTIONS (High-End UI)
    // ════════════════════════════════════════════════════════════
    function renderTransactions(txs) {
        var container = document.getElementById('inlineTxContainer');
        var countEl = document.getElementById('transactionsCount');
        var seeAllBtn = document.getElementById('seeAllTxBtn');
        var modalBody = document.getElementById('modalTxBody');
        
        if (!container || !countEl || !seeAllBtn || !modalBody) {
            console.warn('[account.js] ⚠️ Missing HTML elements for Transactions (inlineTxContainer, transactionsCount, seeAllTxBtn, modalTxBody).');
            return;
        }

        countEl.textContent = txs.length;

        if (txs.length === 0) {
            container.innerHTML = '<div class="empty-state-box"><svg viewBox="0 0 24 24"><path d="M7 16V4M7 4L3 8M7 4L11 8M17 8V20M17 20L21 16M17 20L13 16"/></svg><span>No transactions yet</span></div>';
            seeAllBtn.style.display = 'none';
            return;
        }

        function createTxHTML(tx) {
            var amt = Number(tx.amount || 0);
            var isPos = amt > 0;
            var sign = isPos ? '+' : '-';
            var amtClass = isPos ? 'positive' : 'negative';
            
            // High-End Icon logic
            var iconClass = isPos ? 'icon-in' : 'icon-out';
            var iconSvg = isPos 
                ? '<svg viewBox="0 0 24 24"><path d="M12 5v14M19 12l-7 7-7-7"/></svg>' // Arrow Down (Deposit)
                : '<svg viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg>'; // Arrow Up (Purchase)

            var displayAmt = formatPrice(Math.abs(amt));

            return '<div class="data-item">' +
                '<div style="display:flex; align-items:center;">' +
                    '<div class="data-icon-wrap ' + iconClass + '">' + iconSvg + '</div>' +
                    '<div class="data-info">' +
                        '<div class="data-name">' + escHTML(tx.description || tx.type || 'Transaction') + '</div>' +
                        '<div class="data-date">' + formatDate(tx.created_at) + '</div>' +
                    '</div>' +
                '</div>' +
                '<div class="data-amount ' + amtClass + '">' + sign + ' ' + displayAmt + '</div>' +
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
    // 🎯 RENDER SUBSCRIPTIONS (High-End UI)
    // ════════════════════════════════════════════════════════════
    function renderSubscriptions(subs) {
        var container = document.getElementById('inlineSubsContainer');
        var countEl = document.getElementById('subsCount');
        var seeAllBtn = document.getElementById('seeAllSubsBtn');
        var modalBody = document.getElementById('modalSubsBody');
        
        if (!container || !countEl || !seeAllBtn || !modalBody) {
            console.warn('[account.js] ⚠️ Missing HTML elements for Subscriptions (inlineSubsContainer, subsCount, seeAllSubsBtn, modalSubsBody).');
            return;
        }

        countEl.textContent = subs.length;

        if (subs.length === 0) {
            container.innerHTML = '<div class="empty-state-box"><svg viewBox="0 0 24 24"><path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"/></svg><span>No active subscriptions</span></div>';
            seeAllBtn.style.display = 'none';
            return;
        }

        function createSubHTML(sub) {
            var iconSvg = '<svg viewBox="0 0 24 24"><path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"/></svg>';
            var amountText = sub.subscriptions_amount ? ' • ' + formatPrice(sub.subscriptions_amount) : '';

            return '<div class="data-item">' +
                '<div style="display:flex; align-items:center;">' +
                    '<div class="data-icon-wrap icon-sub">' + iconSvg + '</div>' +
                    '<div class="data-info">' +
                        '<div class="data-name">' + escHTML(sub.plan_name || 'Premium Plan') + '</div>' +
                        '<div class="data-status">Active' + amountText + '</div>' +
                    '</div>' +
                '</div>' +
                '<div class="data-date" style="text-align:right;">Expires:<br><span style="color:#fff; font-weight:600;">' + formatDate(sub.expiry_date) + '</span></div>' +
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
    // 🎯 FETCH: USER PROFILE + BALANCE (login-checker)
    // ════════════════════════════════════════════════════════════
    function fetchUserProfile(token, force) {
        var cacheKey = CACHE_KEYS.PROFILE + token;
        
        if (!force) {
            var cached = cacheRead(cacheKey, TTL.PROFILE);
            if (cached) {
                setUser(cached.data.user);
                renderUserData(cached.data.user);
                
                // SWR: If older than 1 min, refresh silently in background
                if (cached.age > SWR_THRESHOLD) {
                    fetchProfileFresh(token, cacheKey);
                }
                return Promise.resolve(cached.data.user);
            }
        }

        return fetchProfileFresh(token, cacheKey);
    }

    function fetchProfileFresh(token, cacheKey) {
        return dedupeFetch(ENDPOINTS.USER_PROFILE, {
            method: 'GET',
            headers: { 'Authorization': 'Bearer ' + token }
        })
        .then(function(res) {
            if (handleAuthError(res.status)) return null;
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
        })
        .then(function(data) {
            if (!data) return null;
            
            if (!data.valid) {
                clearSession();
                window.location.href = 'login.html';
                return null;
            }

            if (data.user) {
                setUser(data.user);
                renderUserData(data.user);
                cacheWrite(cacheKey, data);
                return data.user;
            }
            return null;
        })
        .catch(function(e) {
            console.warn('[account.js] Profile fetch failed:', e);
            return null;
        });
    }

    // ════════════════════════════════════════════════════════════
    // 🎯 FETCH: TRANSACTIONS (Debug Mode + user_id in URL)
    // ════════════════════════════════════════════════════════════
    function fetchTransactions(token, force) {
        var cacheKey = CACHE_KEYS.TX + token;

        if (!force) {
            var cached = cacheRead(cacheKey, TTL.TX);
            if (cached) {
                renderTransactions(cached.data);
                if (cached.age > SWR_THRESHOLD) {
                    fetchTransactionsFresh(token, cacheKey);
                }
                return Promise.resolve(cached.data);
            }
        }

        return fetchTransactionsFresh(token, cacheKey);
    }

    function fetchTransactionsFresh(token, cacheKey) {
        var container = document.getElementById('inlineTxContainer');
        var user = getUserFromCache();
        var userId = user && user.user_id ? user.user_id : '';

        if (container && !cacheRead(cacheKey, TTL.TX)) {
            container.innerHTML = '<div style="text-align:center; padding:20px; color:#aaa;">Loading transactions...</div>';
        }

        // 🔥 Tumizani user_id mu URL
        var url = ENDPOINTS.TRANSACTIONS + (userId ? '?user_id=' + encodeURIComponent(userId) : '');

        return dedupeFetch(url, {
            method: 'GET',
            headers: { 'Authorization': 'Bearer ' + token }
        })
        .then(function(res) {
            if (handleAuthError(res.status)) return null;
            if (!res.ok) throw new Error('HTTP ' + res.status); // Imabweretsa exact error
            return res.json();
        })
        .then(function(data) {
            if (!data) return null;
            var txs = (data.success && data.transactions) ? data.transactions : [];
            renderTransactions(txs);
            cacheWrite(cacheKey, txs);
            return txs;
        })
        .catch(function(e) {
            console.error('[account.js] TX fetch failed:', e);
            // 🔥 Onetsani exact error pa screen
            if (container) container.innerHTML = '<div style="text-align:center; padding:20px; color:#ff6b6b; font-size:12px;">Error: ' + e.message + '</div>';
            return null;
        });
    }

    // ════════════════════════════════════════════════════════════
    // 🎯 FETCH: SUBSCRIPTIONS (Debug Mode + user_id in URL)
    // ════════════════════════════════════════════════════════════
    function fetchSubscriptions(token, force) {
        var cacheKey = CACHE_KEYS.SUBS + token;

        if (!force) {
            var cached = cacheRead(cacheKey, TTL.SUBS);
            if (cached) {
                renderSubscriptions(cached.data);
                if (cached.age > SWR_THRESHOLD) {
                    fetchSubscriptionsFresh(token, cacheKey);
                }
                return Promise.resolve(cached.data);
            }
        }

        return fetchSubscriptionsFresh(token, cacheKey);
    }

    function fetchSubscriptionsFresh(token, cacheKey) {
        var container = document.getElementById('inlineSubsContainer');
        var user = getUserFromCache();
        var userId = user && user.user_id ? user.user_id : '';

        if (container && !cacheRead(cacheKey, TTL.SUBS)) {
            container.innerHTML = '<div style="text-align:center; padding:20px; color:#aaa;">Loading subscriptions...</div>';
        }

        // 🔥 Tumizani user_id mu URL
        var url = ENDPOINTS.SUBSCRIPTIONS + (userId ? '?user_id=' + encodeURIComponent(userId) : '');

        return dedupeFetch(url, {
            method: 'GET',
            headers: { 'Authorization': 'Bearer ' + token }
        })
        .then(function(res) {
            if (handleAuthError(res.status)) return null;
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
        })
        .then(function(data) {
            if (!data) return null;
            var subs = (data.success && data.subscriptions) ? data.subscriptions : [];
            renderSubscriptions(subs);
            cacheWrite(cacheKey, subs);
            return subs;
        })
        .catch(function(e) {
            console.error('[account.js] Subs fetch failed:', e);
            // 🔥 Onetsani exact error pa screen
            if (container) container.innerHTML = '<div style="text-align:center; padding:20px; color:#ff6b6b; font-size:12px;">Error: ' + e.message + '</div>';
            return null;
        });
    }

    // ════════════════════════════════════════════════════════════
    // 🎯 LOAD ALL (Parallel — Cache-First)
    // ════════════════════════════════════════════════════════════
    function loadAccountData(token, force) {
        fetchUserProfile(token, force);
        fetchTransactions(token, force);
        fetchSubscriptions(token, force);
    }

    // ════════════════════════════════════════════════════════════
    // 🎯 SESSION CHECK
    // ════════════════════════════════════════════════════════════
    function checkLogin() {
        var token = getToken();
        if (!token) {
            window.location.href = 'login.html';
            return;
        }
        window._currentToken = token;
        setTokenInAllPlaces(token);

        // Instant paint from cache (0ms)
        var cachedUser = getUserFromCache();
        if (cachedUser) renderUserData(cachedUser);

        // Load all data (cache-first, will fetch if needed)
        loadAccountData(token, false);
        
        // Setup refresh on tab focus
        setupVisibilityRefresh(token);
    }

    // ════════════════════════════════════════════════════════════
    // 🎯 VISIBILITY REFRESH
    // ════════════════════════════════════════════════════════════
    var visibilityBound = false;
    function setupVisibilityRefresh(token) {
        if (visibilityBound) return;
        visibilityBound = true;
        document.addEventListener('visibilitychange', function() {
            if (document.visibilityState !== 'visible') return;
            if (!getToken()) {
                window.location.href = 'login.html';
                return;
            }
            // Will only fetch if cache expired (force=false)
            loadAccountData(token, false);
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
    // 🎯 SEARCH — LOCAL CACHE ONLY
    // ════════════════════════════════════════════════════════════
    function searchFilmsLocal(query) {
        var cached = localStorageCacheRead('akmark_cache_films_v4', 5 * 60 * 1000);
        if (!cached || !cached.movies) {
            return { results: [], hasCache: false };
        }
        var q = query.toLowerCase();
        var results = cached.movies.filter(function(m) {
            return (m.title && m.title.toLowerCase().indexOf(q) !== -1) ||
                   (m.translator_name && m.translator_name.toLowerCase().indexOf(q) !== -1);
        });
        return { results: results, hasCache: true };
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

        function showMessage(msg) {
            searchResults.innerHTML = '<div class="result-item">' + escHTML(msg) + '</div>';
            searchResults.classList.add('visible');
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
                var result = searchFilmsLocal(query);
                if (!result.hasCache) {
                    showMessage('Search unavailable. Visit home page first.');
                    return;
                }
                if (result.results.length === 0) {
                    showMessage('No results');
                    return;
                }
                renderResults(result.results);
            }, 250);
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
    // 🎯 PUBLIC REFRESH + DEBUG API
    // ════════════════════════════════════════════════════════════
    window.AccountRefreshBalance = function() {
        var token = getToken();
        if (!token) return Promise.resolve(null);
        return fetchUserProfile(token, true); // force=true
    };

    window.AccountRefreshAll = function() {
        var token = getToken();
        if (!token) return Promise.resolve();
        loadAccountData(token, true); // force=true
        return Promise.resolve();
    };

    window.AccountDebug = function() {
        var token = getToken();
        var dbg = {
            supabase_url: SUPABASE_URL,
            endpoints: ENDPOINTS,
            profile_cache: cacheRead(CACHE_KEYS.PROFILE + token, 999999999),
            tx_cache: cacheRead(CACHE_KEYS.TX + token, 999999999),
            subs_cache: cacheRead(CACHE_KEYS.SUBS + token, 999999999),
            cachedUser: getUserFromCache(),
            hasToken: !!token
        };
        console.log('[account.js] Debug state:', dbg);
        return dbg;
    };

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
