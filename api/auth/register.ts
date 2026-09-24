import { createUser, setSessionCookie, checkLoginRateLimit, recordFailedLoginAttempt } from "../_lib/auth.js";

// Public, self-service registration — anyone can create an account with just a login and
// password. No admin approval, no ID/personal-data collection, no payment: this keeps the
// app within Yandex Maps API's free-tier "open access" requirement (any registration must be
// open to everyone with no extra restrictions). Reuses the login rate limiter, keyed by the
// submitted login, so scripted mass-registration is throttled the same way brute-force login
// attempts are.
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
        error: `Слишком много попыток регистрации. Повторите через ${Math.ceil(rateLimit.retryAfterSeconds / 60)} мин.`,
      });
    }

    let user;
    try {
      user = await createUser(login, password);
    } catch (err) {
      // createUser() throws on validation issues (bad login format, short password, login
      // already taken) — count those as a failed attempt too so retries are throttled.
      await recordFailedLoginAttempt(req, login);
      const message = err instanceof Error ? err.message : "Не удалось создать пользователя.";
      return res.status(400).json({ error: message });
    }

    await setSessionCookie(res, { login: user.login, role: "user" });
    return res.status(201).json({ user: { login: user.login, role: "user" } });
  } catch (error) {
    console.error("Register error:", error);
    return res.status(500).json({ error: "Сервис регистрации не настроен или временно недоступен." });
  }
}
