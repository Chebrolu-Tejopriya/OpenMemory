import { Intent } from './types.js';

/**
 * Keywords that indicate design inspiration content.
 */
const INSPIRATION_KEYWORDS = [
  'inspiration', 'inspired', 'ideas', 'design', 'ui', 'ux',
  'visual', 'layout', 'website', 'example', 'gallery', 'showcase',
  'portfolio', 'dribbble', 'behance', 'awwwards', 'beautiful',
  'aesthetic', 'creative', 'stunning', 'elegant', 'minimal',
  'dashboard', 'landing', 'homepage', 'interface', 'mockup'
];

/**
 * Keywords that indicate learning/tutorial content.
 */
const LEARNING_KEYWORDS = [
  'tutorial', 'guide', 'how to', 'learn', 'course', 'lesson',
  'explained', 'introduction', 'beginner', 'advanced', 'deep dive',
  'best practices', 'tips', 'tricks'
];

/**
 * Keywords that indicate developer/programming content (to penalize for inspiration queries).
 */
const DEV_KEYWORDS = [
  'node', 'nodejs', 'react', 'vue', 'angular', 'typescript',
  'javascript', 'python', 'backend', 'frontend', 'api', 'database',
  'performance', 'optimization', 'algorithm', 'programming',
  'code', 'coding', 'developer', 'engineering', 'devops'
];

/**
 * Keywords that indicate tooling content.
 */
const TOOLING_KEYWORDS = [
  'tool', 'plugin', 'extension', 'app', 'software', 'figma',
  'sketch', 'adobe', 'photoshop', 'illustrator', 'canva'
];

/**
 * Folder patterns that indicate design inspiration.
 */
const INSPIRATION_FOLDERS = [
  'inspiration', 'design', 'ui', 'ux', 'visual', 'creative',
  'ideas', 'reference', 'mood', 'style'
];

/**
 * Folder patterns that indicate developer content.
 */
const DEV_FOLDERS = [
  'dev', 'development', 'programming', 'code', 'backend',
  'frontend', 'engineering', 'tech'
];

function containsAny(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some(kw => lower.includes(kw.toLowerCase()));
}

/**
 * Classifies the intent of a bookmark based on title and folder.
 * Simple rule-based classification - no AI needed for MVP.
 */
export function classifyItemIntent(item: { title: string; folder: string | null }): Intent {
  const title = item.title.toLowerCase();
  const folder = (item.folder || '').toLowerCase();
  const combined = `${title} ${folder}`;

  // Check folder first (stronger signal)
  if (containsAny(folder, INSPIRATION_FOLDERS)) {
    return 'inspiration';
  }
  if (containsAny(folder, DEV_FOLDERS)) {
    return 'learning';
  }

  // Then check title
  if (containsAny(title, INSPIRATION_KEYWORDS)) {
    return 'inspiration';
  }
  if (containsAny(title, TOOLING_KEYWORDS)) {
    return 'tooling';
  }
  if (containsAny(title, LEARNING_KEYWORDS) || containsAny(title, DEV_KEYWORDS)) {
    return 'learning';
  }

  return 'reference';
}

/**
 * Infers user intent from a search query.
 */
export function inferQueryIntent(query: string): Intent {
  const lower = query.toLowerCase();

  if (containsAny(lower, INSPIRATION_KEYWORDS)) {
    return 'inspiration';
  }
  if (containsAny(lower, TOOLING_KEYWORDS)) {
    return 'tooling';
  }
  if (containsAny(lower, LEARNING_KEYWORDS) || containsAny(lower, DEV_KEYWORDS)) {
    return 'learning';
  }

  // Default to inspiration for this design-focused product
  return 'inspiration';
}

/**
 * Scoring adjustments for intent-aware ranking.
 */
export interface IntentScoreAdjustment {
  boost: number;    // Multiplier for matching intent
  penalize: number; // Multiplier for conflicting intent
}

/**
 * Calculates a score adjustment based on query intent and item properties.
 * Returns a multiplier to apply to the similarity score.
 */
export function calculateIntentScore(
  queryIntent: Intent,
  item: { title: string; folder: string | null; intent: string }
): number {
  const title = item.title.toLowerCase();
  const folder = (item.folder || '').toLowerCase();

  let multiplier = 1.0;

  if (queryIntent === 'inspiration') {
    // Boost design inspiration content
    if (item.intent === 'inspiration') {
      multiplier *= 1.5;
    }
    if (containsAny(folder, INSPIRATION_FOLDERS)) {
      multiplier *= 1.3;
    }
    if (containsAny(title, INSPIRATION_KEYWORDS)) {
      multiplier *= 1.2;
    }

    // Hard penalize dev content for inspiration queries
    if (containsAny(title, DEV_KEYWORDS)) {
      multiplier *= 0.2;
    }
    if (containsAny(folder, DEV_FOLDERS)) {
      multiplier *= 0.2;
    }
    if (item.intent === 'learning' && containsAny(title, DEV_KEYWORDS)) {
      multiplier *= 0.1;
    }
  }

  return multiplier;
}

/**
 * Determines if an item should be excluded based on query intent.
 * Hard filter - these items will NOT appear in results.
 */
export function shouldExclude(
  queryIntent: Intent,
  item: { title: string; folder: string | null; intent: string }
): boolean {
  const title = item.title.toLowerCase();
  const folder = (item.folder || '').toLowerCase();

  if (queryIntent === 'inspiration') {
    // Exclude pure dev tutorials from inspiration searches
    const isDevContent = containsAny(title, DEV_KEYWORDS) || containsAny(folder, DEV_FOLDERS);
    const hasNoDesignSignal = !containsAny(title, INSPIRATION_KEYWORDS) &&
                              !containsAny(folder, INSPIRATION_FOLDERS);

    if (isDevContent && hasNoDesignSignal) {
      return true;
    }
  }

  return false;
}
