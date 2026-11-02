// home.js (v14 — Pro Multi-Layer Cache + Cloudflare CDN + Full Red/Black Live Ads)
// All v12 logic preserved 100%. Upgraded Ads Modal to Red/Black theme, 10s auto-close, fast load.

(function() {
    'use strict';

    var TOKEN_KEY = 'akmark_token';
    var USER_KEY = 'akmark_user';

    var POSTER_WIDTH = 400;
    var POSTER_QUALITY = 70;

    // ════════════════════════════════════════════════════════════
    // 🆕 CACHE CONFIG
    // ════════════════════════════════════════════════════════════
    var CACHE_KEYS = {
        FILMS:         'akmark_cache_films_v1',
        FILMS_TS:      'akmark_cache_films_ts_v1',
        LOGIN:         'akmark_cache_login_',       // + token suffix
        MYMOVIES:      'akmark_cache_mymovies_',    // + token suffix
        ADS:           'akmark_cache_ads_v1'        // 🆕 Live Ads Cache
    };
    var TTL = {
        FILMS:     5 * 60 * 1000,  // 5 min
        LOGIN:     60 * 1000,      // 60 sec
        MYMOVIES:  30 * 1000,      // 30 sec
        ADS:       2 * 60 * 1000   // 🆕 2 min for ads
    };

    // ════════════════════════════════════════════════════════════
    // SAFE STORAGE HELPERS
    // ════════════════════════════════════════════════════════════
    function safeGet(storage, key) {
        try { return storage.getItem(key); } catch (e) { return null; }
    }
    function safeSet(storage, key, val) {
        try { storage.setItem(key, val); } catch (e) { /* quota / private */ }
    }
    function safeRemove(storage, key) {
        try { storage.removeItem(key); } catch (e) {}
    }

    // ════════════════════════════════════════════════════════════
    // CACHE — read/write with TTL
    // ════════════════════════════════════════════════════════════
    function cacheRead(key, ttl) {
        var raw = safeGet(localStorage, key);
        if (!raw) return null;
        try {
            var parsed = JSON.parse(raw);
            if (Date.now() - parsed.ts > ttl) return null;
            return parsed.data;
        } catch (e) { return null; }
    }
    function cacheWrite(key, data) {
        safeSet(localStorage, key, JSON.stringify({ ts: Date.now(), data: data }));
    }

    function sessionCacheRead(key, ttl) {
        var raw = safeGet(sessionStorage, key);
        if (!raw) return null;
        try {
            var parsed = JSON.parse(raw);
            if (Date.now() - parsed.ts > ttl) return null;
            return parsed.data;
        } catch (e) { return null; }
    }
    function sessionCacheWrite(key, data) {
        safeSet(sessionStorage, key, JSON.stringify({ ts: Date.now(), data: data }));
    }

    // ════════════════════════════════════════════════════════════
    // REQUEST DEDUPLICATION
    // ════════════════════════════════════════════════════════════
    var inflight = {};
    function dedupeFetch(url, options) {
        var key = url + '|' + (options && options.headers ? JSON.stringify(options.headers) : '');
        if (inflight[key]) return inflight[key];

        var p = fetch(url, options).finally(function() {
            delete inflight[key];
        });
        inflight[key] = p;
        return p;
    }

    function optimizePosterUrl(originalUrl, width, quality) {
        if (!originalUrl) return '';
        var w = width || POSTER_WIDTH;
        var q = quality || POSTER_QUALITY;
        if (originalUrl.indexOf('/storage/v1/object/public/') !== -1) {
            var optimized = originalUrl.replace(
                '/storage/v1/object/public/',
                '/storage/v1/render/image/public/'
            );
            var sep = optimized.indexOf('?') === -1 ? '?' : '&';
            return optimized + sep + 'width=' + w + '&quality=' + q + '&resize=contain';
        }
        return originalUrl;
    }

    function optimizePosterThumb(originalUrl) { return optimizePosterUrl(originalUrl, 250, 65); }

    function safeAttr(str) {
        return String(str || '').replace(/'/g, '%27').replace(/"/g, '&quot;');
    }

    function getToken() { return localStorage.getItem(TOKEN_KEY); }
    function setUser(user) { localStorage.setItem(USER_KEY, JSON.stringify(user)); }
    function clearSession() {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem('akmark_refresh_token');
        localStorage.removeItem(USER_KEY);
        if (window._currentToken) {
            safeRemove(sessionStorage, CACHE_KEYS.LOGIN + window._currentToken);
            safeRemove(sessionStorage, CACHE_KEYS.MYMOVIES + window._currentToken);
        }
    }

    // ════════════════════════════════════════════════════════════
    // 🆕 LIVE ADS POPUP MODAL (Red & Black Theme, 10s Auto-Close)
    // ════════════════════════════════════════════════════════════
    function showLiveAdModal(ad) {
        if (document.getElementById('liveAdOverlay')) return; // Already showing

        // 1. Inject CSS
        var style = document.createElement('style');
        style.id = 'liveAdStyles';
        style.innerHTML = `
            #liveAdOverlay {
                position: fixed; inset: 0; z-index: 999999;
                background: rgba(0,0,0,0.9); backdrop-filter: blur(10px);
                display: flex; align-items: center; justify-content: center;
                padding: 16px; opacity: 0; transition: opacity 0.3s ease;
            }
            #liveAdOverlay.show { opacity: 1; }
            
            .live-ad-card {
                background: #121212; width: 100%; max-width: 420px;
                border-radius: 20px; overflow: hidden; position: relative;
                border: 1px solid #333; box-shadow: 0 20px 50px rgba(199, 21, 21, 0.3);
                transform: scale(0.9) translateY(20px); transition: all 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
                display: flex; flex-direction: column;
            }
            #liveAdOverlay.show .live-ad-card { transform: scale(1) translateY(0); }
            
            .live-ad-close {
                position: absolute; top: 12px; right: 12px; z-index: 10;
                background: rgba(0,0,0,0.6); color: #fff; border: 1px solid rgba(255,255,255,0.2);
                width: 34px; height: 34px; border-radius: 50%;
                display: flex; align-items: center; justify-content: center;
                cursor: pointer; backdrop-filter: blur(4px); transition: 0.2s; font-size: 16px;
            }
            .live-ad-close:hover { background: #c71515; border-color: #c71515; transform: rotate(90deg); }
            
            .live-ad-poster-wrap {
                width: 100%; max-height: 380px; overflow: hidden; position: relative;
                background: #000; display: flex; align-items: center; justify-content: center;
                border-bottom: 3px solid #c71515;
            }
            .live-ad-poster {
                width: 100%; height: auto; max-height: 380px; object-fit: contain; display: block;
            }
            
            .live-ad-badge {
                position: absolute; top: 16px; left: 16px;
                background: #c71515; color: #fff; padding: 6px 12px;
                border-radius: 20px; font-size: 12px; font-weight: 800;
                display: flex; align-items: center; gap: 6px; letter-spacing: 0.5px;
                box-shadow: 0 4px 15px rgba(199, 21, 21, 0.5);
            }
            .live-dot {
                width: 8px; height: 8px; background: #fff; border-radius: 50%;
                animation: pulseLive 1s infinite alternate;
            }
            @keyframes pulseLive { 0% { opacity: 1; transform: scale(1); } 100% { opacity: 0.4; transform: scale(1.5); } }
            
            .live-ad-content { padding: 24px 20px; text-align: center; background: #121212; }
            .live-ad-title {
                font-family: 'Lexend', system-ui, sans-serif; font-size: 20px; font-weight: 800;
                color: #ffffff; margin-bottom: 10px; line-height: 1.3;
                display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
            }
            .live-ad-subtitle {
                font-size: 14px; color: #a1a1aa; margin-bottom: 24px; font-weight: 500;
            }
            
            .live-ad-btn {
                background: #c71515; color: #fff; border: none;
                width: 100%; padding: 16px; border-radius: 12px;
                font-size: 16px; font-weight: 800; cursor: pointer;
                display: flex; align-items: center; justify-content: center; gap: 8px;
                text-decoration: none; transition: 0.2s; letter-spacing: 0.5px;
                box-shadow: 0 6px 20px rgba(199, 21, 21, 0.4);
            }
            .live-ad-btn:hover { background: #a31010; }
            .live-ad-btn:active { transform: scale(0.97); }
            
            .live-ad-timer-wrap {
                height: 5px; background: #333; width: 100%; border-bottom-left-radius: 20px; border-bottom-right-radius: 20px; overflow: hidden;
            }
            .live-ad-timer {
                height: 100%; background: #c71515;
                width: 100%; transform-origin: left; animation: timerBar 10s linear forwards;
            }
            @keyframes timerBar { 0% { transform: scaleX(1); } 100% { transform: scaleX(0); } }
        `;
        document.head.appendChild(style);

        // 2. Build HTML
        var overlay = document.createElement('div');
        overlay.id = 'liveAdOverlay';
        overlay.innerHTML = `
            <div class="live-ad-card">
                <button class="live-ad-close" onclick="window.closeLiveAd()">✕</button>
                <div class="live-ad-poster-wrap">
                    <div class="live-ad-badge"><span class="live-dot"></span> LIVE NOW</div>
                    <img src="${ad.poster_url}" class="live-ad-poster" alt="Live Ad">
                </div>
                <div class="live-ad-content">
                    <div class="live-ad-title">${ad.title || 'Exclusive Live Stream'}</div>
                    <div class="live-ad-subtitle">Don't miss out. Watch it live right now!</div>
                    <a href="live.html?id=${ad.id}" class="live-ad-btn">
                        <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                        Watch Live Now
                    </a>
                </div>
                <div class="live-ad-timer-wrap">
                    <div class="live-ad-timer"></div>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        // 3. Animate In
        requestAnimationFrame(function() {
            overlay.classList.add('show');
        });

        // 4. Auto close after 10 seconds (as requested)
        window._liveAdTimeout = setTimeout(function() {
            window.closeLiveAd();
        }, 10000); // 🆕 10 Seconds
    }

    // Global close function
    window.closeLiveAd = function() {
        var overlay = document.getElementById('liveAdOverlay');
        if (!overlay) return;
        overlay.classList.remove('show');
        clearTimeout(window._liveAdTimeout);
        setTimeout(function() {
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        }, 400);
    };

    // 🆕 FETCH ADS
    function fetchLiveAds() {
        var cachedAds = cacheRead(CACHE_KEYS.ADS, TTL.ADS);
        if (cachedAds && cachedAds.length > 0) {
            // 🆕 Show almost instantly (500ms) instead of 3 seconds
            setTimeout(function() {
                showLiveAdModal(cachedAds[0]);
            }, 500);
            return;
        }

        dedupeFetch(SUPABASE_URL + '/functions/v1/ads-api', {
            method: 'GET',
            headers: { 'Authorization': 'Bearer ' + window.SUPABASE_ANON_KEY }
        })
        .then(function(r) { return r.json(); })
        .then(function(data) {
            if (data.success && data.ads && data.ads.length > 0) {
                cacheWrite(CACHE_KEYS.ADS, data.ads);
                // 🆕 Show almost instantly (500ms) instead of 3 seconds
                setTimeout(function() {
                    showLiveAdModal(data.ads[0]);
                }, 500);
            }
        })
        .catch(function(e) {
            console.warn('Failed to load live ads', e);
        });
    }

    // ════════════════════════════════════════════════════════════
    // checkLogin
    // ════════════════════════════════════════════════════════════
    function checkLogin() {
        var token = getToken();
        if (!token) { window.location.href = 'login.html'; return false; }
        window._currentToken = token;

        var cacheKey = CACHE_KEYS.LOGIN + token;
        var cached = sessionCacheRead(cacheKey, TTL.LOGIN);

        if (cached && cached.valid) {
            if (cached.user) setUser(cached.user);
            initApp();
            dedupeFetch('https://vqmmsqtlszzugdyoyilu.supabase.co/functions/v1/login-checker', {
                method: 'GET',
                headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }
            })
            .then(function(r) { return r.json(); })
            .then(function(data) {
                sessionCacheWrite(cacheKey, data);
                if (!data.valid) { clearSession(); window.location.href = 'login.html'; }
            })
            .catch(function() { /* keep cached state */ });
            return true;
        }

        dedupeFetch('https://vqmmsqtlszzugdyoyilu.supabase.co/functions/v1/login-checker', {
            method: 'GET',
            headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }
        })
        .then(function(response) {
            return response.text().then(function(text) {
                try { return JSON.parse(text); } catch (e) { throw new Error('Invalid'); }
            });
        })
        .then(function(data) {
            sessionCacheWrite(cacheKey, data);
            if (!data.valid) { clearSession(); window.location.href = 'login.html'; return false; }
            if (data.user) setUser(data.user);
            initApp();
        })
        .catch(function() { clearSession(); window.location.href = 'login.html'; return false; });
        return true;
    }

    var SUPABASE_URL = window.SUPABASE_URL;
    var allFilms = [];
    var currentCategory = 'all';
    var currentTranslator = 'all';
    var visibleCount = 12;
    var SCROLL_STEP = 12;
    var sentinel = null;
    var isLoadingMore = false;
    var firstLoadDone = false;

    var latestGrid = document.getElementById('latestGrid');
    var homeGrid = document.getElementById('homeGrid');
    var translatorContainer = document.getElementById('translatorContainer');
    var myMoviesBadge = document.getElementById('myMoviesBadge');
    var notificationBadge = document.getElementById('notificationBadge');

    function formatPrice(price) { return 'MK ' + Number(price || 0).toLocaleString(); }

    function movieCardHTML(movie, index, eagerLimit) {
        var optimized = optimizePosterUrl(movie.poster_url);
        var thumb = optimizePosterThumb(movie.poster_url);
        var original = movie.poster_url || '';
        var safeOriginal = safeAttr(original);

        var eager = (index !== undefined && index < (eagerLimit || 6));
        var loadingAttr = eager
            ? 'loading="eager" fetchpriority="high"'
            : 'loading="lazy" fetchpriority="low"';

        return '<div class="movie-card" data-id="' + movie.id + '">' +
            (movie.translator_name ? '<div class="translator-badge">' + movie.translator_name + '</div>' : '') +
            '<div class="poster">' +
                '<img src="' + optimized + '" ' +
                     'srcset="' + thumb + ' 250w, ' + optimized + ' 400w" ' +
                     'sizes="(max-width: 480px) 32vw, (max-width: 768px) 30vw, 220px" ' +
                     'alt="' + (movie.title || '') + '" ' +
                     loadingAttr + ' decoding="async" ' +
                     'onload="this.classList.add(\'loaded\'); this.parentElement.classList.add(\'loaded\');" ' +
                     'onerror="this.onerror=null; this.removeAttribute(\'srcset\'); this.src=\'' + safeOriginal + '\'; this.onload=function(){this.classList.add(\'loaded\'); this.parentElement.classList.add(\'loaded\');};">' +
                '<span class="price-tag">' + formatPrice(movie.price) + '</span>' +
                '<span class="badge">' + (movie.quality || 'HD') + '</span>' +
            '</div>' +
            '<div class="info"><h3>' + (movie.title || '') + '</h3></div></div>';
    }

    function emptyStateHTML(type) {
        if (type === 'latest') {
            return '<div class="more-films-coming">' +
                '<div class="icon"><svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 100 20 10 10 0 000-20zm0 18a8 8 0 110-16 8 8 0 010 16zm-1-5h2v2h-2zm0-8h2v6h-2z"/></svg></div>' +
                '<h4>No Latest Films</h4><p>More films coming soon in this category.</p><div class="underline"></div></div>';
        }
        return '<div class="more-films-coming">' +
            '<div class="icon"><svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 100 20 10 10 0 000-20zm0 18a8 8 0 110-16 8 8 0 010 16zm-1-5h2v2h-2zm0-8h2v6h-2z"/></svg></div>' +
            '<h4>More Films Coming</h4><p>We are adding more films. Check back soon!</p><div class="underline"></div></div>';
    }

    function renderGrid(container, items, type, appendFrom, eagerLimit) {
        if (!items || items.length === 0) {
            container.innerHTML = emptyStateHTML(type);
            return;
        }
        var html = '';
        var startIdx = appendFrom || 0;
        var limit = eagerLimit || 6;
        for (var i = 0; i < items.length; i++) {
            html += movieCardHTML(items[i], startIdx + i, limit);
        }
        if (appendFrom) {
            container.insertAdjacentHTML('beforeend', html);
        } else {
            container.innerHTML = html;
        }
    }

    function crossfadeReplace(container, items, type, eagerLimit) {
        container.style.transition = 'opacity 0.22s ease';
        container.style.opacity = '0';
        setTimeout(function() {
            renderGrid(container, items, type, 0, eagerLimit);
            container.style.opacity = '1';
        }, 180);
    }

    function getUniqueTranslators() {
        var seen = {};
        var priority = ['AKILA', 'DENMARK', 'DAT-V'];
        var priorityNormalized = priority.map(function(p) { return p.toLowerCase(); });
        var priorityTranslators = [];
        var otherTranslators = [];

        allFilms.forEach(function(m) {
            if (m.translator_name) {
                var name = m.translator_name.trim();
                var key = name.toLowerCase();
                if (!seen[key]) {
                    seen[key] = true;
                    if (priorityNormalized.indexOf(key) !== -1) priorityTranslators.push(name);
                    else otherTranslators.push(name);
                }
            }
        });

        priorityTranslators.sort(function(a, b) {
            return priorityNormalized.indexOf(a.toLowerCase()) - priorityNormalized.indexOf(b.toLowerCase());
        });

        return priorityTranslators.concat(otherTranslators);
    }

    function renderTranslatorBar() {
        var translators = getUniqueTranslators();
        var html = '<button class="translator-chip active" data-translator="all">All Translators</button>';
        translators.forEach(function(t) {
            html += '<button class="translator-chip" data-translator="' + t + '">' + t + '</button>';
        });
        translatorContainer.innerHTML = html;
        translatorContainer.querySelectorAll('.translator-chip').forEach(function(chip) {
            chip.addEventListener('click', function() {
                translatorContainer.querySelectorAll('.translator-chip').forEach(function(c) { c.classList.remove('active'); });
                this.classList.add('active');
                currentTranslator = this.dataset.translator;
                resetAndRender();
            });
        });
    }

    function matchesCategory(movie, category) {
        if (category === 'all') return true;
        if (!movie.category) return false;
        var cats = movie.category.split(',').map(function(s) { return s.trim().toLowerCase(); });
        return cats.indexOf(category.toLowerCase()) !== -1;
    }

    function passesTranslator(movie) {
        if (currentTranslator === 'all') return true;
        return (movie.translator_name || '').trim().toLowerCase() === currentTranslator.toLowerCase();
    }

    function getLatestFilms() {
        return allFilms.filter(function(m) {
            return m.latest === true && matchesCategory(m, currentCategory) && passesTranslator(m);
        });
    }

    function getAllFilms() {
        return allFilms.filter(function(m) {
            return m.latest !== true && matchesCategory(m, currentCategory) && passesTranslator(m);
        });
    }

    function renderAll() {
        var latest = getLatestFilms();
        renderGrid(latestGrid, latest, 'latest', 0, 8);

        var all = getAllFilms();
        var visibleItems = all.slice(0, visibleCount);
        renderGrid(homeGrid, visibleItems, 'all', 0, 4);
    }

    function resetAndRender() {
        visibleCount = 12;
        var latest = getLatestFilms();
        var all = getAllFilms();
        var visibleItems = all.slice(0, visibleCount);
        crossfadeReplace(latestGrid, latest, 'latest', 8);
        setTimeout(function() {
            crossfadeReplace(homeGrid, visibleItems, 'all', 4);
        }, 60);
    }

    function loadMyMoviesBadge() {
        var token = getToken();
        if (!token) return;
        var cacheKey = CACHE_KEYS.MYMOVIES + token;

        var cached = sessionCacheRead(cacheKey, TTL.MYMOVIES);
        if (cached && cached.success) {
            myMoviesBadge.textContent = (cached.films || []).length;
        }

        dedupeFetch(`${SUPABASE_URL}/functions/v1/my-film-api`, {
            method: 'GET',
            headers: { 'Authorization': 'Bearer ' + token }
        })
        .then(function(r) { return r.json(); })
        .then(function(data) {
            sessionCacheWrite(cacheKey, data);
            if (data.success) myMoviesBadge.textContent = data.films.length;
        })
        .catch(function(e) {
            console.error('Badge error', e);
            if (!cached) myMoviesBadge.textContent = '0';
        });
    }

    function loadNotifications() {
        notificationBadge.textContent = '0';
    }

    function fetchMovies() {
        var token = getToken();
        var cachedFilms = cacheRead(CACHE_KEYS.FILMS, TTL.FILMS);

        if (cachedFilms && cachedFilms.movies && cachedFilms.movies.length) {
            allFilms = cachedFilms.movies.slice();
            renderTranslatorBar();
            var latest = getLatestFilms();
            var all = getAllFilms();
            var visibleItems = all.slice(0, visibleCount);
            if (!firstLoadDone) {
                firstLoadDone = true;
                crossfadeReplace(latestGrid, latest, 'latest', 8);
                setTimeout(function() {
                    crossfadeReplace(homeGrid, visibleItems, 'all', 4);
                }, 60);
            } else {
                renderAll();
            }
            initSearch();
            initInfiniteScroll();
            loadMyMoviesBadge();
            loadNotifications();

            backgroundFetchMovies(token);
            return;
        }

        return dedupeFetch(`${SUPABASE_URL}/functions/v1/films-api`, {
            method: 'GET',
            headers: { 'Authorization': 'Bearer ' + token }
        })
        .then(function(r) { return r.json(); })
        .then(function(data) {
            if (!data || data.error) throw new Error(data.error || 'Failed');
            allFilms = (data.movies || []).slice();
            cacheWrite(CACHE_KEYS.FILMS, data);
            renderTranslatorBar();

            if (!firstLoadDone) {
                firstLoadDone = true;
                var latest = getLatestFilms();
                var all = getAllFilms();
                var visibleItems = all.slice(0, visibleCount);
                crossfadeReplace(latestGrid, latest, 'latest', 8);
                setTimeout(function() {
                    crossfadeReplace(homeGrid, visibleItems, 'all', 4);
                }, 60);
            } else {
                renderAll();
            }

            initSearch();
            initInfiniteScroll();
            loadMyMoviesBadge();
            loadNotifications();
        })
        .catch(function(error) {
            console.error('Fetch error', error);
            latestGrid.innerHTML = emptyStateHTML('latest');
            homeGrid.innerHTML = emptyStateHTML('all');
        });
    }

    function backgroundFetchMovies(token) {
        dedupeFetch(`${SUPABASE_URL}/functions/v1/films-api`, {
            method: 'GET',
            headers: { 'Authorization': 'Bearer ' + token }
        })
        .then(function(r) { return r.json(); })
        .then(function(data) {
            if (!data || data.error) return;
            cacheWrite(CACHE_KEYS.FILMS, data);
            var oldSig = (allFilms[0] && allFilms[0].id) + '|' + allFilms.length;
            var newSig = (data.movies[0] && data.movies[0].id) + '|' + data.movies.length;
            if (oldSig !== newSig) {
                allFilms = (data.movies || []).slice();
                renderTranslatorBar();
                renderAll();
            }
        })
        .catch(function() { /* silent */ });
    }

    function initInfiniteScroll() {
        sentinel = document.getElementById('scrollSentinel');
        if (!sentinel) return;
        var observer = new IntersectionObserver(function(entries) {
            if (entries[0].isIntersecting && !isLoadingMore) {
                isLoadingMore = true;
                setTimeout(function() {
                    var all = getAllFilms();
                    if (visibleCount < all.length) {
                        var fromIdx = visibleCount;
                        visibleCount += SCROLL_STEP;
                        renderGrid(homeGrid, all.slice(fromIdx, visibleCount), 'all', fromIdx, 2);
                    }
                    isLoadingMore = false;
                }, 400);
            }
        }, { root: null, rootMargin: '0px', threshold: 0.1 });
        observer.observe(sentinel);
    }

    function initSearch() {
        var searchNavBtn = document.getElementById('searchNavBtn');
        var searchSubheader = document.getElementById('searchSubheader');
        var searchInput = document.getElementById('searchInput');
        var searchResults = document.getElementById('searchResults');
        if (!searchNavBtn || searchNavBtn._bound) return;
        searchNavBtn._bound = true;

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
                var filtered = allFilms.filter(function(m) {
                    return (m.title && m.title.toLowerCase().includes(query)) ||
                           (m.translator_name && m.translator_name.toLowerCase().includes(query));
                });
                if (filtered.length > 0) {
                    searchResults.innerHTML = filtered.map(function(m) {
                        return '<div class="result-item" data-id="' + m.id + '">' + m.title + '</div>';
                    }).join('');
                } else {
                    searchResults.innerHTML = '<div class="result-item">No results</div>';
                }
                searchResults.classList.add('visible');
            }, 220);
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

    function initCategories() {
        var chips = document.querySelectorAll('#subheader .category-chip');
        chips.forEach(function(chip) {
            chip.addEventListener('click', function() {
                chips.forEach(function(c) { c.classList.remove('active'); });
                this.classList.add('active');
                currentCategory = this.dataset.category;
                resetAndRender();
            });
        });
    }

    function initCardClick() {
        document.querySelectorAll('.movie-grid').forEach(function(grid) {
            grid.addEventListener('click', function(e) {
                var card = e.target.closest('.movie-card');
                if (!card) return;
                if (card.querySelector('.card-loading')) return;
                var loadingDiv = document.createElement('div');
                loadingDiv.className = 'card-loading';
                loadingDiv.innerHTML = '<div class="card-spinner"></div>';
                card.appendChild(loadingDiv);
                var movieId = card.dataset.id;
                setTimeout(function() {
                    window.location.href = 'view-film.html?id=' + movieId;
                }, 250);
            });
        });
    }

    function initNavMovies() {
        var navMovies = document.getElementById('navMovies');
        if (navMovies) {
            navMovies.addEventListener('click', function(e) {
                e.preventDefault();
                window.scrollTo({ top: 0, behavior: 'smooth' });
            });
        }
    }

    function initScrollEffects() {
        var header = document.getElementById('mainHeader');
        var subheader = document.getElementById('subheader');
        var translatorBar = document.getElementById('translatorBar');

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
                    subheader.classList.remove('hidden');
                    translatorBar.classList.remove('hidden');
                    isHidden = false;
                }
            } else if (delta > 6 && !isHidden) {
                header.classList.add('hidden');
                subheader.classList.add('hidden');
                translatorBar.classList.add('hidden');
                isHidden = true;
            } else if (delta < -6 && isHidden) {
                header.classList.remove('hidden');
                subheader.classList.remove('hidden');
                translatorBar.classList.remove('hidden');
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

    function initMaintenanceBanner() {
        var banner = document.getElementById('maintenanceBanner');
        var closeBtn = document.getElementById('maintenanceClose');
        var clockEl = document.getElementById('malawiClock');
        if (!banner) return;

        var STORAGE_KEY = 'akimark_maintenance_dismissed';
        var DISMISS_DURATION = 30 * 60 * 1000;
        var isAnimating = false;

        function updateClock() {
            if (!clockEl) return;
            var now = new Date();
            var malawi = new Date(now.getTime() + (now.getTimezoneOffset() * 60000) + (2 * 3600000));
            var h = String(malawi.getHours()).padStart(2, '0');
            var m = String(malawi.getMinutes()).padStart(2, '0');
            clockEl.textContent = h + ':' + m;
        }
        updateClock();
        setInterval(updateClock, 30000);

        function isDismissed() {
            try {
                var raw = localStorage.getItem(STORAGE_KEY);
                if (!raw) return false;
                var ts = parseInt(raw, 10);
                if (isNaN(ts)) return false;
                return (Date.now() - ts) < DISMISS_DURATION;
            } catch (e) { return false; }
        }

        function markDismissed() {
            try { localStorage.setItem(STORAGE_KEY, String(Date.now())); } catch (e) {}
        }

        function showBanner() {
            if (isAnimating) return;
            isAnimating = true;
            banner.classList.add('hide');
            banner.style.maxHeight = '0px';
            banner.style.opacity = '0';
            banner.style.transition = 'max-height 0.45s cubic-bezier(0.2,0,0,1), opacity 0.35s ease';
            void banner.offsetHeight;
            requestAnimationFrame(function() {
                banner.style.maxHeight = banner.scrollHeight + 'px';
                banner.style.opacity = '1';
                setTimeout(function() {
                    banner.style.maxHeight = '';
                    isAnimating = false;
                }, 500);
            });
        }

        function hideBanner() {
            if (isAnimating) return;
            isAnimating = true;
            banner.style.transition = 'max-height 0.35s cubic-bezier(0.4,0,1,1), opacity 0.25s ease';
            banner.style.maxHeight = banner.scrollHeight + 'px';
            void banner.offsetHeight;
            requestAnimationFrame(function() {
                banner.style.maxHeight = '0px';
                banner.style.opacity = '0';
                setTimeout(function() {
                    banner.classList.remove('visible');
                    banner.style.maxHeight = '';
                    banner.style.opacity = '';
                    banner.style.transition = '';
                    isAnimating = false;
                }, 380);
            });
        }

        if (closeBtn) {
            closeBtn.addEventListener('click', function(e) {
                e.preventDefault();
                markDismissed();
                hideBanner();
            });
        }

        if (!isDismissed()) {
            setTimeout(showBanner, 400);
        }
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
        document.addEventListener('keyup', function(e) {
            if (e.key === 'PrintScreen') {
                var wm = document.getElementById('watermark');
                if (wm) {
                    wm.classList.add('active');
                    setTimeout(function() { wm.classList.remove('active'); }, 1000);
                }
            }
        });
    }

    function initApp() {
        initCategories();
        initCardClick();
        initSecurity();
        initNavMovies();
        initScrollEffects();
        initMaintenanceBanner();
        fetchMovies();
        fetchLiveAds(); // 🆕 Izi zimayitanitsa ma Ads kuti awonekere msanga
    }

    function init() { checkLogin(); }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

    window.AkimarkImages = {
        optimize: optimizePosterUrl,
        thumb: optimizePosterThumb,
        WIDTH: POSTER_WIDTH,
        QUALITY: POSTER_QUALITY
    };

    window.AkimarkCache = {
        clearAll: function() {
            safeRemove(localStorage, CACHE_KEYS.FILMS);
            safeRemove(localStorage, CACHE_KEYS.ADS);
            var token = getToken();
            if (token) {
                safeRemove(sessionStorage, CACHE_KEYS.LOGIN + token);
                safeRemove(sessionStorage, CACHE_KEYS.MYMOVIES + token);
            }
        },
        clearFilms: function() { safeRemove(localStorage, CACHE_KEYS.FILMS); },
        stats: function() {
            return {
                films_cached: !!cacheRead(CACHE_KEYS.FILMS, TTL.FILMS),
                inflight: Object.keys(inflight).length,
            };
        }
    };
})();
