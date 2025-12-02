// Normalize Apple .mov/.mp4 for Synology: output = H.264 + AAC in .mp4
// This module exports functions for video conversion

import fs from 'fs';
import path from 'path';
import { execFileSync, spawnSync, spawn } from 'child_process';
import { utimesSync } from 'utimes';
import { log } from './logger.js';
import { VIDEO_FILE_EXTENSIONS } from './config.js';

export function checkFfmpegInstalled() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
  } catch (err) {
    throw new Error(
      'ffmpeg and ffprobe are required but not installed.\n' +
      'Install with: brew install ffmpeg (macOS)\n' +
      'Or visit: https://ffmpeg.org/download.html'
    );
  }
}

export function getVideoCodec(filePath) {
  try {
    const result = execFileSync('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ], { encoding: 'utf8' }).trim();
    return result; // e.g. "hevc", "h264", "prores"
  } catch (err) {
    log(`ffprobe failed for ${filePath}: ${err.message}`, true);
    return null;
  }
}

export function getDurationSeconds(filePath) {
  try {
    const result = execFileSync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ], { encoding: 'utf8' }).trim();
    return parseFloat(result);
  } catch (err) {
    log(`ffprobe failed to get duration for ${filePath}: ${err.message}`, true);
    return null;
  }
}

export function convertToH264Mp4(inputPath, outputPath, deleteOriginal) {
  return new Promise((resolve, reject) => {
    const duration = getDurationSeconds(inputPath);
    
    // Get original file stats to restore timestamps later
    let originalStats;
    try {
      originalStats = fs.statSync(inputPath);
    } catch (err) {
      log(`Warning: Could not get file stats for ${inputPath}: ${err.message}`, true);
    }
    
    const args = [
      '-y',
      '-analyzeduration', '5M',
      '-probesize', '50M',
      '-i', inputPath,
      '-map', '0:v',            // map video streams only
      '-map', '0:a:0?',         // map first audio stream only (? = optional, won't fail if none)
      '-c:v', 'libx264',
      '-crf', '18',             // quality: 18 is usually visually lossless
      '-preset', 'medium',      // speed vs compression
      '-c:a', 'aac',
      '-b:a', '160k',
      '-map_metadata', '0',     // preserve all metadata from input to output
      '-movflags', '+faststart',
      '-loglevel', 'warning',   // suppress info, only show warnings/errors
      '-progress', 'pipe:1',    // output progress to stdout
      outputPath
    ];

    // spawn with lower priority using nice (-20 to 19)
    const ffmpeg = spawn('nice', ['-n', '0', 'ffmpeg', ...args]);
    let progressBuffer = '';

    ffmpeg.stdout.on('data', (data) => {
      progressBuffer += data.toString();
      const lines = progressBuffer.split('\n');
      progressBuffer = lines.pop(); // keep incomplete line for next chunk

      for (const line of lines) {
        if (line.startsWith('out_time_ms=')) {
          const timeMs = parseInt(line.split('=')[1], 10);
          if (!isNaN(timeMs) && duration) {
            const currentSec = timeMs / 1000000;
            const remainingSec = Math.max(0, duration - currentSec);
            const percent = Math.min(100, (currentSec / duration) * 100).toFixed(1);
            const remainingMin = Math.floor(remainingSec / 60);
            const remainingSec2 = Math.floor(remainingSec % 60);
            process.stdout.write(`\rProgress: ${percent}% | Remaining: ${remainingMin}m ${remainingSec2}s     `);
          }
        }
      }
    });

    ffmpeg.stderr.on('data', (data) => {
      process.stderr.write(data);
    });

    ffmpeg.on('error', (err) => {
      log(`ffmpeg error on ${inputPath}: ${err.message}`, false);
      reject(err);
    });

    ffmpeg.on('close', (code) => {
      if (code !== 0) {
        process.stdout.write('\n'); // newline after progress
        log(`ffmpeg exited with code ${code} for ${inputPath}`, false);
        reject(new Error(`ffmpeg failed with code ${code}`));
      } else {
        // success - replace progress line with log
        process.stdout.write('\r                                        \r'); // clear the line
        log(`Conversion complete: ${path.basename(outputPath)}          `, true);
        
        // Restore original file timestamps to maintain organization by date
        if (originalStats) {
          try {
            utimesSync(outputPath, {
              btime: Math.floor(originalStats.birthtimeMs),
              mtime: Math.floor(originalStats.mtimeMs),
              atime: Math.floor(originalStats.atimeMs),
              ctime: Math.floor(originalStats.ctimeMs)
            });
            log(`Restored timestamps for: ${path.basename(outputPath)}`, true);
          } catch (err) {
            log(`Warning: Could not restore timestamps for ${path.basename(outputPath)}: ${err.message}`, true);
          }
        }
        
        if (deleteOriginal) {
          try {
            fs.unlinkSync(inputPath);
            log(`Deleted original file: ${path.basename(inputPath)}`, true);
          } catch (err) {
            log(`Failed to delete original file ${path.basename(inputPath)}: ${err.message}`, true);
            reject(new Error(`Failed to delete original file after conversion: ${err.message}`));
          }
        }
        resolve(true);
      }
    });
  });
}

export async function convertVideoFiles(inputDir, deleteOriginals, filesList, stopOnError) {
  if (!fs.existsSync(inputDir)) {
    fs.mkdirSync(inputDir, { recursive: true });
  }

  if (!filesList || !Array.isArray(filesList)) {
    throw new Error('filesList must be an array');
  }

  let videoFiles = filesList.map(file => ({
    inPath: file.srcFilePath || file,
    name: path.basename(file.srcFilePath || file),
    dir: path.dirname(file.srcFilePath || file)
  }));

  let fileCount = 0;
  const totalFiles = videoFiles.length;

  for (const fileInfo of videoFiles) {
    const inPath = fileInfo.inPath;
    const name = fileInfo.name;
    const fileDir = fileInfo.dir;
    
    const stat = fs.statSync(inPath);
    if (!stat.isFile()) continue; // skip dirs, symlinks, etc.

    const ext = path.extname(name).toLowerCase();
    if (!VIDEO_FILE_EXTENSIONS.includes(ext) && ext !== '.mov' && ext !== '.mp4') continue;

    fileCount++;

    // Accept any file type — we'll try to produce an .mp4 for every file provided.
    // If input is already an H.264 MP4 we'll copy/rename it; otherwise we convert.

    const base = path.basename(name, path.extname(name)); // use original case extension for basename
    
    // Preserve directory structure relative to inputDir if processing recursively
    let outPath;
    if (filesList && Array.isArray(filesList)) {
      const relativePath = path.relative(inputDir, fileDir);
      const outputSubDir = path.join(inputDir, relativePath);
      if (!fs.existsSync(outputSubDir)) {
        fs.mkdirSync(outputSubDir, { recursive: true });
      }
      outPath = path.join(outputSubDir, `${base}.mp4`);
    } else {
      outPath = path.join(inputDir, `${base}.mp4`);
    }

    // Check if output file already exists
    if (fs.existsSync(outPath)) {
      log(`(${fileCount}/${totalFiles}) Skipping - already converted: ${name} -> ${path.basename(outPath)}`, true);
      continue;
    }

    log(`(${fileCount}/${totalFiles}) Processing file: ${inPath}`, true);
    try {
      // Special case: MP4 files that are already H.264 can just be copied
      if (ext === '.mp4') {
        const codec = getVideoCodec(inPath);
        if (codec === 'h264') {
          log(`Already H.264 MP4 — moving to output: ${name}`, true);
          try {
            // Move preserves all timestamps including creation time
            fs.renameSync(inPath, outPath);
          } catch (err) {
            log(`Failed to move ${inPath} -> ${outPath}: ${err.message}`, true);
          }
          continue;
        }
        // If codec couldn't be determined or is not h264, fall through to convert
        log(`Converting MP4 (${codec || 'unknown codec'}) -> H.264 MP4: ${name}`, true);
      } else {
        log(`Converting file to MP4: ${name}`, true);
      }
      
      // Convert all non-h264 files
      await convertToH264Mp4(inPath, outPath, deleteOriginals);
    } catch (err) {
      log(`Error converting file to MP4: ${name}: ${err.message}`, true);
      // Remove the failed output file if it was created
      if (fs.existsSync(outPath)) {
        try {
          fs.unlinkSync(outPath);
          log(`Removed failed conversion file: ${path.basename(outPath)}`, true);
        } catch (unlinkErr) {
          log(`Warning: Could not remove failed file ${path.basename(outPath)}: ${unlinkErr.message}`, true);
        }
      }
      if (stopOnError) {
        throw err;
      }
    }
  }
}
