// Voice control on screen: a mic button in the top bar (tap to talk), a card at the
// bottom that shows what was heard and the answer, and the Voice sheet (status, type a
// command, things to say, settings). The listening itself happens on the Pi in
// voice/pidisplay_voice.py; the server (server/voice.js) relays its events here.
import { call, onServerEvent } from './api';
import { h } from './dom';
import { closeSheet, openSheet, settingsForm, type SheetHandle } from './sheet';
import type { SettingField } from './types';
import './voice.css';

interface VoiceSettings {
  enabled: boolean;
  wakeWord: string;
  sensitivity: number;
  speak: boolean;
  speechVolume: number;
  chime: boolean;
  duck: boolean;
  [key: string]: unknown;
}

interface ServiceInfo {
  running: boolean;
  mic?: boolean;
  micName?: string | null;
  wakeWord?: string | null;
  stt?: string | null;
  tts?: string | null;
  error?: string | null;
}

interface VoiceState {
  settings: VoiceSettings;
  service: ServiceInfo;
  wakeWords: { id: string; label: string }[];
  examples: { group: string; items: string[] }[];
  history: { at: number; heard: string; reply: string; ok: boolean }[];
}

export type VoiceAction =
  | { type: 'page'; index: number; name?: string }
  | { type: 'nextPage' | 'prevPage' | 'close' | 'back' | 'reload' | 'help' | 'resume' }
  | { type: 'hold'; minutes: number }
  | { type: 'widget'; widget: string };

interface VoiceEvent {
  type: 'wake' | 'partial' | 'thinking' | 'speaking' | 'idle' | 'error' | 'result' | 'status';
  text?: string;
  heard?: string;
  reply?: string;
  ok?: boolean;
  action?: VoiceAction;
  expectReply?: boolean;
  service?: ServiceInfo;
}

/** What the voice card can ask of the dashboard shell. */
export interface VoiceHost {
  goTo(index: number): void;
  step(delta: number): void;
  hold(ms: number): void;
}

const SENSITIVITY = [
  { value: '0.35', label: 'Easy to wake (more false wakes)' },
  { value: '0.5', label: 'Normal' },
  { value: '0.7', label: 'Strict (fewer false wakes)' },
];

export class VoiceUI {
  private card = h('div', { class: 'voice-card', hidden: true, role: 'status', 'aria-live': 'polite' });
  private icon = h('div', { class: 'voice-icon' }, '🎙️');
  private heardEl = h('div', { class: 'voice-heard' });
  private replyEl = h('div', { class: 'voice-reply' });
  private hideTimer = 0;
  private sheet: SheetHandle | null = null;
  private renderSheet: (() => void) | null = null;
  private state: VoiceState | null = null;
  readonly button = h(
    'button',
    { class: 'btn btn-ghost bar-btn voice-btn', 'aria-label': 'Voice control', onclick: () => this.tapToTalk() },
    '🎙️',
  );

  constructor(
    hostEl: HTMLElement,
    private host: VoiceHost,
  ) {
    this.card.append(this.icon, h('div', { class: 'voice-text' }, this.heardEl, this.replyEl));
    this.card.addEventListener('click', () => this.dismiss());
    hostEl.append(this.card);
    // Hold the mic button to open the Voice sheet.
    let pressTimer = 0;
    let held = false;
    this.button.addEventListener('pointerdown', () => {
      held = false;
      pressTimer = window.setTimeout(() => {
        held = true;
        this.openSheet();
      }, 600);
    });
    const release = () => clearTimeout(pressTimer);
    this.button.addEventListener('pointerup', release);
    this.button.addEventListener('pointerleave', release);
    this.button.addEventListener('click', (e) => held && e.stopImmediatePropagation(), true);

    onServerEvent<VoiceEvent>('voice', (e) => this.onEvent(e));
    void this.refresh();
  }

  private async refresh() {
    try {
      this.state = await call<VoiceState>('GET', '/api/voice');
      this.button.classList.toggle('voice-off', !this.state.service.running);
      this.renderSheet?.();
    } catch {
      // Server not up yet; the next status event fills this in.
    }
  }

  private async tapToTalk() {
    if (!this.state?.service.running) {
      this.openSheet();
      return;
    }
    try {
      await call('POST', '/api/voice/listen', {});
      this.show('listening', '', 'Listening…');
    } catch (err) {
      this.show('error', '', (err as Error).message);
    }
  }

  private dismiss() {
    if (this.card.classList.contains('listening')) void call('POST', '/api/voice/cancel', {}).catch(() => {});
    this.hide();
  }

  private hide() {
    clearTimeout(this.hideTimer);
    this.card.hidden = true;
    this.card.className = 'voice-card';
  }

  /** Shows the card in a mode; `ms` hides it again after that long. */
  private show(mode: 'listening' | 'thinking' | 'result' | 'error', heard: string, reply: string, ms = 0) {
    clearTimeout(this.hideTimer);
    this.card.hidden = false;
    this.card.className = `voice-card ${mode}`;
    this.icon.textContent = mode === 'error' ? '⚠️' : mode === 'result' ? '💬' : '🎙️';
    this.heardEl.textContent = heard ? `“${heard}”` : '';
    this.replyEl.textContent = reply;
    if (ms) this.hideTimer = window.setTimeout(() => this.hide(), ms);
  }

  private onEvent(e: VoiceEvent) {
    switch (e.type) {
      case 'status':
        void this.refresh();
        return;
      case 'wake':
        this.show('listening', '', 'Listening…', 15000);
        return;
      case 'partial':
        if (!this.card.classList.contains('result')) this.show('listening', e.text ?? '', 'Listening…', 15000);
        return;
      case 'thinking':
        this.show('thinking', e.text ?? '', '…', 15000);
        return;
      case 'error':
        this.show('error', '', e.text ?? 'Something went wrong', 6000);
        return;
      case 'idle':
        // Keep a result up until its own timer; drop an unanswered "Listening…".
        if (!this.card.classList.contains('result') && !this.card.classList.contains('error')) this.hide();
        return;
      case 'result': {
        const reply = e.reply || (e.action ? '' : 'OK.');
        if (reply || !e.action) {
          const ms = e.expectReply ? 15000 : Math.min(15000, 4000 + reply.length * 60);
          this.show(e.ok === false ? 'error' : 'result', e.heard ?? '', reply, ms);
          if (e.expectReply) this.card.classList.add('listening');
        } else {
          this.hide();
        }
        if (e.action) this.act(e.action);
        if (this.sheet) void this.refresh();
        return;
      }
    }
  }

  private act(action: VoiceAction) {
    switch (action.type) {
      case 'page':
        closeSheet();
        this.host.goTo(action.index);
        // Stay there long enough to look, instead of rotating away.
        this.host.hold(5 * 60000);
        break;
      case 'nextPage':
      case 'prevPage':
        this.host.step(action.type === 'nextPage' ? 1 : -1);
        this.host.hold(5 * 60000);
        break;
      case 'hold':
        this.host.hold(action.minutes * 60000);
        break;
      case 'resume':
        this.host.hold(0);
        break;
      case 'close':
        closeSheet();
        break;
      case 'back':
        if (!closeSheet()) this.host.step(-1);
        break;
      case 'reload':
        setTimeout(() => location.reload(), 1500);
        break;
      case 'help':
        this.openSheet();
        break;
    }
  }

  /** The Voice sheet: status, a box to type commands, things to say, settings, recent commands. */
  openSheet() {
    const sheet = openSheet('🎙️ Voice control', [], {
      onClose: () => {
        if (this.sheet === sheet) {
          this.sheet = null;
          this.renderSheet = null;
        }
      },
    });
    this.sheet = sheet;
    const input = h('input', { type: 'text', class: 'voice-input', placeholder: 'Type a command, e.g. set a timer for 5 minutes', enterkeyhint: 'send' });
    const answer = h('p', { class: 'voice-answer' });
    const send = async (text: string) => {
      text = text.trim();
      if (!text) return;
      answer.textContent = '…';
      answer.className = 'voice-answer';
      try {
        const r = await call<{ ok: boolean; reply: string }>('POST', '/api/voice/command', { text, source: 'typed' });
        answer.textContent = r.reply || 'Done.';
        answer.classList.toggle('bad', !r.ok);
        input.value = '';
      } catch (err) {
        answer.textContent = (err as Error).message;
        answer.classList.add('bad');
      }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void send(input.value);
    });
    const typeRow = h(
      'div',
      { class: 'voice-type' },
      input,
      h('button', { class: 'btn btn-primary', onclick: () => void send(input.value) }, 'Send'),
    );

    const render = () => {
      const s = this.state;
      if (!s) {
        sheet.body.replaceChildren(h('p', { class: 'empty' }, 'Loading…'));
        return;
      }
      const svc = s.service;
      const wake = s.wakeWords.find((w) => w.id === s.settings.wakeWord)?.label ?? s.settings.wakeWord;
      const status = !svc.running
        ? h('div', { class: 'voice-status bad' }, h('strong', {}, 'Voice service is not running'), h('small', {}, 'It runs on the Pi once the deploy has set it up and a USB microphone is plugged in. You can still type commands here.'))
        : !svc.mic
          ? h('div', { class: 'voice-status bad' }, h('strong', {}, 'No microphone'), h('small', {}, svc.error || 'Plug a USB microphone into the Pi.'))
          : h(
              'div',
              { class: `voice-status${svc.error ? ' warn' : ''}` },
              h('strong', {}, s.settings.enabled ? `Say “${wake}”, then your command` : 'Wake word is off; tap 🎙️ to talk'),
              h('small', {}, [`Mic: ${svc.micName ?? 'on'}`, svc.error].filter(Boolean).join(' · ')),
            );

      const fields: SettingField[] = [
        { key: 'enabled', label: 'Listen for the wake word', type: 'boolean' },
        { key: 'wakeWord', label: 'Wake word', type: 'select', options: s.wakeWords.map((w) => ({ value: w.id, label: w.label })) },
        { key: 'sensitivity', label: 'Wake word sensitivity', type: 'select', options: SENSITIVITY },
        { key: 'speak', label: 'Say answers out loud', type: 'boolean' },
        { key: 'speechVolume', label: 'Answer volume (0-100)', type: 'number', min: 0, max: 100, step: 10 },
        { key: 'chime', label: 'Chime when listening', type: 'boolean' },
        { key: 'duck', label: 'Turn music down while listening', type: 'boolean' },
      ];
      const nearest = SENSITIVITY.reduce((a, b) => (Math.abs(Number(b.value) - s.settings.sensitivity) < Math.abs(Number(a.value) - s.settings.sensitivity) ? b : a));
      const form = settingsForm(fields, { ...s.settings, sensitivity: nearest.value }, async (next) => {
        try {
          this.state = await call<VoiceState>('PUT', '/api/voice/settings', { ...next, sensitivity: Number(next.sensitivity), speechVolume: Number(next.speechVolume) });
        } catch (err) {
          answer.textContent = (err as Error).message;
        }
      });

      sheet.body.replaceChildren(
        status,
        h('h3', {}, 'Type a command'),
        typeRow,
        answer,
        h('h3', {}, 'Things to say'),
        h('p', { class: 'voice-hint' }, 'Tap one to try it.'),
        ...s.examples.map((g) =>
          h(
            'details',
            { class: 'voice-examples' },
            h('summary', {}, g.group),
            h(
              'div',
              { class: 'chips' },
              ...g.items.map((text) => h('button', { class: 'chip', onclick: () => void send(text.split(' / ')[0].replace(/[?]$/, '')) }, text)),
            ),
          ),
        ),
        h('h3', {}, 'Settings'),
        form,
        ...(s.history.length
          ? [
              h('h3', {}, 'Recent'),
              h(
                'ul',
                { class: 'voice-history' },
                ...s.history.slice(0, 8).map((x) =>
                  h('li', { class: x.ok ? '' : 'bad' }, h('span', {}, `“${x.heard}”`), h('small', {}, x.reply || '✓')),
                ),
              ),
            ]
          : []),
      );
    };
    this.renderSheet = () => {
      // Don't rebuild under someone typing or picking a setting.
      if (sheet.body.contains(document.activeElement) && document.activeElement !== document.body) return;
      render();
    };
    render();
    void this.refresh();
  }
}
