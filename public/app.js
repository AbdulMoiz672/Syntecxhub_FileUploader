const elements = {
  accountEmail: document.querySelector('#account-email'),
  acceptedTypes: document.querySelector('#accepted-types'),
  apiError: document.querySelector('#api-error-state'),
  appShell: document.querySelector('#app-shell'),
  authDescription: document.querySelector('#auth-description'),
  authError: document.querySelector('#auth-error'),
  authFormPanel: document.querySelector('#auth-form-panel'),
  authLoading: document.querySelector('#auth-loading'),
  authScreen: document.querySelector('#auth-screen'),
  authTitle: document.querySelector('#auth-title'),
  browse: document.querySelector('#browse-files'),
  choose: document.querySelector('#choose-file'),
  fileCount: document.querySelector('#file-count'),
  detail: document.querySelector('#file-detail'),
  detailEmpty: document.querySelector('#detail-empty'),
  detailHeading: document.querySelector('#detail-heading'),
  detailIndex: document.querySelector('#detail-index'),
  dropZone: document.querySelector('#drop-zone'),
  empty: document.querySelector('#empty-state'),
  fileInput: document.querySelector('#file-input'),
  fileList: document.querySelector('#file-list'),
  loading: document.querySelector('#loading-state'),
  loginForm: document.querySelector('#login-form'),
  maxFileSize: document.querySelector('#max-file-size'),
  noResults: document.querySelector('#no-results-state'),
  notice: document.querySelector('#notice'),
  noticeText: document.querySelector('#notice-text'),
  progress: document.querySelector('#upload-progress'),
  progressAnnouncement: document.querySelector('#progress-announcement'),
  progressBar: document.querySelector('#progress-bar'),
  progressFilename: document.querySelector('#progress-filename'),
  progressPercent: document.querySelector('#progress-percent'),
  refresh: document.querySelector('#refresh-button'),
  retryList: document.querySelector('#retry-list-button'),
  retryUpload: document.querySelector('#retry-upload'),
  registerForm: document.querySelector('#register-form'),
  search: document.querySelector('#search-input'),
  signOut: document.querySelector('#sign-out'),
  storageStatus: document.querySelector('#storage-status'),
};

let files = [];
let selectedId = null;
let allowedMimeTypes = [];
let maxFileSizeBytes = 0;
let retryFile = null;
let currentUser = null;
let previewObjectUrl = null;
const imagePreviewTypes = new Set([
  'image/avif', 'image/bmp', 'image/gif', 'image/jpeg', 'image/png', 'image/webp',
]);
const inlinePreviewTypes = new Set([...imagePreviewTypes, 'application/pdf', 'text/plain']);

function readableSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let size = bytes;
  let unit = -1;
  do {
    size /= 1024;
    unit += 1;
  } while (size >= 1024 && unit < units.length - 1);
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: size < 10 ? 1 : 0 }).format(size)} ${units[unit]}`;
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
}

function showNotice(message, isError = false, canRetry = false) {
  elements.notice.hidden = false;
  elements.notice.classList.toggle('is-error', isError);
  elements.noticeText.textContent = message;
  elements.retryUpload.hidden = !canRetry;
}

function hideNotice() {
  elements.notice.hidden = true;
  elements.notice.classList.remove('is-error');
}

async function requestJson(url, options) {
  const response = await fetch(url, { ...options, credentials: 'same-origin' });
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `Request failed (${response.status}).`);
    error.status = response.status;
    if (response.status === 401 && (url === '/api/files' || url.startsWith('/api/files/'))) handleSessionExpired();
    throw error;
  }
  return payload;
}

function setAuthError(message = '') {
  elements.authError.textContent = message;
  elements.authError.hidden = !message;
}

function setAuthMode(mode) {
  const isRegister = mode === 'register';
  elements.loginForm.hidden = isRegister;
  elements.registerForm.hidden = !isRegister;
  elements.authTitle.textContent = isRegister ? 'Create your account' : 'Sign in to your archive';
  elements.authDescription.textContent = isRegister
    ? 'Set up a private space for the files you need.'
    : 'Your files are waiting where you left them.';
  document.querySelectorAll('[data-auth-mode]').forEach((button) => {
    const selected = button.dataset.authMode === mode;
    button.classList.toggle('is-active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  setAuthError();
}

function revokePreviewUrl() {
  if (!previewObjectUrl) return;
  URL.revokeObjectURL(previewObjectUrl);
  previewObjectUrl = null;
}

function showAuth(message = '') {
  currentUser = null;
  revokePreviewUrl();
  elements.appShell.hidden = true;
  elements.authScreen.hidden = false;
  elements.authLoading.hidden = true;
  elements.authFormPanel.hidden = false;
  setAuthMode('login');
  setAuthError(message);
}

function handleSessionExpired() {
  if (currentUser) showAuth('Your session has expired. Sign in to continue.');
}

async function enterWorkspace(user) {
  currentUser = user;
  elements.accountEmail.textContent = user.email;
  elements.authScreen.hidden = true;
  elements.appShell.hidden = false;
  await Promise.all([loadConfig(), loadFiles()]);
}

async function restoreSession() {
  try {
    const payload = await requestJson('/api/auth/me');
    await enterWorkspace(payload.user);
  } catch (error) {
    showAuth(error.status === 401 ? '' : 'Unable to verify your session. Check your connection and try again.');
  }
}

async function submitAuth(mode, event) {
  event.preventDefault();
  const form = event.currentTarget;
  const emailField = form.elements.email;
  const email = emailField.value.trim();
  const password = form.elements.password.value;
  if (!email || !emailField.validity.valid) {
    setAuthError('Enter a valid email address.');
    emailField.focus();
    return;
  }
  if (!password) {
    setAuthError('Enter your password.');
    form.elements.password.focus();
    return;
  }
  if (mode === 'register') {
    if (password.length < 12 || password.length > 128) {
      setAuthError('Password must be between 12 and 128 characters.');
      return;
    }
    if (password !== form.elements.confirmPassword.value) {
      setAuthError('The passwords do not match.');
      return;
    }
  }

  const submit = form.querySelector('[type="submit"]');
  const label = submit.querySelector('span:first-child');
  const originalLabel = mode === 'register' ? 'Create account' : 'Sign in';
  submit.disabled = true;
  label.textContent = mode === 'register' ? 'Creating account…' : 'Signing in…';
  setAuthError();
  try {
    const payload = await requestJson(`/api/auth/${mode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    form.reset();
    await enterWorkspace(payload.user);
  } catch (error) {
    setAuthError(error.message);
  } finally {
    submit.disabled = false;
    label.textContent = originalLabel;
  }
}

async function requestFileBlob(url) {
  const response = await fetch(url, { credentials: 'same-origin' });
  if (response.status === 401) {
    handleSessionExpired();
    return null;
  }
  if (!response.ok) {
    let payload;
    try { payload = await response.json(); } catch { payload = null; }
    throw new Error(payload?.error?.message || `Request failed (${response.status}).`);
  }
  return response.blob();
}

function wireDownload(link, url, filename) {
  link.addEventListener('click', async (event) => {
    event.preventDefault();
    try {
      const blob = await requestFileBlob(url);
      if (!blob) return;
      const objectUrl = URL.createObjectURL(blob);
      const download = document.createElement('a');
      download.href = objectUrl;
      download.download = filename;
      download.click();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
    } catch (error) {
      showNotice(error.message, true);
    }
  });
}

function wireFullPreview(link, url) {
  link.addEventListener('click', async (event) => {
    event.preventDefault();
    const previewWindow = window.open('about:blank', '_blank');
    try {
      const blob = await requestFileBlob(url);
      if (!blob) {
        previewWindow?.close();
        return;
      }
      const objectUrl = URL.createObjectURL(blob);
      if (previewWindow) previewWindow.location.href = objectUrl;
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
    } catch (error) {
      previewWindow?.close();
      showNotice(error.message, true);
    }
  });
}

async function loadPreview(url, target, status) {
  try {
    const blob = await requestFileBlob(url);
    if (!blob) return;
    const objectUrl = URL.createObjectURL(blob);
    if (!target.isConnected || !currentUser) {
      URL.revokeObjectURL(objectUrl);
      return;
    }
    revokePreviewUrl();
    previewObjectUrl = objectUrl;
    target.src = objectUrl;
    if (target.tagName === 'IMG') status.hidden = true;
  } catch {
    status.textContent = 'Preview unavailable. Use Full preview below.';
  }
}

function typeLabel(filename) {
  const extension = filename.split('.').pop();
  return extension && extension !== filename ? extension.slice(0, 4).toUpperCase() : 'FILE';
}

function icon(name) {
  const paths = {
    download: '<path d="M12 4v11m0 0 4-4m-4 4-4-4"/><path d="M5 17v3h14v-3"/>',
    delete: '<path d="M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name]}</svg>`;
}

function makeAction(label, className, contents, handler) {
  const button = document.createElement('button');
  button.className = `file-action ${className}`;
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.title = label;
  button.innerHTML = contents;
  button.addEventListener('click', handler);
  return button;
}

function renderDetail() {
  revokePreviewUrl();
  const file = files.find((item) => item.id === selectedId);
  elements.detail.replaceChildren();
  elements.detail.hidden = !file;
  elements.detailEmpty.hidden = Boolean(file);
  elements.detailIndex.textContent = file ? String(files.indexOf(file) + 1).padStart(2, '0') : '—';
  elements.detailHeading.textContent = file ? 'File details' : 'File details';
  if (!file) return;

  const preview = document.createElement('div');
  preview.className = 'preview-frame';
  const previewUrl = `/api/files/${encodeURIComponent(file.id)}?preview=1`;
  if (imagePreviewTypes.has(file.contentType)) {
    const image = document.createElement('img');
    image.alt = `Preview of ${file.filename}`;
    const status = document.createElement('span');
    status.className = 'preview-status';
    status.setAttribute('role', 'status');
    status.textContent = 'Loading inline preview…';
    preview.append(image, status);
    loadPreview(previewUrl, image, status);
  } else if (file.contentType === 'application/pdf' || file.contentType === 'text/plain') {
    const frame = document.createElement('iframe');
    frame.title = `Preview of ${file.filename}`;
    const previewStatus = document.createElement('span');
    previewStatus.className = 'preview-status';
    previewStatus.setAttribute('role', 'status');
    previewStatus.textContent = 'Loading inline preview…';
    const fallbackTimer = window.setTimeout(() => {
      previewStatus.textContent = 'Taking longer? Use Full preview below.';
    }, 5000);
    frame.addEventListener('load', () => {
      window.clearTimeout(fallbackTimer);
      previewStatus.hidden = true;
    }, { once: true });
    frame.addEventListener('error', () => {
      window.clearTimeout(fallbackTimer);
      previewStatus.textContent = 'Preview unavailable. Use Full preview below.';
    }, { once: true });
    preview.append(frame, previewStatus);
    loadPreview(previewUrl, frame, previewStatus);
  } else {
    const placeholder = document.createElement('div');
    placeholder.className = 'preview-placeholder';
    const title = document.createElement('strong');
    title.textContent = typeLabel(file.filename);
    const description = document.createElement('span');
    description.textContent = 'A browser preview is not available for this format. Download the file to open it.';
    placeholder.append(title, description);
    preview.append(placeholder);
  }

  const filename = document.createElement('h3');
  filename.className = 'detail-file-title';
  const filenameParts = file.filename.split(/([._-])/u);
  filenameParts.forEach((part, index) => {
    filename.append(document.createTextNode(part));
    if (['_', '.', '-'].includes(part) && index < filenameParts.length - 1) {
      filename.append(document.createElement('wbr'));
    }
  });

  const metadata = document.createElement('dl');
  metadata.className = 'detail-meta';
  for (const [label, value] of [
    ['File type', file.contentType],
    ['File size', readableSize(file.size)],
    ['Date added', formatDate(file.uploadDate)],
    ['File ID', file.id],
  ]) {
    const group = document.createElement('div');
    const term = document.createElement('dt');
    term.textContent = label;
    const description = document.createElement('dd');
    description.textContent = value;
    group.append(term, description);
    metadata.append(group);
  }

  const actions = document.createElement('div');
  actions.className = 'detail-actions';
  if (inlinePreviewTypes.has(file.contentType)) {
    const previewLink = document.createElement('a');
    previewLink.className = 'preview-link';
    previewLink.href = previewUrl;
    previewLink.target = '_blank';
    previewLink.rel = 'noopener';
    previewLink.textContent = 'Full preview';
    wireFullPreview(previewLink, previewUrl);
    actions.append(previewLink);
  }
  const download = document.createElement('a');
  download.className = 'download-link';
  download.href = `/api/files/${encodeURIComponent(file.id)}`;
  download.setAttribute('download', file.filename);
  download.innerHTML = `${icon('download')}<span>Download</span>`;
  wireDownload(download, `/api/files/${encodeURIComponent(file.id)}`, file.filename);
  const remove = document.createElement('button');
  remove.className = 'detail-delete';
  remove.type = 'button';
  remove.textContent = 'Delete file';
  remove.addEventListener('click', () => deleteFile(file));
  actions.append(download, remove);

  elements.detail.append(preview, filename, metadata, actions);
}

function renderFiles() {
  const query = elements.search.value.trim().toLocaleLowerCase();
  const visibleFiles = files.filter((file) => file.filename.toLocaleLowerCase().includes(query));
  elements.fileList.replaceChildren();
  elements.fileCount.textContent = `${files.length} ${files.length === 1 ? 'file' : 'files'}`;
  elements.empty.hidden = files.length !== 0;
  elements.noResults.hidden = files.length === 0 || visibleFiles.length !== 0;

  visibleFiles.forEach((file, index) => {
    const row = document.createElement('li');
    row.className = `file-row${file.id === selectedId ? ' is-selected' : ''}`;
    row.style.animationDelay = `${Math.min(index, 8) * 24}ms`;

    const select = document.createElement('button');
    select.className = 'file-name-button';
    select.type = 'button';
    select.setAttribute('aria-pressed', String(file.id === selectedId));
    select.setAttribute('aria-label', `Select ${file.filename}`);
    select.addEventListener('click', () => {
      selectedId = file.id;
      renderFiles();
      renderDetail();
    });
    const mark = document.createElement('span');
    mark.className = 'file-type-mark';
    mark.textContent = typeLabel(file.filename);
    const nameCopy = document.createElement('span');
    nameCopy.className = 'file-name-copy';
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = file.filename;
    const mime = document.createElement('span');
    mime.className = 'file-mime';
    mime.textContent = file.contentType;
    nameCopy.append(name, mime);
    select.append(mark, nameCopy);

    const size = document.createElement('span');
    size.className = 'file-size';
    size.textContent = readableSize(file.size);
    const date = document.createElement('span');
    date.className = 'file-date';
    date.textContent = formatDate(file.uploadDate);

    const actions = document.createElement('span');
    actions.className = 'file-actions';
    const download = document.createElement('a');
    download.className = 'file-action';
    download.href = `/api/files/${encodeURIComponent(file.id)}`;
    download.setAttribute('download', file.filename);
    download.setAttribute('aria-label', `Download ${file.filename}`);
    download.title = `Download ${file.filename}`;
    download.innerHTML = icon('download');
    wireDownload(download, `/api/files/${encodeURIComponent(file.id)}`, file.filename);
    const remove = makeAction(`Delete ${file.filename}`, 'delete-action', icon('delete'), () => deleteFile(file));
    actions.append(download, remove);

    row.append(select, size, date, actions);
    elements.fileList.append(row);
  });

  const selectedVisible = visibleFiles.some((file) => file.id === selectedId);
  elements.fileList.hidden = files.length === 0 || visibleFiles.length === 0;
  if (selectedId && !files.some((file) => file.id === selectedId)) selectedId = null;
  if (!selectedVisible && query) {
    elements.detail.hidden = true;
    elements.detailEmpty.hidden = false;
  } else {
    renderDetail();
  }
}

async function loadFiles(preferredId = selectedId) {
  elements.loading.hidden = false;
  elements.apiError.hidden = true;
  elements.empty.hidden = true;
  elements.noResults.hidden = true;
  elements.fileList.hidden = true;
  elements.storageStatus.textContent = 'SYNCING LIBRARY';
  try {
    const payload = await requestJson('/api/files');
    files = Array.isArray(payload.files) ? payload.files : [];
    selectedId = files.some((file) => file.id === preferredId) ? preferredId : files[0]?.id || null;
    elements.loading.hidden = true;
    elements.storageStatus.textContent = 'LIBRARY UP TO DATE';
    renderFiles();
    return true;
  } catch (error) {
    elements.loading.hidden = true;
    elements.apiError.hidden = false;
    elements.storageStatus.textContent = 'CONNECTION UNAVAILABLE';
    elements.fileCount.textContent = 'Library unavailable';
    return false;
  }
}

async function loadConfig() {
  try {
    const config = await requestJson('/api/config');
    allowedMimeTypes = Array.isArray(config.allowedMimeTypes) ? config.allowedMimeTypes : [];
    maxFileSizeBytes = Number(config.maxFileSizeBytes) || 0;
    elements.fileInput.accept = allowedMimeTypes.join(',');
    elements.acceptedTypes.textContent = allowedMimeTypes.length
      ? allowedMimeTypes.map((type) => type.split('/').pop().toUpperCase()).join(' · ')
      : 'No file types configured';
    elements.maxFileSize.textContent = maxFileSizeBytes ? readableSize(maxFileSizeBytes) : 'Unavailable';
  } catch {
    elements.acceptedTypes.textContent = 'Upload settings unavailable';
    elements.maxFileSize.textContent = '—';
  }
}

function uploadFile(file) {
  if (!file) return;
  const mime = (file.type || 'application/octet-stream').toLowerCase();
  if (allowedMimeTypes.length && !allowedMimeTypes.includes(mime)) {
    retryFile = null;
    showNotice(`“${file.name}” is not an accepted file type.`, true);
    return;
  }
  if (maxFileSizeBytes && file.size > maxFileSizeBytes) {
    retryFile = null;
    showNotice(`“${file.name}” is larger than the ${readableSize(maxFileSizeBytes)} limit.`, true);
    return;
  }

  hideNotice();
  retryFile = null;
  elements.progress.hidden = false;
  elements.progressFilename.textContent = file.name;
  elements.progressPercent.textContent = '0%';
  elements.progressAnnouncement.textContent = `Starting upload of ${file.name}.`;
  elements.progressBar.value = 0;
  elements.storageStatus.textContent = 'UPLOADING FILE';
  const formData = new FormData();
  formData.append('file', file);
  const xhr = new XMLHttpRequest();
  let announcedProgress = 0;
  xhr.open('POST', '/api/files/upload');
  xhr.upload.addEventListener('progress', (event) => {
    if (!event.lengthComputable) return;
    const percent = Math.round((event.loaded / event.total) * 100);
    elements.progressBar.value = percent;
    elements.progressPercent.textContent = `${percent}%`;
    if (percent > announcedProgress && (percent === 100 || percent >= announcedProgress + 10)) {
      announcedProgress = percent;
      elements.progressAnnouncement.textContent = `Uploading ${file.name}: ${percent}%.`;
    }
  });
  xhr.addEventListener('load', async () => {
    elements.progress.hidden = true;
    let payload;
    try {
      payload = JSON.parse(xhr.responseText);
    } catch {
      payload = null;
    }
    if (xhr.status < 200 || xhr.status >= 300) {
      if (xhr.status === 401) {
        handleSessionExpired();
        return;
      }
      retryFile = file;
      const message = payload?.error?.message || 'The upload could not be completed.';
      showNotice(message, true, true);
      elements.storageStatus.textContent = 'UPLOAD NEEDS ATTENTION';
      return;
    }
    showNotice(`“${payload.filename}” is now in your library.`);
    elements.fileInput.value = '';
    const loaded = await loadFiles(payload.id);
    if (!loaded) elements.storageStatus.textContent = 'UPLOAD COMPLETE · REFRESH TO SYNC';
  });
  xhr.addEventListener('error', () => {
    elements.progress.hidden = true;
    retryFile = file;
    showNotice('The connection dropped before the upload finished.', true, true);
    elements.storageStatus.textContent = 'UPLOAD NEEDS ATTENTION';
  });
  xhr.send(formData);
}

async function deleteFile(file) {
  const confirmed = window.confirm(`Delete “${file.filename}” from your library? This cannot be undone.`);
  if (!confirmed) return;
  try {
    await requestJson(`/api/files/${encodeURIComponent(file.id)}`, { method: 'DELETE' });
    showNotice(`“${file.filename}” was deleted.`);
    await loadFiles();
  } catch (error) {
    showNotice(error.message, true);
  }
}

function openPicker() {
  elements.fileInput.click();
}

elements.choose.addEventListener('click', openPicker);
elements.browse.addEventListener('click', (event) => {
  event.stopPropagation();
  openPicker();
});
elements.dropZone.addEventListener('click', (event) => {
  if (event.target.closest('button')) return;
  openPicker();
});
elements.fileInput.addEventListener('change', () => uploadFile(elements.fileInput.files[0]));
elements.dropZone.addEventListener('dragover', (event) => {
  event.preventDefault();
  elements.dropZone.classList.add('is-dragging');
});
elements.dropZone.addEventListener('dragleave', (event) => {
  if (!elements.dropZone.contains(event.relatedTarget)) elements.dropZone.classList.remove('is-dragging');
});
elements.dropZone.addEventListener('drop', (event) => {
  event.preventDefault();
  elements.dropZone.classList.remove('is-dragging');
  uploadFile(event.dataTransfer.files[0]);
});
elements.search.addEventListener('input', renderFiles);
elements.refresh.addEventListener('click', () => loadFiles());
elements.retryList.addEventListener('click', () => loadFiles());
elements.retryUpload.addEventListener('click', () => uploadFile(retryFile));
document.querySelectorAll('[data-auth-mode]').forEach((button) => {
  button.addEventListener('click', () => setAuthMode(button.dataset.authMode));
});
elements.loginForm.addEventListener('submit', (event) => submitAuth('login', event));
elements.registerForm.addEventListener('submit', (event) => submitAuth('register', event));
elements.signOut.addEventListener('click', async () => {
  elements.signOut.disabled = true;
  try {
    await requestJson('/api/auth/logout', { method: 'POST' });
    showAuth('You are signed out.');
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    elements.signOut.disabled = false;
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
    event.preventDefault();
    elements.search.focus();
  }
});

restoreSession();