// account.js (v16 — Pro High-End + Chevron Accordions + Smart Subscribe Flow + Failed Tx UI)
(function() {
    'use strict';

    var TOKEN_KEY = 'akmark_token';
    var USER_KEY = 'akmark_user';
    var SUPABASE_URL = window.SUPABASE_URL || 'https://vqmmsqtlszzugdyoyilu.supabase.co';

    var ENDPOINTS = {
        USER_PROFILE:  SUPABASE_URL + '/functions/v1/login-checker',
        TRANSACTIONS:  SUPABASE_URL + '/functions/v1/get-transactions-api',
        SUBSCRIPTIONS: SUPABASE_URL + '/functions/v1/get-mysubscribes-api',
        PLANS:         SUPABASE_URL + '/functions/v1/get-plans-api',
        SUBS_API:      SUPABASE_URL + '/functions/v1/subs-api'
    };

    var CACHE_KEYS = {
        PROFILE: 'akmark_cache_profile_',
        TX:      'akmark_cache_tx_',
        SUBS:    'akmark_cache_subs_',
        PLANS:   'akmark_cache_plans'
    };
    var TTL = {
        PROFILE: 5 * 60 * 1000,
        TX:      2 * 60 * 1000,
        SUBS:    5 * 60 * 1000,
        PLANS:   10 * 60 * 1000
    };
    var SWR_THRESHOLD = 60 * 1000;

    // ════════════════════════════════════════════════════════════
    // 🎯 ACCORDION LOGIC
    // ════════════════════════════════════════════════════════════
    window.toggleSection = function(contentId, headerEl) {
        var content = document.getElementById(contentId);
        if (!content) return;
        
        var isOpen = content.classList.contains('open');
        
        if (isOpen) {
            content.classList.remove('open');
            headerEl.classList.remove('active');
        } else {
            content.classList.add('open');
            headerEl.classList.add('active');
        }
    };

    // ════════════════════════════════════════════════════════════
    // 🎯 SPINNER HELPER (Smaller)
    // ════════════════════════════════════════════════════════════
    function getSpinnerHTML() {
        var blades = '';
        for (var i = 0; i < 12; i++) blades += '<div class="spinner-blade"></div>';
        return '<div class="spinner-container"><div class="spinner">' + blades + '</div></div>';
    }

    // ════════════════════════════════════════════════════════════
    // 🎯 COOKIE & STORAGE
    // ════════════════════════════════════════════════════════════
    function setCookie(name, value, days) { var expires = ""; if (days) { var d = new Date(); d.setTime(d.getTime() + (days * 24 * 60 * 60 * 1000)); expires = "; expires=" + d.toUTCString(); } document.cookie = name + "=" + (value || "") + expires + "; path=/; SameSite=Lax"; }
    function getCookie(name) { var nameEQ = name + "="; var ca = document.cookie.split(';'); for (var i = 0; i < ca.length; i++) { var c = ca[i]; while (c.charAt(0) == ' ') c = c.substring(1, c.length); if (c.indexOf(nameEQ) == 0) return c.substring(nameEQ.length, c.length); } return null; }
    function eraseCookie(name) { document.cookie = name + '=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT;'; }

    function safeGet(s, k) { try { return s.getItem(k); } catch (e) { return null; } }
    function safeSet(s, k, v) { try { s.setItem(k, v); } catch (e) {} }
    function safeRemove(s, k) { try { s.removeItem(k); } catch (e) {} }

    function cacheRead(key, ttl, useSession) {
        var storage = useSession ? sessionStorage : localStorage;
        var raw = safeGet(storage, key);
        if (!raw) return null;
        try { var p = JSON.parse(raw); var age = Date.now() - p.ts; if (age > ttl) return null; return { data: p.data, age: age }; } catch (e) { return null; }
    }
    function cacheWrite(key, data, useSession) {
        var storage = useSession ? sessionStorage : localStorage;
        safeSet(storage, key, JSON.stringify({ ts: Date.now(), data: data }));
    }

    // ════════════════════════════════════════════════════════════
    // 🎯 TOKEN & USER
    // ════════════════════════════════════════════════════════════
    function getToken() {
        var token = safeGet(localStorage, TOKEN_KEY);
        if (!token) token = safeGet(sessionStorage, TOKEN_KEY);
        if (!token) token = getCookie(TOKEN_KEY);
        if (!token || token === 'null' || token === 'undefined') return null;
        try { var parsed = JSON.parse(token); if (parsed && parsed.access_token) return parsed.access_token; if (typeof parsed === 'string') return parsed; } catch (e) {}
        return String(token).replace(/^["']|["']$/g, '').trim();
    }
    function setTokenInAllPlaces(token) { safeSet(localStorage, TOKEN_KEY, token); safeSet(sessionStorage, TOKEN_KEY, token); setCookie(TOKEN_KEY, token, 7); }
    function getUserFromCache() { try { return JSON.parse(safeGet(localStorage, USER_KEY) || 'null'); } catch (e) { return null; } }
    function setUser(user) { safeSet(localStorage, USER_KEY, JSON.stringify(user)); setCookie('akmark_user_logged', 'true', 7); }
    
    function clearSession() {
        var token = getToken();
        safeRemove(localStorage, TOKEN_KEY); safeRemove(sessionStorage, TOKEN_KEY);
        safeRemove(localStorage, 'akmark_refresh_token'); safeRemove(sessionStorage, 'akmark_refresh_token');
        safeRemove(localStorage, USER_KEY); eraseCookie(TOKEN_KEY); eraseCookie('akmark_user_logged');
        if (token) {
            safeRemove(sessionStorage, CACHE_KEYS.PROFILE + token);
            safeRemove(sessionStorage, CACHE_KEYS.TX + token);
            safeRemove(sessionStorage, CACHE_KEYS.SUBS + token);
        }
    }
    function clearAllAppCaches() {
        safeRemove(localStorage, 'akmark_cache_films_v4'); safeRemove(localStorage, 'akmark_cache_translators_v4');
        safeRemove(localStorage, 'akmark_cache_ads_v1'); safeRemove(localStorage, 'akmark_cache_trending_v1');
        safeRemove(localStorage, 'akmark_noncache_films_v1'); safeRemove(localStorage, 'akmark_noncache_translators_v1');
        safeRemove(localStorage, 'akmark_noncache_trending_v1'); safeRemove(localStorage, 'akmark_cache_lives_v1');
        safeRemove(localStorage, CACHE_KEYS.PLANS);
        if (window.AkimarkCache && typeof window.AkimarkCache.clearAll === 'function') { try { window.AkimarkCache.clearAll(); } catch (e) {} }
        if (window.AkimarkNonCache && typeof window.AkimarkNonCache.clearAll === 'function') { try { window.AkimarkNonCache.clearAll(); } catch (e) {} }
    }

    function handleAuthError(status) {
        if (status === 401 || status === 403) { clearSession(); window.location.href = 'login.html'; return true; }
        return false;
    }

    var inflight = {};
    function dedupeFetch(url, options) {
        var key = url + '|' + (options && options.headers ? JSON.stringify(options.headers) : '');
        if (inflight[key]) return inflight[key];
        var p = fetch(url, options).finally(function() { delete inflight[key]; });
        inflight[key] = p; return p;
    }
    function escHTML(str) { return String(str == null ? '' : str).replace(/[&<>"']/g, function(c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    function formatPrice(price) { return 'MK ' + Number(price || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
    function formatDate(isoString) { if (!isoString) return 'N/A'; var d = new Date(isoString); return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }); }
    function formatBalance(balance) { return Number(balance || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

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
    }

    // ════════════════════════════════════════════════════════════
    // 🎯 RENDER TRANSACTIONS (With Failed UI)
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
            seeAllBtn.style.display = 'none'; return;
        }

        function createTxHTML(tx) {
            var amt = Number(tx.amount || 0);
            var isPos = amt > 0;
            var isFailed = tx.status === 'failed';
            
            var sign = isPos && !isFailed ? '+' : '-';
            var amtClass = isPos && !isFailed ? 'positive' : 'negative';
            var iconClass = isFailed ? 'icon-failed' : (isPos ? 'icon-in' : 'icon-out');
            
            // Icons: Green Check, Red X, or Arrow
            var iconSvg = '';
            if (isFailed) {
                iconSvg = '<svg viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>'; // X
            } else if (isPos) {
                iconSvg = '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>'; // Check
            } else {
                iconSvg = '<svg viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg>'; // Arrow Up
            }

            var displayAmt = formatPrice(Math.abs(amt));
            var amountStyle = isFailed ? 'failed-amount' : '';

            return '<div class="data-item">' +
                '<div style="display:flex; align-items:center;">' +
                    '<div class="data-icon-wrap ' + iconClass + '">' + iconSvg + '</div>' +
                    '<div class="data-info">' +
                        '<div class="data-name">' + escHTML(tx.description) + '</div>' +
                        '<div class="data-date">' + formatDate(tx.created_at) + '</div>' +
                    '</div>' +
                '</div>' +
                '<div class="data-amount ' + (isFailed ? amountStyle : amtClass) + '">' + sign + ' ' + displayAmt + '</div>' +
            '</div>';
        }

        container.innerHTML = txs.slice(0, 3).map(createTxHTML).join('');
        if (txs.length > 3) {
            seeAllBtn.style.display = 'block';
            seeAllBtn.onclick = function(e) { e.stopPropagation(); modalBody.innerHTML = txs.map(createTxHTML).join(''); var modal = document.getElementById('modalTx'); if (modal) modal.classList.add('open'); };
        } else { seeAllBtn.style.display = 'none'; }
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
        var subscribeBtnHTML = '<button class="btn-subscribe-now" onclick="window.openPlansModal()"><svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 11h-4v4h-2v-4H7v-2h4V7h2v4h4v2z"/></svg>Subscribe Now</button>';

        if (subs.length === 0) {
            container.innerHTML = '<div class="empty-state-box"><svg viewBox="0 0 24 24"><path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"/></svg><span>No active subscriptions</span></div>' + subscribeBtnHTML;
            seeAllBtn.style.display = 'none'; return;
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

        container.innerHTML = subs.slice(0, 3).map(createSubHTML).join('') + subscribeBtnHTML;
        if (subs.length > 3) {
            seeAllBtn.style.display = 'block';
            seeAllBtn.onclick = function(e) { e.stopPropagation(); modalBody.innerHTML = subs.map(createSubHTML).join(''); var modal = document.getElementById('modalSubs'); if (modal) modal.classList.add('open'); };
        } else { seeAllBtn.style.display = 'none'; }
    }

    // ════════════════════════════════════════════════════════════
    // 🎯 FETCH LOGIC
    // ════════════════════════════════════════════════════════════
    function fetchUserProfile(token, force) {
        var cacheKey = CACHE_KEYS.PROFILE + token;
        if (!force) { var cached = cacheRead(cacheKey, TTL.PROFILE, true); if (cached) { setUser(cached.data.user); renderUserData(cached.data.user); if (cached.age > SWR_THRESHOLD) fetchProfileFresh(token, cacheKey); return Promise.resolve(cached.data.user); } }
        return fetchProfileFresh(token, cacheKey);
    }
    function fetchProfileFresh(token, cacheKey) {
        return dedupeFetch(ENDPOINTS.USER_PROFILE, { method: 'GET', headers: { 'Authorization': 'Bearer ' + token } })
        .then(function(res) { if (handleAuthError(res.status)) return null; if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
        .then(function(data) {
            if (!data) return null;
            if (!data.valid) { clearSession(); window.location.href = 'login.html'; return null; }
            if (data.user) { setUser(data.user); renderUserData(data.user); cacheWrite(cacheKey, data, true); return data.user; }
            return null;
        }).catch(function(e) { console.warn('[account.js] Profile fetch failed:', e); return null; });
    }

    function fetchTransactions(token, force) {
        var cacheKey = CACHE_KEYS.TX + token;
        if (!force) { var cached = cacheRead(cacheKey, TTL.TX, true); if (cached) { renderTransactions(cached.data); if (cached.age > SWR_THRESHOLD) fetchTransactionsFresh(token, cacheKey); return Promise.resolve(cached.data); } }
        return fetchTransactionsFresh(token, cacheKey);
    }
    function fetchTransactionsFresh(token, cacheKey) {
        var container = document.getElementById('inlineTxContainer');
        var user = getUserFromCache();
        var userId = user && user.user_id ? user.user_id : '';
        if (container) container.innerHTML = getSpinnerHTML();
        var url = ENDPOINTS.TRANSACTIONS + (userId ? '?user_id=' + encodeURIComponent(userId) : '');
        return dedupeFetch(url, { method: 'GET', headers: { 'Authorization': 'Bearer ' + token } })
        .then(function(res) { if (handleAuthError(res.status)) return null; if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
        .then(function(data) {
            if (!data) return null;
            var txs = (data.success && data.transactions) ? data.transactions : [];
            renderTransactions(txs); cacheWrite(cacheKey, txs, true); return txs;
        }).catch(function(e) { if (container) container.innerHTML = '<div style="text-align:center; padding:20px; color:#ff6b6b; font-size:12px;">Error: ' + e.message + '</div>'; return null; });
    }

    function fetchSubscriptions(token, force) {
        var cacheKey = CACHE_KEYS.SUBS + token;
        if (!force) { var cached = cacheRead(cacheKey, TTL.SUBS, true); if (cached) { renderSubscriptions(cached.data); if (cached.age > SWR_THRESHOLD) fetchSubscriptionsFresh(token, cacheKey); return Promise.resolve(cached.data); } }
        return fetchSubscriptionsFresh(token, cacheKey);
    }
    function fetchSubscriptionsFresh(token, cacheKey) {
        var container = document.getElementById('inlineSubsContainer');
        var user = getUserFromCache();
        var userId = user && user.user_id ? user.user_id : '';
        if (container) container.innerHTML = getSpinnerHTML();
        var url = ENDPOINTS.SUBSCRIPTIONS + (userId ? '?user_id=' + encodeURIComponent(userId) : '');
        return dedupeFetch(url, { method: 'GET', headers: { 'Authorization': 'Bearer ' + token } })
        .then(function(res) { if (handleAuthError(res.status)) return null; if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
        .then(function(data) {
            if (!data) return null;
            var subs = (data.success && data.subscriptions) ? data.subscriptions : [];
            renderSubscriptions(subs); cacheWrite(cacheKey, subs, true); return subs;
        }).catch(function(e) { if (container) container.innerHTML = '<div style="text-align:center; padding:20px; color:#ff6b6b; font-size:12px;">Error: ' + e.message + '</div>'; return null; });
    }

    // ════════════════════════════════════════════════════════════
    // 🎯 SUBSCRIBE FLOW (Modal)
    // ════════════════════════════════════════════════════════════
    var currentPlans = [];
    var selectedAdmin = null;
    var selectedPlan = null;

    window.openPlansModal = function() {
        var modal = document.getElementById('modalPlans');
        var body = document.getElementById('modalPlansBody');
        var title = document.getElementById('modalPlansTitle');
        if (!modal || !body) return;
        
        modal.classList.add('open');
        title.textContent = 'Choose an Admin';
        selectedAdmin = null; selectedPlan = null;
        
        var cached = cacheRead(CACHE_KEYS.PLANS, TTL.PLANS, false);
        if (cached && cached.data) {
            currentPlans = cached.data;
            renderAdmins(currentPlans, body);
            return;
        }
        
        body.innerHTML = getSpinnerHTML();
        dedupeFetch(ENDPOINTS.PLANS, { method: 'GET' })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (data.success && data.plans) {
                currentPlans = data.plans;
                cacheWrite(CACHE_KEYS.PLANS, currentPlans, false);
                renderAdmins(currentPlans, body);
            } else {
                body.innerHTML = '<div style="text-align:center; color:#aaa; padding:20px;">No admins available.</div>';
            }
        }).catch(function(e) {
            body.innerHTML = '<div style="text-align:center; color:#ff6b6b; padding:20px;">Error: ' + e.message + '</div>';
        });
    };

    function renderAdmins(plans, container) {
        // Phatikizani ma Plans kuti mupeze ma Admins osiyana
        var adminsMap = {};
        plans.forEach(function(p) {
            if (!adminsMap[p.admin_id]) {
                adminsMap[p.admin_id] = { id: p.admin_id, name: p.admin_name, plans: [] };
            }
            adminsMap[p.admin_id].plans.push(p);
        });
        
        var uniqueAdmins = Object.values(adminsMap);
        var html = '';
        uniqueAdmins.forEach(function(admin) {
            html += '<div class="data-item" style="cursor:pointer;" onclick="window.selectAdmin(\'' + admin.id + '\')">' +
                '<div style="display:flex; align-items:center;">' +
                    '<div class="data-icon-wrap icon-sub"><svg viewBox="0 0 24 24"><path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"/></svg></div>' +
                    '<div class="data-info">' +
                        '<div class="data-name">' + escHTML(admin.name) + '</div>' +
                        '<div class="data-date">' + admin.plans.length + ' Plans available</div>' +
                    '</div>' +
                '</div>' +
                '<button class="pro-card-btn" style="width:auto; padding: 6px 12px; margin:0;">Subscribe</button>' +
            '</div>';
        });
        container.innerHTML = html;
    }

    window.selectAdmin = function(adminId) {
        var body = document.getElementById('modalPlansBody');
        var title = document.getElementById('modalPlansTitle');
        
        // Pezani Admin ndi ma plans ake
        selectedAdmin = currentPlans.find(function(p) { return p.admin_id === adminId; }) || null;
        if (!selectedAdmin) return;
        
        title.textContent = selectedAdmin.admin_name + ' Plans';
        
        var adminPlans = currentPlans.filter(function(p) { return p.admin_id === adminId; });
        
        var html = '<button onclick="window.openPlansModal()" style="background:none; border:none; color:var(--accent); font-weight:600; font-size:0.8rem; cursor:pointer; margin-bottom:12px; display:flex; align-items:center; gap:4px;"><svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" fill="none" stroke-width="2"><polyline points="15 18 9 12 15 6"></polyline></svg> Back to Admins</button>';
        
        adminPlans.forEach(function(p) {
            var priceStr = formatPrice(p.price);
            html += '<div class="data-item" style="cursor:pointer;" onclick="window.selectPlan(\'' + p.id + '\')">' +
                '<div style="display:flex; align-items:center;">' +
                    '<div class="data-icon-wrap icon-sub"><svg viewBox="0 0 24 24"><path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"/></svg></div>' +
                    '<div class="data-info">' +
                        '<div class="data-name">' + escHTML(p.plan_name) + '</div>' +
                        '<div class="data-date" style="color:var(--gold);">' + p.duration_days + ' Days</div>' +
                    '</div>' +
                '</div>' +
                '<div class="data-amount positive" style="color:var(--gold);">' + priceStr + '</div>' +
            '</div>';
        });
        body.innerHTML = html;
    };

    window.selectPlan = function(planId) {
        var body = document.getElementById('modalPlansBody');
        var title = document.getElementById('modalPlansTitle');
        
        selectedPlan = currentPlans.find(function(p) { return p.id === planId; });
        if (!selectedPlan) return;
        
        title.textContent = 'Confirm Subscription';
        
        var user = getUserFromCache();
        var balance = user ? Number(user.wallet_balance) || 0 : 0;
        var hasFunds = balance >= selectedPlan.price;
        
        var html = '<button onclick="window.selectAdmin(\'' + selectedPlan.admin_id + '\')" style="background:none; border:none; color:var(--accent); font-weight:600; font-size:0.8rem; cursor:pointer; margin-bottom:12px; display:flex; align-items:center; gap:4px;"><svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" fill="none" stroke-width="2"><polyline points="15 18 9 12 15 6"></polyline></svg> Back to Plans</button>';
        
        html += '<div style="text-align:center; padding: 20px; background: #1a1a1a; border-radius: 12px; margin-bottom: 16px;">' +
            '<h4 style="color:#fff; margin-bottom:8px;">' + escHTML(selectedPlan.plan_name) + '</h4>' +
            '<p style="color:var(--text-muted); font-size:0.85rem; margin-bottom:4px;">' + selectedAdmin.admin_name + '</p>' +
            '<p style="color:var(--gold); font-size:1.2rem; font-weight:800;">' + formatPrice(selectedPlan.price) + '</p>' +
            '<p style="color:var(--text-muted); font-size:0.75rem; margin-top:8px;">Your Balance: ' + formatPrice(balance) + '</p>' +
        '</div>';
        
        if (hasFunds) {
            html += '<button class="btn-subscribe-now" onclick="window.processPayment()">Pay Subs</button>';
        } else {
            html += '<div style="background:rgba(255,77,77,0.1); border:1px solid rgba(255,77,77,0.3); padding:12px; border-radius:8px; text-align:center; margin-bottom:12px;">' +
                '<p style="color:#ff6b6b; font-size:0.85rem; font-weight:600;">Insufficient Balance. Please top up.</p>' +
            '</div>';
            html += '<a href="deposit.html" class="btn-subscribe-now" style="text-decoration:none;">Top Up Wallet</a>';
        }
        
        body.innerHTML = html;
    };

    window.processPayment = function() {
        var body = document.getElementById('modalPlansBody');
        var user = getUserFromCache();
        var token = getToken();
        
        if (!user || !token) return;
        
        body.innerHTML = getSpinnerHTML() + '<p style="text-align:center; color:var(--text-muted); font-size:0.8rem; margin-top:10px;">Processing...</p>';
        
        dedupeFetch(ENDPOINTS.SUBS_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: JSON.stringify({
                user_id: user.user_id,
                admin_id: selectedPlan.admin_id,
                plan_name: selectedPlan.plan_name,
                price: selectedPlan.price,
                duration_days: selectedPlan.duration_days
            })
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (data.success) {
                // Sinthani balance ya user m'manja
                user.wallet_balance = data.new_balance;
                setUser(user);
                renderUserData(user);
                
                document.getElementById('modalPlans').classList.remove('open');
                showToast('Subscription successful!', false);
                
                // Pukutani ma caches kuti zisawonekere zakale
                safeRemove(sessionStorage, CACHE_KEYS.SUBS + token);
                safeRemove(sessionStorage, CACHE_KEYS.TX + token);
                
                // Fetsani zatsopano
                fetchSubscriptions(token, true);
                fetchTransactions(token, true);
            } else {
                body.innerHTML = '<div style="text-align:center; padding:20px; color:#ff6b6b;">Error: ' + (data.error || 'Payment failed') + '</div>';
            }
        })
        .catch(function(e) {
            body.innerHTML = '<div style="text-align:center; padding:20px; color:#ff6b6b;">Network Error: ' + e.message + '</div>';
        });
    };

    // ════════════════════════════════════════════════════════════
    // 🎯 LOAD ALL & INIT
    // ════════════════════════════════════════════════════════════
    function loadAccountData(token, force) {
        fetchUserProfile(token, force);
        fetchTransactions(token, force);
        fetchSubscriptions(token, force);
    }

    function checkLogin() {
        var token = getToken();
        if (!token) { window.location.href = 'login.html'; return; }
        window._currentToken = token;
        setTokenInAllPlaces(token);
        var cachedUser = getUserFromCache();
        if (cachedUser) renderUserData(cachedUser);
        loadAccountData(token, false);
        setupVisibilityRefresh(token);
    }

    var visibilityBound = false;
    function setupVisibilityRefresh(token) {
        if (visibilityBound) return;
        visibilityBound = true;
        document.addEventListener('visibilitychange', function() {
            if (document.visibilityState !== 'visible') return;
            if (!getToken()) { window.location.href = 'login.html'; return; }
            loadAccountData(token, false);
        });
    }

    function logout() { clearSession(); clearAllAppCaches(); window.location.href = 'non.html'; }

    function showToast(msg, isError) {
        var toast = document.getElementById('toast');
        var toastMsg = document.getElementById('toastMsg');
        if (!toast) return;
        if (toastMsg) toastMsg.textContent = msg;
        toast.style.border = isError ? '1px solid #ff6b6b' : 'none';
        toast.classList.add('visible');
        setTimeout(function() { toast.classList.remove('visible'); }, 3000);
    }

    function init() {
        checkLogin();
        // initSearch(); // Handled in v14 block
        // initCopyUserId(); // Handled in v14 block
        // initScrollEffects(); // Handled in v14 block
        // initSecurity(); // Handled in v14 block
        
        // We just need the logout button binding here
        var logoutBtn = document.getElementById('logoutBtn');
        if (logoutBtn && !logoutBtn._bound) {
            logoutBtn._bound = true;
            logoutBtn.addEventListener('click', function(e) { e.preventDefault(); logout(); });
        }
    }

    if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); }
    else { init(); }
})();
