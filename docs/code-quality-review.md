# Code Quality Review — Бавовна Simulator (cotton-farm)

- **Дата:** 2026-09-29
- **Ревʼювер:** senior code-quality review (read-only); єдиний запис — цей файл.
- **Обсяг усього коду:** 12 TS-файлів (~370 рядків) + `game.json` + `style.css`.
- **Метод:** кожен `file:line` нижче перевірено через `read_file`/`grep -n` перед цитуванням;
  команди перелічено в розділі «Виконані перевірки». Динамічні твердження підтверджено
  headless-пробами Rapier (позначено «EMP»).
- **Базові перевірки на момент ревʼю:** `npx tsc --noEmit` → exit 0; `npx vitest run` → 5/5 pass;
  `npm run build` → exit 0 (попередження про chunk 2561 kB).

Позначки пріоритетів: **P0** = блокер (ламає гру/пошкоджує збереження/тоне-порушення плану),
**P1** = важливо до Milestone 4–5, **P2** = скоро, **P3** = дрібниці.

---

## 1. Архітектурна відповідність плану

План (розділи 3, 4, 13, 15 blueprint `bavovna-simulator-plan.md`) вимагає:
core/Game,Renderer,Physics,Events,Save,i18n; entities/Goblin; systems/ScoringSystem,ShopSystem…;
ui DOM-оверлей; усі балансні числа у `state/config/*.json`; зв'язок через event bus.

| Вимога плану | Статус | Де |
|---|---|---|
| core-модулі | ✅ фактично є | `Events.ts`, `Save.ts`, `i18n.ts`, `storeBase.ts`, `Renderer.ts`, `Physics.ts`, `Game.ts` |
| entities/Goblin | ✅ / ⚠️ змішана відповідальність | `GoblinFSM` чистий, але його *рух* живе в `Game.ts` |
| systems/ (Scoring, Shop, Farm…) | ❌ відсутні повністю | немає жодного файлу в `src/systems/` |
| ui (Shop, Settings, Achievements) | ❌ лише HUD-стаб | `ui/hud.ts` — кнопки без обробників |
| Input.ts | ❌ відсутній | керування камерою вписане прямо в `Renderer.ts:38–48` |
| Балансні значення в JSON | ⚠️ частково | см. розділ 3 |
| Event-bus декомпозиція | ⚠️ частково | см. нижче |
| Чисті функції для скорингу | ❌ | немає скорингу взагалі |

### A-1. `Game.ts` — моноліт-богоб'єкт (P1)
`Game` одночасно: фізичний оркестратор, AI-водій, 3D-модельєр дiорами, аніматор, перемотувач
стану. План відводить це окремим модулям.

**Наслідки:**
- логіка руху гобліна (переслідування, дрейф до горщика, `hitImpulse`) захардкоджена в
  `Game.ts:102–131`, хоча належить entities/ Goblin;
- диорама (`createDiorama`, `Game.ts:60–101`) — це майже половина файлу; має бути `entities/Prop.ts` /
  окремий `world.ts`;
- FSM-параметри, що залежать від кінематичного дублювання (`Game.ts:46` передає дистанцію, яку
  сам же рухає), роблять FSM нетестовим у реальних умовах.

**Виправлення (рецепт):**
1. Витягнути `updateGoblin` → `entities/GoblinController.ts` (отримує body + FSM).
2. Витягнути `createDiorama` → `entities/Prop.ts` або `world/diorama.ts`, який повертає опис
   об'єктів сцени.
3. Залишити `Game` = `start/stop/tick` + реєстрація систем.

### A-2. Гібрид кінематичної та фізичної логіки гобліна (P1)
`Game.ts:107–109`: позиція тіла, якою керує фізика, *дампиться* до цілі через
`THREE.MathUtils.damp`, а отриманий офсет ділиться на `delta`, щоб стати швидкістю:

```ts
const x = THREE.MathUtils.damp(targetX, 0, config.goblin.speed, delta);
const z = THREE.MathUtils.damp(targetZ, 0.9, config.goblin.speed, delta);
this.goblinBody.setLinvel({ x: (x - targetX) / Math.max(delta, 0.001), ... });
```

Це не «капсула з upright spring», як описано в плані (`plan.md:101`), а кінематичний
перемотчик, з glued поверх фізики; при `delta → 0` швидкість → нескінченність (гардовано
`0.001`, але сама модель швидкості неадекватна). План пропонує рух через steer-силу/impulse:
`body.applyImpulse({ x: steerX * dt, ... })` або `setLinvel` на *цільовій швидкості*
`v = normalize(target - pos) * speed`.

### A-3. Event bus існує, але майже не використовується (P2)
Події оголошені й використані так (`Events.ts:1–5`):

| Подія | emit | on |
|---|---|---|
| `currency:changed` | — ніде | — ніде (**мертва** в протоколі) |
| `goblin:state` | `Goblin.ts:16` | — ніде (**мертва** для UI) |
| `goblin:grabbed` | `Goblin.ts:17` | `Game.ts:27` → безпосередній `useGameStore.getState().earn(...)` |

План (`plan.md:91`) хоче `goblin:hit`, `trap:triggered`, `combo:chain`, `coins:earned`.
Правильно: підписуватися на події з UI/систем, а не викликати store прямо з конструктора
`Game` (`Game.ts:27`). Тут порушено і принцип «systems communicate via bus» —
`earn` виконується *синхронно всередині emit*, а тому кидає всередину фізичного кроку.

### A-4. Глобальний синглтон стору як вбудований канал (P1)
`useGameStore` — module-level singleton, імпортований прямо в `Game.ts` і в тести. Це
проти «single source of truth, injected»; унеможливлює паралельні ігрові сесії ( і
планові UI-тести) у одному процесі. Правильно: створювати стор у `main.ts` та передавати
в конструктор `Game({ store, events, config })`.

### A-5. Відсутні системи взагалі (P2 на даний момент, P1 перед М4)
План вимагає системи Scoring/Farm/Shop/Achievement/Ambience. В репо немає каталогу
`src/systems/`, а скоринг/шоп/інвентар фактично розмиті: `inventory`/`placed` оголошені в
store (`store.ts:5–6`) і ніде не використані в проді; кнопки Shop/Settings у HUD
(`hud.ts:5`) — мертві.

---

## 2. TypeScript-дисципліна

`tsconfig.json` strict ✅. `npm run tsc --noEmit` → exit 0. Жодних `any`, жодних `!.`.
Проблеми нижче — реальні, але не критичні.

### T-1. Небезпечні definite-assignment `!` в Game (P2)
`Game.ts:13–14`:
```ts
physics!: Physics;
private goblinBody!: import('@dimforge/rapier3d-compat').RigidBody;
```
Це дозволяє виклики `physics.step()` ще **до** `await start()`, з падінням у рантаймі.
План (13-й розділ blueprint) радить детермінізм — краще:
```ts
private physics: Physics | null = null;
```
і ранній return у `tick` поки `!this.physics`. Ще простіше — винести створення
фізики/тіла в `createDiorama()` і викликати все в конструкторі через `await init()`.

### T-2. Внутрішні casts у EventBus (P2)
`Events.ts:11–16` використовує подвійні `Listener<never>` casts, які вимикають перевірку
типів payload-ів:
```ts
bucket.add(listener as Listener<never>);
emit: list(payload as never)
```
Робочий патерн:
```ts
type Handler = (payload: never) => void;
private listeners = new Map<keyof Events, Set<Handler>>();
on<K extends keyof Events>(k: K, fn: (p: Events[K]) => void) {
  const set = this.listeners.get(k) ?? new Set();
  set.add(fn as Handler);
  ...
}
emit<K extends keyof Events>(k: K, p: Events[K]) {
  this.listeners.get(k)?.forEach(fn => (fn as (q: Events[K]) => void)(p));
}
```
Варто принаймні додати `satisfies` або юніт-тест на типобезпеку.

### T-3. Відсутність типу в протоколі подій (P3)
`Events.ts:3`: `'goblin:state': { state: string }` — строковий union `GoblinState` типізує
лише FSM (Goblin.ts:5). Повинно бути `'goblin:state': { state: GoblinState }`, і тоді
UI не зможе показати неіснуючий стан.

### T-4. `validateSave` приймає object із прототипним забрудненням (P3)
`Save.ts:17`: `const data = value as Partial<SaveData>` — object spread у `saveGame`
безпечний, але `JSON.parse` може вернути об'єкт з `__proto__`-полем, яке
`{ ...settings }` у майбутньому коді скопіює небезпечно. Додатково `currency` не
обмежено зверху (не критично). Радимо `Object.hasOwn`-перевірки для майбутніх полів.

---

## 3. Магічні числа vs план «data-driven»

Правило плану (`plan.md:87`, `plan.md:292`): «Balancing the game must never require code
changes»; «reject any code that hardcodes balance values».

**Кількісний вимір** (скрипт-скан, див. розділ «Виконані перевірки»):
- raw-скан усіх числових літералів поза config: **113 входжень** у
  `Game.ts:76`, `Renderer.ts:25`, `Physics.ts:12`;
- після вилучення дублів, індексів, segment-count, 0/1, `Math.PI/2`, байтів градієнту:
  **78 різних значень**; з них справді *тюнінгові* (фізика/гeймплей/анімація/камера/світло):
  **~64**.

Найшкідливіші (впливають на геймплей чи баланс і мусять жити в `game.json`):

| # | Місце | Значення | Що це |
|---|---|---|---|
| M-1 | `Game.ts:32,48` | `-2.7, 0.8, -0.5` | точка спавну/респавну гобліна (дублюється 2×) |
| M-2 | `Game.ts:46,108` | `0.9` | z-ціль горщика — інший дублікат `config.yard.potPosition[2]` |
| M-3 | `Game.ts:40` | `0.1` | max delta frame — має бути `config.physics.maxFrameDelta` |
| M-4 | `Game.ts:118–119` | `delta*2`, `0.55` | вікно удару та частка вертикального імпульсу |
| M-5 | `Game.ts:121,123,128` | `15`, `0.42`, `18`, `0.08`, `2.8` | анімаційні частоти/амплітуди (flop/pulse/stars) |
| M-6 | `Game.ts:46,129` | `-4`, `-5` | межа «offscreen» для FSM і для видимості (два РІЗНІ числа для одного поняття!) |
| M-7 | `Physics.ts:16,20,42` | `1.4, 2.2, 0.8, 0.05, 4, 0.16, -0.08` | дампінги тіла, тертя, restitusія, підлога |
| M-8 | `Renderer.ts:5,11–13,24–32` | `34°,0.1,100,0.55,1.08,9,14,28,1.55,3.1,(−5,9,4),±8` | камера/туман/світло/тіні |
| M-9 | `Game.ts:62–97` | ~40 літералів | розміри/позиції всієї дiорами (`0.54,0.43,0.63…`) |

**Топ-3 для негайного виносу в `game.json`:** M-1 (`spawnPos`), M-6 (`offscreenZ` — ОДНЕ
значення), M-4/M-5 (`hitImpulseYFraction`, анімаційні `flopFreq`/`flopAmp`/`pulseFreq` /
`pulseAmp`/`starsSpinSpeed`).

### Кольори — теж дані, а не код (P3)
`Game.ts:62–96`, `Renderer.ts:24–27` вшивають ~14 hex-рядків. План (розділ 1, 7) прямо
зобов'язує тримати айдентику в даних: `state/config/palette.json` +
`data-driven диорама-опис`.

---

## 4. Мертвий код / невикористані експорти

| Що | Де | Статус |
|---|---|---|
| `createStore` API: `subscribe`-unsub використовується лише hud; сам `storeBase` ок — | `storeBase.ts` | живий |
| `events` у `GoblinFSM` — `events?:` optional, але в проді завжди передається | `Goblin.ts:12` | запах: два режими |
| Події `'currency:changed'` | `Events.ts:2` | ОГОЛОШЕНА, ніхто не emit/не on — мертва |
| `t('pot')` і інші ключі словника | `i18n.ts:3` (`pot`) | жодного `t('pot')` — мертвий ключ |
| `setLocale()` | `i18n.ts:7` | ніхто не викликає в проді → перемикач мови не існує |
| `loadGame`/`saveGame` | `Save.ts:26–39` | не викликається в проді (ні main, ні Game) — **автозбереження не підключене** |
| `src/tests/` — порожній каталог | — | мертвий; план радить десь тримати Playwright |
| `settings.sound` | `store.ts:7` | оголошене, ніхто не читає (аудіо відсутнє) |
| `inventory`, `placed` (прод) | `store.ts:5–6` | оголошені, оновлювані лише тестом; ShopSystem відсутній |

### D-1. Кнопки HUD — мертві елементи інтерфейсу (P2)
`hud.ts:5` малює `<button>Крамниця</button>` і `<button>Налаштування</button>` без
`addEventListener`. Користувач тицяє — нічого. Щоразу, коли хтось грає, він бачить поламану
функціональність. Мінімальний виправлення: у `mountHud` додати обробник, який
показує alert-модалку «в розробці» або `console.warn` — або не показувати кнопки взагалі
до М3.

### D-2. `stars` оновлюються навіть коли невидимі (P3)
`Game.ts:125–128`: `this.stars.rotation.y += delta * 2.8` виконується щокадру навіть коли
`stars.visible === false`. Дрібна непродуктивна робота; або рано виходити з visible=false,
або обертати лише під час `Stunned`.

---

## 5. Обробка помилок

### E-1. Віялопудра: Rapier `init()` не спійманий — білий екран без діагностики (P0)
`main.ts:10`:
```ts
void game.start();
```
`start()` → `Physics.create()` → `RAPIER.init()` фетчить WASM. Будь-який сет-ап без
`unhandledrejection` = непояснений чорний/білий екран і «гра падала» без логу.

**Конкретне виправлення:**
```ts
game.start().catch((err) => {
  document.body.innerHTML = `<div class="fatal">Помилка завантаження: ${String(err)}</div>`;
  throw err;
});
```
+ глобальний `window.addEventListener('unhandledrejection', ...)` у main.

### E-2. Слухачі подій без try/catch усередині fixed-timestep (P0)
Це головна ризик-зона. Ланцюг на кожен фізичний крок:
`Physics.world.step() → GoblinFSM.update → events.emit('goblin:grabbed') →
listener → earn() → set() → listeners.forEach(hud update → Intl.NumberFormat …)`
(`Game.ts:43–56`, `Events.ts:15–17`, `Goblin.ts:17`, `Game.ts:27`, `storeBase.ts:5`,
`hud.ts:9`).
Перевірено (EMP): кидок у будь-якому слухачі = UNCAUGHT виключення, яке рве
requestAnimationFrame петлю → «заморожена» 3D-сцена, жодних еБалів, втрачений save.

**Виправлення** (обидва, захист у глибину):
```ts
// Events.ts
emit<K extends keyof Events>(event: K, payload: Events[K]): void {
  this.listeners.get(event)?.forEach((listener) => {
    try { listener(payload as never); }
    catch (err) { console.error(`[events] ${String(event)} handler failed`, err); }
  });
}
```
плюс обгортка `tick` у try/catch (лог + перезапуск RAF), щоб падіння однієї системи
не вбивало цикл.

### E-3. Локальний localStorage: save не захищено від квоти/приватного режиму (P1)
`Save.ts:29`: `storage.setItem(KEY, …)` без try/catch — в iOS Private Mode або при
переповненій квоті це кидає `QuotaExceededError`, і виклик всередині ланцюга підписки
(як тільки появиться автозбереження) знову б'є по грі. Обгортка:
```ts
try { storage.setItem(KEY, JSON.stringify(data)); }
catch { console.warn('[save] write failed; continuing in memory'); }
```

### E-4. `dispose()` витікає: слухачі ResizeObserver і pointer (P1)
`Renderer.ts:36–48`: `ResizeObserver` не `disconnect()`-иться, pointer listeners
не знімаються. На HMR/перезапуску `new Game(mount)` старий обсервер продовжує
`this.resize()` на мертвому контексті, а pointermove на від'єднаному canvas все ще
`dragging`-ить. Зберігати `resizeObserver` полем і робити `disconnect()` у `dispose`,
`canvas` listeners знімати (або, принаймні, `{ once: false }`-обгортку з abort-контролером).

### E-5. `goblinBody` може не існувати на першому кадрі (P2)
`tick` стартує відразу після `physics.dispose`-цикл? Ні, `start()` await-ить `Physics.create()`,
але якщо `start()` не був викликаний (наприклад, у тестах, що рендерять `Game` без `start`),
`tick` не запуститься теж — OK. Але `stop()` звертається до `this.physics?.dispose()`, а
`goblinBody` — ні; додайте гард.

---

## 6. Тестове покриття vs план

План (розділ 13) вимагає юніт-тести: **reward calculation, combo timing, crop growth +
offline catch-up, save migration, shop transactions**; Playwright smoke.

Поточний стан: 1 файл, 5 тестів (`game.test.ts`), всі зелені.

| Вимога плану | Статус | Чого бракує |
|---|---|---|
| reward calculation | ❌ | немає ScoringSystem; тест для `earn`+`spend` є, для бонусів нема |
| combo timing (×1.5/×2/×3/×4 cap) | ❌ | комбо-системи немає |
| crop growth + offline catch-up | ❌ | ферми немає |
| save migration | ❌ | схема лише v1: міграційного ходу немає, тест теж |
| shop transactions | ❌ | shops немає |
| FSM-стани, spring | ✅ частково | 2 тести |
| валідація save | ✅ частково | корупція JSON є; невалідна *схема* (напр. `version:2`) не покрита |
| Playwright smoke | ❌ | немає навіть `playwright.config` |

### TC-1. Пропоновані юніт-тести найближчого мілістону (P1)
1. `GoblinFSM`: `hit()` у стані `Sneak` → `Stunned`; `hit()` у стані `Flee` → ігнорується
   (вже так у коді, але це не закріплено тестом);
2. `Save`: `validateSave({version:2,…})` → false; `loadGame` повертає default (тестує
   майбутнє міграційне гачко);
3. `store.spend` рівно `0`, від'ємне, NaN, `Infinity` — усі мають бути відхилені;
4. `EventBus`: слухач, що кидає, не перешкоджає іншим слухачам (після T-3/E-2 фікса);
5. seeded RNG (`random.ts`): дві послідовності з однаковим сідом — ідентичні.

### TC-2. Тест швидкодії (P3)
План згадує автоматичний FPS/draw-call бенчмарк. Як мінімум додати budget-test, що
рендерить диораму headless і гортає `scene.traverse` -> кількість мешів ≤ N (зараз
≈14 мешів + 3 outline-шелли; ок для бюджету 150 draw calls).

---

## 7. i18n-витоки

Довідник (`i18n.ts:2–5`) uk/en — 6 ключів, всі використані, крім `pot` (мертвий).
Прямих hardcoded **рядків користувацького тексту в TS-коді** немає — добре.

Витоки є, але не в рядках коду, а в шарі, що не підключений до i18n:

| Місце | Рядок | Проблема |
|---|---|---|
| `index.html:6` | `<title>Бавовна Simulator</title>` | статичний uk-only `<title>`; план вимагає uk-перший, en-другий (це допустимо як дефолт, але слід міняти з `setLocale`) |
| `index.html:5` | `<html lang="uk">` | `lang` не оновлюється при перемкненні мови (функції перемикання немає) |
| `Game.ts:100, Renderer.ts` | — | коментарі українською/англійською — ок, не витік |
| `hud.ts:9` | `new Intl.NumberFormat('uk-UA')` | формат числа не залежить від активної мови → еБали відображатимуться «укр»-стилем для EN-користувача |
| `main.ts:7` | `'Mount points #app and #hud are required'` | техстрічка — ок (dev-only), але буде видно гравцю; краще i18n-ключ |
| `style.css:1` | Google Fonts Nunito без `uk`-специфічних підмножин | Nunito не містить повної кириличної підмножини у `text=` — але в `display=swap` URL підмножини вибирає браузер; додайте `&subset=`, не критично |

**Оцінка:** P3 — реальних витоків мало, бо UI-поверхня крихітна; але *механізм*
(`setLocale` → hud re-render → `html[lang]` → `<title>`) відсутній повністю.

---

## 8. Перформанс-запахи vs план (60 fps мобільний, <150 draw calls)

Цілі плану (`plan.md:48`): 60 fps моб/лаптоп, <25 MB, <150 draw calls, тіні — один
directional light з маленькою мапою.

### P-1. Один великий ресурс-чанк = 2561 kB (P1)
`npm run build` → `dist/assets/index-B95MhukY.js 2 561.27 kB │ gzip: 891.19 kB`.
Це **>10 %** від плану-бюджету 25 MB просто для JS (rapier WASM у base64-інлайні
додає ~50 %). Для «works in shelters with bad connectivity» потрібне код-спліттення:
three → `import('three')`, rapier → динамічний чанк (loader «Готуємо фізику…»).

### P-2. `new THREE.DataTexture` на кожен `toon()` (P1)
`Renderer.ts:50–55` — кожен виклик `toon(color)` створює **новий** 4×1 `DataTexture` з
однаковими байтами. `Game.createDiorama` викликає `toon` ~10 разів → 10 GPU-текстур
з однаковим вмістом та 10 матеріалів, коли потрібен 1 спільний gradientMap.
Виправлення:
```ts
private gradient?: THREE.DataTexture;
toon(color: THREE.ColorRepresentation) {
  this.gradient ??= (() => { const d = new Uint8Array([48,118,190,255]); const t = new THREE.DataTexture(d,4,1,THREE.RedFormat); t.needsUpdate = true; return t; })();
  return new THREE.MeshToonMaterial({ color, gradientMap: this.gradient });
}
```

### P-3. Кожен об'єкт = свій draw call, outline ≠ інстансинг (P2)
Зараз ~15 об'єктів + 3 `addOutlined`-шелли → ~18 draw calls. Бюджет 150 поки що з
запасом, але кожен новий prop/stem додає ×2 (mesh+outline). Колись дійдеться
до ліміту на звичайних декораціях — плануємо інстансинг (`InstancedMesh`) для
`stems`/`stars` одразу.

### P-4. Тінь: PCFSoftShadowMap 512² на мобільному (P2)
`Renderer.ts:18, 30`: PCFSoftShadowMap + `mapSize 512` — ок, але немає якості-пресетів
(Low/Med/High) з плану (розділ 7). На слабких телефонах shadowMap 512 з 3
shadow-caster-ами дасть фрізи. Додатково: `side`-меш (0.4 висоти) і `soup` не
кастують тінь (добре), `stem`×7 — так. Слід знати, що після M3 (props) тіні
підуть угору.

### P-5. Per-frame алокації в `tick`/`updateGoblin` (P2)
`Game.ts:46`:
```ts
this.goblinGroup.position.distanceTo(new THREE.Vector3(0, 0, 0.9))
```
— **новий Vector3 на кожен фізичний крок** (до 60/с). Плюс `Game.ts:109,112,119` —
нові об'єкти `{x,y,z}` для `setLinvel`/`applyImpulse` на кожен крок. У Three/Rapier
це дрібні, але постійні алокації; на мобільному GC дасть мікрофрізи.
Виправлення:
```ts
private readonly potTarget = new THREE.Vector3(0, 0, 0.9); // у конструкторі
const dist = this.goblinGroup.position.distanceTo(this.potTarget);
```
та перевикористання поля `_vec: Vector3` / об'єктів-констант для rapier викликів.

### P-6. `renderer.render` продовжує працювати коли станиця схована (P3)
RAF сам не тікає у фоні — ок; але `document.visibilitychange` краще явно зупиняти
фізичні кроки, щоб після повернення не було «стрибка» (хоча `delta` обрізана 0.1 — теж
ок). Мінор.

### P-7. Інстанси HUD DOM не оновлюються, поки валюта не змінилася (P3)
`hud.ts:9–11`: `update()` викликається на кожен `set()` стору, навіть якщо патч
не стосувався `currency`. Дрібниця зараз; стане гарячою після додавання shop/farm
(багато `set()` на кадр). Правильно: селективна підписка на поле або порівняння
prev/next.

---

## 9. Найменування та стиль

- Файли/класи послідовні (`GoblinFSM`, `EventBus`, `createRng`) ✅.
- Змішана мова ідентифікаторів: `currency`/`earn`/`spend` (англ.) у домені, де план
  каже «єБали» — ок, це не витік, це переклад домену; рекомендовано закріпити
  `currency` у коді і `єБали` лише в UI (так вже і є).
- `hud.ts:9` `new Intl.NumberFormat('uk-UA')` — константний форматер краще винести на
  модульний рівень (алокація раз, не на кожен апдейт).
- `Renderer.ts:70` `scene.userData.addOutlined = (…) => …` — функції, що живуть у
  `userData`, не типізуються і не видно в IDE. Краще `renderer.addOutlined(mesh)`
  як метод класу.
- `Game.ts:118` `this.goblin.elapsed < delta * 2` — код «перший крок після удару»,
  неочевидний; комент або іменована змінна `firstStunStep`.
- Тест `game.test.ts:15`: `goblin.respawnIn = 0;` — втручання в приватний стан замість
  передачі ігорного часу через `update` (краще абстракція для тестів, напр. `updateFor(seconds)`).

---

## 10. Перевірені факти (EMP) з доказом

**E-10.1. Upright-spring — знакове інвертування, що вибухає.** `Physics.ts:27–39` обчислює
`torqueX = upZ; torqueZ = -upX`, тобто `τ ≈ w_up × u` — це *позитивний зворотний зв'язок*
(поштовх далі від вертикалі), а не `u × w_up` (реставруючий). Плюс `UPRIGHT_SPRING=18`
застосовується як **повний torque impulse щокроку**, а не `torque * dt`.

Перевірено headless Rapier 0.14 (Rapier world + capsule + exact code з репо,
начальний tilt 0.35 rad, 60 Гц):

| Тест | Результат |
|---|---|
| Репо-код (spring on, 1 с) | tilt 0.35 → 2.34 рад за 1 крок → **NaN (w) на 8-му кроці**; тіло зникає |
| Без spring | tilt лишається 0.35 (контроль: без вибуху) |
| Знак виправлено + імпульс×dt + явний damp | все одно NaN@31 (K=18 × dt × dt нестабільний з damp) |
| Знак виправлено + імпульс×dt, damp через `angularDamping=2.2` | **tilt 0.212 → 0.001 стабільно** ✅ |

Тобто сьогодні будь-який удар по гобліну (Stunned → spring off → Recover → spring on
при ненульовому нахилі) має шанс моментально перетворити тіло на NaN — Rapier тоді
просто зупиняє симуляцію тіла (без крешу), гоблін «телепортується»/зникає з поля зору.

**Рекомендоване виправлення** (підтверджене пробою):
```ts
// Physics.ts — застосовувати на кожен фіксований крок, поки springEnabled
const upX = 2*(r.x*r.y - r.w*r.z), upZ = 2*(r.y*r.z + r.w*r.x);
body.applyTorqueImpulse({
  x: -upZ * config.goblin.uprightSpring * dt,
  y: 0,
  z:  upX * config.goblin.uprightSpring * dt,
}, true);
// і НЕ додавати ручний angular-damping термін: body.setAngularDamping(2.2) уже є
```
(`dt` = `config.physics.fixedStep`; `K=18` — залишити в config, але семантика змінюється
на «постійна пружини, Н·м/рад».)

> Примітка: попередня версія ревʼю приписувала вибух тільки знаку; проби показали, що
> і знак, і відсутність масштабування на `dt`, і ручний damp-терм — три незалежні
> причини; виправляти треба всі три разом.

---

## 11. Top-5 рефактор-беклогу

1. **E-1 + E-2 (P0):** безпечний boot (`game.start().catch(...)` + `unhandledrejection`)
   та try/catch у `EventBus.emit` і в `Game.tick`. Одна помилка слухача не має
   вбивати гральний цикл. Після цього — юніт-тест TC-1.4 (закріпити поведінку).
2. **P-1/P-2 архітектури (P1):** витягти `updateGoblin`/`createDiorama` з `Game.ts`
   в `entities/GoblinController.ts` + `world/diorama.ts`; `Game` стає тонким
   оркестратором (100→~40 рядків). Одночасно виправити подвійну систему руху
   (A-2) — steer через `applyImpulse`/`setLinvel` цільової швидкості.
3. **M-числа → `game.json` (P1):** винести топ-3 груп `spawnPos`, `offscreenZ`
   (одне значення), анімаційні константи; подалі — світло/камеру (`renderer.json`).
   Прийнятний критерій: жоден балансний літерал поза config, кроме кутових
   геометричних segment counts.
4. **Фізична стабильність upright-spring (P0-EMP):** виправити знак + `× dt` + делегувати
   damp `angularDamping` (+ юніт-тест на детермінізм: 10 хв симуляції з random
   поштовхами — жодного NaN у `body.rotation()`).
5. **Автозбереження + тест швидкодії (P2):** підключити `saveGame`/`loadGame` у `main.ts`
   (30 с інтервал + `visibilitychange`), обгорнути `setItem` у try/catch (E-3),
   додати Playwright smoke: boot → grab → earn → reload → баланс збережено
   (план, розділ 13).

---

## Виконані перевірки (команди)

```bash
# статичний аналіз
find src -type f -name '*.ts' | sort                       # інвентаризація
npx tsc --noEmit                                           # exit 0
npx vitest run                                             # 5/5 pass
npm run build                                              # exit 0; chunk 2561 kB

# точкові перевірки (grep -rn …)
grep -n 'setLocale|loadGame|saveGame|hit(|pot|currency:changed|goblin:state'
grep -rnE '\w!\.| as [A-Z]' src --include=*.ts              # definite-assign/casts
python: скрипт-підрахунок числових літералів (occurrences 113 → distinct 78)

# динамічні проби (EMP) — Rapier 0.14 headless, поза репо (/tmp, scratch):
#   tilt 0.35 rad, spring exact-code → NaN@8; без spring → 0.35;
#   sign-fix + dt + damp → NaN@31; sign-fix + dt, angularDamping → stable 0.001
node probe*.mjs                                            # вивід у розділі 10

# перехресний контроль плану
read blueprint sections 3,4,13,15 (bavovna-simulator-plan.md lines 32–95, 266–303)
```

### Self-check (читає-only підтвердження)
`git -C /Users/stepanpotiienko/morph status --porcelain -- cotton-farm` — єдиний NEW
запис після ревʼю: `?? cotton-farm/docs/code-quality-review.md` (див. фінальний звіт
батьківському агенту для точного виводу; коміт не виконано, жоден файлsource не змінено).