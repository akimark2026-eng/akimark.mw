// account.js (v16 — Pro Max High-End + Accordions + Smart Transactions + Multi-Step Subscribe)
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
        SUBSCRIBE:     SUPABASE_URL + '/functions/v1/subs-api' // New API
    };

    var CACHE_KEYS = {
        PROFILE: 'akmark_cache_profile_', TX: 'akmark_cache_tx_', SUBS: 'akmark_cache_subs_', PLANS: 'akmark_cache_plans'
    };
    var TTL = {
        PROFILE: 5 * 60 * 1000, TX: 2 * 60 * 1000, SUBS: 5 * 60 * 1000, PLANS: 10 * 60 * 1000
    };
    var SWR_THRESHOLD = 60 * 1000;

    // ─── SPINNER & SKELETONS ───
    function getSpinnerHTML() {
        var blades = '';
        for (var i = 0; i < 12; i++) blades += '<div class="spinner-blade"></div>';
        return '<div style="text-align:center; padding:20px;"><div class="spinner"><div class="spinner-blade"></div><div class="spinner-blade"></div><div class="spinner-blade"></div><div class="spinner-blade"></div><div class="spinner-blade"></div><div class="spinner-blade"></div><div class="spinner-blade"></div><div class="spinner-blade"></div><div class="spinner-blade"></div><div class="spinner-blade"></div><div class="spinner-blade"></div><div class="spinner-blade"></div></div></div>';
    }

    function getSkeletonHTML(type) {
        var html = '';
        for (var i = 0; i < 3; i++) {
            html += '<div class="skeleton-item">' +
                '<div class="skeleton-left">' +
                    '<div class="skeleton-icon"></div>' +
                    '<div class="skeleton-text-wrap">' +
                        '<div class="skeleton-line long"></div>' +
                        '<div class="skeleton-line short"></div>' +
                    '</div>' +
                '</div>' +
                '<div class="skeleton-amount"></div>' +
            '</div>';
        }
        return html;
    }

    // ─── COOKIE / STORAGE / FETCH ───
    function setCookie(name, value, days) { var d = new Date(); d.setTime(d.getTime() + (days*24*60*60*1000)); document.cookie = name + "=" + (value || "") + "; expires=" + d.toUTCString() + "; path=/; SameSite=Lax"; }
    function getCookie(name) { var nameEQ = name + "="; var ca = document.cookie.split(';'); for(var i=0;i < ca.length;i++) { var c = ca[i]; while (c.charAt(0)==' ') c = c.substring(1,c.length); if (c.indexOf(nameEQ) == 0) return c.substring(nameEQ.length,c.length); } return null; }
    function eraseCookie(name) { document.cookie = name + '=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT;'; }
    function safeGet(s, k) { try { return s.getItem(k); } catch (e) { return null; } }
    function safeSet(s, k, v) { try { s.setItem(k, v); } catch (e) {} }
    function safeRemove(s, k) { try { s.removeItem(k); } catch (e) {} }
    
    function cacheRead(key, ttl, useSession) { var storage = useSession ? sessionStorage : localStorage; var raw = safeGet(storage, key); if (!raw) return null; try { var p = JSON.parse(raw); if (Date.now() - p.ts > ttl) return null; return { data: p.data, age: Date.now() - p.ts }; } catch (e) { return null; } }
    function cacheWrite(key, data, useSession) { var storage = useSession ? sessionStorage : localStorage; safeSet(storage, key, JSON.stringify({ ts: Date.now(), data: data })); }
    
    function getToken() { var token = safeGet(localStorage, TOKEN_KEY); if (!token) token = safeGet(sessionStorage, TOKEN_KEY); if (!token) token = getCookie(TOKEN_KEY); if (!token || token === 'null' || token === 'undefined') return null; try { var parsed = JSON.parse(token); if (parsed && parsed.access_token) return parsed.access_token; if (typeof parsed === 'string') return parsed; } catch (e) {} return String(token).replace(/^["']|["']$/g, '').trim(); }
    function setTokenInAllPlaces(token) { safeSet(localStorage, TOKEN_KEY, token); safeSet(sessionStorage, TOKEN_KEY, token); setCookie(TOKEN_KEY, token, 7); }
    function getUserFromCache() { try { return JSON.parse(safeGet(localStorage, USER_KEY) || 'null'); } catch (e) { return null; } }
    function setUser(user) { safeSet(localStorage, USER_KEY, JSON.stringify(user)); setCookie('akmark_user_logged', 'true', 7); }

    var inflight = {};
    function dedupeFetch(url, options) { var key = url + '|' + (options && options.headers ? JSON.stringify(options.headers) : ''); if (inflight[key]) return inflight[key]; var p = fetch(url, options).finally(function() { delete inflight[key]; }); inflight[key] = p; return p; }
    function escHTML(str) { return String(str == null ? '' : str).replace(/[&<>"']/g, function(c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    
    function formatPrice(price) { return 'MK ' + Number(price || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
    function formatDate(isoString) { if (!isoString) return 'N/A'; var d = new Date(isoString); return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }); }
    function formatBalance(balance) { return Number(balance || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

    function showToast(msg, isError) { var toast = document.getElementById('toast'); var toastMsg = document.getElementById('toastMsg'); if (!toast) return; if (toastMsg) toastMsg.textContent = msg; toast.style.border = isError ? '1px solid #ff6b6b' : 'none'; toast.classList.add('visible'); setTimeout(function() { toast.classList.remove('visible'); }, 3000); }

    // ─── RENDER USER ───
    function renderUserData(user) {
        if (!user) return;
        document.getElementById('accountSkeleton').style.display = 'none';
        document.getElementById('accountReal').style.display = 'block';
        document.getElementById('accountFullName').textContent = user.full_name || 'User';
        document.getElementById('accountUserId').textContent = user.user_id || 'N/A';
        document.getElementById('accountPhone').textContent = user.phone || 'N/A';
        document.getElementById('walletValue').textContent = formatBalance(user.wallet_balance);
        document.getElementById('coinsValue').textContent = user.coins || 0;
        document.getElementById('earningsValue').textContent = user.earnings || 0;
        document.body.dataset.userId = user.user_id || '';
    }

    // ─── RENDER TRANSACTIONS (High-End Status) ───
    function renderTransactions(txs) {
        var container = document.getElementById('inlineTxContainer');
        var countEl = document.getElementById('transactionsCount');
        var modalBody = document.getElementById('modalTxBody');
        if (!container || !countEl) return;

        countEl.textContent = txs.length;

        if (txs.length === 0) {
            container.innerHTML = '<div class="empty-state-box"><svg viewBox="0 0 24 24"><path d="M7 16V4M7 4L3 8M7 4L11 8M17 8V20M17 20L21 16M17 20L13 16"/></svg><span>No transactions yet</span></div>';
            return;
        }

        function createTxHTML(tx) {
            var amt = Number(tx.amount || 0);
            var isPos = amt > 0;
            var isFailed = tx.status && tx.status.toLowerCase() === 'failed';
            
            var iconClass = isPos ? 'icon-in' : (isFailed ? 'icon-fail' : 'icon-out');
            var iconSvg = isPos 
                ? '<svg viewBox="0 0 24 24"><path d="M12 5v14M19 12l-7 7-7-7"/></svg>' 
                : (isFailed ? '<svg viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>' 
                            : '<svg viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg>');

            var sign = isPos ? '+' : (isFailed ? '' : '-');
            var amtClass = isPos ? 'positive' : (isFailed ? 'strikethrough' : 'negative');
            var displayAmt = formatPrice(Math.abs(amt));

            // Cleanup description (chotsani SUCCESS/FAILED m'mawu ngati alipo)
            var desc = (tx.description || tx.type || 'Transaction').replace(/\s*\((success|failed|pending)\)/ig, '');

            return '<div class="data-item">' +
                '<div style="display:flex; align-items:center;">' +
                    '<div class="data-icon-wrap ' + iconClass + '">' + iconSvg + '</div>' +
                    '<div class="data-info">' +
                        '<div class="data-name">' + escHTML(desc).toUpperCase() + '</div>' +
                        '<div class="data-date">' + formatDate(tx.created_at) + '</div>' +
                    '</div>' +
                '</div>' +
                '<div class="data-amount ' + amtClass + '">' + sign + ' ' + displayAmt + '</div>' +
            '</div>';
        }

        container.innerHTML = txs.slice(0, 3).map(createTxHTML).join('');

        if (modalBody) {
            modalBody.innerHTML = txs.map(createTxHTML).join('');
        }
    }

    // ─── RENDER SUBSCRIPTIONS ───
    function renderSubscriptions(subs) {
        var container = document.getElementById('inlineSubsContainer');
        var countEl = document.getElementById('subsCount');
        if (!container || !countEl) return;

        countEl.textContent = subs.length;

        var subscribeBtnHTML = '<button class="btn-subscribe-now" onclick="window.openPlansModal()"><svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 11h-4v4h-2v-4H7v-2h4V7h2v4h4v2z"/></svg>Subscribe Now</button>';

        if (subs.length === 0) {
            container.innerHTML = '<div class="empty-state-box"><svg viewBox="0 0 24 24"><path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"/></svg><span>No active subscriptions</span></div>' + subscribeBtnHTML;
            return;
        }

        function createSubHTML(sub) {
            var iconSvg = '<svg viewBox="0 0 24 24"><path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"/></svg>';
            var displayName = sub.admin_name ? (sub.admin_name + ' - ' + (sub.plan_name || 'Premium')) : (sub.plan_name || 'Premium Plan');

            return '<div class="data-item">' +
                '<div style="display:flex; align-items:center;">' +
                    '<div class="data-icon-wrap icon-sub">' + iconSvg + '</div>' +
                    '<div class="data-info">' +
                        '<div class="data-name">' + escHTML(displayName) + '</div>' +
                        '<div class="data-status">Active</div>' +
                    '</div>' +
                '</div>' +
                '<div class="data-date" style="text-align:right;">Expires:<br><span style="color:#fff; font-weight:600;">' + formatDate(sub.expiry_date) + '</span></div>' +
            '</div>';
        }

        container.innerHTML = subs.slice(0, 3).map(createSubHTML).join('') + subscribeBtnHTML;
    }

    // ─── FETCHERS ───
    function fetchUserProfile(token, force) {
        var cacheKey = CACHE_KEYS.PROFILE + token;
        if (!force) { var cached = cacheRead(cacheKey, TTL.PROFILE, true); if (cached) { setUser(cached.data.user); renderUserData(cached.data.user); if (cached.age > SWR_THRESHOLD) fetchProfileFresh(token, cacheKey); return; } }
        return fetchProfileFresh(token, cacheKey);
    }
    function fetchProfileFresh(token, cacheKey) {
        return dedupeFetch(ENDPOINTS.USER_PROFILE, { method: 'GET', headers: { 'Authorization': 'Bearer ' + token } })
        .then(function(res) { if (handleAuthError(res.status)) return null; if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
        .then(function(data) { if (!data) return null; if (!data.valid) { clearSession(); window.location.href = 'login.html'; return null; } if (data.user) { setUser(data.user); renderUserData(data.user); cacheWrite(cacheKey, data, true); return data.user; } return null; })
        .catch(function(e) { console.warn('Profile fetch failed:', e); return null; });
    }

    function fetchTransactions(token, force) {
        var cacheKey = CACHE_KEYS.TX + token;
        if (!force) { var cached = cacheRead(cacheKey, TTL.TX, true); if (cached) { renderTransactions(cached.data); if (cached.age > SWR_THRESHOLD) fetchTransactionsFresh(token, cacheKey); return; } }
        return fetchTransactionsFresh(token, cacheKey);
    }
    function fetchTransactionsFresh(token, cacheKey) {
        var container = document.getElementById('inlineTxContainer');
        if (container && !cacheRead(cacheKey, TTL.TX, true)) container.innerHTML = getSkeletonHTML();
        var user = getUserFromCache(); var userId = user && user.user_id ? user.user_id : '';
        var url = ENDPOINTS.TRANSACTIONS + (userId ? '?user_id=' + encodeURIComponent(userId) : '');
        return dedupeFetch(url, { method: 'GET', headers: { 'Authorization': 'Bearer ' + token } })
        .then(function(res) { if (handleAuthError(res.status)) return null; if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
        .then(function(data) { if (!data) return null; var txs = (data.success && data.transactions) ? data.transactions : []; renderTransactions(txs); cacheWrite(cacheKey, txs, true); return txs; })
        .catch(function(e) { console.error('TX fetch failed:', e); if (container) container.innerHTML = '<div style="text-align:center; padding:20px; color:#ff6b6b; font-size:12px;">Error: ' + e.message + '</div>'; return null; });
    }

    function fetchSubscriptions(token, force) {
        var cacheKey = CACHE_KEYS.SUBS + token;
        if (!force) { var cached = cacheRead(cacheKey, TTL.SUBS, true); if (cached) { renderSubscriptions(cached.data); if (cached.age > SWR_THRESHOLD) fetchSubscriptionsFresh(token, cacheKey); return; } }
        return fetchSubscriptionsFresh(token, cacheKey);
    }
    function fetchSubscriptionsFresh(token, cacheKey) {
        var container = document.getElementById('inlineSubsContainer');
        if (container && !cacheRead(cacheKey, TTL.SUBS, true)) container.innerHTML = getSkeletonHTML();
        var user = getUserFromCache(); var userId = user && user.user_id ? user.user_id : '';
        var url = ENDPOINTS.SUBSCRIPTIONS + (userId ? '?user_id=' + encodeURIComponent(userId) : '');
        return dedupeFetch(url, { method: 'GET', headers: { 'Authorization': 'Bearer ' + token } })
        .then(function(res) { if (handleAuthError(res.status)) return null; if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
        .then(function(data) { if (!data) return null; var subs = (data.success && data.subscriptions) ? data.subscriptions : []; renderSubscriptions(subs); cacheWrite(cacheKey, subs, true); return subs; })
        .catch(function(e) { console.error('Subs fetch failed:', e); if (container) container.innerHTML = '<div style="text-align:center; padding:20px; color:#ff6b6b; font-size:12px;">Error: ' + e.message + '</div>'; return null; });
    }

    // ─── SMART SUBSCRIBE FLOW ───
    var _currentPlans = [];
    var _selectedAdminId = null;
    var _selectedPlanId = null;

    window.openPlansModal = function() {
        var modal = document.getElementById('modalPlans');
        var body = document.getElementById('modalPlansBody');
        var title = document.getElementById('modalPlansTitle');
        if (!modal || !body) return;

        modal.classList.add('open');
        body.innerHTML = getSpinnerHTML();
        _selectedAdminId = null;
        _selectedPlanId = null;
        title.textContent = "Choose Admin";

        var cached = cacheRead(CACHE_KEYS.PLANS, TTL.PLANS, false);
        if (cached && cached.data) {
            _currentPlans = cached.data;
            renderAdminsInModal();
            return;
        }

        dedupeFetch(ENDPOINTS.PLANS, { method: 'GET' })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (data.success && data.plans) {
                _currentPlans = data.plans;
                cacheWrite(CACHE_KEYS.PLANS, _currentPlans, false);
                renderAdminsInModal();
            } else {
                body.innerHTML = '<div style="text-align:center; color:#aaa; padding:20px;">No plans available.</div>';
            }
        })
        .catch(function(e) { body.innerHTML = '<div style="text-align:center; color:#ff6b6b; padding:20px;">Error: ' + e.message + '</div>'; });
    };

    function renderAdminsInModal() {
        var body = document.getElementById('modalPlansBody');
        var title = document.getElementById('modalPlansTitle');
        title.textContent = "Choose Admin";
        
        // Phatikizani ma admin (osabwereza)
        var adminMap = {};
        _currentPlans.forEach(function(p) {
            if (!adminMap[p.admin_id]) {
                adminMap[p.admin_id] = p.admin_name;
            }
        });

        var html = '';
        Object.keys(adminMap).forEach(function(aid) {
            html += '<div class="data-item">' +
                '<div style="display:flex; align-items:center;">' +
                    '<div class="data-icon-wrap icon-sub"><svg viewBox="0 0 24 24"><path d="M20 4H4c-1.11 0-2 .89-2 2v12c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V6c0-1.11-.89-2-2-2zm-8 6c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3zm-7 10c0-2.33 4.67-3.5 7-3.5s7 1.17 7 3.5v.5H5v-.5z"/></svg></div>' +
                    '<div class="data-info"><div class="data-name">' + escHTML(adminMap[aid]) + '</div></div>' +
                '</div>' +
                '<button class="pro-card-btn" style="width:auto; padding: 6px 16px; margin-top:0;" onclick="window.selectAdmin(\''+aid+'\')">Subscribe</button>' +
            '</div>';
        });
        body.innerHTML = html;
    }

    window.selectAdmin = function(adminId) {
        _selectedAdminId = adminId;
        _selectedPlanId = null;
        renderPlansInModal(adminId);
    };

    function renderPlansInModal(adminId) {
        var body = document.getElementById('modalPlansBody');
        var title = document.getElementById('modalPlansTitle');
        
        var adminPlans = _currentPlans.filter(function(p) { return p.admin_id === adminId; });
        var adminName = adminPlans.length > 0 ? adminPlans[0].admin_name : 'Admin';
        title.textContent = adminName + "'s Plans";

        var backBtn = '<div class="back-btn" onclick="window.backToAdmins()"><svg viewBox="0 0 24 24"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg> Back</div>';

        var html = backBtn;
        adminPlans.forEach(function(p) {
            html += '<div class="data-item">' +
                '<div style="display:flex; align-items:center;">' +
                    '<div class="data-icon-wrap icon-sub"><svg viewBox="0 0 24 24"><path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"/></svg></div>' +
                    '<div class="data-info"><div class="data-name">' + escHTML(p.plan_name) + '</div><div class="data-date" style="color:var(--gold);">' + p.duration_days + ' Days</div></div>' +
                '</div>' +
                '<div style="display:flex; align-items:center; gap:12px;">' +
                    '<div class="data-amount positive" style="color:var(--gold);">' + formatPrice(p.price) + '</div>' +
                    '<button class="pro-card-btn" style="width:auto; padding: 6px 16px; margin-top:0;" onclick="window.selectPlan(\''+p.id+'\')">Select</button>' +
                '</div>' +
            '</div>';
        });
        body.innerHTML = html;
    }

    window.backToAdmins = function() { renderAdminsInModal(); };

    window.selectPlan = function(planId) {
        _selectedPlanId = planId;
        var plan = _currentPlans.find(function(p) { return p.id === planId; });
        if (!plan) return;

        var body = document.getElementById('modalPlansBody');
        var title = document.getElementById('modalPlansTitle');
        title.textContent = "Confirm Payment";

        var backBtn = '<div class="back-btn" onclick="window.selectAdmin(\''+_selectedAdminId+'\')"><svg viewBox="0 0 24 24"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg> Back</div>';

        var html = backBtn +
            '<div style="text-align:center; padding: 20px;">' +
                '<div class="data-icon-wrap icon-sub" style="width:60px; height:60px; margin: 0 auto 16px;"><svg viewBox="0 0 24 24" style="width:30px; height:30px;"><path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"/></svg></div>' +
                '<h4 style="font-size:1.2rem; font-weight:800; margin-bottom:8px;">' + escHTML(plan.plan_name) + '</h4>' +
                '<p style="color:var(--text-muted); margin-bottom:16px;">For ' + plan.duration_days + ' days</p>' +
                '<div style="font-size:1.5rem; font-weight:900; color:var(--gold); margin-bottom:24px;">' + formatPrice(plan.price) + '</div>' +
                '<button id="paySubsBtn" class="btn-subscribe-now" onclick="window.processPayment()">Pay Subs</button>' +
            '</div>';
        body.innerHTML = html;
    };

    window.processPayment = function() {
        var user = getUserFromCache();
        if (!user || !user.user_id) return showToast('User not found', true);

        var btn = document.getElementById('paySubsBtn');
        btn.disabled = true;
        btn.innerHTML = getSpinnerHTML();

        dedupeFetch(ENDPOINTS.SUBSCRIBE, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getToken() },
            body: JSON.stringify({
                user_id: user.user_id,
                admin_id: _selectedAdminId,
                plan_id: _selectedPlanId
            })
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (data.success) {
                showToast('Subscription Successful!', false);
                document.getElementById('modalPlans').classList.remove('open');
                // Refresh data
                window.AccountRefreshAll();
            } else {
                showToast(data.error || 'Payment failed', true);
                btn.disabled = false;
                btn.textContent = 'Pay Subs';
            }
        })
        .catch(function(e) {
            showToast('Network Error', true);
            btn.disabled = false;
            btn.textContent = 'Pay Subs';
        });
    };

    // ─── INIT & UTILS ───
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

    function loadAccountData(token, force) {
        fetchUserProfile(token, force);
        fetchTransactions(token, force);
        fetchSubscriptions(token, force);
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

    function clearSession() {
        var token = getToken();
        safeRemove(localStorage, TOKEN_KEY); safeRemove(sessionStorage, TOKEN_KEY);
        safeRemove(localStorage, 'akmark_refresh_token'); safeRemove(sessionStorage, 'akmark_refresh_token');
        safeRemove(localStorage, USER_KEY); eraseCookie(TOKEN_KEY); eraseCookie('akmark_user_logged');
        if (token) { safeRemove(sessionStorage, CACHE_KEYS.PROFILE + token); safeRemove(sessionStorage, CACHE_KEYS.TX + token); safeRemove(sessionStorage, CACHE_KEYS.SUBS + token); }
    }

    function handleAuthError(status) { if (status === 401 || status === 403) { clearSession(); window.location.href = 'login.html'; return true; } return false; }

    window.AccountRefreshAll = function() {
        var token = getToken();
        if (!token) return;
        loadAccountData(token, true);
    };

    function init() {
        checkLogin();
        document.getElementById('logoutBtn')?.addEventListener('click', function(e) { e.preventDefault(); clearSession(); window.location.href = 'non.html'; });
        document.getElementById('copyUserIdBtn')?.addEventListener('click', function() {
            var uid = document.getElementById('accountUserId').textContent;
            if (uid && uid !== '...') { navigator.clipboard.writeText(uid).then(function(){ showToast('User ID copied!', false); }); }
        });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
