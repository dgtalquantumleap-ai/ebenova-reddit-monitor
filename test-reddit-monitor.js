// test-reddit-monitor.js
// Manual test script for Reddit Monitor

import dotenv from 'dotenv'

dotenv.config()

// Test configuration
const TEST_KEYWORDS = [
  { keyword: 'legal document API', subreddits: ['webdev', 'SaaS'], product: 'Ebenova API' },
  { keyword: 'MCP server', subreddits: ['ClaudeAI', 'artificial'], product: 'Ebenova MCP' },
  { keyword: 'freelance contract', subreddits: ['freelance', 'freelancers'], product: 'Signova' },
]

const REDDIT_CONFIG = {
  clientId: process.env.REDDIT_CLIENT_ID,
  clientSecret: process.env.REDDIT_CLIENT_SECRET,
  userAgent: process.env.REDDIT_USER_AGENT || 'reddit-monitor-test/1.0',
}

async function testRedditSearch() {
  console.log('🔍 Starting Reddit Monitor Test...\n')
  console.log('Config:', {
    clientId: REDDIT_CONFIG.clientId ? '✅ Set' : '❌ Missing',
    clientSecret: REDDIT_CONFIG.clientSecret ? '✅ Set' : '❌ Missing',
    userAgent: REDDIT_CONFIG.userAgent,
  })
  console.log('')

  // Test each keyword
  for (const { keyword, subreddits, product } of TEST_KEYWORDS) {
    console.log(`\n📌 Testing: "${keyword}"`)
    console.log(`   Product: ${product}`)
    console.log(`   Subreddits: r/${subreddits.join(', r/')}`)

    try {
      // Search Reddit using public JSON endpoint (no auth required)
      const encodedKeyword = encodeURIComponent(keyword)
      const urls = subreddits.map(sr =>
        `https://www.reddit.com/r/${sr}/search.json?q=${encodedKeyword}&sort=new&limit=5&t=day&restrict_sr=1`
      )

      let allPosts = []
      for (const url of urls) {
        const res = await fetch(url, {
          headers: { 'User-Agent': 'reddit-monitor-test/1.0' }
        })
        if (res.ok) {
          const data = await res.json()
          const posts = data?.data?.children || []
          allPosts = allPosts.concat(posts.slice(0, 3))
        }
        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, 1500))
      }

      console.log(`   ✅ Found ${allPosts.length} posts`)

      if (allPosts.length > 0) {
        const topPost = allPosts[0].data
        console.log(`   Top post: "${topPost.title}"`)
        console.log(`   URL: https://reddit.com${topPost.permalink}`)
        console.log(`   Age: ${Math.floor((Date.now() - topPost.created_utc * 1000) / 3600000)} hours ago`)
      }
    } catch (error) {
      console.log(`   ❌ Error: ${error.message}`)
    }
  }

  console.log('\n✅ Test complete!\n')
}

// Run the test
testRedditSearch().catch(console.error)
