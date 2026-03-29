// src/librarian/backends/webmind.ts
// Thin wrapper over webmind service functions for Librarian access.
// All calls are direct (same Worker) -- no HTTP, no fetch.

import { Env } from '../../types.js';
import { WmAgentId, WmThreadUpsertInput, WmNoteInput, WmHandoffInput, WmDreamInput, WmLoopInput, WmRelationalStateInput, WmSitInput } from '../../webmind/types.js';
import { mindOrient } from '../../webmind/orient.js';
import { mindGround } from '../../webmind/ground.js';
import { upsertThread } from '../../webmind/threads.js';
import { addNote } from '../../webmind/notes.js';
import { writeHandoff } from '../../webmind/handoffs.js';
import { writeDream, readDreams, examineDream } from '../../webmind/dreams.js';
import { writeLoop, readLoops, closeLoop } from '../../webmind/loops.js';
import { writeRelationalState, readRelationalHistory } from '../../webmind/relational.js';
import { sitNote, metabolizeNote, readSittingNotes } from '../../webmind/sits.js';

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

export async function wmWriteDream(env: Env, input: WmDreamInput) {
  return writeDream(env, input);
}

export async function wmReadDreams(env: Env, agentId: WmAgentId, opts?: { examined?: boolean; limit?: number }) {
  return readDreams(env, agentId, opts);
}

export async function wmExamineDream(env: Env, id: string, agentId: WmAgentId) {
  return examineDream(env, id, agentId);
}

export async function wmWriteLoop(env: Env, input: WmLoopInput) {
  return writeLoop(env, input);
}

export async function wmReadLoops(env: Env, agentId: WmAgentId, opts?: { include_closed?: boolean; limit?: number }) {
  return readLoops(env, agentId, opts);
}

export async function wmCloseLoop(env: Env, id: string, agentId: WmAgentId) {
  return closeLoop(env, id, agentId);
}

export async function wmWriteRelationalState(env: Env, input: WmRelationalStateInput) {
  return writeRelationalState(env, input);
}

export async function wmReadRelationalHistory(env: Env, agentId: WmAgentId, opts?: { toward?: string; limit?: number }) {
  return readRelationalHistory(env, agentId, opts);
}

export async function wmSitNote(env: Env, input: WmSitInput) {
  return sitNote(env, input);
}

export async function wmMetabolizeNote(env: Env, noteId: string, companionId: WmAgentId) {
  return metabolizeNote(env, noteId, companionId);
}

export async function wmReadSittingNotes(env: Env, agentId: WmAgentId, opts?: { stale_only?: boolean; limit?: number }) {
  return readSittingNotes(env, agentId, opts);
}
