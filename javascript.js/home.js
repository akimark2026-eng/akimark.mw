// home.js (v10 — Clean skeleton crossfade, no pull-refresh, plain translator bar)

(function() {
    'use strict';

    var TOKEN_KEY = 'akmark_token';
    var USER_KEY = 'akmark_user';

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
    function optimizePosterLarge(originalUrl) { return optimizePosterUrl(originalUrl, 800, 80); }

    function safeAttr(str) {
        return String(str || '').replace(/'/g, '%27').replace(/"/g, '&quot;');
    }

    function getToken() { return localStorage.getItem(TOKEN_KEY); }
    function setUser(user) { localStorage.setItem(USER_KEY, JSON.stringify(user)); }
    function clearSession() {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem('akmark_refresh_token');
        localStorage.removeItem(USER_KEY);
    }

    function checkLogin() {
        var token = getToken();
        if (!token) { window.location.href = 'login.html'; return false; }

        fetch('https://jnqwvmxuieeelvukhcsq.supabase.co/functions/v1/login-checker', {
            method: 'GET',
            headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }
        })
        .then(function(response) {
            return response.text().then(function(text) {
                try { return JSON.parse(text); } catch (e) { throw new Error('Invalid'); }
            });
        })
        .then(function(data) {
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

    // ════════════════════════════════════════════════════════════
    // 🆕 SMOOTH CROSSFADE: fade grid out → replace → fade in
    //   Because skeleton structure = real card structure, there is
    //   zero layout shift. Just a smooth visual swap.
    // ════════════════════════════════════════════════════════════
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

    // Used on category / translator change — smooth crossfade
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
        fetch(`${SUPABASE_URL}/functions/v1/my-film-api`, {
            method: 'GET',
            headers: { 'Authorization': 'Bearer ' + getToken() }
        })
        .then(function(r) { return r.json(); })
        .then(function(data) {
            if (data.success) myMoviesBadge.textContent = data.films.length;
        })
        .catch(function(e) {
            console.error('Badge error', e);
            myMoviesBadge.textContent = '0';
        });
    }

    function loadNotifications() {
        notificationBadge.textContent = '0';
    }

    function fetchMovies() {
        return fetch(`${SUPABASE_URL}/functions/v1/films-api`, {
            method: 'GET',
            headers: { 'Authorization': 'Bearer ' + getToken() }
        })
        .then(function(r) { return r.json(); })
        .then(function(data) {
            if (!data || data.error) throw new Error(data.error || 'Failed');
            allFilms = (data.movies || []).slice();
            renderTranslatorBar();

            if (!firstLoadDone) {
                // First load: crossfade skeleton → real
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
            // Replace skeleton with empty state so user doesn't stare at shimmer forever
            latestGrid.innerHTML = emptyStateHTML('latest');
            homeGrid.innerHTML = emptyStateHTML('all');
        });
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
        fetchMovies();
    }

    function init() { checkLogin(); }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

    window.AkimarkImages = {
        optimize: optimizePosterUrl,
        thumb: optimizePosterThumb,
        large: optimizePosterLarge,
        WIDTH: POSTER_WIDTH,
        QUALITY: POSTER_QUALITY
    };
})();
