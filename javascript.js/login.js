// javascript.js/login.js
(function() {
    'use strict';

    // Country data (same as register.js)
    const countries = {
        MW: { name: 'Malawi', flagUrl: 'https://flagcdn.com/w40/mw.png' },
        ZM: { name: 'Zambia', flagUrl: 'https://flagcdn.com/w40/zm.png' },
        MZ: { name: 'Mozambique', flagUrl: 'https://flagcdn.com/w40/mz.png' },
        ZW: { name: 'Zimbabwe', flagUrl: 'https://flagcdn.com/w40/zw.png' },
        ZA: { name: 'South Africa', flagUrl: 'https://flagcdn.com/w40/za.png' },
        TZ: { name: 'Tanzania', flagUrl: 'https://flagcdn.com/w40/tz.png' }
    };

    const phoneFlag = document.getElementById('phoneFlag');

    function detectCountryCode() {
        const lang = navigator.language || navigator.userLanguage || '';
        const map = {
            'en-MW': 'MW', 'en-ZM': 'ZM', 'en-MZ': 'MZ', 'en-ZW': 'ZW', 'en-ZA': 'ZA', 'en-TZ': 'TZ'
        };
        return map[lang] || 'MW';
    }

    function updatePhoneFlag() {
        const code = detectCountryCode();
        const country = countries[code];
        phoneFlag.innerHTML = country
            ? `<img src="${country.flagUrl}" alt="${country.name} flag">`
            : '<img src="https://flagcdn.com/w40/mw.png" alt="Malawi flag">';
    }

    // Password toggle (supports SVG)
    const togglePassword = document.getElementById('togglePassword');
    const passwordInput = document.getElementById('password');

    togglePassword.addEventListener('click', function() {
        const svg = this.querySelector('svg');
        if (passwordInput.type === 'password') {
            passwordInput.type = 'text';
            if (svg) {
                svg.innerHTML = '<path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/>';
            }
        } else {
            passwordInput.type = 'password';
            if (svg) {
                svg.innerHTML = '<path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/>';
            }
        }
    });

    // Form submit
    const form = document.getElementById('loginForm');
    const phoneInput = document.getElementById('phone');
    const errorMsg = document.getElementById('errorMessage');
    const submitBtn = document.getElementById('submitBtn');
    const btnText = submitBtn.querySelector('.btn-text');
    const spinner = submitBtn.querySelector('.spinner');

    form.addEventListener('input', function() {
        errorMsg.style.display = 'none';
    });

    form.addEventListener('submit', async function(e) {
        e.preventDefault();

        const phone = phoneInput.value.trim();
        const password = passwordInput.value.trim();

        if (!phone || !password) {
            errorMsg.textContent = 'Please fill in all fields.';
            errorMsg.style.display = 'block';
            return;
        }

        // Show processing state
        submitBtn.disabled = true;
        submitBtn.classList.add('processing');
        btnText.textContent = 'PROCESSING';

        // Get Supabase URL and Anon Key from global variables (supabase.js)
        const SUPABASE_URL = window.SUPABASE_URL;
        const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY;

        try {
            const response = await fetch(`${SUPABASE_URL}/functions/v1/login-api`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
                },
                body: JSON.stringify({ phone, password })
            });

            // Read response as text first – then try to parse JSON
            const text = await response.text();
            let data;
            try {
                data = JSON.parse(text);
            } catch (parseError) {
                // If response is not JSON, show what we got (e.g., HTML or empty)
                throw new Error(`Server returned invalid response: ${text || 'Empty response'}`);
            }

            if (!response.ok) {
                throw new Error(data.error || 'Login failed. Please try again.');
            }

            // Store session token & user info
            if (data.session && data.session.token) {
                localStorage.setItem('akmark_token', data.session.token);
                localStorage.setItem('akmark_refresh_token', data.session.refresh_token || data.session.token);
            }
            if (data.user) {
                localStorage.setItem('akmark_user', JSON.stringify(data.user));
            }

            // Directly redirect to home.html – NO SUCCESS MESSAGE
            window.location.href = 'home.html';

        } catch (error) {
            errorMsg.textContent = error.message || 'Network error. Please try again.';
            errorMsg.style.display = 'block';
        } finally {
            submitBtn.disabled = false;
            submitBtn.classList.remove('processing');
            btnText.textContent = 'Login';
        }
    });

    // Logo click
    document.querySelector('.logo').addEventListener('click', function() {
        window.location.href = 'index.html';
    });

    // Initialize flag
    updatePhoneFlag();
})();
