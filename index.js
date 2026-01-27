require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const bcrypt = require('bcrypt');
const app = express();
const { fork } = require('child_process');

// --- CONFIGURATION ---
const PORT = process.env.PORT || 8000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, httpOnly: true, maxAge: 24 * 60 * 60 * 1000 }
}));

// --- DATABASE & HELPERS ---
const dbPath = path.join(__dirname, 'data', 'database.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) return console.error("❌ Erreur DB:", err.message);
    console.log("✅ Connecté à database.db");
    initDb();
});

// Wrapper Async pour SQLite
const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function (err) { err ? reject(err) : resolve(this); });
});
const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => { err ? reject(err) : resolve(row); });
});
const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => { err ? reject(err) : resolve(rows); });
});

function initDb() {
    db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS animes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            titre TEXT, 
            slug TEXT UNIQUE,
            synopsis TEXT, affiche TEXT, backdrop TEXT, 
            note REAL, date_sortie TEXT, genres TEXT, tags TEXT, jour_sortie TEXT
        )`);
        db.run(`CREATE TABLE IF NOT EXISTS episodes (
            id INTEGER PRIMARY KEY AUTOINCREMENT, anime_id INTEGER, saison INTEGER, 
            episode INTEGER, langue TEXT, image TEXT, titre TEXT, 
            FOREIGN KEY(anime_id) REFERENCES animes(id) ON DELETE CASCADE
        )`);
        db.run(`CREATE TABLE IF NOT EXISTS lecteurs (
            id INTEGER PRIMARY KEY AUTOINCREMENT, episode_id INTEGER, nom TEXT, url TEXT, 
            FOREIGN KEY(episode_id) REFERENCES episodes(id) ON DELETE CASCADE
        )`);
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, email TEXT UNIQUE, 
            password TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
    });
}

// Fonction pour créer un slug (Titre -> titre-propre)
function slugify(text) {
    return text.toString().toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, '-')
        .replace(/[^\w\-]+/g, '')
        .replace(/\-\-+/g, '-')
        .replace(/^-+/, '')
        .replace(/-+$/, '');
}

// --- MIDDLEWARES ---
app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    // Catégories disponibles pour l'admin
    res.locals.categories = { "Anime": ["Shounen", "Seinen", "Isekai", "Romance", "Action", "Fantastique", "Drame"] };
    next();
});

const checkAuth = (req, res, next) => {
    if (req.session && req.session.admin) next();
    else res.redirect('/admin/login');
};

// --- ROUTES AUTHENTIFICATION USER ---
app.get('/login', (req, res) => res.render('auth', { error: null }));

app.post('/register', async (req, res) => {
    const { username, email, password } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await dbRun(`INSERT INTO users (username, email, password) VALUES (?, ?, ?)`, [username, email, hashedPassword]);
        req.session.user = { id: result.lastID, username, email };
        res.redirect('/profile');
    } catch (e) {
        res.render('auth', { error: "Nom d'utilisateur ou email déjà pris." });
    }
});

app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const user = await dbGet(`SELECT * FROM users WHERE email = ?`, [email]);
        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.render('auth', { error: "Identifiants incorrects." });
        }
        req.session.user = { id: user.id, username: user.username, email: user.email };
        res.redirect('/profile');
    } catch (e) {
        res.render('auth', { error: "Erreur serveur." });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

app.get('/profile', (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    res.render('profile');
});

// --- ROUTES PUBLIQUES (FRONTEND) ---
app.get('/', (req, res) => res.render('landing'));

app.get('/catalog', async (req, res) => {
    const { search, tag } = req.query;
    let sql = "SELECT * FROM animes";
    let params = [];

    if (search) {
        sql += " WHERE titre LIKE ?";
        params.push(`%${search}%`);
    } else if (tag) {
        sql += " WHERE genres LIKE ? OR tags LIKE ?";
        params.push(`%${tag}%`, `%${tag}%`);
    }
    sql += " ORDER BY titre ASC";

    try {
        const animes = await dbAll(sql, params);
        res.render('index', { animes, currentTags: tag ? [tag] : [] });
    } catch (e) {
        res.status(500).send("Erreur catalogue");
    }
});

const axios = require('axios');

// Route Planning
// Variable globale pour mettre en cache le planning d'Anime-Sama (éviter de lancer Puppeteer à chaque clic)
let animeSamaCache = {
    titles: [],
    lastUpdate: 0
};

// Fonction pour récupérer les titres présents sur le planning d'Anime-Sama
async function getAnimeSamaPlanningTitles() {
    const CACHE_DURATION = 60 * 60 * 1000; // 1 Heure
    const now = Date.now();

    // Si le cache est valide, on le retourne direct
    if (animeSamaCache.titles.length > 0 && (now - animeSamaCache.lastUpdate < CACHE_DURATION)) {
        return animeSamaCache.titles;
    }

    console.log("🔄 Mise à jour du cache planning depuis Anime-Sama...");

    // On lance Puppeteer (en mode léger)
    // Note : On utilise le même puppeteer que tes bots
    const puppeteer = require('puppeteer-extra');
    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
        const page = await browser.newPage();
        await page.goto('https://anime-sama.si/planning/', { waitUntil: 'domcontentloaded' });

        // On récupère tous les titres affichés dans les cartes du planning
        const titles = await page.evaluate(() => {
            // Sélecteur basé sur la structure d'AS (titre dans les cartes)
            const elements = document.querySelectorAll('.carte_planning .titre_planning, .card-title, h3');
            return Array.from(elements).map(el => el.textContent.trim().toLowerCase());
        });

        animeSamaCache = {
            titles: titles,
            lastUpdate: now
        };
        console.log(`✅ Cache mis à jour : ${titles.length} animes trouvés sur AS.`);

        await browser.close();
        return titles;

    } catch (e) {
        console.error("❌ Erreur récupération planning AS:", e.message);
        await browser.close();
        return []; // En cas d'erreur, on renvoie vide (le filtre sera désactivé ou permissif)
    }
}

// Fonction de comparaison "Floue" (Fuzzy Match simple)
function isAnimePresent(aniListTitle, asList) {
    if (!asList || asList.length === 0) return true; // Si pas de liste AS, on affiche tout par défaut

    const t1 = aniListTitle.toLowerCase().replace(/[^a-z0-9 ]/g, "");
    const words = t1.split(' ').filter(w => w.length > 3); // On garde les mots de plus de 3 lettres

    // On cherche si un titre AS contient une bonne partie des mots du titre AniList
    return asList.some(asTitle => {
        const t2 = asTitle.replace(/[^a-z0-9 ]/g, "");
        // Si le titre contient le nom exact
        if (t2.includes(t1) || t1.includes(t2)) return true;

        // Sinon on compte les mots communs (ex: "Jujutsu Kaisen" vs "Jujutsu Kaisen S2")
        const matches = words.filter(w => t2.includes(w));
        return matches.length >= 1; // Si au moins 1 mot clé correspond (C'est permissif pour gérer Fr/Anglais)
    });
}

// ROUTE PLANNING MODIFIÉE
// Route Planning (Version Fichier Cache)
app.get('/planning', (req, res) => {
    const jsonPath = 'data/planning_cache.json';

    // 1. Structure de base vide et ordonnée
    const daysOrder = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];
    const finalPlanning = {};

    daysOrder.forEach(day => {
        finalPlanning[day] = { date: '', animes: [] };
    });

    // 2. Lecture et Tri des données
    try {
        if (fs.existsSync(jsonPath)) {
            const rawData = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));

            if (Array.isArray(rawData)) {
                rawData.forEach(item => {
                    // Sécurisation de la majuscule (lundi -> Lundi)
                    if (item.jour) {
                        const dayKey = item.jour.charAt(0).toUpperCase() + item.jour.slice(1).toLowerCase();

                        if (finalPlanning[dayKey]) {
                            finalPlanning[dayKey].animes.push(item);
                            // On prend la date du premier anime trouvé pour ce jour
                            if (!finalPlanning[dayKey].date && item.date_jour) {
                                finalPlanning[dayKey].date = item.date_jour;
                            }
                        }
                    }
                });
            }
        }
    } catch (e) {
        console.error("Erreur lecture planning:", e);
    }

    // 3. Calcul du jour actuel (pour la classe 'active')
    const todayIndex = new Date().getDay(); // 0 = Dimanche, 1 = Lundi...
    // Astuce pour convertir l'index JS (0=Dim) en index tableau (Dimanche est à la fin ou au début selon ta liste)
    // Ici daysOrder est Lundi...Dimanche.
    const jsDayMap = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
    const todayName = jsDayMap[todayIndex];

    res.render('planning', {
        planning: finalPlanning,
        daysOrder: daysOrder,
        today: todayName,
        user: req.user || null
    });
});

app.get('/watch/:slug', async (req, res) => {
    try {
        const anime = await dbGet("SELECT * FROM animes WHERE slug = ?", [req.params.slug]);
        if (!anime) return res.status(404).render('error', { message: "Anime introuvable" });

        const episodes = await dbAll("SELECT * FROM episodes WHERE anime_id = ? ORDER BY saison ASC, episode ASC", [anime.id]);

        if (episodes.length > 0) {
            const epIds = episodes.map(e => e.id).join(',');
            // S'il n'y a pas d'épisodes, epIds sera vide, attention à l'erreur SQL
            const lecteurs = epIds ? await dbAll(`SELECT * FROM lecteurs WHERE episode_id IN (${epIds})`) : [];

            const lecteursMap = {};
            lecteurs.forEach(l => {
                if (!lecteursMap[l.episode_id]) lecteursMap[l.episode_id] = [];
                lecteursMap[l.episode_id].push({ nom: l.nom, url: l.url });
            });

            episodes.forEach(ep => {
                ep.lecteurs = lecteursMap[ep.id] || [];
                ep.lecteurs.sort((a, b) => a.nom.localeCompare(b.nom, undefined, { numeric: true }));
                ep.lien = (ep.lecteurs.length > 0) ? ep.lecteurs[0].url : "";
            });
        }

        res.render('watch', { anime, episodes });
    } catch (e) {
        console.error(e);
        res.status(500).send("Erreur serveur");
    }
});

app.get('/api/search-live', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.json([]);
    try {
        const results = await dbAll(`
            SELECT titre, slug, affiche, synopsis 
            FROM animes 
            WHERE titre LIKE ? 
            ORDER BY CASE WHEN titre LIKE ? THEN 1 ELSE 2 END, titre ASC 
            LIMIT 6`,
            [`%${query}%`, `${query}%`]
        );
        res.json(results);
    } catch (e) {
        res.json([]);
    }
});

// --- ROUTES ADMIN (BACKEND) ---

app.get('/admin/login', (req, res) => res.render('login', { error: null, success: null }));

app.post('/admin/login', (req, res) => {
    if (req.body.password === ADMIN_PASSWORD) {
        req.session.admin = true;
        res.redirect('/admin');
    } else {
        res.render('login', { error: 'Mot de passe incorrect', success: null });
    }
});

// --- DASHBOARD ADMIN CORRIGÉ ---
app.get('/admin', checkAuth, async (req, res) => {
    try {
        // 1. On récupère la liste des animes (pour le tableau et les listes déroulantes)
        const animes = await dbAll("SELECT * FROM animes ORDER BY titre ASC");

        // 2. On récupère la liste des épisodes (pour la section "Remove Specific Episode")
        // On fait une jointure (JOIN) pour avoir le titre de l'anime associé à l'épisode
        const episodes = await dbAll(`
            SELECT episodes.id, episodes.saison, episodes.episode, animes.titre as anime_titre 
            FROM episodes 
            JOIN animes ON episodes.anime_id = animes.id 
            ORDER BY animes.titre ASC, episodes.saison ASC, episodes.episode ASC
        `);

        // 3. On envoie le tout à la vue avec les BONS noms de variables
        res.render('admin', {
            animeList: animes,       // <--- C'est ici que ça corrige votre erreur
            episodeList: episodes,   // <--- Pour la section suppression d'épisode
            user: req.session.user,
            success: null,
            error: null
        });

    } catch (e) {
        console.error("Erreur admin dashboard:", e);
        // En cas d'erreur, on affiche quand même la page mais avec des listes vides pour ne pas planter
        res.render('admin', {
            animeList: [],
            episodeList: [],
            user: req.session.user,
            error: "Erreur lors du chargement des données."
        });
    }
});


/* --- LANCEMENT DU BOT EN ARRIÈRE-PLAN
function startBotProcess() {
    // On utilise la variable 'path' qui est déjà déclarée en haut de ton fichier
    const botScript = path.join(__dirname, 'Bots\\Add_Epi.js');

    console.log(`🤖 Lancement du bot via : ${botScript}`);

    const botProcess = fork(botScript);

    botProcess.on('message', (msg) => {
        console.log(`[BOT MESSAGE] ${msg}`);
    });

    botProcess.on('exit', (code) => {
        console.log(`⚠️ Le bot s'est arrêté avec le code : ${code}`);
    });
}

// Lancer le bot
startBotProcess();*/

// --- START SERVER ---
app.listen(PORT, () => {
    console.log(`🎬 ALStream démarré sur http://localhost:${PORT}`);
});
