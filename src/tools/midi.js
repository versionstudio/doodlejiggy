/**
 * @module tools/midi
 * MIDI Studio — a standalone "virtual GM sound module" host.
 *
 * Routes live Web MIDI input (a keyboard, or Pro Tools → IAC bus) through the
 * exact same synth the game uses, so music can be auditioned on the real GM
 * voices while composing. Tool/UI layer only: it owns Web MIDI and forwards raw
 * MIDI bytes to synth.js — it never touches TinySynth.
 */

import './tools.css';
import { createStudio } from './studio.js';
import { showModal } from './modal.js';
import { unlock, sendMidi, sendProgramChange, panic, listPrograms } from '../engine/synth.js';

const AUDITION_CHANNEL = 1; // Program Change target (1-based); the keyboard should send here
const MESSAGE_IDLE_MS = 400; // how long after the last message the indicator falls back to Idle

const PROGRAMS = listPrograms(); // [{ program, name }] — GM names from the synth

// ══ State ════════════════════════════════

let currentProgram = 0; // the selected audition program
let channelProgram = 0; // what channel 1 actually holds (GM default 0; updated when we send or external MIDI changes it)
let selectedInputId = null;
let midiInputs = []; // MIDIInput[] from the most recent access snapshot

function programLabel(program) {
  return program + ': ' + PROGRAMS[program].name;
}

// ══ Actions ══════════════════════════════

const actions = {
  panic:       function () { unlock(); panic(); },
  prevProgram: function () { selectProgram(Math.max(0, currentProgram - 1)); },
  nextProgram: function () { selectProgram(Math.min(PROGRAMS.length - 1, currentProgram + 1)); },
  reapply:     function () { selectProgram(currentProgram); },
  info:        openInfo,
};

// ══ Toolbar ══════════════════════════════

const TOOLBAR = [
  { controls: [{ badge: 'midi studio' }] },
  { label: 'input',   controls: [{ button: 'input',   text: '— select —',                opens: 'input'   }] },
  { label: 'program', controls: [{ button: 'program', text: programLabel(currentProgram), opens: 'program' }] },
  { controls: [{ button: 'panic', text: 'PANIC', action: 'panic' }] },
  { spacer: true },
  { controls: [{ button: 'info', text: 'ⓘ', icon: true, action: 'info' }] },
];

function openInfo() {
  showModal(
    '<h2>MIDI STUDIO</h2>' +
    '<p>MIDI Studio is a virtual GM sound module using the same synth the game uses.</p>' +
    '<p>The program selector and keyboard shortcuts let you try instruments live from a MIDI source. ' +
    'External MIDI input is forwarded unchanged on all channels, ' +
    'so a sequencer such as Pro Tools can drive full multi-channel playback.</p>' +
    '<h3>Live instrument</h3>' +
    '<ul>' +
    '<li>Pick a program from the dropdown.</li>' +
    '<li><kbd>↑</kbd> previous program &middot; <kbd>↓</kbd> next program</li>' +
    '<li><kbd>Enter</kbd> re-apply the selected program</li>' +
    '<li>The selected program is marked (*) when it no longer matches the active instrument.</li>' +
    '</ul>'
  );
}

// ══ Pickers ══════════════════════════════

const PICKERS = {
  input: {
    heading: 'MIDI Input',
    empty: 'no devices found',
    rows: function () {
      return midiInputs.map(function (input) {
        return {
          label: input.name,
          state: input.id === selectedInputId ? 'current' : 'clickable',
          onSelect: function () { selectInput(input.id); },
        };
      });
    },
  },
  program: {
    heading: 'Program',
    rows: function () {
      return PROGRAMS.map(function (p) {
        return {
          label: programLabel(p.program),
          state: p.program === currentProgram ? 'current' : 'clickable',
          onSelect: function () { selectProgram(p.program); },
        };
      });
    },
  },
};

// ══ Shortcuts ════════════════════════════

const SHORTCUTS = [
  { key: 'ArrowUp',   action: 'prevProgram' },
  { key: 'ArrowDown', action: 'nextProgram' },
  { key: 'Enter',     action: 'reapply' },
];

// ══ Composition ══════════════════════════

const studio = createStudio({
  title: 'Doodlejiggy - MIDI Studio',
  actions: actions,
  toolbar: TOOLBAR,
  pickers: PICKERS,
  shortcuts: SHORTCUTS,
});

// ══ Status view ══════════════════════════
//
// MIDI-local presentation, not a Studio capability: a key/value panel mounted in
// the content region. Lines are built once and only their values change, so a
// dense MIDI stream never rebuilds the DOM (see markReceiving).

function mountStatus(parent, keys) {
  const root = document.createElement('div');
  root.className = 'tools-readout';
  const values = {};
  for (let i = 0; i < keys.length; i++) {
    const row = document.createElement('div');
    const k = document.createElement('b');
    k.textContent = keys[i];
    const v = document.createElement('span');
    row.appendChild(k);
    row.appendChild(v);
    root.appendChild(row);
    values[keys[i]] = v;
  }
  parent.appendChild(root);
  return { set: function (key, text) { values[key].textContent = text; } };
}

const status = mountStatus(studio.content, ['Status', 'Input', 'Message']);
status.set('Message', 'Idle');

function updateConnection() {
  const selectedInput = midiInputs.find(function (input) { return input.id === selectedInputId; });
  status.set('Status', selectedInput ? 'Connected' : 'No input selected');
  status.set('Input', selectedInput ? selectedInput.name : '—');
}

// ══ Selection ════════════════════════════

// Selecting (dropdown or arrow keys) immediately sends the Program Change.
// Re-selecting the same program (Enter) re-sends it — restoring channel 1 after
// external MIDI overrode it.
function selectProgram(program) {
  unlock();
  currentProgram = program;
  sendProgramChange(AUDITION_CHANNEL, program);
  channelProgram = program;
  updateProgramButton();
}

// Trailing "*" marks that channel 1 holds a different program than the
// selection — external MIDI (e.g. Pro Tools) changed it out from under it.
function updateProgramButton() {
  studio.get('program').setText(programLabel(currentProgram) + (channelProgram !== currentProgram ? ' *' : ''));
}

function selectInput(id) {
  unlock();
  midiInputs.forEach(function (input) { input.onmidimessage = null; });
  selectedInputId = id;
  const selectedInput = midiInputs.find(function (input) { return input.id === id; });
  if (selectedInput) selectedInput.onmidimessage = onMidi;
  studio.get('input').setText(selectedInput ? selectedInput.name : '— select —');
  updateConnection();
}

// ══ MIDI routing ═════════════════════════

let receiving = false;
let idleTimer = 0;

function onMidi(e) {
  sendMidi(e.data);
  const d = e.data;
  // Track external Program Changes on channel 1 so the toolbar's "*" can flag
  // when channel 1 has drifted from the selected audition program.
  if ((d[0] & 0xF0) === 0xC0 && (d[0] & 0x0F) === AUDITION_CHANNEL - 1) {
    channelProgram = d[1];
    updateProgramButton();
  }
  markReceiving();
}

// Flips the Message indicator to "Receiving" on traffic and back to "Idle" once
// it goes quiet. Touches the DOM only on the Idle↔Receiving transition, never
// per message — so a dense Pro Tools stream costs nothing here.
function markReceiving() {
  if (!receiving) { receiving = true; status.set('Message', 'Receiving'); }
  clearTimeout(idleTimer);
  idleTimer = setTimeout(function () { receiving = false; status.set('Message', 'Idle'); }, MESSAGE_IDLE_MS);
}

// Re-snapshots inputs on connect/disconnect; keeps the active device bound if
// it's still present (its handler persists on the MIDIInput across the event).
function captureInputs(access) {
  midiInputs = [...access.inputs.values()];
  if (selectedInputId && midiInputs.some(function (input) { return input.id === selectedInputId; })) selectInput(selectedInputId);
  else if (selectedInputId) { selectedInputId = null; studio.get('input').setText('— select —'); }
  updateConnection();
  studio.refresh('input'); // reflect device changes in the picker if it's open
}

if (!navigator.requestMIDIAccess) {
  status.set('Status', 'Web MIDI not supported');
  studio.get('input').setText('unsupported');
} else {
  navigator.requestMIDIAccess().then(function (access) {
    captureInputs(access);
    access.onstatechange = function () { captureInputs(access); };
  }).catch(function () { status.set('Status', 'Web MIDI access denied'); });
}

updateConnection();
