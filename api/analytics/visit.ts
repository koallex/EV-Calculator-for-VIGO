import { recordAppVisit } from '../_lib/auth.js';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const result = await recordAppVisit(req, res);
    return res.status(200).json({ ok: result.ok });
  } catch (error) {
    console.error('App analytics endpoint error:', error);
    return res.status(200).json({ ok: false });
  }
}
