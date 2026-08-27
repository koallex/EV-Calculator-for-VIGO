# Настройка авторизации v1.01

Добавьте в Vercel → Settings → Environment Variables:

- `ADMIN_LOGIN` — логин администратора.
- `ADMIN_PASSWORD_HASH` — хэш пароля администратора.
- `AUTH_SECRET` — случайная строка минимум 32 символа.
- `UPSTASH_REDIS_REST_URL` — URL Redis.
- `UPSTASH_REDIS_REST_TOKEN` — токен Redis.

Redis нужен для хранения обычных пользователей. Пароли хранятся только в виде scrypt-хэшей.

Сгенерировать хэш пароля администратора можно командой Node:

```bash
node -e "const {randomBytes,scryptSync}=require('crypto'); const p=process.argv[1]; const s=randomBytes(16).toString('base64url'); console.log('scrypt$'+s+'$'+scryptSync(p,s,64).toString('base64url'))" "ВАШ_ПАРОЛЬ"
```

После добавления/изменения переменных окружения сделайте Redeploy.

Важно: не помещайте `ADMIN_PASSWORD_HASH`, `AUTH_SECRET` или Redis token в GitHub.
