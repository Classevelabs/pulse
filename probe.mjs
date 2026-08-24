// Outside witness. Probes only what any visitor can reach, writes pulse.json
// into the repo (git history = free uptime archive), and reports to the deck
// with an HMAC signature. Runs on GitHub Actions — a different company,
// network and billing relationship than everything it watches.
import { createHmac } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const DECK = process.env.DECK_ORIGIN ?? 'https://deck.classeve.com';
const SECRET = process.env.PULSE_HMAC_SECRET ?? '';

async function probe(target, url, opts = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15000), method: opts.method ?? 'GET', headers: { 'User-Agent': 'classeve-pulse (github actions witness)', ...(opts.headers ?? {}) } });
    const latency = Date.now() - t0;
    let detail = null;
    let ok = (opts.expect ?? [200]).includes(res.status);
    if (ok && opts.contains) {
      const text = await res.text();
      if (!text.includes(opts.contains)) {
        ok = false;
        detail = 'expected content missing';
      }
    }
    if (ok && opts.json) {
      try {
        JSON.parse(await res.text());
      } catch {
        ok = false;
        detail = 'invalid JSON';
      }
    }
    return { target, ok, status: res.status, latency_ms: latency, detail };
  } catch (err) {
    return { target, ok: false, status: null, latency_ms: Date.now() - t0, detail: err.name === 'TimeoutError' ? 'timeout' : String(err.message).slice(0, 120) };
  }
}

const results = await Promise.all([
  probe('site', 'https://classeve.com/', { contains: 'ClassEve' }),
  probe('products', 'https://classeve.com/products.json', { json: true }),
  probe('api', 'https://api.classeve.com/v1/health'),
  probe('api_ready', 'https://api.classeve.com/v1/health/ready', { expect: [200] }),
  probe('supabase_auth', 'https://ocrcyhuncgfvcmzupymm.supabase.co/auth/v1/health', { headers: { apikey: process.env.SUPABASE_ANON_KEY ?? '' } }),
  probe('deck', `${DECK}/api/health`),
  probe('play_listing', 'https://play.google.com/store/apps/details?id=com.lven.assist', { expect: [200] }),
]);

// Every registered artifact URL must resolve.
try {
  const reg = await (await fetch('https://classeve.com/products.json', { signal: AbortSignal.timeout(15000) })).json();
  const urls = [];
  for (const p of Object.values(reg.products ?? {})) for (const pl of p.platforms ?? []) for (const a of pl.artifacts ?? []) if (a.url) urls.push(new URL(a.url, 'https://classeve.com').toString());
  const misses = [];
  for (const u of urls.slice(0, 20)) {
    try {
      // redirect: 'manual'. Following the redirect fetches the asset, and GitHub
      // counts that as a download — this probe ran every five minutes against all
      // thirteen registered artifacts and put ~150 fake downloads on each of them
      // inside its first day, which is most of what the public counters showed.
      // A 302 from the release URL already proves the release and asset exist
      // (GitHub 404s an unknown asset), so stopping at the redirect verifies the
      // same thing and leaves the counters measuring real people.
      const r = await fetch(u, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(20000) });
      if (r.status !== 200 && r.status !== 302) misses.push(`${u.split('/').pop()}: HTTP ${r.status}`);
    } catch {
      misses.push(`${u.split('/').pop()}: unreachable`);
    }
  }
  results.push({ target: 'downloads', ok: misses.length === 0, status: null, latency_ms: null, detail: misses.length ? misses.slice(0, 3).join('; ').slice(0, 200) : `${urls.length} artifacts ok` });
} catch (err) {
  results.push({ target: 'downloads', ok: false, status: null, latency_ms: null, detail: String(err.message).slice(0, 120) });
}

const summary = { checked_at: new Date().toISOString(), run: process.env.GITHUB_RUN_ID ?? 'local', all_ok: results.every((r) => r.ok), results };
writeFileSync('pulse.json', JSON.stringify(summary, null, 2) + '\n');
console.table(results.map(({ target, ok, status, latency_ms, detail }) => ({ target, ok, status, latency_ms, detail })));

// Report to the deck (skipped silently if the deck itself is what died —
// pulse.json on GitHub remains readable either way).
if (SECRET) {
  const body = JSON.stringify({ run: summary.run, results });
  const ts = String(Date.now());
  const sig = createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex');
  try {
    const res = await fetch(`${DECK}/api/pulse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Pulse-Timestamp': ts, 'X-Pulse-Signature': sig },
      body,
      signal: AbortSignal.timeout(15000),
    });
    console.log('deck ingest:', res.status);
  } catch (err) {
    console.log('deck ingest failed:', err.message);
  }
}

// The workflow turns red on a real outage so GitHub emails the owner.
if (!summary.all_ok) process.exit(1);
