const $ = (s, root = document) => root.querySelector(s);
const viewport = $('#viewport');
const canvas = $('#connections');
const context = canvas.getContext('2d');
const mapCanvas = $('#minimap');
const mapContext = mapCanvas.getContext('2d');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const camera = { x: 0, y: 0, scale: .5 };
const limits = { min: .045, max: 3 };
let data, world, selectedId = null, hoveredId = null, mode = 'family', targetId = null;
let highlight = { people: new Set(), edges: [], chain: [] }, frame = 0, animation = null;
let width = innerWidth, height = innerHeight, spaceHeld = false, dragging = false, suppressClickUntil = 0;
const people = new Map(), elements = new Map(), parents = new Map(), children = new Map(), adjacent = new Map();
const art = new Map(), touches = new Map();
let drag = null, pinch = null, searchIndex = -1, matches = [], toastTimer;
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const editable = el => !!el.closest('input,select,textarea,[contenteditable=true]');
const normalize = s => s.toLocaleLowerCase('ru').replaceAll('ё', 'е').normalize('NFKC').replaceAll('≈', '').trim();

function schedule() { if (!frame) frame = requestAnimationFrame(render); }
function toWorld(x, y) { return { x: (x - camera.x) / camera.scale, y: (y - camera.y) / camera.scale }; }
function resize() {
  const center = toWorld(width / 2, height / 2);
  width = innerWidth; height = innerHeight;
  camera.x = width / 2 - center.x * camera.scale;
  camera.y = height / 2 - center.y * camera.scale;
  const ratio = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
  positionStatus();
  schedule();
}
function positionStatus() {
  $('#status').style.top = width <= 1120 ? `${$('.relationship-bar').getBoundingClientRect().bottom + 8}px` : '21px';
}
function zoomAt(scale, x = width / 2, y = height / 2) {
  animation = null;
  const point = toWorld(x, y);
  camera.scale = clamp(scale, limits.min, limits.max);
  camera.x = x - point.x * camera.scale;
  camera.y = y - point.y * camera.scale;
  schedule();
}
function moveTo(destination, animate = true) {
  if (!animate || reducedMotion) { animation = null; Object.assign(camera, destination); schedule(); return; }
  animation = { from: { ...camera }, to: destination, started: performance.now(), duration: 280 };
  schedule();
}
function focusPerson(id, scale = Math.max(.7, camera.scale)) {
  const person = people.get(id); if (!person) return;
  const rightOffset = selectedId && width > 1120 ? 130 : 0;
  const destination = { scale: clamp(scale, limits.min, limits.max) };
  destination.x = (width - rightOffset) / 2 - (person.x + person.width / 2) * destination.scale;
  destination.y = height / 2 - (person.y + person.height / 2) * destination.scale;
  moveTo(destination);
}
function fitTree() {
  const marginX = width < 720 ? 28 : 60, top = width < 720 ? 170 : 160, bottom = 100;
  const scale = Math.min((width - marginX * 2) / data.width, (height - top - bottom) / data.height);
  moveTo({ scale, x: (width - data.width * scale) / 2, y: top + (height - top - bottom - data.height * scale) / 2 });
}
function fitHighlight() {
  const members = [...highlight.people].map(id => people.get(id)); if (!members.length) return;
  const x = Math.min(...members.map(p => p.x)), y = Math.min(...members.map(p => p.y));
  const right = Math.max(...members.map(p => p.x + p.width)), bottom = Math.max(...members.map(p => p.y + p.height));
  const availableWidth = width - (selectedId && width > 1120 ? 380 : 60), availableHeight = height - 250;
  const scale = clamp(Math.min(availableWidth / (right - x + 100), availableHeight / (bottom - y + 100), 1), limits.min, limits.max);
  moveTo({ scale, x: 30 + availableWidth / 2 - (x + right) / 2 * scale, y: 150 + availableHeight / 2 - (y + bottom) / 2 * scale });
}
function render(now) {
  frame = 0;
  if (!world) return;
  if (animation) {
    const t = clamp((now - animation.started) / animation.duration, 0, 1), eased = 1 - (1 - t) ** 3;
    for (const k of ['x', 'y', 'scale']) camera[k] = animation.from[k] + (animation.to[k] - animation.from[k]) * eased;
    if (t === 1) animation = null; else schedule();
  }
  world.style.transform = `translate3d(${camera.x}px,${camera.y}px,0) scale(${camera.scale})`;
  world.style.setProperty('--scale', camera.scale);
  $('#zoom-reset').textContent = `${Math.round(camera.scale * 100)}%`;
  $('#zoom-out').disabled = camera.scale <= limits.min;
  $('#zoom-in').disabled = camera.scale >= limits.max;
  drawHighlight(); drawMinimap();
}
function drawHighlight() {
  const ratio = canvas.width / width;
  context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, width, height);
  context.setTransform(ratio * camera.scale, 0, 0, ratio * camera.scale, ratio * camera.x, ratio * camera.y);
  context.strokeStyle = '#079bfa'; context.lineWidth = Math.max(3, 2.1 / camera.scale);
  context.lineJoin = 'round'; context.lineCap = 'round';
  for (const edge of highlight.edges) {
    context.beginPath(); edge.points.forEach(([x, y], i) => i ? context.lineTo(x, y) : context.moveTo(x, y)); context.stroke();
    if (edge.kind === 'parent-child') {
      const end = edge.points.at(-1), size = 5.5;
      context.fillStyle = '#079bfa'; context.beginPath(); context.moveTo(end[0], end[1]);
      context.lineTo(end[0] - size, end[1] - 10); context.lineTo(end[0] + size, end[1] - 10); context.closePath(); context.fill();
    }
  }
  // Opaque family badges and cards sit in front of the connectors, including the blue overlay.
  // Use their world-space bounds so the highlight never crosses the text on a badge.
  for (const el of art.values()) {
    const x = parseFloat(el.style.left), y = parseFloat(el.style.top), w = parseFloat(el.style.width), h = parseFloat(el.style.height);
    if ([x, y, w, h].every(Number.isFinite)) context.clearRect(x - 1, y - 1, w + 2, h + 2);
  }
  for (const p of people.values()) context.clearRect(p.x, p.y, p.width, p.height);
}
function drawMinimap() {
  const ctx = mapContext, w = mapCanvas.width, h = mapCanvas.height, s = Math.min((w - 18) / data.width, (h - 18) / data.height);
  const ox = (w - data.width * s) / 2, oy = (h - data.height * s) / 2;
  ctx.clearRect(0, 0, w, h); ctx.fillStyle = '#eeeee8'; ctx.fillRect(ox, oy, data.width * s, data.height * s);
  for (const p of people.values()) {
    ctx.fillStyle = highlight.people.has(p.person) ? '#079bfa' : '#aebaaa';
    ctx.fillRect(ox + p.x * s, oy + p.y * s, p.width * s, p.height * s);
  }
  ctx.strokeStyle = '#079bfa'; ctx.lineWidth = 2; ctx.fillStyle = '#079bfa12';
  const x = ox - camera.x / camera.scale * s, y = oy - camera.y / camera.scale * s;
  ctx.fillRect(x, y, width / camera.scale * s, height / camera.scale * s);
  ctx.strokeRect(x, y, width / camera.scale * s, height / camera.scale * s);
}

function connected(id, direction) {
  const ids = new Set([id]), edges = new Set(), queue = [id];
  for (const current of queue) for (const edge of (direction === 'ancestors' ? parents : children).get(current) || []) {
    const next = direction === 'ancestors' ? edge.a : edge.b; edges.add(edge);
    if (!ids.has(next)) { ids.add(next); queue.push(next); }
  }
  return { people: ids, edges: [...edges], chain: [] };
}
function findPath(from, to) {
  const queue = [from], previous = new Map([[from, null]]);
  for (const current of queue) {
    if (current === to) {
      const chain = [], edges = []; let at = to;
      while (at) { chain.unshift(at); const p = previous.get(at); if (p) edges.unshift(p.edge); at = p?.id; }
      return { people: new Set(chain), edges, chain };
    }
    for (const edge of adjacent.get(current) || []) {
      const next = edge.a === current ? edge.b : edge.a;
      if (!previous.has(next)) { previous.set(next, { id: current, edge }); queue.push(next); }
    }
  }
  return { people: new Set([from, to]), edges: [], chain: [] };
}
function updateHighlight() {
  const id = hoveredId || selectedId;
  if (!id) highlight = { people: new Set(), edges: [], chain: [] };
  else if (mode === 'ancestors' || mode === 'descendants') highlight = connected(id, mode);
  else if (mode === 'path') highlight = findPath(id, targetId);
  else {
    const edges = adjacent.get(id) || [];
    highlight = { edges, people: new Set([id, ...edges.flatMap(e => [e.a, e.b])]), chain: [] };
  }
  world.classList.toggle('has-highlight', !!id);
  for (const [person, element] of elements) {
    element.classList.toggle('is-active', person === id);
    element.classList.toggle('is-related', highlight.people.has(person));
    element.setAttribute('aria-pressed', String(person === selectedId));
  }
  const owners = new Set(highlight.edges.map(e => e.owner));
  for (const [name, element] of art) element.classList.toggle('is-lit-label', name.includes('/Плашка/') && owners.has(name.split('/').at(-1)));
  $('#clear-selection').hidden = !selectedId;
  $('#fit-highlight').hidden = highlight.people.size < 2 || mode === 'family';
  const active = people.get(id), status = $('#status');
  if (!id) status.textContent = 'Наведите на карточку, чтобы увидеть связи';
  else if (mode === 'path') status.textContent = id === targetId ? 'Это выбранный человек' : highlight.chain.length ? `${highlight.chain.length - 1} ${plural(highlight.chain.length - 1, ['связь', 'связи', 'связей'])} · ${active.name} → ${people.get(targetId).name}` : 'Между этими карточками нет связанной цепочки';
  else status.textContent = `${active.name} · ${Math.max(0, highlight.people.size - 1)} ${plural(highlight.people.size - 1, ['человек', 'человека', 'человек'])} ${mode === 'ancestors' ? 'в линии предков' : mode === 'descendants' ? 'в линии потомков' : 'рядом'}`;
  schedule();
}
function plural(n, forms) { n = Math.abs(n) % 100; return n > 10 && n < 20 ? forms[2] : n % 10 === 1 ? forms[0] : n % 10 >= 2 && n % 10 <= 4 ? forms[1] : forms[2]; }
function setMode(value) { hoveredId = null; mode = value; $('#highlight-mode').value = mode; $('#target-wrap').hidden = mode !== 'path'; updateHighlight(); if (selectedId) renderDetails(selectedId); updateHash(); }
function selectPerson(id, center = false) {
  if (!people.has(id)) return;
  selectedId = id; hoveredId = null;
  $('#person-panel').hidden = false; renderDetails(id); updateHighlight(); updateHash();
  for (const [person, el] of elements) el.tabIndex = person === id ? 0 : -1;
  if (center) focusPerson(id);
}
function clearSelection() {
  selectedId = null; hoveredId = null; $('#person-panel').hidden = true;
  updateHighlight(); updateHash();
}
function element(tag, text, className) { const el = document.createElement(tag); if (text) el.textContent = text; if (className) el.className = className; return el; }
function relativeSection(title, ids) {
  const section = element('section', '', 'relative-section'); section.append(element('h3', title));
  for (const id of [...new Set(ids)]) {
    const button = element('button', people.get(id).name, 'relative-link'); button.addEventListener('click', () => selectPerson(id, true)); section.append(button);
  }
  return section;
}
function renderDetails(id) {
  const p = people.get(id), root = $('#person-details'); root.replaceChildren();
  if (p.photo) { const image = new Image(); image.className = 'detail-photo'; image.src = p.photo; image.alt = p.name; image.style.filter = photoFilter(p); root.append(image); }
  else root.append(element('div', 'Фото', 'detail-photo photo-placeholder'));
  root.append(element('h2', p.name)); if (p.portraitLabel) root.append(element('p', p.portraitLabel, 'portrait-label'));
  root.append(element('p', p.life.replace(/(?=Умер(?:ла)?:)/, '\n'), 'person-dates'));
  if (p.place) {
    const location = element('p', '', 'person-location');
    const iconSource = elements.get(id).querySelector('[data-name="Lucide / map-pin"] img');
    if (iconSource) { const icon = new Image(); icon.src = iconSource.src; icon.alt = ''; location.append(icon); }
    location.append(document.createTextNode(p.place)); root.append(location);
  }
  const actions = element('div', '', 'panel-actions');
  for (const [label, fn] of [['Предки', () => setMode('ancestors')], ['Потомки', () => setMode('descendants')], ['Путь к нему', () => { targetId = id; $('#path-target').value = id; setMode('path'); toast('Теперь наведите на другого человека'); }], ['Ссылка', copyLink]]) {
    const button = element('button', label); button.addEventListener('click', fn); actions.append(button);
  }
  root.append(actions);
  const ps = (parents.get(id) || []).map(e => e.a), cs = (children.get(id) || []).map(e => e.b);
  if (ps.length) root.append(relativeSection('Родители', ps));
  if (cs.length) root.append(relativeSection('Дети', cs));
  if (mode === 'path') {
    const path = findPath(id, targetId);
    if (path.chain.length > 1) {
      const section = element('section', '', 'relative-section'); section.append(element('h3', 'Цепочка к ' + people.get(targetId).name));
      const list = element('ol', '', 'path-list');
      for (const member of path.chain) { const li = element('li'); const button = element('button', people.get(member).name); button.addEventListener('click', () => focusPerson(member)); li.append(button); list.append(li); }
      section.append(list); root.append(section);
    }
  }
}
function updateHash() {
  const params = new URLSearchParams();
  if (selectedId) params.set('person', selectedId);
  if (mode !== 'family') params.set('mode', mode);
  if (mode === 'path') params.set('target', targetId);
  history.replaceState(null, '', location.pathname + location.search + (params.size ? '#' + params : ''));
}
function photoFilter(person) { return person.saturation === -1 ? 'grayscale(1)' : person.saturation ? `saturate(${1 + person.saturation})` : ''; }
async function copyLink() { try { await navigator.clipboard.writeText(location.href); toast('Ссылка на карточку скопирована'); } catch { toast('Ссылку можно скопировать из адресной строки'); } }
function toast(message) { clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').hidden = false; toastTimer = setTimeout(() => $('#toast').hidden = true, 2400); }

function search() {
  const query = normalize($('#search').value); const root = $('#search-results'); root.replaceChildren(); searchIndex = -1;
  matches = query ? [...people.values()].filter(p => normalize([p.name, ...(p.aliases || [])].join(' ')).includes(query)).slice(0, 30) : [];
  root.hidden = !query; $('#search').setAttribute('aria-expanded', String(!!query));
  if (!query) return;
  if (!matches.length) root.append(element('p', 'Никого не нашли. Попробуйте часть имени.', 'search-empty'));
  for (const [index, p] of matches.entries()) {
    const button = element('button'); button.role = 'option'; button.id = `result-${index}`; button.setAttribute('aria-selected', 'false');
    if (p.photo) { const image = new Image(); image.src = p.photo; image.alt = ''; image.style.filter = photoFilter(p); button.append(image); }
    const label = element('span', p.name); label.append(element('small', p.life || 'Семейное дерево')); button.append(label);
    button.addEventListener('click', () => chooseSearch(index)); root.append(button);
  }
}
function chooseSearch(index) {
  const p = matches[index]; if (!p) return;
  $('#search').value = ''; $('#search-results').hidden = true; $('#search').setAttribute('aria-expanded', 'false');
  selectPerson(p.person, true); elements.get(p.person).focus({ preventScroll: true });
}

function onPointerDown(event) {
  if (event.button === 2) return;
  const isTouch = event.pointerType === 'touch';
  if (isTouch) touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
  const onCard = !!event.target.closest('[data-person]');
  if (!isTouch && event.button !== 1 && !spaceHeld && onCard) return;
  event.preventDefault(); viewport.setPointerCapture(event.pointerId); animation = null;
  if (isTouch && touches.size === 2) {
    const [a, b] = [...touches.values()], cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
    pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), scale: camera.scale, world: toWorld(cx, cy) }; drag = null;
  } else drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, fromX: camera.x, fromY: camera.y, moved: false };
  dragging = true; viewport.classList.add('is-dragging'); hoveredId = null; updateHighlight();
}
function onPointerMove(event) {
  if (touches.has(event.pointerId)) touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (pinch && touches.size >= 2) {
    const [a, b] = [...touches.values()], cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
    camera.scale = clamp(pinch.scale * Math.hypot(a.x - b.x, a.y - b.y) / pinch.distance, limits.min, limits.max);
    camera.x = cx - pinch.world.x * camera.scale; camera.y = cy - pinch.world.y * camera.scale; suppressClickUntil = performance.now() + 400; schedule();
  } else if (drag && drag.pointerId === event.pointerId) {
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    camera.x = drag.fromX + dx; camera.y = drag.fromY + dy; schedule();
  }
}
function onPointerUp(event) {
  touches.delete(event.pointerId);
  if (drag?.moved || pinch) suppressClickUntil = performance.now() + 400;
  if (pinch && touches.size === 1) {
    const [id, p] = [...touches][0]; drag = { pointerId: id, x: p.x, y: p.y, fromX: camera.x, fromY: camera.y, moved: true };
  } else drag = null;
  pinch = null;
  if (!touches.size) { dragging = false; viewport.classList.remove('is-dragging'); }
  if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
}

async function init() {
  const injected = window.__FAMILY_TREE__;
  const [json, html] = injected
    ? [injected.tree, injected.scene]
    : await Promise.all([fetch('tree.json').then(r => { if (!r.ok) throw Error('Не удалось загрузить дерево'); return r.json(); }), fetch('scene.html').then(r => { if (!r.ok) throw Error('Не удалось загрузить макет'); return r.text(); })]);
  data = json; targetId = data.rootPerson || data.cards[0].person; document.title = data.title || 'История семьи'; $('#scene-mount').innerHTML = html; world = $('#world');
  for (const p of data.cards) { people.set(p.person, p); elements.set(p.person, $(`[data-person="${p.person}"]`, world)); }
  for (const edge of data.edges) {
    for (const id of [edge.a, edge.b]) { if (!adjacent.has(id)) adjacent.set(id, []); adjacent.get(id).push(edge); }
    if (edge.kind === 'parent-child') {
      if (!parents.has(edge.b)) parents.set(edge.b, []); parents.get(edge.b).push(edge);
      if (!children.has(edge.a)) children.set(edge.a, []); children.get(edge.a).push(edge);
    }
  }
  for (const el of world.querySelectorAll('[data-name]')) { if (el.dataset.name.includes('/Плашка/')) art.set(el.dataset.name, el); }
  for (const [id, el] of elements) {
    el.tabIndex = id === data.rootPerson ? 0 : -1;
    const img = el.querySelector('[data-portrait] img'); if (img) img.alt = people.get(id).name;
    el.addEventListener('pointerenter', () => { if (!dragging && !spaceHeld) { hoveredId = id; updateHighlight(); } });
    el.addEventListener('pointerleave', () => { if (hoveredId === id) { hoveredId = null; updateHighlight(); } });
    el.addEventListener('click', event => { if (performance.now() < suppressClickUntil || spaceHeld || event.button === 1) return; selectPerson(id); });
    el.addEventListener('keydown', event => { if (event.code === 'Enter') { event.preventDefault(); selectPerson(id); } });
  }
  $('#people-count').textContent = `${people.size} ${plural(people.size, ['человек', 'человека', 'человек'])} · ${data.stage === 'tree-review' ? 'Проверка дерева' : 'Семейное дерево'}`;
  const target = $('#path-target');
  for (const p of [...people.values()].sort((a,b) => a.name.localeCompare(b.name, 'ru'))) { const option = element('option', p.name); option.value = p.person; target.append(option); }
  target.value = targetId;
  const hash = new URLSearchParams(location.hash.slice(1));
  if (people.has(hash.get('target'))) { targetId = hash.get('target'); target.value = targetId; }
  if (['family', 'ancestors', 'descendants', 'path'].includes(hash.get('mode'))) setMode(hash.get('mode'));
  resize();
  if (people.has(hash.get('person'))) { selectPerson(hash.get('person')); focusPerson(selectedId, .85); }
  else { const p = people.get(data.rootPerson); moveTo({ scale: .5, x: width / 2 - (p.x + 140) * .5, y: height * .54 - (p.y + 216) * .5 }, false); }
  await document.fonts.ready;
  new ResizeObserver(positionStatus).observe($('.relationship-bar'));
  $('#loading').remove(); schedule();
  Object.defineProperty(window, 'drevo', { value: { getState: () => ({ camera: { ...camera }, mode, targetId, selectedId, hoveredId, highlightedPeople: [...highlight.people], highlightedEdges: highlight.edges.map(e => e.id), chain: [...highlight.chain], personCount: people.size, edgeCount: data.edges.length }), focusPerson, fitTree } });
}

viewport.addEventListener('wheel', event => {
  event.preventDefault(); animation = null;
  const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? height : 1;
  if (event.ctrlKey || event.metaKey) zoomAt(camera.scale * Math.exp(-event.deltaY * factor * .0025), event.clientX, event.clientY);
  else { camera.x -= event.deltaX * factor; camera.y -= event.deltaY * factor; schedule(); }
}, { passive: false });
viewport.addEventListener('pointerdown', onPointerDown); viewport.addEventListener('pointermove', onPointerMove);
viewport.addEventListener('pointerup', onPointerUp); viewport.addEventListener('pointercancel', onPointerUp);
viewport.addEventListener('auxclick', event => { if (event.button === 1) event.preventDefault(); });
window.addEventListener('resize', resize);
window.addEventListener('hashchange', () => {
  if (!data) return;
  const hash = new URLSearchParams(location.hash.slice(1));
  if (people.has(hash.get('target'))) { targetId = hash.get('target'); $('#path-target').value = targetId; }
  if (['family', 'ancestors', 'descendants', 'path'].includes(hash.get('mode'))) setMode(hash.get('mode'));
  else setMode('family');
  if (people.has(hash.get('person'))) selectPerson(hash.get('person'), true);
  else clearSelection();
});
window.addEventListener('blur', () => { spaceHeld = false; dragging = false; drag = null; pinch = null; touches.clear(); viewport.classList.remove('is-space', 'is-dragging'); });
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('#search').focus(); return; }
  if (event.key === 'Escape') { $('#search-results').hidden = true; if (!$('#help-dialog').open) clearSelection(); return; }
  if (editable(event.target) || $('#help-dialog').open) return;
  if (event.code === 'Space') { event.preventDefault(); spaceHeld = true; hoveredId = null; viewport.classList.add('is-space'); updateHighlight(); }
  else if (event.key === '0') { event.preventDefault(); fitTree(); }
  else if (['+', '='].includes(event.key)) { event.preventDefault(); zoomAt(camera.scale * 1.25); }
  else if (event.key === '-') { event.preventDefault(); zoomAt(camera.scale / 1.25); }
  else if (event.key.startsWith('Arrow')) {
    event.preventDefault(); animation = null;
    camera.x += event.key === 'ArrowLeft' ? 80 : event.key === 'ArrowRight' ? -80 : 0;
    camera.y += event.key === 'ArrowUp' ? 80 : event.key === 'ArrowDown' ? -80 : 0; schedule();
  }
});
document.addEventListener('keyup', event => { if (event.code === 'Space') { spaceHeld = false; viewport.classList.remove('is-space'); } });
$('#search').addEventListener('input', search);
$('#search').addEventListener('keydown', event => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault(); if (!matches.length) return;
    searchIndex = (searchIndex + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
    for (const [i, el] of [...$('#search-results').querySelectorAll('button')].entries()) el.setAttribute('aria-selected', String(i === searchIndex));
    $('#search').setAttribute('aria-activedescendant', `result-${searchIndex}`);
    $(`#result-${searchIndex}`).scrollIntoView({ block: 'nearest' });
  } else if (event.key === 'Enter') { event.preventDefault(); chooseSearch(Math.max(0, searchIndex)); }
});
document.addEventListener('pointerdown', event => { if (!event.target.closest('.search-wrap')) { $('#search-results').hidden = true; $('#search').setAttribute('aria-expanded', 'false'); } });
$('#highlight-mode').addEventListener('change', event => setMode(event.target.value));
$('#path-target').addEventListener('change', event => { targetId = event.target.value; updateHighlight(); if (selectedId) renderDetails(selectedId); updateHash(); });
$('#clear-selection').addEventListener('click', clearSelection); $('#close-person').addEventListener('click', clearSelection);
$('#fit-highlight').addEventListener('click', fitHighlight);
$('#zoom-out').addEventListener('click', () => zoomAt(camera.scale / 1.25)); $('#zoom-in').addEventListener('click', () => zoomAt(camera.scale * 1.25));
$('#zoom-reset').addEventListener('click', () => zoomAt(1)); $('#fit-tree').addEventListener('click', fitTree);
$('#home-link').addEventListener('click', event => { event.preventDefault(); fitTree(); });
$('#go-root').addEventListener('click', () => selectPerson(data.rootPerson, true));
$('#help-button').addEventListener('click', () => $('#help-dialog').showModal()); $('#close-help').addEventListener('click', () => $('#help-dialog').close());
$('#help-dialog').addEventListener('click', event => { if (event.target === $('#help-dialog')) { const r = event.target.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) event.target.close(); } });
$('#minimap-button').addEventListener('pointerdown', event => {
  event.preventDefault(); animation = null;
  const rect = mapCanvas.getBoundingClientRect(), x = (event.clientX - rect.left) * mapCanvas.width / rect.width, y = (event.clientY - rect.top) * mapCanvas.height / rect.height;
  const s = Math.min((mapCanvas.width - 18) / data.width, (mapCanvas.height - 18) / data.height), ox = (mapCanvas.width - data.width * s) / 2, oy = (mapCanvas.height - data.height * s) / 2;
  moveTo({ ...camera, x: width / 2 - (x - ox) / s * camera.scale, y: height / 2 - (y - oy) / s * camera.scale });
});
init().catch(error => { $('#loading').replaceChildren(element('p', 'Не удалось открыть дерево'), element('p', error.message)); console.error(error); });
