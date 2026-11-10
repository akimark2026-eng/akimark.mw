// account.js (v4 — Pro High-End with Transactions, Subs, and Fixed Logout)
(function() {
    'use strict';

    var TOKEN_KEY = 'akmark_token';
    var USER_KEY = 'akmark_user';
    var SUPABASE_URL = window.SUPABASE_URL;

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
        if (!token) token = getCookie(TOKEN_KEY); 
        
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
        setCookie(TOKEN_KEY, token, 7); 
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
    // 🎯 FORMATTING & RENDERING
    // ════════════════════════════════════════════════════════════
    function formatPrice(price) { return 'MK ' + Number(price || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
    function formatDate(isoString) {
        if(!isoString) return 'N/A';
        var d = new Date(isoString);
        return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    }

    function renderUserData(user) {
        if (!user) return;
        
        document.getElementById('accountSkeleton').style.display = 'none';
        document.getElementById('accountReal').style.display = 'block';

        document.getElementById('accountFullName').textContent = user.full_name || 'User';
        document.getElementById('accountUserId').textContent = user.user_id || 'N/A';
        document.getElementById('accountPhone').textContent = user.phone || 'N/A';

        var balance = user.wallet_balance || 0;
        document.getElementById('walletValue').textContent = Number(balance).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        
        // Set Coins (Earnings) if available
        document.getElementById('coinsValue').textContent = user.coins || 0;
        document.getElementById('earningsValue').textContent = user.coins || 0;

        document.body.dataset.userId = user.user_id || '';
    }

    // 🎯 RENDER TRANSACTIONS
    function renderTransactions(txs) {
        var container = document.getElementById('inlineTxContainer');
        var countEl = document.getElementById('transactionsCount');
        var seeAllBtn = document.getElementById('seeAllTxBtn');
        var modalBody = document.getElementById('modalTxBody');
        
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
            return `
                <div class="data-item">
                    <div class="data-info">
                        <div class="data-name">${tx.description || tx.type || 'Transaction'}</div>
                        <div class="data-date">${formatDate(tx.created_at)}</div>
                    </div>
                    <div class="data-amount ${amtClass}">${sign}${formatPrice(tx.amount)}</div>
                </div>
            `;
        }

        // Render top 3 inline
        container.innerHTML = txs.slice(0, 3).map(createTxHTML).join('');
        
        if (txs.length > 3) {
            seeAllBtn.style.display = 'block';
            seeAllBtn.onclick = function() {
                modalBody.innerHTML = txs.map(createTxHTML).join('');
                document.getElementById('modalTx').classList.add('open');
            };
        } else {
            seeAllBtn.style.display = 'none';
        }
    }

    // 🎯 RENDER SUBSCRIPTIONS
    function renderSubscriptions(subs) {
        var container = document.getElementById('inlineSubsContainer');
        var countEl = document.getElementById('subsCount');
        var seeAllBtn = document.getElementById('seeAllSubsBtn');
        var modalBody = document.getElementById('modalSubsBody');
        
        countEl.textContent = subs.length;

        if (subs.length === 0) {
            container.innerHTML = '<div class="empty-state-box"><svg viewBox="0 0 24 24"><path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"/></svg><span>No active subscriptions</span></div>';
            seeAllBtn.style.display = 'none';
            return;
        }

        function createSubHTML(sub) {
            return `
                <div class="data-item">
                    <div class="data-info">
                        <div class="data-name">${sub.plan_name || 'Premium Plan'}</div>
                        <div class="data-status">Active</div>
                    </div>
                    <div class="data-date">Expires: ${formatDate(sub.expiry_date)}</div>
                </div>
            `;
        }

        // Render top 3 inline
        container.innerHTML = subs.slice(0, 3).map(createSubHTML).join('');

        if (subs.length > 3) {
            seeAllBtn.style.display = 'block';
            seeAllBtn.onclick = function() {
                modalBody.innerHTML = subs.map(createSubHTML).join('');
                document.getElementById('modalSubs').classList.add('open');
            };
        } else {
            seeAllBtn.style.display = 'none';
        }
    }

    // ════════════════════════════════════════════════════════════
    // 🎯 FETCH DATA FROM APIs
    // ════════════════════════════════════════════════════════════
    async function fetchTransactions(token) {
        try {
            var res = await fetch(SUPABASE_URL + '/functions/v1/get-transactions-api', {
                method: 'GET',
                headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }
            });
            var data = await res.json();
            if (data.success && data.transactions) {
                renderTransactions(data.transactions);
            } else {
                renderTransactions([]);
            }
        } catch(e) {
            console.warn("Failed to load transactions", e);
            renderTransactions([]);
        }
    }

    async function fetchSubscriptions(token) {
        try {
            var res = await fetch(SUPABASE_URL + '/functions/v1/get-mysubscribes-api', {
                method: 'GET',
                headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }
            });
            var data = await res.json();
            if (data.success && data.subscriptions) {
                renderSubscriptions(data.subscriptions);
            } else {
                renderSubscriptions([]);
            }
        } catch(e) {
            console.warn("Failed to load subscriptions", e);
            renderSubscriptions([]);
        }
    }

    // ════════════════════════════════════════════════════════════
    // 🎯 BULLETPROOF AUTH SYSTEM & LOGOUT
    // ════════════════════════════════════════════════════════════
    function checkLogin() {
        var token = getToken();
        if (!token) {
            window.location.href = 'login.html';
            return;
        }

        setTokenInAllPlaces(token);

        var cachedUser = null;
        try { cachedUser = JSON.parse(localStorage.getItem(USER_KEY)); } catch(e) {}
        if (cachedUser) renderUserData(cachedUser);

        fetch('https://vqmmsqtlszzugdyoyilu.supabase.co/functions/v1/login-checker', {
            method: 'GET',
            headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }
        })
        .then(function(response) {
            if (response.status === 401 || response.status === 403) {
                clearSession();
                window.location.href = 'login.html';
                return null;
            }
            if (!response.ok) throw new Error('Network response was not ok');
            return response.json();
        })
        .then(function(data) {
            if (!data) return;
            if (!data.valid) {
                clearSession();
                window.location.href = 'login.html';
                return;
            }
            if (data.user) {
                setUser(data.user);
                renderUserData(data.user);
                // 🎯 Fetch Additional Data Once User is Verified
                fetchTransactions(token);
                fetchSubscriptions(token);
            }
        })
        .catch(function(err) {
            console.warn('Auth check ignored (WebView transition):', err); 
            // Even if network fails, try to fetch with cached token
            fetchTransactions(token);
            fetchSubscriptions(token);
        });
    }

    // 🎯 FIXED LOGOUT FUNCTION
    function logout() {
        clearSession();
        // Redirect to non.html (or login.html). Non.html is better for public view.
        window.location.href = 'non.html';
    }

    // ════════════════════════════════════════════════════════════
    // SEARCH (Using Real API)
    // ════════════════════════════════════════════════════════════
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
                // Fetch search results from API
                fetch(SUPABASE_URL + '/functions/v1/films-api?limit=10&search=' + encodeURIComponent(query))
                .then(function(r) { return r.json(); })
                .then(function(data) {
                    var movies = data.movies || [];
                    if (movies.length > 0) {
                        searchResults.innerHTML = movies.map(function(m) {
                            return '<div class="result-item" data-id="' + m.id + '">' + m.title + '</div>';
                        }).join('');
                    } else {
                        searchResults.innerHTML = '<div class="result-item">No movies found</div>';
                    }
                    searchResults.classList.add('visible');
                })
                .catch(function() {
                    searchResults.innerHTML = '<div class="result-item">Search failed</div>';
                    searchResults.classList.add('visible');
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
        if (copyBtn && userIdEl) {
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
    }

    function initScrollEffects() {
        var header = document.getElementById('mainHeader');
        var lastScrollY = 0, ticking = false, HIDE_AFTER = 100, isHidden = false;

        function updateScroll() {
            var y = window.pageYOffset || document.documentElement.scrollTop || 0;
            var delta = y - lastScrollY;

            if (header) {
                if (y > 10) header.classList.add('scrolled');
                else header.classList.remove('scrolled');
            }
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
            if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && (e.key === 'I' || e.key === 'J' || e.key === 'C')) || (e.ctrlKey && e.key === 'u')) {
                e.preventDefault();
                return false;
            }
        });
    }

    function init() {
        // Check Auth
        checkLogin();
        
        // UI Inits
        initSearch();
        initCopyUserId();
        initScrollEffects();
        initSecurity();

        // Bind Logout Button (ONLY ONCE)
        var logoutBtn = document.getElementById('logoutBtn');
        if (logoutBtn) {
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
