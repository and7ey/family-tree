// Парольный вход для статической сборки.
// Данные лежат в payload.enc (AES-256-GCM), ключ выводится из пароля через PBKDF2.
const STORAGE_KEY = 'family-tree-session-key';
const loading = document.getElementById('loading');
let envelope = null;

const styles = document.createElement('style');
styles.textContent = `
  #loading .unlock-card {
    width: min(420px, calc(100vw - 40px));
    background: #fff;
    border: 1px solid #cdd4d5;
    border-radius: 10px;
    padding: 30px 28px 26px;
    box-shadow: 0 14px 40px #2b3a2e14;
    text-align: left;
  }
  #loading .unlock-mark {
    width: 38px; height: 38px; border-radius: 9px;
    display: grid; place-items: center; background: #3e6b59; margin-bottom: 18px;
  }
  #loading .unlock-mark svg { width: 22px; height: 22px; }
  #loading .unlock-card h1 {
    font-size: 21px; font-weight: 500; margin: 0 0 8px; color: #293c30;
  }
  #loading .unlock-card p { margin: 0 0 20px; font-size: 12px; line-height: 1.6; color: #7c877d; }
  #loading .unlock-card label { display: block; font-size: 11px; color: #55645a; margin-bottom: 6px; }
  #loading .unlock-card input {
    width: 100%; box-sizing: border-box; font: inherit; font-size: 14px;
    padding: 11px 12px; border: 1px solid #ccd4c8; border-radius: 6px;
    background: #fbfcfa; color: #293c30; outline: none;
  }
  #loading .unlock-card input:focus { border-color: #3e6b59; box-shadow: 0 0 0 3px #3e6b5918; }
  #loading .unlock-card button {
    width: 100%; margin-top: 14px; padding: 12px; border: 0; border-radius: 6px;
    background: #3e6b59; color: #fff; font: inherit; font-size: 13px; cursor: pointer;
  }
  #loading .unlock-card button:hover { background: #335a4a; }
  #loading .unlock-card button:disabled { opacity: .6; cursor: default; }
  #loading .unlock-error { min-height: 17px; margin: 10px 0 0; font-size: 12px; color: #a34b3c; }
  #loading .unlock-note { margin: 16px 0 0; font-size: 10px; line-height: 1.6; color: #9aa293; }
`;
document.head.append(styles);

const b64ToBytes = value => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};
const bytesToB64 = bytes => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

async function getEnvelope() {
  if (envelope) return envelope;
  const response = await fetch('payload.enc?v=58882cdc1bdf', { cache: 'no-store' });
  if (!response.ok) throw Error('Не удалось загрузить защищённые данные');
  envelope = await response.json();
  if (envelope?.v !== 1) throw Error('Неизвестный формат данных');
  return envelope;
}

async function decryptWithKey(key, data) {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64ToBytes(data.cipher.iv), tagLength: 128 },
    key,
    b64ToBytes(data.data)
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

async function deriveKey(password, data) {
  const material = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: b64ToBytes(data.kdf.salt), iterations: data.kdf.iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    true,
    ['decrypt']
  );
}

async function importSessionKey(raw) {
  return crypto.subtle.importKey('raw', b64ToBytes(raw), { name: 'AES-GCM' }, true, ['decrypt']);
}

function boot(payload) {
  window.__FAMILY_TREE__ = payload;
  loading.replaceChildren();
  const mark = document.createElement('span');
  mark.className = 'loading-mark';
  const text = document.createElement('p');
  text.textContent = 'Собираем семейное дерево…';
  loading.append(mark, text);
  return import('./app.js');
}

function showError(message) {
  const error = document.querySelector('#unlock-error');
  if (error) error.textContent = message;
}

function showForm(message = '') {
  loading.replaceChildren();
  const form = document.createElement('form');
  form.className = 'unlock-card';
  form.innerHTML = `
    <span class="unlock-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.8"><path d="M12 4v8M5 20v-8h14v8"/><rect x="9" y="1" width="6" height="6" rx="1.5"/><rect x="2" y="17" width="6" height="6" rx="1.5"/><rect x="16" y="17" width="6" height="6" rx="1.5"/></svg></span>
    <h1>Семейное дерево</h1>
    <p>Это личный сайт. Введите пароль, чтобы открыть дерево и данные о семье.</p>
    <label for="unlock-password">Пароль</label>
    <input id="unlock-password" type="password" autocomplete="current-password" required>
    <button type="submit">Открыть</button>
    <p class="unlock-error" id="unlock-error" role="alert"></p>
    <p class="unlock-note">Данные зашифрованы в браузере. Пароль не передаётся на сервер и не хранится в репозитории. Ссылку вида <code>?pass=…</code> можно открыть сразу — параметр убирается из адресной строки после запуска.</p>
  `;
  loading.append(form);
  const input = form.querySelector('input');
  const button = form.querySelector('button');
  input.focus();
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const password = input.value;
    if (!password) return;
    button.disabled = true;
    button.textContent = 'Проверяем…';
    showError('');
    try {
      await unlockWith(password);
    } catch {
      button.disabled = false;
      button.textContent = 'Открыть';
      input.select();
      showError('Неверный пароль. Попробуйте ещё раз.');
    }
  });
  if (message) showError(message);
}

async function unlockWith(password) {
  const data = await getEnvelope();
  const key = await deriveKey(password, data);
  const payload = await decryptWithKey(key, data);
  sessionStorage.setItem(STORAGE_KEY, bytesToB64(new Uint8Array(await crypto.subtle.exportKey('raw', key))));
  await boot(payload);
}

function takePasswordFromLink() {
  const url = new URL(location.href);
  const pass = url.searchParams.get('pass');
  if (!pass) return '';
  url.searchParams.delete('pass');
  const rest = url.searchParams.toString();
  history.replaceState(null, '', url.pathname + (rest ? `?${rest}` : '') + url.hash);
  return pass;
}

async function start() {
  const fromLink = takePasswordFromLink();
  if (fromLink) {
    try {
      await unlockWith(fromLink);
      return;
    } catch {
      showForm('Пароль из ссылки не подошёл. Введите пароль вручную.');
      return;
    }
  }
  try {
    const data = await getEnvelope();
    const saved = sessionStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        const key = await importSessionKey(saved);
        await boot(await decryptWithKey(key, data));
        return;
      } catch {
        sessionStorage.removeItem(STORAGE_KEY);
      }
    }
    showForm();
  } catch (error) {
    showForm(error.message);
  }
}

start();
