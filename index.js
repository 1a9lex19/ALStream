require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const axios = require('axios');
const puppeteer = require('puppeteer');
const session = require('express-session');
const app = express();

const TMDB_API_KEY = process.env.TMDB_API_KEY;
const port = process.env.PORT || 8000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// --- CONFIGURATION EXPRESS ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// CONFIGURATION STATIQUE
app.use(express.static(path.join(__dirname, 'public')));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- SESSION CONFIGURATION ---
app.use(session({
    secret: process.env.SESSION_SECRET || 'your-secret-key',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false, httpOnly: true, maxAge: 24 * 60 * 60 * 1000 }
}));

// --- MIDDLEWARE D'AUTHENTIFICATION ---
function checkAuth(req, res, next) {
    if (req.session && req.session.admin) {
        next();
    } else {
        res.redirect('/admin/login');
    }
}

// --- CONFIGURATION DE LA BASE DE DONNÉES ---
const dbPath = path.join(__dirname, 'Data', 'database.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error("Erreur DB:", err.message);
    else {
        console.log("✅ Connecté à database.db");
        db.serialize(() => {
            // Table ANIMES
            db.run(`CREATE TABLE IF NOT EXISTS animes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                titre TEXT, synopsis TEXT, affiche TEXT, backdrop TEXT, 
                note REAL, date_sortie TEXT, genres TEXT, tags TEXT
            )`);
            
            // Table EPISODES (Mise à jour : plus de colonne 'lien', ajout 'titre' et 'image')
            db.run(`CREATE TABLE IF NOT EXISTS episodes (
                id INTEGER PRIMARY KEY AUTOINCREMENT, 
                anime_id INTEGER, 
                saison INTEGER, 
                episode INTEGER, 
                langue TEXT, 
                image TEXT, 
                titre TEXT,
                FOREIGN KEY(anime_id) REFERENCES animes(id)
            )`);

            // NOUVEAU : Table LECTEURS (Pour le multi-lecteurs)
            db.run(`CREATE TABLE IF NOT EXISTS lecteurs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                episode_id INTEGER,
                nom TEXT,
                url TEXT,
                FOREIGN KEY(episode_id) REFERENCES episodes(id)
            )`);
        });
    }
});

const fullCategories = {
    "Anime": ["Shounen", "Seinen", "Isekai"]
};

// --- TMDB GENRES ---
async function loadTmdbGenres() {
    if (!TMDB_API_KEY) return;
    try {
        const [movieRes, tvRes] = await Promise.all([
            axios.get(`https://api.themoviedb.org/3/genre/movie/list?api_key=${TMDB_API_KEY}&language=en-EN`),
            axios.get(`https://api.themoviedb.org/3/genre/tv/list?api_key=${TMDB_API_KEY}&language=en-EN`)
        ]);
        const set = new Set(fullCategories.Anime);
        movieRes.data.genres.forEach(g => set.add(g.name));
        tvRes.data.genres.forEach(g => set.add(g.name));
        fullCategories.Anime = Array.from(set).sort();
    } catch (e) { console.error('Erreur TMDB genres:', e.message); }
}
loadTmdbGenres();

// --- ROUTES ---

app.get('/', (req, res) => res.render('landing'));

app.get('/catalog', (req, res) => {
    const searchQuery = req.query.search;
    const tagFilter = req.query.tag;

    let sql = "SELECT * FROM animes";
    let params = [];

    if (searchQuery) {
        sql += " WHERE titre LIKE ?";
        params.push(`%${searchQuery}%`);
    } else if (tagFilter) {
        sql += " WHERE genres LIKE ? OR tags LIKE ?";
        params.push(`%${tagFilter}%`, `%${tagFilter}%`);
    }

    sql += " ORDER BY titre ASC";

    db.all(sql, params, (err, animes) => {
        if (err) return res.status(500).send("Erreur DB");
        res.render('index', {
            animes: animes || [],
            categories: fullCategories,
            currentTags: tagFilter ? [tagFilter] : []
        });
    });
});

// --- NOUVELLE ROUTE WATCH (Multi-lecteurs) ---
app.get('/watch/:id', (req, res) => {
    const animeId = req.params.id;

    // 1. Récupérer l'Anime
    db.get("SELECT * FROM animes WHERE id = ?", [animeId], (err, anime) => {
        if (err || !anime) return res.status(404).send("Anime introuvable");

        // 2. Récupérer les Épisodes
        db.all("SELECT * FROM episodes WHERE anime_id = ? ORDER BY saison ASC, episode ASC", [animeId], (err, episodes) => {
            if (err) return res.status(500).send("Erreur épisodes");

            // Si aucun épisode, on affiche direct
            if (!episodes || episodes.length === 0) {
                return res.render('watch', { anime, episodes: [] });
            }

            // 3. Récupérer les Lecteurs associés
            const episodeIds = episodes.map(e => e.id);
            const placeholders = episodeIds.map(() => '?').join(','); // Génère "?,?,?"

            db.all(`SELECT * FROM lecteurs WHERE episode_id IN (${placeholders})`, episodeIds, (err, rows) => {
                if (err) {
                    console.error("Erreur lecteurs:", err);
                    return res.render('watch', { anime, episodes });
                }

                // 4. Organiser les lecteurs par épisode
                const lecteursMap = {};
                if (rows) {
                    rows.forEach(l => {
                        if (!lecteursMap[l.episode_id]) lecteursMap[l.episode_id] = [];
                        lecteursMap[l.episode_id].push({ nom: l.nom, url: l.url });
                    });
                }

                // 5. Injecter les lecteurs dans chaque objet épisode
                episodes.forEach(ep => {
                    ep.lecteurs = lecteursMap[ep.id] || [];
                    // Fallback pour compatibilité (si besoin)
                    ep.lien = (ep.lecteurs.length > 0) ? ep.lecteurs[0].url : "";
                });

                res.render('watch', { anime, episodes });
            });
        });
    });
});

// Admin routes...
app.get('/admin/login', (req, res) => res.render('login', { error: null, success: null }));
app.post('/admin/login', (req, res) => {
    if (req.body.password === ADMIN_PASSWORD) {
        req.session.admin = true;
        res.redirect('/admin');
    } else res.render('login', { error: 'Incorrect', success: null });
});

app.get('/admin', checkAuth, (req, res) => {
    db.all("SELECT * FROM animes ORDER BY titre ASC", (err, animes) => {
        res.render('admin', { animeList: animes || [], categories: fullCategories });
    });
});

app.listen(port, () => {
    console.log(`🎬 Serveur prêt : http://localhost:${port}`);
});