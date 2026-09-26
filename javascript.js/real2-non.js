// non.js (v2 — matches home design, guest users, auto-clears loading on return)

(function() {
    'use strict';

    var TOKEN_KEY = 'akmark_token';
    var searchInitialized = false;
    var firstLoadDone = false;

    // ════════════════════════════════════════════════════════════
    // SUPABASE CLIENT & ANONYMOUS SESSION
    // ════════════════════════════════════════════════════════════
    const SUPABASE_URL = window.SUPABASE_URL;
    const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY;
    const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    async function ensureAnonymousSession() {
        let { data: { session } } = await supabase.auth.getSession();
        if (!session) {
            await supabase.auth.signInAnonymously();
            session = (await supabase.auth.getSession()).data.session;
        }
        if (session && session.access_token) {
            localStorage.setItem('anon_token', session.access_token);
        }
        return session;
    }

    // ════════════════════════════════════════════════════════════
    // CHECK LOGIN & REDIRECT IF LOGGED IN
    // ════════════════════════════════════════════════════════════
    function checkLoginAndRedirect() {
        var token = localStorage.getItem(TOKEN_KEY);
        if (token) {
            window.location.href = 'home.html';
            return true;
        }
        return false;
    }

    // ════════════════════════════════════════════════════════════
    // IMAGE OPTIMIZATION (matches home)
    // ════════════════════════════════════════════════════════════
    var POSTER_WIDTH = 400;
    var POSTER_QUALITY = 70;

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

    // ════════════════════════════════════════════════════════════
    // MOVIES DATA
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
    // MOVIE CARD — same style as home
    // ════════════════════════════════════════════════════════════
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

    // ════════════════════════════════════════════════════════════
    // EMPTY STATES
    // ════════════════════════════════════════════════════════════
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

    // ════════════════════════════════════════════════════════════
    // CROSSFADE — smooth skeleton → real transition
    // ════════════════════════════════════════════════════════════
    function crossfadeReplace(container, items, type, eagerLimit) {
        container.style.transition = 'opacity 0.22s ease';
        container.style.opacity = '0';
        setTimeout(function() {
            renderGrid(container, items, type, 0, eagerLimit);
            container.style.opacity = '1';
        }, 180);
    }

    // ════════════════════════════════════════════════════════════
    // DEDUPLICATION + PRIORITY SORT
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
                        if (priorityNormalized.indexOf(key) !== -1) {
                            priorityTranslators.push(name);
                        } else {
                            otherTranslators.push(name);
                        }
                    }
                }
            }
        });

        priorityTranslators.sort(function(a, b) {
            var ia = priorityNormalized.indexOf(a.toLowerCase());
            var ib = priorityNormalized.indexOf(b.toLowerCase());
            return ia - ib;
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

    // ════════════════════════════════════════════════════════════
    // FILTERING
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

    // ════════════════════════════════════════════════════════════
    // RENDER ALL
    // ════════════════════════════════════════════════════════════
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

    // ════════════════════════════════════════════════════════════
    // LOAD MY MOVIES COUNT
    // ════════════════════════════════════════════════════════════
    async function loadMyMoviesCount() {
        try {
            const session = await ensureAnonymousSession();
            const token = session.access_token;
            const res = await fetch(`${SUPABASE_URL}/functions/v1/non-viewing-film-api?action=list_my_views`, {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const data = await res.json();
            if (data.success && data.views) {
                myMoviesBadge.textContent = data.views.length;
            } else {
                myMoviesBadge.textContent = '0';
            }
        } catch (e) {
            console.error('Error loading my movies count:', e);
            myMoviesBadge.textContent = '0';
        }
    }

    // ════════════════════════════════════════════════════════════
    // FETCH MOVIES
    // ════════════════════════════════════════════════════════════
    async function fetchMovies() {
        try {
            const response = await fetch(`${SUPABASE_URL}/functions/v1/films-api`, {
                method: 'GET',
                headers: { 'Content-Type': 'application/json' }
            });
            const text = await response.text();
            let data;
            try { data = JSON.parse(text); } catch (e) { throw new Error('Invalid server response'); }
            if (!response.ok) throw new Error(data.error || 'Failed to fetch movies');

            const allMovies = data.movies || [];
            allFilms = allMovies.slice();

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
            initCardClick();
            loadMyMoviesCount();
        } catch (error) {
            console.error('Error fetching movies:', error);
            latestGrid.innerHTML = emptyStateHTML('latest');
            homeGrid.innerHTML = emptyStateHTML('all');
        }
    }

    // ════════════════════════════════════════════════════════════
    // INFINITE SCROLL
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
                        renderGrid(homeGrid, all.slice(fromIdx, visibleCount), 'all', fromIdx, 2);
                    }
                    isLoadingMore = false;
                }, 400);
            }
        }, { root: null, rootMargin: '0px', threshold: 0.1 });

        observer.observe(sentinel);
    }

    // ════════════════════════════════════════════════════════════
    // SEARCH
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
                        return '<div class="result-item" data-id="' + m.id + '">' + m.title + '</div>';
                    }).join('');
                } else {
                    searchResults.innerHTML = '<div class="result-item">No movies found</div>';
                }
                searchResults.classList.add('visible');
            }, 220);
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
    // CATEGORIES
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
    // CARD CLICK (with loading animation)
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
                }, 250);
            });
        });
    }

    // ════════════════════════════════════════════════════════════
    // 🆕 CLEAR LOADING ON PAGE RETURN
    //   User akabwerera kuchokera ku non-view.html (back button),
    //   .card-loading overlays zichotsedwa kuti athe kudina kachiwiri.
    // ════════════════════════════════════════════════════════════
    function clearAllCardLoadings() {
        document.querySelectorAll('.card-loading').forEach(function(el) {
            el.remove();
        });
    }

    // ════════════════════════════════════════════════════════════
    // SCROLL EFFECTS (hide header on scroll down, show on scroll up)
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
    // MAINTENANCE BANNER
    // ════════════════════════════════════════════════════════════
    function initMaintenanceBanner() {
        var banner = document.getElementById('maintenanceBanner');
        var closeBtn = document.getElementById('maintenanceClose');
        var clockEl = document.getElementById('malawiClock');
        if (!banner) return;

        // Show banner
        banner.classList.add('hide');

        // Live clock (Malawi time = UTC+2)
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

        // Close button
        if (closeBtn) {
            closeBtn.addEventListener('click', function() {
                banner.classList.remove('visible');
            });
        }
    }

    // ════════════════════════════════════════════════════════════
    // SECURITY
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
                    setTimeout(function() {
                        watermark.classList.remove('active');
                    }, 3000);
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
        ensureAnonymousSession().then(loadMyMoviesCount);

        // 🆕 Clear card loading overlays when returning to page
        window.addEventListener('pageshow', function(e) {
            clearAllCardLoadings();
        });
        window.addEventListener('visibilitychange', function() {
            if (!document.hidden) clearAllCardLoadings();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
