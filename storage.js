import { INITIAL_CARDS } from './data.js';
import { createInitialProgress } from './sm2.js';

const STORAGE_KEY = 'lexiflow_anki_v1';

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function loadState() {
  let saved = null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) saved = JSON.parse(raw);
  } catch (e) {
    console.warn('Failed to parse local storage:', e);
  }

  const today = todayStr();
  const baseState = {
    cards: [],
    deletedIds: [],
    progress: {},
    stats: {
      streak: 0,
      lastStudyDate: null,
      reviewedToday: 0,
      todayDate: today,
    },
    settings: {
      supabaseUrl: '',
      supabaseKey: '',
      syncCode: 'my-vocab-deck',
    },
    updatedAt: Date.now(),
  };

  if (!saved) {
    baseState.cards = INITIAL_CARDS.map((c) => ({ ...c }));
    INITIAL_CARDS.forEach((c) => {
      baseState.progress[c.id] = createInitialProgress();
    });
    saveState(baseState);
    return baseState;
  }

  // Merge: preserve user edits, custom cards, and progress while adding any new INITIAL_CARDS
  const deletedSet = new Set(saved.deletedIds || []);
  const existingMap = new Map((saved.cards || []).map((c) => [c.id, c]));

  INITIAL_CARDS.forEach((initCard) => {
    if (!existingMap.has(initCard.id) && !deletedSet.has(initCard.id)) {
      existingMap.set(initCard.id, { ...initCard });
    }
  });

  const mergedCards = Array.from(existingMap.values());
  const progress = { ...(saved.progress || {}) };
  mergedCards.forEach((c) => {
    if (!progress[c.id]) {
      progress[c.id] = createInitialProgress();
    }
  });

  const stats = { ...baseState.stats, ...(saved.stats || {}) };
  if (stats.todayDate !== today) {
    stats.todayDate = today;
    stats.reviewedToday = 0;
  }

  return {
    cards: mergedCards,
    deletedIds: Array.from(deletedSet),
    progress,
    stats,
    settings: { ...baseState.settings, ...(saved.settings || {}) },
    updatedAt: saved.updatedAt || Date.now(),
  };
}

export function saveState(state) {
  state.updatedAt = Date.now();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.error('Failed to save state:', e);
  }
}

export function recordReviewInStats(state) {
  const today = todayStr();
  if (state.stats.todayDate !== today) {
    state.stats.todayDate = today;
    state.stats.reviewedToday = 0;
  }
  state.stats.reviewedToday += 1;

  if (state.stats.lastStudyDate !== today) {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
    if (state.stats.lastStudyDate === yStr) {
      state.stats.streak += 1;
    } else {
      state.stats.streak = 1;
    }
    state.stats.lastStudyDate = today;
  }
}

export function exportStateJSON(state) {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `vocab-flashcards-backup-${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export async function pushToSupabase(state) {
  const { supabaseUrl, supabaseKey, syncCode } = state.settings || {};
  if (!supabaseUrl || !supabaseKey || !syncCode) {
    throw new Error('Missing Supabase URL, Anon Key, or Sync Code.');
  }
  const cleanUrl = supabaseUrl.replace(/\/+$/, '');
  const res = await fetch(`${cleanUrl}/rest/v1/vocab_sync`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify({
      sync_id: syncCode,
      payload: {
        cards: state.cards,
        deletedIds: state.deletedIds,
        progress: state.progress,
        stats: state.stats,
        updatedAt: state.updatedAt,
      },
      updated_at: new Date().toISOString(),
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase push failed (${res.status}): ${text}`);
  }
  return true;
}

export async function pullFromSupabase(state) {
  const { supabaseUrl, supabaseKey, syncCode } = state.settings || {};
  if (!supabaseUrl || !supabaseKey || !syncCode) {
    throw new Error('Missing Supabase URL, Anon Key, or Sync Code.');
  }
  const cleanUrl = supabaseUrl.replace(/\/+$/, '');
  const res = await fetch(
    `${cleanUrl}/rest/v1/vocab_sync?sync_id=eq.${encodeURIComponent(syncCode)}&select=payload,updated_at`,
    {
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
      },
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase pull failed (${res.status}): ${text}`);
  }
  const rows = await res.json();
  if (!rows.length || !rows[0].payload) {
    return null;
  }
  return rows[0].payload;
}
