import fs from 'node:fs';
import path from 'node:path';

const STATE_FILE = process.env.STATE_FILE || '/data/state.json';

const DEFAULT_STATE = {
  sessions: {},       // chatId -> claude session_id
  models: {},         // chatId -> model name
  modes: {},          // chatId -> strict | guided | yolo
  lastResponse: {},   // chatId -> { tldr, details, ts, model }
  repos: {},          // chatId -> current working repo path
  knownUserId: null,
};

let state = { ...DEFAULT_STATE };

try {
  const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  state = { ...DEFAULT_STATE, ...raw };
} catch {}

export function get() {
  return state;
}

export function save() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function getMode(chatId) {
  return state.modes[chatId] || process.env.DEFAULT_MODE || 'guided';
}

export function setMode(chatId, mode) {
  state.modes[chatId] = mode;
  save();
}

export function getModel(chatId) {
  return state.models[chatId] || process.env.DEFAULT_MODEL || 'sonnet';
}

export function setModel(chatId, model) {
  state.models[chatId] = model;
  save();
}

export function getSession(chatId) {
  return state.sessions[chatId];
}

export function setSession(chatId, sessionId) {
  if (sessionId && state.sessions[chatId] !== sessionId) {
    state.sessions[chatId] = sessionId;
    save();
  }
}

export function clearSession(chatId) {
  delete state.sessions[chatId];
  delete state.lastResponse[chatId];
  save();
}

export function getLastResponse(chatId) {
  return state.lastResponse[chatId];
}

export function setLastResponse(chatId, payload) {
  state.lastResponse[chatId] = { ...payload, ts: Date.now() };
  save();
}

export function getRepo(chatId) {
  return state.repos[chatId] || process.env.TARGET_WORKDIR || '/workspace';
}

export function setRepo(chatId, repoPath) {
  state.repos[chatId] = repoPath;
  save();
}
