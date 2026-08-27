import { getCurrentUser } from '../../src/server/auth';

export default async function handler(req: any, res: any) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: 'Не авторизован.' });
    return res.status(200).json({ user });
  } catch (error) {
    console.error('Session check error:', error);
    return res.status(500).json({ error: 'Сервис авторизации не настроен.' });
  }
}
