const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const path = require('path');
const supabase = require('./supabase');

const app = express();

// --- Middleware ---
app.use(cors()); // CORS yowonjezera kuti zinthu zikhale bwino (ngati mukugwiritsa ntchito ma origin osiyana)
app.use(express.json());

// --- Serve static files (HTML, CSS, JS) ---
app.use(express.static(path.join(__dirname, 'public')));

// --- POST /register — kulembetsa user ---
app.post('/register', async (req, res) => {
  try {
    const { full_name, phone, password } = req.body;

    // Validate input
    if (!full_name || !phone || !password) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    // Hash password
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // Insert into users table
    const { data, error } = await supabase
      .from('users')
      .insert([
        {
          full_name,
          phone,
          password: hashedPassword,
        },
      ])
      .select()
      .single();

    if (error) {
      // Handle unique constraint violation (phone already exists)
      if (error.code === '23505') {
        return res.status(409).json({ error: 'Phone number already registered' });
      }
      throw error;
    }

    return res.status(201).json({
      message: 'User registered successfully',
      user: {
        user_id: data.user_id,
        full_name: data.full_name,
        phone: data.phone,
        created_at: data.created_at,
      },
    });
  } catch (error) {
    console.error('Registration error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// --- Serve register.html pa root path (kapena mukhoza kusiya static) ---
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

// --- Start server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
