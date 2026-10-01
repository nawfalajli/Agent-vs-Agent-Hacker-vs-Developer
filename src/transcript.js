import { appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

// The conversation is the sequence of real artifacts (challenge, proof result, fix, test result,
// rematch, round result), narrated. Two sinks share one event stream: a pretty, append-only
// conversation.log you read, and transcript.jsonl for tooling. No UI, no server.

const ACTORS = {
  hacker: { tag: '🔴 HACKER', plain: 'HACKER' },
  developer: { tag: '🔵 DEVELOPER', plain: 'DEVELOPER' },
  referee: { tag: '⚖️ REFEREE', plain: 'REFEREE' },
};

const time = (d = new Date()) => d.toISOString().slice(11, 19);
const indent = (text) => String(text ?? '').trim().split('\n').map((l) => `  ${l}`).join('\n');

export class Transcript {
  /** `useColor`/`useEmoji` off → plain ASCII, for terminals or files that mangle glyphs. */
  constructor(dir, { repo = '', emoji = true } = {}) {
    mkdirSync(dir, { recursive: true });
    this.log = path.join(dir, 'conversation.log');
    this.jsonl = path.join(dir, 'transcript.jsonl');
    this.repo = repo;
    this.emoji = emoji;
    this.round = 0;
  }

  /** Session banner, once per run. */
  open(meta) {
    const line = `\n╔══ Hacker vs Developer · ${this.repo} · ${new Date().toISOString()} ══╗\n`
      + `  models: hacker=${meta.hacker} developer=${meta.developer} · jev=${meta.jev} · push=${meta.push}\n`;
    appendFileSync(this.log, line);
    this.#event({ kind: 'session', actor: 'referee', text: `run started on ${this.repo}`, meta });
  }

  startRound(n) {
    this.round = n;
    appendFileSync(this.log, `\n════════ Round ${n} · ${this.repo} ════════════════════════════════════\n`);
    this.#event({ kind: 'round-start', actor: 'referee', text: `round ${n}` });
  }

  /** A turn in the duel. `kind` is the artifact; `fields` are echoed into the JSONL event. */
  say(actor, kind, text, fields = {}) {
    const a = ACTORS[actor] ?? ACTORS.referee;
    const head = `[${time()}] ${this.emoji ? a.tag : a.plain} — ${kind}`
      + (fields.cwe ? ` · ${fields.cwe}` : '') + (fields.severity ? ` · ${String(fields.severity).toUpperCase()}` : '');
    appendFileSync(this.log, `\n${head}\n${indent(text)}\n`);
    this.#event({ kind, actor, text, ...fields });
  }

  /** Closing line of the whole run. */
  close(verdict, text) {
    appendFileSync(this.log, `\n──────── ${verdict.toUpperCase()} ────────\n${indent(text)}\n`);
    this.#event({ kind: 'verdict', actor: 'referee', verdict, text });
  }

  #event(ev) {
    const line = JSON.stringify({ ts: new Date().toISOString(), round: this.round, ...ev });
    appendFileSync(this.jsonl, `${line}\n`);
    if (!this.quiet) console.log(line.length > 240 ? `${line.slice(0, 237)}...` : line);
  }

  /** Reset both files (used at the start of a fresh run). */
  reset() {
    writeFileSync(this.log, '');
    writeFileSync(this.jsonl, '');
  }
}
