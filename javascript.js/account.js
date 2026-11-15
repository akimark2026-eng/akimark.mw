// account.js (v15 — Pro High-End + Spinner Animations + Smart Subscribe Flow)
// v15 upgrades:
//  - Added Uiverse Spinner animations for loading states.
//  - Added "Subscribe Now" button persistently under Subscriptions.
//  - Added get-plans-api fetch logic with a beautiful modal UI.
//  - Preserved all caching, error handling, and SWR logic from v14.

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
        SUBSCRIPTIONS: SUPABASE_URL + '/functions/v1/get-mysubscribes-api',
        PLANS:         SUPABASE_URL + '/functions/v1/get-plans-api'
    };

    // ════════════════════════════════════════════════════════════
    // 🎯 CACHE CONFIG
    // ════════════════════════════════════════════════════════════
    var CACHE_KEYS = {
        PROFILE: 'akmark_cache_profile_', // per token
        TX:      'akmark_cache_tx_',      // per token
        SUBS:    'akmark_cache_subs_',    // per token
        PLANS:   'akmark_cache_plans'     // global (hafu)
    };
    var TTL = {
        PROFILE: 5 * 60 * 1000,  // 5 min
        TX:      2 * 60 * 1000,  // 2 min
        SUBS:    5 * 60 * 1000,  // 5 min
        PLANS:   10 * 60 * 1000  // 10 min
    };
    var SWR_THRESHOLD = 60 * 1000; // 1 min — refresh in background if cache is older

    // ════════════════════════════════════════════════════════════
    // 🎯 SPINNER HELPER (Uiverse)
    // ════════════════════════════════════════════════════════════
    function getSpinnerHTML() {
        var blades = '';
        for (var i = 0; i < 12; i++) {
            blades += '<div class="spinner-blade"></div>';
        }
        return '<div class="spinner" style="display:inline-block; margin: 20px auto;"><div class="spinner-blade"></div><div class="spinner-blade"></div><div class="spinner-blade"></div><div class="spinner-blade"></div><div class="spinner-blade"></div><div class="spinner-blade"></div><div class="spinner-blade"></div><div class="spinner-blade"></div><div class="spinner-blade"></div><div class="spinner-blade"></div><div class="spinner-blade"></div><div class="spinner-blade"></div></div>';
    }

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

    function cacheRead(key, ttl, useSession) {
        var storage = useSession ? sessionStorage : localStorage;
        var raw = safeGet(storage, key);
        if (!raw) return null;
        try {
            var p = JSON.parse(raw);
            var age = Date.now() - p.ts;
            if (age > ttl) return null;
            return { data: p.data, age: age };
        } catch (e) { return null; }
    }
    function cacheWrite(key, data, useSession) {
        var storage = useSession ? sessionStorage : localStorage;
        safeSet(storage, key, JSON.stringify({ ts: Date.now(), data: data }));
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
        safeRemove(localStorage, CACHE_KEYS.PLANS);

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
        
        if (!container || !countEl || !seeAllBtn || !modalBody) return;

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
            var iconClass = isPos ? 'icon-in' : 'icon-out';
            var iconSvg = isPos ? '<svg viewBox="0 0 24 24"><path d="M12 5v14M19 12l-7 7-7-7"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
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
    // 🎯 RENDER SUBSCRIPTIONS (+ SUBSCRIBE NOW BUTTON)
    // ════════════════════════════════════════════════════════════
    function renderSubscriptions(subs) {
        var container = document.getElementById('inlineSubsContainer');
        var countEl = document.getElementById('subsCount');
        var seeAllBtn = document.getElementById('seeAllSubsBtn');
        var modalBody = document.getElementById('modalSubsBody');
        
        if (!container || !countEl || !seeAllBtn || !modalBody) return;

        countEl.textContent = subs.length;

        // ⚡ THE SUBSCRIBE NOW BUTTON (Always visible)
        var subscribeBtnHTML = '<button class="btn-subscribe-now" onclick="window.openPlansModal()">' +
            '<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 11h-4v4h-2v-4H7v-2h4V7h2v4h4v2z"/></svg>' +
            'Subscribe Now' +
        '</button>';

        if (subs.length === 0) {
            container.innerHTML = '<div class="empty-state-box"><svg viewBox="0 0 24 24"><path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"/></svg><span>No active subscriptions</span></div>' + subscribeBtnHTML;
            seeAllBtn.style.display = 'none';
            return;
        }

        function createSubHTML(sub) {
            var iconSvg = '<svg viewBox="0 0 24 24"><path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"/></svg>';
            var amountText = sub.subscriptions_amount ? ' • ' + formatPrice(sub.subscriptions_amount) : '';
            var displayName = sub.admin_name ? (sub.admin_name + ' - ' + (sub.plan_name || 'Premium')) : (sub.plan_name || 'Premium Plan');

            return '<div class="data-item">' +
                '<div style="display:flex; align-items:center;">' +
                    '<div class="data-icon-wrap icon-sub">' + iconSvg + '</div>' +
                    '<div class="data-info">' +
                        '<div class="data-name">' + escHTML(displayName) + '</div>' +
                        '<div class="data-status">Active' + amountText + '</div>' +
                    '</div>' +
                '</div>' +
                '<div class="data-date" style="text-align:right;">Expires:<br><span style="color:#fff; font-weight:600;">' + formatDate(sub.expiry_date) + '</span></div>' +
            '</div>';
        }

        // Render top 3 inline + Subscribe Button
        container.innerHTML = subs.slice(0, 3).map(createSubHTML).join('') + subscribeBtnHTML;

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
    // 🎯 FETCH: USER PROFILE (login-checker)
    // ════════════════════════════════════════════════════════════
    function fetchUserProfile(token, force) {
        var cacheKey = CACHE_KEYS.PROFILE + token;
        
        if (!force) {
            var cached = cacheRead(cacheKey, TTL.PROFILE, true);
            if (cached) {
                setUser(cached.data.user);
                renderUserData(cached.data.user);
                if (cached.age > SWR_THRESHOLD) fetchProfileFresh(token, cacheKey);
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
                cacheWrite(cacheKey, data, true);
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
    // 🎯 FETCH: TRANSACTIONS (Spinner + Debug Mode)
    // ════════════════════════════════════════════════════════════
    function fetchTransactions(token, force) {
        var cacheKey = CACHE_KEYS.TX + token;
        if (!force) {
            var cached = cacheRead(cacheKey, TTL.TX, true);
            if (cached) {
                renderTransactions(cached.data);
                if (cached.age > SWR_THRESHOLD) fetchTransactionsFresh(token, cacheKey);
                return Promise.resolve(cached.data);
            }
        }
        return fetchTransactionsFresh(token, cacheKey);
    }

    function fetchTransactionsFresh(token, cacheKey) {
        var container = document.getElementById('inlineTxContainer');
        var user = getUserFromCache();
        var userId = user && user.user_id ? user.user_id : '';

        if (container) {
            container.innerHTML = getSpinnerHTML(); // Show spinner
        }

        var url = ENDPOINTS.TRANSACTIONS + (userId ? '?user_id=' + encodeURIComponent(userId) : '');

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
            var txs = (data.success && data.transactions) ? data.transactions : [];
            renderTransactions(txs);
            cacheWrite(cacheKey, txs, true);
            return txs;
        })
        .catch(function(e) {
            console.error('[account.js] TX fetch failed:', e);
            if (container) container.innerHTML = '<div style="text-align:center; padding:20px; color:#ff6b6b; font-size:12px;">Error: ' + e.message + '</div>';
            return null;
        });
    }

    // ════════════════════════════════════════════════════════════
    // 🎯 FETCH: SUBSCRIPTIONS (Spinner + Debug Mode)
    // ════════════════════════════════════════════════════════════
    function fetchSubscriptions(token, force) {
        var cacheKey = CACHE_KEYS.SUBS + token;
        if (!force) {
            var cached = cacheRead(cacheKey, TTL.SUBS, true);
            if (cached) {
                renderSubscriptions(cached.data);
                if (cached.age > SWR_THRESHOLD) fetchSubscriptionsFresh(token, cacheKey);
                return Promise.resolve(cached.data);
            }
        }
        return fetchSubscriptionsFresh(token, cacheKey);
    }

    function fetchSubscriptionsFresh(token, cacheKey) {
        var container = document.getElementById('inlineSubsContainer');
        var user = getUserFromCache();
        var userId = user && user.user_id ? user.user_id : '';

        if (container) {
            container.innerHTML = getSpinnerHTML(); // Show spinner
        }

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
            cacheWrite(cacheKey, subs, true);
            return subs;
        })
        .catch(function(e) {
            console.error('[account.js] Subs fetch failed:', e);
            if (container) container.innerHTML = '<div style="text-align:center; padding:20px; color:#ff6b6b; font-size:12px;">Error: ' + e.message + '</div>';
            return null;
        });
    }

    // ════════════════════════════════════════════════════════════
    // 🎯 FETCH: PLANS (For Subscribe Now)
    // ════════════════════════════════════════════════════════════
    window.openPlansModal = function() {
        var modal = document.getElementById('modalPlans');
        var body = document.getElementById('modalPlansBody');
        if (!modal || !body) return;

        modal.classList.add('open');
        
        // Yang'anani Cache (10 min TTL)
        var cached = cacheRead(CACHE_KEYS.PLANS, TTL.PLANS, false);
        if (cached && cached.data) {
            renderPlans(cached.data, body);
            return;
        }

        body.innerHTML = getSpinnerHTML(); // Show spinner

        dedupeFetch(ENDPOINTS.PLANS, { method: 'GET' })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (data.success && data.plans) {
                cacheWrite(CACHE_KEYS.PLANS, data.plans, false);
                renderPlans(data.plans, body);
            } else {
                body.innerHTML = '<div style="text-align:center; color:#aaa; padding:20px;">No plans available.</div>';
            }
        })
        .catch(function(e) {
            body.innerHTML = '<div style="text-align:center; color:#ff6b6b; padding:20px;">Error: ' + e.message + '</div>';
        });
    };

    function renderPlans(plans, container) {
        if (!plans || plans.length === 0) {
            container.innerHTML = '<div style="text-align:center; color:#aaa; padding:20px;">No plans available.</div>';
            return;
        }

        var html = '';
        plans.forEach(function(p) {
            html += '<div class="data-item" style="cursor:pointer;" onclick="window.goToSubscribe(\'' + p.admin_id + '\', \'' + p.id + '\')">' +
                '<div style="display:flex; align-items:center;">' +
                    '<div class="data-icon-wrap icon-sub"><svg viewBox="0 0 24 24"><path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"/></svg></div>' +
                    '<div class="data-info">' +
                        '<div class="data-name">' + escHTML(p.admin_name) + '</div>' +
                        '<div class="data-date" style="color:var(--gold);">' + escHTML(p.plan_name) + ' (' + p.duration_days + ' Days)</div>' +
                    '</div>' +
                '</div>' +
                '<div class="data-amount positive" style="color:var(--gold);">' + formatPrice(p.price) + '</div>' +
            '</div>';
        });
        container.innerHTML = html;
    }

    window.goToSubscribe = function(adminId, planId) {
        // Route to your subscribe/payment page
        window.location.href = 'subscribe.html?admin_id=' + adminId + '&plan_id=' + planId;
    };

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

        var cachedUser = getUserFromCache();
        if (cachedUser) renderUserData(cachedUser);

        loadAccountData(token, false);
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
    // 🎯 SEARCH / SECURITY / TOAST (Unchanged from v14)
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

    function initSearch() {
        // Search code remains unchanged... (insert your existing initSearch code here)
        // For brevity, I'm omitting the huge search block as it's not part of this upgrade, 
        // but in your full file, keep the initSearch function exactly as it was in v14.
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
