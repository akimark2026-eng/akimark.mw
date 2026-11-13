// home.js (v29 — Pro Multi-Layer Cache + Latest Expand/Collapse)
// Upgraded: Latest See All toggles, Back to Top, Smooth Transitions

(function() {
    'use strict';

    var TOKEN_KEY = 'akmark_token';
    var USER_KEY = 'akmark_user';

    var POSTER_WIDTH = 400;
    var POSTER_QUALITY = 70;
    var PAGE_SIZE = 50;
    var BG_FETCH_SIZE = 100; 

    var CORE_TRANSLATORS = ['AKILA', 'DENMARK', 'DAT-V'];

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

    var CACHE_KEYS = {
        FILMS:         'akmark_cache_films_v3',
        TRANSLATORS:   'akmark_cache_translators_v3',
        LOGIN:         'akmark_cache_login_',       
        MYMOVIES:      'akmark_cache_mymovies_',    
        ADS:           'akmark_cache_ads_v1'        
    };
    var TTL = {
        FILMS:     5 * 60 * 1000,  
        TRANSLATORS: 30 * 60 * 1000, 
        LOGIN:     60 * 1000,      
        MYMOVIES:  30 * 1000,      
        ADS:       2 * 60 * 1000   
    };

    function safeGet(storage, key) {
        try { return storage.getItem(key); } catch (e) { return null; }
    }
    function safeSet(storage, key, val) {
        try { storage.setItem(key, val); } catch (e) { }
    }
    function safeRemove(storage, key) {
        try { storage.removeItem(key); } catch (e) {}
    }

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

    function getToken() {
        var token = safeGet(localStorage, TOKEN_KEY) || safeGet(sessionStorage, TOKEN_KEY) || getCookie(TOKEN_KEY);
        if (!token || token === 'null' || token === 'undefined') return null;
        try {
            var parsed = JSON.parse(token);
            if (parsed && parsed.access_token) return parsed.access_token;
            if (typeof parsed === 'string') return parsed;
        } catch(e) {}
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
        safeRemove(localStorage, TOKEN_KEY);
        safeRemove(sessionStorage, TOKEN_KEY);
        safeRemove(localStorage, 'akmark_refresh_token');
        safeRemove(sessionStorage, 'akmark_refresh_token');
        safeRemove(localStorage, USER_KEY);
        eraseCookie(TOKEN_KEY);
        eraseCookie('akmark_user_logged');
        
        if (window._currentToken) {
            safeRemove(sessionStorage, CACHE_KEYS.LOGIN + window._currentToken);
            safeRemove(sessionStorage, CACHE_KEYS.MYMOVIES + window._currentToken);
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

    function checkLogin() {
        var token = getToken();
        if (!token) { 
            window.location.href = 'login.html'; 
            return false; 
        }
        window._currentToken = token;
        setTokenInAllPlaces(token);

        var cacheKey = CACHE_KEYS.LOGIN + token;
        var cached = sessionCacheRead(cacheKey, TTL.LOGIN);

        if (cached && cached.valid) {
            if (cached.user) setUser(cached.user);
            initApp(); 
        } else {
            initApp(); 
        }
        
        dedupeFetch('https://vqmmsqtlszzugdyoyilu.supabase.co/functions/v1/login-checker', {
            method: 'GET',
            headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }
        })
        .then(function(r) {
            if (r.status === 401 || r.status === 403) {
                handleAuthError(r.status);
            } else if (r.ok) {
                return r.json().then(function(data) {
                    sessionCacheWrite(cacheKey, data);
                    if (!data.valid) { 
                        clearSession(); 
                        window.location.href = 'login.html'; 
                    } else if (data.user) {
                        setUser(data.user);
                    }
                });
            }
        })
        .catch(function(err) { console.warn('Auth check ignored:', err); });
        
        return true;
    }

    function showLiveAdModal(ad) {
        if (document.getElementById('liveAdOverlay')) return;

        var style = document.createElement('style');
        style.id = 'liveAdStyles';
        style.innerHTML = `
            #liveAdOverlay { position: fixed; inset: 0; z-index: 999999; background: rgba(0,0,0,0.9); backdrop-filter: blur(10px); display: flex; align-items: center; justify-content: center; padding: 16px; opacity: 0; transition: opacity 0.3s ease; }
            #liveAdOverlay.show { opacity: 1; }
            .live-ad-card { background: #121212; width: 100%; max-width: 420px; border-radius: 20px; overflow: hidden; position: relative; border: 1px solid #333; box-shadow: 0 20px 50px rgba(199, 21, 21, 0.3); transform: scale(0.9) translateY(20px); transition: all 0.4s cubic-bezier(0.34, 1.56, 0.64, 1); display: flex; flex-direction: column; }
            #liveAdOverlay.show .live-ad-card { transform: scale(1) translateY(0); }
            .live-ad-close { position: absolute; top: 12px; right: 12px; z-index: 10; background: rgba(0,0,0,0.6); color: #fff; border: 1px solid rgba(255,255,255,0.2); width: 34px; height: 34px; border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer; backdrop-filter: blur(4px); transition: 0.2s; font-size: 16px; }
            .live-ad-close:hover { background: #c71515; border-color: #c71515; transform: rotate(90deg); }
            .live-ad-poster-wrap { width: 100%; max-height: 380px; overflow: hidden; position: relative; background: #000; display: flex; align-items: center; justify-content: center; border-bottom: 3px solid #c71515; }
            .live-ad-poster { width: 100%; height: auto; max-height: 380px; object-fit: contain; display: block; }
            .live-ad-badge { position: absolute; top: 16px; left: 16px; background: #c71515; color: #fff; padding: 6px 12px; border-radius: 20px; font-size: 12px; font-weight: 800; display: flex; align-items: center; gap: 6px; letter-spacing: 0.5px; box-shadow: 0 4px 15px rgba(199, 21, 21, 0.5); }
            .live-dot { width: 8px; height: 8px; background: #fff; border-radius: 50%; animation: pulseLive 1s infinite alternate; }
            @keyframes pulseLive { 0% { opacity: 1; transform: scale(1); } 100% { opacity: 0.4; transform: scale(1.5); } }
            .live-ad-content { padding: 24px 20px; text-align: center; background: #121212; }
            .live-ad-title { font-family: 'Lexend', system-ui, sans-serif; font-size: 20px; font-weight: 800; color: #ffffff; margin-bottom: 10px; line-height: 1.3; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
            .live-ad-subtitle { font-size: 14px; color: #a1a1aa; margin-bottom: 24px; font-weight: 500; }
            .live-ad-btn { background: #c71515; color: #fff; border: none; width: 100%; padding: 16px; border-radius: 12px; font-size: 16px; font-weight: 800; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px; text-decoration: none; transition: 0.2s; letter-spacing: 0.5px; box-shadow: 0 6px 20px rgba(199, 21, 21, 0.4); }
            .live-ad-btn:hover { background: #a31010; }
            .live-ad-btn:active { transform: scale(0.97); }
            .live-ad-timer-wrap { height: 5px; background: #333; width: 100%; border-bottom-left-radius: 20px; border-bottom-right-radius: 20px; overflow: hidden; }
            .live-ad-timer { height: 100%; background: #c71515; width: 100%; transform-origin: left; animation: timerBar 10s linear forwards; }
            @keyframes timerBar { 0% { transform: scaleX(1); } 100% { transform: scaleX(0); } }
        `;
        document.head.appendChild(style);

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
                <div class="live-ad-timer-wrap"><div class="live-ad-timer"></div></div>
            </div>
        `;
        document.body.appendChild(overlay);

        requestAnimationFrame(function() { overlay.classList.add('show'); });
        window._liveAdTimeout = setTimeout(function() { window.closeLiveAd(); }, 10000);
    }

    window.closeLiveAd = function() {
        var overlay = document.getElementById('liveAdOverlay');
        if (!overlay) return;
        overlay.classList.remove('show');
        clearTimeout(window._liveAdTimeout);
        setTimeout(function() { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }, 400);
    };

    function fetchLiveAds() {
        var cachedAds = cacheRead(CACHE_KEYS.ADS, TTL.ADS);
        if (cachedAds && cachedAds.length > 0) {
            setTimeout(function() { showLiveAdModal(cachedAds[0]); }, 500);
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
                setTimeout(function() { showLiveAdModal(data.ads[0]); }, 500);
            }
        })
        .catch(function(e) { console.warn('Failed to load live ads', e); });
    }

    var SUPABASE_URL = window.SUPABASE_URL;
    
    var allFilms = [];             
    var translatorMemoryCache = {}; 
    var translatorOffsets = {};    
    var translatorHasMoreMap = {}; 
    var fetchingTranslators = {};  

    var translatorCache = [];      
    var currentCategory = 'all';
    var currentTranslator = 'all';
    
    var visibleCount = 12;
    var SCROLL_STEP = 12;
    var sentinel = null;
    var isLoadingMore = false;
    var firstLoadDone = false;

    var allFilmsOffset = 0;
    var allFilmsHasMore = true;
    var isFetchingMoreAll = false;

    // 🎯 LATEST EXPAND STATE
    var isLatestExpanded = false;
    var latestSeeAllBtn = document.getElementById('latestSeeAllBtn');
    var latestSeeAllText = document.getElementById('latestSeeAllText');
    var latestSeeAllIcon = document.getElementById('latestSeeAllIcon');

    var latestGrid = document.getElementById('latestGrid');
    var homeGrid = document.getElementById('homeGrid');
    var translatorContainer = document.getElementById('translatorContainer');

    // 🎯 TRENDING VARIABLES
    var trendingSection = document.getElementById('trendingSection');
    var trendingGrid = document.getElementById('trendingGrid');
    var trendingTabGrid = document.getElementById('trendingTabGrid');
    var trendingSeeAllBtn = document.getElementById('trendingSeeAllBtn');
    var trendingFullScreenTab = document.getElementById('trendingFullScreenTab');
    var closeTrendingTab = document.getElementById('closeTrendingTab');
    var allTrendingFilms = [];

    function formatPrice(price) { return 'MK ' + Number(price || 0).toLocaleString(); }

    function movieCardHTML(movie, index, eagerLimit) {
        var optimized = optimizePosterUrl(movie.poster_url);
        var thumb = optimizePosterThumb(movie.poster_url);
        var original = movie.poster_url || '';
        var safeOriginal = safeAttr(original);

        var eager = (index !== undefined && index < (eagerLimit || 6));
        var loadingAttr = eager ? 'loading="eager" fetchpriority="high"' : 'loading="lazy" fetchpriority="low"';

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
            return '<div class="more-films-coming"><div class="icon"><svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 100 20 10 10 0 000-20zm0 18a8 8 0 110-16 8 8 0 010 16zm-1-5h2v2h-2zm0-8h2v6h-2z"/></svg></div><h4>No Latest Films</h4><p>More films coming soon in this category.</p><div class="underline"></div></div>';
        }
        return '<div class="more-films-coming"><div class="icon"><svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 100 20 10 10 0 000-20zm0 18a8 8 0 110-16 8 8 0 010 16zm-1-5h2v2h-2zm0-8h2v6h-2z"/></svg></div><h4>More Films Coming</h4><p>We are adding more films. Check back soon!</p><div class="underline"></div></div>';
    }

    function renderGrid(container, items, type, appendFrom, eagerLimit) {
        if (!items || items.length === 0) {
            if (!appendFrom) container.innerHTML = emptyStateHTML(type);
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
        if (!container) return;
        container.style.transition = 'opacity 0.15s ease-out';
        container.style.opacity = '0';
        
        setTimeout(function() {
            renderGrid(container, items, type, 0, eagerLimit);
            container.style.transition = 'opacity 0.15s ease-in';
            container.style.opacity = '1';
        }, 150);
    }

    function extractTranslatorsFromFilms(films) {
        var seen = {};
        films.forEach(function(m) {
            if (m.translator_name) {
                var name = m.translator_name.trim();
                if (name) seen[name.toLowerCase()] = name;
            }
        });
        return Object.values(seen);
    }

    // 🎯 FETCH TRENDING FILMS FROM API
    function fetchTrendingFilms() {
        var trendUrl = SUPABASE_URL + '/functions/v1/trend-api?t=' + Date.now(); // Cache buster
        dedupeFetch(trendUrl, { method: 'GET' })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            allTrendingFilms = data.movies || data.data || [];
            renderTrending();
        })
        .catch(function(err) {
            console.warn('Trend fetch failed', err);
            if (trendingSection) trendingSection.style.display = 'none';
        });
    }

    // 🎯 RENDER TRENDING
    function renderTrending() {
        if (!trendingSection || !trendingGrid) return;

        var filteredTrending = allTrendingFilms;
        if (currentTranslator !== 'all') {
            filteredTrending = allTrendingFilms.filter(function(m) {
                return m.translator_name && m.translator_name.toUpperCase() === currentTranslator.toUpperCase();
            });
        }

        if (filteredTrending.length === 0) {
            trendingSection.style.display = 'none';
            return;
        }

        trendingSection.style.display = 'block';

        var html = '';
        filteredTrending.forEach(function(m, index) {
            html += `
                <div class="trending-card" onclick="window.location.href='view-film.html?id=${m.id}'">
                    <div class="trending-poster">
                        <img src="${m.poster_url || 'images/default-poster.jpg'}" alt="${m.title}" onerror="this.src='images/default-poster.jpg'" class="loaded">
                        <div class="trending-play">
                            <svg viewBox="0 0 24 24" width="16" height="16"><path d="M8 5v14l11-7z"/></svg>
                        </div>
                        <span class="trending-rank">#${index + 1}</span>
                    </div>
                    <div class="trending-info">
                        <h3>${m.title}</h3>
                        <p>${m.translator_name || 'Akila Voice'} • MK ${m.price || 0}</p>
                    </div>
                </div>
            `;
        });
        trendingGrid.innerHTML = html;

        if (trendingTabGrid) trendingTabGrid.innerHTML = html;

        if (trendingSeeAllBtn && !trendingSeeAllBtn._bound) {
            trendingSeeAllBtn._bound = true;
            trendingSeeAllBtn.addEventListener('click', function() {
                trendingFullScreenTab.classList.add('active');
            });
        }
        if (closeTrendingTab && !closeTrendingTab._bound) {
            closeTrendingTab._bound = true;
            closeTrendingTab.addEventListener('click', function() {
                trendingFullScreenTab.classList.remove('active');
            });
        }
    }

    function fetchAllTranslators() {
        var cachedTranslators = cacheRead(CACHE_KEYS.TRANSLATORS, TTL.TRANSLATORS);
        var finalTranslators = [];

        CORE_TRANSLATORS.forEach(function(t) {
            finalTranslators.push(t);
        });

        if (cachedTranslators && cachedTranslators.length > 0) {
            cachedTranslators.forEach(function(t) {
                if (!finalTranslators.some(function(ft) { return ft.toLowerCase() === t.toLowerCase(); })) {
                    finalTranslators.push(t);
                }
            });
        }

        translatorCache = finalTranslators;
        renderTranslatorBar();

        var fetchUrl = SUPABASE_URL + '/functions/v1/films-api?limit=150&offset=0';
        dedupeFetch(fetchUrl, {
            method: 'GET',
            headers: { 'Authorization': 'Bearer ' + getToken() }
        })
        .then(function(r) { return r.json(); })
        .then(function(data) {
            if (!data || data.error) return;
            var films = data.movies || [];
            var fetchedTranslators = extractTranslatorsFromFilms(films);
            
            var newFound = false;
            fetchedTranslators.forEach(function(t) {
                if (!translatorCache.some(function(existing) { return existing.toLowerCase() === t.toLowerCase(); })) {
                    translatorCache.push(t);
                    newFound = true;
                }
            });

            if (newFound) {
                cacheWrite(CACHE_KEYS.TRANSLATORS, translatorCache);
                renderTranslatorBar(); 
            }
        })
        .catch(function(e) { console.warn('Background translator fetch failed:', e); });
    }

    // 🎯 RANDOMIZATION FUNCTION (Fisher-Yates Shuffle)
    function shuffleArray(array) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
        return array;
    }

    function renderTranslatorBar() {
        if (!translatorContainer) return;

        var priority = CORE_TRANSLATORS.map(function(p) { return p.toLowerCase(); });
        var priorityTranslators = [];
        var otherTranslators = [];

        translatorCache.forEach(function(name) {
            var key = name.toLowerCase();
            if (priority.indexOf(key) !== -1) priorityTranslators.push(name);
            else otherTranslators.push(name);
        });

        priorityTranslators.sort(function(a, b) {
            return priority.indexOf(a.toLowerCase()) - priority.indexOf(b.toLowerCase());
        });
        
        shuffleArray(otherTranslators); 

        var allSorted = priorityTranslators.concat(otherTranslators);

        var html = '<button class="translator-chip ' + (currentTranslator === 'all' ? 'active' : '') + '" data-translator="all">All</button>';
        allSorted.forEach(function(t) {
            var isActive = (currentTranslator === t) ? 'active' : '';
            html += '<button class="translator-chip ' + isActive + '" data-translator="' + safeAttr(t) + '">' + safeAttr(t) + '</button>';
        });
        
        if (translatorContainer.innerHTML !== html) {
            translatorContainer.innerHTML = html;
            translatorContainer.querySelectorAll('.translator-chip').forEach(function(chip) {
                chip.addEventListener('click', function() {
                    if (currentTranslator === this.dataset.translator) return; 
                    translatorContainer.querySelectorAll('.translator-chip').forEach(function(c) { c.classList.remove('active'); });
                    this.classList.add('active');
                    currentTranslator = this.dataset.translator;
                    resetAndRender();
                });
            });
        }
    }

    function matchesCategory(movie, category) {
        if (category === 'all') return true;
        if (!movie.category) return false;
        var cats = movie.category.split(',').map(function(s) { return s.trim().toLowerCase(); });
        return cats.indexOf(category.toLowerCase()) !== -1;
    }

    function getActiveSource() {
        if (currentTranslator === 'all') return allFilms;
        return translatorMemoryCache[currentTranslator] || [];
    }

    function getLatestFilms() {
        return getActiveSource().filter(function(m) { return m.latest === true && matchesCategory(m, currentCategory); });
    }

    // 🎯 Function yosankha ma Latest Films mwachisawawa (Randomly)
    function getRandomLatestFilms(limit) {
        var latest = getLatestFilms();
        for (var i = latest.length - 1; i > 0; i--) {
            var j = Math.floor(Math.random() * (i + 1));
            var temp = latest[i];
            latest[i] = latest[j];
            latest[j] = temp;
        }
        return latest.slice(0, limit || 6);
    }

    function getAllFilms() {
        return getActiveSource().filter(function(m) { return m.latest !== true && matchesCategory(m, currentCategory); });
    }

    // 🎯 RENDER ALL (Including Latest logic)
    function renderAll() {
        var latestAll = getLatestFilms();
        
        // Check if we should show the See All button
        if (latestSeeAllBtn) {
            if (latestAll.length > 6) {
                latestSeeAllBtn.style.display = 'flex';
            } else {
                latestSeeAllBtn.style.display = 'none';
                isLatestExpanded = false; // Reset if not enough items
                latestSeeAllText.textContent = 'See All';
                latestSeeAllIcon.style.transform = 'rotate(0deg)';
            }
        }

        var limit = isLatestExpanded ? latestAll.length : 6;
        crossfadeReplace(latestGrid, getRandomLatestFilms(limit), 'latest', 6);
        
        renderTrending();

        setTimeout(function() {
            crossfadeReplace(homeGrid, getAllFilms().slice(0, visibleCount), 'all', 4);
        }, 50);
    }

    function resetAndRender() {
        visibleCount = 12;
        renderAll();

        if (currentTranslator !== 'all') {
            fetchTranslatorFilms(currentTranslator, false);
        }
    }

    function fetchTranslatorFilms(translatorName, isLoadMore) {
        if (fetchingTranslators[translatorName]) return; 
        fetchingTranslators[translatorName] = true;

        var offset = isLoadMore ? (translatorOffsets[translatorName] || 0) : 0;
        var url = SUPABASE_URL + '/functions/v1/films-api?limit=' + PAGE_SIZE + '&offset=' + offset + '&translator=' + encodeURIComponent(translatorName);

        return dedupeFetch(url, {
            method: 'GET',
            headers: { 'Authorization': 'Bearer ' + getToken() }
        })
        .then(function(r) { return r.json(); })
        .then(function(data) {
            if (!data || data.error) throw new Error(data.error || 'Failed');
            
            var newMovies = data.movies || [];
            var existing = translatorMemoryCache[translatorName] || [];

            if (isLoadMore) {
                translatorMemoryCache[translatorName] = existing.concat(newMovies);
            } else {
                translatorMemoryCache[translatorName] = newMovies;
            }

            translatorHasMoreMap[translatorName] = newMovies.length === PAGE_SIZE;
            translatorOffsets[translatorName] = translatorMemoryCache[translatorName].length;

            if (currentTranslator === translatorName) {
                if (isLoadMore) {
                    var all = getAllFilms();
                    var fromIdx = visibleCount;
                    visibleCount += SCROLL_STEP;
                    renderGrid(homeGrid, all.slice(fromIdx, visibleCount), 'all', fromIdx, 2);
                } else {
                    renderAll();
                }
            }
        })
        .catch(function(e) { console.warn('Failed to fetch translator films', e); })
        .finally(function() { fetchingTranslators[translatorName] = false; });
    }

    function fetchMovies(isLoadMore) {
        if (isLoadMore && isFetchingMoreAll) return Promise.resolve();
        if (isLoadMore) isFetchingMoreAll = true;

        var token = getToken();
        var cachedFilms = cacheRead(CACHE_KEYS.FILMS, TTL.FILMS);

        if (!isLoadMore && currentTranslator === 'all' && cachedFilms && cachedFilms.movies && cachedFilms.movies.length) {
            allFilms = cachedFilms.movies.slice();
            allFilmsOffset = allFilms.length;
            allFilmsHasMore = true; 
            
            if (!firstLoadDone) {
                firstLoadDone = true;
                renderAll();
            } else {
                renderAll();
            }
            
            initSearch();
            initInfiniteScroll();
            backgroundFetchMovies(token);
            return Promise.resolve();
        }

        var fetchUrl = SUPABASE_URL + '/functions/v1/films-api?limit=' + PAGE_SIZE + '&offset=' + (isLoadMore ? allFilmsOffset : 0);
        
        return dedupeFetch(fetchUrl, {
            method: 'GET',
            headers: { 'Authorization': 'Bearer ' + token }
        })
        .then(function(r) { return r.json(); })
        .then(function(data) {
            if (!data || data.error) throw new Error(data.error || 'Failed');
            
            var newMovies = data.movies || [];
            
            if (isLoadMore) {
                allFilms = allFilms.concat(newMovies);
            } else {
                allFilms = newMovies;
            }

            allFilmsHasMore = newMovies.length === PAGE_SIZE;
            allFilmsOffset = allFilms.length;

            if (!isLoadMore) {
                cacheWrite(CACHE_KEYS.FILMS, { movies: allFilms.slice(0, PAGE_SIZE) });
            }

            if (currentTranslator === 'all') {
                if (!firstLoadDone) {
                    firstLoadDone = true;
                    renderAll();
                } else if (isLoadMore) {
                    var all = getAllFilms();
                    var fromIdx = visibleCount;
                    visibleCount += SCROLL_STEP;
                    renderGrid(homeGrid, all.slice(fromIdx, visibleCount), 'all', fromIdx, 2);
                } else {
                    renderAll();
                }
            }

            if (!isLoadMore) {
                initSearch();
                initInfiniteScroll();
            }
        })
        .catch(function(error) {
            console.error('Fetch error', error);
            if (!isLoadMore && !firstLoadDone) {
                latestGrid.innerHTML = emptyStateHTML('latest');
                homeGrid.innerHTML = emptyStateHTML('all');
            }
        })
        .finally(function() {
            if (isLoadMore) isFetchingMoreAll = false;
        });
    }

    function backgroundFetchMovies(token) {
        dedupeFetch(SUPABASE_URL + '/functions/v1/films-api?limit=' + PAGE_SIZE + '&offset=0', {
            method: 'GET',
            headers: { 'Authorization': 'Bearer ' + token }
        })
        .then(function(r) { return r.json(); })
        .then(function(data) {
            if (!data || data.error) return;
            var newMovies = data.movies || [];
            
            if (newMovies[0] && allFilms[0] && newMovies[0].id !== allFilms[0].id) {
                var existingIds = new Set(allFilms.map(function(f) { return f.id; }));
                var trulyNew = newMovies.filter(function(f) { return !existingIds.has(f.id); });
                
                if (trulyNew.length > 0) {
                    allFilms = trulyNew.concat(allFilms);
                    if (currentTranslator === 'all') renderAll();
                }
            }
        })
        .catch(function() { });
    }

    function initInfiniteScroll() {
        sentinel = document.getElementById('scrollSentinel');
        if (!sentinel || sentinel._bound) return;
        sentinel._bound = true;
        
        var observer = new IntersectionObserver(function(entries) {
            if (entries[0].isIntersecting && !isLoadingMore) {
                isLoadingMore = true;
                
                var all = getAllFilms();
                
                if (visibleCount < all.length) {
                    setTimeout(function() {
                        var fromIdx = visibleCount;
                        visibleCount += SCROLL_STEP;
                        renderGrid(homeGrid, all.slice(fromIdx, visibleCount), 'all', fromIdx, 2);
                        isLoadingMore = false;
                    }, 150);
                } else if (currentTranslator !== 'all' && translatorHasMoreMap[currentTranslator]) {
                    isLoadingMore = false;
                    fetchTranslatorFilms(currentTranslator, true);
                } else if (currentTranslator === 'all' && allFilmsHasMore) {
                    isLoadingMore = false;
                    fetchMovies(true);
                } else {
                    isLoadingMore = false;
                }
            }
        }, { root: null, rootMargin: '100px', threshold: 0.1 });
        observer.observe(sentinel);
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

        searchNavBtn.addEventListener('click', function(e) {
            e.preventDefault();
            searchSubheader.classList.toggle('open');
            if (searchSubheader.classList.contains('open')) {
                setTimeout(function() { searchInput.focus(); }, 150);
            } else {
                searchInput.value = '';
                searchResults.classList.remove('visible');
                if(clearBtn) clearBtn.classList.remove('visible');
                searchResults.innerHTML = ''; // Instant clear
            }
        });

        if (clearBtn) {
            clearBtn.addEventListener('click', function(e) {
                e.preventDefault();
                e.stopPropagation();
                searchInput.value = '';
                clearBtn.classList.remove('visible');
                searchResults.classList.remove('visible');
                searchResults.innerHTML = ''; // Instant clear (No busy)
                searchInput.focus();
            });
        }

        searchInput.addEventListener('input', function() {
            var query = this.value.toLowerCase().trim();
            
            if (this.value.length > 0 && clearBtn) clearBtn.classList.add('visible');
            else if (clearBtn) clearBtn.classList.remove('visible');

            if (!query) { 
                searchResults.classList.remove('visible'); 
                searchResults.innerHTML = '';
                return; 
            }
            
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(function() {
                var searchSource = getActiveSource();
                var filtered = searchSource.filter(function(m) {
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
        var chips = document.querySelectorAll('.subheader-scroll .category-chip');
        chips.forEach(function(chip) {
            chip.addEventListener('click', function() {
                chips.forEach(function(c) { c.classList.remove('active'); });
                this.classList.add('active');
                currentCategory = this.dataset.category;
                visibleCount = 12;
                isLatestExpanded = false; // Reset expansion on category switch
                if(latestSeeAllText) latestSeeAllText.textContent = 'See All';
                if(latestSeeAllIcon) latestSeeAllIcon.style.transform = 'rotate(0deg)';
                renderAll();
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
                }, 150);
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

    // 🎯 FEATURE: BACK TO TOP FUNCTIONALITY
    function initBackToTop() {
        var backToTopBtn = document.getElementById('backToTopBtn');
        if (!backToTopBtn) return;

        backToTopBtn.addEventListener('click', function() {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });

        window.addEventListener('scroll', function() {
            if (window.pageYOffset > 400) {
                backToTopBtn.classList.add('visible');
            } else {
                backToTopBtn.classList.remove('visible');
            }
        }, { passive: true });
    }

    function initScrollEffects() {
        var header = document.getElementById('mainHeader');
        var unifiedSubheaders = document.getElementById('unifiedSubheaders');

        var lastScrollY = 0;
        var ticking = false;
        var HIDE_AFTER = 80;
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
                    if (header) header.classList.remove('hidden');
                    if (unifiedSubheaders) unifiedSubheaders.classList.remove('hidden');
                    isHidden = false;
                }
            } else if (delta > 6 && !isHidden) {
                if (header) header.classList.add('hidden');
                if (unifiedSubheaders) unifiedSubheaders.classList.add('hidden');
                isHidden = true;
            } else if (delta < -6 && isHidden) {
                if (header) header.classList.remove('hidden');
                if (unifiedSubheaders) unifiedSubheaders.classList.remove('hidden');
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

    // 🎯 LATEST SEE ALL LOGIC
    function initLatestSeeAll() {
        if (!latestSeeAllBtn) return;

        latestSeeAllBtn.addEventListener('click', function() {
            isLatestExpanded = !isLatestExpanded;
            
            if (isLatestExpanded) {
                latestSeeAllText.textContent = 'Show Less';
                latestSeeAllIcon.style.transform = 'rotate(180deg)';
            } else {
                latestSeeAllText.textContent = 'See All';
                latestSeeAllIcon.style.transform = 'rotate(0deg)';
            }

            // Re-render only the latest grid
            var latestAll = getLatestFilms();
            var limit = isLatestExpanded ? latestAll.length : 6;
            crossfadeReplace(latestGrid, getRandomLatestFilms(limit), 'latest', 6);
        });
    }

    function initApp() {
        initCategories();
        initCardClick();
        initSecurity();
        initNavMovies();
        initScrollEffects();
        initBackToTop(); // 🎯 Feature
        initLatestSeeAll(); // 🎯 Feature
        fetchMovies(false); 
        fetchAllTranslators(); 
        fetchLiveAds(); 
        fetchTrendingFilms(); 
    }

    function init() { checkLogin(); }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

    window.AkimarkCache = {
        clearAll: function() {
            safeRemove(localStorage, CACHE_KEYS.FILMS);
            safeRemove(localStorage, CACHE_KEYS.TRANSLATORS);
            safeRemove(localStorage, CACHE_KEYS.ADS);
            var token = getToken();
            if (token) {
                safeRemove(sessionStorage, CACHE_KEYS.LOGIN + token);
                safeRemove(sessionStorage, CACHE_KEYS.MYMOVIES + token);
            }
        },
        stats: function() {
            return {
                films_cached: !!cacheRead(CACHE_KEYS.FILMS, TTL.FILMS),
                translators_cached: !!cacheRead(CACHE_KEYS.TRANSLATORS, TTL.TRANSLATORS),
                inflight: Object.keys(inflight).length
            };
        }
    };
})();
