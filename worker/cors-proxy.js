/**
 * RefScope CORS proxy — Cloudflare Worker (optional).
 *
 * GitHub Pages is static, so a few endpoints that don't send CORS headers
 * (some preview CDNs, fingerprint APIs) can't be called from the browser.
 * Deploy this worker and set its URL (e.g. https://refscope-proxy.<you>.workers.dev/?url=)
 * in RefScope's settings.
 *
 * Security: only allow-listed upstream hosts are proxied, and only for the
 * origins in ALLOWED_ORIGINS (set it to your GitHub Pages origin).
 *
 *   npx wrangler deploy worker/cors-proxy.js --name refscope-proxy
 *   npx wrangler secret put ALLOWED_ORIGINS   # e.g. https://<user>.github.io
 */
const UPSTREAM_HOSTS = [
  /^itunes\.apple\.com$/,
  /^audio-ssl\.itunes\.apple\.com$/,
  /\.mzstatic\.com$/,
  /^api\.audd\.io$/,
  /^identify-[a-z0-9-]+\.acrcloud\.com$/,
  /^ws\.audioscrobbler\.com$/,
  /^musicbrainz\.org$/,
];

export default {
  /** @param {Request} request @param {{ALLOWED_ORIGINS?: string}} env */
  async fetch(request, env) {
    const origin = request.headers.get('origin') ?? '';
    const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const originOk = allowed.length === 0 || allowed.includes(origin);
    const cors = {
      'access-control-allow-origin': originOk ? origin || '*' : 'null',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '86400',
      vary: 'origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (!originOk) return new Response('Origin not allowed', { status: 403, headers: cors });

    const target = new URL(request.url).searchParams.get('url');
    let url;
    try {
      url = new URL(target ?? '');
    } catch {
      return new Response('Missing or invalid ?url=', { status: 400, headers: cors });
    }
    if (url.protocol !== 'https:' || !UPSTREAM_HOSTS.some((re) => re.test(url.hostname)))
      return new Response('Host not allowed', { status: 403, headers: cors });

    const upstream = await fetch(url.toString(), {
      method: request.method,
      headers: { 'content-type': request.headers.get('content-type') ?? '' },
      body: request.method === 'POST' ? request.body : undefined,
    });
    const headers = new Headers(upstream.headers);
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
    headers.delete('set-cookie');
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
