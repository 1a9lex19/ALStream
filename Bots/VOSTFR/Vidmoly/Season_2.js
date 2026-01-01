const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// const open = require('open'); 

puppeteer.use(StealthPlugin());

// --- SETUP SERVEUR WEB ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// --- VARIABLES GLOBALES ---
let browser = null;
let isRunning = false;
let stats = { anime: 0, episode: 0, error: 0 };
let jsonDatabase = [];

// --- DATABASE ---
const DB_NAME = 'C:\\Users\\Alex19\\Desktop\\Program\\Clear\\Data\\Anime Links\\VOSTFR\\Season 2\\Vidmoly\\Season_2.db';
const JSON_FILE = 'C:\\Users\\Alex19\\Desktop\\Program\\Clear\\Data\\Anime Links\\VOSTFR\\Season 2\\Vidmoly\\Season_2.json';
const db = new sqlite3.Database(DB_NAME);

// Initialisation table
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS episodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        anime_name TEXT,
        season INTEGER,
        episode_num TEXT,
        language TEXT,
        vidmoly_link TEXT,
        UNIQUE(anime_name, season, episode_num, language)
    )`);
});

const CONFIG = {
    BASE_URL_CATALOGUE: 'https://anime-sama.tv/catalogue/?type%5B%5D=Anime&search=&page=',
    MAX_PAGES_CATALOGUE: 30,
    MAX_SAISONS_CHECK: 10,
    LANGUES: ['vostfr']
};

// Chargement JSON existant
if (fs.existsSync(JSON_FILE)) {
    try {
        const raw = fs.readFileSync(JSON_FILE);
        jsonDatabase = JSON.parse(raw);
    } catch (e) { jsonDatabase = []; }
} else { jsonDatabase = []; }

function saveToJsonRealTime(entry) {
    jsonDatabase.push(entry);
    fs.writeFileSync(JSON_FILE, JSON.stringify(jsonDatabase, null, 2));
}

// --- SOCKET.IO ---
io.on('connection', (socket) => {
    socket.emit('stats', stats);

    socket.on('start', async (data) => {
        if (isRunning) return;
        isRunning = true;
        
        const startFrom = data && data.startFrom ? data.startFrom : null;
        
        io.emit('bot-status', 'running');
        log(`🚀 Démarrage du Bot (Mode Strict : Pas de Vidmoly = Next Anime)`, 'info');
        if(startFrom) log(`📍 Départ forcé à : "${startFrom}"`, 'info');
        
        try {
            await runBot(startFrom);
        } catch (e) {
            log(`❌ Erreur fatale : ${e.message}`, 'error');
        } finally {
            isRunning = false;
            io.emit('bot-status', 'stopped');
            log('🏁 Processus terminé.', 'success');
        }
    });

    socket.on('stop', async () => {
        if (!isRunning) return;
        log('⚠️ Arrêt demandé...', 'error');
        isRunning = false; 
        if (browser) await browser.close();
    });
});

function log(msg, type = 'info') {
    if(type !== 'skip') console.log(`[${type.toUpperCase()}] ${msg}`);
    io.emit('log', { msg, type });
}

function updateStats(type) {
    if (stats[type] !== undefined) stats[type]++;
    io.emit('stats', stats);
}

const delay = (time) => new Promise(resolve => setTimeout(resolve, time));

// =========================================================================
// CŒUR DU BOT
// =========================================================================
async function runBot(startFromName = null) {
    stats = { anime: 0, episode: 0, error: 0 };
    io.emit('stats', stats);

    browser = await puppeteer.launch({
        headless: false,
        defaultViewport: null,
        args: ['--start-maximized', '--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    browser.on('targetcreated', async (target) => {
        if (target.type() === 'page') {
            const p = await target.page();
            if (p && p.url() !== 'about:blank') try { await p.close(); } catch(e){}
        }
    });

    // -------------------------------------------------------------------------
    // PHASE 1 : SCAN CATALOGUE
    // -------------------------------------------------------------------------
    let allAnimeLinks = [];
    log(`📥 PHASE 1 : Scan du catalogue...`, 'info');

    for (let i = 1; i <= CONFIG.MAX_PAGES_CATALOGUE; i++) {
        if (!isRunning) break;
        try {
            await page.goto(`${CONFIG.BASE_URL_CATALOGUE}${i}`, { waitUntil: 'domcontentloaded' });
            await delay(500);
            
            const links = await page.evaluate(() => 
                Array.from(document.querySelectorAll('a[href^="https://anime-sama.tv/catalogue/"]'))
                .map(a => a.href)
                .filter(l => !l.includes('?'))
            );
            
            allAnimeLinks = allAnimeLinks.concat(links);
            log(`Page ${i} : ${links.length} animes trouvés.`, 'info');
        } catch (e) { }
    }
    allAnimeLinks = [...new Set(allAnimeLinks)];
    log(`✅ ${allAnimeLinks.length} animes à traiter.`, 'success');

    // -------------------------------------------------------------------------
    // PHASE 2 : TRAITEMENT (FILTRE S2 + STRICT VIDMOLY)
    // -------------------------------------------------------------------------
    const stmt = db.prepare("INSERT OR IGNORE INTO episodes (anime_name, season, episode_num, language, vidmoly_link) VALUES (?, ?, ?, ?, ?)");

    let skipping = !!startFromName; 

    for (const link of allAnimeLinks) {
        if (!isRunning) break;

        const cleanLink = link.endsWith('/') ? link.slice(0, -1) : link;
        const animeName = cleanLink.split('/').pop();

        // LOGIQUE DE SAUT (Start From)
        if (skipping) {
            if (animeName.toLowerCase().includes(startFromName.toLowerCase())) {
                skipping = false;
                log(`🎯 CIBLE TROUVÉE : ${animeName}.`, 'success');
            } else {
                log(`⏩ Ignoré (Avant cible) : ${animeName}`, 'skip');
                continue;
            }
        }
        
        log(`📺 ANIME : ${animeName}`, 'info');
        updateStats('anime');

        // =====================================================================
        // VÉRIFICATION INITIALE SAISON 2
        // =====================================================================
        let hasValidSeason2 = false;
        log(`🔍 Vérif S2 + Vidmoly...`, 'info');

        for (const checkLang of CONFIG.LANGUES) {
            if(!isRunning) break;
            const s2Url = `${cleanLink}/saison2/${checkLang}/`;
            try {
                await page.goto(s2Url, { waitUntil: 'domcontentloaded' });
                const isDead = await page.evaluate(() => document.body.innerText.includes("Page introuvable"));
                if (!isDead) {
                    await page.waitForSelector('#playerDF', { timeout: 3000 }).catch(()=>null);
                    await ensureVidmoly(page); 
                    const checkLink = await getIframeSrc(page);
                    if (checkLink && checkLink.includes('vidmoly')) {
                        hasValidSeason2 = true;
                        break; 
                    }
                }
            } catch(e) {}
        }

        if (!hasValidSeason2) {
            log(`⏩ Anime ignoré (Pas de S2 ou pas de Vidmoly).`, 'skip');
            continue; 
        }

        log(`✅ Saison 2 OK. Démarrage.`, 'success');

        // =====================================================================
        // BOUCLE DE SCRAPING (Commence à s=2)
        // =====================================================================
        let stopAnime = false;

        for (let s = 2; s <= CONFIG.MAX_SAISONS_CHECK; s++) {
            if (stopAnime || !isRunning) break;

            let seasonFound = false;

            for (const lang of CONFIG.LANGUES) {
                if (stopAnime || !isRunning) break;

                const targetUrl = `${cleanLink}/saison${s}/${lang}/`;

                try {
                    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
                    
                    const isDead = await page.evaluate(() => document.body.innerText.includes("Page introuvable"));
                    if (isDead) continue;

                    seasonFound = true;
                    log(`   📂 Saison ${s} [${lang}]`, 'info');
                    
                    await page.waitForSelector('#playerDF', { timeout: 8000 }).catch(()=>null);
                    await ensureVidmoly(page);
                    await delay(1500);

                    let episodeCurrent = 1;
                    let hasNext = true;
                    let processedLinks = new Set(); 

                    while (hasNext && isRunning) {
                        if (stopAnime) break;
                        const currentLink = await getIframeSrc(page);
                        
                        // Anti-Doublon Mémoire
                        if (currentLink && processedLinks.has(currentLink)) {
                            log(`      🛑 DOUBLON DÉTECTÉ. PASSAGE ANIME SUIVANT.`, 'error');
                            stopAnime = true;
                            hasNext = false;
                            break;
                        }

                        // --- CHANGEMENT ICI : CONDITION STRICTE ---
                        if (currentLink && currentLink.includes('vidmoly')) {
                            // C'est du Vidmoly -> On sauvegarde
                            log(`      🔗 Ep ${episodeCurrent} : ${currentLink}`, 'link');
                            
                            stmt.run(animeName, s, episodeCurrent.toString(), lang, currentLink);
                            
                            const jsonEntry = {
                                anime: animeName,
                                season: s,
                                episode: episodeCurrent,
                                lang: lang,
                                link: currentLink
                            };
                            saveToJsonRealTime(jsonEntry);

                            updateStats('episode');
                            processedLinks.add(currentLink);

                        } else {
                            // --- C'EST ICI QUE ÇA TUE L'ANIME ---
                            // Si le lien existe mais n'est PAS Vidmoly (ex: Sibnet, Sendvid, ou vide)
                            log(`      ⛔ Pas de Vidmoly (Lien: ${currentLink || "Aucun"}). ARRÊT ANIME.`, 'error');
                            stopAnime = true;
                            hasNext = false;
                            break; // Sort du while
                        }

                        // Navigation Suivant (Seulement si on n'a pas arrêté)
                        if (!stopAnime) {
                            const nextBtnHandle = await page.evaluateHandle(() => {
                                const btns = Array.from(document.querySelectorAll('a, button'));
                                return btns.find(b => b.innerText && b.innerText.includes('SUIVANT'));
                            });

                            const isVisible = await page.evaluate((el) => {
                                if (!el) return false;
                                const style = window.getComputedStyle(el);
                                return style.display !== 'none' && style.visibility !== 'hidden' && !el.disabled;
                            }, nextBtnHandle);

                            if (nextBtnHandle && isVisible) {
                                await page.evaluate(el => el.click(), nextBtnHandle);
                                await delay(4000); 
                                await ensureVidmoly(page);

                                const newLink = await getIframeSrc(page);
                                
                                if (newLink === currentLink) {
                                    log(`      🛑 Lien figé. STOP ANIME.`, 'error');
                                    stopAnime = true;
                                    hasNext = false;
                                } else {
                                    episodeCurrent++;
                                }
                            } else {
                                hasNext = false; 
                            }
                        }
                    }

                } catch (e) { 
                    log(`      ❌ Erreur technique`, 'error');
                }
            }
            if ((!seasonFound && s > 2) || stopAnime) break;
        }
    }

    stmt.finalize();
    if(browser) await browser.close();
}


// =========================================================================
// UTILITAIRES
// =========================================================================

async function getIframeSrc(page) {
    return await page.evaluate(() => {
        const ifr = document.getElementById('playerDF');
        return ifr ? ifr.src : "";
    });
}

async function ensureVidmoly(page) {
    const current = await getIframeSrc(page);
    if (current && current.includes('vidmoly')) return;

    await page.evaluate(() => {
        const select = document.getElementById('selectLecteurs');
        if (select) {
            for (let i = 0; i < select.options.length; i++) {
                if (select.options[i].text.toLowerCase().includes('vidmoly')) {
                    select.selectedIndex = i;
                    select.dispatchEvent(new Event('change', { bubbles: true }));
                    return;
                }
            }
        }
    });

    let r = 0;
    while (r < 20) {
        const src = await getIframeSrc(page);
        if (src && src.includes('vidmoly')) return;
        await new Promise(res => setTimeout(res, 100));
        r++;
    }
}

server.listen(4000, () => {
    console.log('✅ Serveur lancé sur http://localhost:4000');
});