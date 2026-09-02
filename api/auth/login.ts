import { authenticate, setSessionCookie, checkLoginRateLimit, recordFailedLoginAttempt, clearLoginAttempts } from "../_lib/auth.js";

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const { login, password } = req.body || {};
    if (typeof login !== "string" || typeof password !== "string" || !login.trim() || !password) {
      return res.status(400).json({ error: "Введите логин и пароль." });
    }

    const rateLimit = await checkLoginRateLimit(req, login);
    if (!rateLimit.allowed) {
      res.setHeader("Retry-After", String(rateLimit.retryAfterSeconds));
      return res.status(429).json({
        error: `Слишком много неудачных попыток входа. Повторите через ${Math.ceil(rateLimit.retryAfterSeconds / 60)} мин.`,
      });
    }

    const user = await authenticate(login, password);
    if (!user) {
      await recordFailedLoginAttempt(req, login);
      return res.status(401).json({ error: "Неверный логин или пароль." });
    }
    await clearLoginAttempts(req, login);
    await setSessionCookie(res, user);
    return res.status(200).json({ user });
  } catch (error) {
    console.error("Login error:", error);
    return res.status(500).json({ error: "Сервис авторизации не настроен или временно недоступен." });
  }
}
