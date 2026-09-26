// Petit jeu: météorites avec mots français; il faut taper la traduction anglaise pour les détruire.

window.addEventListener('load', ()=>{
  console.log('Game init: DOM loaded');

  // DOM elements
  const canvas = document.getElementById('gameCanvas');
  const ctx = canvas.getContext('2d');
  const input = document.getElementById('input');
  const scoreEl = document.getElementById('score');
  const livesEl = document.getElementById('lives');
  const startBtn = document.getElementById('start');
  const ui = document.getElementById('ui');
  const gameBottom = document.getElementById('game-bottom');
  const restartBottom = document.getElementById('restart-bottom');

  let width = 800, height = 600;
  let meteors = [];
  let spawnTimer = 0; // ms accumulator
  let spawnInterval = 4000; // ms (increased base spawn interval)
  let lastTime = 0;
  let score = 0;
  let lives = 3;
  let lostWords = []; // words that caused a life loss (for game over summary)
  let destroyedCount = 0; // count of successfully destroyed meteors (for pause every 10)
  let spawnCount = 0; // number of meteors spawned
  let pendingPause = false; // when true, wait for screen to be empty then pause 5s
  let running = false;
  let words = [];
  // language key detection
  const LANG_NAMES = {
    fr:'Français', en:'English', ja:'日本語', es:'Español',
    de:'Deutsch', it:'Italiano', pt:'Português', zh:'中文',
    ko:'한국어', ru:'Русский', ar:'العربية', nl:'Nederlands',
    sv:'Svenska', pl:'Polski', tr:'Türkçe', hi:'हिन्दी'
  };
  let langA = 'fr', langB = 'en'; // detected from word data
  // controls elements (will be looked up after DOM ready)
  const sliderLives = document.getElementById('sliderLives');
  const sliderSpeed = document.getElementById('sliderSpeed');
  const sliderSpawn = document.getElementById('sliderSpawn');
  const valLives = document.getElementById('valLives');
  const valSpeed = document.getElementById('valSpeed');
  const valSpawn = document.getElementById('valSpawn');
  const dirMode = document.getElementById('dirMode');
  const gameModeEl = document.getElementById('gameMode');
  const imageModeEl = document.getElementById('imageMode');
  let imageMode = false;
  const imageCache = {}; // englishWord -> HTMLImageElement | 'loading' | 'failed'
  let imagePendingCount = 0; // images still being fetched/decoded

  // initial values from sliders
  lives = parseInt(sliderLives.value, 10) || 3;
  valLives.textContent = lives;
  let speedMultiplier = parseFloat(sliderSpeed.value) || 1.0;
  valSpeed.textContent = speedMultiplier.toFixed(2) + '×';
  spawnInterval = parseInt(sliderSpawn.value, 10) || 1500;
  valSpawn.textContent = (spawnInterval/1000).toFixed(1) + 's';

  // slider events
  sliderLives.addEventListener('input', ()=>{
    const v = parseInt(sliderLives.value,10);
    valLives.textContent = v;
    // change current lives without resetting the game
    const diff = v - lives;
    lives = v;
    if(diff>0) updateUI();
    else updateUI();
  });
  sliderSpeed.addEventListener('input', ()=>{
    speedMultiplier = parseFloat(sliderSpeed.value);
    valSpeed.textContent = speedMultiplier.toFixed(2) + '×';
    // apply multiplier to existing meteors' speeds (respect lengthFactor if present)
    for(const m of meteors){ m.speed = (m.baseSpeed || m.speed) * (m.lengthFactor || 1) * speedMultiplier; }
  });
  sliderSpawn.addEventListener('input', ()=>{
    spawnInterval = parseInt(sliderSpawn.value,10);
    valSpawn.textContent = (spawnInterval/1000).toFixed(1) + 's';
  });

  // direction mode select (populated dynamically after words load)
  let currentDir = 'fr-en';
  if(dirMode){
    dirMode.addEventListener('change', ()=>{ currentDir = dirMode.value; });
  }

  // detect language keys from word data and populate direction dropdown
  function detectAndPopulateLangs(data){
    if(!Array.isArray(data) || data.length === 0) return;
    const keys = Object.keys(data[0]);
    if(keys.length >= 2){ langA = keys[0]; langB = keys[1]; }
    if(!dirMode) return;
    dirMode.innerHTML = '';
    const nameA = LANG_NAMES[langA] || langA;
    const nameB = LANG_NAMES[langB] || langB;
    [{v:`${langA}-${langB}`, t:`${nameA} → ${nameB}`},
     {v:`${langB}-${langA}`, t:`${nameB} → ${nameA}`},
     {v:'both', t:'Les deux'}].forEach(o=>{
      const opt = document.createElement('option');
      opt.value = o.v; opt.textContent = o.t;
      dirMode.appendChild(opt);
    });
    currentDir = dirMode.value;
    input.placeholder = 'Tapez la traduction...';
  }

  // Return the best key to use for image search (prefer English)
  function getImageKey(wordObj){
    if(wordObj.en) return wordObj.en;
    for(const k of Object.keys(wordObj)){
      if(!['ja','zh','ar','ko','hi','ru'].includes(k)) return wordObj[k];
    }
    return wordObj[Object.keys(wordObj)[0]];
  }

  // Strip leading articles so "la pomme" → "pomme", "l'ananas" → "ananas"
  function stripArticles(word, lang){
    const map = {
      fr: /^(la |le |l['']|les |du |de la |de |des |un |une )/i,
      pt: /^(a |o |as |os |um |uma )/i,
      en: /^(the |an |a )/i,
      es: /^(la |el |los |las |un |una )/i,
      de: /^(der |die |das |ein |eine |dem |den )/i,
      it: /^(la |il |lo |le |gli |l['']|un |una )/i,
    };
    const re = map[lang];
    return re ? word.replace(re, '').trim() : word;
  }

  // Update Start button: disabled with counter while images are still pending in image mode
  function updateStartBtn(){
    if(!startBtn) return;
    if(imageMode && imagePendingCount > 0){
      startBtn.disabled = true;
      startBtn.textContent = `⏳ ${imagePendingCount} image${imagePendingCount > 1 ? 's' : ''} en cours…`;
    } else {
      startBtn.disabled = false;
      startBtn.textContent = 'Start';
    }
  }

  // --- Image fetch queue (max 3 concurrent to avoid Wikipedia rate-limiting) ---
  const imageQueue = [];
  let imageFetching = 0;
  const MAX_CONCURRENT_IMG = 3;

  function processImageQueue(){
    while(imageFetching < MAX_CONCURRENT_IMG && imageQueue.length > 0){
      fetchWordImageNow(imageQueue.shift());
    }
  }

  // Fetch and cache an image for a word using the MediaWiki pageimages API
  function preloadWordImage(wordObj){
    const key = getImageKey(wordObj);
    if(imageCache[key] !== undefined) return;
    imageCache[key] = 'loading';
    imagePendingCount++;
    updateStartBtn();
    imageQueue.push(wordObj);
    processImageQueue();
  }

  function fetchWordImageNow(wordObj){
    imageFetching++;
    const key = getImageKey(wordObj); // used as cache key (raw word)

    // Build ordered list of (word, lang) pairs to try — English first, then all others
    const tryList = [];
    if(wordObj.en){
      tryList.push({word: wordObj.en, lang: 'en'});
    }
    for(const [k, v] of Object.entries(wordObj)){
      if(k !== 'en' && !['zh','ar','ko','hi','ru'].includes(k)){
        tryList.push({word: v, lang: k});
      }
    }
    for(const [k, v] of Object.entries(wordObj)){
      if(['ja'].includes(k)) tryList.push({word: v, lang: 'ja'});
    }

    const done = (value) => {
      imageCache[key] = value;
      imageFetching--;
      imagePendingCount--;
      updateStartBtn();
      processImageQueue();
    };

    // Try each (word, lang) pair sequentially until one returns an image
    function tryNext(idx){
      if(idx >= tryList.length){ done('failed'); return; }
      const {word, lang} = tryList[idx];
      const cleaned = stripArticles(word, lang);
      const title = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
      const controller = new AbortController();
      const tid = setTimeout(()=>controller.abort(), 8000);
      fetch(
        `https://${lang}.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=pageimages&redirects=1&format=json&pithumbsize=300&pilimit=1&origin=*`,
        {signal: controller.signal}
      )
        .then(r=>r.json())
        .then(data=>{
          clearTimeout(tid);
          const pages = data.query && data.query.pages;
          const page = pages && Object.values(pages)[0];
          const src = page && page.thumbnail && page.thumbnail.source;
          if(src){
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = ()=>done(img);
            img.onerror = ()=>tryNext(idx + 1); // image load failed, try next lang
            img.src = src;
          } else { tryNext(idx + 1); } // no thumbnail, try next lang
        })
        .catch(()=>{ clearTimeout(tid); tryNext(idx + 1); });
    }

    tryNext(0);
  }

  // game mode select (normal | random | final-boss)
  let gameMode = gameModeEl ? gameModeEl.value : 'normal';
  if(gameModeEl){ gameModeEl.addEventListener('change', ()=>{ gameMode = gameModeEl.value; }); }

  // image mode toggle
  if(imageModeEl){
    imageModeEl.addEventListener('change', ()=>{
      imageMode = imageModeEl.checked;
      // preload images for all current words immediately when toggled on
      if(imageMode && words.length > 0){ for(const w of words) preloadWordImage(w); }
      updateStartBtn();
    });
  }

  // helper: shuffle array
  function shuffle(a){
    for(let i=a.length-1;i>0;i--){ const j = Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; }
    return a;
  }

  // mode-specific pool for final-boss
  let bossQueue = []; // for 'final-boss' mode: queue of words to finish

  function resize(){
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    width = canvas.width; height = canvas.height;
  }
  window.addEventListener('resize', resize);
  resize();

  function updateUI(){
    scoreEl.textContent = `Score: ${score}`;
    livesEl.textContent = `Vies: ${lives}`;
  }

  function loseMeteorAt(index){
    const removed = meteors.splice(index,1)[0];
    if(!removed) return;
    lostWords.push({word: removed.word, shown: removed.show});
    // In final-boss mode, a missed meteor returns to the queue.
    if(gameMode === 'final-boss'){
      bossQueue.push(removed.word);
    }
    lives -= 1;
    updateUI();
    if(lives<=0){
      endGame();
      return;
    }
    if(gameMode === 'final-boss' && bossQueue.length === 0 && meteors.length === 0){
      running = false;
      showVictory();
    }
  }
  
  function makeAsteroidShape(){
    // le contour : peu de bosses mais bien arrondies (pas de pointes)
    const points = 7 + Math.floor(Math.random()*3); // 7 à 9 bosses
    const shape = [];
    const angleStep = (Math.PI*2) / points;
    for(let i=0;i<points;i++){
      const angle = i*angleStep + (Math.random()-0.5) * angleStep*0.4;
      const radiusMul = 0.78 + Math.random()*0.34; // entre 0.78 et 1.12 : variations douces
      shape.push({angle, radiusMul});
    }
    // les cratères : petites taches sombres à des positions aléatoires
    const craterCount = 3 + Math.floor(Math.random()*3); // 3 à 5 cratères
    const craters = [];
    for(let i=0;i<craterCount;i++){
      craters.push({
        x: (Math.random()-0.5) * 1.1,
        y: (Math.random()-0.5) * 1.1,
        rx: 0.10 + Math.random()*0.10,
        ry: 0.07 + Math.random()*0.08,
        rotation: Math.random()*Math.PI
      });
    }
    return {points: shape, craters: craters};
  }

  function spawnMeteor(){
    if(words.length===0) return;
    // prevent duplicate words on screen
    const present = new Set(meteors.map(m=>m.word[langA]));
    let w = null;
    if(gameMode === 'final-boss'){
      // spawn next from bossQueue; if empty nothing to spawn
      if(bossQueue.length === 0) return;
      // find next word not already on screen; try up to bossQueue.length
      for(let i=0;i<bossQueue.length;i++){
        const cand = bossQueue[0];
        if(!present.has(cand[langA])){
          w = bossQueue.shift();
          break;
        } else {
          // rotate to try next
          bossQueue.push(bossQueue.shift());
        }
      }
      if(!w) return; // all remaining words are already displayed
    } else {
      // normal mode: choose any available word at random
      const available = words.filter(w2=>!present.has(w2[langA]));
      if(available.length===0) return; // no free words to spawn
      w = available[Math.floor(Math.random()*available.length)];
    }
    const fontSize = 26 + Math.random()*14;
    const base = 40 + Math.random()*80;
    // decide which side to display based on mode
    let showSide = langA;
    if(currentDir === 'both') showSide = (Math.random() < 0.5) ? langA : langB;
    else showSide = currentDir.split('-')[0];

  // length-based factor: base it on the word the player must type (the answer)
  const answerWord = w[showSide === langA ? langB : langA]; // player types the opposite side
  const len = Math.max(1, (answerWord||'').length);
  // map length to factor: longer answer => slower fall.
  // stronger mapping so effect is more noticeable
  const lengthFactor = Math.max(0.4, Math.min(1.8, 1.8 - len*0.08));

    const meter = {
      x: Math.random()*(width-120)+60,
      y: -50,
      baseSpeed: base,
      lengthFactor,
      speed: base * lengthFactor * speedMultiplier,
      word: w,
      show: showSide, // which language key is visible on the meteor
      fontSize,
      r: imageMode ? 55 : undefined, // larger hit-circle in image mode
      shape: makeAsteroidShape() // forme de rocher irrégulière, fixée à la création
    };
    meteors.push(meter);
    if(imageMode) preloadWordImage(w);
    // increment spawn counter and mark pending pause every 10 spawns
    spawnCount += 1;
    if(spawnCount % 10 === 0){ pendingPause = true; }
  }

  function startGame(){
    meteors = [];
    lostWords = [];
    destroyedCount = 0;
    spawnTimer = 0;
    lastTime = performance.now();
    score = 0;
    // read current control values so restart respects them
    lives = parseInt(sliderLives.value, 10) || 3;
    spawnInterval = parseInt(sliderSpawn.value, 10) || 1500;
    speedMultiplier = parseFloat(sliderSpeed.value) || 1.0;
  // ensure existing meteors (if any) use multiplier and length factor
  for(const m of meteors){ m.speed = (m.baseSpeed || m.speed) * (m.lengthFactor || 1) * speedMultiplier; }
    updateUI();
    running = true;
    document.body.classList.add('playing');
    console.log('Game started');
    // initialize mode-specific pools
    if(gameMode === 'final-boss'){
      bossQueue = shuffle(words.slice());
    }
    // preload images for all words if image mode is active
    if(imageMode){ for(const w of words) preloadWordImage(w); }
    // immediate feedback: spawn one meteor right away so the user sees something
    spawnMeteor();
    requestAnimationFrame(loop);
  }

  function endGame(){
    running = false;
    document.body.classList.remove('playing');
    showGameOver();
  }

  function showGameOver(){
    let el = document.createElement('div');
    el.className = 'game-over';
    // load high score from localStorage
    const prevHigh = parseInt(localStorage.getItem('mt_highscore') || '0', 10);
    let newHigh = prevHigh;
    if(score > prevHigh){
      localStorage.setItem('mt_highscore', String(score));
      newHigh = score;
    }
    // prepare lost words list HTML
    let lostHtml = '<em>Aucun</em>';
    if(lostWords.length>0){
      lostHtml = '<ul>' + lostWords.map(w=>{
        const left = w.word[w.shown];
        const right = w.word[w.shown === langA ? langB : langA];
        return `<li>${left} → ${right}</li>`;
      }).join('') + '</ul>';
    }
    el.innerHTML = `<div style="text-align:center">\n      <strong>Game Over</strong><br>\n      Score: ${score} <br>\n      Meilleur score: ${newHigh} <br>\n      <div style=\"margin-top:8px;text-align:left;display:inline-block;max-width:420px\">\n        <div style=\"font-weight:600;margin-bottom:6px\">Mots qui ont causé une perte de vie:</div>\n        ${lostHtml}\n      </div>\n      <div style=\"margin-top:10px\"><button id=\"go-restart\">Recommencer</button></div>\n    </div>`;
    document.body.appendChild(el);
    // hide bottom UI (input + restart) on game over
    if(gameBottom) gameBottom.style.display = 'none';
    document.getElementById('go-restart').addEventListener('click', ()=>{
      el.remove();
      // behave like the restart-bottom button: show settings and hide game bottom
      running = false;
      document.body.classList.remove('playing');
      ui.classList.add('show-controls');
      if(gameBottom) gameBottom.style.display = 'none';
      const go = document.querySelector('.game-over'); if(go) go.remove();
      input.focus();
    });
  }

  function showVictory(){
    let el = document.createElement('div');
    el.className = 'game-over';
    el.innerHTML = `<div style="text-align:center">\n      <strong>Victoire !</strong><br>\n      Vous avez terminé la liste. Score: ${score} <br>\n      <div style=\"margin-top:10px\"><button id=\"go-restart\">Recommencer</button></div>\n    </div>`;
    document.body.appendChild(el);
    if(gameBottom) gameBottom.style.display = 'none';
    document.getElementById('go-restart').addEventListener('click', ()=>{
      el.remove();
      running = false;
      document.body.classList.remove('playing');
      ui.classList.add('show-controls');
      if(gameBottom) gameBottom.style.display = 'none';
      input.focus();
    });
  }

  function loop(ts){
    if(!running) return;
    const dt = (ts - lastTime)/1000;
    lastTime = ts;

    // spawn timer
    spawnTimer += dt*1000;
    if(spawnTimer > spawnInterval){
      spawnMeteor();
      spawnTimer -= spawnInterval;
      if(spawnInterval>600) spawnInterval *= 0.995;
    }

    // If a pending pause was scheduled (every 10 spawns), wait until screen is empty then pause silently
    if(pendingPause && meteors.length === 0){
      // clear canvas so the last meteor doesn't remain visible
      ctx.clearRect(0,0,width,height);
      pendingPause = false;
      running = false;
      setTimeout(()=>{
        running = true;
        lastTime = performance.now();
        requestAnimationFrame(loop);
        input.focus();
      }, 5000);
      return; // exit loop until resumed
    }

    // update/draw
    ctx.clearRect(0,0,width,height);
    // debug overlay removed
    for(let i=meteors.length-1;i>=0;i--){
      const m = meteors[i];
      m.y += m.speed * dt;
      const r = (m.r !== undefined) ? m.r : (m.fontSize/2 + 10);

      // glow + tail to make meteors feel dynamic
      ctx.save();
      ctx.translate(m.x, m.y);
      const tailLen = Math.min(80, Math.max(26, r + m.speed * 0.08));
            const tail = ctx.createLinearGradient(-r*0.7, -tailLen, r*0.7, 0);
      tail.addColorStop(0, 'rgba(92,225,230,0)');
      tail.addColorStop(0.45, 'rgba(255,110,199,0.28)');
      tail.addColorStop(1, 'rgba(41,35,87,0.6)');
      ctx.fillStyle = tail;
      ctx.beginPath();
      ctx.moveTo(-r*0.68, -2);
      ctx.lineTo(r*0.68, -2);
      ctx.lineTo(r*0.36, -tailLen);
      ctx.lineTo(-r*0.36, -tailLen);
      ctx.closePath();
      ctx.fill();

      // le rocher : forme fixe attribuée à la création (m.shape)
      const shape = m.shape || makeAsteroidShape();

      // contour lisse et arrondi (courbes passant par les milieux des points)
      function tracerContourAsteroide(){
        const pts = shape.points.map(pt => ({
          x: Math.cos(pt.angle) * r * pt.radiusMul,
          y: Math.sin(pt.angle) * r * pt.radiusMul
        }));
        const n = pts.length;
        const startMid = { x: (pts[n-1].x + pts[0].x)/2, y: (pts[n-1].y + pts[0].y)/2 };
        ctx.beginPath();
        ctx.moveTo(startMid.x, startMid.y);
        for(let i=0;i<n;i++){
          const cur = pts[i];
          const next = pts[(i+1)%n];
          const mid = { x: (cur.x+next.x)/2, y: (cur.y+next.y)/2 };
          ctx.quadraticCurveTo(cur.x, cur.y, mid.x, mid.y);
        }
        ctx.closePath();
      }

      // dégradé diagonal clair (haut-gauche) vers foncé (bas-droite)
      const meteorGrad = ctx.createLinearGradient(-r*0.7, -r*0.7, r*0.7, r*0.7);
      meteorGrad.addColorStop(0, '#bfe8f2');
      meteorGrad.addColorStop(0.35, '#6f8fc4');
      meteorGrad.addColorStop(0.7, '#3a3f7a');
      meteorGrad.addColorStop(1, '#20223f');

      ctx.shadowColor = 'rgba(40,50,90,0.5)';
      ctx.shadowBlur = 18;
      tracerContourAsteroide();
      ctx.fillStyle = meteorGrad;
      ctx.fill();
      ctx.shadowBlur = 0;

      // les cratères, découpés pour rester à l'intérieur du rocher
      ctx.save();
      tracerContourAsteroide();
      ctx.clip();
      shape.craters.forEach(c=>{
        const cx = c.x * r, cy = c.y * r;
        const crx = c.rx * r, cry = c.ry * r;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(c.rotation);
        ctx.beginPath();
        ctx.ellipse(0, 0, crx, cry, 0, 0, Math.PI*2);
        ctx.fillStyle = 'rgba(20,24,50,0.55)';
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(-crx*0.15, -cry*0.15, crx*0.9, cry*0.9, 0, Math.PI*0.9, Math.PI*1.6);
        ctx.strokeStyle = 'rgba(200,220,240,0.35)';
        ctx.lineWidth = Math.max(1, r*0.03);
        ctx.stroke();
        ctx.restore();
      });
      ctx.restore();

      // léger liseré lumineux sur tout le contour
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(255,255,255,0.15)';
      tracerContourAsteroide();
      ctx.stroke();

      // text or image (show the word in the displayed language)
      const textToShow = m.word[m.show];
      if(imageMode && m.r !== undefined){
        const key = getImageKey(m.word);
        const cached = imageCache[key];
        if(cached instanceof HTMLImageElement){
          // clip image to the meteor circle
          ctx.save();
          tracerContourAsteroide();
          ctx.clip();
          const d = (r - 4) * 2;
          ctx.drawImage(cached, -(r-4), -(r-4), d, d);
          ctx.restore();
          // Étiquette sous l'image
          ctx.save();

          const labelY = r + 22;
          const labelFont = Math.max(14, Math.floor(r * 0.34));

ctx.font = `600 ${labelFont}px "Space Grotesk", "Bricolage Grotesk", sans-serif`;
ctx.textAlign = 'center';
ctx.textBaseline = 'middle';

const labelText = textToShow;
const textWidth = ctx.measureText(labelText).width;

const paddingX = 10;
const labelW = textWidth + paddingX * 2;
const labelH = labelFont + 8;

const x0 = -labelW / 2;
const y0 = labelY - labelH / 2;
const radius = 7;

// Fond de l'étiquette
ctx.fillStyle = 'rgba(20, 30, 45, 0.88)';

ctx.beginPath();
ctx.moveTo(x0 + radius, y0);
ctx.lineTo(x0 + labelW - radius, y0);
ctx.quadraticCurveTo(
  x0 + labelW, y0,
  x0 + labelW, y0 + radius
);
ctx.lineTo(x0 + labelW, y0 + labelH - radius);
ctx.quadraticCurveTo(
  x0 + labelW, y0 + labelH,
  x0 + labelW - radius, y0 + labelH
);
ctx.lineTo(x0 + radius, y0 + labelH);
ctx.quadraticCurveTo(
  x0, y0 + labelH,
  x0, y0 + labelH - radius
);
ctx.lineTo(x0, y0 + radius);
ctx.quadraticCurveTo(
  x0, y0,
  x0 + radius, y0
);
ctx.closePath();

ctx.fill();

// Texte du mot
ctx.fillStyle = '#ffffff';
ctx.fillText(labelText, 0, labelY);

ctx.restore();
        } else if(cached === 'loading'){
          // still fetching: show dots
          ctx.fillStyle = '#ffffff';
          ctx.font = `bold ${Math.max(12, Math.floor(r*0.45))}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('...', 0, 2);
        } else {
          // failed or unavailable: fall back to the text word
          ctx.fillStyle = '#ffffff';
          ctx.font = `${m.fontSize}px "Space Grotesk", "Bricolage Grotesk", sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.lineWidth = Math.max(1.2, m.fontSize * 0.1);
          ctx.strokeStyle = 'rgba(24,42,61,0.85)';
          ctx.strokeText(textToShow, 0, 2);
          ctx.fillText(textToShow, 0, 2);
        }
      } else {
        ctx.fillStyle = '#ffffff';
        ctx.font = `${m.fontSize}px "Space Grotesk", "Bricolage Grotesk", sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = Math.max(1.2, m.fontSize * 0.1);
        ctx.strokeStyle = 'rgba(24,42,61,0.85)';
        ctx.strokeText(textToShow, 0, 2);
        ctx.fillText(textToShow, 0, 2);
      }
      ctx.restore();

      if(m.y > height - 20){
        loseMeteorAt(i);
        if(!running) return;
      }
    }
    requestAnimationFrame(loop);
  }

  // helper: strip accents/diacritics for tolerant comparison
  function stripAccents(s){
    return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC');
  }

  // accent correction bubble
  const accentBubble = document.getElementById('accent-bubble');
  let bubbleTimeout = null;
  function showAccentBubble(correctWord){
    if(!accentBubble) return;
    accentBubble.textContent = correctWord;
    accentBubble.classList.add('show');
    if(bubbleTimeout) clearTimeout(bubbleTimeout);
    bubbleTimeout = setTimeout(()=>{ accentBubble.classList.remove('show'); }, 3000);
  }

  // input handling
  input.addEventListener('keydown', (e)=>{
    if(e.key === 'Enter'){
      const val = input.value.trim().toLowerCase();
      if(!val) return;
      for(let i=meteors.length-1;i>=0;i--){
        const answer = meteors[i].word[meteors[i].show === langA ? langB : langA];
        const exactMatch = answer.toLowerCase() === val;
        const tolerantMatch = !exactMatch && stripAccents(answer.toLowerCase()) === stripAccents(val);
        if(exactMatch || tolerantMatch){
          meteors.splice(i,1);
          score += 10;
          updateUI();
          input.value = '';
          if(tolerantMatch) showAccentBubble(answer);
          return;
        }
      }
      // wrong guess: do not remove life. Provide visual feedback instead.
      input.classList.add('wrong');
      setTimeout(()=> input.classList.remove('wrong'), 300);
      input.value = '';
    }
  });

  canvas.addEventListener('click', (e)=>{
    if(!running || meteors.length === 0) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    for(let i=meteors.length-1;i>=0;i--){
      const m = meteors[i];
      const r = m.fontSize/2 + 8;
      const dx = x - m.x;
      const dy = y - m.y;
      if(dx*dx + dy*dy <= r*r){
        loseMeteorAt(i);
        return;
      }
    }
  });

  // Start button: hide controls/menu and show game bottom UI then begin
  startBtn.addEventListener('click', ()=>{
    ui.classList.remove('show-controls');
    if(gameBottom) gameBottom.style.display = 'flex';
    startGame();
    input.focus();
  });

  // (top restart removed) - use bottom restart during gameplay to return to settings

  // Restart bottom button (shown during the game): behave like top restart
  restartBottom.addEventListener('click', ()=>{
    running = false;
    document.body.classList.remove('playing');
    ui.classList.add('show-controls');
    if(gameBottom) gameBottom.style.display = 'none';
    const go = document.querySelector('.game-over'); if(go) go.remove();
  });
  window.addEventListener('click', ()=>input.focus());
  input.focus();

  // Show controls at initial load
  document.body.classList.remove('playing');
  ui.classList.add('show-controls');
  if(gameBottom) gameBottom.style.display = 'none';

  // Use an embedded list of words only (no fetch/server)
  // Try fetching words.json first (works when served via http)
  fetch('words.json').then(r=>r.json()).then(data=>{
    if(Array.isArray(data) && data.length>0){
      words = data;
      detectAndPopulateLangs(words);
      console.log('Loaded words.json', words.length, 'words');
    }
  }).catch(err=>{
    console.warn('Could not load words.json, will use embedded list unless user loads one', err);
  }).finally(()=>{
    if(words.length===0){
      words = [
        {fr:'chat', en:'cat'},
        {fr:'chien', en:'dog'},
        {fr:'maison', en:'house'},
        {fr:'soleil', en:'sun'},
        {fr:'lune', en:'moon'},
        {fr:'voiture', en:'car'},
        {fr:'pomme', en:'apple'},
        {fr:'eau', en:'water'},
        {fr:'feu', en:'fire'},
        {fr:'arbre', en:'tree'}
      ];
      detectAndPopulateLangs(words);
      console.log('Using embedded words list', words.length, 'words');
    }
  });

  // load words from file input
  const loadWordsBtn = document.getElementById('loadWordsBtn');
  const loadWordsFile = document.getElementById('loadWordsFile');
  if(loadWordsBtn && loadWordsFile){
    loadWordsBtn.addEventListener('click', ()=> loadWordsFile.click());
    loadWordsFile.addEventListener('change', (e)=>{
      const f = e.target.files && e.target.files[0];
      if(!f) return;
      const reader = new FileReader();
      reader.onload = (ev)=>{
        try{
          const data = JSON.parse(ev.target.result);
          if(Array.isArray(data) && data.length>0){
            words = data;
            detectAndPopulateLangs(words);
            if(imageMode){ for(const w of words) preloadWordImage(w); } // précharge seulement si mode image actif
            // initialize mode pools for the newly loaded words
            if(gameMode === 'random') poolRandom = shuffle(words.slice());
            if(gameMode === 'final-boss') bossQueue = shuffle(words.slice());
            alert('Liste chargée: '+data.length+' mots');
          } else alert('Fichier invalide: format attendu JSON array');
        }catch(err){ alert('Erreur lecture JSON: '+err.message); }
      };
      reader.readAsText(f);
    });
  }

});
