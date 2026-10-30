// In-memory GitHub REST API (the subset used by worker/admin.js): refs, commits, trees, blobs and raw contents.
// Rejects non-fast-forward ref updates like GitHub (422) and records every request for assertions.
import crypto from 'node:crypto';

export function createFakeGitHub({ repo = 'grind/yuma3d', branch = 'main', files = {}, token = 'github_pat_test123' } = {}) {
  const blobs = new Map(), trees = new Map(), commits = new Map();
  const requests = [];
  const sha = data => crypto.createHash('sha1').update(data).digest('hex');
  const putBlob = buffer => { const id = sha(Buffer.concat([Buffer.from('blob'), buffer])); blobs.set(id, buffer); return id; };
  const putTree = map => { const id = sha('tree' + JSON.stringify([...map].sort())); trees.set(id, new Map(map)); return id; };
  const putCommit = (tree, parents, message) => { const id = sha('commit' + tree + parents.join() + message + Math.random()); commits.set(id, { tree, parents, message }); return id; };

  const initial = new Map(Object.entries(files).map(([path, content]) => [path, putBlob(Buffer.isBuffer(content) ? content : Buffer.from(content))]));
  const refs = { [branch]: putCommit(putTree(initial), [], 'initial') };

  const reply = (status, body) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  async function fetch(url, init = {}) {
    const { pathname, searchParams } = new URL(url);
    const method = init.method || 'GET';
    const headers = new Headers(init.headers);
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ method, pathname, body, headers: Object.fromEntries(headers) });
    if (headers.get('Authorization') !== `Bearer ${token}`) return reply(401, { message: 'Bad credentials' });
    if (headers.get('X-GitHub-Api-Version') !== '2022-11-28' || !headers.get('User-Agent')) return reply(400, { message: 'missing headers' });
    const prefix = `/repos/${repo}`;
    if (!pathname.startsWith(prefix + '/')) return reply(404, { message: 'Not Found' });
    const path = pathname.slice(prefix.length);
    let m;
    if (method === 'GET' && (m = path.match(/^\/git\/ref\/heads\/(.+)$/))) return refs[m[1]] ? reply(200, { object: { sha: refs[m[1]], type: 'commit' } }) : reply(404, {});
    if (method === 'GET' && (m = path.match(/^\/git\/commits\/(\w+)$/))) { const c = commits.get(m[1]); return c ? reply(200, { sha: m[1], tree: { sha: c.tree }, parents: c.parents.map(p => ({ sha: p })) }) : reply(404, {}); }
    if (method === 'GET' && (m = path.match(/^\/git\/trees\/(\w+)$/))) {
      const t = trees.get(m[1]); if (!t || searchParams.get('recursive') !== '1') return reply(404, {});
      return reply(200, { sha: m[1], truncated: false, tree: [...t].map(([p, s]) => ({ path: p, type: 'blob', sha: s, mode: '100644' })) });
    }
    if (method === 'GET' && (m = path.match(/^\/contents\/(.+)$/))) {
      const c = commits.get(searchParams.get('ref')); const blob = c && trees.get(c.tree).get(m[1]);
      if (!blob) return reply(404, { message: 'Not Found' });
      if (headers.get('Accept') !== 'application/vnd.github.raw+json') return reply(415, {});
      return new Response(blobs.get(blob), { status: 200 });
    }
    if (method === 'POST' && path === '/git/blobs') {
      if (body.encoding !== 'base64') return reply(422, {});
      return reply(201, { sha: putBlob(Buffer.from(body.content, 'base64')) });
    }
    if (method === 'POST' && path === '/git/trees') {
      const base = trees.get(body.base_tree); if (!base) return reply(422, {});
      const next = new Map(base);
      for (const entry of body.tree) {
        if (entry.mode !== '100644' || entry.type !== 'blob') return reply(422, {});
        if (entry.sha === null) next.delete(entry.path);
        else if (typeof entry.content === 'string') next.set(entry.path, putBlob(Buffer.from(entry.content)));
        else if (blobs.has(entry.sha)) next.set(entry.path, entry.sha);
        else return reply(422, {});
      }
      return reply(201, { sha: putTree(next) });
    }
    if (method === 'POST' && path === '/git/commits') {
      if (!trees.has(body.tree) || !body.parents.every(p => commits.has(p))) return reply(422, {});
      return reply(201, { sha: putCommit(body.tree, body.parents, body.message) });
    }
    if (method === 'PATCH' && (m = path.match(/^\/git\/refs\/heads\/(.+)$/))) {
      const commit = commits.get(body.sha);
      if (!commit) return reply(422, {});
      if (!body.force && !commit.parents.includes(refs[m[1]])) return reply(422, { message: 'Update is not a fast forward' });
      refs[m[1]] = body.sha;
      return reply(200, { object: { sha: body.sha } });
    }
    return reply(404, { message: 'Not Found' });
  }

  const head = () => refs[branch];
  const file = (path, at = head()) => { const id = trees.get(commits.get(at).tree).get(path); return id ? blobs.get(id) : undefined; };
  // Simulates someone else pushing to the branch (e.g. a code change).
  function pushExternal(path, content) {
    const tree = new Map(trees.get(commits.get(head()).tree));
    tree.set(path, putBlob(Buffer.from(content)));
    refs[branch] = putCommit(putTree(tree), [head()], 'external');
  }
  return { fetch, requests, head, file, pushExternal, commit: id => commits.get(id), repo, token };
}
