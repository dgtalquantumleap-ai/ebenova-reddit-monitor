// Fallback templates for the onboarding wizard when:
//   - User picks "I'll set it up myself" (skip path)
//   - Anthropic API is down or returns invalid JSON twice
//
// 8 buckets cover the most common ICPs. Each has the same shape that
// /v1/onboarding/suggest returns, so the frontend handles them identically.

export const TEMPLATES = {
  freelancer: {
    label: '🎨 Freelance designer / developer',
    suggestedName: 'Freelance Client Leads',
    productContext: 'I\'m a freelance creative looking for client work.',
    keywords: [
      { keyword: 'looking for designer', intentType: 'buying', confidence: 'high' },
      { keyword: 'need a freelancer', intentType: 'buying', confidence: 'high' },
      { keyword: 'hire freelance developer', intentType: 'buying', confidence: 'high' },
      { keyword: 'scope creep', intentType: 'pain', confidence: 'high' },
      { keyword: 'client won\'t pay', intentType: 'pain', confidence: 'medium' },
      { keyword: 'unpaid invoice', intentType: 'pain', confidence: 'medium' },
      { keyword: 'fiverr vs upwork', intentType: 'comparison', confidence: 'medium' },
      { keyword: 'freelance contract template', intentType: 'question', confidence: 'low' },
    ],
    subreddits: ['freelance', 'forhire', 'graphic_design', 'webdev'],
    platforms: ['reddit', 'hackernews', 'quora'],
  },
  saas: {
    label: '💻 SaaS founder',
    suggestedName: 'SaaS Buying Intent',
    productContext: 'I run a SaaS product looking for new customers.',
    keywords: [
      { keyword: 'looking for software', intentType: 'buying', confidence: 'high' },
      { keyword: 'best tool for', intentType: 'buying', confidence: 'high' },
      { keyword: 'recommend SaaS', intentType: 'buying', confidence: 'medium' },
      { keyword: 'tool isn\'t working', intentType: 'pain', confidence: 'medium' },
      { keyword: 'looking for alternative', intentType: 'comparison', confidence: 'high' },
      { keyword: 'vs comparison', intentType: 'comparison', confidence: 'medium' },
      { keyword: 'how do I solve', intentType: 'question', confidence: 'low' },
      { keyword: 'open source alternative', intentType: 'comparison', confidence: 'medium' },
    ],
    subreddits: ['SaaS', 'startups', 'Entrepreneur', 'sideproject', 'IndieHackers'],
    platforms: ['reddit', 'hackernews', 'quora'],
  },
  agency: {
    label: '🏢 Agency owner',
    suggestedName: 'Agency Service Leads',
    productContext: 'I run an agency offering services to other businesses.',
    keywords: [
      { keyword: 'need an agency', intentType: 'buying', confidence: 'high' },
      { keyword: 'looking to hire agency', intentType: 'buying', confidence: 'high' },
      { keyword: 'agency didn\'t deliver', intentType: 'pain', confidence: 'high' },
      { keyword: 'in-house vs agency', intentType: 'comparison', confidence: 'high' },
      { keyword: 'agency vs freelancer', intentType: 'comparison', confidence: 'medium' },
      { keyword: 'agency recommendations', intentType: 'buying', confidence: 'medium' },
    ],
    subreddits: ['marketing', 'Entrepreneur', 'smallbusiness', 'startups'],
    platforms: ['reddit', 'quora'],
  },
  coach: {
    label: '🎯 Coach / consultant',
    suggestedName: 'Coaching Leads',
    productContext: 'I offer coaching or consulting services.',
    keywords: [
      { keyword: 'need a coach', intentType: 'buying', confidence: 'high' },
      { keyword: 'looking for mentor', intentType: 'buying', confidence: 'high' },
      { keyword: 'coaching recommendations', intentType: 'buying', confidence: 'medium' },
      { keyword: 'feeling stuck', intentType: 'pain', confidence: 'medium' },
      { keyword: 'coach vs therapist', intentType: 'comparison', confidence: 'low' },
      { keyword: 'how to find a coach', intentType: 'question', confidence: 'medium' },
    ],
    subreddits: ['Entrepreneur', 'getdisciplined', 'productivity', 'careerguidance'],
    platforms: ['reddit', 'quora'],
  },
  course: {
    label: '📚 Course creator',
    suggestedName: 'Course Buying Intent',
    productContext: 'I sell online courses or educational content.',
    keywords: [
      { keyword: 'best course for', intentType: 'buying', confidence: 'high' },
      { keyword: 'learn how to', intentType: 'question', confidence: 'medium' },
      { keyword: 'tutorial for beginners', intentType: 'question', confidence: 'medium' },
      { keyword: 'course recommendation', intentType: 'buying', confidence: 'high' },
      { keyword: 'udemy vs', intentType: 'comparison', confidence: 'medium' },
      { keyword: 'wasted money on course', intentType: 'pain', confidence: 'medium' },
    ],
    subreddits: ['learnprogramming', 'careerguidance', 'AskMarketing'],
    platforms: ['reddit', 'quora'],
  },
  ecommerce: {
    label: '🛒 Ecommerce / DTC brand',
    suggestedName: 'Ecommerce Buying Intent',
    productContext: 'I run an ecommerce store or DTC brand.',
    keywords: [
      { keyword: 'where to buy', intentType: 'buying', confidence: 'high' },
      { keyword: 'looking for', intentType: 'buying', confidence: 'medium' },
      { keyword: 'best brand for', intentType: 'buying', confidence: 'high' },
      { keyword: 'product recommendation', intentType: 'buying', confidence: 'high' },
      { keyword: 'is it worth', intentType: 'question', confidence: 'medium' },
    ],
    subreddits: ['BuyItForLife', 'shutupandtakemymoney', 'smallbusiness'],
    platforms: ['reddit', 'quora'],
  },
  local: {
    label: '📍 Local service business',
    suggestedName: 'Local Service Leads',
    productContext: 'I run a local services business.',
    keywords: [
      { keyword: 'looking for in [city]', intentType: 'buying', confidence: 'high' },
      { keyword: 'need recommendations near me', intentType: 'buying', confidence: 'high' },
      { keyword: 'best in town', intentType: 'buying', confidence: 'medium' },
      { keyword: 'local recommendations', intentType: 'buying', confidence: 'medium' },
    ],
    subreddits: ['smallbusiness', 'Entrepreneur'],
    platforms: ['reddit'],
  },
  other: {
    label: '+ Other / not sure',
    suggestedName: 'Generic Buying Intent',
    productContext: 'General buying-intent monitor.',
    keywords: [
      { keyword: 'looking for', intentType: 'buying', confidence: 'medium' },
      { keyword: 'recommend', intentType: 'buying', confidence: 'medium' },
      { keyword: 'best option for', intentType: 'buying', confidence: 'medium' },
      { keyword: 'alternative to', intentType: 'comparison', confidence: 'medium' },
    ],
    subreddits: ['Entrepreneur', 'smallbusiness', 'startups'],
    platforms: ['reddit'],
  },
}
