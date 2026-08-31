import {
  createUser,
  deleteUser,
  getCurrentUser,
  listUsers,
} from '../_lib/auth.js';

export default async function handler(req: any, res: any) {
  const current = await getCurrentUser(req);
  if (!current || current.role !== 'admin') {
    return res.status(403).json({ error: 'Доступ только для администратора.' });
  }

  try {
    if (req.method === 'GET') {
      const users = await listUsers();
      return res.status(200).json({
        users: users.map(({ login, createdAt, disabled }) => ({ login, role: 'user', createdAt, disabled })),
      });
    }

    if (req.method === 'POST') {
      const { login, password } = req.body || {};
      if (typeof login !== 'string' || typeof password !== 'string') {
        return res.status(400).json({ error: 'Укажите логин и пароль.' });
      }
      const user = await createUser(login, password);
      return res.status(201).json({ user: { login: user.login, role: 'user', createdAt: user.createdAt } });
    }

    if (req.method === 'DELETE') {
      const login = typeof req.query?.login === 'string' ? req.query.login : '';
      if (!login) return res.status(400).json({ error: 'Не указан логин.' });
      const deleted = await deleteUser(login);
      if (!deleted) return res.status(404).json({ error: 'Пользователь не найден.' });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('Admin users error:', error);
    const message = error instanceof Error ? error.message : 'Ошибка сервера.';
    return res.status(500).json({ error: message });
  }
}
