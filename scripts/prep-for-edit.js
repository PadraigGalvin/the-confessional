// After the weekend: converts every recorded clip into a constant-frame-rate
// H.264/AAC MP4 that video editors import cleanly. Browser recordings use a
// variable frame rate, which some editors (Premiere, Resolve) handle badly.
// The folder layout is mirrored into the output folder, along with session.json
// files and index.csv. Re-running skips clips that are already converted.
//
// Usage: node scripts/prep-for-edit.js [recordingsDir] [outputDir]
// Set FFMPEG to the ffmpeg executable if it isn't on your PATH.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';
const FPS = 30;
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mkv']);

const inputDir = path.resolve(process.argv[2] ?? path.join(ROOT, 'recordings'));
const outputDir = path.resolve(process.argv[3] ?? path.join(ROOT, 'recordings-for-edit'));

if (spawnSync(FFMPEG, ['-version'], { stdio: 'ignore' }).error) {
  console.error('ffmpeg was not found. Install it (Linux: sudo apt install ffmpeg, Windows: winget install ffmpeg) or set FFMPEG to its path.');
  process.exit(1);
}
if (!fs.existsSync(inputDir)) {
  console.error(`No recordings found at ${inputDir}`);
  process.exit(1);
}

const jobs = [];
for (const session of fs.readdirSync(inputDir, { withFileTypes: true })) {
  if (!session.isDirectory()) continue;
  const sessionIn = path.join(inputDir, session.name);
  const sessionOut = path.join(outputDir, session.name);
  fs.mkdirSync(sessionOut, { recursive: true });
  for (const file of fs.readdirSync(sessionIn)) {
    const ext = path.extname(file).toLowerCase();
    if (file === 'session.json') fs.copyFileSync(path.join(sessionIn, file), path.join(sessionOut, file));
    if (!VIDEO_EXTENSIONS.has(ext)) continue;
    jobs.push({
      label: `${session.name}/${file}`,
      input: path.join(sessionIn, file),
      output: path.join(sessionOut, `${path.basename(file, ext)}.mp4`),
    });
  }
}

const indexCsv = path.join(inputDir, 'index.csv');
if (fs.existsSync(indexCsv)) {
  // Converted files are always .mp4, so point the index at them.
  const csv = fs.readFileSync(indexCsv, 'utf8').replace(/\.(webm|mkv)"/g, '.mp4"');
  fs.writeFileSync(path.join(outputDir, 'index.csv'), csv);
}

let converted = 0;
let skipped = 0;
const failed = [];
for (const [i, job] of jobs.entries()) {
  const progress = `[${i + 1}/${jobs.length}] ${job.label}`;
  if (fs.existsSync(job.output)) {
    skipped++;
    continue;
  }
  console.log(progress);
  const partial = `${job.output}.partial.mp4`;
  const result = spawnSync(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', job.input,
    '-vf', `fps=${FPS}`,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-af', 'aresample=async=1',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-movflags', '+faststart',
    partial,
  ], { stdio: 'inherit' });
  if (result.status === 0) {
    fs.renameSync(partial, job.output);
    converted++;
  } else {
    fs.rmSync(partial, { force: true });
    failed.push(job.label);
  }
}

console.log(`\nDone: ${converted} converted, ${skipped} already done, ${failed.length} failed.`);
if (failed.length) console.log(`Failed:\n  ${failed.join('\n  ')}`);
console.log(`Edit-ready files are in ${outputDir}`);
process.exitCode = failed.length ? 1 : 0;
