/**
 * Word Count Tracker
 * Simple full-stack app for tracking writing progress.
 * Includes login, sessions, CRUD (create/read/update/delete) for projects,
 * and progress tracking via PostgreSQL.
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

// Instead of importing db.js, define db here:
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
      // secure: true, // uncomment if using HTTPS (AWS)
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
console.log('🧭 Views directory:', app.get('views'));


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

// ---------------- ROUTES ----------------

// Root route → Login page
app.get('/', (req, res) => {
  res.render('login', { error_message: null });
});

// Handle login (plain-text version for testing)
app.post('/login', async (req, res) => {
  const { username, password } = req.body;

  try {
    const result = await db.query(
      `SELECT u.user_id, u.username, u.first_name, u.last_name, s.password_text
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

    console.log(`✅ Login successful for ${username}`);
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
              COALESCE(g.target_value / 50, 1000) AS daily_goal
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
      projects: result.rows
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.render('dashboard', { username: req.session.username, projects: [] });
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
              COALESCE(g.target_value / 50, 1000) AS daily_goal
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
      searchTerm
    });
  } catch (err) {
    console.error('Search error:', err);
    res.render('dashboard', { username: req.session.username, projects: [], searchTerm });
  }
});

// Add new project form
app.get('/add', (req, res) => {
  res.render('add-project', { username: req.session.username });
});

// Add new project (submit)
app.post('/add', async (req, res) => {
  const { title, genre, targetWords, currentWords, startDate } = req.body;
  try {
    const project = await db.query(
      `INSERT INTO Project (user_id, title, genre, start_date)
       VALUES ($1, $2, $3, $4)
       RETURNING project_id`,
      [req.session.userId, title, genre, startDate]
    );

    const projectId = project.rows[0].project_id;

    // Add goal
    await db.query(
      `INSERT INTO Goal (project_id, goal_type, target_value, start_date, is_active)
       VALUES ($1, 'total_words', $2, $3, true)`,
      [projectId, parseInt(targetWords), startDate]
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
      `SELECT p.project_id AS id, p.title, p.genre, p.start_date,
              COALESCE(pl.total_words, 0) AS current_words,
              COALESCE(g.target_value, 50000) AS target_words,
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
    project.daily_goal = Math.round(project.target_words / 50);

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
  const { title, genre, targetWords, currentWords, startDate } = req.body;

  try {
    // Update Project
    await db.query(
      `UPDATE Project
       SET title = $1, genre = $2, start_date = $3
       WHERE project_id = $4 AND user_id = $5`,
      [title, genre, startDate, projectId, req.session.userId]
    );

    // Update Goal
    await db.query(
      `UPDATE Goal
       SET target_value = $1
       WHERE project_id = $2 AND goal_type = 'total_words' AND is_active = true`,
      [parseInt(targetWords), projectId]
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
