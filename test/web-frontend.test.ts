import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

interface Channel { id: string; format: string; urlEnv: string; enabled: boolean }
interface Frontend {
  state: {
    config: { destinations: Channel[]; routes: Array<{ destinations: string[] }> };
    openChannels: Set<number>;
    channelNameDrafts: Map<Channel, string>;
  };
  acceptState(value: unknown): void;
  renderChannel(destination: Channel, index: number): ElementStub;
  validate(): string | null;
  isDirty(): boolean;
  discard(): void;
}

// A small DOM surface for executing the real input handlers. No browser logic is
// copied into the regression test; the application is evaluated unchanged except
// that its initial network load is replaced with access to the tested functions.
class ElementStub {
  value = '';
  validationMessage = '';
  children: ElementStub[] = [];
  listeners = new Map<string, (event: { target: ElementStub }) => void>();
  constructor(readonly tag: string, private readonly ids: Map<string, ElementStub>) {}
  setAttribute(key: string, value: string): void { if (key === 'id') this.ids.set(value, this); }
  addEventListener(name: string, listener: (event: { target: ElementStub }) => void): void { this.listeners.set(name, listener); }
  append(...children: ElementStub[]): void { this.children.push(...children); }
  replaceChildren(...children: ElementStub[]): void { this.children = children; }
  querySelector(tag: string): ElementStub | undefined {
    return this.children.find(child => child.tag === tag) || this.children.map(child => child.querySelector(tag)).find(Boolean);
  }
  setCustomValidity(message: string): void { this.validationMessage = message; }
  input(value: string): void { this.value = value; this.listeners.get('input')?.({ target: this }); }
}

function frontend() {
  const ids = new Map<string, ElementStub>();
  const make = (tag: string) => new ElementStub(tag, ids);
  ids.set('app', make('div'));
  const source = readFileSync(join(__dirname, '../src/web/app.js'), 'utf8');
  const boot = '  void load();\n})();';
  assert.equal(source.split(boot).length, 2, 'The test must replace only the initial network load.');
  const context = {
    Node: ElementStub, URLSearchParams, URL,
    document: { getElementById: (id: string) => ids.get(id), createElement: make,
      createElementNS: (_namespace: string, tag: string) => make(tag), createTextNode: () => make('#text'),
      querySelectorAll: () => [], documentElement: { dataset: { theme: 'dark' } } },
    window: { addEventListener: () => {}, confirm: () => true },
    location: { hash: '', pathname: '/', search: '' },
    sessionStorage: { getItem: () => null },
    ui: undefined as Frontend | undefined,
  };
  runInNewContext(source.replace(boot, '  globalThis.ui = { state, acceptState, renderChannel, validate, isDirty, discard };\n})();'), context);
  const ui = context.ui!;
  ui.acceptState({ revision: 'test', configuredSecrets: [], runtime: { running: false }, config: {
    destinations: [{ id: 'ops', format: 'teams', urlEnv: 'OPS', enabled: false }, { id: 'payments', format: 'slack', urlEnv: 'PAYMENTS', enabled: false }],
    routes: [{ destinations: ['ops'] }, { destinations: ['payments'] }, { destinations: ['ops', 'payments'] }],
  } });
  ui.state.openChannels.add(0);
  const renderName = () => {
    ui.renderChannel(ui.state.config.destinations[0], 0);
    return ids.get('channel-0-name')!;
  };
  const assignments = () => JSON.parse(JSON.stringify(ui.state.config.routes.map(route => route.destinations))) as string[][];
  return { ui, renderName, assignments };
}

test('duplicate channel-name drafts cannot redirect another channel’s workflows', () => {
  const { ui, renderName, assignments } = frontend();
  let input = renderName();
  input.input('payments');
  assert.match(input.validationMessage, /already in use/);
  assert.equal(ui.state.config.destinations[0].id, 'ops');
  assert.deepEqual(assignments(), [['ops'], ['payments'], ['ops', 'payments']]);
  assert.equal(ui.isDirty(), true);
  assert.match(ui.validate()!, /already in use/);

  input = renderName(); // Equivalent to reopening the channel after a rerender.
  assert.equal(input.value, 'payments');
  assert.match(input.validationMessage, /already in use/);
  input.input('ops-new');
  assert.equal(input.validationMessage, '');
  assert.equal(ui.state.channelNameDrafts.size, 0);
  assert.deepEqual(assignments(), [['ops-new'], ['payments'], ['ops-new', 'payments']]);
  assert.equal(ui.validate(), null);
});

test('clearing or mistyping a channel name preserves routing until a valid edit', () => {
  const { ui, renderName, assignments } = frontend();
  let input = renderName();
  for (const value of ['', 'invalid name']) {
    input.input(value);
    assert.equal(ui.state.config.destinations[0].id, 'ops');
    assert.deepEqual(assignments(), [['ops'], ['payments'], ['ops', 'payments']]);
    assert.match(ui.validate()!, /Channel names/);
    input = renderName();
    assert.equal(input.value, value);
    assert.notEqual(input.validationMessage, '');
  }
  for (const value of ['p', 'pa', 'pay', 'payments', 'payments-new']) input.input(value);
  assert.equal(ui.state.config.destinations[0].id, 'payments-new');
  assert.deepEqual(assignments(), [['payments-new'], ['payments'], ['payments-new', 'payments']]);
  assert.equal(ui.validate(), null);
});

test('discard clears invalid channel-name drafts and restores the saved assignments', () => {
  const { ui, renderName, assignments } = frontend();
  renderName().input('payments');
  ui.discard();
  assert.equal(ui.state.channelNameDrafts.size, 0);
  assert.equal(ui.isDirty(), false);
  assert.deepEqual(assignments(), [['ops'], ['payments'], ['ops', 'payments']]);
  ui.state.openChannels.add(0);
  assert.equal(renderName().value, 'ops');
});
