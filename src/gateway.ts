import http, { type IncomingHttpHeaders } from "node:http";
import https from "node:https";

const port = Number(process.env.PORT ?? "8080");
const host = process.env.HOST ?? "0.0.0.0";
const upstream = new URL(required("UPSTREAM_BASE_URL"));

if (upstream.protocol !== "http:" && upstream.protocol !== "https:") {
  throw new Error("UPSTREAM_BASE_URL must use http or https");
}

const server = http.createServer((request, response) => {
  const requestPath = request.url?.startsWith("/") ? request.url : "/";
  const target = new URL(requestPath, upstream);
  const transport = target.protocol === "https:" ? https : http;
  const headers = proxyRequestHeaders(request.headers, target);
  const upstreamRequest = transport.request(target, {
    method: request.method,
    headers,
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, proxyResponseHeaders(upstreamResponse.headers));
    upstreamResponse.pipe(response);
  });

  upstreamRequest.once("error", (error) => {
    if (!response.headersSent) {
      response.writeHead(502, { "content-type": "application/json; charset=utf-8" });
    }
    response.end(JSON.stringify({ error: "SeeIn worker is temporarily unavailable", detail: error.message }));
  });
  request.pipe(upstreamRequest);
});

server.listen({ host, port }, () => {
  process.stdout.write(JSON.stringify({ service: "seein-gateway", listen: `${host}:${port}`, upstream: upstream.origin }) + "\n");
});

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function proxyRequestHeaders(headers: IncomingHttpHeaders, target: URL): IncomingHttpHeaders {
  const next = { ...headers };
  delete next.connection;
  delete next["proxy-connection"];
  delete next["keep-alive"];
  delete next["transfer-encoding"];
  delete next.upgrade;
  next.host = target.host;
  return next;
}

function proxyResponseHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const next = { ...headers };
  delete next.connection;
  delete next["proxy-connection"];
  delete next["keep-alive"];
  delete next["transfer-encoding"];
  delete next.upgrade;
  return next;
}
