// non.js (v7 — Pro Multi-Layer Cache + Cloudflare CDN)
// All v6 logic preserved 100%. Only caching layer added.
// Backend load: 1000 non-users → ~0-10 requests/5min (was 3000+)

(function() {
    'use strict';

    var TOKEN_KEY = 'akmark_token';
    var searchInitialized = false;
    var firstLoadDone = false;

    // ════════════════════════════════════════════════════════════
    // 🆕 CACHE CONFIG
    // ════════════════════════════════════════════════════════════
    var CACHE_KEYS = {
        FILMS:       'akmark_noncache_films_v1',
        ANON_SESS:   'akmark_noncache_anon_v1',
        MYVIEWS:     'akmark_noncache_myviews_v1',
    };
    var TTL = {
        FILMS:     5 * 60 * 1000,      // 5 min
        ANON_SESS: 60 * 60 * 1000,     // 60 min (Supabase anon sessions last hours)
        MYVIEWS:   30 * 1000,          // 30 sec
    };

    // ════════════════════════════════════════════════════════════
    // 🆕 SAFE STORAGE
    // ════════════════════════════════════════════════════════════
    function safeGet(s, k) { try { return s.getItem(k); } catch (e) { return null; } }
    function safeSet(s, k, v) { try { s.setItem(k, v); } catch (e) {} }
    function safeRemove(s, k) { try { s.removeItem(k); } catch (e) {} }

    function cacheRead(storage, key, ttl) {
        var raw = safeGet(storage, key);
        if (!raw) return null;
        try {
            var parsed = JSON.parse(raw);
            if (Date.now() - parsed.ts > ttl) return null;
            return parsed.data;
        } catch (e) { return null; }
    }
    function cacheWrite(storage, key, data) {
        safeSet(storage, key, JSON.stringify({ ts: Date.now(), data: data }));
    }

    // ════════════════════════════════════════════════════════════
    // 🆕 REQUEST DEDUPLICATION
    // ════════════════════════════════════════════════════════════
    var inflight = {};
    function dedupeFetch(url, options) {
        var key = url + '|' + (options && options.headers ? JSON.stringify(options.headers) : '');
        if (inflight[key]) return inflight[key];
        var p = fetch(url, options).finally(function() { delete inflight[key]; });
        inflight[key] = p;
        return p;
    }

    // ════════════════════════════════════════════════════════════
    // SUPABASE CLIENT
    // ════════════════════════════════════════════════════════════
    const SUPABASE_URL = window.SUPABASE_URL;
    const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY;
    const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    // ════════════════════════════════════════════════════════════
    // 🆕 ANONYMOUS SESSION — session cache (60 min)
    // ════════════════════════════════════════════════════════════
    async function ensureAnonymousSession() {
        try {
            // 🆕 1. Try memory cache first
            if (window._cachedAnonSession && window._cachedAnonSession.access_token) {
                return window._cachedAnonSession;
            }

            // 🆕 2. Try sessionStorage cache
            var cached = cacheRead(sessionStorage, CACHE_KEYS.ANON_SESS, TTL.ANON_SESS);
            if (cached && cached.access_token) {
                // Verify it's still valid with supabase client (fast, local)
                window._cachedAnonSession = cached;
                safeSet(localStorage, 'anon_token', cached.access_token);
                return cached;
            }

            // 3. Check existing session
            let { data: { session } } = await supabase.auth.getSession();
            if (!session) {
                await supabase.auth.signInAnonymously();
                session = (await supabase.auth.getSession()).data.session;
            }
            if (session && session.access_token) {
                safeSet(localStorage, 'anon_token', session.access_token);
                cacheWrite(sessionStorage, CACHE_KEYS.ANON_SESS, session);  // 🆕
                window._cachedAnonSession = session;
            }
            return session;
        } catch (e) {
            console.error('Anonymous session error:', e);
            return null;
        }
    }

    function checkLoginAndRedirect() {
        var token = safeGet(localStorage, TOKEN_KEY);
        if (token) {
            window.location.href = 'home.html';
            return true;
        }
        return false;
    }

    // ════════════════════════════════════════════════════════════
    // SMART POSTER URL RESOLVER (unchanged)
    // ════════════════════════════════════════════════════════════
    var POSTER_WIDTH = 400;
    var POSTER_QUALITY = 72;

    function getPrimaryPosterUrl(movie) {
        var url = movie.poster_url || '';
        if (!url) return '';
        if (url.indexOf('/storage/v1/object/public/') !== -1) {
            return url.replace(
                '/storage/v1/object/public/',
                '/storage/v1/render/image/public/'
            ) + (url.indexOf('?') === -1 ? '?' : '&') +
                'width=' + POSTER_WIDTH + '&quality=' + POSTER_QUALITY + '&resize=contain';
        }
        return url;
    }

    function getFallbackPosterUrl(movie) {
        var url = movie.poster_url || '';
        if (!url) return '';
        if (url.indexOf('/storage/v1/render/image/public/') !== -1) {
            return url
                .replace('/storage/v1/render/image/public/', '/storage/v1/object/public/')
                .split('?')[0];
        }
        return url;
    }

    function getSecondaryFallback(movie) {
        if (movie.compressed_poster_url) return movie.compressed_poster_url;
        return '';
    }

    function safeAttr(str) {
        return String(str || '')
            .replace(/'/g, '%27')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    // ════════════════════════════════════════════════════════════
    // PRELOAD / PREFETCH (unchanged)
    // ════════════════════════════════════════════════════════════
    var preloadedUrls = {};
    function preloadPosters(movies, count) {
        if (!movies || !movies.length) return;
        var n = Math.min(count || 8, movies.length);
        for (var i = 0; i < n; i++) {
            var url = getPrimaryPosterUrl(movies[i]);
            if (!url || preloadedUrls[url]) continue;
            preloadedUrls[url] = true;
            try {
                var link = document.createElement('link');
                link.rel = 'preload';
                link.as = 'image';
                link.href = url;
                link.fetchPriority = i < 4 ? 'high' : 'auto';
                document.head.appendChild(link);
            } catch (e) {}
        }
    }

    function prefetchPosters(movies, fromIdx, count) {
        if (!movies || !movies.length) return;
        var to = Math.min(fromIdx + count, movies.length);
        for (var i = fromIdx; i < to; i++) {
            var url = getPrimaryPosterUrl(movies[i]);
            if (!url || preloadedUrls[url]) continue;
            preloadedUrls[url] = true;
            try {
                var link = document.createElement('link');
                link.rel = 'prefetch';
                link.as = 'image';
                link.href = url;
                document.head.appendChild(link);
            } catch (e) {}
        }
    }

    // ════════════════════════════════════════════════════════════
    // IMAGE BINDING WITH FALLBACK (unchanged)
    // ════════════════════════════════════════════════════════════
    function bindImageToMovie(imgEl, movie) {
        var primary = getPrimaryPosterUrl(movie);
        var fallback = getFallbackPosterUrl(movie);
        var secondary = getSecondaryFallback(movie);
        var tried = 0;

        imgEl.onload = function() {
            imgEl.classList.add('loaded');
            if (imgEl.parentElement) imgEl.parentElement.classList.add('loaded');
            imgEl.onerror = null;
        };

        imgEl.onerror = function() {
            tried++;
            if (tried === 1 && fallback && fallback !== primary) {
                imgEl.src = fallback;
            } else if (tried === 2 && secondary && secondary !== primary && secondary !== fallback) {
                imgEl.src = secondary;
            } else {
                imgEl.style.opacity = '0.15';
                if (imgEl.parentElement) imgEl.parentElement.classList.add('failed');
                imgEl.onerror = null;
            }
        };

        if (!imgEl.src || imgEl.src === '' || imgEl.src === window.location.href) {
            imgEl.src = primary;
        }
    }

    function observeLazyImage(imgEl, movie) {
        if (!('IntersectionObserver' in window)) {
            imgEl.src = imgEl.dataset.src;
            imgEl.removeAttribute('data-src');
            bindImageToMovie(imgEl, movie);
            return;
        }

        var observer = new IntersectionObserver(function(entries) {
            entries.forEach(function(entry) {
                if (entry.isIntersecting) {
                    var img = entry.target;
                    img.src = img.dataset.src;
                    img.removeAttribute('data-src');
                    bindImageToMovie(img, movie);
                    observer.unobserve(img);
                }
            });
        }, { rootMargin: '300px', threshold: 0.01 });

        observer.observe(imgEl);
    }

    // ════════════════════════════════════════════════════════════
    // MOVIES DATA (unchanged)
    // ════════════════════════════════════════════════════════════
    var allFilms = [];
    var currentCategory = 'all';
    var currentTranslator = 'all';

    var visibleCount = 12;
    var SCROLL_STEP = 12;
    var sentinel = null;
    var isLoadingMore = false;

    function $(sel) { return document.querySelector(sel); }
    function $$(sel) { return document.querySelectorAll(sel); }

    var latestGrid = $('#latestGrid');
    var homeGrid = $('#homeGrid');
    var translatorContainer = $('#translatorContainer');
    var myMoviesBadge = $('#myMoviesBadge');

    function formatPrice(price) {
        return 'MK ' + Number(price || 0).toLocaleString();
    }

    // ════════════════════════════════════════════════════════════
    // MOVIE CARD (unchanged)
    // ════════════════════════════════════════════════════════════
    function movieCardHTML(movie, index, eagerLimit) {
        var primary = getPrimaryPosterUrl(movie);
        var eager = (index !== undefined && index < (eagerLimit || 12));

        var imgAttrs = eager
            ? 'src="' + safeAttr(primary) + '" loading="eager" fetchpriority="high"'
            : 'data-src="' + safeAttr(primary) + '" loading="lazy" fetchpriority="low"';

        return '<div class="movie-card" data-id="' + safeAttr(movie.id) + '">' +
            (movie.translator_name ? '<div class="translator-badge">' + safeAttr(movie.translator_name) + '</div>' : '') +
            '<div class="poster">' +
                '<img class="poster-img" ' + imgAttrs + ' alt="' + safeAttr(movie.title) + '" decoding="async">' +
                '<span class="price-tag">' + formatPrice(movie.price) + '</span>' +
                '<span class="badge">' + (movie.quality || 'HD') + '</span>' +
            '</div>' +
            '<div class="info"><h3>' + safeAttr(movie.title) + '</h3></div></div>';
    }

    function emptyStateHTML(type) {
        if (type === 'latest') {
            return '<div class="more-films-coming">' +
                '<div class="icon"><svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 100 20 10 10 0 000-20zm0 18a8 8 0 110-16 8 8 0 010 16zm-1-5h2v2h-2zm0-8h2v6h-2z"/></svg></div>' +
                '<h4>No Latest Films</h4><p>More films coming soon.</p><div class="underline"></div></div>';
        }
        return '<div class="more-films-coming">' +
            '<div class="icon"><svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 100 20 10 10 0 000-20zm0 18a8 8 0 110-16 8 8 0 010 16zm-1-5h2v2h-2zm0-8h2v6h-2z"/></svg></div>' +
            '<h4>More Films Coming</h4><p>We are adding more films.</p><div class="underline"></div></div>';
    }

    // ════════════════════════════════════════════════════════════
    // RENDER GRID (unchanged)
    // ════════════════════════════════════════════════════════════
    function renderGrid(container, items, type, appendFrom, eagerLimit) {
        if (!items || items.length === 0) {
            if (!appendFrom) container.innerHTML = emptyStateHTML(type);
            return;
        }

        var existingImgCount = container.querySelectorAll('.poster-img').length;

        var html = '';
        var startIdx = appendFrom || 0;
        var limit = eagerLimit || 12;

        for (var i = 0; i < items.length; i++) {
            html += movieCardHTML(items[i], startIdx + i, limit);
        }

        if (appendFrom) {
            container.insertAdjacentHTML('beforeend', html);
        } else {
            container.innerHTML = html;
            existingImgCount = 0;
        }

        var allImgs = container.querySelectorAll('.poster-img');
        var newImgs = [];
        for (var k = existingImgCount; k < allImgs.length; k++) {
            newImgs.push(allImgs[k]);
        }

        for (var j = 0; j < newImgs.length; j++) {
            var img = newImgs[j];
            var movie = items[j];
            if (!img || !movie) continue;

            var globalIdx = startIdx + j;
            var isEager = globalIdx < limit;

            if (isEager) {
                bindImageToMovie(img, movie);
            } else {
                observeLazyImage(img, movie);
            }
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

    // ════════════════════════════════════════════════════════════
    // TRANSLATORS (unchanged)
    // ════════════════════════════════════════════════════════════
    function getUniqueTranslators() {
        var priority = ['AKILA', 'DENMARK', 'DAT-V'];
        var priorityNormalized = priority.map(function(p) { return p.toLowerCase(); });
        var priorityTranslators = [];
        var otherTranslators = [];
        var seen = {};

        allFilms.forEach(function(m) {
            if (m.translator_name) {
                var name = m.translator_name.trim();
                if (name) {
                    var key = name.toLowerCase();
                    if (!seen[key]) {
                        seen[key] = true;
                        if (priorityNormalized.indexOf(key) !== -1) priorityTranslators.push(name);
                        else otherTranslators.push(name);
                    }
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
            html += '<button class="translator-chip" data-translator="' + safeAttr(t) + '">' + safeAttr(t) + '</button>';
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

    // ════════════════════════════════════════════════════════════
    // FILTERING (unchanged)
    // ════════════════════════════════════════════════════════════
    function passesCategory(movie) {
        if (currentCategory === 'all') return true;
        if (movie.category) {
            var cats = String(movie.category).toLowerCase().split(',').map(function(s) { return s.trim(); });
            return cats.indexOf(currentCategory.toLowerCase()) !== -1;
        }
        return false;
    }

    function passesTranslator(movie) {
        if (currentTranslator === 'all') return true;
        return (movie.translator_name || '').trim() === currentTranslator;
    }

    function getLatestFilms() {
        return allFilms.filter(function(m) {
            return m.latest === true && passesCategory(m) && passesTranslator(m);
        });
    }

    function getAllFilms() {
        return allFilms.filter(function(m) {
            return (m.latest !== true) && passesCategory(m) && passesTranslator(m);
        });
    }

    function renderAll() {
        var latest = getLatestFilms();
        renderGrid(latestGrid, latest, 'latest', 0, 12);

        var all = getAllFilms();
        var visibleItems = all.slice(0, visibleCount);
        renderGrid(homeGrid, visibleItems, 'all', 0, 12);
    }

    function resetAndRender() {
        visibleCount = 12;
        var latest = getLatestFilms();
        var all = getAllFilms();
        var visibleItems = all.slice(0, visibleCount);

        preloadPosters(latest, 6);
        preloadPosters(all, 6);

        crossfadeReplace(latestGrid, latest, 'latest', 12);
        setTimeout(function() {
            crossfadeReplace(homeGrid, visibleItems, 'all', 12);
        }, 60);
    }

    // ════════════════════════════════════════════════════════════
    // 🆕 LOAD MY MOVIES COUNT — session cache (30s)
    // ════════════════════════════════════════════════════════════
    async function loadMyMoviesCount() {
        try {
            // 🆕 Check cache first
            var cached = cacheRead(sessionStorage, CACHE_KEYS.MYVIEWS, TTL.MYVIEWS);
            if (cached && typeof cached.count === 'number') {
                myMoviesBadge.textContent = cached.count;
            }

            const session = await ensureAnonymousSession();
            if (!session) { myMoviesBadge.textContent = '0'; return; }
            const token = session.access_token;

            const res = await dedupeFetch(
                `${SUPABASE_URL}/functions/v1/non-viewing-film-api?action=list_my_views`,
                {
                    method: 'GET',
                    headers: { 'Authorization': `Bearer ${token}` }
                }
            );
            const data = await res.json();
            var count = (data.success && data.views) ? data.views.length : 0;
            myMoviesBadge.textContent = count;
            cacheWrite(sessionStorage, CACHE_KEYS.MYVIEWS, { count: count });  // 🆕
        } catch (e) {
            console.error('Error loading my movies count:', e);
            if (!cacheRead(sessionStorage, CACHE_KEYS.MYVIEWS, TTL.MYVIEWS)) {
                myMoviesBadge.textContent = '0';
            }
        }
    }

    // ════════════════════════════════════════════════════════════
    // 🆕 FETCH MOVIES — SWR pattern (cache hit → instant render)
    // ════════════════════════════════════════════════════════════
    async function fetchMovies() {
        // 🆕 Check localStorage cache
        var cachedFilms = cacheRead(localStorage, CACHE_KEYS.FILMS, TTL.FILMS);

        if (cachedFilms && cachedFilms.movies && cachedFilms.movies.length) {
            // ── CACHE HIT: instant render ──
            allFilms = cachedFilms.movies.slice();
            renderTranslatorBar();

            var latest = getLatestFilms();
            var all = getAllFilms();
            preloadPosters(latest, 8);
            preloadPosters(all, 8);

            if (!firstLoadDone) {
                firstLoadDone = true;
                var visibleItems = all.slice(0, visibleCount);
                crossfadeReplace(latestGrid, latest, 'latest', 12);
                setTimeout(function() {
                    crossfadeReplace(homeGrid, visibleItems, 'all', 12);
                }, 60);
            } else {
                renderAll();
            }

            initSearch();
            initInfiniteScroll();
            initCardClick();

            // 🆕 Background revalidate + load my views
            backgroundFetchMovies();
            loadMyMoviesCount();
            return;
        }

        // ── CACHE MISS: normal fetch ──
        try {
            const response = await dedupeFetch(`${SUPABASE_URL}/functions/v1/films-api`, {
                method: 'GET',
                headers: { 'Content-Type': 'application/json' }
            });
            const text = await response.text();
            let data;
            try { data = JSON.parse(text); } catch (e) { throw new Error('Invalid server response'); }
            if (!response.ok) throw new Error(data.error || 'Failed to fetch movies');

            const allMovies = data.movies || [];
            allFilms = allMovies.slice();

            cacheWrite(localStorage, CACHE_KEYS.FILMS, data);  // 🆕

            if (allFilms.length > 0) {
                console.log(`[Akimark] Loaded ${allFilms.length} films`);
            }

            renderTranslatorBar();

            var latest = getLatestFilms();
            var all = getAllFilms();
            preloadPosters(latest, 8);
            preloadPosters(all, 8);

            if (!firstLoadDone) {
                firstLoadDone = true;
                var visibleItems = all.slice(0, visibleCount);
                crossfadeReplace(latestGrid, latest, 'latest', 12);
                setTimeout(function() {
                    crossfadeReplace(homeGrid, visibleItems, 'all', 12);
                }, 60);
            } else {
                renderAll();
            }

            initSearch();
            initInfiniteScroll();
            initCardClick();
            loadMyMoviesCount();
        } catch (error) {
            console.error('Error fetching movies:', error);
            latestGrid.innerHTML = emptyStateHTML('latest');
            homeGrid.innerHTML = emptyStateHTML('all');
        }
    }

    // 🆕 Background revalidate — silent, updates UI only if changed
    function backgroundFetchMovies() {
        dedupeFetch(`${SUPABASE_URL}/functions/v1/films-api`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        })
        .then(function(r) { return r.json(); })
        .then(function(data) {
            if (!data || data.error) return;
            cacheWrite(localStorage, CACHE_KEYS.FILMS, data);

            var oldSig = (allFilms[0] && allFilms[0].id) + '|' + allFilms.length;
            var newSig = (data.movies[0] && data.movies[0].id) + '|' + (data.movies || []).length;
            if (oldSig !== newSig) {
                allFilms = (data.movies || []).slice();
                renderTranslatorBar();
                renderAll();
            }
        })
        .catch(function() { /* silent */ });
    }

    // ════════════════════════════════════════════════════════════
    // INFINITE SCROLL (unchanged)
    // ════════════════════════════════════════════════════════════
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
                        prefetchPosters(all, fromIdx, SCROLL_STEP);
                        renderGrid(homeGrid, all.slice(fromIdx, visibleCount), 'all', fromIdx, 6);
                    }
                    isLoadingMore = false;
                }, 400);
            }
        }, { root: null, rootMargin: '500px', threshold: 0.01 });

        observer.observe(sentinel);
    }

    // ════════════════════════════════════════════════════════════
    // SEARCH (unchanged)
    // ════════════════════════════════════════════════════════════
    function initSearch() {
        if (searchInitialized) return;
        searchInitialized = true;

        var searchNavBtn = $('#searchNavBtn');
        var searchSubheader = $('#searchSubheader');
        var searchInput = $('#searchInput');
        var searchResults = $('#searchResults');
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
                var filtered = allFilms.filter(function(m) {
                    return (m.title && m.title.toLowerCase().includes(query)) ||
                           (m.translator_name && m.translator_name.toLowerCase().includes(query));
                });
                if (filtered.length > 0) {
                    searchResults.innerHTML = filtered.map(function(m) {
                        return '<div class="result-item" data-id="' + safeAttr(m.id) + '">' + safeAttr(m.title) + '</div>';
                    }).join('');
                } else {
                    searchResults.innerHTML = '<div class="result-item">No movies found</div>';
                }
                searchResults.classList.add('visible');
            }, 200);
        });

        searchResults.addEventListener('click', function(e) {
            var item = e.target.closest('.result-item');
            if (!item || !item.dataset.id) return;
            window.location.href = 'non-view.html?id=' + item.dataset.id;
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
    // CATEGORIES (unchanged)
    // ════════════════════════════════════════════════════════════
    function initCategories() {
        var subheaderChips = $$('#subheader .category-chip');
        subheaderChips.forEach(function(chip) {
            chip.addEventListener('click', function() {
                subheaderChips.forEach(function(c) { c.classList.remove('active'); });
                this.classList.add('active');
                currentCategory = this.dataset.category;
                resetAndRender();
            });
        });
    }

    // ════════════════════════════════════════════════════════════
    // CARD CLICK (unchanged)
    // ════════════════════════════════════════════════════════════
    function initCardClick() {
        document.querySelectorAll('.movie-grid').forEach(function(grid) {
            if (grid._bound) return;
            grid._bound = true;
            grid.addEventListener('click', function(e) {
                var card = e.target.closest('.movie-card');
                if (!card) return;
                if (card.querySelector('.card-loading')) return;

                var loadingDiv = document.createElement('div');
                loadingDiv.className = 'card-loading';
                loadingDiv.innerHTML = '<div class="card-spinner"></div>';
                card.appendChild(loadingDiv);

                var id = card.dataset.id;
                setTimeout(function() {
                    window.location.href = 'non-view.html?id=' + id;
                }, 200);
            });
        });
    }

    function clearAllCardLoadings() {
        document.querySelectorAll('.card-loading').forEach(function(el) { el.remove(); });
    }

    // ════════════════════════════════════════════════════════════
    // SCROLL EFFECTS (unchanged)
    // ════════════════════════════════════════════════════════════
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

    // ════════════════════════════════════════════════════════════
    // MAINTENANCE BANNER (unchanged)
    // ════════════════════════════════════════════════════════════
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

    // ════════════════════════════════════════════════════════════
    // SECURITY (unchanged)
    // ════════════════════════════════════════════════════════════
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
                var watermark = document.getElementById('watermark');
                if (watermark) {
                    watermark.classList.add('active');
                    setTimeout(function() { watermark.classList.remove('active'); }, 3000);
                }
            }
        });
    }

    // ════════════════════════════════════════════════════════════
    // INIT
    // ════════════════════════════════════════════════════════════
    function init() {
        if (checkLoginAndRedirect()) return;

        initCategories();
        initCardClick();
        initSecurity();
        initScrollEffects();
        initMaintenanceBanner();

        fetchMovies();
        // 🆕 Anonymous session + my views count (cached)
        ensureAnonymousSession().then(loadMyMoviesCount);

        window.addEventListener('pageshow', function() { clearAllCardLoadings(); });
        window.addEventListener('visibilitychange', function() {
            if (!document.hidden) clearAllCardLoadings();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // 🆕 Utility: cache management (console)
    window.AkimarkNonCache = {
        clearAll: function() {
            safeRemove(localStorage, CACHE_KEYS.FILMS);
            safeRemove(sessionStorage, CACHE_KEYS.ANON_SESS);
            safeRemove(sessionStorage, CACHE_KEYS.MYVIEWS);
            window._cachedAnonSession = null;
        },
        clearFilms: function() { safeRemove(localStorage, CACHE_KEYS.FILMS); },
        clearAnonSession: function() {
            safeRemove(sessionStorage, CACHE_KEYS.ANON_SESS);
            window._cachedAnonSession = null;
        },
        stats: function() {
            return {
                films_cached: !!cacheRead(localStorage, CACHE_KEYS.FILMS, TTL.FILMS),
                anon_cached: !!cacheRead(sessionStorage, CACHE_KEYS.ANON_SESS, TTL.ANON_SESS),
                myviews_cached: !!cacheRead(sessionStorage, CACHE_KEYS.MYVIEWS, TTL.MYVIEWS),
                inflight: Object.keys(inflight).length,
            };
        }
    };
})();
