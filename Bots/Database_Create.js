const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');

// --- CONFIGURATION ---
const JSON_FILE = 'C:\\Users\\Alex19\\Desktop\\Program\\ALStream\\Data\\Anime Links\\All Season\\Vidmoly\\Anime.json';
const DB_FILE = 'C:\\Users\\Alex19\\Desktop\\Program\\ALStream\\Data\\database.db';
const TMDB_API_KEY = "88e7889f0345fe7b5054e6db1b09b47a";
const LANGUAGE = "fr-FR"; // Langue des infos

// --- VÉRIFICATIONS ---
if (!fs.existsSync(JSON_FILE)) {
    console.error(`❌ Erreur : Le fichier ${JSON_FILE} n'existe pas.`);
    process.exit(1);
}

const db = new sqlite3.Database(DB_FILE);

// --- FONCTIONS TMDB ---

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 1. Rechercher l'ID TMDB à partir du nom
async function searchTMDB(query) {
    try {
        const cleanQuery = query.replace(/-/g, ' ').replace(/\d{4}$/, ''); // Enlève les tirets
        const url = `https://api.themoviedb.org/3/search/multi?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(cleanQuery)}&language=${LANGUAGE}`;
        const res = await axios.get(url);

        // On prend le premier résultat qui est soit TV soit Movie
        const found = res.data.results.find(r => r.media_type === 'tv' || r.media_type === 'movie');
        return found ? { id: found.id, type: found.media_type } : null;
    } catch (e) {
        return null;
    }
}

// 2. Récupérer les détails complets (Synopsis, Genres, Images)
async function getTMDBDetails(tmdbId, type) {
    try {
        const url = `https://api.themoviedb.org/3/${type}/${tmdbId}?api_key=${TMDB_API_KEY}&language=${LANGUAGE}`;
        const res = await axios.get(url);
        const data = res.data;

        return {
            titre: data.title || data.name,
            synopsis: data.overview || "Aucun synopsis disponible.",
            affiche: data.poster_path ? `https://image.tmdb.org/t/p/w500${data.poster_path}` : "https://placehold.co/500x750?text=No+Poster",
            backdrop: data.backdrop_path ? `https://image.tmdb.org/t/p/original${data.backdrop_path}` : "",
            note: data.vote_average || 0,
            date: data.first_air_date || data.release_date || "",
            genres: data.genres ? data.genres.map(g => g.name).join(', ') : "Anime"
        };
    } catch (e) {
        return null;
    }
}

// 3. Récupérer les infos d'une saison (pour les images d'épisodes)
async function getTMDBSeason(tmdbId, seasonNum) {
    try {
        const url = `https://api.themoviedb.org/3/tv/${tmdbId}/season/${seasonNum}?api_key=${TMDB_API_KEY}&language=${LANGUAGE}`;
        const res = await axios.get(url);
        // On retourne un dictionnaire : { "1": { image, titre }, "2": ... }
        const episodesMap = {};
        res.data.episodes.forEach(ep => {
            episodesMap[ep.episode_number] = {
                titre: ep.name,
                image: ep.still_path ? `https://image.tmdb.org/t/p/w500${ep.still_path}` : null,
                overview: ep.overview
            };
        });
        return episodesMap;
    } catch (e) {
        return {}; // Si la saison n'existe pas sur TMDB (ex: Saisons custom Anime-Sama)
    }
}


// --- MAIN SCRIPT ---

(async () => {
    console.log("🚀 Démarrage de l'import INTELLIGENT (JSON + TMDB)...");

    // 1. INIT DB
    await new Promise(resolve => {
        db.serialize(() => {
            console.log("♻️  Reset des tables...");
            db.run("DROP TABLE IF EXISTS episodes");
            db.run("DROP TABLE IF EXISTS animes");

            db.run(`CREATE TABLE animes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                titre TEXT,
                slug TEXT, -- Pour faire le lien avec Anime-Sama
                synopsis TEXT,
                affiche TEXT,
                backdrop TEXT,
                note REAL,
                genres TEXT,
                date_sortie TEXT
            )`);

            db.run(`CREATE TABLE episodes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                anime_id INTEGER,
                saison INTEGER,
                episode INTEGER,
                langue TEXT,
                lien TEXT,
                titre TEXT,
                image TEXT, -- Nouvelle colonne pour la preview
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

    // Groupement par Anime
    const animeGroups = {};
    jsonData.forEach(item => {
        if (!animeGroups[item.anime]) animeGroups[item.anime] = [];
        animeGroups[item.anime].push(item);
    });

    const animeSlugs = Object.keys(animeGroups);
    console.log(`📺 ${animeSlugs.length} animes à traiter avec TMDB.`);
    console.log("☕ Cela va prendre du temps pour respecter les limites de l'API...");

    // 3. TRAITEMENT BOUCLE
    let totalAdded = 0;

    db.run("BEGIN TRANSACTION"); // Optimisation vitesse écriture

    for (const slug of animeSlugs) {
        process.stdout.write(`\n🔍 ${slug} : `);

        // A. RECHERCHE TMDB
        const tmdbResult = await searchTMDB(slug);
        let animeInfo = null;
        let tmdbId = null;
        let mediaType = 'tv';

        if (tmdbResult) {
            tmdbId = tmdbResult.id;
            mediaType = tmdbResult.type;
            animeInfo = await getTMDBDetails(tmdbId, mediaType);
            process.stdout.write(`✅ TMDB Trouvé "${animeInfo.titre}" `);
        } else {
            // Fallback si pas trouvé
            process.stdout.write(`❌ Pas trouvé sur TMDB (Utilisation données brutes) `);
            animeInfo = {
                titre: slug.toUpperCase(), // On met le slug en majuscule
                synopsis: "Description non disponible.",
                affiche: "https://placehold.co/500x750?text=No+Image",
                backdrop: "",
                note: 0,
                date: "",
                genres: "Inconnu"
            };
        }

        // B. CRÉATION ANIME EN BASE
        const animeId = await new Promise((resolve) => {
            db.run(
                `INSERT INTO animes (titre, slug, synopsis, affiche, backdrop, note, genres, date_sortie) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [animeInfo.titre, slug, animeInfo.synopsis, animeInfo.affiche, animeInfo.backdrop, animeInfo.note, animeInfo.genres, animeInfo.date],
                function (err) { resolve(this.lastID); }
            );
        });

        // C. PRÉCHARGEMENT DES INFOS SAISONS (Pour éviter de spammer l'API)
        // On regarde quelles saisons sont présentes dans le JSON pour cet anime
        const episodesList = animeGroups[slug];
        const seasonsInJson = [...new Set(episodesList.map(ep => ep.season))];
        const seasonsMeta = {};

        if (tmdbId && mediaType === 'tv') {
            for (const sNum of seasonsInJson) {
                // On récupère les infos (titres/images) de la saison S chez TMDB
                seasonsMeta[sNum] = await getTMDBSeason(tmdbId, sNum);
                await delay(200); // Petite pause pour l'API
            }
        }

        // D. INSERTION ÉPISODES
        let count = 0;
        for (const ep of episodesList) {
            // On cherche les métadonnées TMDB pour cet épisode précis
            let epTitle = `Épisode ${ep.episode}`;
            let epImage = animeInfo.backdrop; // Par défaut le backdrop de l'anime

            if (seasonsMeta[ep.season] && seasonsMeta[ep.season][ep.episode]) {
                const meta = seasonsMeta[ep.season][ep.episode];
                if (meta.titre) epTitle = meta.titre;
                if (meta.image) epImage = meta.image;
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
        process.stdout.write(`-> ${count} eps ajoutés.`);

        await delay(100); // Pause entre chaque anime
    }

    db.run("COMMIT");
    db.close();
    console.log(`\n\n🎉 TERMINÉ ! ${totalAdded} épisodes importés avec métadonnées.`);

})();