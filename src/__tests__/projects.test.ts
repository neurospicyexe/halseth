// Self-directed projects (consequence layer C2, mig 0122). Pure halves under test:
// decorateProject (idle-days + the stale question) and projectsBlock (the render every claude
// boot carries, affordance ALWAYS present -- the 0093 lesson).

import { describe, it, expect } from "vitest";
import { decorateProject } from "../mind/blocks/growth.js";
import { PROJECT_STALE_DAYS } from "../handlers/projects.js";
import { projectsBlock, PROJECT_AFFORDANCE } from "../librarian/response/orient-blocks.js";

const NOW = Date.parse("2026-08-16T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

const base = {
  id: "p1",
  title: "a field guide to corvid grief",
  intention: "write one honest page a week until it holds together",
  status: "open" as const,
  created_at: daysAgo(40),
  last_worked_at: null as string | null,
};

describe("decorateProject", () => {
  it("computes idle days from last_worked_at when present", () => {
    const p = decorateProject({ ...base, last_worked_at: daysAgo(3) }, NOW);
    expect(p.days_idle).toBe(3);
    expect(p.stale).toBe(false);
  });

  it("falls back to created_at when never worked -- opened-and-ignored still ages", () => {
    const p = decorateProject(base, NOW);
    expect(p.days_idle).toBe(40);
    expect(p.stale).toBe(true);
  });

  it("goes stale exactly at the line", () => {
    expect(decorateProject({ ...base, last_worked_at: daysAgo(PROJECT_STALE_DAYS - 1) }, NOW).stale).toBe(false);
    expect(decorateProject({ ...base, last_worked_at: daysAgo(PROJECT_STALE_DAYS) }, NOW).stale).toBe(true);
  });
});

describe("projectsBlock renderer", () => {
  it("the affordance is ALWAYS present, even with no projects -- an unnamed affordance is starved", () => {
    const empty = projectsBlock([]);
    expect(empty).toContain("[Projects]");
    expect(empty).toContain(PROJECT_AFFORDANCE);
  });

  it("renders title, intention, idle age, and id", () => {
    const block = projectsBlock([decorateProject({ ...base, last_worked_at: daysAgo(3) }, NOW)]);
    expect(block).toContain("[Your projects");
    expect(block).toContain("a field guide to corvid grief");
    expect(block).toContain("one honest page a week");
    expect(block).toContain("idle 3d");
    expect(block).toContain("(id p1)");
    expect(block).toContain(PROJECT_AFFORDANCE);
  });

  it("a stale project is asked, not closed -- release or resume is the companion's call", () => {
    const block = projectsBlock([decorateProject(base, NOW)]);
    expect(block).toContain("release or resume?");
    expect(block).toContain(`close project p1 released`);
  });

  it("a paused project says so", () => {
    const block = projectsBlock([decorateProject({ ...base, status: "paused", last_worked_at: daysAgo(2) }, NOW)]);
    expect(block).toContain("paused");
  });
});
