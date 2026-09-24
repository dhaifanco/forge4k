
// Shared helpers for the Forge E2E suite (zero deps).
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const BASE = process.env.FORGE_API || 'http://127.0.0.1:5177';
const SAMPLES = path.join(__dirname, '..', 'samples');
const GEN = path.join(process.env.TEMP || '/tmp', 'forge_e2e');

function request(method, p, { data, files, timeout = 600000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + p);
    const mod = url.protocol === 'https:' ? https : http;
    let body = null;
    const headers = {};
    if (files) {
      const boundary = '----forgeE2E' + Date.now() + Math.random().toString(36).slice(2);
      const parts = [];
      for (const [field, val] of Object.entries(files)) {
        const entries = Array.isArray(val) && Array.isArray(val[0]) ? val : [val];
        for (const [fname, fpath, ctype] of entries) {
          parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="' + field + '"; filename="' + fname + '"\r\nContent-Type: ' + (ctype || 'application/octet-stream') + '\r\n\r\n'));
          parts.push(fs.readFileSync(fpath));
          parts.push(Buffer.from('\r\n'));
        }
      }
      parts.push(Buffer.from('--' + boundary + '--\r\n'));
      body = Buffer.concat(parts);
      headers['Content-Type'] = 'multipart/form-data; boundary=' + boundary;
      headers['Content-Length'] = body.length;
    } else if (data != null) {
      body = Buffer.from(JSON.stringify(data));
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = body.length;
    }
    headers['Connection'] = 'close';
    const r = mod.request(url, { method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch (e) { parsed = { raw }; }
        if (res.statusCode >= 400) {
          const err = new Error((parsed && parsed.error) || raw.slice(0, 200));
          err.status = res.statusCode; err.body = parsed;
          reject(err);
        } else resolve(parsed);
      });
    });
    r.on('error', reject);
    r.setTimeout(timeout, () => r.destroy(new Error('timeout ' + p)));
    if (body) r.write(body);
    r.end();
  });
}

async function reqRetry(method, p, data, files, timeout) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { return await request(method, p, { data, files, timeout }); }
    catch (e) {
      lastErr = e;
      const safeRetry = files != null || method === 'GET';
      if (!safeRetry) throw e;
      const transient = !e.status && (e.code === 'ECONNRESET' || e.code === 'EPIPE' || /socket|reset|timeout/i.test(e.message || ''));
      if (!transient || attempt === 3) throw e;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  throw lastErr;
}
const req = (method, p, data, files, timeout) => reqRetry(method, p, data, files, timeout);
const analyzeFile = (fpath, name) => req('POST', '/api/analyze', null, { file: [name || path.basename(fpath), fpath, 'video/mp4'] });

async function waitForJob(id, { timeoutMs = 300000, useV1 = false } = {}) {
  const t0 = Date.now();
  for (;;) {
    const j = useV1 ? await req('GET', '/api/optimize/' + id) : await req('GET', '/api/queue/' + id);
    if (['completed', 'failed', 'cancelled'].includes(j.state)) return j;
    if (Date.now() - t0 > timeoutMs) throw new Error('job timeout: ' + id);
    await new Promise((r) => setTimeout(r, 700));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { req, analyzeFile, waitForJob, sleep, SAMPLES, GEN, BASE };
