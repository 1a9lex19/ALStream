const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');

// --- CONFIGURATION ---
const JSON_FILE = 'C:\\Users\\Alex19\\Desktop\\Program\\ALStream\\Data\\Anime Links\\All Season\\Vidmoly\\vidmoly.json';
const DB_FILE = 'C:\\Users\\Alex19\\Desktop\\Program\\ALStream\\Data\\database.db';

// 🔑 CLÉ TMDB (Requise pour les images)
const TMDB_API_KEY = "88e7889f0345fe7b5054e6db1b09b47a";
const LANGUAGE = "fr-FR"; // Langue pour TMDB

// --- VÉRIFICATIONS ---
if (!fs.existsSync(JSON_FILE)) {
    console.error(`❌ Erreur : Le fichier ${JSON_FILE} n'existe pas.`);
    process.exit(1);
}

const db = new sqlite3.Database(DB_FILE);
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ============================================================
// 1. API JIKAN (Principal : Infos Anime)
// ============================================================

async function getJikanInfo(query) {
    try {
        const cleanQuery = query.replace(/-/g, ' ');
        const url = `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(cleanQuery)}&limit=1`;
        const res = await axios.get(url);

        if (!res.data || !res.data.data || res.data.data.length === 0) return null;

        const anime = res.data.data[0];

        return {
            titre: anime.title_english || anime.title,
            synopsis: anime.synopsis ? anime.synopsis.replace('[Written by MAL Rewrite]', '').trim() : "Synopsis non disponible.",
            affiche: anime.images.jpg.large_image_url || anime.images.jpg.image_url,
            // On tentera de remplacer le backdrop par celui de TMDB plus tard
            backdrop: anime.trailer.images.maximum_image_url || "",
            note: anime.score || 0,
            date: anime.aired.string || "",
            genres: anime.genres ? anime.genres.map(g => g.name).join(', ') : "Anime"
        };
    } catch (e) {
        if (e.response && e.response.status === 429) console.warn("⚠️ Jikan Rate Limit (429)");
        return null;
    }
}

// ============================================================
// 2. API TMDB (Secondaire : Images Episodes)
// ============================================================

// A. Trouver l'ID TMDB à partir du titre (trouvé par Jikan ou le slug)
async function searchTMDB_ID(query) {
    try {
        const url = `https://api.themoviedb.org/3/search/tv?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(query)}&language=${LANGUAGE}`;
        const res = await axios.get(url);
        if (res.data.results && res.data.results.length > 0) {
            return { id: res.data.results[0].id, backdrop: res.data.results[0].backdrop_path };
        }
        return null;
    } catch (e) { return null; }
}

// B. Récupérer les images d'une saison spécifique
async function getTMDBSeasonImages(tmdbId, seasonNum) {
    try {
        const url = `https://api.themoviedb.org/3/tv/${tmdbId}/season/${seasonNum}?api_key=${TMDB_API_KEY}&language=${LANGUAGE}`;
        const res = await axios.get(url);

        const imagesMap = {};
        res.data.episodes.forEach(ep => {
            // On stocke l'image et le titre de l'épisode si dispo
            imagesMap[ep.episode_number] = {
                image: ep.still_path ? `https://image.tmdb.org/t/p/w500${ep.still_path}` : null,
                titre: ep.name
            };
        });
        return imagesMap;
    } catch (e) { return {}; }
}

// ============================================================
// MAIN SCRIPT
// ============================================================

(async () => {
    console.log("🚀 Démarrage HYBRIDE (Jikan pour Infos + TMDB pour Images)...");

    // 1. INIT DB
    await new Promise(resolve => {
        db.serialize(() => {
            console.log("♻️  Reset des tables...");
            db.run("DROP TABLE IF EXISTS episodes");
            db.run("DROP TABLE IF EXISTS animes");

            db.run(`CREATE TABLE animes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                titre TEXT,
                slug TEXT,
                synopsis TEXT,
                affiche TEXT,
                backdrop TEXT,
                note REAL,
                genres TEXT,
                date_sortie TEXT,
                source_api TEXT DEFAULT 'JIKAN+TMDB'
            )`);

            db.run(`CREATE TABLE episodes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                anime_id INTEGER,
                saison INTEGER,
                episode INTEGER,
                langue TEXT,
                lien TEXT,
                titre TEXT,
                image TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(anime_id) REFERENCES animes(id),
                UNIQUE(anime_id, saison, episode, langue)
            )`);
            resolve();
        });
    });

    // 2. LOAD JSON
    const rawData = fs.readFileSync(JSON_FILE);
    const jsonData = JSON.parse(rawData);

    // Groupement
    const animeGroups = {};
    jsonData.forEach(item => {
        if (!animeGroups[item.anime]) animeGroups[item.anime] = [];
        animeGroups[item.anime].push(item);
    });

    const animeSlugs = Object.keys(animeGroups);
    console.log(`📺 ${animeSlugs.length} animes à traiter.`);
    let totalAdded = 0;

    db.run("BEGIN TRANSACTION");

    for (const slug of animeSlugs) {
        process.stdout.write(`\n🔍 ${slug} : `);

        // --- ÉTAPE 1 : INFOS PRINCIPALES VIA JIKAN ---
        let animeInfo = await getJikanInfo(slug);

        // Fallback si Jikan échoue
        if (!animeInfo) {
            animeInfo = {
                titre: slug.toUpperCase(),
                synopsis: "...",
                affiche: "https://placehold.co/500x750?text=No+Image",
                backdrop: "",
                note: 0,
                date: "",
                genres: "Inconnu"
            };
            process.stdout.write(`❌ Jikan (Raw) `);
        } else {
            process.stdout.write(`✅ Jikan `);
        }

        // --- ÉTAPE 2 : IMAGES ÉPISODES VIA TMDB ---
        let tmdbData = null;
        let episodesImages = {}; // Stockera { "1": { "1": img, "2": img }, "2": ... } (Saison -> Episode -> Data)

        // On cherche l'ID TMDB en utilisant le titre trouvé par Jikan (souvent plus précis que le slug)
        const searchTitle = animeInfo.titre || slug.replace(/-/g, ' ');
        const tmdbResult = await searchTMDB_ID(searchTitle);

        if (tmdbResult) {
            process.stdout.write(`+ ✅ TMDB `);

            // Si Jikan n'avait pas de backdrop, on prend celui de TMDB (souvent meilleure qualité)
            if (!animeInfo.backdrop && tmdbResult.backdrop) {
                animeInfo.backdrop = `https://image.tmdb.org/t/p/original${tmdbResult.backdrop}`;
            }

            // On regarde quelles saisons sont dans le JSON pour ne télécharger que celles-là
            const episodesList = animeGroups[slug];
            const seasonsNeeded = [...new Set(episodesList.map(ep => ep.season))];

            for (const sNum of seasonsNeeded) {
                episodesImages[sNum] = await getTMDBSeasonImages(tmdbResult.id, sNum);
            }
        } else {
            process.stdout.write(`+ ❌ TMDB `);
        }

        // --- ÉTAPE 3 : INSERTION DB ---

        // A. Anime
        const animeId = await new Promise((resolve) => {
            db.run(
                `INSERT INTO animes (titre, slug, synopsis, affiche, backdrop, note, genres, date_sortie) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [animeInfo.titre, slug, animeInfo.synopsis, animeInfo.affiche, animeInfo.backdrop, animeInfo.note, animeInfo.genres, animeInfo.date],
                function (err) { resolve(this.lastID); }
            );
        });

        // B. Épisodes
        const episodesList = animeGroups[slug];
        let count = 0;

        for (const ep of episodesList) {
            let epTitle = `Episode ${ep.episode}`;
            let epImage = animeInfo.backdrop || animeInfo.affiche; // Fallback par défaut

            // Est-ce qu'on a trouvé une image spécifique via TMDB ?
            if (episodesImages[ep.season] && episodesImages[ep.season][ep.episode]) {
                const specificData = episodesImages[ep.season][ep.episode];
                if (specificData.image) epImage = specificData.image; // Image HD de l'épisode !
                if (specificData.titre) epTitle = specificData.titre; // Titre officiel (ex: "L'attaque commence")
            }

            await new Promise(resolve => {
                db.run(
                    `INSERT OR IGNORE INTO episodes (anime_id, saison, episode, langue, lien, titre, image) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [animeId, ep.season, ep.episode, ep.lang, ep.link, epTitle, epImage],
                    (err) => {
                        if (!err) { count++; totalAdded++; }
                        resolve();
                    }
                );
            });
        }
        process.stdout.write(`-> ${count} eps.`);

        // ⚠️ Pause OBLIGATOIRE pour Jikan (Rate Limit)
        await delay(1000);
    }

    db.run("COMMIT");
    db.close();
    console.log(`\n\n🎉 TERMINÉ ! ${totalAdded} épisodes importés.`);
})();