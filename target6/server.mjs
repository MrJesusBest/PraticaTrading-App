import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 4316);

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx < 1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadEnvFile(path.join(__dirname, '.env.local'));

let OPENAI_API_KEY = String(process.env.OPENAI_API_KEY || '').split(/[\r\n\u2028\u2029]/)[0].trim().replace(/^['\"]|['\"]$/g, '');
const ROUTINE_MODEL = process.env.TEF_ROUTINE_MODEL || 'gpt-5.6-luna';
const EVALUATION_MODEL = process.env.TEF_EVALUATION_MODEL || 'gpt-5.6-terra';
const TRANSCRIBE_MODEL = process.env.TEF_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe';
const TTS_MODEL = process.env.TEF_TTS_MODEL || 'gpt-4o-mini-tts';
const TTS_VOICE = process.env.TEF_TTS_VOICE || 'marin';
const TTS_WOMAN_VOICE = process.env.TEF_TTS_WOMAN_VOICE || 'marin';
const TTS_MAN_VOICE = process.env.TEF_TTS_MAN_VOICE || 'cedar';
const ALLOWED_TTS_VOICES = new Set(['alloy','ash','ballad','coral','echo','fable','nova','onyx','sage','shimmer','verse','marin','cedar']);

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readJson(req, maxBytes = 16 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Request too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (err) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function extractOutputText(data) {
  if (typeof data?.output_text === 'string') return data.output_text;
  const parts = [];
  for (const item of data?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === 'string') parts.push(content.text);
    }
  }
  return parts.join('\n').trim();
}

function extractJson(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(cleaned); } catch {}
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
  throw new Error('AI returned invalid JSON');
}

async function openAIResponse(prompt, model = ROUTINE_MODEL) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY_NOT_CONFIGURED');
  const r = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      store: false,
      input: prompt,
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data?.error?.message || `OpenAI error ${r.status}`;
    throw new Error(msg);
  }
  return extractOutputText(data);
}

async function textToSpeech(text, { voice = TTS_VOICE, role = 'neutral' } = {}) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY_NOT_CONFIGURED');
  const safeVoice = ALLOWED_TTS_VOICES.has(voice) ? voice : TTS_VOICE;
  const roleInstruction = role === 'woman'
    ? 'Sound like a natural adult French-speaking woman in a real everyday conversation.'
    : role === 'man'
      ? 'Sound like a natural adult French-speaking man in a real everyday conversation.'
      : 'Sound like a natural adult French speaker.';
  const r = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: TTS_MODEL,
      voice: safeVoice,
      input: text,
      instructions: `${roleInstruction} Use lifelike pacing, natural French intonation, subtle breathing space, and realistic conversational rhythm. Avoid announcer-style delivery unless the text is actually an announcement. Do not add, omit, or paraphrase words.`,
      response_format: 'mp3',
    }),
  });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw new Error(data?.error?.message || `TTS error ${r.status}`);
  }
  const arr = new Uint8Array(await r.arrayBuffer());
  return `data:audio/mpeg;base64,${Buffer.from(arr).toString('base64')}`;
}

function normalizeListeningTurns(body = {}) {
  const rawTurns = Array.isArray(body.turns) ? body.turns : [];
  const turns = rawTurns.slice(0, 12).map(t => ({
    speaker: ['woman','man','neutral'].includes(String(t?.speaker)) ? String(t.speaker) : 'neutral',
    text: String(t?.text || '').trim(),
  })).filter(t => t.text);
  if (turns.length) return turns;
  const script = String(body.script || body.text || '').trim();
  return script ? [{ speaker: 'neutral', text: script }] : [];
}

async function listeningToSpeech(body = {}) {
  const turns = normalizeListeningTurns(body);
  if (!turns.length) throw new Error('Invalid listening audio');
  const clips = [];
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    const voice = turn.speaker === 'woman' ? TTS_WOMAN_VOICE : turn.speaker === 'man' ? TTS_MAN_VOICE : TTS_VOICE;
    clips.push({
      speaker: turn.speaker,
      audioDataUrl: await textToSpeech(turn.text, { voice, role: turn.speaker }),
      pauseAfterMs: i === turns.length - 1 ? 0 : 650,
    });
  }
  return clips;
}

async function transcribeAudio(dataUrl) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY_NOT_CONFIGURED');
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || '');
  if (!m) throw new Error('Invalid audio data');
  const mime = m[1];
  const bytes = Buffer.from(m[2], 'base64');
  const ext = mime.includes('webm') ? 'webm' : mime.includes('mp4') ? 'mp4' : mime.includes('wav') ? 'wav' : 'webm';
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: mime }), `tef-response.${ext}`);
  form.append('model', TRANSCRIBE_MODEL);
  form.append('language', 'fr');
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` },
    body: form,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error?.message || `Transcription error ${r.status}`);
  return data.text || '';
}

function listeningPrompt({ difficulty = 'B1', focus = 'general' }) {
  return `You create ORIGINAL TEF Canada - 2 Modules French listening practice. Do not reproduce or paraphrase copyrighted official test questions.
Target learner level: ${difficulty}. Focus: ${focus}.
Create ONE realistic listening item inspired only by the official format: short everyday spoken French, one multiple-choice question, four choices, one correct answer.
The audio must sound like real life, not a narrator reading a transcript. Choose either:
- "dialogue": exactly 2 distinct people — one woman and one man — speaking naturally in alternating short turns, with 4-8 turns total;
- "monologue": 1 natural speaker for an announcement, voicemail, radio extract, instruction, etc.
The total spoken content must be 35-90 words. For dialogue, each turn should usually be 1-2 short sentences, with realistic conversational rhythm. Never put speaker labels inside the spoken text.
Include realistic distractors. The question and choices must be in French.
Return JSON ONLY with this exact shape:
{
  "title": "short French title",
  "audioType": "dialogue|monologue",
  "turns": [{"speaker":"woman|man|neutral","text":"exact French words to speak","pt":"natural European Portuguese translation of that turn"}],
  "script": "plain full transcript for fallback only",
  "scriptPt": "natural European Portuguese translation of the full spoken content",
  "question": "French question",
  "questionPt": "European Portuguese translation of the question",
  "choices": ["A", "B", "C", "D"],
  "choicesPt": ["European Portuguese translation of A","translation of B","translation of C","translation of D"],
  "answerIndex": 0,
  "difficulty": "${difficulty}",
  "skillTag": "detail|purpose|inference|number_time|attitude",
  "explanationPt": "brief explanation in European Portuguese",
  "vocab": [{"fr":"word or phrase","pt":"Portuguese meaning"}]
}
answerIndex must be an integer 0-3. Keep vocab to 2-4 useful items.`;
}

function speakingPrompt({ section = 'A', difficulty = 'B1' }) {
  const sectionRule = section === 'A'
    ? 'Section A: the candidate must obtain information by asking relevant questions for about 5 minutes. Create an advertisement/service/event scenario with enough details to explore, but do not give all answers upfront.'
    : 'Section B: the candidate must argue to convince another person for about 10 minutes. Create a realistic proposal/event/activity and a skeptical friend position that can be answered with reasons and examples.';
  return `Create ONE ORIGINAL TEF Canada-style oral expression practice task. Do not copy official or commercial test items.
Target level: ${difficulty}. ${sectionRule}
All exam task content must be in French. Interface help may be in European Portuguese.
Return JSON ONLY:
{
  "section": "${section}",
  "title": "short French title",
  "promptFr": "full task shown to candidate in French",
  "examinerRoleFr": "role/persona the AI examiner should play",
  "keyObjectives": ["objective 1", "objective 2", "objective 3"],
  "difficulty": "${difficulty}",
  "prepTipPt": "one concise preparation tip in European Portuguese"
}`;
}

function speakingDrillEvaluationPrompt(payload = {}) {
  const section = String(payload.section || 'A') === 'B' ? 'B' : 'A';
  const modelFr = String(payload.modelFr || '').trim();
  const learnerTranscript = String(payload.learnerTranscript || '').trim();
  const skillId = String(payload.skillId || '').trim();
  return `You are a patient but precise French speaking coach preparing a beginner for TEF Canada.
This is a MICRO-DRILL, not an official exam score. Evaluate only what can be inferred from the transcript; do not claim to assess pronunciation.
Section: ${section}
Skill: ${skillId}
Target model: ${modelFr}
Learner transcript: ${learnerTranscript}

Goal: decide whether the learner communicated the intended sentence/structure well enough to move on. Do NOT require an exact word-for-word match. Accept small article, agreement, accent, or spelling/transcription errors when meaning and target structure are clear. If the structure is materially wrong or meaning is unclear, require a retry.
Return JSON ONLY:
{
  "achieved": true,
  "score": 0,
  "feedbackPt": "short, concrete feedback in European Portuguese",
  "correctedFr": "the best corrected natural French sentence",
  "keyPointPt": "one exact thing to remember next time"
}
score must be 0-100. Use achieved=true only when score is at least 70. Keep feedback encouraging but factual and concise.`;
}

function speakingEvaluationPrompt(payload) {
  const { section, task, transcript, durationSeconds = 0 } = payload;
  return `You are an expert practice evaluator for TEF Canada - 2 Modules oral expression for Francophone Mobility. This is a TRAINING ESTIMATE, never an official TEF score.
Official task structure: Section A = obtain information; Section B = argue to convince. Evaluate the candidate from the supplied transcript and duration. Do NOT pretend to assess pronunciation from text alone.
Section: ${section}
Task: ${JSON.stringify(task)}
Duration seconds: ${durationSeconds}
Transcript:\n${transcript}\n
Assess these criteria 0-100: taskFulfillment, interactionStrategy, vocabulary, grammar, organizationFluency, comprehensibilityFromTranscript.
Then estimate readiness conservatively as one of: "BELOW_NCLC5", "NCLC5_RANGE", "NCLC6_RANGE", "NCLC7_PLUS_RANGE". This is only a practice readiness estimate, not a conversion to an official TEF score.
Return JSON ONLY:
{
  "criteria": {"taskFulfillment":0,"interactionStrategy":0,"vocabulary":0,"grammar":0,"organizationFluency":0,"comprehensibilityFromTranscript":0},
  "overall": 0,
  "readinessBand": "NCLC5_RANGE",
  "confidence": "low|medium|high",
  "pronunciationAssessed": false,
  "strengthsPt": ["..."],
  "prioritiesPt": ["..."],
  "corrections": [{"original":"...","better":"...","whyPt":"..."}],
  "modelAnswerFr": "a concise stronger example answer or interaction strategy in French",
  "nextDrillPt": "one exact next drill"
}
Use European Portuguese for feedback fields. Keep modelAnswerFr in French.`;
}

function coachPlanPrompt(progress) {
  return `You are the adaptive coach for a TEF Canada - 2 Modules learner preparing specifically for IRCC Francophone Mobility. The only current exam competencies in scope are Listening and Speaking. The IRCC minimum target is NCLC 5 in both, while the training target is NCLC 6 for safety margin. Do not assign Reading or Writing tasks.
Use the progress JSON below. Build a practical study plan for the NEXT 7 DAYS, 30-45 minutes per day. Prioritize weaknesses and spaced repetition. Do not claim guaranteed exam outcomes.
Progress: ${JSON.stringify(progress)}
Return JSON ONLY:
{
  "summaryPt": "...",
  "priority": "listening|speaking|balanced",
  "days": [{"day":1,"minutes":35,"tasks":["...","..."],"successRule":"..."}],
  "readinessMessagePt": "..."
}
Exactly 7 day objects. European Portuguese except exam-specific French drill phrases where useful.`;
}



function listeningBatchPrompt({ count = 10, startIndex = 1 }) {
  const safeCount = Math.max(1, Math.min(10, Number(count) || 10));
  return `You create ORIGINAL TEF Canada-style French listening practice. Do not reproduce, paraphrase, or imitate any confidential/copyrighted official test items.
Create ${safeCount} distinct items for a 40-question TRAINING mock, starting at mock position ${startIndex}.
Use realistic everyday French situations such as announcements, conversations, interviews, radio-style extracts, services, schedules, opinions and short reports. Mix A2/B1/B2 difficulty progressively and mix skills: detail, purpose, inference, number_time, attitude.
For every item choose "dialogue" or "monologue". A dialogue must contain exactly 2 distinct people — one woman and one man — in alternating short turns, 4-8 turns total, and must sound conversational rather than narrated. A monologue uses one neutral speaker. Never put speaker labels into spoken text.
Each item must contain 25-100 spoken words total, one question, four choices, exactly one correct answer. All task content in French. Explanations in European Portuguese.
Return JSON ONLY:
{
  "items": [
    {
      "title":"...",
      "audioType":"dialogue|monologue",
      "turns":[{"speaker":"woman|man|neutral","text":"...","pt":"European Portuguese translation"}],
      "script":"plain full transcript for fallback",
      "scriptPt":"European Portuguese translation of full spoken content",
      "question":"...",
      "questionPt":"European Portuguese translation of the question",
      "choices":["...","...","...","..."],
      "choicesPt":["...","...","...","..."],
      "answerIndex":0,
      "difficulty":"A2|B1|B2",
      "skillTag":"detail|purpose|inference|number_time|attitude",
      "explanationPt":"...",
      "vocab":[{"fr":"...","pt":"..."}]
    }
  ]
}
Return exactly ${safeCount} items.`;
}

function examinerTurnPrompt({ section = 'A', task = {}, history = [], candidateText = '' }) {
  const rule = section === 'A'
    ? 'You are the service/provider person in the role-play. Answer the candidate question naturally, briefly, and provide useful information. Do not take over the candidate role. Encourage follow-up only through natural answers.'
    : 'You are the skeptical friend/interlocutor. The candidate is trying to convince you. Raise one realistic objection or doubt at a time and react naturally to their arguments. Do not become easily convinced too early.';
  return `You are acting as the TEF Canada oral-expression TRAINING interlocutor. This is practice, not an official exam.
Section ${section}. ${rule}
Task: ${JSON.stringify(task)}
Conversation history: ${JSON.stringify(history)}
Candidate just said: ${candidateText}
Reply ONLY as the interlocutor in natural spoken French. 1-3 short sentences. No coaching, no scoring, no Portuguese.
Return JSON ONLY: {"replyFr":"...","intent":"answer|clarify|object|challenge|close"}`;
}

function multiRaterPrompt(payload, lens) {
  return `${speakingEvaluationPrompt(payload)}\nAdditional rater lens: ${lens}. Be independent and conservative. Return the exact same JSON shape.`;
}

function consensusPrompt(payload, ratings) {
  return `You are the consensus evaluator for a TEF Canada oral-expression TRAINING mock. This is not an official score conversion.
Section: ${payload.section}
Task: ${JSON.stringify(payload.task)}
Candidate transcript: ${payload.transcript}
Duration seconds: ${payload.durationSeconds || 0}
Independent ratings: ${JSON.stringify(ratings)}
Reconcile disagreements conservatively. Do not claim to assess pronunciation unless actual audio features were analyzed; here pronunciationAssessed must be false.
Return JSON ONLY with the same shape as the individual ratings:
{
  "criteria":{"taskFulfillment":0,"interactionStrategy":0,"vocabulary":0,"grammar":0,"organizationFluency":0,"comprehensibilityFromTranscript":0},
  "overall":0,
  "readinessBand":"BELOW_NCLC5|NCLC5_RANGE|NCLC6_RANGE|NCLC7_PLUS_RANGE",
  "confidence":"low|medium|high",
  "pronunciationAssessed":false,
  "strengthsPt":["..."],
  "prioritiesPt":["..."],
  "corrections":[{"original":"...","better":"...","whyPt":"..."}],
  "modelAnswerFr":"...",
  "nextDrillPt":"..."
}
European Portuguese for feedback fields; French for modelAnswerFr.`;
}

async function handleApi(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      aiConfigured: Boolean(OPENAI_API_KEY),
      routineModel: ROUTINE_MODEL,
      evaluationModel: EVALUATION_MODEL,
      transcribeModel: TRANSCRIBE_MODEL,
      ttsModel: TTS_MODEL,
    });
  }

  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });

  try {
    const body = await readJson(req);

    if (pathname === '/api/setup-key') {
      return sendJson(res, 409, { error: 'Na versão cloud, a API key é guardada como secret do servidor.' });
    }

    if (pathname === '/api/test-ai') {
      const text = await openAIResponse('Reply with exactly OK', ROUTINE_MODEL);
      return sendJson(res, 200, { ok: /OK/i.test(text), text: String(text || '').slice(0, 50) });
    }

    if (pathname === '/api/generate-listening') {
      const text = await openAIResponse(listeningPrompt(body), ROUTINE_MODEL);
      const item = extractJson(text);
      if (!Array.isArray(item.choices) || item.choices.length !== 4 || !Number.isInteger(item.answerIndex)) {
        throw new Error('Generated listening item failed validation');
      }
      return sendJson(res, 200, { item });
    }

    if (pathname === '/api/generate-listening-batch') {
      const text = await openAIResponse(listeningBatchPrompt(body), ROUTINE_MODEL);
      const parsed = extractJson(text);
      const items = Array.isArray(parsed.items) ? parsed.items : [];
      const requested = Math.max(1, Math.min(10, Number(body.count) || 10));
      if (items.length !== requested || items.some(item => !Array.isArray(item.choices) || item.choices.length !== 4 || !Number.isInteger(item.answerIndex))) {
        throw new Error('Generated listening batch failed validation');
      }
      return sendJson(res, 200, { items });
    }

    if (pathname === '/api/tts') {
      const text = String(body.text || '').trim();
      if (!text || text.length > 3500) throw new Error('Invalid TTS text');
      const requestedVoice = ALLOWED_TTS_VOICES.has(String(body.voice || '')) ? String(body.voice) : TTS_VOICE;
      const role = ['woman','man','neutral'].includes(String(body.role || '')) ? String(body.role) : 'neutral';
      const audioDataUrl = await textToSpeech(text, { voice: requestedVoice, role });
      return sendJson(res, 200, { audioDataUrl });
    }

    if (pathname === '/api/tts-listening') {
      const clips = await listeningToSpeech(body);
      return sendJson(res, 200, { clips });
    }

    if (pathname === '/api/generate-speaking') {
      const text = await openAIResponse(speakingPrompt(body), ROUTINE_MODEL);
      const task = extractJson(text);
      return sendJson(res, 200, { task });
    }

    if (pathname === '/api/evaluate-speaking-drill') {
      const learnerTranscript = String(body.learnerTranscript || '').trim();
      const modelFr = String(body.modelFr || '').trim();
      if (!learnerTranscript || !modelFr) throw new Error('Micro-drill requires model and learner transcript');
      const text = await openAIResponse(speakingDrillEvaluationPrompt(body), ROUTINE_MODEL);
      const evaluation = extractJson(text);
      evaluation.score = Math.max(0, Math.min(100, Number(evaluation.score) || 0));
      evaluation.achieved = Boolean(evaluation.achieved) && evaluation.score >= 70;
      if (!evaluation.correctedFr) evaluation.correctedFr = modelFr;
      return sendJson(res, 200, { evaluation });
    }

    if (pathname === '/api/examiner-turn') {
      const candidateText = String(body.candidateText || '').trim();
      if (!candidateText) throw new Error('Candidate turn is empty');
      const text = await openAIResponse(examinerTurnPrompt(body), ROUTINE_MODEL);
      const turn = extractJson(text);
      if (!turn.replyFr) throw new Error('Examiner returned no reply');
      return sendJson(res, 200, { turn });
    }

    if (pathname === '/api/transcribe') {
      const transcript = await transcribeAudio(body.audioDataUrl);
      return sendJson(res, 200, { transcript });
    }

    if (pathname === '/api/evaluate-speaking') {
      const transcript = String(body.transcript || '').trim();
      if (!transcript) throw new Error('Transcript is empty');
      const text = await openAIResponse(speakingEvaluationPrompt(body), EVALUATION_MODEL);
      const evaluation = extractJson(text);
      return sendJson(res, 200, { evaluation });
    }

    if (pathname === '/api/evaluate-speaking-multi') {
      const transcript = String(body.transcript || '').trim();
      if (!transcript) throw new Error('Transcript is empty');
      const [aText, bText] = await Promise.all([
        openAIResponse(multiRaterPrompt(body, 'Focus strongly on task fulfillment, interaction strategy and whether the candidate actually performs the role-play.'), EVALUATION_MODEL),
        openAIResponse(multiRaterPrompt(body, 'Focus strongly on linguistic control: vocabulary, grammar, organization, clarity and sustained interaction.'), EVALUATION_MODEL),
      ]);
      const ratings = [extractJson(aText), extractJson(bText)];
      const consensusText = await openAIResponse(consensusPrompt(body, ratings), EVALUATION_MODEL);
      const evaluation = extractJson(consensusText);
      return sendJson(res, 200, { evaluation, raters: ratings.map(r => ({ overall:r.overall, readinessBand:r.readinessBand, confidence:r.confidence })) });
    }

    if (pathname === '/api/coach-plan') {
      const text = await openAIResponse(coachPlanPrompt(body.progress || {}), EVALUATION_MODEL);
      const plan = extractJson(text);
      return sendJson(res, 200, { plan });
    }

    return sendJson(res, 404, { error: 'Unknown API route' });
  } catch (err) {
    const code = err?.message === 'OPENAI_API_KEY_NOT_CONFIGURED' ? 503 : 500;
    return sendJson(res, code, { error: err?.message || 'Server error' });
  }
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  try { rel = decodeURIComponent(rel); } catch {}
  const safe = path.normalize(rel).replace(/^([.][.][/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safe);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      const indexPath = path.join(PUBLIC_DIR, 'index.html');
      fs.readFile(indexPath, (e, data) => {
        if (e) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
}

export default async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (!url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found' });
  return handleApi(req, res, url.pathname);
}