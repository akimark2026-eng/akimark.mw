// non.js (Updated: Latest vs All separation, real category filtering, More Films Coming)

(function() {
    'use strict';

    var TOKEN_KEY = 'akmark_token';
    var searchInitialized = false;

    // ===== SUPABASE CLIENT & ANONYMOUS SESSION =====
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

    // ===== CHECK LOGIN & REDIRECT IF LOGGED IN =====
    function checkLoginAndRedirect() {
        var token = localStorage.getItem(TOKEN_KEY);
        if (token) {
            window.location.href = 'home.html';
            return true;
        }
        return false;
    }

    // ===== MOVIES DATA =====
    var allFilms = [];  // all movies (including series parts, but we'll keep all)
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
    var pullRefreshEl = $('#pullRefresh');
    var startY = 0;
    var pulling = false;

    function formatPrice(price) {
        return 'MK ' + Number(price || 0).toLocaleString();
    }

    function movieCardHTML(movie) {
        return '<div class="movie-card" data-id="' + movie.id + '">' +
            (movie.translator_name ? '<div class="translator-badge">' + movie.translator_name + '</div>' : '') +
            '<div class="poster">' +
            '<img src="' + movie.poster_url + '" alt="' + movie.title + '" loading="lazy">' +
            '<span class="price-tag">' + formatPrice(movie.price) + '</span>' +
            '<span class="badge">' + movie.quality + '</span>' +
            '</div>' +
            '<div class="info">' +
            '<h3>' + movie.title + '</h3>' +
            '</div>' +
            '</div>';
    }

    // ===== EMPTY STATES =====
    function emptyStateHTML(type) {
        if (type === 'latest') {
            return '<div class="more-films-coming">' +
                '<div class="icon"><svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 100 20 10 10 0 000-20zm0 18a8 8 0 110-16 8 8 0 010 16zm-1-5h2v2h-2zm0-8h2v6h-2z"/></svg></div>' +
                '<h4>No Latest Films</h4>' +
                '<p>More films coming soon in this category.</p>' +
                '<div class="underline"></div>' +
                '</div>';
        }
        // default: All Films empty
        return '<div class="more-films-coming">' +
            '<div class="icon"><svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 100 20 10 10 0 000-20zm0 18a8 8 0 110-16 8 8 0 010 16zm-1-5h2v2h-2zm0-8h2v6h-2z"/></svg></div>' +
            '<h4>More Films Coming</h4>' +
            '<p>We are adding more films. Check back soon!</p>' +
            '<div class="underline"></div>' +
            '</div>';
    }

    function renderGrid(container, items, type) {
        if (!items || items.length === 0) {
            container.innerHTML = emptyStateHTML(type);
            return;
        }
        var html = '';
        for (var i = 0; i < items.length; i++) {
            html += movieCardHTML(items[i]);
        }
        container.innerHTML = html;
    }

    // ===== DEDUPLICATION (TRIM NAMES) + PRIORITY SORT =====
    function getUniqueTranslators() {
        // Priority list (case-insensitive) - these will appear first
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

        // Sort priority translators according to priority list order
        priorityTranslators.sort(function(a, b) {
            var ia = priorityNormalized.indexOf(a.toLowerCase());
            var ib = priorityNormalized.indexOf(b.toLowerCase());
            return ia - ib;
        });

        // Combine: priority first, then others
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

    // ===== FILTERING =====
    function passesCategory(movie) {
        if (currentCategory === 'all') return true;
        // Category might be a single string or comma-separated. We'll check exact match or contains.
        if (movie.category) {
            var cats = String(movie.category).toLowerCase().split(',');
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

    // ===== RENDER ALL =====
    function renderAll() {
        // Latest section
        var latest = getLatestFilms();
        renderGrid(latestGrid, latest, 'latest');

        // All Films section (non-latest)
        var all = getAllFilms();
        var visibleItems = all.slice(0, visibleCount);
        renderGrid(homeGrid, visibleItems, 'all');
    }

    function resetAndRender() {
        visibleCount = 12;
        renderAll();
    }

    // ===== SKELETON LOADING =====
    function showSkeleton() {
        latestGrid.innerHTML = '<div class="skeleton-card"></div>'.repeat(6);
        homeGrid.innerHTML = '<div class="skeleton-card"></div>'.repeat(6);
    }

    // ===== LOAD MY MOVIES COUNT =====
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
            renderAll(); // This replaces skeletons with actual movie cards
            initSearch();
            initInfiniteScroll();
            initPullToRefresh();
            loadMyMoviesCount();
        } catch (error) {
            console.error('Error fetching movies:', error);
            latestGrid.innerHTML = '<div class="more-films-coming"><div class="icon"><svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 100 20 10 10 0 000-20zm0 18a8 8 0 110-16 8 8 0 010 16zm-1-5h2v2h-2zm0-8h2v6h-2z"/></svg></div><h4>Failed to load</h4><p>Please check your connection.</p></div>';
            homeGrid.innerHTML = '<div class="more-films-coming"><div class="icon"><svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 100 20 10 10 0 000-20zm0 18a8 8 0 110-16 8 8 0 010 16zm-1-5h2v2h-2zm0-8h2v6h-2z"/></svg></div><h4>Failed to load</h4><p>Please check your connection.</p></div>';
        }
    }

    // ===== INFINITE SCROLL =====
    function initInfiniteScroll() {
        sentinel = document.getElementById('scrollSentinel');
        if (!sentinel) return;

        var observer = new IntersectionObserver(function(entries) {
            if (entries[0].isIntersecting && !isLoadingMore) {
                isLoadingMore = true;
                setTimeout(function() {
                    var all = getAllFilms();
                    if (visibleCount < all.length) {
                        visibleCount += SCROLL_STEP;
                        // Re-render only the homeGrid
                        var visibleItems = all.slice(0, visibleCount);
                        renderGrid(homeGrid, visibleItems, 'all');
                    }
                    isLoadingMore = false;
                }, 500);
            }
        }, { root: null, rootMargin: '0px', threshold: 0.1 });

        observer.observe(sentinel);
    }

    // ===== SEARCH FUNCTIONALITY =====
    function initSearch() {
        if (searchInitialized) return;
        searchInitialized = true;

        var searchNavBtn = $('#searchNavBtn');
        var searchSubheader = $('#searchSubheader');
        var searchInput = $('#searchInput');
        var searchResults = $('#searchResults');

        if (searchNavBtn) {
            searchNavBtn.addEventListener('click', function(e) {
                e.preventDefault();
                searchSubheader.classList.toggle('open');
                if (searchSubheader.classList.contains('open')) {
                    searchInput.focus();
                } else {
                    searchInput.value = '';
                    searchResults.classList.remove('visible');
                }
            });
        }

        if (searchInput) {
            searchInput.addEventListener('input', function() {
                var query = this.value.toLowerCase().trim();
                if (!query) { searchResults.classList.remove('visible'); return; }
                var filtered = allFilms.filter(function(m) {
                    return (m.title && m.title.toLowerCase().includes(query)) ||
                           (m.translator_name && m.translator_name.toLowerCase().includes(query));
                });
                if (filtered.length > 0) {
                    searchResults.innerHTML = filtered.map(function(m) {
                        return '<div class="result-item" data-id="' + m.id + '">' + m.title + '</div>';
                    }).join('');
                    searchResults.classList.add('visible');
                } else {
                    searchResults.innerHTML = '<div class="result-item">No movies found</div>';
                    searchResults.classList.add('visible');
                }
            });

            searchResults.addEventListener('click', function(e) {
                var item = e.target.closest('.result-item');
                if (!item || !item.dataset.id) return;
                var id = item.dataset.id;
                if (id) {
                    window.location.href = 'non-view.html?id=' + id;
                }
                searchSubheader.classList.remove('open');
                searchResults.classList.remove('visible');
            });

            document.addEventListener('click', function(e) {
                if (!searchSubheader.contains(e.target)) {
                    searchResults.classList.remove('visible');
                }
            });
        }
    }

    // ===== CATEGORY CHIPS (Works immediately) =====
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

    // ===== CARD CLICK (with loading animation) =====
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

                var id = card.dataset.id;
                setTimeout(function() {
                    window.location.href = 'non-view.html?id=' + id;
                }, 300);
            });
        });
    }

    // ===== PULL TO REFRESH =====
    function initPullToRefresh() {
        if ('ontouchstart' in window) {
            document.addEventListener('touchstart', function(e) {
                if (window.scrollY === 0) {
                    startY = e.touches[0].clientY;
                    pulling = true;
                }
            }, { passive: true });

            document.addEventListener('touchmove', function(e) {
                if (!pulling) return;
                var currentY = e.touches[0].clientY;
                var delta = currentY - startY;
                if (delta > 80 && window.scrollY === 0) {
                    pullRefreshEl.classList.add('show');
                }
            }, { passive: true });

            document.addEventListener('touchend', function() {
                if (pulling && pullRefreshEl.classList.contains('show')) {
                    pullRefreshEl.classList.remove('show');
                    resetAndRender();
                    fetchMovies();
                }
                pulling = false;
            }, { passive: true });
        }
    }

    // ===== SECURITY =====
    function initSecurity() {
        document.addEventListener('contextmenu', function(e) {
            e.preventDefault();
        });

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
                watermark.classList.add('active');
                setTimeout(function() {
                    watermark.classList.remove('active');
                }, 1000);
            }
        });
    }

    // ===== INIT =====
    function init() {
        if (checkLoginAndRedirect()) {
            return;
        }

        showSkeleton();
        initCategories();
        initCardClick();
        initSecurity();

        fetchMovies();
        ensureAnonymousSession().then(loadMyMoviesCount);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
