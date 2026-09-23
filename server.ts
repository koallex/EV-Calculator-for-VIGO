import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import { getEvraceGroups, getEvraceStats, forceRefreshEvraceCache } from "./api/_lib/evrace";

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Basic middleware
  app.use(express.json());

  // Health check endpoint for Cloud Run
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // EVRACE proxy: keeps browser requests same-origin and avoids EVRACE CORS/Cloudflare cookie issues.
  app.get("/api/evrace/stations", async (req, res) => {
    try {
      const n = (value: unknown) => { const v = Array.isArray(value) ? value[0] : value; const x = Number(v); return Number.isFinite(x) ? x : undefined; };
      const minLat = n(req.query.minLat), maxLat = n(req.query.maxLat), minLon = n(req.query.minLon), maxLon = n(req.query.maxLon);
      const hasBbox = [minLat, maxLat, minLon, maxLon].every(v => v !== undefined);
      const groups = await getEvraceGroups(hasBbox ? { minLat: minLat!, maxLat: maxLat!, minLon: minLon!, maxLon: maxLon! } : undefined);
      const stats = await getEvraceStats();
      res.setHeader("Cache-Control", "public, max-age=300, s-maxage=21600");
      res.json({ source: "evrace", groups, meta: { total_groups: stats.totalGroups ?? groups.length, returned_groups: groups.length, filtered: hasBbox, cache: stats.cached, stale: stats.stale, failed_pages: stats.failedPages } });
    } catch (error) {
      res.status(502).json({ error: "EVRACE unavailable", message: error instanceof Error ? error.message : String(error) });
    }
  });

  // Manual trigger for the same refresh the daily Vercel cron runs, for local testing:
  // curl http://localhost:3000/api/cron/evrace-refresh
  app.get("/api/cron/evrace-refresh", async (req, res) => {
    try {
      const result = await forceRefreshEvraceCache();
      res.json({ ok: true, totalGroups: result.totalGroups, groupsFetched: result.groups.length, failedPages: result.failedPages, fetchedAt: result.fetchedAt });
    } catch (error) {
      res.status(502).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
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

