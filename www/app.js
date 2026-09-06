import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';

const IS_NATIVE = Capacitor.isNativePlatform();

const DAYS = ["Lun","Mar","Mer","Jeu","Ven","Sam","Dim"];
const STORE_KEY = "medisuivi-state-v1";
let state = { medications: [], logs: {}, isPremium: false, remindersEnabled: false };
let pendingTimes = [];
let rappelsActifs = []; // timers actifs (mode web uniquement)
const MISSED_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 heures avant de marquer une dose comme manquée

// Convertit un id de medicament + heure en identifiant numerique stable
// (LocalNotifications de Capacitor exige un id de type "number")
function notifId(medId, timeStr){
  const str = `${medId}__${timeStr}`;
  let hash = 0;
  for(let i=0;i<str.length;i++){
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 2147483647;
}

function todayKey(d=new Date()){
  return d.toISOString().slice(0,10);
}
function fmtDateLabel(){
  const d = new Date();
  return "Aujourd'hui — " + d.toLocaleDateString('fr-FR', {weekday:'long', day:'numeric', month:'long'});
}
function toast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'), 2200);
}

async function loadState(){
  try{
    const raw = localStorage.getItem(STORE_KEY);
    if(raw){
      state = JSON.parse(raw);
      state.medications = state.medications || [];
      state.logs = state.logs || {};
      state.remindersEnabled = state.remindersEnabled || false;
    }
  }catch(e){
    console.log("Aucun état sauvegardé, démarrage à zéro.");
  }
  render();
  await updateBellUI();
  if(state.remindersEnabled){
    scheduleReminders();
  }
}
async function saveState(){
  try{
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  }catch(e){
    console.error("Erreur de sauvegarde", e);
  }
}

document.querySelectorAll('.nav-btn').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    document.querySelectorAll('.nav-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
    document.getElementById('screen-'+btn.dataset.screen).classList.add('active');
    if(btn.dataset.screen==='week') renderWeek();
    if(btn.dataset.screen==='premium') renderPremium();
  });
});

/* ---------- RAPPELS / ALARMES ---------- */

async function permissionAccordee(){
  if(IS_NATIVE){
    const res = await LocalNotifications.checkPermissions();
    return res.display === 'granted';
  }
  return ("Notification" in window) && Notification.permission === 'granted';
}

async function updateBellUI(){
  const bell = document.getElementById('bellBtn');
  const banner = document.getElementById('reminderBanner');
  const granted = (await permissionAccordee()) && state.remindersEnabled;
  bell.classList.toggle('on', granted);
  bell.textContent = granted ? '🔔' : '🔕';
  banner.style.display = granted ? 'none' : 'flex';
}

async function activerRappels(){
  if(IS_NATIVE){
    const res = await LocalNotifications.requestPermissions();
    if(res.display !== 'granted'){
      toast("Permission refusée — active-la dans les réglages Android de l'app");
      await updateBellUI();
      return;
    }
    // Sur Android 12+, demande aussi l'autorisation "Alarmes et rappels exacts"
    // (ouvre l'écran de réglages système si elle n'est pas déjà accordée)
    try{
      if(LocalNotifications.checkExactNotificationSetting){
        const exact = await LocalNotifications.checkExactNotificationSetting();
        if(exact.exact_alarm !== 'granted'){
          await LocalNotifications.changeExactNotificationSetting();
        }
      }
    }catch(e){ console.log("Réglage alarme exacte non disponible sur cette version:", e); }

    state.remindersEnabled = true;
    await saveState();
    await updateBellUI();
    await scheduleReminders();
    toast("Rappels activés ✓");
    return;
  }

  // --- Mode web (GitHub Pages) : notifications navigateur classiques ---
  if (!("Notification" in window)) {
    toast("Notifications non supportées sur ce navigateur");
    return;
  }
  if (Notification.permission === 'denied') {
    toast("Notifications bloquées — active-les dans les réglages du navigateur");
    return;
  }
  let permission = Notification.permission;
  if (permission !== 'granted') {
    permission = await Notification.requestPermission();
  }
  if (permission === 'granted') {
    state.remindersEnabled = true;
    await saveState();
    await updateBellUI();
    scheduleReminders();
    toast("Rappels activés ✓");
  } else {
    toast("Permission refusée");
  }
}

document.getElementById('bellBtn').addEventListener('click', async ()=>{
  if(state.remindersEnabled){
    state.remindersEnabled = false;
    await saveState();
    await annulerTousLesRappels();
    await updateBellUI();
    toast("Rappels désactivés");
  } else {
    activerRappels();
  }
});
document.getElementById('enableRemindersBtn').addEventListener('click', activerRappels);

async function annulerTousLesRappels(){
  if(IS_NATIVE){
    const pending = await LocalNotifications.getPending();
    if(pending.notifications.length){
      await LocalNotifications.cancel({ notifications: pending.notifications });
    }
  } else {
    rappelsActifs.forEach(id => clearTimeout(id));
    rappelsActifs = [];
  }
}

async function scheduleReminders(){
  await annulerTousLesRappels();

  const granted = await permissionAccordee();
  if(!state.remindersEnabled || !granted) return;

  if(IS_NATIVE){
    // Alarmes natives : une notification qui se repete tous les jours a l'heure choisie.
    // Geree directement par Android (AlarmManager) -> fonctionne app fermee.
    const notifications = [];
    state.medications.forEach(med=>{
      med.times.forEach(time=>{
        const [h, m] = time.split(":").map(Number);
        notifications.push({
          id: notifId(med.id, time),
          title: `💊 C'est l'heure : ${med.name}`,
          body: `${med.dosage || ''} · prévu à ${time}`,
          schedule: { on: { hour: h, minute: m }, allowWhileIdle: true },
          sound: undefined, // utilise le son de notification par defaut du canal
          channelId: 'medisuivi-rappels',
          extra: { medId: med.id, time }
        });
      });
    });
    if(notifications.length){
      await LocalNotifications.createChannel({
        id: 'medisuivi-rappels',
        name: 'Rappels de médicaments',
        description: 'Alertes pour les prises de médicaments programmées',
        importance: 5, // MAX -> son + affichage prioritaire meme ecran verrouille
        visibility: 1,
        vibration: true
      }).catch(()=>{});
      await LocalNotifications.schedule({ notifications });
    }
    return;
  }

  // --- Mode web : setTimeout (fonctionne seulement app/onglet ouvert) ---
  state.medications.forEach(med=>{
    med.times.forEach(time=>{
      programmerUneAlarmeWeb(med, time);
    });
  });
}

function programmerUneAlarmeWeb(med, timeStr){
  const [h, m] = timeStr.split(":").map(Number);
  const maintenant = new Date();
  let prochaine = new Date();
  prochaine.setHours(h, m, 0, 0);
  if(prochaine <= maintenant){
    prochaine.setDate(prochaine.getDate()+1);
  }
  const delai = prochaine.getTime() - maintenant.getTime();

  const timerId = setTimeout(()=>{
    declencherNotificationWeb(med, timeStr);
    programmerUneAlarmeWeb(med, timeStr);
  }, delai);

  rappelsActifs.push(timerId);
}

function declencherNotificationWeb(med, timeStr){
  const titre = `💊 C'est l'heure : ${med.name}`;
  const options = {
    body: `${med.dosage || ''} · prévu à ${timeStr}`,
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    vibrate: [200,100,200,100,200],
    tag: `${med.id}__${timeStr}`,
    requireInteraction: true,
    data: { medId: med.id, time: timeStr },
    actions: [
      { action: 'pris', title: '✅ Pris' },
      { action: 'reporter', title: '⏰ Reporter 10 min' }
    ]
  };

  if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
    navigator.serviceWorker.ready.then(reg => reg.showNotification(titre, options));
  } else if (Notification.permission === 'granted') {
    new Notification(titre, { body: options.body, icon: options.icon, vibrate: options.vibrate });
  }
}

// Web : actions "Pris" / "Reporter" depuis une notification service worker
if (!IS_NATIVE && 'serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event)=>{
    const { type, medId, time } = event.data || {};
    if(!medId || !time) return;
    const key = todayKey();
    if(type === 'MARQUER_PRIS'){
      setDoseStatus(medId, key, time, 'taken');
      toast("Marqué comme pris ✓");
    } else if(type === 'REPORTER'){
      const med = state.medications.find(m=>m.id===medId);
      if(med){
        const timerId = setTimeout(()=> declencherNotificationWeb(med, time), 10*60*1000);
        rappelsActifs.push(timerId);
        toast("Rappel reporté de 10 min");
      }
    }
  });
}

// Natif : tap sur la notification -> ouvre l'app sur l'ecran du jour (comportement par defaut)
if (IS_NATIVE) {
  LocalNotifications.addListener('localNotificationActionPerformed', (notif) => {
    // Le tap ouvre simplement l'app ; le rafraichissement du jour se fait via render().
    render();
  });
}

/* ---------- ADD MEDICATION MODAL ---------- */
const overlay = document.getElementById('overlay');
document.getElementById('addMedBtn').addEventListener('click', openAddModal);
document.getElementById('cancelBtn').addEventListener('click', closeModal);

function openAddModal(){
  if(!state.isPremium && state.medications.length >= 3){
    toast("Limite gratuite atteinte (3 médicaments)");
    switchTo('premium');
    return;
  }
  pendingTimes = ["08:00"];
  document.getElementById('medName').value = '';
  document.getElementById('medDosage').value = '';
  document.getElementById('medForm').value = '💊';
  renderTimesRow();
  overlay.classList.add('open');
}
function closeModal(){ overlay.classList.remove('open'); }
function switchTo(name){
  document.querySelectorAll('.nav-btn').forEach(b=>b.classList.toggle('active', b.dataset.screen===name));
  document.querySelectorAll('.screen').forEach(s=>s.classList.toggle('active', s.id==='screen-'+name));
  if(name==='week') renderWeek();
  if(name==='premium') renderPremium();
}

function renderTimesRow(){
  const row = document.getElementById('timesRow');
  row.innerHTML = '';
  pendingTimes.sort().forEach((t,i)=>{
    const chip = document.createElement('div');
    chip.className='time-chip';
    chip.innerHTML = `${t} <button data-i="${i}">✕</button>`;
    chip.querySelector('button').addEventListener('click', ()=>{
      pendingTimes.splice(i,1);
      renderTimesRow();
    });
    row.appendChild(chip);
  });
}
document.getElementById('addTimeBtn').addEventListener('click', ()=>{
  const v = document.getElementById('timeInput').value;
  if(v && !pendingTimes.includes(v)){
    pendingTimes.push(v);
    renderTimesRow();
  }
});

document.getElementById('saveBtn').addEventListener('click', async ()=>{
  const name = document.getElementById('medName').value.trim();
  const dosage = document.getElementById('medDosage').value.trim();
  const form = document.getElementById('medForm').value;
  if(!name || pendingTimes.length===0){
    toast("Nom et au moins une heure requis");
    return;
  }
  state.medications.push({
    id: 'm'+Date.now(),
    name, dosage, form,
    times: [...pendingTimes],
    createdAt: todayKey()
  });
  await saveState();
  closeModal();
  render();
  await scheduleReminders();
  toast("Médicament ajouté ✓");
});

/* ---------- DÉTECTION AUTOMATIQUE DES DOSES MANQUÉES ---------- */
async function checkMissedDoses(){
  const key = todayKey();
  const now = new Date();
  let changed = false;

  state.medications.forEach(m=>{
    m.times.forEach(t=>{
      const status = getDoseStatus(m.id, key, t);
      if(status === 'pending'){
        const [h, mi] = t.split(":").map(Number);
        const scheduled = new Date();
        scheduled.setHours(h, mi, 0, 0);
        if(now.getTime() - scheduled.getTime() >= MISSED_THRESHOLD_MS){
          state.logs[key] = state.logs[key] || {};
          state.logs[key][m.id] = state.logs[key][m.id] || {};
          state.logs[key][m.id][t] = 'missed';
          changed = true;
        }
      }
    });
  });

  if(changed) await saveState();
  return changed;
}

function updateMissedBadge(){
  const key = todayKey();
  let missedCount = 0;
  state.medications.forEach(m=>{
    m.times.forEach(t=>{
      if(getDoseStatus(m.id, key, t) === 'missed') missedCount++;
    });
  });
  const badge = document.getElementById('missedBadge');
  if(missedCount > 0){
    badge.style.display = 'flex';
    badge.textContent = missedCount > 9 ? '9+' : missedCount;
  } else {
    badge.style.display = 'none';
  }
}

/* ---------- TODAY ---------- */
function getDoseStatus(medId, dateKey, time){
  return (state.logs[dateKey] && state.logs[dateKey][medId] && state.logs[dateKey][medId][time]) || 'pending';
}
async function setDoseStatus(medId, dateKey, time, status){
  state.logs[dateKey] = state.logs[dateKey] || {};
  state.logs[dateKey][medId] = state.logs[dateKey][medId] || {};
  state.logs[dateKey][medId][time] = status;
  await saveState();
  render();
}

function renderToday(){
  document.getElementById('todayDateLabel').textContent = fmtDateLabel();
  const list = document.getElementById('todayList');
  list.innerHTML = '';
  const key = todayKey();
  let doses = [];
  state.medications.forEach(m=>{
    m.times.forEach(t=>{
      doses.push({med:m, time:t});
    });
  });
  doses.sort((a,b)=> a.time.localeCompare(b.time));

  if(doses.length===0){
    list.innerHTML = `<div class="empty">Aucun médicament pour l'instant.<br>Ajoutez-en un depuis l'onglet Médicaments.</div>`;
  } else {
    doses.forEach(d=>{
      const status = getDoseStatus(d.med.id, key, d.time);
      const item = document.createElement('div');
      item.className = 'dose-item';
      item.innerHTML = `
        <div class="dose-icon">${d.med.form}</div>
        <div class="dose-info">
          <b>${d.med.name}</b>
          <span>${d.med.dosage || ''} · ${d.time}</span>
        </div>
        <button class="check-btn ${status}">${status==='taken'?'✓': status==='missed'?'✕':''}</button>
      `;
      item.querySelector('.check-btn').addEventListener('click', ()=>{
        const next = status==='pending' ? 'taken' : status==='taken' ? 'missed' : 'pending';
        setDoseStatus(d.med.id, key, d.time, next);
      });
      list.appendChild(item);
    });
  }

  const total = doses.length;
  const taken = doses.filter(d=>getDoseStatus(d.med.id, key, d.time)==='taken').length;
  const pct = total ? Math.round((taken/total)*100) : 0;
  const circumference = 201;
  document.getElementById('ringProgress').style.strokeDashoffset = circumference - (circumference*pct/100);
  document.getElementById('ringLabel').textContent = pct + '%';

  document.getElementById('streakBadge').textContent = '🔥 ' + computeStreak() + ' j.';
}

function computeStreak(){
  let streak = 0;
  for(let i=0;i<60;i++){
    const d = new Date();
    d.setDate(d.getDate()-i);
    const key = todayKey(d);
    let doses = [];
    state.medications.forEach(m=> m.times.forEach(t=> doses.push({medId:m.id, time:t})));
    if(doses.length===0) break;
    const allTaken = doses.every(x => getDoseStatus(x.medId, key, x.time)==='taken');
    if(allTaken) streak++; else break;
  }
  return streak;
}

/* ---------- MEDS LIST ---------- */
function renderMeds(){
  const wrap = document.getElementById('medList');
  wrap.innerHTML = '';
  document.getElementById('medCount').textContent = state.isPremium ? '' : `(${state.medications.length}/3)`;
  if(state.medications.length===0){
    wrap.innerHTML = `<div class="empty">Aucun médicament enregistré.</div>`;
  }
  state.medications.forEach(m=>{
    const card = document.createElement('div');
    card.className = 'med-card';
    card.innerHTML = `
      <div class="dose-icon">${m.form}</div>
      <div class="med-meta">
        <b>${m.name}</b>
        <div class="dosage">${m.dosage || 'Dosage non précisé'}</div>
        <div class="chip-row">${m.times.map(t=>`<span class="chip">${t}</span>`).join('')}</div>
      </div>
      <button class="icon-btn" data-id="${m.id}">🗑️</button>
    `;
    card.querySelector('.icon-btn').addEventListener('click', async ()=>{
      state.medications = state.medications.filter(x=>x.id!==m.id);
      await saveState();
      render();
      await scheduleReminders();
      toast("Médicament supprimé");
    });
    wrap.appendChild(card);
  });

  const btn = document.getElementById('addMedBtn');
  if(!state.isPremium && state.medications.length>=3){
    btn.classList.add('locked');
    btn.textContent = '🔒 Limite gratuite atteinte — Passer à Premium';
  } else {
    btn.classList.remove('locked');
    btn.textContent = '➕ Ajouter un médicament';
  }
}

/* ---------- WEEK ---------- */
function renderWeek(){
  const wrap = document.getElementById('weekTableWrap');
  if(state.medications.length===0){
    wrap.innerHTML = `<div class="empty">Ajoutez un médicament pour voir votre pilulier.</div>`;
    return;
  }
  const now = new Date();
  const dow = (now.getDay()+6)%7;
  const monday = new Date(now);
  monday.setDate(now.getDate()-dow);
  const weekDates = [...Array(7)].map((_,i)=>{
    const d = new Date(monday); d.setDate(monday.getDate()+i); return d;
  });

  let html = '<table class="week"><tr><th style="text-align:left;"></th>' +
    DAYS.map(d=>`<th>${d}</th>`).join('') + '</tr>';

  state.medications.forEach(m=>{
    html += `<tr><td class="med-row-label">${m.form} ${m.name}</td>`;
    weekDates.forEach(d=>{
      const key = todayKey(d);
      const isFuture = d.setHours(0,0,0,0) > new Date().setHours(0,0,0,0);
      if(m.times.length===0){ html += `<td><div class="dot na"></div></td>`; return; }
      const isToday = key === todayKey();
      const isPastDay = !isFuture && !isToday;

      if(m.createdAt && key < m.createdAt){
        html += `<td><div class="dot na"></div></td>`;
        return;
      }

      let statuses = m.times.map(t=>getDoseStatus(m.id,key,t));
      if(isPastDay){
        statuses = statuses.map(s => s === 'pending' ? 'missed' : s);
      }
      let cls, sym;
      if(isFuture){ cls='future'; sym=''; }
      else if(statuses.every(s=>s==='taken')){ cls='taken'; sym='✓'; }
      else if(statuses.some(s=>s==='missed')){ cls='missed'; sym='✕'; }
      else { cls='pending'; sym=''; }
      html += `<td><div class="dot ${cls}">${sym}</div></td>`;
    });
    html += '</tr>';
  });
  html += '</table>';
  wrap.innerHTML = html;
}

/* ---------- PREMIUM ---------- */
document.getElementById('upgradeBtn').addEventListener('click', async ()=>{
  state.isPremium = true;
  await saveState();
  render();
  toast("Bienvenue dans Premium ✨");
  switchTo('premium');
});

function renderPremium(){
  const note = document.getElementById('premiumNote');
  const upBtn = document.getElementById('upgradeBtn');
  if(state.isPremium){
    upBtn.textContent = "✓ Abonnement actif";
    upBtn.disabled = true;
    upBtn.style.opacity = 0.7;
    note.textContent = "Vous êtes Premium. Cette bascule est simulée pour la démo — la version publiée utilisera Google Play Billing pour gérer le paiement réel et le renouvellement mensuel.";
  } else {
    upBtn.textContent = "Passer à Premium";
    upBtn.disabled = false;
    upBtn.style.opacity = 1;
    note.textContent = "Démo MVP : le passage à Premium est simulé localement. Pour la publication sur le Play Store, l'abonnement devra passer par Google Play Billing (achat intégré géré par Google).";
  }
}

/* ---------- RENDER ALL ---------- */
async function render(){
  await checkMissedDoses();
  renderToday();
  renderMeds();
  updateMissedBadge();
  if(document.getElementById('screen-week').classList.contains('active')) renderWeek();
  if(document.getElementById('screen-premium').classList.contains('active')) renderPremium();
}

loadState();

setInterval(()=>{ render(); }, 60 * 1000);

// Le service worker (cache hors-ligne) ne sert que pour la version web/GitHub Pages
if (!IS_NATIVE && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js')
      .then((reg) => console.log('Service worker enregistré :', reg.scope))
      .catch((err) => console.error('Échec enregistrement service worker :', err));
  });
}
