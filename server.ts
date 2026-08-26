import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Basic middleware
  app.use(express.json());

  // Health check endpoint for Cloud Run
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Endpoint to download zip files with explicit headers
  const handleZipDownload = (filename: string, res: express.Response) => {
    const paths = [
      path.join(process.cwd(), "public", filename),
      path.join(process.cwd(), "dist", filename),
      path.join(process.cwd(), filename),
    ];
    for (const p of paths) {
      if (fs.existsSync(p)) {
        res.setHeader("Content-Type", "application/zip");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        return res.sendFile(p);
      }
    }
    return res.status(404).send("File not found");
  };

  app.get("/dongfeng-vigo-dist.zip", (req, res) => handleZipDownload("dongfeng-vigo-dist.zip", res));
  app.get("/download-dist.zip", (req, res) => handleZipDownload("dongfeng-vigo-dist.zip", res));
  app.get("/dist.zip", (req, res) => handleZipDownload("dongfeng-vigo-dist.zip", res));

  app.get("/dongfeng-vigo-source.zip", (req, res) => handleZipDownload("dongfeng-vigo-source.zip", res));
  app.get("/download-project.zip", (req, res) => handleZipDownload("dongfeng-vigo-source.zip", res));
  app.get("/source.zip", (req, res) => handleZipDownload("dongfeng-vigo-source.zip", res));

  // Vite middleware for development vs Static serving for production
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    // Catch-all route handler compatible with Express 5 & static SPA
    app.use((req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();

