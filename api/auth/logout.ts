import { clearSession } from "../_lib/auth.js";

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  await clearSession(req, res);
  return res.status(200).json({ ok: true });
}
