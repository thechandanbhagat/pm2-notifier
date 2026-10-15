'use strict';

(() => {
  const EVENT_CHOICES = [
    ['*', 'All events'],
    ['cpu.high', 'CPU above threshold'],
    ['cpu.recovered', 'CPU recovered'],
    ['process.restarted', 'Process restarted'],
    ['process.stopped', 'Process stopped'],
    ['process.errored', 'Process errored'],
    ['process.deleted', 'Process deleted'],
    ['process.started', 'Process started'],
    ['notifier.test', 'Test notifications'],
    ['cpu.*', 'Any CPU event'],
    ['process.*', 'Any process event'],
    ['notifier.*', 'Any notifier event'],
  ];
  const FORMATS = [['teams', 'Microsoft Teams'], ['slack', 'Slack'], ['discord', 'Discord'], ['generic', 'Generic webhook']];
  const SEVERITIES = [['critical', 'Critical'], ['warning', 'Warning'], ['info', 'Info']];
  const defaults = () => ({
    monitor: {
      pollIntervalMs: 5000,
      processes: { include: ['*'], exclude: [], includeModules: false },
      cpu: { enabled: true, scope: 'both', threshold: 95, durationMs: 60000, recoveryThreshold: 80, recoveryDurationMs: 15000 },
      lifecycle: { enabled: true, notifyOnStart: false, settleMs: 3000 },
    },
    destinations: [], routes: [],
  });
  const clone = value => JSON.parse(JSON.stringify(value));
  const state = {
    config: defaults(), savedConfig: null, revision: '', configuredSecrets: [], secrets: Object.create(null),
    runtime: { running: false }, tab: 'workflows', loading: true, loaded: false, saving: false,
    openChannels: new Set(), openRoutes: new Set(), channelNameDrafts: new Map(), templateDrafts: new Map(), templateErrors: new Set(),
    notice: null, testing: new Set(), testResults: new Map(),
  };
  const root = document.getElementById('app');
  let token = '';
  try {
    token = new URLSearchParams(location.hash.slice(1)).get('token') || sessionStorage.getItem('pm2-notifier-token') || '';
    if (token) sessionStorage.setItem('pm2-notifier-token', token);
  } catch { token = new URLSearchParams(location.hash.slice(1)).get('token') || ''; }
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);

  const iconPaths = {
    sun: ['M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0', 'M12 2v2', 'M12 20v2', 'M2 12h2', 'M20 12h2', 'm5 5 1.5 1.5', 'M17.5 17.5 19 19', 'm5 19 1.5-1.5', 'M17.5 6.5 19 5'],
    moon: ['M20.5 13A8.5 8.5 0 0 1 11 3.5 8.5 8.5 0 1 0 20.5 13Z'],
    workflow: ['M4 5h6v6H4z', 'M14 13h6v6h-6z', 'M7 11v5h7', 'M10 8h7v5'],
    channel: ['M4 5h16v11H9l-5 4V5z', 'M8 9h8', 'M8 12h5'],
    monitor: ['M3 13h4l3-8 4 14 3-7h4'],
    plus: ['M12 5v14', 'M5 12h14'],
    arrow: ['M4 12h15', 'm14 7 5 5-5 5'],
    chevron: ['m6 9 6 6 6-6'],
    check: ['m5 12 4 4L19 6'],
    circle: ['M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0'],
    clock: ['M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0', 'M12 7v5l3 2'],
    lock: ['M5 10h14v11H5z', 'M8 10V6a4 4 0 0 1 8 0v4', 'M12 14v3'],
    info: ['M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0', 'M12 11v6', 'M12 7h.01'],
    alert: ['m12 3 10 18H2L12 3z', 'M12 9v5', 'M12 17h.01'],
    close: ['m6 6 12 12', 'M18 6 6 18'],
    trash: ['M3 6h18', 'M9 6V3h6v3', 'm5 6 1 15h12l1-15', 'M10 10v7', 'M14 10v7'],
    send: ['m21 3-7 18-4-7-7-4 18-7z', 'm10 14 5-5'],
    save: ['M5 3h12l4 4v14H3V3h2z', 'M7 3v6h10V3', 'M7 21v-7h10v7'],
    server: ['M3 3h18v7H3z', 'M3 14h18v7H3z', 'M7 6.5h.01', 'M7 17.5h.01'],
  };
  function icon(name, className = '') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.65', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: className })) svg.setAttribute(key, value);
    for (const d of iconPaths[name] || iconPaths.circle) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d); svg.append(path);
    }
    return svg;
  }
  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key === 'className') node.className = value;
      else if (['value', 'checked', 'disabled', 'required', 'hidden', 'open'].includes(key)) node[key] = value;
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat(Infinity)) if (child !== null && child !== undefined && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    return node;
  }
  function button(label, action, options = {}) {
    return el('button', { type: 'button', className: `button ${options.kind || ''}`, onClick: action, ...options.attrs }, options.icon && icon(options.icon), label);
  }
  function updateThemeToggle() {
    const toggle = document.getElementById('theme-toggle');
    if (!toggle) return;
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    const label = `${next === 'light' ? 'Light' : 'Dark'} mode`;
    toggle.setAttribute('aria-label', `Switch to ${next} mode`);
    toggle.setAttribute('title', `Switch to ${next} mode`);
    toggle.replaceChildren(icon(next === 'light' ? 'sun' : 'moon'), el('span', { className: 'theme-label' }, label));
  }
  function setTheme(theme) {
    document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
    updateThemeToggle();
  }
  function themeToggle() {
    return button('', () => {
      const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
      setTheme(next);
      try { localStorage.setItem('pm2-notifier-theme', next); } catch { /* Keep the selection for this visit. */ }
    }, { kind: 'theme-toggle', attrs: { id: 'theme-toggle' } });
  }
  window.addEventListener('storage', event => {
    if (event.key === 'pm2-notifier-theme' || event.key === null) setTheme(event.newValue);
  });
  function inputField(label, value, update, options = {}) {
    const { id, help, full, type = 'text', ...attrs } = options;
    const input = el('input', { id, type, value: value ?? '', ...attrs, 'aria-describedby': help ? `${id}-help` : null, onInput: event => { update(event.target.value); changed(); } });
    return el('div', { className: `field${full ? ' full-width' : ''}` }, el('label', { for: id, className: 'field-label' }, label), input, help && el('p', { className: 'field-help', id: `${id}-help` }, help));
  }
  function selectField(label, value, choices, update, options = {}) {
    const select = el('select', { id: options.id, 'aria-describedby': options.help ? `${options.id}-help` : null, onChange: event => { update(event.target.value); changed(); } }, choices.map(([key, text]) => el('option', { value: key }, text)));
    select.value = value;
    return el('div', { className: `field${options.full ? ' full-width' : ''}` }, el('label', { for: options.id, className: 'field-label' }, label), select, options.help && el('p', { className: 'field-help', id: `${options.id}-help` }, options.help));
  }
  function checkbox(label, checked, update, options = {}) {
    return el('label', { className: 'checkbox-row', for: options.id },
      el('input', { type: 'checkbox', id: options.id, checked, disabled: options.disabled, onChange: event => { update(event.target.checked); changed(); } }),
      el('span', { className: 'checkbox-copy' }, label, options.help && el('span', { className: 'field-help' }, options.help)));
  }
  function toggleValue(values, value, checked) { return checked ? [...new Set([...values, value])] : values.filter(item => item !== value); }
  function patterns(value) { return value.split(',').map(item => item.trim()).filter(Boolean); }
  function formatLabel(format) { return FORMATS.find(([id]) => id === format)?.[1] || format; }
  function normalized(raw) {
    const base = defaults();
    const result = { ...base, ...clone(raw || {}) };
    result.monitor = { ...base.monitor, ...result.monitor };
    for (const key of ['processes', 'cpu', 'lifecycle']) result.monitor[key] = { ...base.monitor[key], ...result.monitor[key] };
    result.routes = result.routes.map(route => ({ events: ['*'], processes: ['*'], excludeProcesses: [], severities: ['info', 'warning', 'critical'], scope: 'all', ...route }));
    return result;
  }
  function isDirty() {
    return JSON.stringify(state.config) !== JSON.stringify(normalized(state.savedConfig)) || Object.values(state.secrets).some(Boolean) || state.templateErrors.size > 0 || state.channelNameDrafts.size > 0;
  }
  function configured(name) { return state.configuredSecrets.includes(name) || Boolean(state.secrets[name]); }
  function changed() {
    updateSavebar();
    for (const item of document.querySelectorAll('[data-test-button]')) item.disabled = isDirty() || state.saving || state.testing.has(item.dataset.testButton);
    for (const item of document.querySelectorAll('[data-test-help]')) item.textContent = isDirty() ? 'Save changes before sending a test.' : 'Sends a real notification to this channel.';
  }
  function notify(message, kind = 'error', action = null) {
    state.notice = { message, kind, action };
    renderNotice();
    document.getElementById('notice')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  function noticeBox(message, kind = 'neutral') {
    return el('div', { className: `notice ${kind}` }, icon(kind === 'error' || kind === 'warning' ? 'alert' : 'info'), el('div', { className: 'notice-content' }, el('p', {}, message)));
  }
  function renderNotice() {
    const container = document.getElementById('notices');
    if (!container) return;
    container.replaceChildren();
    if (state.notice) {
      const current = state.notice;
      const box = noticeBox(current.message, current.kind);
      box.id = 'notice'; box.setAttribute('role', current.kind === 'error' ? 'alert' : 'status');
      if (current.action) box.querySelector('.notice-content').append(button(current.action.label, current.action.run));
      box.append(el('button', { type: 'button', className: 'notice-close', 'aria-label': 'Dismiss message', onClick: () => { state.notice = null; renderNotice(); } }, icon('close')));
      container.append(box);
    }
    if (state.loaded && !state.runtime.running && state.runtime.message) container.append(noticeBox(state.runtime.message, state.savedConfig ? 'warning' : 'neutral'));
  }
  async function api(path, body) {
    const response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'X-Notifier-Token': token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let data;
    try { data = await response.json(); } catch { throw new Error('The server returned an unreadable response. Check the notifier terminal and retry.'); }
    if (!response.ok) {
      const error = new Error(data.message || `Request failed (${response.status}).`);
      error.status = response.status; throw error;
    }
    return data;
  }
  function acceptState(data) {
    state.savedConfig = data.config ? clone(data.config) : null;
    state.config = normalized(data.config);
    state.revision = data.revision;
    state.configuredSecrets = data.configuredSecrets || [];
    state.runtime = data.runtime || { running: false };
    state.secrets = Object.create(null);
    state.channelNameDrafts.clear(); state.templateDrafts.clear(); state.templateErrors.clear(); state.testResults.clear();
    state.loaded = true;
  }
  async function load() {
    state.loading = true; state.notice = null; render();
    if (!token) {
      state.loading = false; state.loaded = false;
      state.notice = { kind: 'error', message: 'Open the complete setup URL printed in your terminal. It includes the session token needed to connect to this notifier.' };
      render(); return;
    }
    try { acceptState(await api('/api/state')); }
    catch (error) { state.notice = { kind: 'error', message: error.status === 401 || error.status === 403 ? 'This setup session is no longer authorized. Reopen the complete URL from the notifier terminal.' : `Could not load configuration. ${error.message}` }; }
    finally { state.loading = false; render(); }
  }
  function validate() {
    const config = state.config;
    for (const [destination, value] of state.channelNameDrafts) {
      return channelNameError(destination, value) || 'Finish editing the pending channel name before saving.';
    }
    if (!config.destinations.length) return 'Add a notification channel before saving.';
    if (!config.routes.length) return 'Add a workflow and assign a notification channel before saving.';
    if (state.templateErrors.size) return 'A custom JSON body is invalid. Fix the JSON in the channel’s advanced settings before saving.';
    const ids = new Set();
    for (const destination of config.destinations) {
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(destination.id)) return 'Channel names must contain 1–100 letters, numbers, hyphens, or underscores.';
      if (ids.has(destination.id)) return `The channel name “${destination.id}” is already in use. Give each channel a unique name.`;
      ids.add(destination.id);
      if (destination.enabled !== false && !configured(destination.urlEnv)) return `Add a webhook URL for “${destination.id}”, or turn off this channel.`;
      if (destination.enabled !== false) {
        for (const variable of Object.values(destination.headersEnv || {})) if (!configured(variable)) return `Add the missing header value for “${destination.id}” in its advanced settings.`;
      }
      const url = state.secrets[destination.urlEnv];
      if (url) {
        try {
          const parsed = new URL(url);
          if ((parsed.protocol !== 'https:' && !(destination.allowInsecureHttp && parsed.protocol === 'http:')) || parsed.username || parsed.password || parsed.hash) throw new Error();
        } catch { return `The webhook URL for “${destination.id}” must use HTTPS, without URL credentials or a fragment. HTTP can be enabled in advanced settings for local receivers.`; }
      }
    }
    for (let index = 0; index < config.routes.length; index++) {
      const route = config.routes[index];
      if (!route.destinations?.length) return `Choose at least one notification channel for workflow ${index + 1}.`;
      if (route.destinations.some(id => !ids.has(id))) return `Workflow ${index + 1} refers to a missing channel. Update its channel assignments.`;
      if (!route.events?.length) return `Choose at least one event for workflow ${index + 1}.`;
      if (!route.severities?.length) return `Choose at least one severity for workflow ${index + 1}.`;
      if (!route.processes?.length) return `Add a process name pattern for workflow ${index + 1}. Use * to include every process.`;
    }
    const cpu = config.monitor.cpu;
    if (cpu.recoveryThreshold >= cpu.threshold) return 'The CPU recovery threshold must be lower than the alert threshold.';
    if (cpu.scope !== 'process' && cpu.threshold > 100) return 'Use a CPU alert threshold of 100% or lower when monitoring host CPU.';
    if (!config.monitor.processes.include.length) return 'Add a monitored process pattern. Use * to monitor every process.';
    return null;
  }
  async function save(event) {
    event?.preventDefault();
    if (state.saving || !state.loaded) return;
    const form = document.getElementById('config-form');
    if (!form.reportValidity()) return;
    const error = validate();
    if (error) { notify(error); return; }
    const referenced = new Set(state.config.destinations.flatMap(destination => [destination.urlEnv, ...Object.values(destination.headersEnv || {})]));
    const secrets = Object.fromEntries(Object.entries(state.secrets).filter(([key, value]) => referenced.has(key) && value !== ''));
    state.saving = true; state.notice = null; render();
    try {
      const data = await api('/api/config', { revision: state.revision, config: state.config, secrets });
      acceptState(data);
      state.notice = { kind: data.runtime?.running ? 'success' : 'warning', message: data.message || (data.runtime?.running ? 'Configuration saved. Your workflows are now monitoring PM2.' : 'Configuration saved. Monitoring has not started; check the runtime message below.') };
    } catch (error) {
      state.notice = {
        kind: 'error', message: error.status === 409 ? 'The saved configuration changed in another session. Your edits are still here. Reload the saved configuration before applying new changes.' : `Could not apply configuration. ${error.message}`,
        ...(error.status === 409 ? { action: { label: 'Reload saved configuration', run: reloadWithConfirmation } } : {}),
      };
    } finally { state.saving = false; render(); }
  }
  function discard() {
    if (!isDirty() || window.confirm('Discard your unsaved changes and return to the saved configuration?')) {
      state.config = normalized(state.savedConfig); state.secrets = Object.create(null); state.channelNameDrafts.clear(); state.templateDrafts.clear(); state.templateErrors.clear(); state.openRoutes.clear(); state.openChannels.clear(); state.notice = null; render();
    }
  }
  function reloadWithConfirmation() {
    if (!isDirty() || window.confirm('Reloading will discard your unsaved changes. Reload the saved configuration?')) void load();
  }
  function uniqueId(prefix, values) {
    let suffix = 1;
    while (values.has(`${prefix}-${suffix}`)) suffix++;
    return `${prefix}-${suffix}`;
  }
  function newVariable(label) {
    const occupied = new Set([...state.configuredSecrets, ...state.config.destinations.flatMap(destination => [destination.urlEnv, ...Object.values(destination.headersEnv || {})])]);
    const base = `NOTIFIER_${label.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`;
    let variable = base; let suffix = 2;
    while (occupied.has(variable)) variable = `${base}_${suffix++}`;
    return variable;
  }
  function addChannel() {
    const id = uniqueId('channel', new Set(state.config.destinations.map(destination => destination.id)));
    const destination = { id, format: 'teams', urlEnv: newVariable(`${id}_WEBHOOK_URL`), enabled: true };
    state.config.destinations.push(destination); state.tab = 'channels';
    const index = state.config.destinations.length - 1; state.openChannels.add(index);
    render(); document.getElementById(`channel-${index}-name`)?.focus();
  }
  function addWorkflow() {
    if (!state.config.destinations.length) { addChannel(); return; }
    const destination = state.config.destinations.find(item => item.enabled !== false) || state.config.destinations[0];
    state.config.routes.push({ events: ['*'], processes: ['*'], excludeProcesses: [], scope: 'all', severities: ['info', 'warning', 'critical'], destinations: [destination.id] });
    const index = state.config.routes.length - 1; state.openRoutes.add(index); state.tab = 'workflows';
    render(); document.getElementById(`route-${index}-scope`)?.focus();
  }
  function deleteChannel(index) {
    const destination = state.config.destinations[index];
    const references = state.config.routes.filter(route => route.destinations.includes(destination.id));
    if (references.length) {
      notify(`“${destination.id}” is assigned to ${references.length} workflow${references.length === 1 ? '' : 's'}. Remove its assignments in Workflows before deleting this channel.`, 'warning', { label: 'Go to workflows', run: () => { state.tab = 'workflows'; state.openRoutes = new Set(state.config.routes.map((_, i) => i)); render(); } });
      return;
    }
    state.config.destinations.splice(index, 1); state.openChannels.clear(); state.channelNameDrafts.delete(destination); state.templateDrafts.delete(destination); state.templateErrors.delete(destination); render();
  }
  async function testChannel(destination) {
    if (isDirty() || state.testing.has(destination.id)) return;
    state.testing.add(destination.id); state.testResults.delete(destination.id); render();
    try {
      const data = await api('/api/test', { destination: destination.id });
      state.testResults.set(destination.id, { success: true, message: data.message || 'Test notification delivered.' });
    } catch (error) { state.testResults.set(destination.id, { success: false, message: `Test failed. ${error.message}` }); }
    finally { state.testing.delete(destination.id); render(); }
  }

  function channelNameError(destination, value) {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(value)) return 'Channel names must contain 1–100 letters, numbers, hyphens, or underscores.';
    if (state.config.destinations.some(item => item !== destination && item.id === value)) return `The channel name “${value}” is already in use. Give each channel a unique name.`;
    return '';
  }
  function renderChannel(destination, index) {
    const prefix = `channel-${index}`;
    const open = state.openChannels.has(index);
    const hasWebhook = configured(destination.urlEnv);
    const status = destination.enabled === false ? 'Paused' : hasWebhook ? 'Configured' : 'Needs webhook';
    const summary = el('button', {
      type: 'button', className: 'record-summary', 'aria-expanded': String(open), 'aria-controls': `${prefix}-body`,
      onClick: () => { open ? state.openChannels.delete(index) : state.openChannels.add(index); render(); document.getElementById(`${prefix}-summary`)?.focus(); }, id: `${prefix}-summary`,
    }, el('span', { className: 'record-symbol' }, icon('channel')),
    el('span', { className: 'record-title-group' }, el('span', { className: 'record-title' }, destination.id || 'Unnamed channel'), el('span', { className: 'record-subtitle' }, formatLabel(destination.format))),
    el('span', { className: `badge ${destination.enabled === false ? 'muted' : hasWebhook ? '' : 'warning'}` }, status), icon('chevron', 'record-chevron'));
    const record = el('section', { className: 'record' }, summary);
    if (!open) { record.append(el('div', { id: `${prefix}-body`, hidden: true })); return record; }
    const draftName = state.channelNameDrafts.get(destination);
    const name = inputField('Channel name', draftName ?? destination.id, value => {
      const error = channelNameError(destination, value);
      document.getElementById(`${prefix}-name`).setCustomValidity(error);
      if (error) { state.channelNameDrafts.set(destination, value); return; }
      state.channelNameDrafts.delete(destination);
      const previous = destination.id;
      destination.id = value;
      for (const route of state.config.routes) route.destinations = route.destinations.map(id => id === previous ? value : id);
    }, { id: `${prefix}-name`, required: true, maxlength: 100, pattern: '[A-Za-z0-9_\\-]+', help: 'A unique name, such as operations-slack. Use letters, numbers, - or _.' });
    if (draftName !== undefined) name.querySelector('input').setCustomValidity(channelNameError(destination, draftName) || 'Finish editing this channel name before saving.');
    const provider = selectField('Notification service', destination.format, FORMATS, value => {
      if ((destination.template !== undefined || state.templateErrors.has(destination)) && value !== 'generic') {
        notify('Clear this channel’s custom JSON body before switching to a different notification service.');
        document.getElementById(`${prefix}-format`).value = destination.format;
        return;
      }
      destination.format = value; render();
    }, { id: `${prefix}-format` });
    const savedWebhook = state.configuredSecrets.includes(destination.urlEnv);
    const webhook = inputField('Webhook URL', state.secrets[destination.urlEnv] || '', value => { state.secrets[destination.urlEnv] = value.trim(); }, {
      id: `${prefix}-url`, type: 'password', autocomplete: 'new-password', spellcheck: 'false', placeholder: savedWebhook ? 'Paste a new URL to replace the saved webhook' : 'https://…', full: true,
      help: savedWebhook ? 'Webhook saved — leave blank to keep it. Saved credentials are never displayed.' : 'Paste the full webhook URL from your notification service. Saved privately on this server.',
    });
    const body = el('div', { className: 'record-body', id: `${prefix}-body` }, el('div', { className: 'form-grid' }, name, provider, webhook));
    body.append(el('div', { className: 'form-section' }, checkbox('Channel enabled', destination.enabled !== false, checked => { destination.enabled = checked; }, { id: `${prefix}-enabled`, help: 'Paused channels keep their workflow assignments but do not receive notifications.' })));
    body.append(channelAdvanced(destination, index));
    const savedDestination = state.savedConfig?.destinations?.find(item => item.id === destination.id && item.enabled !== false);
    const test = button(state.testing.has(destination.id) ? 'Sending test…' : 'Test channel', () => void testChannel(destination), {
      icon: 'send', attrs: { disabled: !savedDestination || isDirty() || state.testing.has(destination.id), 'data-test-button': savedDestination ? destination.id : null, title: savedDestination ? 'Send a real notification using the saved channel' : 'Save and enable this channel before testing' },
    });
    body.append(el('div', { className: 'record-footer' },
      el('div', { className: 'test-group' }, test, el('span', { className: 'field-help', 'data-test-help': savedDestination ? 'true' : null }, !savedDestination ? 'Save and enable this channel to test it.' : isDirty() ? 'Save changes before sending a test.' : 'Sends a real notification to this channel.')),
      button('Delete channel', () => deleteChannel(index), { kind: 'quiet danger', icon: 'trash' })));
    const testResult = state.testResults.get(destination.id);
    if (testResult) {
      const result = noticeBox(testResult.message, testResult.success ? 'success' : 'error');
      result.setAttribute('role', testResult.success ? 'status' : 'alert'); body.append(result);
    }
    record.append(body); return record;
  }
  function channelAdvanced(destination, index) {
    const prefix = `channel-${index}`;
    const advanced = el('details', { className: 'advanced' }, el('summary', {}, 'Advanced channel settings'));
    advanced.append(el('div', { className: 'form-grid' },
      inputField('Webhook environment variable', destination.urlEnv, value => {
        const previous = destination.urlEnv;
        if (state.secrets[previous] && previous !== value) state.secrets[value] = state.secrets[previous];
        destination.urlEnv = value;
      }, { id: `${prefix}-env`, pattern: '[A-Za-z_][A-Za-z0-9_]*', required: true, help: 'Generated automatically. Change this only to use an existing variable.' }),
      el('div', { className: 'field' }, el('span', { className: 'field-label' }, 'Transport'), checkbox('Allow HTTP', destination.allowInsecureHttp === true, checked => { destination.allowInsecureHttp = checked; }, { id: `${prefix}-http`, help: 'For local receivers that do not support HTTPS.' }))));
    const headerSection = el('div', { className: 'form-section' });
    headerSection.append(el('div', { className: 'section-topline' }, el('h3', {}, 'Request headers'), button('Add header', () => {
      destination.headersEnv ||= {};
      let headerName = 'Authorization'; let suffix = 2;
      while (Object.hasOwn(destination.headersEnv, headerName)) headerName = `X-Custom-${suffix++}`;
      destination.headersEnv[headerName] = newVariable(`${destination.id}_${headerName}`);
      render(); const panel = document.getElementById(`${prefix}-advanced`); if (panel) panel.open = true;
    }, { kind: 'quiet', icon: 'plus' })));
    const headers = Object.entries(destination.headersEnv || {});
    if (!headers.length) headerSection.append(el('p', { className: 'field-help' }, 'Optional. Add authorization or other headers required by your receiver.'));
    else headerSection.append(el('div', { className: 'headers' }, headers.map(([name, variable], headerIndex) => {
      let currentName = name;
      return el('div', { className: 'header-row' },
        inputField('Header name', name, value => {
          if (value !== currentName && Object.hasOwn(destination.headersEnv, value)) {
            document.getElementById(`${prefix}-header-${headerIndex}-name`).setCustomValidity('This header name is already in use.'); return;
          }
          document.getElementById(`${prefix}-header-${headerIndex}-name`).setCustomValidity('');
          const updated = { ...destination.headersEnv }; delete updated[currentName];
          destination.headersEnv = { ...updated, [value]: variable }; currentName = value;
        }, { id: `${prefix}-header-${headerIndex}-name`, required: true }),
        inputField('Header value', state.secrets[variable] || '', value => { state.secrets[variable] = value; }, { id: `${prefix}-header-${headerIndex}-value`, type: 'password', autocomplete: 'new-password', placeholder: state.configuredSecrets.includes(variable) ? 'Saved — leave blank to keep' : 'Enter header value', help: `Stored as ${variable}` }),
        button(icon('trash'), () => { delete destination.headersEnv[currentName]; render(); document.getElementById(`${prefix}-advanced`).open = true; }, { kind: 'quiet danger icon-button', attrs: { 'aria-label': `Remove ${name} header` } }));
    })));
    advanced.id = `${prefix}-advanced`; advanced.append(headerSection);
    if (destination.format === 'generic') {
      const value = state.templateDrafts.has(destination) ? state.templateDrafts.get(destination) : destination.template === undefined ? '' : JSON.stringify(destination.template, null, 2);
      const template = el('textarea', {
        id: `${prefix}-template`, className: 'code-input', spellcheck: 'false', 'aria-describedby': `${prefix}-template-help`,
        onInput: event => {
          const text = event.target.value; state.templateDrafts.set(destination, text);
          if (!text.trim()) { delete destination.template; state.templateErrors.delete(destination); event.target.setCustomValidity(''); }
          else {
            try { destination.template = JSON.parse(text); state.templateErrors.delete(destination); event.target.setCustomValidity(''); }
            catch { state.templateErrors.add(destination); event.target.setCustomValidity('Enter a valid JSON value, or clear the custom body.'); }
          }
          changed();
        },
      });
      template.value = value;
      if (state.templateErrors.has(destination)) template.setCustomValidity('Enter a valid JSON value, or clear the custom body.');
      advanced.append(el('div', { className: 'form-section field' }, el('label', { for: `${prefix}-template`, className: 'field-label' }, 'Custom JSON body (optional)'), template,
        el('p', { className: 'field-help', id: `${prefix}-template-help` }, 'Leave blank to send the standard alert. Use placeholders such as {{message}}, {{type}}, {{hostname}}, {{process}}, and {{details}}.')));
    }
    return advanced;
  }
  function workflowTitle(route) {
    if (route.events.includes('*')) return 'All events';
    if (!route.events.length) return 'Choose alert events';
    const first = EVENT_CHOICES.find(([value]) => value === route.events[0])?.[1] || route.events[0];
    return route.events.length > 1 ? `${first} + ${route.events.length - 1} more` : first;
  }
  function renderWorkflow(route, index) {
    const prefix = `route-${index}`;
    const open = state.openRoutes.has(index);
    const processLabel = route.scope === 'host' ? 'Host only' : route.processes.length === 1 && route.processes[0] === '*' ? route.scope === 'process' ? 'Every process' : 'Host & every process' : route.processes.join(', ') || 'No processes';
    const summary = el('button', {
      type: 'button', className: 'record-summary', id: `${prefix}-summary`, 'aria-expanded': String(open), 'aria-controls': `${prefix}-body`,
      onClick: () => { open ? state.openRoutes.delete(index) : state.openRoutes.add(index); render(); document.getElementById(`${prefix}-summary`)?.focus(); },
    }, el('span', { className: 'record-symbol' }, icon('workflow')),
    el('span', { className: 'record-title-group' }, el('span', { className: 'record-title' }, workflowTitle(route)),
      el('span', { className: 'record-subtitle' }, processLabel, icon('arrow'), route.destinations.join(', ') || 'No channel assigned')),
    el('span', { className: `badge${route.destinations.length ? '' : ' warning'}` }, `${route.destinations.length} channel${route.destinations.length === 1 ? '' : 's'}`), icon('chevron', 'record-chevron'));
    const record = el('section', { className: 'record' }, summary);
    if (!open) { record.append(el('div', { id: `${prefix}-body`, hidden: true })); return record; }
    const body = el('div', { className: 'record-body', id: `${prefix}-body` });
    body.append(el('div', { className: 'form-grid' },
      selectField('Monitor scope', route.scope, [['all', 'Host and processes'], ['process', 'Processes only'], ['host', 'Host only']], value => { route.scope = value; render(); }, { id: `${prefix}-scope` }),
      inputField('Include processes', route.processes.join(', '), value => { route.processes = patterns(value); }, { id: `${prefix}-include`, required: true, help: route.scope === 'host' ? 'Use * to match host events. Named process patterns do not match host events.' : 'Comma-separated names or patterns. Use * for all, or payments-*.' }),
      inputField('Exclude processes (optional)', route.excludeProcesses.join(', '), value => { route.excludeProcesses = patterns(value); }, { id: `${prefix}-exclude`, disabled: route.scope === 'host', full: true, help: 'For example: test-*, worker-dev. Exclusions apply to process events.' })));
    const events = el('fieldset', { className: 'form-section' }, el('legend', {}, 'When these events happen'));
    const anySelected = route.events.includes('*');
    const ordinaryEvents = EVENT_CHOICES.slice(0, 9);
    events.append(el('div', { className: 'checkbox-grid' }, ordinaryEvents.map(([value, label]) => checkbox(label, route.events.includes(value), checked => {
      if (value === '*') route.events = checked ? ['*'] : [];
      else route.events = toggleValue(route.events.filter(item => item !== '*'), value, checked);
      render();
    }, { id: `${prefix}-event-${value.replace(/[^a-z0-9]/gi, '-')}`, disabled: value !== '*' && anySelected }))));
    const importedGroups = EVENT_CHOICES.slice(9).filter(([value]) => route.events.includes(value));
    if (importedGroups.length) {
      const groupChoices = importedGroups.map(([value, label]) => checkbox(label, true, checked => {
        route.events = toggleValue(route.events, value, checked); render();
      }, { id: `${prefix}-group-${value.replace(/[^a-z0-9]/gi, '-')}` }));
      events.append(el('div', { className: 'form-section' },
        el('p', { className: 'section-description' }, 'Event groups from your saved configuration'),
        el('div', { className: 'checkbox-grid' }, groupChoices)));
    }
    events.append(el('p', { className: 'field-help' }, 'Process-start alerts also require “Notify when a process starts” in Monitoring.'));
    body.append(events);
    body.append(el('fieldset', { className: 'form-section' }, el('legend', {}, 'Severity'), el('div', { className: 'checkbox-group' }, SEVERITIES.map(([value, label]) => checkbox(label, route.severities.includes(value), checked => { route.severities = toggleValue(route.severities, value, checked); }, { id: `${prefix}-severity-${value}` })))));
    const channels = el('fieldset', { className: 'form-section' }, el('legend', {}, 'Send notifications to'), el('div', { className: 'checkbox-grid' }, state.config.destinations.map((destination, channelIndex) => checkbox(destination.id || 'Unnamed channel', route.destinations.includes(destination.id), checked => { route.destinations = toggleValue(route.destinations, destination.id, checked); }, { id: `${prefix}-channel-${channelIndex}`, help: `${formatLabel(destination.format)}${destination.enabled === false ? ' · paused' : ''}` }))));
    body.append(channels);
    body.append(el('div', { className: 'record-footer' }, el('span', { className: 'field-help' }, 'Matching events are sent to every selected, enabled channel.'), button('Delete workflow', () => { state.config.routes.splice(index, 1); state.openRoutes.clear(); render(); }, { kind: 'quiet danger', icon: 'trash' })));
    record.append(body); return record;
  }
  function renderMonitoring() {
    const monitor = state.config.monitor;
    const cpu = monitor.cpu;
    const lifecycle = monitor.lifecycle;
    const section = (heading, symbol, ...children) => el('section', { className: 'settings-panel' }, el('div', { className: 'settings-heading' }, icon(symbol), el('h2', {}, heading)), ...children);
    const number = (label, key, object, options = {}) => inputField(label, options.seconds ? object[key] / 1000 : object[key], value => {
      object[key] = options.seconds ? Math.round(Number(value) * 1000) : Number(value);
    }, { id: `monitor-${key}`, type: 'number', required: true, step: options.seconds ? '0.001' : 'any', min: options.min ?? 0, max: options.max ?? 100000, help: options.help });
    return [
      section('Environment', 'server', el('div', { className: 'form-grid' },
        inputField('Environment label (optional)', state.config.environment || '', value => { if (value) state.config.environment = value; else delete state.config.environment; }, { id: 'monitor-environment', maxlength: 200, placeholder: 'production', help: 'Included in notifications to identify this environment.' }),
        inputField('Hostname (optional)', state.config.hostname || '', value => { if (value) state.config.hostname = value; else delete state.config.hostname; }, { id: 'monitor-hostname', maxlength: 200, placeholder: 'Use this machine’s hostname', help: 'Leave blank to use the hostname of this server.' }))),
      section('CPU alerts', 'monitor',
        checkbox('Monitor CPU usage', cpu.enabled, checked => { cpu.enabled = checked; }, { id: 'monitor-cpu-enabled', help: 'Send an alert after CPU stays above the threshold for the selected duration.' }),
        el('div', { className: 'form-grid' },
          selectField('CPU scope', cpu.scope, [['both', 'Host and processes'], ['host', 'Host only'], ['process', 'Processes only']], value => { cpu.scope = value; }, { id: 'monitor-cpu-scope', full: true, help: 'Host usage is 0–100%. A process may exceed 100% on multiple cores.' }),
          number('Alert threshold (%)', 'threshold', cpu, { min: 1 }),
          number('Above threshold for (seconds)', 'durationMs', cpu, { seconds: true, min: .001, max: 86400 }),
          number('Recovery threshold (%)', 'recoveryThreshold', cpu, { min: 0, help: 'Must be lower than the alert threshold.' }),
          number('Recovered for (seconds)', 'recoveryDurationMs', cpu, { seconds: true, min: .001, max: 86400 }))),
      section('Process lifecycle', 'workflow',
        checkbox('Monitor process lifecycle', lifecycle.enabled, checked => { lifecycle.enabled = checked; }, { id: 'monitor-lifecycle-enabled', help: 'Watch for restarts, stops, errors, and deleted processes.' }),
        checkbox('Notify when a process starts', lifecycle.notifyOnStart, checked => { lifecycle.notifyOnStart = checked; }, { id: 'monitor-start', help: 'Off by default to keep initial startup quiet.' }),
        el('div', { className: 'form-grid' }, number('Settlement window (seconds)', 'settleMs', lifecycle, { seconds: true, min: 0, max: 60, help: 'Wait before reporting a stop, so quick restarts can settle.' }))),
      section('Collection settings', 'clock', el('div', { className: 'form-grid' },
        number('Check CPU every (seconds)', 'pollIntervalMs', monitor, { seconds: true, min: .5, max: 60 }),
        inputField('Monitored processes', monitor.processes.include.join(', '), value => { monitor.processes.include = patterns(value); }, { id: 'monitor-process-include', required: true, help: 'Use * for every process, or comma-separated patterns.' }),
        inputField('Excluded processes (optional)', monitor.processes.exclude.join(', '), value => { monitor.processes.exclude = patterns(value); }, { id: 'monitor-process-exclude', full: true, help: 'Excluded processes are not collected and cannot match a workflow.' }),
        el('div', { className: 'full-width' }, checkbox('Include PM2 modules', monitor.processes.includeModules, checked => { monitor.processes.includeModules = checked; }, { id: 'monitor-modules', help: 'Modules are excluded from collection by default.' })))),
    ];
  }
  function renderEmpty(type) {
    const channelsExist = state.config.destinations.length > 0;
    const title = type === 'channels' ? 'Give your alerts somewhere to go' : channelsExist ? 'Create your first workflow' : 'Your first alert starts with a channel';
    const description = type === 'channels' ? 'Connect a Teams, Slack, Discord, or webhook channel. You can use the same channel in any number of workflows.' : channelsExist ? 'Choose the events and processes to watch, then assign the channels that should receive those alerts.' : 'Connect your notification service, then choose which PM2 events should reach your team. No configuration files to edit.';
    return el('section', { className: 'empty-state' }, el('div', { className: 'empty-symbol' }, icon(type === 'channels' || !channelsExist ? 'channel' : 'workflow')),
      el('h2', {}, title), el('p', {}, description),
      button(type === 'channels' || !channelsExist ? 'Add your first channel' : 'Create workflow', type === 'channels' || !channelsExist ? addChannel : addWorkflow, { kind: 'primary', icon: 'plus' }),
      type === 'workflows' && !channelsExist && el('div', { className: 'empty-how' }, 'Connect a channel', icon('arrow'), 'Create a workflow', icon('arrow'), 'Save and apply'));
  }
  function renderSidebar() {
    const channelReady = state.config.destinations.some(destination => destination.enabled !== false && configured(destination.urlEnv));
    const workflowsReady = state.config.routes.some(route => route.destinations.length > 0);
    return el('aside', { className: 'sidebar' }, el('nav', { className: 'nav', 'aria-label': 'Setup sections' },
      [['workflows', 'Workflows', 'workflow', state.config.routes.length], ['channels', 'Channels', 'channel', state.config.destinations.length], ['monitoring', 'Monitoring', 'monitor', null]].map(([id, label, symbol, count]) => el('button', {
        type: 'button', className: 'nav-button', 'aria-current': state.tab === id ? 'page' : null, disabled: state.saving,
        onClick: () => { state.tab = id; render(); document.getElementById('page-title')?.focus(); },
      }, icon(symbol), label, count !== null && el('span', { className: 'nav-count', 'aria-label': `${count} ${label.toLowerCase()}` }, count)))),
    el('section', { className: 'setup-guide', 'aria-label': 'Setup checklist' }, el('h2', {}, 'Ready to notify'),
      el('ul', { className: 'checklist' }, [[channelReady, 'Connect a channel'], [workflowsReady, 'Create a workflow'], [Boolean(state.savedConfig) && state.runtime.running && !isDirty(), 'Save and apply']].map(([done, text]) => el('li', { className: done ? 'complete' : '' }, icon(done ? 'check' : 'circle'), text)))),
    el('p', { className: 'sidebar-note' }, icon('lock'), 'Local setup. Your webhook credentials stay on this server.'));
  }
  function updateSavebar() {
    const container = document.getElementById('savebar');
    if (!container) return;
    const dirty = isDirty();
    let label = dirty ? 'Unsaved changes' : state.savedConfig ? 'All changes saved' : 'Not saved yet';
    if (state.saving) label = 'Applying configuration…';
    container.replaceChildren(
      el('div', { className: `save-status${dirty ? ' pending' : ''}`, role: 'status', 'aria-live': 'polite' }, icon(dirty || state.saving ? 'clock' : state.savedConfig ? 'check' : 'circle'), label),
      el('div', { className: 'save-actions' }, dirty && button('Discard changes', discard, { kind: 'quiet', attrs: { disabled: state.saving } }),
        el('button', { type: 'submit', form: 'config-form', className: 'button primary', disabled: !state.loaded || state.saving || (!dirty && (state.runtime.running || !state.savedConfig)) }, icon('save'), state.saving ? 'Applying…' : 'Save and apply')));
  }
  function render() {
    const focusedId = document.activeElement?.id;
    const detailsOpen = [...document.querySelectorAll('details[open]')].map(item => item.id);
    const headings = {
      workflows: ['Workflows', 'Choose which PM2 events matter, and where they go.'],
      channels: ['Notification channels', 'Connect the places your team already checks.'],
      monitoring: ['Monitoring', 'Set when an event becomes an alert. Your workflows decide who receives it.'],
    };
    const [title, description] = headings[state.tab];
    const top = el('header', { className: 'topbar' },
      el('div', { className: 'brand' }, icon('monitor', 'brand-mark'), el('span', {}, 'pm2-notifier'), el('span', { className: 'brand-divider' }), el('span', { className: 'brand-label' }, 'Configuration workspace')),
      el('div', { className: 'topbar-actions' },
        el('div', { className: `runtime-badge${state.runtime.running ? ' running' : ''}`, role: 'status' }, el('span', { className: 'status-dot' }), el('span', { className: 'runtime-label' }, state.loading ? 'Connecting…' : !state.loaded ? 'Not connected' : state.runtime.running ? 'Monitoring active' : state.savedConfig ? 'Monitoring stopped' : 'Awaiting setup')),
        themeToggle()));
    const heading = el('div', { className: 'page-header' }, el('div', {}, el('h1', { id: 'page-title', tabindex: '-1' }, title), el('p', { className: 'page-description' }, description)));
    if (state.loaded && !state.loading && state.tab === 'channels' && state.config.destinations.length) heading.append(button('Add channel', addChannel, { icon: 'plus', attrs: { disabled: state.saving } }));
    if (state.loaded && !state.loading && state.tab === 'workflows' && state.config.routes.length) heading.append(button('Add workflow', addWorkflow, { icon: 'plus', attrs: { disabled: state.saving } }));
    const main = el('main', { className: 'workspace', id: 'main', tabindex: '-1' }, heading, el('div', { id: 'notices' }));
    if (state.loading) main.append(el('div', { className: 'loading-content', role: 'status', 'aria-label': 'Loading configuration' }, el('div', { className: 'skeleton', 'aria-hidden': true }), el('div', { className: 'skeleton', 'aria-hidden': true }), el('span', { className: 'visually-hidden' }, 'Loading configuration…')));
    else if (!state.loaded) main.append(button('Retry connection', () => void load(), { icon: 'arrow' }));
    else {
      const content = el('fieldset', { disabled: state.saving, 'aria-label': title });
      if (state.tab === 'channels') content.append(state.config.destinations.length ? el('div', { className: 'record-list' }, state.config.destinations.map(renderChannel)) : renderEmpty('channels'));
      if (state.tab === 'workflows') {
        content.append(state.config.routes.length ? el('div', { className: 'record-list' }, state.config.routes.map(renderWorkflow)) : renderEmpty('workflows'));
        if (state.config.routes.length) content.append(el('p', { className: 'footer-note' }, icon('info'), 'Each workflow matches events independently. A channel receives a matching event once, even when multiple workflows select it.'));
      }
      if (state.tab === 'monitoring') content.append(...renderMonitoring());
      main.append(el('form', { id: 'config-form', onSubmit: event => void save(event) }, content));
    }
    root.replaceChildren(top, el('div', { className: 'layout' }, renderSidebar(), main), el('footer', { className: 'savebar', id: 'savebar', 'aria-label': 'Configuration actions' }));
    renderNotice(); updateSavebar(); updateThemeToggle();
    for (const id of detailsOpen) { const details = document.getElementById(id); if (details) details.open = true; }
    if (focusedId) document.getElementById(focusedId)?.focus({ preventScroll: true });
  }
  window.addEventListener('beforeunload', event => {
    if (state.loaded && isDirty()) { event.preventDefault(); event.returnValue = ''; }
  });
  void load();
})();
