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

// --- ADMIN PASSWORD (À CHANGER) ---
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD

// --- SESSION CONFIGURATION ---
app.use(session({
    secret: process.env.SESSION_SECRET || 'your-secret-key-change-in-production',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false, httpOnly: true, maxAge: 24 * 60 * 60 * 1000 } // 24 heures
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
const dbPath = path.join(__dirname, 'Data\\database.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error("Erreur DB:", err.message);
    else {
        console.log("Connecté à database.db");
        // INITIALISATION DES TABLES (Indispensable pour éviter le "Cannot GET")
        db.serialize(() => {
            db.run(`CREATE TABLE IF NOT EXISTS animes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                titre TEXT,
                synopsis TEXT,
                affiche TEXT,
                backdrop TEXT,
                note REAL,
                date_sortie TEXT
            )`);
            db.run(`CREATE TABLE IF NOT EXISTS episodes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                anime_id INTEGER,
                saison INTEGER,
                episode INTEGER,
                langue TEXT,
                lien TEXT,
                image TEXT,
                titre TEXT,
                FOREIGN KEY(anime_id) REFERENCES animes(id)
            )`);
        });
    }
});


// --- CONFIGURATION EXPRESS ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const fullCategories = {
    //"Movies": ["Action", "Adventure", "Sci-Fi"],
    //"TV Shows": ["Drama", "Sitcom", "Thriller"],
    "Anime": ["Shounen", "Seinen", "Isekai"]
};

// --- TMDB: récupérer les genres (movie + tv) et ajouter aux tags Anime
async function loadTmdbGenres() {
    if (!TMDB_API_KEY) return console.warn('TMDB_API_KEY manquante : skipping genre load');
    try {
        const [movieRes, tvRes] = await Promise.all([
            axios.get(`https://api.themoviedb.org/3/genre/movie/list?api_key=${TMDB_API_KEY}&language=en-EN`),
            axios.get(`https://api.themoviedb.org/3/genre/tv/list?api_key=${TMDB_API_KEY}&language=en-EN`)
        ]);
        const set = new Set(fullCategories.Anime || []);
        if (movieRes.data && Array.isArray(movieRes.data.genres)) movieRes.data.genres.forEach(g => set.add(g.name));
        if (tvRes.data && Array.isArray(tvRes.data.genres)) tvRes.data.genres.forEach(g => set.add(g.name));
        fullCategories.Anime = Array.from(set).sort();
        console.log(`TMDB genres loaded: ${fullCategories.Anime.length} tags added to Anime category`);
    } catch (e) {
        console.error('Erreur chargement genres TMDB:', e.message || e);
    }
}

// Lancer le chargement en tâche de fond au démarrage
loadTmdbGenres();

// --- SCRAPER
async function scrapeEpisodes(animeSamaUrl, seasonNumber, tmdbEpisodes, dbAnimeId) {
    const bravePath = "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe";
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: false,
            executablePath: bravePath,
            args: ['--no-sandbox']
        });
        const page = await browser.newPage();
        await page.goto(animeSamaUrl, { waitUntil: 'domcontentloaded' });
        await new Promise(r => setTimeout(r, 5000));

        const optionsCount = await page.$$eval('#selectEpisodes option', opts => opts.length);
        const stmt = db.prepare("INSERT INTO episodes (anime_id, saison, episode, langue, lien, image, titre) VALUES (?, ?, ?, ?, ?, ?, ?)");

        for (let i = 0; i < tmdbEpisodes.length; i++) {
            const epData = tmdbEpisodes[i];
            let finalLink = "PENDING_LINK";
            const previewImg = epData.still_path ? `https://image.tmdb.org/t/p/w500${epData.still_path}` : null;

            if (i < optionsCount) {
                await page.select('#selectEpisodes', i.toString());
                await new Promise(r => setTimeout(r, 2000));
                finalLink = await page.evaluate(() => document.getElementById('playerDF')?.src || "PENDING_LINK");
            }
            stmt.run(dbAnimeId, seasonNumber, epData.episode_number, "VOSTFR", finalLink, previewImg, epData.name);
        }
        stmt.finalize();
    } catch (e) { console.error("Scraper Error:", e); }
    finally { if (browser) await browser.close(); }
}

// --- ROUTES ---

// 1. Accueil
app.get('/', (req, res) => res.render('landing'));

// 2. Catalogue (CORRIGÉ)
app.get('/catalog', (req, res) => {
    const tagFilter = req.query.tag; // legacy single-tag param
    const tagsParam = req.query.tags; // comma-separated multiple tags
    const searchQuery = req.query.search;

    let sql = "SELECT * FROM animes";
    const params = [];

    if (tagsParam) {
        const tags = tagsParam.split(',').map(t => t.trim()).filter(Boolean);
        if (tags.length) {
            const clauses = [];
            tags.forEach(t => {
                clauses.push("(genres LIKE ? OR tags LIKE ?)");
                params.push(`%${t}%`, `%${t}%`);
            });
            sql += " WHERE " + clauses.join(' OR ');
        }
    } else if (tagFilter) {
        sql += " WHERE (genres LIKE ? OR tags LIKE ?)";
        params.push(`%${tagFilter}%`, `%${tagFilter}%`);
    } else if (searchQuery) {
        sql += " WHERE titre LIKE ?";
        params.push(`%${searchQuery}%`);
    }

    // Trier alphabétiquement par titre
    sql += " ORDER BY titre ASC";

    db.all(sql, params, (err, animes) => {
        if (err) {
            console.error(err.message);
            return res.status(500).send("Erreur lors de la récupération depuis la base de données.");
        }

        // currentTags: array used by client to highlight active tags
        const currentTags = tagsParam ? tagsParam.split(',').map(t => t.trim()).filter(Boolean) : (tagFilter ? [tagFilter] : []);
        res.render('index', {
            animes: animes || [],
            categories: fullCategories,
            currentTag: tagFilter || null,
            currentTags: currentTags
        });
    });
});

// API: return aggregated tags (from genres + tags columns) with counts
app.get('/api/tags', (req, res) => {
    db.all("SELECT genres, tags FROM animes", (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const counts = {};
        rows.forEach(r => {
            ['genres', 'tags'].forEach(col => {
                if (!r[col]) return;
                r[col].split(',').map(x => x.trim()).filter(Boolean).forEach(tag => {
                    counts[tag] = (counts[tag] || 0) + 1;
                });
            });
        });
        const result = Object.keys(counts).map(tag => ({ tag, count: counts[tag] })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
        res.json(result);
    });
});

// 3. Watch
app.get('/watch/:id', (req, res) => {
    db.get("SELECT * FROM animes WHERE id = ?", [req.params.id], (err, anime) => {
        if (!anime) return res.status(404).send("Anime non trouvé");
        db.all("SELECT * FROM episodes WHERE anime_id = ? ORDER BY saison ASC, episode ASC", [req.params.id], (err, episodes) => {
            res.render('watch', { anime, episodes: episodes || [] });
        });
    });
});

// 4. Admin Login
app.get('/admin/login', (req, res) => {
    res.render('login', { error: null, success: null });
});

app.post('/admin/login', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        req.session.admin = true;
        res.redirect('/admin');
    } else {
        res.render('login', { error: 'Mot de passe incorrect', success: null });
    }
});

app.get('/admin/logout', (req, res) => {
    req.session.admin = false;
    res.redirect('/admin/login');
});

// 5. Admin (Protected Route)
app.get('/admin', checkAuth, (req, res) => {
    db.all("SELECT * FROM animes ORDER BY titre ASC", (err, animes) => {
        const sqlEp = `SELECT episodes.*, animes.titre as anime_titre FROM episodes 
                       JOIN animes ON episodes.anime_id = animes.id 
                       ORDER BY animes.titre, saison, episode`;
        db.all(sqlEp, (err, episodes) => {
            res.render('admin', { animeList: animes || [], episodeList: episodes || [], categories: fullCategories });
        });
    });
});

app.get('/admin/import', checkAuth, (req, res) => res.render('admin-import'));

// 6. API TMDB
app.post('/api/search-tmdb', checkAuth, async (req, res) => {
    try {
        const r = await axios.get(`https://api.themoviedb.org/3/search/multi?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(req.body.query)}&language=fr-FR`);
        res.json(r.data.results.filter(x => x.media_type === 'tv' || x.media_type === 'movie'));
    } catch (e) { res.json({ error: e.message }); }
});

app.post('/api/import-tmdb', checkAuth, async (req, res) => {
    const { tmdbId, mediaType, animeSamaUrl } = req.body;
    try {
        const { data: details } = await axios.get(`https://api.themoviedb.org/3/${mediaType}/${tmdbId}?api_key=${TMDB_API_KEY}&language=fr-FR`);

        db.run(`INSERT INTO animes (titre, synopsis, affiche, backdrop, note, date_sortie) VALUES (?, ?, ?, ?, ?, ?)`,
            [details.title || details.name, details.overview,
            details.poster_path ? `https://image.tmdb.org/t/p/w500${details.poster_path}` : '',
            details.backdrop_path ? `https://image.tmdb.org/t/p/original${details.backdrop_path}` : '',
            details.vote_average, details.first_air_date || details.release_date],
            async function (err) {
                if (err) return res.json({ error: err.message });
                const newId = this.lastID;

                if (mediaType === 'tv') {
                    const { data: sData } = await axios.get(`https://api.themoviedb.org/3/tv/${tmdbId}/season/1?api_key=${TMDB_API_KEY}&language=fr-FR`);
                    if (animeSamaUrl) scrapeEpisodes(animeSamaUrl, 1, sData.episodes, newId);
                }
                res.json({ success: true });
            }
        );
    } catch (e) { res.json({ error: e.message }); }
});

app.post('/admin/delete-work', checkAuth, (req, res) => {
    db.run("DELETE FROM episodes WHERE anime_id = ?", [req.body.anime_id], () => {
        db.run("DELETE FROM animes WHERE id = ?", [req.body.anime_id], () => res.redirect('/admin'));
    });
});

app.listen(port, () => console.log(`🎬 Serveur prêt : http://localhost:${port}`));