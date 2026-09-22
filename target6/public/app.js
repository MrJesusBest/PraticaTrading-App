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
  diagnostic: { active:false, listeningDone:false, speakingA:false, speakingB:false, completed:false, correct:0, total:0 },
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
  if (on){ el.dataset.oldText = el.textContent; el.disabled=true; el.innerHTML=`<span class="loader"></span>${label||'A processar…'}`; }
  else { el.disabled=false; el.textContent=el.dataset.oldText||el.textContent; }
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
  const a = state.speakingAttempts.slice(-10).map(x=>Number(x.overall)).filter(Number.isFinite);
  return a.length ? Math.round(a.reduce((x,y)=>x+y,0)/a.length) : null;
}
function readiness(){
  const l=listeningAccuracy(), s=speakingAverage();
  if(l==null && s==null) return 0;
  if(l==null) return Math.round(s*.55);
  if(s==null) return Math.round(l*.45);
  let score = Math.round(l*.48+s*.52);
  if(unassistedListeningAttempts().length<8) score=Math.min(score,58);
  if(state.speakingAttempts.length<2) score=Math.min(score,58);
  return Math.max(0,Math.min(100,score));
}
function nextActionInfo(){
  if(!state.diagnostic.completed) return {page:'diagnostic',text:'Faz o diagnóstico inicial para o sistema descobrir onde deves concentrar o estudo.'};
  const l=listeningAccuracy() ?? 0, s=speakingAverage() ?? 0;
  if(state.speakingAttempts.length<4 || s < l-6) return {page:'speaking',text:'Prioridade: Speaking. Faz uma tarefa da secção com menor desempenho e aplica a correção imediatamente.'};
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

async function generateListening(opts={}){
  const button=opts.button || $('#generateListening');
  const difficulty=opts.difficulty || $('#listeningDifficulty').value;
  const supportMode=opts.supportMode || $('#listeningSupportMode')?.value || 'learn';
  setBusy(button,true,'A criar exercício…');
  try{
    const {item}=await api('/api/generate-listening',{difficulty,focus:opts.focus||'general'});
    currentListening={...item,answered:false,plays:0,assisted:false,supportMode,examMode:Boolean(opts.examMode || supportMode==='exam'),diagnostic:Boolean(opts.diagnostic)};
    renderListening(currentListening, opts.workspace || $('#listeningWorkspace'), opts.onAnswered);
    $('#listeningDifficultyBadge').textContent=difficulty;
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
  const feedback=$('#listenFeedback',workspace); if(!feedback)return;
  const turns=Array.isArray(item.turns)&&item.turns.length?item.turns:[{speaker:'neutral',text:item.script||'',pt:item.scriptPt||''}];
  const choicesPt=Array.isArray(item.choicesPt)?item.choicesPt:[];
  feedback.innerHTML=`<div class="feedback study-review">
    <div class="panel-head"><h3>${correct?'✓ Correto':'✗ Vamos perceber o erro'}</h3><span class="badge ${item.assisted?'neutral':''}">${item.assisted?'ASSISTIDO':'REVISÃO'}</span></div>
    ${item.assisted?'<div class="assisted-note">Usaste ajuda antes de responder. Esta tentativa fica guardada, mas não entra na readiness.</div>':''}
    <p><strong>Explicação:</strong> ${escapeHtml(item.explanationPt||'')}</p>
    <div class="review-section"><div class="review-title">1 · ÁUDIO — francês + tradução</div><button class="secondary-btn compact" id="reviewReplay">▶ Ouvir diálogo novamente</button><div class="turn-review">
      ${turns.map((t,i)=>`<div class="turn-review-row"><button class="mini-audio review-turn-audio" data-i="${i}">🔊</button><div><strong>${t.speaker==='woman'?'Mulher':t.speaker==='man'?'Homem':'Voz'}:</strong> <span lang="fr">${escapeHtml(t.text)}</span><small>${escapeHtml(t.pt||'')}</small></div></div>`).join('')}
    </div></div>
    <div class="review-section"><div class="review-title">2 · PERGUNTA</div><div class="study-line"><button class="mini-audio" id="reviewQuestionAudio">🔊</button><div><span lang="fr">${escapeHtml(item.question)}</span><small>${escapeHtml(item.questionPt||'')}</small></div></div></div>
    <div class="review-section"><div class="review-title">3 · RESPOSTAS</div><div class="answer-study-list">${item.choices.map((c,i)=>`<div class="answer-study ${i===item.answerIndex?'answer-correct':''}"><button class="mini-audio review-choice-audio" data-i="${i}">🔊</button><div><strong>${String.fromCharCode(65+i)}.</strong> <span lang="fr">${escapeHtml(c)}</span><small>${escapeHtml(choicesPt[i]||'')}</small></div></div>`).join('')}</div></div>
    <div class="review-section"><div class="review-title">4 · VOCABULÁRIO ÚTIL</div><div class="vocab-chips">${(item.vocab||[]).map(v=>`<span class="vocab-chip"><b>${escapeHtml(v.fr)}</b> · ${escapeHtml(v.pt)}</span>`).join('')}</div></div>
  </div>`;
  $('#reviewReplay',feedback).onclick=()=>replayStudyAudio(item,$('#reviewReplay',feedback));
  $$('.review-turn-audio',feedback).forEach(b=>{const t=turns[Number(b.dataset.i)];b.onclick=()=>playStudyPhrase(t.text,t.speaker,b)});
  $('#reviewQuestionAudio',feedback).onclick=()=>playStudyPhrase(item.question,'neutral',$('#reviewQuestionAudio',feedback));
  $$('.review-choice-audio',feedback).forEach(b=>{const i=Number(b.dataset.i);b.onclick=()=>playStudyPhrase(item.choices[i],'neutral',b)});
}

function renderListening(item, workspace=$('#listeningWorkspace'), onAnswered){
  workspace.classList.remove('empty-state');
  const allowAssist=item.supportMode==='learn'&&!item.diagnostic&&!item.mock&&!item.examMode;
  const allowWordAudio=allowAssist;
  const choiceRows=item.choices.map((c,i)=>allowWordAudio
    ? `<div class="choice-row"><button class="choice" data-i="${i}"><strong>${String.fromCharCode(65+i)}.</strong> ${escapeHtml(c)}</button><button class="mini-audio pre-choice-audio" data-i="${i}">🔊</button></div>`
    : `<button class="choice" data-i="${i}"><strong>${String.fromCharCode(65+i)}.</strong> ${escapeHtml(c)}</button>`).join('');
  workspace.innerHTML=`<div class="panel-head"><h3>${escapeHtml(item.title)}</h3><span class="badge">${escapeHtml(item.difficulty)} · ${escapeHtml(item.skillTag)}</span></div>
    <div class="inline-help"><span class="help-title">O QUE FAZER NESTA QUESTÃO</span><strong>1.</strong> Clica ▶ e ouve. <strong>2.</strong> Lê a pergunta. <strong>3.</strong> Escolhe A, B, C ou D. ${item.examMode?'<strong>Não podes repetir o áudio.</strong>':'No treino podes repetir.'}</div>
    <div class="audio-box"><div><strong>Écoutez le document.</strong><br><small><strong>Em português:</strong> Ouve o áudio. · ${item.audioType==='dialogue'?'Diálogo com 2 vozes e pausas naturais. · ':''}${item.examMode?'Uma única reprodução.':'Modo treino: podes repetir.'} · Voz gerada por AI.</small></div><button class="audio-btn" id="listenPlay">▶</button></div>
    <div class="question-row"><div class="question">${escapeHtml(item.question)}</div>${allowWordAudio?'<button class="mini-audio" id="preQuestionAudio">🔊</button>':''}</div>
    <div class="choices">${choiceRows}</div>
    ${allowAssist?`<div class="assist-zone"><button id="showPtHelp" class="secondary-btn compact">Preciso de ajuda PT</button><div id="ptHelp" class="assist-content hidden"><strong>Ajuda usada — esta questão não contará para readiness.</strong><p>${escapeHtml(item.questionPt||'')}</p><ol>${item.choices.map((c,i)=>`<li>${escapeHtml((item.choicesPt||[])[i]||'')}</li>`).join('')}</ol><small>A tradução do diálogo aparece depois de responder.</small></div></div>`:''}
    <div id="listenFeedback"></div>`;
  $('#listenPlay',workspace).onclick=()=>playListening(item,$('#listenPlay',workspace));
  $$('.choice',workspace).forEach(btn=>btn.onclick=()=>answerListening(item,Number(btn.dataset.i),workspace,onAnswered));
  if(allowWordAudio){
    $('#preQuestionAudio',workspace).onclick=()=>playStudyPhrase(item.question,'neutral',$('#preQuestionAudio',workspace));
    $$('.pre-choice-audio',workspace).forEach(b=>{const i=Number(b.dataset.i);b.onclick=()=>playStudyPhrase(item.choices[i],'neutral',b)});
  }
  if(allowAssist){ $('#showPtHelp',workspace).onclick=()=>{ item.assisted=true; $('#ptHelp',workspace).classList.remove('hidden'); $('#showPtHelp',workspace).disabled=true; $('#showPtHelp',workspace).textContent='Ajuda PT ativada'; }; }
}

function answerListening(item, chosen, workspace, onAnswered){
  if(item.answered)return; item.answered=true;
  const correct=chosen===item.answerIndex;
  $$('.choice',workspace).forEach((b,i)=>{b.disabled=true;if(i===item.answerIndex)b.classList.add('correct');else if(i===chosen)b.classList.add('wrong')});
  const attempt={correct,assisted:Boolean(item.assisted),difficulty:item.difficulty,skillTag:item.skillTag,at:new Date().toISOString(),diagnostic:item.diagnostic};
  state.listeningAttempts.push(attempt); addVocab(item.vocab||[]); logHistory('Listening',`${item.difficulty} · ${item.skillTag}`,`${correct?'Correto':'Errado'}${item.assisted?' · assistido':''}`);
  if(!item.suppressFeedback)renderListeningReview(item,workspace,correct);
  saveState(); if(onAnswered)onAnswered(correct,item,workspace);
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
  const sectionHelp=task.section==='A'?'<strong>Section A:</strong> faz perguntas para obter informações e mantém a conversa.':'<strong>Section B:</strong> argumenta, dá razões e tenta convencer.';
  workspace.innerHTML=`
    <div class="panel-head"><h3>Section ${escapeHtml(task.section)} · ${escapeHtml(task.title)}</h3><span class="badge">${task.section==='A'?'5 min':'10 min'}</span></div>
    <div class="inline-help"><span class="help-title">O QUE TENS DE FAZER</span>${sectionHelp}<br><strong>Depois:</strong> Gravar → Parar → Transcrever → Avaliar com AI.</div>
    <div class="task-card"><h4>Consigne <small>· instrução da tarefa</small></h4><div class="task-prompt">${escapeHtml(task.promptFr)}</div><p><small><strong>Dica em português:</strong> ${escapeHtml(task.prepTipPt||'')}</small></p></div>
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
    state.speakingAttempts.push({section:task.section,overall:evaluation.overall,readinessBand:evaluation.readinessBand,criteria:evaluation.criteria,at:new Date().toISOString(),diagnostic:task.diagnostic});
    logHistory('Speaking',`Section ${task.section}`,`${evaluation.overall}/100 · ${bandLabel(evaluation.readinessBand)}`);
    if(task.diagnostic){
      if(task.section==='A')state.diagnostic.speakingA=true; if(task.section==='B')state.diagnostic.speakingB=true;
      maybeFinishDiagnostic();
    }
    saveState();
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
  state.diagnostic={active:true,listeningDone:false,speakingA:false,speakingB:false,completed:false,correct:0,total:0,startedAt:new Date().toISOString()};saveState();
  diagnosticRuntime={index:0,correct:0}; $('#diagnosticWorkspace').classList.remove('hidden'); runNextDiagnosticListening();
}
async function runNextDiagnosticListening(){
  const w=$('#diagnosticWorkspace');
  if(!diagnosticRuntime)diagnosticRuntime={index:state.diagnostic.total||0,correct:state.diagnostic.correct||0};
  if(diagnosticRuntime.index>=8){
    state.diagnostic.listeningDone=true;state.diagnostic.correct=diagnosticRuntime.correct;state.diagnostic.total=8;saveState();
    w.innerHTML=`<div class="panel-head"><h3>Listening concluído</h3><span class="badge">${diagnosticRuntime.correct}/8</span></div><p>Agora precisamos das duas secções de Speaking. A avaliação é feita depois da gravação.</p><div class="hero-actions"><button id="diagSpeakA" class="primary-btn">Fazer Speaking A</button><button id="diagSpeakB" class="secondary-btn">Fazer Speaking B</button></div>`;
    $('#diagSpeakA').onclick=()=>startDiagnosticSpeaking('A');$('#diagSpeakB').onclick=()=>startDiagnosticSpeaking('B');return;
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
    const progress={listeningAccuracy:listeningAccuracy(),listeningAttempts:state.listeningAttempts.slice(-20),speakingAverage:speakingAverage(),speakingAttempts:state.speakingAttempts.slice(-10),vocabDue:state.vocab.slice(-30),diagnostic:state.diagnostic};
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