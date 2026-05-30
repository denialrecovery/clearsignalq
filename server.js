const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json({ limit: '2mb' }));

// ── DATABASE ──────────────────────────────────────────────────────────────────
let pool = null;

async function initDB() {
  if (!process.env.DATABASE_URL) { console.log('No DATABASE_URL'); return; }
  try {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false, connectionTimeoutMillis: 5000 });
    await pool.query('SELECT 1');
    await pool.query(`CREATE TABLE IF NOT EXISTS contacts (
      id SERIAL PRIMARY KEY, name VARCHAR(200), title VARCHAR(200),
      company VARCHAR(200), email VARCHAR(200), phone VARCHAR(50),
      location VARCHAR(200), linkedin VARCHAR(300), website VARCHAR(200),
      source VARCHAR(50), org_type VARCHAR(50), deal_type VARCHAR(20),
      notes TEXT, score INTEGER DEFAULT 80, added_at TIMESTAMP DEFAULT NOW()
    )`);
    try {
      await pool.query(`DELETE FROM contacts a USING contacts b WHERE a.id < b.id AND a.email = b.email AND a.email != ''`);
      await pool.query(`DELETE FROM contacts WHERE email IS NULL OR email = ''`);
      await pool.query(`ALTER TABLE contacts ADD CONSTRAINT contacts_email_unique UNIQUE (email)`);
      console.log('Unique email constraint added successfully');
    } catch(constraintErr) { console.log('Email constraint already exists or skipped:', constraintErr.message); }
    console.log('Database connected');
  } catch (err) { console.log('DB unavailable:', err.message); pool = null; }
}

// ── NEWS SOURCE REGISTRY ──────────────────────────────────────────────────────
const NEWS_SOURCES = [
  // RSS Feeds
  { name: 'Fierce Healthcare', url: 'https://www.fiercehealthcare.com/rss/xml', type: 'rss', category: 'news' },
  { name: 'Modern Healthcare', url: 'https://www.modernhealthcare.com/section/rss', type: 'rss', category: 'news' },
  { name: 'Health Affairs', url: 'https://www.healthaffairs.org/rss/site_3/1.xml', type: 'rss', category: 'policy' },
  { name: 'Beckers Hospital Review', url: 'https://www.beckershospitalreview.com/rss.xml', type: 'rss', category: 'news' },
  { name: 'Healthcare IT News', url: 'https://www.healthcareitnews.com/rss.xml', type: 'rss', category: 'health-it' },
  { name: 'HHS.gov News', url: 'https://www.hhs.gov/rss/news.xml', type: 'rss', category: 'regulatory' },
  { name: 'CMS.gov', url: 'https://www.cms.gov/newsroom/rss.xml', type: 'rss', category: 'regulatory' },
  { name: 'PR Newswire Healthcare', url: 'https://www.prnewswire.com/rss/news-releases-list.rss', type: 'rss', category: 'press' },
  { name: 'Business Wire Health', url: 'https://feed.businesswire.com/rss/home/?rss=G22', type: 'rss', category: 'press' },
  // Google News RSS
  { name: 'Google News: EHR Migration', url: 'https://news.google.com/rss/search?q=EHR+migration+healthcare+2025&hl=en-US&gl=US&ceid=US:en', type: 'google', category: 'ehr' },
  { name: 'Google News: MSO Acquisition', url: 'https://news.google.com/rss/search?q=MSO+acquisition+healthcare&hl=en-US&gl=US&ceid=US:en', type: 'google', category: 'mso' },
  { name: 'Google News: Prior Auth Denials', url: 'https://news.google.com/rss/search?q=prior+authorization+denial+Medicare+Advantage&hl=en-US&gl=US&ceid=US:en', type: 'google', category: 'denials' },
  { name: 'Google News: Health System Merger', url: 'https://news.google.com/rss/search?q=health+system+merger+acquisition+2025&hl=en-US&gl=US&ceid=US:en', type: 'google', category: 'mergers' },
  { name: 'Google News: Revenue Cycle', url: 'https://news.google.com/rss/search?q=revenue+cycle+management+healthcare&hl=en-US&gl=US&ceid=US:en', type: 'google', category: 'rcm' },
  { name: 'Google News: HIPAA Compliance', url: 'https://news.google.com/rss/search?q=HIPAA+compliance+healthcare+2025&hl=en-US&gl=US&ceid=US:en', type: 'google', category: 'compliance' },
  // SEC EDGAR - healthcare company filings
  { name: 'SEC EDGAR Healthcare', url: 'https://efts.sec.gov/LATEST/search-index?q=%22health+information%22+%22EHR%22&dateRange=custom&startdt=2025-01-01&forms=8-K&_source=efts', type: 'sec', category: 'regulatory' },
  // Company website monitoring
  { name: 'Epic Systems News', url: 'https://www.epic.com/about/news', type: 'web', category: 'ehr' },
  { name: 'Oracle Health News', url: 'https://www.oracle.com/health/news/', type: 'web', category: 'ehr' },
  { name: 'HCA Healthcare Newsroom', url: 'https://hcahealthcare.com/about/news-and-media/', type: 'web', category: 'health-system' },
  { name: 'CMS Innovation Center', url: 'https://innovation.cms.gov/news', type: 'web', category: 'regulatory' },
  { name: 'Availity News', url: 'https://www.availity.com/news/', type: 'web', category: 'clearinghouse' },
];

// Track which source index we're on for rotation
let sourceRotation = 0;

// ── LIVE RSS/WEB SCAN ─────────────────────────────────────────────────────────
app.post('/api/scan-sources', async (req, res) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'No API key' });

    // Pick 3 sources per scan in rotation
    const batch = [];
    for (let i = 0; i < 3; i++) {
      batch.push(NEWS_SOURCES[sourceRotation % NEWS_SOURCES.length]);
      sourceRotation++;
    }

    const sourceList = batch.map(s => `- ${s.name} (${s.category}): ${s.url}`).join('\n');

    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'web-search-2025-03-05'
    };

    const body = {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{
        role: 'user',
        content: `Search these healthcare news sources for signals relevant to: ROI/Release of Information partnerships, EHR migrations, MSO acquisitions, prior auth denials, revenue cycle changes, HIPAA compliance:\n\n${sourceList}\n\nSearch each source URL and return ONLY a valid JSON array of 3-6 signals found:\n[{"type":"news","org":"org name","headline":"specific finding","signal":"why this matters for ROI/denial/records exchange sales","urgency":"high|medium|low","contact":"decision-maker title","location":"city, state","tags":["tag1","tag2"],"source":"source name","receivedAt":"${new Date().toLocaleTimeString()}"}]\nOnly return the JSON array starting with [ and ending with ].`
      }]
    };

    const response = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers, body: JSON.stringify(body) });
    const data = await response.json();
    res.json({ ...data, sourcesScanned: batch.map(s => s.name) });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ── COMPANY WEBSITE MONITOR ───────────────────────────────────────────────────
const MONITORED_SITES = [
  { name: 'Epic Systems', url: 'https://www.epic.com/about/news', signal: 'EHR vendor news' },
  { name: 'Oracle Health', url: 'https://www.oracle.com/health/news/', signal: 'EHR competition' },
  { name: 'HCA Healthcare', url: 'https://hcahealthcare.com/about/news-and-media/', signal: 'Large health system' },
  { name: 'Oasis Health Partners', url: 'https://www.oasishealthpartners.com/news', signal: 'Key MSO target' },
  { name: 'Availity', url: 'https://www.availity.com/news/', signal: 'Key clearinghouse target' },
  { name: 'Waystar', url: 'https://waystar.com/newsroom/', signal: 'RCM competitor' },
  { name: 'CommonSpirit Health', url: 'https://www.commonspirit.org/newsroom', signal: 'Health system contract expiring' },
  { name: 'Ascension Health', url: 'https://healthcare.ascension.org/news', signal: 'Health system target' },
  { name: 'Elevance Health', url: 'https://ir.elevancehealth.com/news-releases', signal: 'Major payer' },
  { name: 'Privia Health', url: 'https://priviahealth.com/press-releases/', signal: 'MSO target' },
  { name: 'R1 RCM', url: 'https://r1rcm.com/news/', signal: 'RCM channel partner' },
  { name: 'Centene Corporation', url: 'https://ir.centene.com/news-releases', signal: 'Major payer - MA denials' },
];

app.post('/api/monitor-sites', async (req, res) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'No API key' });

    const { sites } = req.body;
    const targetSites = sites ? MONITORED_SITES.filter(s => sites.includes(s.name)) : MONITORED_SITES.slice(0, 4);

    const siteList = targetSites.map(s => `- ${s.name}: ${s.url} (Signal context: ${s.signal})`).join('\n');

    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'web-search-2025-03-05'
    };

    const body = {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1200,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{
        role: 'user',
        content: `Visit each of these company websites and find their most recent news, press releases, or announcements that signal buying opportunities for: ROI/Release of Information, denial recovery, or medical records exchange:\n\n${siteList}\n\nReturn ONLY a valid JSON array:\n[{"type":"news","org":"company name","headline":"recent news headline or announcement","signal":"specific sales opportunity this creates","urgency":"high|medium|low","contact":"best decision-maker title to contact","tags":["relevant","tags"],"source":"site name","url":"${targetSites[0]?.url || ''}","receivedAt":"${new Date().toLocaleTimeString()}"}]\nOnly return JSON array.`
      }]
    };

    const response = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers, body: JSON.stringify(body) });
    const data = await response.json();
    res.json({ ...data, sitesMonitored: targetSites.map(s => s.name) });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ── SOURCE REGISTRY ENDPOINT ──────────────────────────────────────────────────
app.get('/api/sources', (req, res) => {
  res.json({
    newsSources: NEWS_SOURCES,
    monitoredSites: MONITORED_SITES,
    totalSources: NEWS_SOURCES.length + MONITORED_SITES.length,
    sourceRotation
  });
});

// ── 200+ HEALTHCARE COMPANY DATABASE ─────────────────────────────────────────
const ALL_TARGETS = {
  clearinghouses: ['Availity','Change Healthcare','Waystar','Trizetto','Cotiviti','Inovalon','Ciox Health','MRO Corp','Datavant','Veradigm','Surescripts','Experian Health','Emdeon'],
  msos: ['Privia Health Group','Agilon Health','Aledade','Evolent Health','Oasis Health Partners','Oak Street Health','ChenMed','VillageMD','Landmark Health','Envision Healthcare','TeamHealth','US Acute Care Solutions','Optum Care','DaVita Medical Group','American Medical Group'],
  healthSystems: ['HCA Healthcare','CommonSpirit Health','Ascension Health','Advocate Aurora Health','Mayo Clinic','Cleveland Clinic','Johns Hopkins Medicine','UPMC','Intermountain Healthcare','Providence Health','Banner Health','Atrium Health','Northwell Health','Mass General Brigham','NYU Langone Health','Mount Sinai Health System','Cedars-Sinai','Stanford Health Care','Yale New Haven Health','Rush University Medical Center','Houston Methodist','Baylor Scott White Health','Ochsner Health','OhioHealth','Mercy Health','SSM Health','Trinity Health','Tenet Healthcare','Community Health Systems','LifePoint Health'],
  rcm: ['R1 RCM','Conifer Health Solutions','Ensemble Health Partners','nThrive','Parallon','MedData','GeBBS Healthcare','Omega Healthcare','AGS Health','Infinx Healthcare','Maxim Health Information Services','Greenway Revenue Cycle','Kareo','Modernizing Medicine'],
  ehrVendors: ['Epic Systems','Oracle Health','Meditech','Netsmart Technologies','PointClickCare','MatrixCare','WellSky','Greenway Health','NextGen Healthcare','athenahealth','eClinicalWorks','Allscripts','Altera Digital Health','Azalea Health','ChartLogic'],
  gpos: ['HealthTrust','Vizient','Premier Inc','Intalere','Provista','Yankee Alliance','Captis'],
  specialtyGroups: ['Radiology Partners','US Oncology Network','American Oncology Network','Pediatrix Medical Group','MEDNAX','Sound Physicians','EmCare','AmSurg','Surgery Partners','SCA Health','Surgical Care Affiliates','United Urology Group','Urology of Virginia'],
  homeHealth: ['Amedisys','LHC Group','Encompass Health','Kindred Healthcare','BrightSpring Health','Addus HomeCare','Acadia Healthcare','Universal Health Services','Behavioral Health Group','Pyramid Healthcare'],
  payers: ['UnitedHealth Group','Humana','CVS Health','Elevance Health','Centene Corporation','Molina Healthcare','WellCare Health Plans','CareSource','AmeriHealth Caritas','Magellan Health'],
  urgentCare: ['CityMD','GoHealth Urgent Care','Patient First','MedExpress Urgent Care','NextCare Urgent Care','FastMed Urgent Care','Concentra'],
};

const TITLES_BY_TYPE = {
  clearinghouses: ['SVP Business Development','VP Channel Partnerships','Director Provider Relations','VP Product Management'],
  msos: ['Chief Executive Officer','Chief Operating Officer','VP Operations','Chief Health Information Officer'],
  healthSystems: ['CHIO','HIM Director','VP Revenue Cycle','Chief Information Officer','Director Health Information Management'],
  rcm: ['VP Operations','Director HIM','Chief Revenue Officer','SVP Client Services'],
  ehrVendors: ['SVP Sales','VP Channel Partnerships','Director Business Development'],
  gpos: ['Managing Director','VP Partnerships','Director Contracting'],
  specialtyGroups: ['Chief Revenue Officer','VP Operations','Director Billing','Chief Financial Officer'],
  homeHealth: ['Chief Executive Officer','COO','VP Clinical Operations','Director Revenue Cycle'],
  payers: ['VP Provider Relations','Director Network Management','VP Health Information'],
  urgentCare: ['Chief Operating Officer','VP Operations','Director HIM'],
};

let pullState = {};
Object.keys(ALL_TARGETS).forEach(k => pullState[k] = 0);

async function apolloSearch(title, company) {
  const apolloKey = process.env.APOLLO_API_KEY;
  if (!apolloKey) return [];
  try {
    const payload = { page: 1, per_page: 10, person_titles: [title], person_locations: ['United States'], reveal_personal_emails: true, reveal_phone_number: true };
    if (company) payload.q_organization_name = company;
    const response = await fetch('https://api.apollo.io/v1/mixed_people/api_search', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Key': apolloKey }, body: JSON.stringify(payload) });
    const data = await response.json();
    return data.people || [];
  } catch (err) { return []; }
}

async function savePersonToDB(person, orgType, dealType) {
  if (!pool) return false;
  if (!person.email) return false;
  try {
    const name = ((person.first_name||'') + ' ' + (person.last_name||'')).trim();
    const company = person.organization?.name || '';
    await pool.query(
      `INSERT INTO contacts (name,title,company,email,phone,location,linkedin,source,org_type,deal_type,score) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [name, person.title||'', company, person.email||'', person.phone_numbers?.[0]?.raw_number||'', [person.city,person.state].filter(Boolean).join(', '), person.linkedin_url||'', 'Apollo', orgType||'Health System', dealType||'provider', 85]
    );
    return true;
  } catch (err) { return false; }
}

async function runNightlyPull() {
  if (!pool || !process.env.APOLLO_API_KEY) { console.log('Nightly pull skipped'); return; }
  console.log('Starting nightly contact pull...');
  let totalSaved = 0;
  for (const [category, companies] of Object.entries(ALL_TARGETS)) {
    const titles = TITLES_BY_TYPE[category] || ['Chief Executive Officer','VP Operations'];
    const dealType = ['clearinghouses','ehrVendors','gpos','rcm'].includes(category) ? 'channel' : 'provider';
    const startIdx = pullState[category] % companies.length;
    const batch = [];
    for (let i = 0; i < 3; i++) batch.push(companies[(startIdx + i) % companies.length]);
    pullState[category] = (pullState[category] + 3) % companies.length;
    for (const company of batch) {
      for (const title of titles.slice(0, 2)) {
        const people = await apolloSearch(title, company);
        for (const person of people) { const saved = await savePersonToDB(person, category, dealType); if (saved) totalSaved++; }
        await new Promise(r => setTimeout(r, 300));
      }
    }
  }
  const generalTitles = ['HIM Director','Chief Health Information Officer','VP Revenue Cycle','Director Health Information Management','CHIO'];
  for (const title of generalTitles) {
    const people = await apolloSearch(title, null);
    for (const person of people) { const saved = await savePersonToDB(person, 'Health System', 'provider'); if (saved) totalSaved++; }
    await new Promise(r => setTimeout(r, 300));
  }
  console.log(`Nightly pull complete - saved ${totalSaved} new contacts`);
}

function scheduleMidnightPull() {
  const now = new Date();
  const midnight = new Date();
  midnight.setHours(24, 0, 0, 0);
  const msUntilMidnight = midnight - now;
  console.log(`Next nightly pull in ${Math.round(msUntilMidnight/1000/60)} minutes`);
  setTimeout(() => { runNightlyPull(); setInterval(runNightlyPull, 24 * 60 * 60 * 1000); }, msUntilMidnight);
}

app.post('/api/pull-contacts', async (req, res) => {
  res.json({ message: 'Contact pull started', categories: Object.keys(ALL_TARGETS).length, totalCompanies: Object.values(ALL_TARGETS).flat().length });
  runNightlyPull();
});

// ── CONTACT ENDPOINTS ─────────────────────────────────────────────────────────
app.get('/api/contacts', async (req, res) => {
  if (!pool) return res.json({ contacts: [], total: 0 });
  try {
    const limit = parseInt(req.query.limit) || 500;
    const search = req.query.search || '';
    const q = search ? [`%${search}%`] : [];
    const whereClause = search ? `WHERE name ILIKE $1 OR company ILIKE $1 OR title ILIKE $1 OR email ILIKE $1` : '';
    const result = await pool.query(`SELECT * FROM contacts ${whereClause} ORDER BY added_at DESC LIMIT ${search?'$2':'$1'}`, search ? [...q, limit] : [limit]);
    const count = await pool.query(`SELECT COUNT(*) FROM contacts ${whereClause}`, q);
    res.json({ contacts: result.rows, total: parseInt(count.rows[0].count) });
  } catch (err) { res.json({ contacts: [], total: 0 }); }
});

app.post('/api/contacts', async (req, res) => {
  if (!pool) return res.json({ success: false });
  try {
    const c = req.body;
    await pool.query(`INSERT INTO contacts (name,title,company,email,phone,location,linkedin,website,source,org_type,deal_type,notes,score) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [c.name||'',c.title||'',c.company||'',c.email||'',c.phone||'',c.location||'',c.linkedin||'',c.website||'',c.source||'Manual',c.org_type||'',c.deal_type||'provider',c.notes||'',c.score||80]);
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

app.post('/api/contacts/bulk', async (req, res) => {
  if (!pool) return res.json({ success: false, saved: 0 });
  try {
    const { contacts } = req.body;
    if (!contacts?.length) return res.json({ success: true, saved: 0 });
    let saved = 0;
    for (const c of contacts) {
      try {
        await pool.query(`INSERT INTO contacts (name,title,company,email,phone,location,linkedin,website,source,org_type,deal_type,notes,score) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [c.name||c.n||'',c.title||c.t||'',c.company||c.c||'',c.email||c.e||'',c.phone||c.p||'',c.location||c.l||'',c.linkedin||c.li||'',c.website||'',c.source||c.s||'Imported',c.org_type||c.orgType||'',c.deal_type||c.dealType||'provider',c.notes||'',c.score||80]);
        saved++;
      } catch(e) {}
    }
    res.json({ success: true, saved });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/contacts/cleanup/no-email', async (req, res) => {
  if (!pool) return res.json({ deleted: 0 });
  try {
    const result = await pool.query(`DELETE FROM contacts WHERE email IS NULL OR email = '' RETURNING id`);
    res.json({ deleted: result.rowCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── ANTHROPIC ─────────────────────────────────────────────────────────────────
app.post('/api/claude', async (req, res) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'No API key' });
    const useWebSearch = req.body.useWebSearch === true;
    const headers = { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
    if (useWebSearch) headers['anthropic-beta'] = 'web-search-2025-03-05';
    const body = { ...req.body };
    delete body.useWebSearch; delete body.useScanKey;
    const response = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers, body: JSON.stringify(body) });
    const data = await response.json();
    console.log('Claude:', data.stop_reason, data.error ? JSON.stringify(data.error) : 'ok');
    res.json(data);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ── APOLLO SEARCH ─────────────────────────────────────────────────────────────
app.post('/api/apollo-search', async (req, res) => {
  try {
    const apolloKey = process.env.APOLLO_API_KEY;
    if (!apolloKey) return res.status(500).json({ error: 'No Apollo API key' });
    const { title, industry, location, size } = req.body;
    const searchPayload = { page: 1, per_page: 25, person_titles: [title], person_locations: location ? [location] : ['United States'] };
    if (size) searchPayload.organization_num_employees_ranges = [size];
    const searchRes = await fetch('https://api.apollo.io/v1/mixed_people/api_search', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Key': apolloKey }, body: JSON.stringify(searchPayload) });
    const searchData = await searchRes.json();
    const people = searchData.people || [];
    const enriched = [];
    for (const person of people) {
      try {
        const enrichPayload = { first_name: person.first_name||'', last_name: person.last_name||'', organization_name: person.organization?.name||'', run_waterfall_email: true, reveal_personal_emails: true };
        if (person.linkedin_url) enrichPayload.linkedin_url = person.linkedin_url;
        if (person.id) enrichPayload.id = person.id;
        const enrichRes = await fetch('https://api.apollo.io/api/v1/people/match', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Key': apolloKey }, body: JSON.stringify(enrichPayload) });
        const enrichData = await enrichRes.json();
        const email = enrichData.person?.email || '';
        if (email) enriched.push({ ...person, email, phone_numbers: enrichData.person?.phone_numbers || [] });
      } catch(err) {}
      await new Promise(r => setTimeout(r, 200));
    }
    res.json({ ...searchData, people: enriched });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/apollo-enrich', async (req, res) => {
  try {
    const apolloKey = process.env.APOLLO_API_KEY;
    if (!apolloKey) return res.status(500).json({ error: 'No Apollo API key' });
    const { name, company, email, linkedin } = req.body;
    const payload = { reveal_personal_emails: true };
    if (email) payload.email = email;
    if (name) { const p = name.split(' '); payload.first_name = p[0]; payload.last_name = p.slice(1).join(' '); }
    if (company) payload.organization_name = company;
    if (linkedin) payload.linkedin_url = linkedin;
    const response = await fetch('https://api.apollo.io/api/v1/people/match', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Key': apolloKey }, body: JSON.stringify(payload) });
    res.json(await response.json());
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ── HEALTH ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.status(200).json({ status: 'ok', anthropic: !!process.env.ANTHROPIC_API_KEY, apollo: !!process.env.APOLLO_API_KEY, database: !!pool, newsSources: NEWS_SOURCES.length, monitoredSites: MONITORED_SITES.length }));

// ── PWA ───────────────────────────────────────────────────────────────────────
app.get('/sw.js', (req, res) => { res.setHeader('Content-Type', 'application/javascript'); res.setHeader('Service-Worker-Allowed', '/'); res.sendFile(path.join(__dirname, 'sw.js')); });
app.get('/manifest.json', (req, res) => { res.setHeader('Content-Type', 'application/manifest+json'); res.sendFile(path.join(__dirname, 'manifest.json')); });
app.use(express.static(path.join(__dirname)));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'clearsignalq.html')));

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`ClearsignalQ running on port ${PORT}`);
  console.log(`Sources: ${NEWS_SOURCES.length} RSS/Google/SEC feeds + ${MONITORED_SITES.length} monitored sites`);
  await initDB();
  scheduleMidnightPull();
});
