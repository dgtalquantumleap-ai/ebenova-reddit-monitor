// lib/keyword-presets.js — Vertical-keyword presets (Roadmap PR #33).
//
// "I run a hair salon — what should I monitor?" The honest answer
// most users need is a curated keyword set, not a 4-second AI suggestion run.
// PRESET_LIBRARY hardcodes 8 verticals, each a complete monitor blueprint
// (keywords + types + suggested platforms + relevant subreddits).
//
// The dashboard reads /v1/presets to populate a "Start from a preset" picker
// in the Find Customers flow; the user can edit anything before confirming.
// Subreddits are intentionally hidden from the list endpoint and only served
// from the per-id endpoint — they're a hint to the worker, not a UI element.

/**
 * @typedef {Object} PresetKeyword
 * @property {string} term  the keyword phrase
 * @property {'keyword' | 'competitor'} type
 *
 * @typedef {Object} Preset
 * @property {string}            id          stable slug
 * @property {string}            label       human display
 * @property {string}            emoji       single-glyph icon for the picker
 * @property {string}            description short tagline
 * @property {PresetKeyword[]}   keywords
 * @property {string[]}          platforms   ids from VALID_PLATFORMS
 * @property {string[]}          subreddits  Reddit subreddit hints
 * @property {'keyword'}         mode        always 'keyword' for now
 */

/** @type {Object.<string, Preset>} */
export const PRESET_LIBRARY = {
  freelancing: {
    id:          'freelancing',
    label:       'Freelancing & Contracts',
    emoji:       '💼',
    description: 'Contract disputes, scope creep, unpaid invoices — every freelancer pain point.',
    keywords: [
      { term: 'client refused to pay',       type: 'keyword'    },
      { term: 'no written contract',         type: 'keyword'    },
      { term: 'scope creep',                 type: 'competitor' },
      { term: 'unpaid invoice',              type: 'keyword'    },
      { term: 'verbal agreement',            type: 'keyword'    },
      { term: 'freelance contract',          type: 'keyword'    },
      { term: 'client added more work',      type: 'competitor' },
      { term: 'payment dispute',             type: 'keyword'    },
      { term: 'independent contractor agreement', type: 'keyword' },
      { term: 'need NDA',                    type: 'keyword'    },
    ],
    platforms:  ['reddit', 'hackernews', 'quora', 'upwork', 'fiverr'],
    subreddits: ['freelance', 'freelancers', 'Upwork', 'legaladvice', 'smallbusiness', 'Entrepreneur'],
    mode: 'keyword',
  },

  saas_founders: {
    id:          'saas_founders',
    label:       'SaaS & Indie Hackers',
    emoji:       '🚀',
    description: 'Founders shipping in public, asking for tools, comparing alternatives.',
    keywords: [
      { term: 'building in public',     type: 'keyword'    },
      { term: 'launched my SaaS',       type: 'keyword'    },
      { term: 'need a tool for',        type: 'keyword'    },
      { term: 'looking for software that', type: 'keyword' },
      { term: 'alternatives to',        type: 'competitor' },
      { term: 'is there an app that',   type: 'keyword'    },
      { term: 'my tech stack',          type: 'keyword'    },
      { term: 'API for',                type: 'keyword'    },
      { term: 'webhook integration',    type: 'keyword'    },
    ],
    platforms:  ['reddit', 'hackernews', 'producthunt', 'github', 'substack'],
    subreddits: ['SaaS', 'IndieHackers', 'startups', 'webdev', 'buildinpublic', 'SideProject'],
    mode: 'keyword',
  },

  real_estate: {
    id:          'real_estate',
    label:       'Real Estate',
    emoji:       '🏠',
    description: 'Buyers, renters, and investors asking for agents, listings, and advice.',
    keywords: [
      { term: 'looking for a realtor',          type: 'keyword' },
      { term: 'first time home buyer',          type: 'keyword' },
      { term: 'should I rent or buy',           type: 'keyword' },
      { term: 'recommend a real estate agent',  type: 'keyword' },
      { term: 'property investment advice',     type: 'keyword' },
      { term: 'looking to buy a house',         type: 'keyword' },
    ],
    platforms:  ['reddit', 'quora'],
    subreddits: ['RealEstate', 'FirstTimeHomeBuyer', 'realestateinvesting', 'Mortgages', 'personalfinance'],
    mode: 'keyword',
  },

  healthcare_wellness: {
    id:          'healthcare_wellness',
    label:       'Healthcare & Wellness',
    emoji:       '💆',
    description: 'Clinics, dermatologists, wellness centers — service-seekers asking for recs.',
    keywords: [
      { term: 'looking for a dermatologist',  type: 'keyword' },
      { term: 'recommend a therapist',        type: 'keyword' },
      { term: 'best skincare routine',        type: 'keyword' },
      { term: 'need a good clinic',           type: 'keyword' },
      { term: 'looking for a nutritionist',   type: 'keyword' },
      { term: 'wellness retreat recommendations', type: 'keyword' },
    ],
    platforms:  ['reddit', 'quora', 'substack'],
    subreddits: ['SkincareAddiction', 'AskDocs', 'Health', 'Supplements', 'NoStupidQuestions'],
    mode: 'keyword',
  },

  fashion_retail: {
    id:          'fashion_retail',
    label:       'Fashion & Retail',
    emoji:       '👗',
    description: 'Shoppers and resellers asking where to buy or who to source from.',
    keywords: [
      { term: 'where to buy affordable clothes', type: 'keyword' },
      { term: 'recommend a clothing brand',      type: 'keyword' },
      { term: 'best place to shop for',          type: 'keyword' },
      { term: 'wholesale clothing supplier',     type: 'keyword' },
      { term: 'sustainable fashion brands',      type: 'keyword' },
      { term: 'looking for an outfit for',       type: 'keyword' },
    ],
    platforms:  ['reddit', 'quora'],
    subreddits: ['femalefashionadvice', 'malefashionadvice', 'findfashion', 'streetwear', 'Frugalfemalefashion'],
    mode: 'keyword',
  },

  ai_developers: {
    id:          'ai_developers',
    label:       'AI & Developer Tools',
    emoji:       '🤖',
    description: 'Devs building on LLMs — MCP, agents, integrations, automation.',
    keywords: [
      { term: 'MCP server',              type: 'keyword' },
      { term: 'Claude Desktop tools',    type: 'keyword' },
      { term: 'AI agent tools',          type: 'keyword' },
      { term: 'model context protocol',  type: 'keyword' },
      { term: 'legal document API',      type: 'keyword' },
      { term: 'contract generation API', type: 'keyword' },
      { term: 'LLM integration',         type: 'keyword' },
      { term: 'AI workflow automation',  type: 'keyword' },
    ],
    platforms:  ['reddit', 'hackernews', 'github', 'substack'],
    subreddits: ['ClaudeAI', 'artificial', 'LocalLLaMA', 'LangChain', 'webdev', 'SaaS'],
    mode: 'keyword',
  },

  food_hospitality: {
    id:          'food_hospitality',
    label:       'Food & Delivery',
    emoji:       '🍱',
    description: 'Diners and event hosts asking for restaurants, caterers, and delivery.',
    keywords: [
      { term: 'restaurant recommendations',     type: 'keyword' },
      { term: 'best food delivery app',         type: 'keyword' },
      { term: 'looking for a caterer',          type: 'keyword' },
      { term: 'where should I eat',             type: 'keyword' },
      { term: 'meal prep service',              type: 'keyword' },
      { term: 'event catering recommendations', type: 'keyword' },
    ],
    platforms:  ['reddit', 'quora'],
    subreddits: ['food', 'AskCulinary', 'Cooking', 'mealprep', 'KitchenConfidential'],
    mode: 'keyword',
  },

  hair_beauty: {
    id:          'hair_beauty',
    label:       'Hair, Beauty & Grooming',
    emoji:       '✂️',
    description: 'Hair salons, vendors, wig retailers — discovery-driven category.',
    keywords: [
      { term: 'recommend a hair salon',     type: 'keyword' },
      { term: 'best hair products for',     type: 'keyword' },
      { term: 'looking for a barber',       type: 'keyword' },
      { term: 'natural hair routine',       type: 'keyword' },
      { term: 'where to buy wigs',          type: 'keyword' },
      { term: 'grooming product recommendations', type: 'keyword' },
    ],
    platforms:  ['reddit', 'quora'],
    subreddits: ['Naturalhair', 'curlyhair', 'HaircareScience', 'malegrooming', 'beauty'],
    mode: 'keyword',
  },
}

/**
 * Public-shape view of a preset (omits `subreddits` — that's a worker hint,
 * not a UI element). Used by GET /v1/presets list response.
 */
export function presetForList(preset) {
  if (!preset) return null
  const { subreddits: _omit, ...rest } = preset
  return rest
}

/**
 * @returns {Preset[]} all presets, list-shape (no subreddits)
 */
export function listPresets() {
  return Object.values(PRESET_LIBRARY).map(presetForList)
}

/**
 * @param {string} id
 * @returns {Preset | null} full preset (including subreddits) or null
 */
export function getPreset(id) {
  if (!id || typeof id !== 'string') return null
  return PRESET_LIBRARY[id] || null
}
