const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');

// --- CONFIGURATION ---
// Pointe vers le JSON fusionné que tu as créé avec le script précédent
const JSON_FILE = './database_finale.json';
const DB_FILE = 'C:\\Users\\Alex19\\Desktop\\Program\\ALStream\\Data\\database.db';

// Clés API
const TMDB_API_KEY = "88e7889f0345fe7b5054e6db1b09b47a";
const LANGUAGE = "fr-FR";

// --- INIT ---
const db = new sqlite3.Database(DB_FILE);
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- FONCTIONS API (Jikan + TMDB) ---
async function getJikanInfo(query) {
    try {
        const url = `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(query.replace(/-/g, ' '))}&limit=1`;
        const res = await axios.get(url);
        if (!res.data.data || !res.data.data.length) return null;
        const anime = res.data.data[0];
        return {
            titre: anime.title_english || anime.title,
            synopsis: anime.synopsis ? anime.synopsis.replace('[Written by MAL Rewrite]', '').trim() : "Synopsis indisponible.",
            affiche: anime.images.jpg.large_image_url,
            backdrop: anime.trailer.images.maximum_image_url || "",
            note: anime.score || 0,
            date: anime.aired.string || "",
            genres: anime.genres ? anime.genres.map(g => g.name).join(', ') : "Anime"
        };
    } catch (e) { return null; }
}

async function searchTMDB_ID(query) {
    try {
        const url = `https://api.themoviedb.org/3/search/tv?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(query)}&language=${LANGUAGE}`;
        const res = await axios.get(url);
        return res.data.results[0] ? { id: res.data.results[0].id, backdrop: res.data.results[0].backdrop_path } : null;
    } catch (e) { return null; }
}

async function getTMDBSeasonImages(tmdbId, seasonNum) {
    try {
        const url = `https://api.themoviedb.org/3/tv/${tmdbId}/season/${seasonNum}?api_key=${TMDB_API_KEY}&language=${LANGUAGE}`;
        const res = await axios.get(url);
        const map = {};
        res.data.episodes.forEach(ep => {
            map[ep.episode_number] = {
                image: ep.still_path ? `https://image.tmdb.org/t/p/w500${ep.still_path}` : null,
                titre: ep.name
            };
        });
        return map;
    } catch (e) { return {}; }
}

// --- MAIN ---
(async () => {
    console.log("🚀 Démarrage Import FINAL (Multi-Lecteurs)...");

    // 1. CRÉATION DES TABLES (Nouvelle Structure)
    await new Promise(resolve => {
        db.serialize(() => {
            db.run("DROP TABLE IF EXISTS lecteurs"); // Nouvelle table
            db.run("DROP TABLE IF EXISTS episodes");
            db.run("DROP TABLE IF EXISTS animes");

            // Table Anime
            db.run(`CREATE TABLE animes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                titre TEXT, slug TEXT, synopsis TEXT, affiche TEXT, backdrop TEXT,
                note REAL, genres TEXT, date_sortie TEXT
            )`);

            // Table Episodes (Sans le lien direct)
            db.run(`CREATE TABLE episodes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                anime_id INTEGER,
                saison INTEGER,
                episode INTEGER,
                langue TEXT,
                titre TEXT,
                image TEXT,
                FOREIGN KEY(anime_id) REFERENCES animes(id),
                UNIQUE(anime_id, saison, episode, langue)
            )`);

            // Table Lecteurs (Les liens sont ici)
            db.run(`CREATE TABLE lecteurs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                episode_id INTEGER,
                nom TEXT, -- Ex: Vidmoly, Sibnet
                url TEXT,
                FOREIGN KEY(episode_id) REFERENCES episodes(id)
            )`);
            resolve();
        });
    });

    // 2. LECTURE DU JSON
    if (!fs.existsSync(JSON_FILE)) return console.error("❌ Fichier JSON introuvable");
    const jsonData = JSON.parse(fs.readFileSync(JSON_FILE));

    // Groupement
    const animeGroups = {};
    jsonData.forEach(item => {
        if (!animeGroups[item.anime]) animeGroups[item.anime] = [];
        animeGroups[item.anime].push(item);
    });

    const slugs = Object.keys(animeGroups);
    console.log(`📺 ${slugs.length} animes détectés.`);

    db.run("BEGIN TRANSACTION");

    for (const slug of slugs) {
        process.stdout.write(`\n🔍 ${slug} : `);

        // A. API JIKAN + TMDB
        let info = await getJikanInfo(slug);
        if (!info) info = { titre: slug, synopsis: "...", affiche: "", backdrop: "", note: 0, date: "", genres: "" };

        let tmdbId = null;
        let epImages = {};
        const tmdbRes = await searchTMDB_ID(info.titre);

        if (tmdbRes) {
            tmdbId = tmdbRes.id;
            if (!info.backdrop) info.backdrop = `https://image.tmdb.org/t/p/original${tmdbRes.backdrop}`;
            const seasons = [...new Set(animeGroups[slug].map(ep => ep.season))];
            for (const s of seasons) epImages[s] = await getTMDBSeasonImages(tmdbId, s);
            process.stdout.write(`✅ API OK `);
        } else {
            process.stdout.write(`⚠️ API RAW `);
        }

        // B. INSERT ANIME
        const animeId = await new Promise(r => db.run(
            `INSERT INTO animes (titre, slug, synopsis, affiche, backdrop, note, genres, date_sortie) VALUES (?,?,?,?,?,?,?,?)`,
            [info.titre, slug, info.synopsis, info.affiche, info.backdrop, info.note, info.genres, info.date],
            function () { r(this.lastID); }
        ));

        // C. INSERT EPISODES & LECTEURS
        let count = 0;
        for (const ep of animeGroups[slug]) {
            let title = `Episode ${ep.episode}`;
            let img = info.backdrop || info.affiche;
            if (epImages[ep.season] && epImages[ep.season][ep.episode]) {
                if (epImages[ep.season][ep.episode].titre) title = epImages[ep.season][ep.episode].titre;
                if (epImages[ep.season][ep.episode].image) img = epImages[ep.season][ep.episode].image;
            }

            // 1. Insérer l'épisode
            const epId = await new Promise(r => db.run(
                `INSERT OR IGNORE INTO episodes (anime_id, saison, episode, langue, titre, image) VALUES (?,?,?,?,?,?)`,
                [animeId, ep.season, ep.episode, ep.lang, title, img],
                function () {
                    // Si INSERT IGNORE ne fait rien, on doit récupérer l'ID existant
                    if (this.lastID) r(this.lastID);
                    else db.get(`SELECT id FROM episodes WHERE anime_id=? AND saison=? AND episode=? AND langue=?`,
                        [animeId, ep.season, ep.episode, ep.lang], (err, row) => r(row ? row.id : null));
                }
            ));

            // 2. Insérer les lecteurs (Liens)
            if (epId && ep.lecteurs) {
                for (const lecteur of ep.lecteurs) {
                    db.run(`INSERT INTO lecteurs (episode_id, nom, url) VALUES (?,?,?)`, [epId, lecteur.nom, lecteur.url]);
                }
            }
            count++;
        }
        process.stdout.write(`-> ${count} eps.`);
        await delay(1000); // Pause Jikan
    }

    db.run("COMMIT");
    db.close();
    console.log("\n✅ Import terminé !");
})();