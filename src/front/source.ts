// src/front/source.ts
//
// The ONE place Halseth learns who is fronting (2026-09-30, STATUS B43).
//
// SimplyPlural (the nullsafe-plural-v2 Service Binding) was retired: Raziel stopped using it and moved
// to a new plural app that has no API yet. Every caller -- the Librarian's "who is fronting" verb,
// the pre-fetch that feeds orient/session_open -- asks this module and nothing else, so wiring the new
// app is a change to this file only.
//
// Until a source is connected the answer is UNKNOWN, never "no one". The dead binding answered
// "No one is currently fronting." and an empty history, which a companion reads as a fact about the
// system. Unknown carries its reason so the companion can say why, and read the front from Raziel.
//
// Plural fronters are Raziel's system members, not the companions; front state is context, never
// companion identity.

import type { Env } from "../types.js";

export const NO_FRONT_SOURCE_REASON =
  "no front source is connected: SimplyPlural was retired 2026-09-30 and the new plural app has no API yet";

export type FrontRead =
  | { status: "ok"; name: string; member_id: string }
  | { status: "unknown"; reason: string };

export type FrontHistoryRead =
  | { status: "ok"; events: { member_id: string; name: string; started_at: string }[] }
  | { status: "unknown"; reason: string };

export async function readFront(_env: Env): Promise<FrontRead> {
  return { status: "unknown", reason: NO_FRONT_SOURCE_REASON };
}

export async function readFrontHistory(_env: Env): Promise<FrontHistoryRead> {
  return { status: "unknown", reason: NO_FRONT_SOURCE_REASON };
}
