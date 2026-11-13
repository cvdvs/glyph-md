// A stand-in for server/whisper-worker.py, so Scripts/server-smoke.mjs can test
// the voice route on a machine with no Python, no mlx and no model (CI is Linux).
//
//   GLYPH_WHISPER_CMD='["node","Scripts/fake-whisper.mjs"]' node server/glyph-server.mjs …
//
// Same protocol as the real worker: one JSON job per line on stdin
// ({id, path, language}), one JSON reply per line on stdout. The "audio" a test
// uploads is plain text naming a case, e.g. a body of `CASE:pause`, and the
// reply is canned segments for it, which the server then turns into paragraphs.
// Every transcript word list includes "zebra", so a test can prove no transcript
// ever reaches the server's log.
//
//   CASE:pause     gaps of 0.1 s, 1.49 s and exactly 1.5 s: two paragraphs
//   CASE:romanian  language "ro", paragraphs starting with lowercase ă and ș
//   CASE:punct     endings ? . … are kept; a leading quote is skipped to capitalize
//   CASE:lang      echoes the language it was sent (null for auto) as "language"
//   CASE:silence   no segments at all (the server answers 422)
//   CASE:blank     only whitespace segments (422)
//   CASE:error     replies with an error (500)
//   CASE:crash     exits without replying (500, and the next job gets a new worker)
//   CASE:hang      never replies (504 after GLYPH_VOICE_TIMEOUT_MS)
//
// If FAKE_WHISPER_LOG names a file, each job appends {path, language, mode} to it
// as a JSON line, so a test can check the temp file's permissions and name and
// that the server deleted it afterwards.
import { readFileSync, statSync, appendFileSync } from "node:fs";

const CASES = {
  pause: [
    { start: 0.0, end: 1.0, text: " zebra one" },
    { start: 1.1, end: 2.0, text: "two  " },
    { start: 3.49, end: 4.0, text: "three" },
    { start: 5.5, end: 6.2, text: "four" },
  ],
  romanian: [
    { start: 0.0, end: 1.5, text: "  ăsta e începutul zebra" },
    { start: 3.2, end: 5.0, text: "ștefan trimite propunerea" },
    { start: 5.1, end: 6.0, text: " mâine" },
  ],
  punct: [
    { start: 0, end: 1, text: "is it zebra?" },
    { start: 3, end: 4, text: "yes." },
    { start: 6, end: 7, text: "well…" },
    { start: 9, end: 10, text: "\"quoted start" },
  ],
  lang: [{ start: 0, end: 1, text: "zebra" }],
  silence: [],
  blank: [{ start: 0, end: 1, text: "   " }, { start: 1, end: 2, text: "" }],
};

function reply(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

reply({ ready: true });

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    let job;
    try { job = JSON.parse(line); } catch { continue; }
    handle(job);
  }
});
process.stdin.on("end", () => process.exit(0));

function handle(job) {
  let body = "";
  let mode = null;
  try {
    body = readFileSync(job.path, "utf8").trim();
    mode = statSync(job.path).mode & 0o777;
  } catch { /* reported as an error below */ }
  if (process.env.FAKE_WHISPER_LOG) {
    appendFileSync(process.env.FAKE_WHISPER_LOG,
      JSON.stringify({ path: job.path, language: job.language, mode }) + "\n");
  }
  const name = body.startsWith("CASE:") ? body.slice(5) : "";
  if (name === "crash") process.exit(3);
  if (name === "hang") return;
  if (name === "error" || !(name in CASES)) return reply({ id: job.id, error: "FakeError" });
  const segments = CASES[name];
  const language = name === "lang" ? job.language : name === "romanian" ? "ro" : "en";
  const duration = segments.length ? segments[segments.length - 1].end + 0.3 : 1.0;
  reply({ id: job.id, language, duration, segments });
}
