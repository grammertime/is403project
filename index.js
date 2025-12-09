/**
 * Word Count Tracker - Enhanced Version with Manager Features
 * Includes user management for managers
 */

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 2999;

// ---------------- DATABASE CONNECTION ----------------
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5433,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'admin',
  database: process.env.DB_NAME || 'wordcount_db'
});

const db = {
  query: (text, params) => pool.query(text, params)
};

// ---------------- SESSION SETUP ----------------
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'fallback-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 8 // 8 hours
    }
  })
);

// ---------------- MIDDLEWARE ----------------
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

// Debug logging
app.use((req, _res, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

// Authentication middleware
app.use((req, res, next) => {
  const openPaths = ['/', '/login', '/logout'];
  if (openPaths.includes(req.path)) return next();

  if (req.session.isLoggedIn) return next();
  res.render('login', { error_message: 'Please log in to access this page' });
});

// Manager-only middleware
function requireManager(req, res, next) {
  if (req.session.permissions === 'M') {
    return next();
  }
  res.status(403).send('Access denied. Manager permissions required.');
}

// ---------------- ROUTES ----------------

// Root route → Login page
app.get('/', (req, res) => {
  res.render('login', { error_message: null });
});

// Handle login
app.post('/login', async (req, res) => {
  const { username, password } = req.body;

  try {
    const result = await db.query(
      `SELECT u.user_id, u.username, u.first_name, u.last_name, u.permissions, s.password_text
       FROM "User" u
       INNER JOIN Security s ON u.user_id = s.user_id
       WHERE u.username = $1`,
      [username]
    );

    if (result.rows.length === 0) {
      return res.render('login', { error_message: 'Invalid username or password' });
    }

    const user = result.rows[0];
    const validPassword = password === user.password_text;

    if (!validPassword) {
      return res.render('login', { error_message: 'Invalid username or password' });
    }

    await db.query(
      'UPDATE Security SET last_login = CURRENT_TIMESTAMP WHERE user_id = $1',
      [user.user_id]
    );

    req.session.isLoggedIn = true;
    req.session.username = user.username;
    req.session.userId = user.user_id;
    req.session.firstName = user.first_name;
    req.session.permissions = user.permissions; // Store permissions in session

    console.log(`✅ Login successful for ${username} (${user.permissions === 'M' ? 'Manager' : 'User'})`);
    res.redirect('/dashboard');
  } catch (err) {
    console.error('❌ Login error:', err);
    res.render('login', { error_message: 'An error occurred. Please try again.' });
  }
});

// Dashboard route
app.get('/dashboard', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT p.project_id AS id, p.title, p.genre, p.description, p.start_date,
              COALESCE(pl.total_words, 0) AS current_words,
              COALESCE(g.target_value, 50000) AS target_words,
              COALESCE(g.daily_target, 1000) AS daily_goal
       FROM Project p
       LEFT JOIN LATERAL (
         SELECT total_words
         FROM ProgressLog
         WHERE project_id = p.project_id
         ORDER BY log_date DESC
         LIMIT 1
       ) pl ON true
       LEFT JOIN Goal g ON g.project_id = p.project_id
         AND g.is_active = true
         AND g.goal_type = 'total_words'
       WHERE p.user_id = $1
       ORDER BY p.start_date DESC`,
      [req.session.userId]
    );

    res.render('dashboard', {
      username: req.session.username,
      projects: result.rows,
      isManager: req.session.permissions === 'M' // Pass manager status to view
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.render('dashboard', { 
      username: req.session.username, 
      projects: [],
      isManager: req.session.permissions === 'M'
    });
  }
});

// Search route
app.get('/search', async (req, res) => {
  const searchTerm = req.query.q || '';
  try {
    const result = await db.query(
      `SELECT p.project_id AS id, p.title, p.genre, p.description, p.start_date,
              COALESCE(pl.total_words, 0) AS current_words,
              COALESCE(g.target_value, 50000) AS target_words,
              COALESCE(g.daily_target, 1000) AS daily_goal
       FROM Project p
       LEFT JOIN LATERAL (
         SELECT total_words
         FROM ProgressLog
         WHERE project_id = p.project_id
         ORDER BY log_date DESC
         LIMIT 1
       ) pl ON true
       LEFT JOIN Goal g ON g.project_id = p.project_id
         AND g.is_active = true
         AND g.goal_type = 'total_words'
       WHERE p.user_id = $1
         AND (LOWER(p.title) LIKE LOWER($2) OR LOWER(p.genre) LIKE LOWER($2))
       ORDER BY p.start_date DESC`,
      [req.session.userId, `%${searchTerm}%`]
    );

    res.render('dashboard', {
      username: req.session.username,
      projects: result.rows,
      searchTerm,
      isManager: req.session.permissions === 'M'
    });
  } catch (err) {
    console.error('Search error:', err);
    res.render('dashboard', { 
      username: req.session.username, 
      projects: [], 
      searchTerm,
      isManager: req.session.permissions === 'M'
    });
  }
});

// Add new project form
app.get('/add', (req, res) => {
  res.render('add-project', { username: req.session.username });
});

// Add new project (submit)
app.post('/add', async (req, res) => {
  const { title, genre, description, targetWords, currentWords, dailyGoal, startDate } = req.body;
  try {
    const project = await db.query(
      `INSERT INTO Project (user_id, title, genre, description, start_date)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING project_id`,
      [req.session.userId, title, genre, description || null, startDate]
    );

    const projectId = project.rows[0].project_id;

    // Add goal with daily_target
    await db.query(
      `INSERT INTO Goal (project_id, goal_type, target_value, daily_target, start_date, is_active)
       VALUES ($1, 'total_words', $2, $3, $4, true)`,
      [projectId, parseInt(targetWords), parseInt(dailyGoal) || 1000, startDate]
    );

    // Optional initial progress log
    if (parseInt(currentWords) > 0) {
      await db.query(
        `INSERT INTO ProgressLog (project_id, word_count, total_words, log_date)
         VALUES ($1, $2, $2, $3)`,
        [projectId, parseInt(currentWords), startDate]
      );
    }

    res.redirect('/dashboard');
  } catch (err) {
    console.error('Add project error:', err);
    res.redirect('/dashboard');
  }
});

// Edit project (GET form)
app.get('/edit/:id', async (req, res) => {
  const projectId = parseInt(req.params.id);
  try {
    const result = await db.query(
      `SELECT p.project_id AS id, p.title, p.genre, p.description, p.start_date,
              COALESCE(pl.total_words, 0) AS current_words,
              COALESCE(g.target_value, 50000) AS target_words,
              COALESCE(g.daily_target, 1000) AS daily_goal,
              g.goal_id
       FROM Project p
       LEFT JOIN LATERAL (
         SELECT total_words
         FROM ProgressLog
         WHERE project_id = p.project_id
         ORDER BY log_date DESC
         LIMIT 1
       ) pl ON true
       LEFT JOIN Goal g ON g.project_id = p.project_id
         AND g.is_active = true
         AND g.goal_type = 'total_words'
       WHERE p.project_id = $1 AND p.user_id = $2`,
      [projectId, req.session.userId]
    );

    if (result.rows.length === 0) return res.redirect('/dashboard');

    const project = result.rows[0];
    if (project.start_date) {
      project.start_date = new Date(project.start_date).toISOString().split('T')[0];
    }

    res.render('edit-project', {
      username: req.session.username,
      project
    });
  } catch (err) {
    console.error('Edit GET error:', err);
    res.redirect('/dashboard');
  }
});

// Edit project (POST update)
app.post('/edit/:id', async (req, res) => {
  const projectId = parseInt(req.params.id);
  const { title, genre, description, targetWords, currentWords, dailyGoal, startDate } = req.body;

  try {
    // Update Project
    await db.query(
      `UPDATE Project
       SET title = $1, genre = $2, description = $3, start_date = $4
       WHERE project_id = $5 AND user_id = $6`,
      [title, genre, description || null, startDate, projectId, req.session.userId]
    );

    // Update Goal with daily_target
    await db.query(
      `UPDATE Goal
       SET target_value = $1, daily_target = $2
       WHERE project_id = $3 AND goal_type = 'total_words' AND is_active = true`,
      [parseInt(targetWords), parseInt(dailyGoal) || 1000, projectId]
    );

    // Update progress
    const currentTotal = parseInt(currentWords);
    const lastLog = await db.query(
      `SELECT total_words FROM ProgressLog
       WHERE project_id = $1 ORDER BY log_date DESC LIMIT 1`,
      [projectId]
    );

    if (lastLog.rows.length === 0 && currentTotal > 0) {
      await db.query(
        `INSERT INTO ProgressLog (project_id, word_count, total_words)
         VALUES ($1, $2, $2)`,
        [projectId, currentTotal]
      );
    } else if (lastLog.rows.length > 0 && lastLog.rows[0].total_words !== currentTotal) {
      const diff = currentTotal - lastLog.rows[0].total_words;
      await db.query(
        `INSERT INTO ProgressLog (project_id, word_count, total_words)
         VALUES ($1, $2, $3)`,
        [projectId, diff, currentTotal]
      );
    }

    res.redirect('/dashboard');
  } catch (err) {
    console.error('Edit POST error:', err);
    res.redirect('/dashboard');
  }
});

// Delete project
app.post('/delete/:id', async (req, res) => {
  const projectId = parseInt(req.params.id);
  try {
    // Delete related records first (if no CASCADE in DB)
    await db.query('DELETE FROM ProgressLog WHERE project_id = $1', [projectId]);
    await db.query('DELETE FROM Goal WHERE project_id = $1', [projectId]);
    await db.query(
      `DELETE FROM Project WHERE project_id = $1 AND user_id = $2`,
      [projectId, req.session.userId]
    );
    res.redirect('/dashboard');
  } catch (err) {
    console.error('Delete error:', err);
    res.redirect('/dashboard');
  }
});

// ============ WORD LOGGING ROUTES ============

// Project-specific word logging page (GET)
app.get('/log-words/:id', async (req, res) => {
  const projectId = parseInt(req.params.id);
  
  try {
    const result = await db.query(
      `SELECT p.project_id AS id, p.title, p.genre,
              COALESCE(pl.total_words, 0) AS current_words,
              COALESCE(g.target_value, 50000) AS target_words,
              COALESCE(g.daily_target, 1000) AS daily_goal
       FROM Project p
       LEFT JOIN LATERAL (
         SELECT total_words
         FROM ProgressLog
         WHERE project_id = p.project_id
         ORDER BY log_date DESC
         LIMIT 1
       ) pl ON true
       LEFT JOIN Goal g ON g.project_id = p.project_id
         AND g.is_active = true
         AND g.goal_type = 'total_words'
       WHERE p.project_id = $1 AND p.user_id = $2`,
      [projectId, req.session.userId]
    );

    if (result.rows.length === 0) {
      return res.redirect('/dashboard');
    }

    res.render('log-words', {
      username: req.session.username,
      project: result.rows[0],
      error_message: null,
      success_message: null
    });
  } catch (err) {
    console.error('Log words page error:', err);
    res.redirect('/dashboard');
  }
});

// Submit word log for specific project (POST)
app.post('/log-words/:id', async (req, res) => {
  const projectId = parseInt(req.params.id);
  const { text, manual_count } = req.body;
  
  try {
    // Calculate word count
    let wordCount = 0;
    if (manual_count && parseInt(manual_count) > 0) {
      wordCount = parseInt(manual_count);
    } else if (text && text.trim()) {
      // TODO: Replace with your teammate's word counting function
      wordCount = text.trim().split(/\s+/).length;
    }

    if (wordCount === 0) {
      const project = await db.query(
        `SELECT p.project_id AS id, p.title, p.genre,
                COALESCE(pl.total_words, 0) AS current_words,
                COALESCE(g.target_value, 50000) AS target_words,
                COALESCE(g.daily_target, 1000) AS daily_goal
         FROM Project p
         LEFT JOIN LATERAL (
           SELECT total_words FROM ProgressLog
           WHERE project_id = p.project_id
           ORDER BY log_date DESC LIMIT 1
         ) pl ON true
         LEFT JOIN Goal g ON g.project_id = p.project_id
           AND g.is_active = true AND g.goal_type = 'total_words'
         WHERE p.project_id = $1 AND p.user_id = $2`,
        [projectId, req.session.userId]
      );
      
      return res.render('log-words', {
        username: req.session.username,
        project: project.rows[0],
        error_message: 'Please enter text or a word count',
        success_message: null
      });
    }

    // Get current total for the project
    const lastLog = await db.query(
      `SELECT total_words FROM ProgressLog
       WHERE project_id = $1 ORDER BY log_date DESC LIMIT 1`,
      [projectId]
    );

    const previousTotal = lastLog.rows.length > 0 ? lastLog.rows[0].total_words : 0;
    const newTotal = previousTotal + wordCount;

    // Insert progress log
    await db.query(
      `INSERT INTO ProgressLog (project_id, word_count, total_words, log_date)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
      [projectId, wordCount, newTotal]
    );

    console.log(`✅ Logged ${wordCount} words for project ${projectId}. New total: ${newTotal}`);
    res.redirect('/dashboard');
  } catch (err) {
    console.error('Log submission error:', err);
    res.redirect('/dashboard');
  }
});

// Statistics page
app.get('/stats', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT p.title,
              COALESCE(pl.total_words, 0) AS total_words,
              COALESCE(g.target_value, 50000) AS goal_words
       FROM Project p
       LEFT JOIN LATERAL (
         SELECT total_words
         FROM ProgressLog
         WHERE project_id = p.project_id
         ORDER BY log_date DESC
         LIMIT 1
       ) pl ON true
       LEFT JOIN Goal g ON g.project_id = p.project_id
         AND g.is_active = true
         AND g.goal_type = 'total_words'
       WHERE p.user_id = $1
       ORDER BY p.start_date DESC`,
      [req.session.userId]
    );

    const projects = result.rows.map(r => r.title);
    const totalWords = result.rows.map(r => r.total_words);
    const goalWords = result.rows.map(r => r.goal_words);

    res.render('stats', {
      username: req.session.username,
      projects,
      totalWords,
      goalWords
    });
  } catch (err) {
    console.error('Stats error:', err);
    res.render('stats', {
      username: req.session.username,
      projects: [],
      totalWords: [],
      goalWords: []
    });
  }
});

// ============ MANAGER ROUTES ============

// Manage Users (GET - list all users)
app.get('/manage-users', requireManager, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT u.user_id, u.username, u.email, u.first_name, u.last_name, 
              u.permissions, u.created_at, s.last_login
       FROM "User" u
       LEFT JOIN Security s ON u.user_id = s.user_id
       ORDER BY u.created_at DESC`
    );

    res.render('manage-users', {
      username: req.session.username,
      users: result.rows
    });
  } catch (err) {
    console.error('Manage users error:', err);
    res.render('manage-users', {
      username: req.session.username,
      users: []
    });
  }
});

// Edit User (GET - form)
app.get('/edit-user/:id', requireManager, async (req, res) => {
  const userId = parseInt(req.params.id);
  try {
    const result = await db.query(
      `SELECT u.user_id, u.username, u.email, u.first_name, u.last_name, u.permissions
       FROM "User" u
       WHERE u.user_id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.redirect('/manage-users');
    }

    res.render('edit-user', {
      username: req.session.username,
      user: result.rows[0]
    });
  } catch (err) {
    console.error('Edit user GET error:', err);
    res.redirect('/manage-users');
  }
});

// Edit User (POST - update)
app.post('/edit-user/:id', requireManager, async (req, res) => {
  const userId = parseInt(req.params.id);
  const { username, email, first_name, last_name, permissions } = req.body;

  try {
    await db.query(
      `UPDATE "User"
       SET username = $1, email = $2, first_name = $3, last_name = $4, permissions = $5
       WHERE user_id = $6`,
      [username, email, first_name, last_name, permissions, userId]
    );

    res.redirect('/manage-users');
  } catch (err) {
    console.error('Edit user POST error:', err);
    res.redirect('/manage-users');
  }
});

// Delete User (POST)
app.post('/delete-user/:id', requireManager, async (req, res) => {
  const userId = parseInt(req.params.id);
  
  // Prevent deleting yourself
  if (userId === req.session.userId) {
    return res.status(400).send('You cannot delete your own account');
  }

  try {
    await db.query('DELETE FROM "User" WHERE user_id = $1', [userId]);
    res.redirect('/manage-users');
  } catch (err) {
    console.error('Delete user error:', err);
    res.redirect('/manage-users');
  }
});

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) console.error('Session destroy error:', err);
    res.redirect('/');
  });
});

// ---------------- START SERVER ----------------
app.listen(port, () => {
  console.log(`✅ Server running on http://localhost:${port}`);
});