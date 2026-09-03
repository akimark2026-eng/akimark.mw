// home.js (Updated to match non.js logic - Latest/All separation, More Films Coming)
(function() {
    'use strict';

    var TOKEN_KEY = 'akmark_token';
    var USER_KEY = 'akmark_user';

    function getToken() { return localStorage.getItem(TOKEN_KEY); }
    function setUser(user) { localStorage.setItem(USER_KEY, JSON.stringify(user)); }
    function clearSession() {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem('akmark_refresh_token');
        localStorage.removeItem(USER_KEY);
    }

    function checkLogin() {
        var token = getToken();
        if (!token) {
            window.location.href = 'login.html';
            return false;
        }

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
            if (!data.valid) {
                clearSession();
                window.location.href = 'login.html';
                return false;
            }
            if (data.user) {
                setUser(data.user);
            }
            initApp();
        })
        .catch(function() {
            clearSession();
            window.location.href = 'login.html';
            return false;
        });
        return true;
    }

    var SUPABASE_URL = window.SUPABASE_URL;
    var allFilms = [];  // all movies (including series parts)
    var currentCategory = 'all';
    var currentTranslator = 'all';
    var visibleCount = 12;
    var SCROLL_STEP = 12;
    var sentinel = null;
    var isLoadingMore = false;

    var latestGrid = document.getElementById('latestGrid');
    var homeGrid = document.getElementById('homeGrid');
    var translatorContainer = document.getElementById('translatorContainer');
    var myMoviesBadge = document.getElementById('myMoviesBadge');
    var notificationBadge = document.getElementById('notificationBadge');

    function formatPrice(price) { return 'MK ' + Number(price || 0).toLocaleString(); }

    function movieCardHTML(movie) {
        return '<div class="movie-card" data-id="' + movie.id + '">' +
            (movie.translator_name ? '<div class="translator-badge">' + movie.translator_name + '</div>' : '') +
            '<div class="poster"><img src="' + movie.poster_url + '" alt="' + movie.title + '" loading="lazy">' +
            '<span class="price-tag">' + formatPrice(movie.price) + '</span>' +
            '<span class="badge">' + movie.quality + '</span></div>' +
            '<div class="info"><h3>' + movie.title + '</h3></div></div>';
    }

    function emptyStateHTML(type) {
        if (type === 'latest') {
            return '<div class="more-films-coming">' +
                '<div class="icon"><svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 100 20 10 10 0 000-20zm0 18a8 8 0 110-16 8 8 0 010 16zm-1-5h2v2h-2zm0-8h2v6h-2z"/></svg></div>' +
                '<h4>No Latest Films</h4>' +
                '<p>More films coming soon in this category.</p>' +
                '<div class="underline"></div>' +
                '</div>';
        }
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
        for (var i = 0; i < items.length; i++) html += movieCardHTML(items[i]);
        container.innerHTML = html;
    }

    // ===== DEDUPLICATE TRANSLATORS (WITH PRIORITY) =====
    function getUniqueTranslators() {
        var seen = {};
        var translators = [];
        // Priority list (case-insensitive)
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
                    // Check if priority
                    if (priorityNormalized.indexOf(key) !== -1) {
                        priorityTranslators.push(name);
                    } else {
                        otherTranslators.push(name);
                    }
                }
            }
        });

        // Arrange: priorityTranslators first (in priority order), then others
        priorityTranslators.sort(function(a, b) {
            var ia = priorityNormalized.indexOf(a.toLowerCase());
            var ib = priorityNormalized.indexOf(b.toLowerCase());
            return ia - ib;
        });

        translators = priorityTranslators.concat(otherTranslators);
        return translators;
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

    // ===== CATEGORY MATCHING =====
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

    // ===== LATEST FILMS (only latest=true) =====
    function getLatestFilms() {
        return allFilms.filter(function(m) {
            return m.latest === true && matchesCategory(m, currentCategory) && passesTranslator(m);
        });
    }

    // ===== ALL FILMS (non-latest) =====
    function getAllFilms() {
        return allFilms.filter(function(m) {
            return m.latest !== true && matchesCategory(m, currentCategory) && passesTranslator(m);
        });
    }

    function renderAll() {
        var latest = getLatestFilms();
        renderGrid(latestGrid, latest, 'latest');

        var all = getAllFilms();
        var visibleItems = all.slice(0, visibleCount);
        renderGrid(homeGrid, visibleItems, 'all');
    }

    function resetAndRender() { visibleCount = 12; renderAll(); }

    // ===== SKELETON REMOVAL =====
    function hideSkeletons() {
        var skeletons = document.querySelectorAll('.skeleton-card');
        skeletons.forEach(function(s) { s.style.display = 'none'; });
    }

    async function loadMyMoviesBadge() {
        try {
            const response = await fetch(`${SUPABASE_URL}/functions/v1/my-film-api`, {
                method: 'GET',
                headers: { 'Authorization': 'Bearer ' + getToken() }
            });
            const data = await response.json();
            if (data.success) {
                myMoviesBadge.textContent = data.films.length;
            }
        } catch (e) {
            console.error('Failed to load my movies badge', e);
            myMoviesBadge.textContent = '0';
        }
    }

    async function loadNotifications() {
        notificationBadge.textContent = '0';
    }

    async function fetchMovies() {
        try {
            const response = await fetch(`${SUPABASE_URL}/functions/v1/films-api`, {
                method: 'GET',
                headers: { 'Authorization': 'Bearer ' + getToken() }
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Failed to fetch');
            const allMovies = data.movies || [];
            allFilms = allMovies.slice(); // keep all movies
            renderTranslatorBar();
            renderAll();
            hideSkeletons();
            initSearch();
            initInfiniteScroll();
            loadMyMoviesBadge();
            loadNotifications();
        } catch (error) {
            console.error('Error fetching movies:', error);
            renderAll();
            hideSkeletons();
        }
    }

    // ===== PULL TO REFRESH =====
    function initPullToRefresh() {
        var pullRefreshEl = document.getElementById('pullRefresh');
        var startY = 0;
        var pulling = false;
        var threshold = 80;

        document.addEventListener('touchstart', function(e) {
            if (window.scrollY === 0 && !pulling) {
                startY = e.touches[0].clientY;
                pulling = true;
                pullRefreshEl.style.transition = 'none';
            }
        }, { passive: true });

        document.addEventListener('touchmove', function(e) {
            if (!pulling) return;
            var currentY = e.touches[0].clientY;
            var delta = currentY - startY;
            if (delta > 0) {
                pullRefreshEl.style.transform = 'translateY(' + Math.min(delta * 0.4, 70) + 'px)';
                e.preventDefault();
            }
        }, { passive: false });

        document.addEventListener('touchend', function() {
            if (!pulling) return;
            pulling = false;
            pullRefreshEl.style.transition = 'transform 0.3s ease';
            pullRefreshEl.style.transform = 'translateY(-100%)';
            if (pullRefreshEl._dragged > threshold) {
                pullRefreshEl.classList.add('show');
                resetAndRender();
                fetchMovies().then(function() {
                    setTimeout(function() {
                        pullRefreshEl.classList.remove('show');
                    }, 500);
                });
            }
            pullRefreshEl._dragged = 0;
        }, { passive: true });

        document.addEventListener('touchmove', function(e) {
            if (!pulling) return;
            var delta = e.touches[0].clientY - startY;
            if (delta > 0) pullRefreshEl._dragged = delta;
        }, { passive: true });
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
                        visibleCount += SCROLL_STEP;
                        renderGrid(homeGrid, all.slice(0, visibleCount), 'all');
                    }
                    isLoadingMore = false;
                }, 500);
            }
        }, { root: null, rootMargin: '0px', threshold: 0.1 });
        observer.observe(sentinel);
    }

    // ===== SEARCH (with debounce) =====
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
                searchInput.focus();
            } else {
                searchInput.value = '';
                searchResults.classList.remove('visible');
            }
        });

        searchInput.addEventListener('input', function() {
            var query = this.value.toLowerCase().trim();
            if (!query) {
                searchResults.classList.remove('visible');
                return;
            }
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
            }, 250);
        });

        searchResults.addEventListener('click', function(e) {
            var item = e.target.closest('.result-item');
            if (!item || !item.dataset.id) return;
            window.location.href = 'view-film.html?id=' + item.dataset.id;
            searchSubheader.classList.remove('open');
            searchResults.classList.remove('visible');
        });

        document.addEventListener('click', function(e) {
            if (!searchSubheader.contains(e.target)) {
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
                }, 300);
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

    function initSecurity() {
        document.addEventListener('contextmenu', function(e) { e.preventDefault(); });
        document.addEventListener('keydown', function(e) {
            if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && (e.key === 'I' || e.key === 'J' || e.key === 'C')) || (e.ctrlKey && e.key === 'u')) { e.preventDefault(); return false; }
        });
        document.addEventListener('keyup', function(e) {
            if (e.key === 'PrintScreen') {
                var wm = document.getElementById('watermark');
                wm.classList.add('active');
                setTimeout(function() { wm.classList.remove('active'); }, 1000);
            }
        });
    }

    function initApp() {
        initCategories();
        initCardClick();
        initSecurity();
        initNavMovies();
        initPullToRefresh();
        fetchMovies();
    }

    function init() {
        checkLogin();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
