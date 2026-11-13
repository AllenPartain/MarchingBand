const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
]);

http.createServer((request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" });
    response.end("Method Not Allowed");
    return;
  }

  const asset = assets.get(new URL(request.url ?? "/", "http://localhost").pathname);
  if (!asset) {
    response.writeHead(404);
    response.end("Not Found");
    return;
  }

  fs.readFile(path.join(__dirname, asset[0]), (error, content) => {
    if (error) {
      console.error(`Could not read ${asset[0]}:`, error);
      response.writeHead(500);
      response.end("Internal Server Error");
      return;
    }

    response.writeHead(200, {
      "Content-Type": asset[1],
      "X-Content-Type-Options": "nosniff",
    });
    response.end(request.method === "HEAD" ? undefined : content);
  });
}).listen(8080, "127.0.0.1", () => {
  console.log("MarchingBand server ready at http://127.0.0.1:8080");
});
