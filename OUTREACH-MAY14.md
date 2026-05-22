# Customer Outreach Drafts — 2026-05-14

Drafted after the May 14 keyword audit + engagement scan. Each section is
copy-paste ready. Sub in your signature line at the bottom.

---

## 1. TESTIMONIAL ASK — Joshua (ayenioladejijoshua@gmail.com)

**Why him:** Highest engagement user across all 10 monitors. 36 "Mark Posted"
on Idea Validation Tool (279 matches found, 13% post rate) + 10 on SmallBiz
Social Eavesdrop. He's the only user with sustained posting behavior — the
right candidate for a discovery-value testimonial.

**Note:** Engagement deltas (comments driven, score change) all came back
zero. So don't ask for a "drove revenue" quote — ask about discovery /
time saved / community fit. That's where the real value showed up for him.

**Subject line options:**
- A 3-sentence ask, if you can spare it
- Quick favour — would love your voice on the site

---

```
Hey Joshua,

Quick favour — you've been the most active user of Ebenova by a clear
margin (46 posts marked across Idea Validation Tool + SmallBiz Social
Eavesdrop, which is more than the rest of our cohort combined). I'd love
to put a 3-sentence quote from you on ebenova.dev so other founders see
that someone real is actually getting use out of this.

No pressure on length or polish — just a quick honest sentence on (a)
what you were trying to do before you tried Ebenova, (b) the kind of
posts/threads it's helped you find that you wouldn't have stumbled on
otherwise, and (c) anything you'd change. I'll send you the exact words
that go on the site before anything goes live.

Thanks in advance — and let me know if there's anything I can do to make
either monitor work harder for you.

— Olumide
```

---

## 2. HIRE ME monitor — DM to Clement (clementolawunmi@gmail.com)

**Backend done:** Replaced the single "Logistics" keyword with 10 pain-phrase
keywords (logistics software recommendation, supply chain management tool,
freight tracking solution, etc.). Worker will pick them up next cycle.

**Still needs from owner:** productContext is empty. Without it, AI drafts
can't be personalized — Clement's 3 matches have generated 0 drafts so far
because the relevance check has nothing to compare against.

---

```
Hey Clement,

Saw you set up the "Hire me" monitor on Ebenova — quick heads-up that I
noticed it was running on a single keyword ("Logistics") which is a bit
too broad to surface buying-intent posts (it was catching general
discussion + news instead of people actively looking for what you offer).

I went ahead and swapped it for 10 more specific keywords (things like
"looking for a logistics platform", "frustrated with logistics provider",
"warehouse management system" etc.) — you should start seeing better
matches within the next cycle or two.

One thing I can't fill in for you: the "product context" field is empty.
That's the short description of what you actually offer — Ebenova uses it
to generate reply drafts that sound like you and to filter out matches
that aren't a fit. If you can drop me a sentence or two about what you're
hiring yourself out for (logistics consulting? a SaaS? freelance ops
work?), I can either fill it in or coach you through the dashboard.

— Olumide
```

---

## 3. KEYWORD-AUDIT DMs (8 monitors, sorted by priority)

Each block is the AI's read on the current keyword set + the suggested
replacement. Pick the ones that resonate and send. The "Apply via" line
gives you the exact CLI command if the user says yes.

### 3a. Calgary Home Services SEO Monitor (silahubtechnologies@gmail.com)

**Status:** Active 17 days, 17,429 matches all-time (huge volume already).
Some keywords are very long-tail. AI suggests broader, higher-volume
local-SEO pain phrases.

```
Hey — your Calgary SEO monitor is running great (17K+ matches all-time
this month). I ran a quick audit and the AI suggested swapping a few of
the longer phrases ("why is my website not showing up in local search")
for shorter ones with bigger Reddit volume ("Google My Business not
ranking", "GMB insights dropped", "local pack not showing"). Want me to
swap them in?
```

**Apply via:**
```
node bin/apply-keywords.js mon_643d3bc2b5bebc6487ca43bf --replace \
  "Google My Business not ranking" "local search algorithm change" \
  "GMB insights dropped" "how to get more local leads" \
  "home service SEO tips" "Google Maps ranking help" \
  "local SEO for contractors" "affordable SEO for small business" \
  "Google Business Profile optimization" "local pack not showing" \
  "SEO for plumbers and electricians" "Calgary SEO services"
```

---

### 3b. Prembly inc (tolu.adetuyi@gmail.com)

**Status:** 10 days active, 103 matches all-time, 32 drafts (36% draft
rate — Tolu has the lowest draft rate of any active monitor). AI flags
the keywords as too brand-comparison heavy.

```
Hey Tolu — Prembly's Ebenova monitor has surfaced 103 matches over the
past 10 days but only 36% of them got AI drafts (the rest got filtered
as not-a-fit). I ran an audit and the AI suggests broader category
keywords ("identity verification solutions", "fraud prevention strategies",
"automating KYC processes") to catch more pre-purchase discussions, not
just direct Auth0/Okta complaints. Want me to swap them in?
```

**Apply via:**
```
node bin/apply-keywords.js mon_983515f519ae2143d4648ced --replace \
  "identity verification solutions" "fraud prevention strategies" \
  "compliance requirements for businesses" "user authentication best practices" \
  "preventing fake user accounts" "automating KYC processes" \
  "identity management for enterprises" "secure user onboarding" \
  "regulatory compliance for online platforms" "preventing online fraud"
```

---

### 3c. Idea Validation Tool (ayenioladejijoshua@gmail.com)

**Status:** Joshua's main monitor. 279 matches, 36 posted (your most-
engaged user). AI suggests dropping the long phrases in favor of high-
volume terms.

```
Hey Joshua — your Idea Validation monitor's been great (you've posted 36
of the 279 matches it surfaced, more than anyone else in the cohort).
The AI audit suggests broadening a few keywords — your current set has
some long phrases like "i don't want to waste months building something
nobody wants" which are vivid but get fewer Reddit hits than "idea
validation" or "market validation". Want me to swap in the shorter set?
```

**Apply via:**
```
node bin/apply-keywords.js mon_ba477ac8fa46267322d72cbf --replace \
  "idea validation" "market validation" "validate my startup idea" \
  "how to test demand for my product" "customer discovery" \
  "pre-launch validation" "build something nobody wants" \
  "test my business idea" "demand testing tool" \
  "product market fit survey" "lean startup validation" "MVP validation"
```

---

### 3d. SmallBiz Social Eavesdrop (ayenioladejijoshua@gmail.com)

**Status:** Joshua's diaspora corridor monitor (Lagos↔London). 35 matches,
10 posted. AI flags the 5 keywords as too generic for the corridor use case.

```
Hey Joshua — your diaspora corridor monitor's been finding 35 matches, but
the AI audit suggests adding more corridor-specific pain points (rent
collection from abroad, Naira devaluation, land title verification, UK→
Nigeria transfers). Right now the keywords are pretty generic which means
it catches general Nigerian property news too. Want me to swap them in?
```

**Apply via:**
```
node bin/apply-keywords.js mon_c00485c5b4f700face319199 --replace \
  "buying property in Lagos from abroad" "rent collection Nigeria" \
  "Naira devaluation property" "land title verification Nigeria" \
  "UK to Nigeria money transfer" "diaspora property investment Lagos" \
  "Lagos real estate agents" "Nigeria property scam" \
  "send money to Nigeria from UK" "Nigerian diaspora investing" \
  "property management Nigeria" "Lagos apartment purchase"
```

---

### 3e. Keytificate (daveylups@gmail.com)

**Status:** 2 days active, 0 matches. Keywords are well-crafted but very
narrow. AI suggests broader credential-verification terms.

```
Hey — your Keytificate monitor's been running 2 days with 0 matches so
far. The keywords are pretty specific (Credly/Accredible comparisons,
"fake certificates") which keeps noise low but also means the volume's
thin. The AI audit suggests broader terms like "how to verify digital
credentials", "prevent fake certificates", "credential fraud prevention".
Want me to swap them in?
```

**Apply via:**
```
node bin/apply-keywords.js mon_f57ce832f0c8485956c60a85 --replace \
  "how to verify digital credentials" "verify employee certifications" \
  "prevent fake certificates" "automated credential verification" \
  "issue verifiable certificates" "blockchain for certificate verification" \
  "verify event attendance badges" "scalable credential verification" \
  "digital badge verification solution" "credential fraud prevention" \
  "verify training completion" "open badge verification"
```

---

### 3f. Good and affordable Truck insurance service (otihrm@gmail.com)

**Status:** 9 days active, 0 matches despite 20 keywords. Issue is
platform mix (just reddit/hackernews/medium) + niche sub-industries.
AI suggests broader trucking-community phrases.

```
Hey — your truck insurance monitor's been running 9 days with 0 matches.
The keyword set is comprehensive but very specific to insurance product
sub-types (hotshot, dump, food truck). The AI audit suggests broader
trucking-community phrases like "starting a trucking company insurance",
"truck insurance horror stories", "should I become an owner operator" —
those tend to surface buying-intent threads in r/trucking and r/owneroperators.
Want me to swap them in? Also flagging: the product context is just "A
truck insurance service" — adding a sentence about what makes yours
different (regional? brokerage? digital-first?) would help the AI draft
better replies.
```

**Apply via:**
```
node bin/apply-keywords.js mon_3394b7985fab7a26aadb8eab --replace \
  "how to find affordable truck insurance" "truck insurance cost too high" \
  "truck insurance claim denied" "starting a trucking company insurance" \
  "owner operator insurance tips" "truck insurance for new drivers" \
  "truck insurance broker recommendations" "truck insurance horror stories" \
  "commercial truck insurance rates" "trucking startup costs" \
  "should I become an owner operator" "truck insurance for hotshot trucking"
```

---

### 3g. Academix Suite (davidaniago@gmail.com)

**Status:** 2 days active, 0 matches. Keywords lean too heavy on PowerSchool
comparisons. AI suggests broader admin-workflow phrases.

```
Hey — your Academix Suite monitor's been running 2 days with 0 matches.
The keywords focus on PowerSchool alternatives which is a fine niche but
low Reddit volume. The AI audit suggests broader phrases like "school
fee tracking software", "frustrated with school administrative tasks",
"affordable school admin software" that surface more pre-purchase
discussions. Want me to swap them in?
```

**Apply via:**
```
node bin/apply-keywords.js mon_790cd3f127a7e9455cb620cc --replace \
  "school fee tracking software" "student management system for small schools" \
  "how to automate fee collection" "attendance tracking tool for schools" \
  "school administration software recommendations" "frustrated with school administrative tasks" \
  "looking for school management platform" "affordable school admin software" \
  "student information system for private schools" "parent-teacher communication tool" \
  "school billing and invoicing solution" "replace manual fee tracking"
```

---

### 3h. Winnov8 (fjjdcreative@gmail.com)

**Status:** 1 day active, 0 matches. Keywords are good. AI suggests adding
side-project / portfolio terms to broaden surface area.

```
Hey — your Winnov8 monitor's been running 1 day with 0 matches. The
keyword set is well-crafted but a bit narrow on "technical co-founder".
The AI audit suggests adding broader collaboration terms like "looking
for a team to build my app", "need a developer for my side project",
"need help building my MVP" to catch more of the early-stage chatter
where co-founder matching actually happens. Want me to swap them in?
```

**Apply via:**
```
node bin/apply-keywords.js mon_dd25811e652740a62c2a15ac --replace \
  "looking for a team to build my app" "how to find a co-founder for my startup" \
  "need a developer for my side project" "where to find collaborators for open source" \
  "how to get experience as a junior developer" "looking for a project to work on" \
  "build a startup without a technical co-founder" "find a partner for my business idea" \
  "how to join a startup as a non-technical founder" "looking for a developer to partner with" \
  "need help building my MVP" "how to find a technical co-founder for free"
```

---

### 3i. Creative Hauz (info@creativehauz.space)

**Status:** 1 day active, 0 matches. Keywords are too long and brand-
comparison heavy (e.g. "amazon alexa too expensive for my clinic" — low
volume). AI suggests short pain-phrases.

```
Hey — your Creative Hauz monitor's been running 1 day with 0 matches.
The current keywords are very long and a few are brand comparisons that
get tiny Reddit volume ("amazon alexa too expensive for my clinic"). The
AI audit suggests shorter pain-phrase versions like "ai receptionist for
small business", "missed calls booking system", "automate phone calls
for clinic" that match how people actually phrase the problem. Want me
to swap them in?
```

**Apply via:**
```
node bin/apply-keywords.js mon_ec448769b5dbe0dc053b6a1e --replace \
  "ai receptionist for small business" "missed calls booking system" \
  "automate phone calls for clinic" "voice agent for restaurant reservations" \
  "ai answering service for HVAC" "how to handle after hours calls" \
  "frustrated with phone tag" "ai phone assistant for scheduling" \
  "automated call handling for service business" "receptionist software for small business" \
  "voice ai for appointment booking" "phone automation for field service"
```

---

## Priority order if you only send 3 today

1. **Joshua — testimonial ask** (highest ROI, only takes him 3 sentences)
2. **Clement — HIRE ME productContext follow-up** (closes the activation loop)
3. **Tolu (Prembly)** or **Calgary SEO** — both have real match volume and
   the keyword swap could measurably move their numbers
