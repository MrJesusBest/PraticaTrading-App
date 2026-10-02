const $ = (s, root=document) => root.querySelector(s);
const $$ = (s, root=document) => [...root.querySelectorAll(s)];

const STORAGE_KEY = 'target6_tef_state_v1';
const initialState = () => ({
  version: 2,
  createdAt: new Date().toISOString(),
  listeningAttempts: [],
  speakingAttempts: [],
  vocab: [],
  sessions: 0,
  history: [],
  mockRuns: [],
  plan: null,
  diagnostic: { active:false, listeningDone:false, speakingA:false, speakingB:false, speakingBaseline:false, completed:false, correct:0, total:0 },
  settings: { lang:'pt' }
});

let state = loadState();
let health = null;
let currentListening = null;
let currentSpeaking = null;
let speakingSection = 'A';
let mediaRecorder = null;
let mediaChunks = [];
let recordedAudioDataUrl = '';
let recordStartedAt = 0;
let recordTimerInterval = null;
let browserTranscript = '';
let recognition = null;
let diagnosticRuntime = null;
let fullMockRuntime = null;
let fullMockTimer = null;
let turnRecorder = null;
let turnChunks = [];
let turnStream = null;
let turnStartedAt = 0;
let speakingSectionTimer = null;

function loadState(){
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return parsed && parsed.version ? {...initialState(), ...parsed, diagnostic:{...initialState().diagnostic, ...(parsed.diagnostic||{})}, settings:{...initialState().settings, ...(parsed.settings||{})}} : initialState();
  } catch { return initialState(); }
}
function saveState(){ localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); updateDashboard(); }

function toast(msg, type='ok'){
  const el = $('#toast'); el.textContent = msg; el.className = `toast ${type}`;
  setTimeout(()=> el.className='toast hidden', 4200);
}
function setBusy(el, on, label){
  if (!el) return;
  if (on){
    if(!el.dataset.oldText) el.dataset.oldText = el.textContent;
    el.disabled=true;
    el.classList.add('is-busy');
    el.setAttribute('aria-busy','true');
    el.innerHTML=`<span class="loader"></span>${label||'A processar…'}`;
  } else {
    el.disabled=false;
    el.classList.remove('is-busy');
    el.removeAttribute('aria-busy');
    el.textContent=el.dataset.oldText||el.textContent;
    delete el.dataset.oldText;
  }
}
async function api(path, body={}){
  const r = await fetch(path, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
  const data = await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(data.error || `Erro ${r.status}`);
  return data;
}

const pageTitles = {dashboard:'Dashboard',diagnostic:'Diagnóstico',listening:'Listening',speaking:'Speaking',plan:'Plano AI',progress:'Progresso',mock:'Full Mock',settings:'Definições'};
function navigate(page){
  $$('.page').forEach(p=>p.classList.remove('active'));
  $$('.nav-item').forEach(b=>b.classList.toggle('active', b.dataset.page===page));
  $(`#page-${page}`)?.classList.add('active');
  $('#pageTitle').textContent = pageTitles[page] || page;
  if(page==='progress'){ renderHistory(); renderVocabReview(); }
  if(page==='mock') renderMockStatus();
  if(page==='plan') renderPlan();
  if(page==='settings') renderSettings();
  window.scrollTo({top:0,behavior:'smooth'});
}

$$('.nav-item').forEach(b=>b.addEventListener('click',()=>navigate(b.dataset.page)));
$$('[data-jump]').forEach(b=>b.addEventListener('click',()=>navigate(b.dataset.jump)));

function unassistedListeningAttempts(){
  return state.listeningAttempts.filter(x=>!x.assisted);
}
function listeningAccuracy(){
  const a = unassistedListeningAttempts().slice(-20);
  return a.length ? Math.round(a.filter(x=>x.correct).length/a.length*100) : null;
}
function speakingAverage(){
  const a = state.speakingAttempts.filter(x=>!x.assisted).slice(-10).map(x=>Number(x.overall)).filter(Number.isFinite);
  return a.length ? Math.round(a.reduce((x,y)=>x+y,0)/a.length) : null;
}
function readiness(){
  const l=listeningAccuracy(), s=speakingAverage();
  if(l==null && s==null) return 0;
  if(l==null) return Math.round(s*.55);
  if(s==null) return Math.round(l*.45);
  let score = Math.round(l*.48+s*.52);
  if(unassistedListeningAttempts().length<8) score=Math.min(score,58);
  if(state.speakingAttempts.filter(x=>!x.assisted).length<2) score=Math.min(score,58);
  return Math.max(0,Math.min(100,score));
}
function nextActionInfo(){
  if(!state.diagnostic.completed) return {page:'diagnostic',text:'Faz o diagnóstico inicial para o sistema descobrir onde deves concentrar o estudo.'};
  const l=listeningAccuracy() ?? 0, s=speakingAverage() ?? 0;
  if(state.speakingAttempts.filter(x=>!x.assisted).length<4 || s < l-6) return {page:'speaking',text:'Prioridade: Speaking. Faz uma tarefa da secção com menor desempenho e aplica a correção imediatamente.'};
  if(unassistedListeningAttempts().length<20 || l<75) return {page:'listening',text:'Prioridade: Listening. Trabalha detalhe, intenção e inferência antes do próximo mock.'};
  return {page:'plan',text:'Tens base suficiente para uma semana equilibrada. Recalcula o plano adaptativo e mantém consistência.'};
}
function updateDashboard(){
  const l=listeningAccuracy(), s=speakingAverage(), r=readiness();
  $('#metricListening').textContent=l==null?'—':`${l}%`;
  $('#metricSpeaking').textContent=s==null?'—':`${s}/100`;
  $('#metricSessions').textContent=state.sessions||0;
  $('#metricVocab').textContent=state.vocab.length;
  $('#readinessScore').textContent=r;
  $('.target-ring').style.background=`conic-gradient(var(--accent) ${r*3.6}deg,#263a34 0deg)`;
  $('#progressListening').textContent=l==null?'—':`${l}%`;
  $('#progressSpeaking').textContent=s==null?'—':`${s}/100`;
  $('#progressReadiness').textContent=`${r}/100`;
  const na=nextActionInfo(); $('#nextAction').textContent=na.text; $('#nextActionBtn').onclick=()=>navigate(na.page);
}

async function checkHealth(){
  try{
    const r=await fetch('/api/health'); health=await r.json();
    const chip=$('#aiStatus');
    if(health.aiConfigured){ chip.textContent='AI ligado'; chip.className='status-chip ok'; }
    else { chip.textContent='AI sem chave'; chip.className='status-chip warn'; }
    renderSettings();
  }catch{ $('#aiStatus').textContent='Servidor offline'; }
}

function addVocab(items=[]){
  for(const v of items){
    if(!v?.fr) continue;
    if(!state.vocab.some(x=>x.fr.toLowerCase()===v.fr.toLowerCase())) state.vocab.push({...v,addedAt:new Date().toISOString(),level:0,intervalDays:0,nextReviewAt:new Date().toISOString(),reviews:0});
  }
}
function logHistory(kind, title, result){
  state.history.unshift({kind,title,result,at:new Date().toISOString()});
  state.history=state.history.slice(0,80);
}

function ensureListeningV3Styles(){
  if(document.getElementById('listeningV3Styles'))return;
  const st=document.createElement('style');
  st.id='listeningV3Styles';
  st.textContent=
    '#listeningCoachPanel{border:0!important;background:linear-gradient(145deg,rgba(16,20,29,.98),rgba(21,27,38,.98))!important;box-shadow:0 18px 55px rgba(0,0,0,.22)}'+
    '#listeningCoachPanel .exam-cycle-steps{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}'+
    '#listeningCoachPanel .exam-cycle-steps>div{border:0!important;border-radius:14px!important;padding:14px!important;background:rgba(255,255,255,.045)!important}'+
    '#listeningCoachPanel .exam-cycle-steps>div:nth-child(1){box-shadow:inset 0 3px 0 #19b97d}'+
    '#listeningCoachPanel .exam-cycle-steps>div:nth-child(2){box-shadow:inset 0 3px 0 #dda62a}'+
    '#listeningCoachPanel .exam-cycle-steps>div:nth-child(3){box-shadow:inset 0 3px 0 #df6266}'+
    '.listening-shell-v3{--listen-accent:#19b97d;--listen-soft:rgba(25,185,125,.10);--listen-line:rgba(25,185,125,.32)}'+
    '.listening-shell-v3.mode-consolidate{--listen-accent:#dda62a;--listen-soft:rgba(221,166,42,.10);--listen-line:rgba(221,166,42,.34)}'+
    '.listening-shell-v3.mode-exam{--listen-accent:#df6266;--listen-soft:rgba(223,98,102,.09);--listen-line:rgba(223,98,102,.34)}'+
    '.listen-mission{padding:18px;border-radius:18px;background:linear-gradient(135deg,var(--listen-soft),rgba(255,255,255,.025));border:1px solid var(--listen-line);margin-bottom:14px}'+
    '.listen-mission-top{display:flex;justify-content:space-between;gap:14px;align-items:flex-start}.listen-kicker{font-size:.68rem;font-weight:900;letter-spacing:.12em;opacity:.62;margin-bottom:4px}'+
    '.listen-mission h2{font-size:1.3rem;margin:0}.listen-mode-pill{padding:8px 11px;border-radius:999px;background:var(--listen-accent);color:#06110d;font-weight:900;font-size:.73rem;white-space:nowrap}.mode-exam .listen-mode-pill{color:white}'+
    '.listen-stage-progress{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin-top:12px}.listen-stage-progress>div{height:7px;border-radius:999px;background:rgba(255,255,255,.075)}.listen-stage-progress>div.active,.listen-stage-progress>div.done{background:var(--listen-accent)}'+
    '.listen-focus-card{padding:20px;border-radius:20px;background:rgba(255,255,255,.05);border:1px solid var(--listen-line);box-shadow:0 14px 36px rgba(0,0,0,.13)}'+
    '.listen-audio-main{display:flex;justify-content:space-between;gap:14px;align-items:center;padding:15px;border-radius:15px;background:var(--listen-soft);border:1px solid var(--listen-line);margin-bottom:14px}.listen-audio-main button{width:64px;height:64px;border-radius:50%;font-size:1.15rem}'+
    '.listen-question-label{font-size:.68rem;font-weight:900;letter-spacing:.1em;color:var(--listen-accent);margin-bottom:5px}.listen-question-main{font-size:1.13rem;line-height:1.5;font-weight:800}.listen-question-pt{font-size:.86rem;opacity:.78;margin-top:7px}'+
    '.listen-choices-v3{display:grid;gap:9px;margin-top:16px}.listen-choice-v3{width:100%;display:flex;align-items:flex-start;gap:11px;text-align:left;padding:13px 14px;border-radius:13px;border:1px solid rgba(255,255,255,.09);background:rgba(255,255,255,.035)}'+
    '.listen-choice-v3:hover{border-color:var(--listen-line);background:var(--listen-soft)}.listen-choice-v3 strong{min-width:22px}.listen-choice-v3.correct{border-color:#19b97d;background:rgba(25,185,125,.12)}.listen-choice-v3.wrong{border-color:#df6266;background:rgba(223,98,102,.11)}'+
    '.listen-help-box{margin-top:12px;padding:12px;border-radius:12px;background:var(--listen-soft);border:1px solid var(--listen-line)}.listen-action-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.listen-action-row button{min-height:44px}'+
    '.listen-correction{margin-top:15px;padding:18px;border-radius:18px;background:rgba(221,166,42,.09);border:1px solid rgba(221,166,42,.34)}.listen-correction.correct{background:rgba(25,185,125,.09);border-color:rgba(25,185,125,.34)}'+
    '.listen-critical{padding:13px;border-radius:13px;background:rgba(255,255,255,.045);margin:10px 0}.listen-critical span{display:block;font-size:.68rem;font-weight:900;letter-spacing:.09em;opacity:.62;margin-bottom:5px}'+
    '.listen-keywords{display:flex;flex-wrap:wrap;gap:7px;margin:10px 0}.listen-keywords span{padding:7px 9px;border-radius:999px;background:rgba(255,255,255,.055);font-size:.82rem}.listen-review-details{margin-top:10px}.listen-review-details summary{cursor:pointer;font-weight:800}.listen-next-btn{width:100%;margin-top:13px;min-height:48px}'+
    '@media(max-width:760px){#listeningCoachPanel .exam-cycle-steps{grid-template-columns:1fr}.listen-mission-top{flex-direction:column}.listen-mode-pill{align-self:flex-start}.listen-audio-main{align-items:flex-start}}';
  document.head.appendChild(st);
}
function listeningModeMeta(mode){
  if(mode==='exam')return {title:'SEM AJUDA',cls:'mode-exam',group:2,subtitle:'Uma reprodução. Sem português, pistas ou ajuda antes de responder.'};
  if(mode==='consolidate')return {title:'AJUDA MÍNIMA',cls:'mode-consolidate',group:1,subtitle:'Tenta sozinho. Se bloqueares, podes abrir uma pista.'};
  return {title:'COM AJUDA',cls:'mode-learn',group:0,subtitle:'Aprende o que procurar no áudio e usa português quando precisares.'};
}
function listeningSkillLabel(skill){
  return ({detail:'detalhe',purpose:'intenção',inference:'inferência',number_time:'números / horas',attitude:'atitude'})[skill]||String(skill||'compreensão');
}
function listeningStageProgress(mode){
  const g=mode==='exam'?2:mode==='consolidate'?1:0;
  return '<div class="listen-stage-progress">'+[0,1,2].map(i=>'<div class="'+(i<g?'done':i===g?'active':'')+'"></div>').join('')+'</div>';
}

async function generateListening(opts={}){
  ensureListeningV3Styles();
  const button=opts.button || $('#generateListening');
  const difficulty=opts.difficulty || $('#listeningDifficulty')?.value || 'B1';
  const supportMode=opts.supportMode || $('#listeningSupportMode')?.value || 'learn';
  setBusy(button,true,'A criar exercício…');
  try{
    const {item}=await api('/api/generate-listening',{difficulty,focus:opts.focus||'general'});
    currentListening={...item,answered:false,plays:0,assisted:supportMode!=='exam',supportMode,examMode:Boolean(opts.examMode||supportMode==='exam'),diagnostic:Boolean(opts.diagnostic),coachReview:null,chosenIndex:null,hintLevel:0};
    renderListening(currentListening,opts.workspace||$('#listeningWorkspace'),opts.onAnswered);
    if($('#listeningDifficultyBadge'))$('#listeningDifficultyBadge').textContent=difficulty;
  }catch(e){toast(friendlyError(e),'error')}
  finally{setBusy(button,false)}
}

function browserSpeak(text, onEnd, preferredRole='neutral'){
  if(!('speechSynthesis' in window)){toast('Este browser não suporta áudio TTS local. Usa OpenAI Natural.','error');return;}
  const u=new SpeechSynthesisUtterance(text); u.lang='fr-FR'; u.rate=.96; u.pitch=preferredRole==='woman'?1.05:(preferredRole==='man'?0.92:1);
  const voices=speechSynthesis.getVoices().filter(v=>/^fr[-_]/i.test(v.lang) || /French/i.test(v.name));
  const roleVoice=preferredRole==='woman'
    ? voices.find(v=>/female|amelie|audrey|aurelie/i.test(v.name))
    : preferredRole==='man'
      ? voices.find(v=>/male|thomas|daniel/i.test(v.name))
      : null;
  if(roleVoice || voices[0]) u.voice=roleVoice||voices[0];
  if(onEnd)u.onend=onEnd; speechSynthesis.speak(u);
}

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function playAudioUrl(url){
  return new Promise((resolve,reject)=>{
    const a=new Audio(url); a.onended=resolve; a.onerror=()=>reject(new Error('Falha ao reproduzir áudio')); a.play().catch(reject);
  });
}
async function playHQClips(clips=[]){
  for(const clip of clips){ await playAudioUrl(clip.audioDataUrl); if(clip.pauseAfterMs)await sleep(clip.pauseAfterMs); }
}
async function playBrowserTurns(item){
  const turns=Array.isArray(item.turns)&&item.turns.length?item.turns:[{speaker:'neutral',text:item.script||''}];
  speechSynthesis.cancel();
  for(let i=0;i<turns.length;i++){ await new Promise(resolve=>browserSpeak(turns[i].text,resolve,turns[i].speaker)); if(i<turns.length-1)await sleep(650); }
}

async function playListening(item, playBtn){
  if(item.examMode && item.plays>=1){toast('No modo diagnóstico/exame, o áudio toca apenas uma vez.','error');return;}
  item.plays++;
  const mode=(item.diagnostic||item.examMode)?'hq':($('#audioMode')?.value||'hq');
  playBtn.disabled=true; playBtn.textContent='…';
  try{
    if(mode==='hq'){
      if(!item.audioClips){ const d=await api('/api/tts-listening',{audioType:item.audioType,turns:item.turns,script:item.script}); item.audioClips=d.clips; }
      await playHQClips(item.audioClips);
    }else{ await playBrowserTurns(item); }
  }catch(e){ if(item.examMode)item.plays=Math.max(0,item.plays-1); toast(friendlyError(e),'error'); }
  finally{ playBtn.disabled=false;playBtn.textContent='▶'; }
}

const studyAudioCache=new Map();

async function playStudyPhrase(text, role='neutral', btn=null){
  const clean=String(text||'').trim(); if(!clean)return;
  const key=`${role}|${clean}`; const old=btn?.textContent;
  if(btn){btn.disabled=true;btn.textContent='…';}
  try{
    let url=studyAudioCache.get(key);
    if(!url){ const voice=role==='man'?'cedar':'marin'; const d=await api('/api/tts',{text:clean,voice,role}); url=d.audioDataUrl; studyAudioCache.set(key,url); }
    await playAudioUrl(url);
  }catch(e){toast(friendlyError(e),'error')}
  finally{if(btn){btn.disabled=false;btn.textContent=old||'🔊';}}
}

async function replayStudyAudio(item,btn){
  const old=btn?.textContent;if(btn){btn.disabled=true;btn.textContent='A reproduzir…';}
  try{ if(!item.audioClips){ const d=await api('/api/tts-listening',{audioType:item.audioType,turns:item.turns,script:item.script}); item.audioClips=d.clips; } await playHQClips(item.audioClips); }
  catch(e){toast(friendlyError(e),'error')}
  finally{if(btn){btn.disabled=false;btn.textContent=old||'▶ Ouvir novamente';}}
}

function renderListeningReview(item,workspace,correct){
  const feedback=$('#listenFeedback',workspace);if(!feedback)return;
  const turns=Array.isArray(item.turns)&&item.turns.length?item.turns:[{speaker:'neutral',text:item.script||'',pt:item.scriptPt||''}];
  const review=item.coachReview||{};
  const idx=Math.max(0,Math.min(turns.length-1,Number(review.criticalTurnIndex)||0));
  const critical=turns[idx]||turns[0]||{};
  const keywords=Array.isArray(review.keywords)&&review.keywords.length?review.keywords:(item.vocab||[]).slice(0,3);
  feedback.innerHTML='<div class="listen-correction '+(correct?'correct':'')+'">'+
    '<div class="listen-kicker">'+(correct?'CERTO':'CORREÇÃO RÁPIDA')+'</div>'+
    '<h3>'+(correct?'Boa. Identificaste a informação certa.':'Vamos atacar exatamente o que te fez falhar.')+'</h3>'+
    (!correct?'<div class="listen-critical"><span>O QUE TINHAS DE OUVIR</span><strong>'+escapeHtml(review.focusPt||item.explanationPt||'Identificar a informação que distingue a resposta correta.')+'</strong></div>':'')+
    (!correct&&critical?.text?'<div class="listen-critical"><span>TRECHO DECISIVO</span><strong lang="fr">'+escapeHtml(critical.text)+'</strong>'+(critical.pt?'<small>'+escapeHtml(critical.pt)+'</small>':'')+'<div class="listen-action-row"><button id="listenCriticalReplay" class="secondary-btn compact">▶ OUVIR SÓ ESTE TRECHO</button></div></div>':'')+
    (!correct&&keywords.length?'<div class="listen-keywords">'+keywords.map(v=>'<span><b>'+escapeHtml(v.fr||'')+'</b> · '+escapeHtml(v.pt||'')+'</span>').join('')+'</div>':'')+
    '<p><strong>'+(!correct?'Porque falhou:':'Explicação:')+'</strong> '+escapeHtml(review.whyPt||item.explanationPt||'')+'</p>'+
    (!correct&&review.listenAgainPt?'<p><strong>Na repetição:</strong> '+escapeHtml(review.listenAgainPt)+'</p>':'')+
    '<details class="listen-review-details"><summary>Ver transcrição, tradução e respostas</summary><div>'+
      '<div class="turn-review">'+turns.map((t,i)=>'<div class="turn-review-row"><button class="mini-audio review-turn-audio" data-i="'+i+'">🔊</button><div><strong>'+(t.speaker==='woman'?'Mulher':t.speaker==='man'?'Homem':'Voz')+':</strong> <span lang="fr">'+escapeHtml(t.text||'')+'</span>'+(t.pt?'<small>'+escapeHtml(t.pt)+'</small>':'')+'</div></div>').join('')+'</div>'+
      '<div class="answer-study-list">'+item.choices.map((c,i)=>'<div class="answer-study '+(i===item.answerIndex?'answer-correct':'')+'"><strong>'+String.fromCharCode(65+i)+'.</strong> <span lang="fr">'+escapeHtml(c)+'</span><small>'+escapeHtml((item.choicesPt||[])[i]||'')+'</small></div>').join('')+'</div>'+
    '</div></details>'+
    ((!item.diagnostic&&!item.mock)?'<button id="listenNextSimilar" class="primary-btn listen-next-btn">'+(correct?'PRÓXIMA PERGUNTA':'NOVA PERGUNTA PARECIDA')+'</button>':'')+
  '</div>';
  if($('#listenCriticalReplay',feedback))$('#listenCriticalReplay',feedback).onclick=()=>playStudyPhrase(critical.text,critical.speaker||'neutral',$('#listenCriticalReplay',feedback));
  $$('.review-turn-audio',feedback).forEach(b=>{const t=turns[Number(b.dataset.i)];b.onclick=()=>playStudyPhrase(t.text,t.speaker,b)});
  if($('#listenNextSimilar',feedback))$('#listenNextSimilar',feedback).onclick=e=>generateListening({button:e.currentTarget,difficulty:item.difficulty||$('#listeningDifficulty')?.value||'B1',supportMode:item.supportMode||'learn',examMode:item.supportMode==='exam',focus:item.skillTag||review.transferFocus||'general'});
}

function renderListening(item,workspace=$('#listeningWorkspace'),onAnswered){
  ensureListeningV3Styles();
  workspace.classList.remove('empty-state');
  const effectiveMode=item.examMode?'exam':(item.supportMode||'learn');
  const mode=listeningModeMeta(effectiveMode);
  const allowHelp=!item.diagnostic&&!item.mock&&!item.examMode;
  const showPt=item.supportMode==='learn';
  workspace.className='panel exercise-panel listening-shell-v3 '+mode.cls;
  workspace.innerHTML='<div class="listen-mission"><div class="listen-mission-top"><div><div class="listen-kicker">TEF AI COACH · LISTENING</div><h2>'+escapeHtml(item.title||'Compréhension orale')+'</h2><small>'+escapeHtml(item.difficulty)+' · '+escapeHtml(listeningSkillLabel(item.skillTag))+'</small></div><div class="listen-mode-pill">'+mode.title+'</div></div><p>'+escapeHtml(mode.subtitle)+'</p>'+listeningStageProgress(effectiveMode)+'</div>'+
    '<div class="listen-focus-card">'+
      '<div class="listen-audio-main"><div><div class="listen-kicker">1 · OUVE</div><strong>'+(item.audioType==='dialogue'?'Diálogo':'Áudio')+'</strong><br><small>'+(item.examMode?'Toca uma vez.':'Podes repetir durante o treino.')+'</small></div><button class="audio-btn" id="listenPlay">▶</button></div>'+
      '<div class="listen-question-label">2 · O QUE TENS DE DESCOBRIR</div><div class="listen-question-main" lang="fr">'+escapeHtml(item.question)+'</div>'+
      (showPt?'<div class="listen-question-pt">'+escapeHtml(item.questionPt||'')+'</div>':'')+
      '<div class="listen-choices-v3">'+item.choices.map((c,i)=>'<button class="listen-choice-v3 choice" data-i="'+i+'"><strong>'+String.fromCharCode(65+i)+'.</strong><span lang="fr">'+escapeHtml(c)+'</span></button>').join('')+'</div>'+
      (allowHelp?'<div class="listen-action-row"><button id="listenHintBtn" class="secondary-btn">'+(item.supportMode==='learn'?'AJUDA PT':'PISTA')+'</button></div><div id="listenHintBox"></div>':'')+
      '<div id="listenFeedback"></div></div>';
  $('#listenPlay',workspace).onclick=()=>playListening(item,$('#listenPlay',workspace));
  $$('.choice',workspace).forEach(btn=>btn.onclick=()=>answerListening(item,Number(btn.dataset.i),workspace,onAnswered));
  if($('#listenHintBtn',workspace))$('#listenHintBtn',workspace).onclick=()=>{
    item.assisted=true;item.hintLevel=(item.hintLevel||0)+1;
    const box=$('#listenHintBox',workspace);
    if(item.supportMode==='learn'){
      box.innerHTML='<div class="listen-help-box"><strong>Ajuda em português</strong><p>'+escapeHtml(item.questionPt||'')+'</p><div class="listen-keywords">'+(item.vocab||[]).slice(0,3).map(v=>'<span><b>'+escapeHtml(v.fr||'')+'</b> · '+escapeHtml(v.pt||'')+'</span>').join('')+'</div></div>';
      $('#listenHintBtn',workspace).disabled=true;$('#listenHintBtn',workspace).textContent='AJUDA ATIVA';
    }else{
      const vocab=(item.vocab||[])[0];
      box.innerHTML='<div class="listen-help-box"><strong>Pista '+Math.min(item.hintLevel,2)+'/2</strong><p>'+(item.hintLevel===1?'Procura no áudio a informação necessária para: '+escapeHtml(item.questionPt||item.question):vocab?'<b>'+escapeHtml(vocab.fr)+'</b> significa '+escapeHtml(vocab.pt):'Volta a ouvir e elimina as opções que contradizem diretamente o áudio.')+'</p></div>';
      if(item.hintLevel>=2)$('#listenHintBtn',workspace).disabled=true;
    }
  };
}

async function answerListening(item,chosen,workspace,onAnswered){
  if(item.answered)return;
  item.answered=true;item.chosenIndex=chosen;
  const correct=chosen===item.answerIndex;
  $$('.choice',workspace).forEach((b,i)=>{b.disabled=true;if(i===item.answerIndex)b.classList.add('correct');else if(i===chosen)b.classList.add('wrong')});
  const attempt={correct,assisted:Boolean(item.assisted),difficulty:item.difficulty,skillTag:item.skillTag,at:new Date().toISOString(),diagnostic:item.diagnostic};
  state.listeningAttempts.push(attempt);addVocab(item.vocab||[]);logHistory('Listening',item.difficulty+' · '+item.skillTag,(correct?'Correto':'Errado')+(item.assisted?' · assistido':''));
  if(!correct&&!item.suppressFeedback){
    const feedback=$('#listenFeedback',workspace);
    if(feedback)feedback.innerHTML='<div class="listen-correction"><span class="loader"></span><strong> A AI está a identificar exatamente o trecho que te enganou…</strong></div>';
    try{
      const coachItem={
        turns:item.turns,script:item.script,scriptPt:item.scriptPt,
        question:item.question,questionPt:item.questionPt,
        choices:item.choices,choicesPt:item.choicesPt,
        answerIndex:item.answerIndex,skillTag:item.skillTag,
        explanationPt:item.explanationPt,vocab:item.vocab
      };
      const out=await api('/api/listening-coach-review',{item:coachItem,chosenIndex:chosen});
      item.coachReview=out.review||null;
      if(item.coachReview?.keywords?.length)addVocab(item.coachReview.keywords.map(v=>({...v,source:'listening-ai-coach'})));
    }catch{}
  }
  if(!item.suppressFeedback)renderListeningReview(item,workspace,correct);
  saveState();
  if(onAnswered)onAnswered(correct,item,workspace);
}

$('#generateListening').addEventListener('click',()=>{ const supportMode=$('#listeningSupportMode')?.value || 'learn'; generateListening({supportMode,examMode:supportMode==='exam'}); });

$$('#speakingSectionSelector .seg').forEach(btn=>btn.onclick=()=>{
  speakingSection=btn.dataset.section; $$('#speakingSectionSelector .seg').forEach(b=>b.classList.toggle('active',b===btn));
});
$('#generateSpeaking').addEventListener('click',()=>generateSpeakingTask());

async function generateSpeakingTask(opts={}){
  const button=opts.button || $('#generateSpeaking'); const section=opts.section||speakingSection; const difficulty=opts.difficulty||$('#speakingDifficulty').value;
  setBusy(button,true,'A criar tarefa…');
  try{
    const {task}=await api('/api/generate-speaking',{section,difficulty});
    currentSpeaking={...task,diagnostic:Boolean(opts.diagnostic)}; recordedAudioDataUrl=''; browserTranscript='';
    renderSpeaking(currentSpeaking, opts.workspace || $('#speakingWorkspace'));
  }catch(e){toast(friendlyError(e),'error')}
  finally{setBusy(button,false)}
}

function renderSpeaking(task, workspace=$('#speakingWorkspace')){
  workspace.classList.remove('empty-state');
  const seconds=task.section==='A'?300:600;
  const noHelp=Boolean(task.noHelp);
  const sectionHelp=task.section==='A'?'<strong>Section A:</strong> faz perguntas para obter informações e mantém a conversa.':'<strong>Section B:</strong> argumenta, dá razões e tenta convencer.';
  const guidance=noHelp
    ? '<div class="exam-no-help-banner"><strong>SIMULAÇÃO FINAL · SEM AJUDA</strong><span>Sem tradução, sugestões ou frases-modelo. Responde apenas à consigne em francês.</span></div>'
    : `<div class="inline-help"><span class="help-title">O QUE TENS DE FAZER</span>${sectionHelp}<br><strong>Depois:</strong> Gravar → Parar → Transcrever → Avaliar com AI.</div>`;
  const ptTip=(!noHelp && task.prepTipPt)?`<p><small><strong>Dica em português:</strong> ${escapeHtml(task.prepTipPt)}</small></p>`:'';
  workspace.innerHTML=`
    <div class="panel-head"><div><div class="small-label">${task.cycleLabel?escapeHtml(task.cycleLabel):'EXPRESSION ORALE'}</div><h3>Section ${escapeHtml(task.section)} · ${escapeHtml(task.title)}</h3></div><span class="badge">${task.section==='A'?'5 min':'10 min'}</span></div>
    ${guidance}
    <div class="task-card"><h4>Consigne <small>· instrução da tarefa</small></h4><div class="task-prompt">${escapeHtml(task.promptFr)}</div>${ptTip}</div>
    <div class="recording-controls"><button id="recordStart" class="record-btn">● Gravar</button><button id="recordStop" class="stop-btn" disabled>■ Parar</button><span id="recordTimer" class="timer">${formatTime(seconds)}</span></div>
    <audio id="recordPreview" controls class="hidden"></audio>
    <label class="small-label">TRANSCRIÇÃO</label>
    <textarea id="speakingTranscript" class="transcript-box" placeholder="A transcrição aparecerá aqui. Também podes corrigir pequenos erros de transcrição antes de avaliar."></textarea>
    <div class="recording-controls"><button id="transcribeBtn" class="secondary-btn" disabled>Transcrever áudio</button><button id="evaluateSpeaking" class="primary-btn">Avaliar com AI</button></div>
    <div id="speakingFeedback"></div>`;
  $('#recordStart',workspace).onclick=()=>startRecording(task,workspace);
  $('#recordStop',workspace).onclick=()=>stopRecording(workspace);
  $('#transcribeBtn',workspace).onclick=()=>transcribeRecording(workspace);
  $('#evaluateSpeaking',workspace).onclick=()=>evaluateSpeaking(task,workspace);
}

async function startRecording(task,workspace){
  if(!navigator.mediaDevices?.getUserMedia){toast('Microfone não disponível neste browser.','error');return;}
  try{
    const stream=await navigator.mediaDevices.getUserMedia({audio:true});
    const mime=MediaRecorder.isTypeSupported('audio/webm;codecs=opus')?'audio/webm;codecs=opus':'audio/webm';
    mediaRecorder=new MediaRecorder(stream,{mimeType:mime}); mediaChunks=[]; recordedAudioDataUrl=''; recordStartedAt=Date.now();
    mediaRecorder.ondataavailable=e=>{if(e.data.size)mediaChunks.push(e.data)};
    mediaRecorder.onstop=()=>{
      const blob=new Blob(mediaChunks,{type:mediaRecorder.mimeType});
      const reader=new FileReader(); reader.onload=()=>{recordedAudioDataUrl=reader.result; const preview=$('#recordPreview',workspace); preview.src=recordedAudioDataUrl;preview.classList.remove('hidden');$('#transcribeBtn',workspace).disabled=false;}; reader.readAsDataURL(blob);
      stream.getTracks().forEach(t=>t.stop());
    };
    mediaRecorder.start(500); startBrowserRecognition(workspace);
    $('#recordStart',workspace).disabled=true;$('#recordStart',workspace).classList.add('live');$('#recordStart',workspace).textContent='● A gravar';$('#recordStop',workspace).disabled=false;
    const maxSec=task.section==='A'?300:600; startTimer(workspace,maxSec);
  }catch(e){toast(`Não consegui abrir o microfone: ${e.message}`,'error')}
}
function stopRecording(workspace){
  if(mediaRecorder?.state==='recording')mediaRecorder.stop();
  if(recognition){try{recognition.stop()}catch{}}
  clearInterval(recordTimerInterval);
  $('#recordStart',workspace).disabled=false;$('#recordStart',workspace).classList.remove('live');$('#recordStart',workspace).textContent='● Gravar';$('#recordStop',workspace).disabled=true;
  if(browserTranscript.trim())$('#speakingTranscript',workspace).value=browserTranscript.trim();
}
function startTimer(workspace,maxSec){
  clearInterval(recordTimerInterval); let left=maxSec; $('#recordTimer',workspace).textContent=formatTime(left);
  recordTimerInterval=setInterval(()=>{left--;$('#recordTimer',workspace).textContent=formatTime(Math.max(0,left));if(left<=0){clearInterval(recordTimerInterval);stopRecording(workspace)}},1000);
}
function startBrowserRecognition(workspace){
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition; browserTranscript=''; if(!SR)return;
  recognition=new SR(); recognition.lang='fr-FR';recognition.continuous=true;recognition.interimResults=true;
  recognition.onresult=e=>{let final='', interim='';for(let i=e.resultIndex;i<e.results.length;i++){const t=e.results[i][0].transcript;if(e.results[i].isFinal)final+=t+' ';else interim+=t}browserTranscript+=final;$('#speakingTranscript',workspace).value=(browserTranscript+interim).trim()};
  recognition.onerror=()=>{}; try{recognition.start()}catch{}
}
async function transcribeRecording(workspace){
  if(!recordedAudioDataUrl){toast('Grava primeiro uma resposta.','error');return;}
  const btn=$('#transcribeBtn',workspace);setBusy(btn,true,'A transcrever…');
  try{const {transcript}=await api('/api/transcribe',{audioDataUrl:recordedAudioDataUrl});$('#speakingTranscript',workspace).value=transcript;toast('Transcrição concluída.');}
  catch(e){toast(friendlyError(e),'error')}
  finally{setBusy(btn,false)}
}
async function evaluateSpeaking(task,workspace){
  const transcript=$('#speakingTranscript',workspace).value.trim();if(!transcript){toast('Preciso de uma transcrição antes de avaliar.','error');return;}
  const btn=$('#evaluateSpeaking',workspace);setBusy(btn,true,'A avaliar…');
  const durationSeconds=recordStartedAt?Math.max(1,Math.round((Date.now()-recordStartedAt)/1000)):0;
  try{
    const {evaluation}=await api('/api/evaluate-speaking',{section:task.section,task,transcript,durationSeconds});
    renderSpeakingEvaluation(evaluation,workspace);
    state.speakingAttempts.push({section:task.section,overall:evaluation.overall,readinessBand:evaluation.readinessBand,criteria:evaluation.criteria,at:new Date().toISOString(),diagnostic:task.diagnostic,assisted:Boolean(task.assisted),cycleStage:task._cycleStage||null});
    logHistory(task.assisted?'Speaking assistido':'Speaking',`Section ${task.section}`,`${evaluation.overall}/100 · ${bandLabel(evaluation.readinessBand)}`);
    if(task.diagnostic){
      if(task.section==='A')state.diagnostic.speakingA=true; if(task.section==='B')state.diagnostic.speakingB=true;
      maybeFinishDiagnostic();
    }
    saveState();
    window.dispatchEvent(new CustomEvent('target6:speaking-evaluated',{detail:{task,evaluation,transcript,durationSeconds}}));
  }catch(e){toast(friendlyError(e),'error')}
  finally{setBusy(btn,false)}
}
function renderSpeakingEvaluation(ev,workspace){
  const crit=ev.criteria||{};
  const labels={taskFulfillment:'Tarefa',interactionStrategy:'Interação',vocabulary:'Vocabulário',grammar:'Gramática',organizationFluency:'Fluência',comprehensibilityFromTranscript:'Clareza'};
  $('#speakingFeedback',workspace).innerHTML=`<div class="feedback"><div class="panel-head"><h3>${escapeHtml(bandLabel(ev.readinessBand))}</h3><span class="badge">${Number(ev.overall)||0}/100</span></div><p><strong>Estimativa de treino — não é score oficial.</strong> Confiança: ${escapeHtml(ev.confidence||'—')}.</p><div class="score-grid">${Object.entries(labels).map(([k,l])=>`<div class="score-item"><span>${l}</span><strong>${Number(crit[k]||0)}</strong></div>`).join('')}</div><h4>Pontos fortes</h4><ul class="priority-list">${(ev.strengthsPt||[]).map(x=>`<li>${escapeHtml(x)}</li>`).join('')}</ul><h4>Prioridades</h4><ul class="priority-list">${(ev.prioritiesPt||[]).map(x=>`<li>${escapeHtml(x)}</li>`).join('')}</ul><h4>Próximo drill</h4><p>${escapeHtml(ev.nextDrillPt||'')}</p><details><summary>Exemplo melhor em francês</summary><p>${escapeHtml(ev.modelAnswerFr||'')}</p></details></div>`;
}
function bandLabel(b){return ({BELOW_NCLC5:'Abaixo da zona NCLC 5',NCLC5_RANGE:'Zona de preparação NCLC 5',NCLC6_RANGE:'Zona de preparação NCLC 6',NCLC7_PLUS_RANGE:'Zona de preparação NCLC 7+'})[b]||b||'Sem estimativa'}

// Diagnostic flow: 8 adaptive listening items, then speaking A and B.
$('#startDiagnostic').addEventListener('click',startDiagnostic);
function startDiagnostic(){
  state.diagnostic={active:true,listeningDone:false,speakingA:false,speakingB:false,speakingBaseline:false,completed:false,correct:0,total:0,startedAt:new Date().toISOString()};saveState();
  diagnosticRuntime={index:0,correct:0}; $('#diagnosticWorkspace').classList.remove('hidden'); runNextDiagnosticListening();
}
async function runNextDiagnosticListening(){
  const w=$('#diagnosticWorkspace');
  if(!diagnosticRuntime)diagnosticRuntime={index:state.diagnostic.total||0,correct:state.diagnostic.correct||0};
  if(diagnosticRuntime.index>=8){
    state.diagnostic.listeningDone=true;state.diagnostic.correct=diagnosticRuntime.correct;state.diagnostic.total=8;saveState();
    w.innerHTML=`<div class="panel-head"><h3>Listening concluído</h3><span class="badge">${diagnosticRuntime.correct}/8</span></div><p>Agora vamos medir a tua base oral <strong>sem te obrigar a fazer 5 ou 10 minutos de Speaking</strong>. Vais completar 5 micro-drills: ouvir, repetir, corrigir e consolidar.</p><div class="hero-actions"><button id="diagSpeakProgressive" class="primary-btn">Começar nivelamento oral</button></div>`;
    $('#diagSpeakProgressive').onclick=()=>{ if(window.startProgressiveDiagnostic) window.startProgressiveDiagnostic(); else startDiagnosticSpeaking('A'); };return;
  }
  const idx=diagnosticRuntime.index; const levels=['A2','B1','B1','B1','B2','B1','B2','B2'];
  w.innerHTML=`<div class="panel-head"><h3>Listening ${idx+1}/8</h3><span class="badge">Diagnóstico</span></div><div id="diagItem"><p>A preparar questão…</p></div>`;
  const fake={textContent:'',disabled:false,dataset:{},innerHTML:''};
  try{
    const {item}=await api('/api/generate-listening',{difficulty:levels[idx],focus:['detail','purpose','number_time','inference'][idx%4]});
    currentListening={...item,answered:false,plays:0,assisted:false,supportMode:'diagnostic',examMode:true,diagnostic:true};
    renderListening(currentListening,$('#diagItem'),(correct,item,workspace)=>{
      diagnosticRuntime.index++; if(correct)diagnosticRuntime.correct++; state.diagnostic.correct=diagnosticRuntime.correct; state.diagnostic.total=diagnosticRuntime.index; saveState();
      const feedback=$('#listenFeedback',workspace);
      if(feedback){ const next=document.createElement('button'); next.className='primary-btn diagnostic-next'; next.textContent=diagnosticRuntime.index>=8?'Continuar para Speaking':'Próxima questão'; next.onclick=runNextDiagnosticListening; feedback.appendChild(next); }
    });
  }catch(e){w.innerHTML+=`<p>${escapeHtml(friendlyError(e))}</p><button id="retryDiag" class="secondary-btn">Tentar novamente</button>`;$('#retryDiag').onclick=runNextDiagnosticListening}
}
function startDiagnosticSpeaking(section){
  navigate('speaking'); speakingSection=section; $$('#speakingSectionSelector .seg').forEach(b=>b.classList.toggle('active',b.dataset.section===section));
  generateSpeakingTask({section,difficulty:'B1',diagnostic:true});
  toast(`Diagnóstico: completa a Section ${section} e clica “Avaliar com AI”.`);
}
function maybeFinishDiagnostic(){
  if(state.diagnostic.listeningDone&&state.diagnostic.speakingA&&state.diagnostic.speakingB){
    state.diagnostic.completed=true;state.diagnostic.active=false;state.diagnostic.completedAt=new Date().toISOString();state.sessions=(state.sessions||0)+1;
    logHistory('Diagnóstico','Diagnóstico inicial','Concluído');
    toast('Diagnóstico completo. Agora recalcula o Plano AI.');
  } else if(state.diagnostic.active){
    const next=state.diagnostic.speakingA?'B':'A';
    toast(`Secção guardada. Falta Speaking ${next}.`);
  }
}

$('#generatePlan').addEventListener('click',generatePlan);
async function generatePlan(){
  const btn=$('#generatePlan'); setBusy(btn,true,'A calcular plano…');
  try{
    const rawExamDate=String(state.settings?.examDate||'').trim();
    let daysUntilExam=null;
    if(rawExamDate){
      const target=new Date(rawExamDate+'T12:00:00'); const now=new Date(); now.setHours(12,0,0,0);
      if(!Number.isNaN(target.getTime())) daysUntilExam=Math.ceil((target-now)/86400000);
    }
    const progress={listeningAccuracy:listeningAccuracy(),listeningAttempts:state.listeningAttempts.slice(-20),speakingAverage:speakingAverage(),speakingAttempts:state.speakingAttempts.slice(-10),speakingTraining:state.speakingTraining||null,vocabDue:state.vocab.slice(-30),diagnostic:state.diagnostic,examDate:rawExamDate,daysUntilExam};
    const {plan}=await api('/api/coach-plan',{progress}); state.plan={...plan,generatedAt:new Date().toISOString()};saveState();renderPlan();toast('Plano de 7 dias atualizado.');
  }catch(e){toast(friendlyError(e),'error')}
  finally{setBusy(btn,false)}
}
function renderPlan(){
  const w=$('#planWorkspace'); if(!w)return;
  if(!state.plan?.days?.length){w.innerHTML=`<div class="panel"><h3>Ainda sem plano</h3><p>Conclui o diagnóstico ou alguns exercícios e clica “Recalcular plano com AI”.</p></div>`;return;}
  w.innerHTML=`<div class="panel"><div class="small-label">RESUMO</div><p>${escapeHtml(state.plan.summaryPt||'')}</p><strong>Prioridade: ${escapeHtml(state.plan.priority||'balanced')}</strong></div>${state.plan.days.map(d=>`<div class="day-card"><div class="panel-head"><h4>Dia ${d.day}</h4><span class="badge">${d.minutes} min</span></div><ul>${(d.tasks||[]).map(t=>`<li>${escapeHtml(t)}</li>`).join('')}</ul><small><strong>Sucesso:</strong> ${escapeHtml(d.successRule||'')}</small></div>`).join('')}<div class="panel"><div class="small-label">READINESS</div><p>${escapeHtml(state.plan.readinessMessagePt||'')}</p></div>`;
}

function renderHistory(){
  const w=$('#historyList'); if(!w)return;
  if(!state.history.length){w.innerHTML='<p>Sem histórico ainda.</p>';return;}
  w.innerHTML=state.history.slice(0,30).map(h=>`<div class="history-row"><strong>${escapeHtml(h.kind)}</strong><div>${escapeHtml(h.title)}<br><small>${new Date(h.at).toLocaleString()}</small></div><span>${escapeHtml(h.result)}</span></div>`).join('');
}
$('#clearProgress').addEventListener('click',()=>{
  if(confirm('Apagar todo o progresso local desta plataforma?')){state=initialState();saveState();renderHistory();renderPlan();toast('Progresso local apagado.');}
});



function trainingGate(){
  const l=listeningAccuracy() ?? 0;
  const recentSpeaking=state.speakingAttempts.slice(-8);
  const hasA=recentSpeaking.some(x=>x.section==='A' && x.readinessBand!=='BELOW_NCLC5');
  const hasB=recentSpeaking.some(x=>x.section==='B' && x.readinessBand!=='BELOW_NCLC5');
  const checks=[
    {label:'Diagnóstico concluído',ok:Boolean(state.diagnostic.completed)},
    {label:'20+ respostas Listening sem ajuda',ok:unassistedListeningAttempts().length>=20},
    {label:'Listening recente sem ajuda ≥70% (regra interna)',ok:unassistedListeningAttempts().length>=20 && l>=70},
    {label:'4+ avaliações de Speaking',ok:state.speakingAttempts.length>=4},
    {label:'Evidência recente em Speaking A',ok:hasA},
    {label:'Evidência recente em Speaking B',ok:hasB},
  ];
  return {checks,ready:checks.every(x=>x.ok)};
}

function renderMockStatus(){
  const box=$('#mockGate'); if(!box)return;
  const g=trainingGate();
  box.innerHTML=`<strong>${g.ready?'READY interno para simulação completa':'Podes fazer já; ainda não estás no gate recomendado'}</strong><div class="gate-list">${g.checks.map(c=>`<span class="${c.ok?'gate-ok':'gate-no'}">${c.ok?'✓':'○'} ${escapeHtml(c.label)}</span>`).join('')}</div><small>Este gate é uma regra interna de preparação e não equivale a uma classificação oficial TEF/NCLC.</small>`;
}

$('#startFullMock')?.addEventListener('click',startFullMock);
$('#resetMock')?.addEventListener('click',()=>{
  clearInterval(fullMockTimer); clearInterval(speakingSectionTimer); fullMockRuntime=null;
  const w=$('#mockWorkspace');
  w.className='panel exercise-panel empty-state';
  w.innerHTML='<div class="empty-icon">40</div><h3>Mock reiniciado.</h3><p>Carrega em “Iniciar Full Mock” quando estiveres pronto.</p>';
});

async function startFullMock(){
  const w=$('#mockWorkspace');
  if(!health?.aiConfigured){toast('Primeiro liga a API em SET_API_KEY.command.','error');return;}
  clearInterval(fullMockTimer); clearInterval(speakingSectionTimer);
  fullMockRuntime={stage:'preparing',questions:[],index:0,correct:0,startedAt:new Date().toISOString(),speakingResults:{},conversation:[]};
  w.className='panel exercise-panel';
  w.innerHTML='<div class="panel-head"><h3>A preparar 40 questões originais</h3><span id="mockPrepBadge" class="badge">0/40</span></div><p>Preparação inicial para evitar pausas de geração durante o relógio do exame.</p><div class="progress-track"><div id="mockPrepBar" class="progress-bar" style="width:0%"></div></div>';
  try{
    for(let i=0;i<4;i++){
      const {items}=await api('/api/generate-listening-batch',{count:10,startIndex:i*10+1});
      fullMockRuntime.questions.push(...items.map(x=>({...x,answered:false,plays:0,examMode:true,suppressFeedback:true,mock:true})));
      const n=fullMockRuntime.questions.length;
      $('#mockPrepBadge').textContent=`${n}/40`; $('#mockPrepBar').style.width=`${n/40*100}%`;
    }
    fullMockRuntime.stage='listening'; fullMockRuntime.listeningStartedAt=Date.now(); fullMockRuntime.secondsLeft=2400;
    startMockClock(); renderMockQuestion();
  }catch(e){
    w.innerHTML=`<div class="feedback"><strong>Não consegui preparar o mock.</strong><p>${escapeHtml(friendlyError(e))}</p></div><button id="retryFullMock" class="primary-btn">Tentar novamente</button>`;
    $('#retryFullMock').onclick=startFullMock;
  }
}

function startMockClock(){
  clearInterval(fullMockTimer);
  fullMockTimer=setInterval(()=>{
    if(!fullMockRuntime || fullMockRuntime.stage!=='listening'){clearInterval(fullMockTimer);return;}
    fullMockRuntime.secondsLeft--;
    const el=$('#mockClock'); if(el)el.textContent=formatTime(Math.max(0,fullMockRuntime.secondsLeft));
    if(fullMockRuntime.secondsLeft<=0){clearInterval(fullMockTimer);finishMockListening(true);}
  },1000);
}

function renderMockQuestion(){
  if(!fullMockRuntime || fullMockRuntime.stage!=='listening')return;
  if(fullMockRuntime.index>=fullMockRuntime.questions.length){finishMockListening(false);return;}
  const w=$('#mockWorkspace'); const idx=fullMockRuntime.index; const item=fullMockRuntime.questions[idx];
  w.className='panel exercise-panel';
  w.innerHTML=`<div class="mock-head"><div><div class="small-label">FULL MOCK · LISTENING</div><h3>Questão ${idx+1} de 40</h3></div><div class="mock-clock" id="mockClock">${formatTime(fullMockRuntime.secondsLeft)}</div></div><div id="mockQuestion"></div>`;
  renderListening(item,$('#mockQuestion'),correct=>{
    if(correct)fullMockRuntime.correct++;
    fullMockRuntime.index++;
    setTimeout(renderMockQuestion,280);
  });
  const small=$('#mockQuestion .audio-box small'); if(small)small.textContent='Uma única reprodução. Depois de responder não podes voltar atrás.';
}

function finishMockListening(timedOut=false){
  if(!fullMockRuntime || fullMockRuntime.stage!=='listening')return;
  clearInterval(fullMockTimer); fullMockRuntime.stage='speaking-ready';
  const answered=fullMockRuntime.index; const score=fullMockRuntime.correct;
  const w=$('#mockWorkspace');
  w.innerHTML=`<div class="panel-head"><h3>Listening terminado</h3><span class="badge">${score}/${answered || 40}</span></div><p>${timedOut?'O relógio de 40 minutos terminou.':'Completaste as 40 questões.'} O valor acima é apenas resultado bruto de treino; não é convertido diretamente num score TEF oficial.</p><div class="mock-rule"><strong>Segue agora para Expression orale.</strong> Section A = 5 min; Section B = 10 min.</div><button id="mockSpeakA" class="primary-btn">Iniciar Speaking A</button>`;
  $('#mockSpeakA').onclick=()=>startInteractiveMockSpeaking('A');
}

async function startInteractiveMockSpeaking(section){
  const w=$('#mockWorkspace');
  w.innerHTML=`<div class="panel-head"><h3>A preparar Speaking ${section}</h3><span class="loader"></span></div>`;
  try{
    const {task}=await api('/api/generate-speaking',{section,difficulty:'B1'});
    fullMockRuntime.stage=`speaking-${section}`; fullMockRuntime.currentSection=section; fullMockRuntime.currentTask=task; fullMockRuntime.conversation=[]; fullMockRuntime.candidateTurns=[];
    fullMockRuntime.sectionSeconds=section==='A'?300:600;
    renderInteractiveSpeaking(); startInteractiveSpeakingClock();
  }catch(e){w.innerHTML=`<div class="feedback"><strong>Erro a preparar Speaking.</strong><p>${escapeHtml(friendlyError(e))}</p></div>`;}
}

function startInteractiveSpeakingClock(){
  clearInterval(speakingSectionTimer);
  speakingSectionTimer=setInterval(()=>{
    if(!fullMockRuntime || !String(fullMockRuntime.stage).startsWith('speaking-')){clearInterval(speakingSectionTimer);return;}
    fullMockRuntime.sectionSeconds--;
    const el=$('#interactiveClock'); if(el)el.textContent=formatTime(Math.max(0,fullMockRuntime.sectionSeconds));
    if(fullMockRuntime.sectionSeconds<=0){clearInterval(speakingSectionTimer);finishInteractiveSection();}
  },1000);
}

function renderInteractiveSpeaking(){
  const w=$('#mockWorkspace'); const rt=fullMockRuntime; const t=rt.currentTask; const section=rt.currentSection;
  w.innerHTML=`<div class="mock-head"><div><div class="small-label">FULL MOCK · SPEAKING ${section}</div><h3>${escapeHtml(t.title||`Section ${section}`)}</h3></div><div id="interactiveClock" class="mock-clock">${formatTime(rt.sectionSeconds)}</div></div><div class="task-card"><h4>Consigne</h4><div class="task-prompt">${escapeHtml(t.promptFr||'')}</div></div><div id="conversationLog" class="conversation-log"></div><div class="recording-controls"><button id="turnStart" class="record-btn">● Gravar turno</button><button id="turnStop" class="stop-btn" disabled>■ Parar e enviar</button><button id="finishInteractive" class="secondary-btn">Terminar secção e avaliar</button></div><div id="turnStatus" class="small-label">Fala em francês. O examinador AI responderá depois de cada turno.</div>`;
  $('#turnStart').onclick=startTurnRecording; $('#turnStop').onclick=stopTurnRecording; $('#finishInteractive').onclick=finishInteractiveSection;
  renderConversationLog();
}

function renderConversationLog(){
  const log=$('#conversationLog'); if(!log || !fullMockRuntime)return;
  if(!fullMockRuntime.conversation.length){log.innerHTML='<div class="conversation-empty">A interação aparecerá aqui.</div>';return;}
  log.innerHTML=fullMockRuntime.conversation.map(x=>`<div class="bubble ${x.role==='candidate'?'candidate':'examiner'}"><span>${x.role==='candidate'?'Tu':'Examinador'}</span>${escapeHtml(x.text)}</div>`).join('');
  log.scrollTop=log.scrollHeight;
}

async function startTurnRecording(){
  if(!navigator.mediaDevices?.getUserMedia){toast('Microfone indisponível.','error');return;}
  try{
    turnStream=await navigator.mediaDevices.getUserMedia({audio:true});
    const mime=MediaRecorder.isTypeSupported('audio/webm;codecs=opus')?'audio/webm;codecs=opus':'audio/webm';
    turnRecorder=new MediaRecorder(turnStream,{mimeType:mime}); turnChunks=[]; turnStartedAt=Date.now();
    turnRecorder.ondataavailable=e=>{if(e.data.size)turnChunks.push(e.data)};
    turnRecorder.start(400); $('#turnStart').disabled=true; $('#turnStop').disabled=false; $('#turnStatus').textContent='A gravar…';
  }catch(e){toast(`Não consegui abrir o microfone: ${e.message}`,'error');}
}

async function stopTurnRecording(){
  if(!turnRecorder || turnRecorder.state!=='recording')return;
  $('#turnStop').disabled=true; $('#turnStatus').textContent='A transcrever e obter resposta do examinador…';
  const dataUrl=await new Promise(resolve=>{
    turnRecorder.onstop=()=>{
      const blob=new Blob(turnChunks,{type:turnRecorder.mimeType}); const reader=new FileReader(); reader.onload=()=>resolve(reader.result); reader.readAsDataURL(blob);
      if(turnStream)turnStream.getTracks().forEach(t=>t.stop());
    };
    turnRecorder.stop();
  });
  try{
    const {transcript}=await api('/api/transcribe',{audioDataUrl:dataUrl});
    const candidateText=String(transcript||'').trim();
    if(!candidateText)throw new Error('A transcrição ficou vazia. Repete o turno.');
    fullMockRuntime.conversation.push({role:'candidate',text:candidateText}); fullMockRuntime.candidateTurns.push(candidateText); renderConversationLog();
    const history=fullMockRuntime.conversation.slice(-10);
    const {turn}=await api('/api/examiner-turn',{section:fullMockRuntime.currentSection,task:fullMockRuntime.currentTask,history,candidateText});
    fullMockRuntime.conversation.push({role:'examiner',text:turn.replyFr}); renderConversationLog();
    const spoken=await api('/api/tts',{text:turn.replyFr,voice:'cedar',role:'man'});
    await playAudioUrl(spoken.audioDataUrl);
    $('#turnStatus').textContent='Resposta do examinador reproduzida. Continua a interação.';
  }catch(e){toast(friendlyError(e),'error'); $('#turnStatus').textContent='Falha no turno. Podes gravar novamente.';}
  finally{$('#turnStart').disabled=false;}
}

async function finishInteractiveSection(){
  if(!fullMockRuntime || !String(fullMockRuntime.stage).startsWith('speaking-'))return;
  clearInterval(speakingSectionTimer);
  if(turnRecorder?.state==='recording'){try{turnRecorder.stop()}catch{}}
  if(turnStream)turnStream.getTracks().forEach(t=>t.stop());
  const section=fullMockRuntime.currentSection; const task=fullMockRuntime.currentTask;
  const transcript=(fullMockRuntime.candidateTurns||[]).join('\n');
  const usedSeconds=(section==='A'?300:600)-Math.max(0,fullMockRuntime.sectionSeconds);
  const w=$('#mockWorkspace');
  if(!transcript.trim()){
    toast('Preciso de pelo menos um turno falado antes de avaliar.','error'); startInteractiveSpeakingClock(); return;
  }
  w.innerHTML=`<div class="panel-head"><h3>Avaliação multi-rater · Speaking ${section}</h3><span class="loader"></span></div><p>Dois avaliadores independentes + consenso conservador.</p>`;
  try{
    const {evaluation,raters}=await api('/api/evaluate-speaking-multi',{section,task,transcript,durationSeconds:usedSeconds});
    fullMockRuntime.speakingResults[section]={evaluation,raters};
    state.speakingAttempts.push({section,overall:evaluation.overall,readinessBand:evaluation.readinessBand,criteria:evaluation.criteria,at:new Date().toISOString(),mock:true});
    logHistory('Full Mock Speaking',`Section ${section}`,`${evaluation.overall}/100 · ${bandLabel(evaluation.readinessBand)}`); saveState();
    w.innerHTML='<div id="mockEval"></div><div class="hero-actions" id="mockEvalActions"></div>';
    const holder=$('#mockEval'); holder.innerHTML='<div id="speakingFeedback"></div>'; renderSpeakingEvaluation(evaluation,holder);
    const actions=$('#mockEvalActions');
    if(section==='A')actions.innerHTML='<button id="mockSpeakB" class="primary-btn">Continuar para Speaking B</button>';
    else actions.innerHTML='<button id="finishFullMock" class="primary-btn">Concluir Full Mock</button>';
    if(section==='A')$('#mockSpeakB').onclick=()=>startInteractiveMockSpeaking('B'); else $('#finishFullMock').onclick=completeFullMock;
  }catch(e){w.innerHTML=`<div class="feedback"><strong>Falha na avaliação.</strong><p>${escapeHtml(friendlyError(e))}</p></div><button id="retryEval" class="primary-btn">Tentar avaliação novamente</button>`;$('#retryEval').onclick=finishInteractiveSection;}
}

function completeFullMock(){
  if(!fullMockRuntime)return;
  const a=fullMockRuntime.speakingResults.A?.evaluation; const b=fullMockRuntime.speakingResults.B?.evaluation;
  const run={at:new Date().toISOString(),listeningCorrect:fullMockRuntime.correct,listeningAnswered:fullMockRuntime.index,speakingA:a?.overall??null,speakingB:b?.overall??null,readiness:readiness()};
  state.mockRuns=state.mockRuns||[]; state.mockRuns.push(run); state.sessions=(state.sessions||0)+1; logHistory('Full Mock','40 Listening + Speaking A/B',`${run.listeningCorrect}/40 · A ${run.speakingA}/100 · B ${run.speakingB}/100`); saveState();
  fullMockRuntime.stage='done';
  $('#mockWorkspace').innerHTML=`<div class="panel-head"><h3>Full Mock concluído</h3><span class="badge">GUARDADO</span></div><div class="grid-3 metrics"><div class="metric-card"><span>Listening bruto</span><strong>${run.listeningCorrect}/40</strong><small>não convertido em score TEF</small></div><div class="metric-card"><span>Speaking A</span><strong>${run.speakingA}/100</strong><small>estimativa AI de treino</small></div><div class="metric-card"><span>Speaking B</span><strong>${run.speakingB}/100</strong><small>estimativa AI de treino</small></div></div><div class="mock-rule"><strong>Próxima ação:</strong> abre o Plano AI e recalcula com estes resultados.</div><button id="mockToPlan" class="primary-btn">Abrir Plano AI</button>`;
  $('#mockToPlan').onclick=()=>navigate('plan'); renderMockStatus();
}

function dueVocab(){
  const now=Date.now(); return (state.vocab||[]).filter(v=>!v.nextReviewAt || new Date(v.nextReviewAt).getTime()<=now);
}
function renderVocabReview(){
  const box=$('#vocabReview'); const badge=$('#vocabDueBadge'); if(!box||!badge)return;
  const due=dueVocab(); badge.textContent=`${due.length} devido${due.length===1?'':'s'}`;
  if(!due.length){box.innerHTML='<p>Sem vocabulário devido agora. Novos itens aparecem automaticamente a partir dos exercícios de Listening.</p>';return;}
  const v=due[0];
  box.innerHTML=`<div class="flashcard"><div class="small-label">FRANCÊS</div><div class="flash-word">${escapeHtml(v.fr)}</div><div id="flashMeaning" class="flash-meaning hidden">${escapeHtml(v.pt||'')}</div></div><div class="recording-controls"><button id="showMeaning" class="secondary-btn">Mostrar tradução</button><button id="vocabMiss" class="danger-ghost">Não sabia</button><button id="vocabKnow" class="primary-btn">Sabia</button></div>`;
  $('#showMeaning').onclick=()=>$('#flashMeaning').classList.remove('hidden');
  $('#vocabMiss').onclick=()=>reviewVocab(v,false); $('#vocabKnow').onclick=()=>reviewVocab(v,true);
}
function reviewVocab(v,knew){
  v.reviews=(v.reviews||0)+1;
  if(knew){const steps=[1,3,7,14,30,60];v.level=Math.min((v.level||0)+1,steps.length-1);v.intervalDays=steps[v.level];}
  else{v.level=0;v.intervalDays=1;}
  v.nextReviewAt=new Date(Date.now()+v.intervalDays*86400000).toISOString(); saveState(); renderVocabReview();
}

$('#testAI')?.addEventListener('click',async()=>{
  const btn=$('#testAI'); const out=$('#testAIResult'); setBusy(btn,true,'A testar…'); out.textContent='';
  try{const r=await api('/api/test-ai',{});out.textContent=r.ok?'Ligação AI confirmada.':'A API respondeu, mas o teste não devolveu OK.';toast('Ligação AI operacional.');}
  catch(e){out.textContent=friendlyError(e);toast(friendlyError(e),'error');}
  finally{setBusy(btn,false);}
});


function renderSettings(){
  if(!$('#modelInfo'))return;
  $('#settingsAIStatus').textContent=health?.aiConfigured?'LIGADO':'SEM CHAVE';
  $('#settingsAIStatus').className=`badge ${health?.aiConfigured?'':'neutral'}`;
  $('#modelInfo').innerHTML=health?`<div><span>Rotina / exercícios</span><code>${escapeHtml(health.routineModel)}</code></div><div><span>Avaliação / plano</span><code>${escapeHtml(health.evaluationModel)}</code></div><div><span>Transcrição</span><code>${escapeHtml(health.transcribeModel)}</code></div><div><span>Áudio HQ</span><code>${escapeHtml(health.ttsModel)}</code></div>`:'<p>A carregar…</p>';
}

function formatTime(sec){const m=Math.floor(sec/60),s=sec%60;return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`}
function escapeHtml(v=''){return String(v).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
function friendlyError(e){
  const m=String(e?.message||e);
  if(m.includes('OPENAI_API_KEY_NOT_CONFIGURED'))return 'A AI ainda não está ligada. Abre a página Ligar AI e adiciona a tua API key.';
  if(/quota|billing|credit|limit/i.test(m))return `A API recusou o pedido por limite/crédito: ${m}`;
  return m;
}

// Minimal bilingual navigation. Exam content remains French by design.
const staticEn={
  'Diagnóstico':'Diagnostic','Plano AI':'AI Plan','Progresso':'Progress','Definições':'Settings',
  'Começar diagnóstico':'Start diagnostic','Treinar agora':'Train now','Gerar exercício':'Generate exercise','Gerar tarefa':'Generate task','Recalcular plano com AI':'Recalculate plan with AI',
  'Objetivo imediato':'Immediate goal','NCLC 5 obrigatório':'NCLC 5 required','Treino para NCLC 6':'Train toward NCLC 6',
  'Próxima ação':'Next action','Regra de prontidão':'Readiness rule','Treino adaptativo':'Adaptive training','Dificuldade':'Difficulty','Modo de áudio':'Audio mode',
  'Expression orale':'Oral expression','Plano adaptativo de 7 dias':'7-day adaptive plan','Histórico recente':'Recent history','Limpar progresso':'Clear progress'
};
$('#langToggle').addEventListener('click',()=>{
  state.settings.lang=state.settings.lang==='pt'?'en':'pt';saveState();applyLanguage();
});
function applyLanguage(){
  const en=state.settings.lang==='en'; $('#langToggle').textContent=en?'EN / PT':'PT / EN';
  const selectors=['.nav-item','.sidebar-footer .small-label','.goal-pill','.primary-btn','.secondary-btn','.panel h3'];
  $$(selectors.join(',')).forEach(el=>{
    if(!el.dataset.pt)el.dataset.pt=el.textContent.trim();
    if(en && staticEn[el.dataset.pt])el.textContent=staticEn[el.dataset.pt];
    else if(!en&&el.dataset.pt)el.textContent=el.dataset.pt;
  });
  const active=$('.nav-item.active')?.dataset.page||'dashboard';
  $('#pageTitle').textContent=en?(staticEn[pageTitles[active]]||pageTitles[active]):pageTitles[active];
}

updateDashboard();renderPlan();renderHistory();renderVocabReview();renderMockStatus();applyLanguage();checkHealth();