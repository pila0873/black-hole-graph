# Black Hole Graph

Obsidian-плагин, превращающий граф заметок в космическую систему:

- чёрная дыра Шварцшильда с трассировкой фотонных геодезических;
- аккреционный диск с плазменными филаментами, горячими пятнами, redshift и Doppler;
- папки становятся планетами, заметки — их спутниками;
- серые пунктирные связи и красные кометы между связанными объектами;
- процедурные планеты с рельефом, normal-map и атмосферными ореолами;
- процедурный звёздный atlas с разрешением до 8192×4096 и gravitational lensing.

> Проект находится в активной разработке. На слабых GPU используйте `Fast` и
> `Resolution scale = 0.5–0.75`.

## Установка из GitHub

1. Скачайте `main.js`, `manifest.json` и `styles.css` из [последнего релиза](../../releases/latest).
2. Создайте папку:

   ```text
   <Vault>/.obsidian/plugins/black-hole-graph/
   ```

3. Поместите туда эти три файла.
4. Откройте **Settings → Community plugins**, включите **Black Hole Graph**.
5. Запустите команду **Black hole graph: Open black hole graph**.

## Сборка из исходников

```powershell
git clone https://github.com/pila0873/black-hole-graph.git
cd black-hole-graph
npm install
npm run build
```

После сборки скопируйте `main.js`, `manifest.json` и `styles.css` в папку плагина.

Для локальной установки:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install.ps1 `
  -Vault "C:\Path\To\Your\Vault"
```

## Установка (вручную)

```powershell
npm install
npm run build
```

Скопировать `main.js`, `manifest.json` и `styles.css` в
`<ВашеХранилище>/.obsidian/plugins/black-hole-graph/`, перезапустить Obsidian,
включить плагин в **Settings → Community plugins**.

Или одной командой:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install.ps1 -Vault "D:\МоёХранилище"
```

Затем: иконка **orbit** на ленте слева или команда **Black hole graph: Open black hole graph**.

## Управление

| Действие | Что делает |
|---|---|
| Зажать и тащить | вращение камеры |
| Колесо | зум |
| Клик по планете | приблизиться к папке |
| Клик по заметке | открыть заметку |
| Ctrl/Cmd + клик | открыть в новой вкладке |
| `Esc` / Reset camera | вернуться к системе |

## Настройки

- **Quality** — `Cinematic` (полная трассировка геодезических) или `Fast`.
- **Resolution scale** — разрешение внутреннего рендера (0.5–1.5). Выше — резче, но медленнее.
- **Anti-aliasing** — FXAA финального изображения.
- **Frame rate cap** — 30 или 60.
- **Lensing** — искривление звёздного фона.
- **Disk temperature / brightness / thickness / bloom** — внешний вид плазмы.
- **Camera inclination** — угол камеры над плоскостью диска.
- **Orbit speed** — скорость обращения заметок.
- **Planet labels** — отображение названий папок.
- **Maximum notes** — сколько заметок попадает в сцену (ранжирование по числу связей).
- **Excluded folders** — папки, которые не участвуют.

## Разработка

```powershell
npm run dev            # esbuild watch -> main.js
npm run preview        # отдельная сборка для браузера (dev/preview.js)
npm run preview:serve  # http://localhost:8765/preview.html
```

`dev/preview.html` — изолированный харнесс: та же сцена (дыра + орбиты + карточки) без
Obsidian, с синтетическим графом на 55 заметок. Удобно для настройки шейдера.

Клавиши в превью: `F` — переключить fast mode, `N` — пересобрать случайный граф, `R` — сброс камеры.

### Структура

```
src/
  main.ts                 плагин: view, команды, настройки
  view/BlackHoleView.ts   ItemView, фокус камеры, ввод, связывание слоёв
  types.ts                контракты между слоями (планеты, ноты, кадр)
  scene/Camera.ts         орбитальная камера, проекция, перелёты
  scene/OrbitLayout.ts    папки -> планеты, заметки -> спутники, анимация
  scene/NoteLayer.ts      2D-слой: планеты, орбиты, карточки, кометы
  render/StarAtlas.ts     процедурное RGBA-звёздное небо
  graph/VaultGraph.ts     хранилище -> узлы и связи
  render/                 WebGL2: геодезические, объёмная плазма, atlas, FXAA
  render/Fallback2D.ts    отрисовка без WebGL2
  util/math.ts            математика, матрицы
```

Физика и решения описаны в `docs/PLAN.md`, актуальное ТЗ — в `docs/SCIENTIFIC_BLACK_HOLE_SPEC.md`
и `docs/STAR_ATLAS_PLANETS_COMETS_SPEC.md`.

## Лицензия

MIT
