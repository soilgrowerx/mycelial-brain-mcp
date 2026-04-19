const { Storage } = require('@google-cloud/storage');
const express = require('express');
const app = express();

const storage = new Storage();
const BUCKET = process.env.GCS_BUCKET_NAME || 'mycelial-brain-storage';
const PREFIX = 'doc-';

app.use(express.json());

async function getNextDocPath() {
  const [files] = await storage.bucket(BUCKET).getFiles({ prefix: PREFIX });
  const nums = files.map(f => parseInt(f.name.replace(PREFIX, '').replace('.json', ''))).filter(n => !isNaN(n));
  return 'doc-' + (Math.max(...nums, 0) + 1);
}

async function writeDoc(path, content, tags) {
  const file = storage.bucket(BUCKET).file(path + '.json');
  await file.save(JSON.stringify({ path, content, tags, updated: new Date().toISOString() }), { contentType: 'application/json' });
}

async function searchDocs(query, limit) {
  const synonyms = {
    scares: ['fears','anxieties','afraid'], 
    scared: ['fears','anxieties'], 
    fear: ['fears','anxieties'],
    failed: ['failures','mistakes','learned'], 
    fail: ['failures','mistakes'],
    morning: ['routine','daily'],
    family: ['chelsea','kids','legacy'],
    work: ['how-george-works','field-work'], 
    working: ['how-george-works','field-work']
  };
  
  let expandedTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  for (const term of [...expandedTerms]) {
    if (synonyms[term]) expandedTerms.push(...synonyms[term]);
  }
  const terms = [...new Set(expandedTerms)];
  
  if (terms.length === 0) return [];
  
  const [files] = await storage.bucket(BUCKET).getFiles({ prefix: PREFIX });
  const scored = [];
  
  for (const file of files) {
    try {
      const [contents] = await file.download();
      const doc = JSON.parse(contents.toString());
      const docText = doc.content.toLowerCase();
      const docTags = doc.tags.join(' ').toLowerCase();
      
      let score = 0;
      for (const term of terms) {
        if (docText.includes(term)) score += 2;
        if (docTags.includes(term)) score += 3;
      }
      
      if (score > 0) {
        scored.push({ path: doc.path, tags: doc.tags, preview: doc.content.slice(0, 150), score });
      }
    } catch (e) { console.error('Error:', e.message); }
  }
  
  const sorted = scored.sort((a, b) => b.score - a.score || parseInt(a.path.replace('doc-', '')) - parseInt(b.path.replace('doc-', '')));
  return limit ? sorted.slice(0, limit) : sorted;
}

app.get('/', (_, res) => res.json({ name: 'mycelial-brain', version: '2.0' }));
app.get('/health', (_, res) => res.json({ status: 'ok' }));

app.post('/mcp', async (req, res) => {
  const { method, params, id } = req.body || {};
  try {
    if (method === 'tools/list') {
      const tools = [
        { name: 'brain_search', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] }},
        { name: 'brain_read', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }},
        { name: 'brain_write', inputSchema: { type: 'object', properties: { content: { type: 'string' }, tags: { type: 'array' }, path: { type: 'string' } }, required: ['content'] }},
        { name: 'brain_list', inputSchema: { type: 'object', properties: {}}}
      ];
      return res.json({ jsonrpc: '2.0', id, result: { tools: tools }});
    }
    if (method === 'tools/call') {
      const { name, arguments: args } = params;
      if (name === 'brain_write') {
        const path = args.path || await getNextDocPath();
        await writeDoc(path, args.content, args.tags || []);
        return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Saved ' + path }]}});
      }
      if (name === 'brain_search') {
        const results = await searchDocs(args.query, args.limit);
        return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(results) }]}});
      }
      if (name === 'brain_read') {
        const [contents] = await storage.bucket(BUCKET).file(args.path + '.json').download();
        const doc = JSON.parse(contents);
        return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: doc.content }]}});
      }
      if (name === 'brain_list') {
        const [files] = await storage.bucket(BUCKET).getFiles({ prefix: PREFIX });
        const docs = await Promise.all(files.slice(0, 50).map(async f => { const [c] = await f.download(); return JSON.parse(c); }));
        return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(docs.map(d => ({ path: d.path, tags: d.tags }))) }]}});
      }
    }
    res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' }});
  } catch (e) {
    res.json({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message }});
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log('Mycelial Brain v2.0 ready'));
