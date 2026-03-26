// src/librarian/backends/webmind.ts
// Thin wrapper over webmind service functions for Librarian access.
// All calls are direct (same Worker) -- no HTTP, no fetch.

import { Env } from '../../types.js';
import { WmAgentId, WmThreadUpsertInput, WmNoteInput, WmHandoffInput } from '../../webmind/types.js';
import { mindOrient } from '../../webmind/orient.js';
import { mindGround } from '../../webmind/ground.js';
import { upsertThread } from '../../webmind/threads.js';
import { addNote } from '../../webmind/notes.js';
import { writeHandoff } from '../../webmind/handoffs.js';

export async function wmOrient(env: Env, agentId: WmAgentId) {
  return mindOrient(env, agentId);
}

export async function wmGround(env: Env, agentId: WmAgentId) {
  return mindGround(env, agentId);
}

export async function wmUpsertThread(env: Env, input: WmThreadUpsertInput) {
  return upsertThread(env, input);
}

export async function wmAddNote(env: Env, input: WmNoteInput) {
  return addNote(env, input);
}

export async function wmWriteHandoff(env: Env, input: WmHandoffInput) {
  return writeHandoff(env, input);
}
