// Lightweight HTTP test client that starts the Express app on an ephemeral
// port, issues a request using the global fetch, and closes the server.
async function requestJSON(app, method, path, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", async () => {
      const { port } = server.address();
      try {
        const res = await fetch(`http://127.0.0.1:${port}${path}`, {
          method,
          headers: body ? { "Content-Type": "application/json" } : {},
          body: body ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
        server.close(() => resolve({ status: res.status, data }));
      } catch (e) {
        server.close(() => reject(e));
      }
    });
    server.on("error", reject);
  });
}

module.exports = { requestJSON };
