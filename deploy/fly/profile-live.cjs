// 20 s CPU profile of the town server (read-only diagnosis): SIGUSR1 opens Node's inspector on 127.0.0.1:9229,
// Profiler samples for 20 s, the raw profile goes to /tmp/town.cpuprofile, the inspector is closed again.
const fs = require('fs'); const http = require('http');
function find() { for (const d of fs.readdirSync('/proc')) { if (!/^\d+$/.test(d)) continue; let c = ''; try { c = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8'); } catch { continue; } if (c.includes('--require') && c.includes('packages/server/src/main.ts')) return Number(d); } throw new Error('server pid not found'); }
const pid = Number(process.argv[2]) || find();
const SECONDS = Number(process.argv[3]) || 20;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  process.kill(pid, 'SIGUSR1'); await sleep(1500);
  const list = await new Promise((res, rej) => http.get('http://127.0.0.1:9229/json/list', (r) => { let b = ''; r.on('data', (d) => b += d); r.on('end', () => res(JSON.parse(b))); }).on('error', rej));
  const WS = globalThis.WebSocket || require('/data/repo/node_modules/ws');
  const ws = new WS(list[0].webSocketDebuggerUrl); let id = 0; const pending = new Map();
  const handle = (raw) => { const d = JSON.parse(String(raw)); if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.rej(new Error(JSON.stringify(d.error))) : p.res(d.result); } };
  if (typeof ws.on === 'function') { ws.on('message', handle); await new Promise((r) => ws.on('open', r)); } else { ws.onmessage = (m) => handle(m.data); await new Promise((r) => ws.onopen = r); }
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Profiler.enable'); await send('Profiler.setSamplingInterval', { interval: 1000 });
  await send('Profiler.start'); console.log(`profiling pid ${pid} for ${SECONDS} s`); await sleep(SECONDS * 1000);
  const { profile } = await send('Profiler.stop');
  fs.writeFileSync('/tmp/town.cpuprofile', JSON.stringify(profile));
  await send('Runtime.evaluate', { expression: "require('inspector').close(); 'closed'", includeCommandLineAPI: true }).then((r) => console.log('inspector', r.result && r.result.value)).catch((e) => console.log('inspector close failed', e.message));
  ws.close();
  const nodes = new Map(profile.nodes.map((n) => [n.id, n])); const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
  const key = (n) => { const cf = n.callFrame; return `${cf.functionName || '(anon)'} ${cf.url.replace('file:///data/repo/', '').replace(/^node:/, 'node:')}:${cf.lineNumber + 1}`; };
  const self = new Map(), incl = new Map(); let total = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    const dt = profile.timeDeltas[i] || 0; total += dt; let n = nodes.get(profile.samples[i]);
    self.set(key(n), (self.get(key(n)) || 0) + dt);
    const seen = new Set(); while (n) { const k = key(n); if (!seen.has(k)) { seen.add(k); incl.set(k, (incl.get(k) || 0) + dt); } n = nodes.get(parent.get(n.id)); }
  }
  const pct = (v) => String(Math.round(v / total * 1000) / 10).padStart(5) + '%';
  console.log(`\nsampled ${Math.round(total / 1000)} ms\n--- SELF time (top 30)`);
  for (const [k, v] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(pct(v), k);
  console.log('--- INCLUSIVE time (top 45, excluding root/program)');
  for (const [k, v] of [...incl.entries()].filter(([k]) => !/^\((root|program)\)/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 45)) console.log(pct(v), k);
  const byFile = new Map(); for (const [k, v] of self) { const f = k.split(' ').pop().replace(/:\d+$/, ''); byFile.set(f, (byFile.get(f) || 0) + v); }
  console.log('--- SELF time by file (top 15)'); for (const [k, v] of [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(pct(v), k);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
