import {
  createInitialProgress,
  formatIntervalLabel,
  getCardStatus,
  isCardDue,
  scheduleCard,
} from './sm2.js';
import {
  exportStateJSON,
  loadState,
  pullFromSupabase,
  pushToSupabase,
  recordReviewInStats,
  saveState,
} from './storage.js';

let state = loadState();
let currentTab = 'study'; // 'study' | 'library'
let activeDeck = 'all'; // 'all' | 'vocab' | 'phrase'
let directionMode = 'auto'; // 'auto' | 'word-first' | 'meaning-first'
let batchSize = 15; // 10 | 15 | 20 | 30 | 'all'
let sessionFilter = 'due'; // 'due' | 'new' | 'reviewed'

let sessionQueue = [];
let sessionTotal = 0;
let sessionDone = 0;
let currentCard = null;
let isRevealed = false;
let showHint = false;
let userTypedGuess = '';

let editingCardId = null;

// --- US English Text-to-Speech ---
let preferredVoice = null;

function loadVoices() {
  if (!('speechSynthesis' in window)) return;
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return;
  preferredVoice =
    voices.find((v) => v.lang === 'en-US' && /natural|google|samantha|alex|aria|jenny/i.test(v.name)) ||
    voices.find((v) => v.lang === 'en-US') ||
    voices.find((v) => v.lang.startsWith('en-')) ||
    voices[0];
}

if ('speechSynthesis' in window) {
  loadVoices();
  window.speechSynthesis.onvoiceschanged = loadVoices;
}

function speakText(text, btnEl = null) {
  if (!('speechSynthesis' in window)) {
    alert('Text-to-Speech is not supported in this browser.');
    return;
  }
  const cleanText = text.replace(/\bsth\b/g, 'something').replace(/\bsb\b/g, 'somebody').replace(/\.\.\./g, '');
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(cleanText);
  utter.lang = 'en-US';
  if (preferredVoice) utter.voice = preferredVoice;
  utter.rate = 0.94;

  if (btnEl) {
    btnEl.classList.add('speaking');
    utter.onend = () => btnEl.classList.remove('speaking');
    utter.onerror = () => btnEl.classList.remove('speaking');
  }
  window.speechSynthesis.speak(utter);
}

// --- Queue & Session Management ---
function buildQueue() {
  const now = Date.now();
  let filtered = state.cards.filter((c) => {
    if (activeDeck !== 'all' && c.type !== activeDeck) return false;
    const prog = state.progress[c.id];
    const isNew = !prog || !prog.lastReviewed;

    if (sessionFilter === 'new') return isNew;
    if (sessionFilter === 'reviewed') return !isNew;
    return isCardDue(prog, now);
  });

  if (sessionFilter === 'reviewed') {
    // Show oldest-reviewed or lowest-interval cards first
    filtered.sort((a, b) => {
      const pa = state.progress[a.id];
      const pb = state.progress[b.id];
      return (pa?.lastReviewed || 0) - (pb?.lastReviewed || 0);
    });
  } else {
    // Prioritize due learning cards first, then new cards
    filtered.sort((a, b) => {
      const pa = state.progress[a.id];
      const pb = state.progress[b.id];
      const aNew = !pa || !pa.lastReviewed;
      const bNew = !pb || !pb.lastReviewed;
      if (aNew !== bNew) return aNew ? 1 : -1;
      return (pa?.due || 0) - (pb?.due || 0);
    });
  }

  const limit = batchSize === 'all' ? filtered.length : Number(batchSize);
  sessionQueue = filtered.slice(0, limit);
  sessionTotal = sessionQueue.length;
  sessionDone = 0;
  loadNextCard();
}

function loadNextCard() {
  currentCard = sessionQueue.length > 0 ? sessionQueue[0] : null;
  isRevealed = false;
  showHint = false;
  userTypedGuess = '';
  render();
}

function getCardDirection(card) {
  if (directionMode === 'word-first') return 'word-first';
  if (directionMode === 'meaning-first') return 'meaning-first';
  const prog = state.progress[card.id];
  // First review (unseen or reps === 0): show word + pronunciation first
  if (!prog || prog.reps === 0) return 'word-first';
  // Subsequent reviews: show meaning first for active recall
  return 'meaning-first';
}

function handleRate(rating) {
  if (!currentCard || !isRevealed) return;
  const now = Date.now();
  const prev = state.progress[currentCard.id] || createInitialProgress();
  const next = scheduleCard(prev, rating, now);
  state.progress[currentCard.id] = next;

  recordReviewInStats(state);
  saveState(state);

  // Remove from front of queue
  const finishedCard = sessionQueue.shift();

  if (rating === 1) {
    // Re-queue "Again" card 3 positions later (or at end)
    const insertIdx = Math.min(3, sessionQueue.length);
    sessionQueue.splice(insertIdx, 0, finishedCard);
  } else {
    sessionDone += 1;
  }

  loadNextCard();
}

function practiceAllEarly() {
  const filtered = state.cards.filter((c) => activeDeck === 'all' || c.type === activeDeck);
  // Shuffle lightly
  const shuffled = [...filtered].sort(() => Math.random() - 0.5);
  sessionQueue = shuffled.slice(0, 25);
  sessionTotal = sessionQueue.length;
  sessionDone = 0;
  loadNextCard();
}

// --- Rendering ---
function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function makeHint(term) {
  return term
    .split(' ')
    .map((w) => (w.length <= 2 ? w : w[0] + '_'.repeat(Math.min(w.length - 1, 6))))
    .join(' ');
}

function computeStats() {
  const now = Date.now();
  let due = 0;
  let newCount = 0;
  let learning = 0;
  let mastered = 0;
  let vocabCount = 0;
  let phraseCount = 0;

  for (const c of state.cards) {
    if (c.type === 'vocab') vocabCount++;
    else phraseCount++;

    const p = state.progress[c.id];
    const status = getCardStatus(p);
    if (status === 'new') newCount++;
    else if (status === 'mastered') mastered++;
    else learning++;

    if (isCardDue(p, now)) due++;
  }

  return {
    total: state.cards.length,
    due,
    newCount,
    learning,
    mastered,
    vocabCount,
    phraseCount,
    reviewedToday: state.stats.reviewedToday || 0,
    streak: state.stats.streak || 0,
  };
}

function renderStats(stats) {
  document.getElementById('stats-strip').innerHTML = `
    <div class="stat-card">
      <div class="stat-label">Due Today</div>
      <div class="stat-value">${stats.due}</div>
      <div class="stat-sub">${stats.newCount} new · ${stats.learning} learning</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Reviewed Today</div>
      <div class="stat-value">${stats.reviewedToday}</div>
      <div class="stat-sub">Active recall</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Mastered</div>
      <div class="stat-value">${stats.mastered}</div>
      <div class="stat-sub">of ${stats.total} cards</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Streak</div>
      <div class="stat-value">${stats.streak}d</div>
      <div class="stat-sub">Daily habit</div>
    </div>
  `;
}

function renderStudyView(stats) {
  const dueAll = state.cards.filter((c) => isCardDue(state.progress[c.id])).length;
  const dueVocab = state.cards.filter((c) => c.type === 'vocab' && isCardDue(state.progress[c.id])).length;
  const duePhrase = state.cards.filter((c) => c.type === 'phrase' && isCardDue(state.progress[c.id])).length;

  const pct = sessionTotal > 0 ? Math.min(100, Math.round((sessionDone / sessionTotal) * 100)) : 100;

  const dueForDeck = state.cards.filter(
    (c) => (activeDeck === 'all' || c.type === activeDeck) && isCardDue(state.progress[c.id])
  ).length;
  const reviewedForDeck = state.cards.filter(
    (c) => (activeDeck === 'all' || c.type === activeDeck) && state.progress[c.id]?.lastReviewed
  ).length;
  const batchLabel = batchSize === 'all' ? 'All' : batchSize;

  let stageHtml = '';
  if (!currentCard) {
    const title =
      sessionTotal > 0
        ? `Batch complete! (${sessionDone} reviewed)`
        : sessionFilter === 'reviewed'
        ? 'No reviewed cards yet'
        : 'All caught up for now!';
    const subtitle =
      dueForDeck > 0
        ? `You still have ${dueForDeck} due/new cards waiting. Start another batch of ${batchLabel}, or review cards you already learned.`
        : 'You finished all due cards in this deck. You can review previously learned cards anytime or browse the library.';

    stageHtml = `
      <div class="empty-state">
        <h2>${title}</h2>
        <p>${subtitle}</p>
        <div class="empty-actions">
          ${
            dueForDeck > 0
              ? `<button class="icon-btn primary" id="btn-next-batch">Review Next ${batchLabel} Due/New</button>`
              : ''
          }
          ${
            reviewedForDeck > 0
              ? `<button class="icon-btn ${dueForDeck === 0 ? 'primary' : ''}" id="btn-review-learned">Review ${batchLabel} Already-Reviewed</button>`
              : ''
          }
          <button class="icon-btn" id="btn-go-library">Browse All ${stats.total} Cards</button>
        </div>
      </div>
    `;
  } else {
    const dir = getCardDirection(currentCard);
    const prog = state.progress[currentCard.id] || createInitialProgress();
    const isFirstReview = prog.reps === 0;
    const typeLabel = currentCard.type === 'vocab' ? 'Vocabulary / Collocation' : 'Phrase';
    const typeClass = currentCard.type === 'vocab' ? 'badge-vocab' : 'badge-phrase';
    const stageBadge = isFirstReview
      ? `<span class="badge badge-stage first-review">First Review · Learn</span>`
      : `<span class="badge badge-stage">Active Recall · Rep #${prog.reps + 1}</span>`;

    let frontHtml = '';
    let backHtml = '';

    if (dir === 'word-first') {
      frontHtml = `
        <div class="prompt-caption">New ${currentCard.type === 'vocab' ? 'Vocabulary' : 'Phrase'} — Read &amp; Pronounce</div>
        <h2 class="card-term">${escapeHtml(currentCard.term)}</h2>
        ${currentCard.pos ? `<div class="card-pos">${escapeHtml(currentCard.pos)}</div>` : ''}
        <div class="pronunciation-row">
          ${currentCard.ipa ? `<span class="ipa-text">${escapeHtml(currentCard.ipa)}</span>` : ''}
          <button class="speak-btn" id="btn-speak-card" type="button" title="Listen (US English)">
            <span>🔊</span> Listen (US)
          </button>
        </div>
      `;

      if (isRevealed) {
        backHtml = `
          <div class="card-answer-divider"></div>
          <div class="answer-block">
            <div>
              <div class="answer-row-label">B2 Simple Meaning</div>
              <div class="answer-meaning">${escapeHtml(currentCard.meaning)}</div>
            </div>
            ${
              currentCard.example
                ? `<div>
                    <div class="answer-row-label">Example</div>
                    <div class="answer-example">${escapeHtml(currentCard.example)}</div>
                   </div>`
                : ''
            }
          </div>
        `;
      }
    } else {
      // Meaning-first (Active Recall)
      frontHtml = `
        <div class="prompt-caption">Guess the ${currentCard.type === 'vocab' ? 'Word / Collocation' : 'Phrase'}</div>
        <p class="card-meaning-prompt">${escapeHtml(currentCard.meaning)}</p>
        ${currentCard.pos ? `<div class="card-pos">Type: ${escapeHtml(currentCard.pos)}</div>` : ''}
        ${
          !isRevealed
            ? `<div class="recall-tools">
                <input
                  type="text"
                  id="input-type-guess"
                  class="type-guess-input"
                  placeholder="Optional: type your guess..."
                  value="${escapeHtml(userTypedGuess)}"
                  autocomplete="off"
                />
                ${
                  showHint
                    ? `<div class="hint-text">Hint: ${escapeHtml(makeHint(currentCard.term))}</div>`
                    : `<button type="button" class="hint-btn" id="btn-show-hint">Show letter hint</button>`
                }
               </div>`
            : ''
        }
      `;

      if (isRevealed) {
        let guessFeedback = '';
        if (userTypedGuess.trim()) {
          const normGuess = userTypedGuess.trim().toLowerCase();
          const normTerm = currentCard.term.trim().toLowerCase();
          if (normGuess === normTerm) {
            guessFeedback = `<div class="guess-feedback correct">Exact match: "${escapeHtml(userTypedGuess)}"</div>`;
          } else {
            guessFeedback = `<div class="guess-feedback close">You typed: "${escapeHtml(userTypedGuess)}"</div>`;
          }
        }

        backHtml = `
          <div class="card-answer-divider"></div>
          <div class="answer-block">
            ${guessFeedback}
            <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px;">
              <div>
                <div class="answer-row-label">Answer</div>
                <div style="font-family:var(--font-serif); font-size:1.6rem; font-weight:600; line-height:1.2;">
                  ${escapeHtml(currentCard.term)}
                </div>
              </div>
              <div class="pronunciation-row">
                ${currentCard.ipa ? `<span class="ipa-text">${escapeHtml(currentCard.ipa)}</span>` : ''}
                <button class="speak-btn" id="btn-speak-card" type="button">
                  <span>🔊</span> Listen (US)
                </button>
              </div>
            </div>
            ${
              currentCard.example
                ? `<div>
                    <div class="answer-row-label">Example</div>
                    <div class="answer-example">${escapeHtml(currentCard.example)}</div>
                   </div>`
                : ''
            }
          </div>
        `;
      }
    }

    // Preview intervals for the 4 Anki buttons
    const i1 = formatIntervalLabel(scheduleCard(prog, 1).interval, 1);
    const i2 = formatIntervalLabel(scheduleCard(prog, 2).interval, 2);
    const i3 = formatIntervalLabel(scheduleCard(prog, 3).interval, 3);
    const i4 = formatIntervalLabel(scheduleCard(prog, 4).interval, 4);

    const actionsHtml = !isRevealed
      ? `<button class="reveal-btn" id="btn-reveal">Show Answer</button>`
      : `<div class="rating-grid">
          <button class="rate-btn rate-again" data-rate="1">
            <span class="rate-title">Again</span>
            <span class="rate-interval">${i1}</span>
          </button>
          <button class="rate-btn rate-hard" data-rate="2">
            <span class="rate-title">Hard</span>
            <span class="rate-interval">${i2}</span>
          </button>
          <button class="rate-btn rate-good" data-rate="3">
            <span class="rate-title">Good</span>
            <span class="rate-interval">${i3}</span>
          </button>
          <button class="rate-btn rate-easy" data-rate="4">
            <span class="rate-title">Easy</span>
            <span class="rate-interval">${i4}</span>
          </button>
        </div>`;

    stageHtml = `
      <div class="flashcard-stage">
        <div class="flashcard">
          <div class="card-top-row">
            <div class="badge-group">
              <span class="badge ${typeClass}">${typeLabel}</span>
              ${stageBadge}
            </div>
            <button class="mini-btn" id="btn-edit-current" title="Edit this card">Edit</button>
          </div>
          <div class="card-center">
            ${frontHtml}
            ${backHtml}
          </div>
        </div>
        <div class="card-actions">
          ${actionsHtml}
        </div>
        <div class="keyboard-hint">
          Shortcuts: <kbd>Space</kbd> Show Answer · <kbd>1</kbd>–<kbd>4</kbd> Rate · <kbd>R</kbd> Pronounce
        </div>
      </div>
    `;
  }

  return `
    <div class="study-toolbar">
      <div class="deck-pills">
        <button class="deck-pill ${activeDeck === 'all' ? 'active' : ''}" data-deck="all">
          All <span class="deck-count">(${dueAll})</span>
        </button>
        <button class="deck-pill ${activeDeck === 'vocab' ? 'active' : ''}" data-deck="vocab">
          Vocabularies &amp; Collocations <span class="deck-count">(${dueVocab})</span>
        </button>
        <button class="deck-pill ${activeDeck === 'phrase' ? 'active' : ''}" data-deck="phrase">
          Phrases <span class="deck-count">(${duePhrase})</span>
        </button>
      </div>
      <div class="mode-select-wrap" style="flex-wrap:wrap;">
        <label for="select-focus">Focus:</label>
        <select id="select-focus" class="mode-select">
          <option value="due" ${sessionFilter === 'due' ? 'selected' : ''}>Due &amp; New</option>
          <option value="new" ${sessionFilter === 'new' ? 'selected' : ''}>New Only</option>
          <option value="reviewed" ${sessionFilter === 'reviewed' ? 'selected' : ''}>Already Reviewed</option>
        </select>
        <label for="select-batch">Batch:</label>
        <select id="select-batch" class="mode-select">
          <option value="10" ${String(batchSize) === '10' ? 'selected' : ''}>10 cards</option>
          <option value="15" ${String(batchSize) === '15' ? 'selected' : ''}>15 cards</option>
          <option value="20" ${String(batchSize) === '20' ? 'selected' : ''}>20 cards</option>
          <option value="30" ${String(batchSize) === '30' ? 'selected' : ''}>30 cards</option>
          <option value="all" ${batchSize === 'all' ? 'selected' : ''}>All</option>
        </select>
        <label for="select-direction">Mode:</label>
        <select id="select-direction" class="mode-select">
          <option value="auto" ${directionMode === 'auto' ? 'selected' : ''}>Auto (Two-Stage)</option>
          <option value="meaning-first" ${directionMode === 'meaning-first' ? 'selected' : ''}>Meaning → Word</option>
          <option value="word-first" ${directionMode === 'word-first' ? 'selected' : ''}>Word → Meaning</option>
        </select>
      </div>
    </div>

    ${
      sessionTotal > 0
        ? `<div class="session-progress">
            <div class="progress-meta">
              <span>Session progress</span>
              <span>${sessionDone} / ${sessionTotal} completed (${sessionQueue.length} remaining)</span>
            </div>
            <div class="progress-track">
              <div class="progress-fill" style="width:${pct}%"></div>
            </div>
          </div>`
        : ''
    }

    ${stageHtml}
  `;
}

let libSearch = '';
let libTypeFilter = 'all';
let libStatusFilter = 'all';

function renderLibraryView() {
  const items = state.cards.filter((c) => {
    if (libTypeFilter !== 'all' && c.type !== libTypeFilter) return false;
    const status = getCardStatus(state.progress[c.id]);
    if (libStatusFilter !== 'all' && status !== libStatusFilter) return false;
    if (libSearch.trim()) {
      const q = libSearch.toLowerCase();
      return (
        c.term.toLowerCase().includes(q) ||
        c.meaning.toLowerCase().includes(q) ||
        (c.example || '').toLowerCase().includes(q)
      );
    }
    return true;
  });

  const rowsHtml = items.length
    ? items
        .map((c) => {
          const p = state.progress[c.id];
          const status = getCardStatus(p);
          const statusBadge =
            status === 'mastered'
              ? `<span class="badge" style="background:var(--good-soft);color:var(--good);">Mastered (${p.interval}d)</span>`
              : status === 'learning'
              ? `<span class="badge" style="background:var(--hard-soft);color:var(--hard);">Learning (${p.interval || '<1'}d)</span>`
              : `<span class="badge badge-stage">New</span>`;
          return `
            <div class="library-item">
              <div class="library-item-main">
                <div class="library-item-header">
                  <span class="library-term">${escapeHtml(c.term)}</span>
                  ${c.ipa ? `<span class="library-ipa">${escapeHtml(c.ipa)}</span>` : ''}
                  <span class="badge ${c.type === 'vocab' ? 'badge-vocab' : 'badge-phrase'}">
                    ${c.type === 'vocab' ? 'Vocab' : 'Phrase'}
                  </span>
                  ${statusBadge}
                </div>
                <div class="library-meaning">${escapeHtml(c.meaning)}</div>
                ${c.example ? `<div class="library-example">“${escapeHtml(c.example)}”</div>` : ''}
              </div>
              <div class="library-item-actions">
                <button class="mini-btn lib-speak" data-term="${escapeHtml(c.term)}" title="Pronounce">🔊</button>
                <button class="mini-btn lib-edit" data-id="${c.id}">Edit</button>
                <button class="mini-btn danger lib-delete" data-id="${c.id}">Delete</button>
              </div>
            </div>
          `;
        })
        .join('')
    : `<div class="empty-state"><h2>No matching cards</h2><p>Try clearing your search or filters, or add a new word.</p></div>`;

  return `
    <div class="library-controls">
      <input id="lib-search" class="search-input" type="text" placeholder="Search words, meanings, or examples..." value="${escapeHtml(libSearch)}" />
      <select id="lib-type" class="filter-select">
        <option value="all" ${libTypeFilter === 'all' ? 'selected' : ''}>All Types</option>
        <option value="vocab" ${libTypeFilter === 'vocab' ? 'selected' : ''}>Vocabularies</option>
        <option value="phrase" ${libTypeFilter === 'phrase' ? 'selected' : ''}>Phrases</option>
      </select>
      <select id="lib-status" class="filter-select">
        <option value="all" ${libStatusFilter === 'all' ? 'selected' : ''}>All Statuses</option>
        <option value="new" ${libStatusFilter === 'new' ? 'selected' : ''}>New</option>
        <option value="learning" ${libStatusFilter === 'learning' ? 'selected' : ''}>Learning</option>
        <option value="mastered" ${libStatusFilter === 'mastered' ? 'selected' : ''}>Mastered</option>
      </select>
    </div>
    <div style="font-size:0.82rem; color:var(--text-muted); margin-bottom:10px; font-weight:600;">
      Showing ${items.length} of ${state.cards.length} cards
    </div>
    <div class="library-list">
      ${rowsHtml}
    </div>
  `;
}

function render() {
  const stats = computeStats();
  renderStats(stats);

  document.querySelectorAll('.nav-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === currentTab);
  });

  const mainEl = document.getElementById('main-content');
  if (currentTab === 'study') {
    mainEl.innerHTML = renderStudyView(stats);
    bindStudyEvents();
  } else {
    mainEl.innerHTML = renderLibraryView();
    bindLibraryEvents();
  }
}

function bindStudyEvents() {
  document.querySelectorAll('.deck-pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeDeck = btn.dataset.deck;
      buildQueue();
    });
  });

  const focusSelect = document.getElementById('select-focus');
  if (focusSelect) {
    focusSelect.addEventListener('change', (e) => {
      sessionFilter = e.target.value;
      buildQueue();
    });
  }

  const batchSelect = document.getElementById('select-batch');
  if (batchSelect) {
    batchSelect.addEventListener('change', (e) => {
      batchSize = e.target.value === 'all' ? 'all' : Number(e.target.value);
      state.settings.batchSize = batchSize;
      saveState(state);
      buildQueue();
    });
  }

  const dirSelect = document.getElementById('select-direction');
  if (dirSelect) {
    dirSelect.addEventListener('change', (e) => {
      directionMode = e.target.value;
      render();
    });
  }

  const speakBtn = document.getElementById('btn-speak-card');
  if (speakBtn && currentCard) {
    speakBtn.addEventListener('click', () => speakText(currentCard.term, speakBtn));
  }

  const hintBtn = document.getElementById('btn-show-hint');
  if (hintBtn) {
    hintBtn.addEventListener('click', () => {
      showHint = true;
      render();
    });
  }

  const guessInput = document.getElementById('input-type-guess');
  if (guessInput) {
    guessInput.addEventListener('input', (e) => {
      userTypedGuess = e.target.value;
    });
    guessInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        isRevealed = true;
        render();
      }
    });
  }

  const revealBtn = document.getElementById('btn-reveal');
  if (revealBtn) {
    revealBtn.addEventListener('click', () => {
      isRevealed = true;
      render();
    });
  }

  document.querySelectorAll('.rate-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      handleRate(Number(btn.dataset.rate));
    });
  });

  const editCurrentBtn = document.getElementById('btn-edit-current');
  if (editCurrentBtn && currentCard) {
    editCurrentBtn.addEventListener('click', () => openCardModal(currentCard));
  }

  const nextBatchBtn = document.getElementById('btn-next-batch');
  if (nextBatchBtn) {
    nextBatchBtn.addEventListener('click', () => {
      sessionFilter = 'due';
      buildQueue();
    });
  }

  const reviewLearnedBtn = document.getElementById('btn-review-learned');
  if (reviewLearnedBtn) {
    reviewLearnedBtn.addEventListener('click', () => {
      sessionFilter = 'reviewed';
      buildQueue();
    });
  }

  const goLibBtn = document.getElementById('btn-go-library');
  if (goLibBtn) {
    goLibBtn.addEventListener('click', () => {
      currentTab = 'library';
      render();
    });
  }
}

function bindLibraryEvents() {
  const searchEl = document.getElementById('lib-search');
  if (searchEl) {
    searchEl.addEventListener('input', (e) => {
      const pos = e.target.selectionStart;
      libSearch = e.target.value;
      render();
      const restored = document.getElementById('lib-search');
      if (restored) {
        restored.focus();
        restored.setSelectionRange(pos, pos);
      }
    });
  }

  const typeEl = document.getElementById('lib-type');
  if (typeEl) {
    typeEl.addEventListener('change', (e) => {
      libTypeFilter = e.target.value;
      render();
    });
  }

  const statusEl = document.getElementById('lib-status');
  if (statusEl) {
    statusEl.addEventListener('change', (e) => {
      libStatusFilter = e.target.value;
      render();
    });
  }

  document.querySelectorAll('.lib-speak').forEach((btn) => {
    btn.addEventListener('click', () => speakText(btn.dataset.term, btn));
  });

  document.querySelectorAll('.lib-edit').forEach((btn) => {
    btn.addEventListener('click', () => {
      const card = state.cards.find((c) => c.id === btn.dataset.id);
      if (card) openCardModal(card);
    });
  });

  document.querySelectorAll('.lib-delete').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      const card = state.cards.find((c) => c.id === id);
      if (!card || !confirm(`Delete "${card.term}"?`)) return;
      state.cards = state.cards.filter((c) => c.id !== id);
      if (!state.deletedIds.includes(id)) state.deletedIds.push(id);
      delete state.progress[id];
      saveState(state);
      buildQueue();
    });
  });
}

// --- Add / Edit Card Modal ---
function openCardModal(card = null) {
  editingCardId = card ? card.id : null;
  document.getElementById('card-modal-title').textContent = card ? 'Edit Card' : 'Add Vocabulary or Phrase';
  document.getElementById('f-term').value = card ? card.term : '';
  document.getElementById('f-type').value = card ? card.type : 'vocab';
  document.getElementById('f-pos').value = card ? card.pos || '' : 'n. / v.';
  document.getElementById('f-ipa').value = card ? card.ipa || '' : '';
  document.getElementById('f-meaning').value = card ? card.meaning : '';
  document.getElementById('f-example').value = card ? card.example || '' : '';
  document.getElementById('bulk-section').classList.toggle('hidden', !!card);
  document.getElementById('card-modal').classList.remove('hidden');
}

function closeCardModal() {
  document.getElementById('card-modal').classList.add('hidden');
}

function handleSaveCard(e) {
  e.preventDefault();
  const term = document.getElementById('f-term').value.trim();
  const type = document.getElementById('f-type').value;
  const pos = document.getElementById('f-pos').value.trim();
  const ipa = document.getElementById('f-ipa').value.trim();
  const meaning = document.getElementById('f-meaning').value.trim();
  const example = document.getElementById('f-example').value.trim();

  if (!term || !meaning) return;

  if (editingCardId) {
    const idx = state.cards.findIndex((c) => c.id === editingCardId);
    if (idx !== -1) {
      state.cards[idx] = { ...state.cards[idx], term, type, pos, ipa, meaning, example };
    }
  } else {
    const id = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    state.cards.unshift({ id, term, type, pos, ipa, meaning, example });
    state.progress[id] = createInitialProgress();
  }

  saveState(state);
  closeCardModal();
  buildQueue();
}

function handleBulkImport() {
  const raw = document.getElementById('f-bulk').value.trim();
  if (!raw) return;
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  let added = 0;

  lines.forEach((line) => {
    const parts = line.split('|').map((s) => s.trim());
    if (parts.length < 2) return;
    const term = parts[0];
    const meaning = parts[1];
    const example = parts[2] || '';
    const type = parts[3] === 'phrase' || term.split(' ').length >= 3 ? 'phrase' : 'vocab';
    const ipa = parts[4] || '';
    const id = `bulk-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    state.cards.unshift({
      id,
      term,
      type,
      pos: type === 'phrase' ? 'phrase' : '',
      ipa,
      meaning,
      example,
    });
    state.progress[id] = createInitialProgress();
    added++;
  });

  if (added > 0) {
    saveState(state);
    document.getElementById('f-bulk').value = '';
    closeCardModal();
    buildQueue();
    alert(`Added ${added} new card(s)!`);
  }
}

// --- Sync & Backup Modal ---
function openSyncModal() {
  document.getElementById('s-url').value = state.settings.supabaseUrl || '';
  document.getElementById('s-key').value = state.settings.supabaseKey || '';
  document.getElementById('s-code').value = state.settings.syncCode || 'my-vocab-deck';
  document.getElementById('sync-status').textContent = 'Ready. Export JSON anytime or connect a free Supabase project.';
  document.getElementById('sync-modal').classList.remove('hidden');
}

function closeSyncModal() {
  document.getElementById('sync-modal').classList.add('hidden');
}

function saveSyncSettings() {
  state.settings.supabaseUrl = document.getElementById('s-url').value.trim();
  state.settings.supabaseKey = document.getElementById('s-key').value.trim();
  state.settings.syncCode = document.getElementById('s-code').value.trim() || 'my-vocab-deck';
  saveState(state);
}

// --- Global Listeners ---
document.querySelectorAll('.nav-tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    currentTab = btn.dataset.tab;
    render();
  });
});

document.getElementById('btn-open-add').addEventListener('click', () => openCardModal(null));
document.getElementById('btn-open-sync').addEventListener('click', openSyncModal);
document.getElementById('btn-close-card-modal').addEventListener('click', closeCardModal);
document.getElementById('btn-cancel-card').addEventListener('click', closeCardModal);
document.getElementById('card-form').addEventListener('submit', handleSaveCard);
document.getElementById('btn-bulk-import').addEventListener('click', handleBulkImport);

document.getElementById('btn-close-sync-modal').addEventListener('click', closeSyncModal);
document.getElementById('btn-export-json').addEventListener('click', () => exportStateJSON(state));

document.getElementById('input-import-json').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      if (!Array.isArray(parsed.cards)) throw new Error('Invalid backup file.');
      state = { ...state, ...parsed, settings: state.settings };
      saveState(state);
      buildQueue();
      document.getElementById('sync-status').textContent = `Imported ${state.cards.length} cards successfully!`;
    } catch (err) {
      document.getElementById('sync-status').textContent = `Import failed: ${err.message}`;
    }
  };
  reader.readAsText(file);
});

document.getElementById('btn-push-cloud').addEventListener('click', async () => {
  saveSyncSettings();
  const statusEl = document.getElementById('sync-status');
  statusEl.textContent = 'Pushing to Supabase...';
  try {
    await pushToSupabase(state);
    statusEl.textContent = 'Synced! Your cards & progress are saved in the cloud.';
  } catch (err) {
    statusEl.textContent = err.message;
  }
});

document.getElementById('btn-pull-cloud').addEventListener('click', async () => {
  saveSyncSettings();
  const statusEl = document.getElementById('sync-status');
  statusEl.textContent = 'Pulling from Supabase...';
  try {
    const remote = await pullFromSupabase(state);
    if (!remote) {
      statusEl.textContent = 'No remote backup found for this Sync Code yet.';
      return;
    }
    state.cards = remote.cards || state.cards;
    state.deletedIds = remote.deletedIds || state.deletedIds;
    state.progress = remote.progress || state.progress;
    state.stats = remote.stats || state.stats;
    saveState(state);
    buildQueue();
    statusEl.textContent = `Pulled ${state.cards.length} cards from cloud!`;
  } catch (err) {
    statusEl.textContent = err.message;
  }
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (currentTab !== 'study' || !currentCard) return;
  const activeTag = document.activeElement?.tagName;
  if (activeTag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'SELECT') return;
  if (!document.getElementById('card-modal').classList.contains('hidden')) return;
  if (!document.getElementById('sync-modal').classList.contains('hidden')) return;

  if (e.code === 'Space' && !isRevealed) {
    e.preventDefault();
    isRevealed = true;
    render();
  } else if (isRevealed && ['1', '2', '3', '4'].includes(e.key)) {
    handleRate(Number(e.key));
  } else if (e.key.toLowerCase() === 'r') {
    const dir = getCardDirection(currentCard);
    if (dir === 'word-first' || isRevealed) {
      speakText(currentCard.term, document.getElementById('btn-speak-card'));
    }
  }
});

// Initialize
buildQueue();
