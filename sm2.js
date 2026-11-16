// Anki-style SM-2 Spaced Repetition Engine

const DAY_MS = 24 * 60 * 60 * 1000;

export function createInitialProgress() {
  return {
    reps: 0,
    interval: 0, // in days
    ease: 2.5,
    lapses: 0,
    due: 0, // timestamp ms (0 = new / immediately due)
    lastReviewed: null,
  };
}

/**
 * Compute next SM-2 state for rating:
 * 1 = Again, 2 = Hard, 3 = Good, 4 = Easy
 */
export function scheduleCard(progress, rating, now = Date.now()) {
  const p = { ...createInitialProgress(), ...(progress || {}) };

  if (rating === 1) {
    // Again: reset repetition count, repeat in ~1 minute
    p.reps = 0;
    p.interval = 0;
    p.lapses += 1;
    p.ease = Math.max(1.3, +(p.ease - 0.2).toFixed(2));
    p.due = now + 60 * 1000;
    p.lastReviewed = now;
    return p;
  }

  if (rating === 2) {
    // Hard
    if (p.reps === 0) {
      p.interval = 0.5; // 12 hours
      p.reps = 1;
    } else {
      p.interval = Math.max(1, Math.round(p.interval * 1.2));
      p.reps += 1;
    }
    p.ease = Math.max(1.3, +(p.ease - 0.15).toFixed(2));
  } else if (rating === 3) {
    // Good
    if (p.reps === 0) {
      p.interval = 1;
    } else if (p.reps === 1) {
      p.interval = 6;
    } else {
      p.interval = Math.max(1, Math.round(p.interval * p.ease));
    }
    p.reps += 1;
  } else if (rating === 4) {
    // Easy
    if (p.reps === 0) {
      p.interval = 4;
    } else if (p.reps === 1) {
      p.interval = 8;
    } else {
      p.interval = Math.max(4, Math.round(p.interval * p.ease * 1.3));
    }
    p.ease = +(p.ease + 0.15).toFixed(2);
    p.reps += 1;
  }

  p.due = now + p.interval * DAY_MS;
  p.lastReviewed = now;
  return p;
}

export function formatIntervalLabel(days, rating) {
  if (rating === 1) return '< 1 min';
  if (days < 1) {
    const hrs = Math.max(1, Math.round(days * 24));
    return `${hrs} hr${hrs === 1 ? '' : 's'}`;
  }
  if (days < 30) {
    const d = Math.round(days);
    return `${d} day${d === 1 ? '' : 's'}`;
  }
  if (days < 365) {
    const mo = +(days / 30).toFixed(1);
    return `${mo} mo`;
  }
  const yr = +(days / 365).toFixed(1);
  return `${yr} yr`;
}

export function getCardStatus(progress) {
  if (!progress || progress.reps === 0 && !progress.lastReviewed) {
    return 'new';
  }
  if (progress.interval >= 21) {
    return 'mastered';
  }
  return 'learning';
}

export function isCardDue(progress, now = Date.now()) {
  if (!progress || !progress.lastReviewed) return true;
  return progress.due <= now;
}
