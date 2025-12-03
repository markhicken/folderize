import fs from 'fs';
import enquirer from 'enquirer';
import path from 'path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { getDurationSeconds, checkFfmpegInstalled } from './convert-to-mp4.js';
import { log, initializeLogger } from './logger.js';
import { validatePath, getFiles } from './utils.js';
import { VIDEO_FILE_EXTENSIONS, IGNORED_FILES } from './config.js';

const DURATION_TOLERANCE_SECONDS = 1;

// Parse command-line arguments with yargs
const argv = await yargs(hideBin(process.argv))
  .positional('source', {
    describe: 'Source path for video files',
    type: 'string'
  })
  .option('dry-run', {
    describe: 'Preview files that would be deleted without actually deleting',
    type: 'boolean',
    default: false
  })
  .option('stop-on-error', {
    describe: 'Stop processing if ffprobe fails for a file',
    type: 'boolean',
    default: false
  })
  .demandCommand(1, 'You must provide source path')
  .example('node $0 ./source', 'Find and remove duplicate video files')
  .example('node $0 ./source --dry-run', 'Preview duplicates without deleting')
  .example('node $0 ./source --stop-on-error', 'Stop if ffprobe fails for any file')
  .check((argv) => {
    const source = argv._[0] || argv.source;
    if (!source) {
      throw new Error('Please provide source path');
    }
    return true;
  })
  .argv;

let srcPath = argv._[0] || argv.source;
let dryRun = argv['dry-run'];
let stopOnError = argv['stop-on-error'];

/**
 * Groups video files by their directory + base name (case-insensitive).
 * Returns a map where each key points to { mp4: filePath | null, others: [...filePaths] }
 */
function groupVideoFiles(videoFiles) {
  const groups = new Map();
  
  for (const file of videoFiles) {
    const filePath = file.srcFilePath;
    const dir = path.dirname(filePath);
    const ext = path.extname(filePath);
    const baseName = path.basename(filePath, ext);
    
    // Create case-insensitive key: directory + lowercase base name
    const key = path.join(dir, baseName.toLowerCase());
    
    if (!groups.has(key)) {
      groups.set(key, { mp4: null, others: [] });
    }
    
    const group = groups.get(key);
    
    // Check if this is an MP4 file (case-insensitive)
    if (ext.toLowerCase() === '.mp4') {
      group.mp4 = filePath;
    } else {
      group.others.push(filePath);
    }
  }
  
  return groups;
}

/**
 * Finds duplicate video files that have a matching MP4 with the same duration.
 * Returns an array of file paths that are safe to delete.
 */
async function findDuplicates(videoFiles, stopOnError) {
  const duplicates = [];
  const groups = groupVideoFiles(videoFiles);
  
  let groupCount = 0;
  const groupsWithMp4 = [...groups.entries()].filter(([, group]) => group.mp4 && group.others.length > 0);
  const totalGroups = groupsWithMp4.length;
  
  if (totalGroups === 0) {
    log('No video files with potential MP4 duplicates found.', true);
    return duplicates;
  }
  
  log(`Found ${totalGroups} video group(s) with potential duplicates to check.`, true);
  
  for (const [key, group] of groupsWithMp4) {
    groupCount++;
    const mp4Path = group.mp4;
    
    // Get MP4 duration
    log(`(${groupCount}/${totalGroups}) Checking: ${mp4Path}`, true);
    const mp4Duration = getDurationSeconds(mp4Path);
    
    if (mp4Duration === null) {
      log(`  Could not get duration for MP4: ${mp4Path}`, true);
      if (stopOnError) {
        throw new Error(`Failed to get duration for ${mp4Path}`);
      }
      continue;
    }
    
    // Check each non-MP4 file in this group
    for (const otherPath of group.others) {
      const otherDuration = getDurationSeconds(otherPath);
      
      if (otherDuration === null) {
        log(`  Could not get duration for: ${otherPath}`, true);
        if (stopOnError) {
          throw new Error(`Failed to get duration for ${otherPath}`);
        }
        continue;
      }
      
      // Compare durations with tolerance
      const durationDiff = Math.abs(mp4Duration - otherDuration);
      
      if (durationDiff <= DURATION_TOLERANCE_SECONDS) {
        log(`  DUPLICATE: ${otherPath} (${otherDuration.toFixed(2)}s) matches MP4 (${mp4Duration.toFixed(2)}s)`, true);
        duplicates.push({
          path: otherPath,
          mp4Path: mp4Path,
          duration: otherDuration,
          mp4Duration: mp4Duration
        });
      } else {
        log(`  KEPT: ${otherPath} (${otherDuration.toFixed(2)}s) differs from MP4 (${mp4Duration.toFixed(2)}s) by ${durationDiff.toFixed(2)}s`, true);
      }
    }
  }
  
  return duplicates;
}

/**
 * Deletes the duplicate files.
 */
function deleteDuplicates(duplicates) {
  let deleted = 0;
  let failed = 0;
  
  for (const dup of duplicates) {
    try {
      fs.unlinkSync(dup.path);
      log(`Deleted: ${dup.path}`, true);
      deleted++;
    } catch (err) {
      log(`Failed to delete ${dup.path}: ${err.message}`, true);
      failed++;
    }
  }
  
  return { deleted, failed };
}

async function dedupeVideoFiles() {
  try {
    log('Starting duplicate video detection...', true);
    checkFfmpegInstalled();
    
    // Get recursive list of video files (no extended info needed)
    const videoFiles = await getFiles(srcPath, VIDEO_FILE_EXTENSIONS, IGNORED_FILES, false);
    
    if (videoFiles.length === 0) {
      log('No video files found.', true);
      return true;
    }
    
    log(`Found ${videoFiles.length} video file(s) to analyze.`, true);
    
    // Find duplicates
    const duplicates = await findDuplicates(videoFiles, stopOnError);
    
    if (duplicates.length === 0) {
      log('No duplicate video files found.', true);
      return true;
    }
    
    // Display summary
    log('', true);
    log(`Found ${duplicates.length} duplicate file(s) that can be safely deleted.`, true);
    
    if (dryRun) {
      log('DRY RUN: No files were deleted.', true);
      return true;
    }
    
    // Delete duplicates
    const { deleted, failed } = deleteDuplicates(duplicates);
    
    log('', true);
    log(`Deleted ${deleted} file(s), ${failed} failed.`, true);
    
    return true;
  } catch (err) {
    log(`Duplicate detection failed: ${err.message}`, true);
    return false;
  }
}

// --- main ---
(async () => {
  // Handle graceful shutdown on SIGINT (CTRL-C)
  process.on('SIGINT', () => {
    process.exit(0);
  });

  initializeLogger();
  validatePath(srcPath, 'Source');

  const actionText = dryRun ? 'scan for' : 'find and DELETE';
  
  try {
    const shouldContinue = await new enquirer.Confirm({
      message: `Are you sure you want to recursively ${actionText} duplicate video files in "${srcPath}"?`
    }).run();
    if (!shouldContinue) {
      process.exit(0);
    }
  } catch (error) {
    // Handle CTRL-C or other interruptions during prompt
    process.exit(0);
  }

  await dedupeVideoFiles();
})();

