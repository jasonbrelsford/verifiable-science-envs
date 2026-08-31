// Cloudflare Worker: serve hlaverify.com from the HF Space, keeping our domain in the bar.
// Deploy: dashboard → Workers → create → paste → route hlaverify.com/*
const ORIGIN = "https://jebidiag-hla-verify.hf.space";
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const upstream = ORIGIN + url.pathname + url.search;
    const resp = await fetch(upstream, {
      method: request.method,
      headers: request.headers,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
    });
    const headers = new Headers(resp.headers);
    headers.delete("content-security-policy");
    return new Response(resp.body, { status: resp.status, headers });
  },
};
