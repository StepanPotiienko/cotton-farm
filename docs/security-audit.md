# Звіт безпекового аудиту — «Бавовна Simulator»

- **Дата:** 2026-09-29 (EEST)
- **Об'єкт:** `/Users/stepanpotiienko/morph/cotton-farm` — локальний three.js + Vite + TS-strict браузерний ігровий проєкт (без бекенда, збереження в localStorage, DOM-оверлей UI).
- **Режим:** READ-ONLY для коду; єдиний запис — цей файл. Аудит охоплює осі: XSS, цілісність save-даних, ланцюжок постачання (npm audit/outdated), `window.__game` і event bus + CSP, динамічне виконання конфіг-даних.

## Зведена таблиця severity

| Рівень | К-сть | Знахідки |
|---|---|---|
| Критичний | 1 | F3 — критичний advisories-ланцюжок vitest (dev-only) |
| Високий | 1 | F4 — вразливий вкладений vite 5.4.21 + esbuild 0.21.5 (dev-only) |
| Середній | 4 | F1, F6, F10, F15 |
| Низький | 3 | F7, F9, F14 |
| Не-проблема | 6 | F2, F5, F8, F11, F12, F13 |

**Разом: 15 знахідок.** У продакшн-бандлі (код гри) немає жодної критичної чи високої вразливості; обидві верхні проблеми — виключно dev-залежності, які не потрапляють у `dist/`.

---

## F1. Середній — єдиний HTML-синк: `innerHTML` з інтерполяцією i18n

- **Місце:** `src/ui/hud.ts:4-7` — `root.innerHTML = \`...\`` з інтерполяціями `${t('title')}`, `${t('currency')}`, `${t('shop')}`, `${t('settings')}`, `${t('hint')}`.
- **Чому це має значення:** сьогодні значення безпечні — словник `i18n.ts:2-5` це `as const`-літерал із статичними рядками, `setLocale` (`src/core/i18n.ts:7`) ніде не викликається (пошук підтверджено). Але це єдина точка, куди будь-яка майбутня динаміка (переклади з JSON-файлу/конфіга, значення save `settings.locale`, текст подій event bus, майбутній DOM крамниці чи плаваючих підказок) потрапляє в DOM без екранування як розмітка. Рядок `t()` типізований як `keyof dictionary.uk`, тож випадкова підстановка невідомого ключа не скомпілюється — гарний бар'єр, який треба зберегти.
- **Стан «фабрики попапів/шоп-DOM»: у `src/` їх ще не існує** — єдиний файл у `src/ui/` це `hud.ts` (перелік файлів + grep перевірено). Проблема превентивна.
- **Мінімальний фікс:** не міняти зараз на createElement цілком (це більше диф); мінімально — винести інтерпольовані значення через хелпер екранування та використати його вже при першій появі динаміки:
  ```ts
  const esc = (s: string): string =>
    s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  ```
  або одразу писати значення через `textContent`. Незалежно від обраного шляху — правило: **жоден рядок із save/конфігу/подій не інтерполюється в HTML без `esc()`**.

## F2. Не-проблема — безпечний шлях оновлення лічильника

- **Місце:** `src/ui/hud.ts:9` — `currency.textContent = new Intl.NumberFormat('uk-UA').format(...currency)`.
- **Чому:** `textContent` + числове форматування — безпечно за визначенням: число не може нести розмітку. Зберегти цей стиль для всіх динамічних оверлей-значень.

## F3. Критичний (dev-only) — vitest 2.1.9: довільне читання/виконання файлів через Vitest UI/API-сервер

- **Місце (джерело):** `package-lock.json` → `node_modules/vitest@2.1.9` (devDependency, `package.json` `devDependencies.vitest: ^2.1.8`).
- **Вихід `npm audit` (реально виконано):**
  ```
  5 vulnerabilities (1 critical, 1 high, 3 moderate)
  vitest    … critical  — "When Vitest UI server is listening, arbitrary file can be read and executed"
              GHSA-5xrq-8626-4rwp / CVE-2026-47429 (CVSS 9.8); patched у 3.2.5 / 4.1.0+
  @vitest/mocker @2.1.9 … moderate — GHSA-82fw-gwwq-j7x9 (path traversal / arbitrary file read через redirect mock)
  vite-node @2.1.9    … moderate — успадковує вразливий vite
  fix available: vitest@5.0.2 (semver-major)
  ```
- **Чому це має значення:** якщо Vitest UI (`vitest --ui`) або API-сервер слухає порт (особливо на Windows або з `--api.host` назовні), сторонній процес у мережі може читати довільні файли та через `saveTestFile`+`rerun` виконувати довільні скрипти від імені розробника. Для локальної гри ризик обмежений dev-машиною, але це найвищий балCVSS у залежностях.
- **Мінімальний фікс:** `npm i -D vitest@^5.0.2` (побічно підніме `@vitest/mocker`, `vite-node` і вкладений `vite`; після цього `npm audit` очікувано чистий). Never запускати `vitest --ui` з `--api.host` поза localhost. Це збігається з цільовим «vitest 5» проєкту.

## F4. Високий (dev-only) — вкладений vite 5.4.21 (під vitest) з високим advisories + esbuild 0.21.5

- **Місце:** `package-lock.json` → `node_modules/vitest/node_modules/vite@5.4.21`, `node_modules/vite-node/node_modules/vite@5.4.21`; `node_modules/vitest/node_modules/esbuild@0.21.5`, `node_modules/vite-node/node_modules/esbuild@0.21.5`.
- **Вихід `npm audit`:**
  ```
  vite … high — GHSA-fx2h-pf6j-xcff (server.fs.deny bypass на Windows з alternate data streams/8.3-imens; patched: 6.4.3 / 7.3.5 / 8.0.16)
             — GHSA-4w7w-66w2-5vf9 (moderate, path traversal в optimized deps)
             — GHSA-v6wh-96g9-6wx3 (moderate, launch-editor NTLMv2 hash disclosure, Windows)
  esbuild … moderate — GHSA-67mh-4wv8-2f99 (довільний сайт може надсилати запити до dev-сервера і читати відповіді)
  ```
- **Важливий нюанс:** **кореневий** `vite` у проєкті вже 6.4.3 (patched версія для GHSA-fx2h-pf6j-xcff; перевірено по lockfile). Вразливі — дублікати 5.4.21/0.21.5, притягнуті vitest-ланцюжком, тому вони **не зникають** оновленням кореневого vite — лише підняттям vitest → 5.x (тобто той самий фікс, що й у F3). `npm audit` об'єднує їх в один fixAvailable `vitest@5.0.2`.
- **Мінімальний фікс:** той самий — `npm i -D vitest@^5.0.2`; у CI/локально не відкривати dev-сервер назовні (`vite --host 0.0.0.0` не використовувати).

## F5. Не-проблема — продуктові залежності чисті за advisories

- **Дані:** `npm audit --omit=dev` → `found 0 vulnerabilities`. `three@0.170.0`, `@dimforge/rapier3d-compat@0.14.0` (lockfile-версії) — відомих advisories немає. В `package-lock.json` у продуктових залежностях немає жодних `postinstall`/`preinstall` скриптів (скан виконано), lockfile закомічений.
- **Примітка (`npm outdated`, реальний вивід):** доступні новіші major/minor — `three 0.186.1`, `rapier3d-compat 0.21.0`, `vite 8.3.1`, `typescript 7.0.2`. Це не безпекова вимога (немає advisories на поточні версії), а рутинне оновлення — робити окремою задачею з перевіркою тестів, не міксувати з безпековими фіксами.

## F6. Середній — `window.__game` потрапляє у прод-бандл і експонує повний стан гри

- **Місце:** `src/main.ts:11-12` — `declare global { interface Window { __game: Game } }` і `window.__game = game;`. Перевірка бандлу: у `dist/assets/index-B95MhukY.js` є `window.__game` (grep знайшов 1 збіг) — тобто діагностичний хук живе і у проді.
- **Чому це має значення:** об'єкт `Game` експонує:
  - `events` (`Game.ts:10`) — ззовні можна `window.__game.events.emit('goblin:grabbed', undefined)`, що тригерить `earn()` (`Game.ts:27`, `store.ts:16`) — безкінечні єБали одним викликом з консолі;
  - `renderer` (`Game.ts:11`) — доступ до сцени/камери/WebGL-рендерера та `dispose()`;
  - `physics` (`Game.ts:13`) — Rapier-світ; `Game.stop()` → `physics.dispose()` → `world.free()` (`Physics.ts:44`) — виклик ззовні = use-after-free/краш;
  - `goblin` FSM — `transition()` перемикає стани довільно;
  - `private`-поле `goblinBody` приватне лише на рівні TS — у рантаймі воно доступне з іменованого об'єкта.
  Для сторінки, вбудованої в інший сайт (iframe) або відвіданої з розширенням, це готовий інструмент маніпуляції/крашу для будь-якого стороннього скрипта на сторінці. Реальних «даних» тут нема (локальна гра), тому вплив обмежений цілісністю ігрового процесу — звідси середній, а не високий.
- **Мінімальний фікс:**
  ```ts
  declare global { interface Window { __game: Game | undefined } }
  if (import.meta.env.DEV) window.__game = game;
  ```
  Vite зробить присвоєння умовним і змерджить гілку в проді; зворотна сумісність тестів/дев-дебагу зберігається.

## F7. Низький — `EventBus.emit` не ізольований від винятків слухачів

- **Місце:** `src/core/Events.ts:15-16` — `emit(...): this.listeners.get(event)?.forEach((listener) => listener(payload as never));`
- **Чому:** один кинутий виняток у слухачі перериває `forEach` — решта слухачів події не отримають виклик. Це не вразливість, а стійкість: слухач — це контракт, а платіжний потік (`events.on('goblin:grabbed', ...) earn` у `Game.ts:27`) не має права гинути через чужий баг.
- **Мінімальний фікс:** обгорнути виклик:
  ```ts
  this.listeners.get(event)?.forEach((listener) => {
    try { listener(payload as never); } catch (error) { console.error(`[events] listener failed for ${String(event)}`, error); }
  });
  ```

## F8. Не-проблема — event-bus поверхня замкнена всередині сторінки

- **Дані:** grep `fetch\(|XMLHttpRequest|postMessage|addEventListener\(\s*['\"]message|WebSocket|document\.cookie|location\.|\bURL\(` по `src/` і `index.html` → **0 збігів**. EventBus не публікується через `postMessage`, не слухає `message`, не має мережевих виходів; payload-типи (`Events.ts:1-5`) — число/стрінг-стан/undefined. Єдиний споживач подій — `Game.ts:27`; єдиний `subscribe` — `hud.ts:11`. Ризик ін'єкції через «event payload → DOM» відсутній (цільового innerHTML-споживача подій просто не існує).

## F9. Низький — відсутній ліміт розміру збереження перед `JSON.parse`

- **Місце:** `src/core/Save.ts:32-38` — `loadGame` читає `raw` (`:34`) і парсить (`:36`) без обмеження довжини.
- **Чому:** localStorage обмежує ~5 МБ на origin, але довільний рядок з нього парситься «як є»; при пошкодженому/накрученому значенні (наприклад, інший скрипт чи користувач вручну записав велетенський об'єкт) ми отримуємо сплеск CPU/OOM на parse-етапі при кожному старті гри. Це DoS-площина проти самого гравця, не проти інших.
- **Мінімальний фікс:** перед парсом:
  ```ts
  const MAX_SAVE_BYTES = 256 * 1024;
  if (raw.length > MAX_SAVE_BYTES) return defaultSave();
  ```
  плюс (опційно) після серії невдалих парсів — `storage.removeItem(KEY)` щоб не парсити сміття на кожному запуску.

## F10. Середній — `validateSave` не має канонічної реконструкції: додаткові/аномальні ключі проходять далі

- **Місце:** `src/core/Save.ts:15-25` (схема), `:37` — `return validateSave(parsed) ? parsed : defaultSave();`.
- **Чому це має значення:** валідатор перевіряє лише відомі поля (`version`, `currency`, `inventory`, `placed`, `settings`, `lastSeenAt`), але `loadGame` повертає **весь** `parsed` обʼєкт разом із невідомими ключами (а `placed[i]` — з довільними додатковими полями, `inventory[i]` — з довільними строками без обмеження числа/довжини). Сьогодні додаткові ключі просто ігноруються, бо читання йде за відомими полями; ризик виникає при першому ж майбутньому deep-merge/save-міграційному коді, який робить `for (const k in parsed) target[k] = ...` — класичний вектор прототипного забруднення через ключі `__proto__`/`constructor` (див. F11: поточних merge-сінків немає, але контракту «only known fields» теж немає).
- **Мінімальний фікс (канонізація):**
  ```ts
  export function loadGame(storage: Pick<Storage, 'getItem'> = localStorage): SaveData {
    try {
      const raw = storage.getItem(KEY);
      if (!raw || raw.length > MAX_SAVE_BYTES) return defaultSave();
      const parsed: unknown = JSON.parse(raw);
      if (!validateSave(parsed)) return defaultSave();
      return {
        version: 1,
        currency: parsed.currency,
        inventory: [...parsed.inventory],
        placed: parsed.placed.map((e) => ({ itemId: e.itemId, position: [e.position[0], e.position[1], e.position[2]] as [number, number, number] })),
        settings: { locale: parsed.settings.locale, sound: parsed.settings.sound },
        lastSeenAt: parsed.lastSeenAt,
      };
    } catch { return defaultSave(); }
  }
  ```
  Це гарантує: тільки відомі поля, довжина масивів обмежена (`inventory.slice(0, 200)`), жодних чужих ключів. Додати тест: `loadGame`-обʼєкт не мати власних ключів поза схемою (`Object.keys(save)` — сукупність очікуваних).

## F11. Не-проблема — прототипне забруднення через ключі `__proto__`/`constructor` на сьогодні неможливе (доведено пробою)

- **Дані:** у `src/` немає жодного bracket-присвоєння чи deep-merge для даних збереження (grep `__proto__|constructor\b|Object\.assign` → збіги лише з TS-конструкторами класів). `saveGame` (`Save.ts:28-29`) пише новий літерал обʼєкта — зворотний шлях чистий. `storeBase.ts:5` розгортає `{ ...state, ...patch }` — `patch` типізований як `Partial<S>` і не приймає save-дані.
- **Емпірична проба (Node 22):** `JSON.parse('{"__proto__":{"polluted":"yes"},...}')` створює **властивість-дані** `__proto__` (не змінює прототип); `{...parsed}` і `Object.assign({}, parsed)` у цій конфігурації **не** забруднюють `Object.prototype` (перевірено: `({}).polluted === undefined` після обох операцій).
- **Висновок:** поточний код «parse → validate → read known fields» безпечний проти цього вектора; загроза з'явиться тільки разом із майбутнім кодом deep-merge (див. F10 — канонізація закриває заздалегідь).

## F12. Не-проблема (дизайн-нота) — міграції збереження: строгий шлюз version === 1

- **Місце:** `src/core/Save.ts:18` — `data.version === 1`; схема жорстко вимагає точної версії.
- **Чому це не проблема:** майбутня версія 2 save просто відкатиться на дефолт (втрата прогресу, а не інʼєкція) — безпечна відмова. Увага на майбутнє: коли з'явиться версія 2, валідатор має приймати `version >= 1 && version <= CURRENT` і мігрувати в один крок (v1→v2), не через `eval`/динамічний код, а через явні мапінги полів.

## F13. Не-проблема — відсутнє динамічне виконання даних

- **Дані:** grep `\beval\s*\(|new Function|Function\(|import\(|require\(|setTimeout\(\s*['\"]|document\.write` по `src/` і `index.html` → єдиний збіг `src/core/Game.ts:14` — це **type-position** `import('@dimforge/rapier3d-compat').RigidBody` (type-level import, стирається компілятором, у рантаймі не виконується). У бандлі `dist/assets/index-B95MhukY.js` немає `eval(`/`new Function` (grep: 0; інший збіг `innerHTML` — це саме F1). `config/game.json` (читається у `Game.ts:7`, `Physics.ts:2`, `Renderer.ts:2`, `Goblin.ts:3`, `store.ts:2`, `Save.ts:2`) використовується як дані геометрії/фізики/економіки — жодна строка з нього не виконується і не потрапляє в DOM; числа (`fixedStep`, `gravity`, `earnPerGrab: 3`) далі проходять через `Number.isFinite` гварди (`store.ts:16,18`). `RAPIER.init()` інстанціює WebAssembly (у бандлі 7 звернень до `WebAssembly`) — це очікувана поведінка фіз-движка, не виконання користувацьких даних.

## F14. Низький — зовнішній Google Fonts `@import` у стилях

- **Місце:** `src/style.css:1` — `@import url('https://fonts.googleapis.com/css2?family=Nunito:wght@500;700;900&display=swap');`. Реально потрапляє у прод (`dist/assets/index-CG4a65bG.css`, перевірено першим рядком), тож при кожному рендері тайтла браузер робить запит до Google — витік IP/Referrer гравця до третьої сторони у суто локальній грі.
- **Мінімальний фікс (варіанти):**
  1. self-host: покласти шрифти у `public/fonts/`, `@font-face` локально (найкраще для CSP й приватності);
  2. або залишити, але тоді CSP мусить явно дозволити `style-src https://fonts.googleapis.com; font-src https://fonts.gstatic.com;` (див. F15) і приймати зовнішній запит.

## F15. Середній — відсутня CSP у побудованому бандлі

- **Місце:** `index.html:3-8` та `dist/index.html` — `<head>` містить лише `charset/viewport/theme-color` + `<script src>`, жодного `Content-Security-Policy` meta (перевірено).
- **Чому це має значення:** якщо тайтл коли-небудь вбудують в iframe стороннього сайту, або до сторінки потрапить будь-який інжектований скрипт (розширення, компрометація CDN-шрифту у F14), CSP — останній бар'єр. Бандл статичний і добре піддається strict-політиці: скрипт один, зовнішній (`dist/index.html:8`), стилі зовнішні, мережевих викликів у коді немає (F8), потрібен лише `wasm-unsafe-eval` через Rapier (F13).
- **Конкретний CSP для `dist/` (meta, додається на збірці):** через плагін у `vite.config.ts`, щоб не ламати dev-сервер (HMR потребує inline/websocket):
  ```ts
  // vite.config.ts
  const cspPlugin = {
    name: 'csp-inject',
    apply: 'build' as const,
    transformIndexHtml: () => [{
      tag: 'meta',
      attrs: {
        'http-equiv': 'Content-Security-Policy',
        content: [
          "default-src 'self'",
          "script-src 'self' 'wasm-unsafe-eval'",   // wasm-unsafe-eval — для Rapier WASM (F13)
          "style-src 'self' https://fonts.googleapis.com", // до self-host шрифтів (F14)
          "font-src https://fonts.gstatic.com",
          "img-src 'self' data:",
          "connect-src 'self'",
          "object-src 'none'",
          "base-uri 'none'",
          "form-action 'none'",
        ].join('; '),
      },
      injectTo: 'head',
    }],
  };
  export default defineConfig({ base: './', plugins: [cspPlugin], test: { environment: 'node', include: ['src/**/*.test.ts'] } });
  ```
  **Header-варіант (хостинг/обгортка, додає те, чого meta не вміє):**
  ```
  Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  ```
  Примітка: `frame-ancestors` ігнорується у meta-тегах — якщо проти embedding треба захиститись, це робиться тільки HTTP-заголовком. Після self-host шрифтів у F14 заголовкову політику можна затягнути до `style-src 'self'`.

---

## Проведені перевірки (фактично виконані, для відтворюваності)

1. **Повне прочитання кожного файлу джерел із номерами рядків** (`cat -n`): `src/main.ts`, `src/core/{Game,Physics,Renderer,Save,Events,i18n,random,storeBase,game.test}.ts`, `src/entities/Goblin.ts`, `src/state/{store,config/game.json}`, `src/ui/hud.ts`, `src/style.css`, `index.html`, `vite.config.ts`, `tsconfig.json` — усі `file:line` у звіті взяті з цих читань.
2. **Grep-патерни (по `src/` + `index.html`):**
   - DOM-сінки: `innerHTML|outerHTML|insertAdjacentHTML|textContent|createContextualFragment|DOMParser|\.html\(` → збіг тільки `hud.ts:4` (innerHTML) та `hud.ts:9` (textContent).
   - Виконання: `\beval\s*\(|new Function|Function\(|import\(|require\(|setTimeout\(\s*['\"]|document\.write` → тільки type-import `Game.ts:14`.
   - Мережа/обмін: `fetch\(|XMLHttpRequest|postMessage|addEventListener\(\s*['\"]message|WebSocket|document\.cookie|location\.|\bURL\(` → 0 збігів.
   - Сховища: `localStorage|sessionStorage` → тільки `Save.ts:26,32`.
   - Прототипи/merge: `__proto__|constructor\b|Object\.assign|\.\.\.parsed|\.\.\.data\b|prototype\[` → збіги лише з конструкторами класів.
   - Споживачі збережень/хуків: `loadGame|saveGame|validateSave|setLocale|window.__game|__game` → збереження використовуються лише у `game.test.ts`; `window.__game` — тільки `main.ts:11-12`.
3. **Бандл:** `grep -oE "eval\(|new Function|WebAssembly|innerHTML" dist/assets/index-B95MhukY.js` → `innerHTML ×1` (F1), `WebAssembly ×7` (Rapier), `eval`/`new Function` — 0; зовнішні URL у бандлі — тільки `http://www.w3.org/1999/xhtml` (namespace, не запит); `window.__game` присутній у прод-бандлі (1 збіг); `dist/index.html` без CSP-meta; `dist/assets/index-CG4a65bG.css` містить Google Fonts `@import`.
4. **npm audit:** `npm audit` → `5 vulnerabilities (1 critical, 1 high, 3 moderate)`; `npm audit --omit=dev` → `found 0 vulnerabilities`; `npm audit --json` (розпарсено скриптом) → `vite` = high (GHSA-fx2h-pf6j-xcff, GHSA-4w7w-66w2-5vf9, GHSA-v6wh-96g9-6wx3), `esbuild` = moderate (GHSA-67mh-4wv8-2f99), `vitest` = critical (GHSA-5xrq-8626-4rwp / CVE-2026-47429, CVSS 9.8) + `@vitest/mocker` moderate (GHSA-82fw-gwwq-j7x9); fixAvailable = `vitest@5.0.2` (semver-major).
5. **npm outdated:** three 0.170.0→0.186.1; @dimforge/rapier3d-compat 0.14.0→0.21.0; vite 6.4.3→8.3.1; vitest 2.1.9→5.0.2; typescript 5.9.3→7.0.2.
6. **Lockfile-верифікація:** кореневий `vite@6.4.3` (patched для GHSA-fx2h-pf6j-xcff); вразливі дублікати — `vitest/node_modules/vite@5.4.21`, `vite-node/node_modules/vite@5.4.21`, `esbuild@0.21.5` у вкладених шляхах; продуктові залежності без postinstall-скриптів.
7. **Прототипна проба (node):** JSON.parse `{__proto__:{…}}` — власна властивість-дані; `{...parsed}` та `Object.assign({}, parsed)` у Node 22.23 не забруднюють `Object.prototype` (перевірено).
8. **Тести:** `npm test` → `5/5 passed` (базова цілісність не зламана аудитом).
9. **Верифікація advisories у вебі:** патчі-версії GHSA-5xrq-8626-4rwp (vitest 3.2.5/4.1.0+, CVE-2026-47429) та GHSA-fx2h-pf6j-xcff (vite 6.4.3/7.3.5/8.0.16) — збігаються з висновками audit.

## Топ-5 пріоритетних дій

1. **Підняти `vitest` до ^5.0.2** (`npm i -D vitest@^5.0.2`) — знімає критичний GHSA-5xrq-8626-4rwp, високий вкладений vite 5.4.21 (GHSA-fx2h-pf6j-xcff), moderate esbuild/@vitest/mocker одним рухом; після цього `npm audit` очікувано `0 vulnerabilities`. Ніколи не запускати Vitest UI з `--api.host` назовні.
2. **Приховати `window.__game` у прод-бандлі** — у `main.ts:12` обгорнути присвоєння в `if (import.meta.env.DEV)`; тим самим зникає зовнішній доступ до `events.emit` (безшумна видача єБалів), `physics.dispose()`/`world.free()` (краш) та сцени.
3. **Додати CSP до прод-збірки** — плагін `csp-inject` з F15 до `vite.config.ts` (meta з `'wasm-unsafe-eval'` для Rapier), плюс header `frame-ancestors 'none'` + `X-Content-Type-Options: nosniff` на хостингу; після self-host шрифтів (F14) затягнути `style-src` до `'self'` тільки.
4. **Захарднити DOM-сінк перед появою динаміки** — `hud.ts:4-7`: ввести `esc()`/`textContent` правило для всіх інтерполяцій і запровадити його як обовʼязковий для майбутніх шопу/попапів; i18n зберегти типізованим словником, не пускати туди save/конфіг-дані без екранування.
5. **Канонізувати збереження** — у `Save.ts`: ліміт розміру (`MAX_SAVE_BYTES`), реконструкція обʼєкта тільки зі схемових полів (F10) + обмеження кількості елементів `inventory`/`placed`; додати юніт-тест на сторонні ключі й розмір. Це одночасно готує каркас для безпечної майбутньої міграції версій save (F12).