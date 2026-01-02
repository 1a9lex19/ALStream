const fs = require('fs');

// --- CONFIGURATION DES FICHIERS ---
// Remplace par les noms exacts de tes fichiers
const FICHIER_1 = 'C:\\Users\\Alex19\\Desktop\\Program\\ALStream\\Data\\Anime Links\\All Season\\Sibnet\\sibnet.json';   // Ton fichier avec les liens Sibnet
const FICHIER_2 = 'C:\\Users\\Alex19\\Desktop\\Program\\ALStream\\Data\\Anime Links\\All Season\\Vidmoly\\vidmoly.json';  // Ton fichier avec les liens Vidmoly
const FICHIER_SORTIE = './database_finale.json'; // Le résultat

// Fonction pour détecter le nom du lecteur via le lien
function detecterLecteur(url) {
    if (!url) return "Inconnu";
    if (url.includes('sibnet.ru')) return "Sibnet";
    if (url.includes('vidmoly')) return "Vidmoly";
    if (url.includes('voe')) return "Voe";
    if (url.includes('uqload')) return "Uqload";
    return "Autre Lecteur";
}

// Fonction principale
function fusionnerBasesDeDonnees() {
    try {
        console.log("🔄 Lecture des fichiers...");

        // 1. Lire les fichiers
        if (!fs.existsSync(FICHIER_1) || !fs.existsSync(FICHIER_2)) {
            console.error("❌ Erreur : Un des fichiers d'entrée n'existe pas !");
            return;
        }

        const rawData1 = fs.readFileSync(FICHIER_1);
        const rawData2 = fs.readFileSync(FICHIER_2);

        const data1 = JSON.parse(rawData1);
        const data2 = JSON.parse(rawData2);

        console.log(`📊 Fichier 1 : ${data1.length} entrées`);
        console.log(`📊 Fichier 2 : ${data2.length} entrées`);

        // 2. Fusionner les données
        // On utilise une "Map" pour stocker les épisodes uniques
        // La clé sera : "nom-anime_S1_E1_vostfr"
        const episodeMap = new Map();

        const ajouterEpisode = (item) => {
            // Création d'une clé unique pour identifier l'épisode
            // On nettoie les espaces et on met tout en minuscule pour éviter les doublons
            const uniqueKey = `${item.anime.trim()}_S${item.season}_E${item.episode}_${item.lang.trim()}`.toLowerCase();

            // Si l'épisode n'existe pas encore dans notre liste, on le crée
            if (!episodeMap.has(uniqueKey)) {
                episodeMap.set(uniqueKey, {
                    anime: item.anime,
                    season: item.season,
                    episode: item.episode,
                    lang: item.lang,
                    // On initialise le tableau lecteurs vide
                    lecteurs: []
                });
            }

            // On récupère l'entrée existante
            const entry = episodeMap.get(uniqueKey);

            // On ajoute le lecteur si le lien existe
            if (item.link && item.link.trim() !== "") {
                const nomDuLecteur = detecterLecteur(item.link);

                // Vérifier si ce lien n'est pas déjà présent pour éviter les doublons exacts
                const lienExisteDeja = entry.lecteurs.find(l => l.url === item.link);

                if (!lienExisteDeja) {
                    entry.lecteurs.push({
                        nom: nomDuLecteur,
                        url: item.link
                    });
                }
            }
        };

        // Traiter les deux listes
        data1.forEach(ajouterEpisode);
        data2.forEach(ajouterEpisode);

        // 3. Convertir la Map en tableau final
        const resultatFinal = Array.from(episodeMap.values());

        // OPTIONNEL : Trier par Anime puis Saison puis Episode
        resultatFinal.sort((a, b) => {
            if (a.anime < b.anime) return -1;
            if (a.anime > b.anime) return 1;
            if (a.season !== b.season) return a.season - b.season;
            return a.episode - b.episode;
        });

        // 4. Sauvegarder le résultat
        fs.writeFileSync(FICHIER_SORTIE, JSON.stringify(resultatFinal, null, 2));

        console.log("✅ Terminé !");
        console.log(`📁 Résultat sauvegardé dans : ${FICHIER_SORTIE}`);
        console.log(`🎉 Nombre total d'épisodes uniques : ${resultatFinal.length}`);

    } catch (error) {
        console.error("❌ Une erreur s'est produite :", error);
    }
}

// Lancer le script
fusionnerBasesDeDonnees();