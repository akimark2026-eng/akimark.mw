// javascript.js/register.js
(function() {
    'use strict';

    // Country data with real flags from flagcdn.com
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
        if (map[lang]) {
            return map[lang];
        }
        return 'MW';
    }

    function updatePhoneFlag() {
        const code = detectCountryCode();
        const country = countries[code];
        if (country) {
            phoneFlag.innerHTML = `<img src="${country.flagUrl}" alt="${country.name} flag">`;
        } else {
            phoneFlag.innerHTML = '<img src="https://flagcdn.com/w40/mw.png" alt="Malawi flag">';
        }
    }

    // Password toggle – supports both SVG and Bootstrap icons
    const togglePassword = document.getElementById('togglePassword');
    const passwordInput = document.getElementById('password');

    togglePassword.addEventListener('click', function() {
        // Toggle input type
        if (passwordInput.type === 'password') {
            passwordInput.type = 'text';
            // If using SVG (innerHTML contains <svg>)
            if (this.querySelector('svg')) {
                this.querySelector('svg').innerHTML = '<path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/>';
            }
            // If using Bootstrap icon class
            else if (this.querySelector('i')) {
                this.querySelector('i').className = 'bi bi-eye-slash';
            }
        } else {
            passwordInput.type = 'password';
            if (this.querySelector('svg')) {
                this.querySelector('svg').innerHTML = '<path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/>';
            }
            else if (this.querySelector('i')) {
                this.querySelector('i').className = 'bi bi-eye';
            }
        }
    });

    // Form submit - REAL registration using fetch to Supabase Edge Function
    const form = document.getElementById('registerForm');
    const successMsg = document.getElementById('successMessage');
    const errorMsg = document.getElementById('errorMessage');
    const submitBtn = form.querySelector('.submit-btn');
    // Check if button has spinner structure (btn-text + spinner)
    const btnText = submitBtn.querySelector('.btn-text');
    const spinner = submitBtn.querySelector('.spinner');

    form.addEventListener('input', function() {
        errorMsg.style.display = 'none';
    });

    form.addEventListener('submit', async function(e) {
        e.preventDefault();

        const fullName = document.getElementById('fullName').value.trim();
        const phone = document.getElementById('phoneNumber').value.trim();
        const password = document.getElementById('password').value.trim();

        if (!fullName || !phone || !password) {
            errorMsg.textContent = 'Please fill in all fields.';
            errorMsg.style.display = 'block';
            return;
        }

        // Disable button and show processing/spinner
        submitBtn.disabled = true;
        if (btnText && spinner) {
            submitBtn.classList.add('processing');
            btnText.textContent = 'PROCESSING';
        } else {
            submitBtn.textContent = 'PROCESSING';
        }

        // Kugwiritsa ntchito URL ndi Anon Key kuchokera ku supabase.js
        const SUPABASE_URL = window.SUPABASE_URL;
        const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY;

        try {
            // Send request to Supabase Edge Function
            const response = await fetch(`${SUPABASE_URL}/functions/v1/register-api`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
                },
                body: JSON.stringify({
                    full_name: fullName,
                    phone: phone,
                    password: password
                })
            });

            // Read response as text first (kuti mupewe "Empty response" error)
            const text = await response.text();

            // Try to parse JSON
            let data;
            try {
                data = JSON.parse(text);
            } catch (parseError) {
                throw new Error(`Server returned invalid response: ${text || 'Empty response'}`);
            }

            if (!response.ok) {
                throw new Error(data.error || 'Registration failed. Please try again.');
            }

            // ----- SUCCESS: Store token & user in localStorage -----
            if (data.session && data.session.token) {
                localStorage.setItem('akmark_token', data.session.token);
                localStorage.setItem('akmark_refresh_token', data.session.refresh_token || data.session.token);
            }

            if (data.user) {
                localStorage.setItem('akmark_user', JSON.stringify(data.user));
            }

            // Redirect to home page
            window.location.href = '/home';

        } catch (error) {
            // Error handling (kuwona vuto la network kapena server)
            if (error.message === 'Failed to fetch') {
                errorMsg.textContent = 'Unable to connect to Supabase. Please check your connection.';
            } else {
                errorMsg.textContent = error.message || 'Network error. Please try again.';
            }
            errorMsg.style.display = 'block';
        } finally {
            // Re-enable submit button if form still visible (not redirected)
            if (form.style.display !== 'none') {
                submitBtn.disabled = false;
                if (btnText && spinner) {
                    submitBtn.classList.remove('processing');
                    btnText.textContent = 'Register';
                } else {
                    submitBtn.textContent = 'Register';
                }
            }
        }
    });

    // Logo click
    document.getElementById('logoHome').addEventListener('click', function() {
        window.location.href = '/home';
    });

    updatePhoneFlag();
})();
